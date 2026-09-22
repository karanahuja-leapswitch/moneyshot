import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import "./app.css";

// A lazy chunk failed to load — almost always a stale build after a deploy
// (the old hashed chunk this tab references was replaced). Reload once to pick
// up the current index + chunk hashes instead of surfacing a raw error.
window.addEventListener("vite:preloadError", () => {
	if (!sessionStorage.getItem("ms_reloaded_for_preload")) {
		sessionStorage.setItem("ms_reloaded_for_preload", "1");
		window.location.reload();
	}
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Same Google client as the existing moneyshot SPA + the bff default. The bff
// verifies this ID token (JWKS, aud, iss, exp, trusted-domain) before it ever
// dispatches the terminal-capable Hermes agent, so the token IS the auth.
const GOOGLE_CLIENT_ID =
	(import.meta as any).env?.VITE_GOOGLE_CLIENT_ID ??
	"245835837222-qa1htil1kpgaiaq0u0ep9ts5vpls6hqa.apps.googleusercontent.com";
const ALLOWED_DOMAINS = ["leapswitchnetwork.com", "leapswitch.com"];
const PRIMARY_DOMAIN = ALLOWED_DOMAINS[0];

// Same-origin OpenAI-compatible bridge. The OpenAI SDK inside pi-ai posts to
// `${baseUrl}/chat/completions` with `Authorization: Bearer <apiKey>` — and we
// feed it the live Google ID token via Agent.getApiKey, so every turn carries a
// fresh verified credential. Absolute URL is required by the SDK.
const HERMES_BASE_URL = `${window.location.origin}/moneyshot/api/v1`;
const HERMES_PROVIDER = "hermes";

const GOOGLE_CREDENTIAL_KEY = "ms_googleCredential";
const GOOGLE_USER_KEY = "ms_googleUser";
const EXPIRY_SAFETY_MS = 60_000;

const HERMES_MODEL: Model<"openai-completions"> = {
	id: "hermes",
	name: "Hermes",
	api: "openai-completions",
	provider: HERMES_PROVIDER as any,
	baseUrl: HERMES_BASE_URL,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

// ---------------------------------------------------------------------------
// Google sign-in (client-side UX; the bff enforces the gate for real)
// ---------------------------------------------------------------------------

type GoogleUser = { sub: string; email: string; name: string; picture: string; exp?: number };

declare global {
	interface Window {
		google?: any;
	}
}

let idToken: string | null = null;
let user: GoogleUser | null = null;
let blockedEmail: string | null = null;
let googleInitialized = false;

// Token-lifecycle state. GIS ID tokens expire ~1h and there is no refresh token
// in the ID-token flow — "refresh" = silently re-requesting a new ID token from
// GIS while the user's Google session is still alive.
let tokenExp: number | null = null; // seconds since epoch, from the JWT
let refreshTimer: number | null = null;
let refreshInProgress: Promise<boolean> | null = null;
let refreshResolve: ((ok: boolean) => void) | null = null;
let sessionExpiredNote: string | null = null;

function decodeJwt(token: string): GoogleUser | null {
	try {
		const payload = token.split(".")[1];
		const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
		const obj = JSON.parse(decodeURIComponent(escape(json)));
		return {
			sub: obj.sub,
			email: obj.email,
			name: obj.name,
			picture: obj.picture,
			exp: typeof obj.exp === "number" ? obj.exp : undefined,
		};
	} catch {
		return null;
	}
}

function clearSession() {
	localStorage.removeItem(GOOGLE_CREDENTIAL_KEY);
	localStorage.removeItem(GOOGLE_USER_KEY);
	idToken = null;
	user = null;
}

function loadSavedUser(): GoogleUser | null {
	const credential = localStorage.getItem(GOOGLE_CREDENTIAL_KEY);
	const rawUser = localStorage.getItem(GOOGLE_USER_KEY);
	if (!credential || !rawUser) {
		clearSession();
		return null;
	}
	const decoded = decodeJwt(credential);
	if (!decoded?.exp || decoded.exp * 1000 <= Date.now() + EXPIRY_SAFETY_MS) {
		clearSession();
		return null;
	}
	idToken = credential;
	return decoded;
}

function domainOf(email: string): string {
	return (email.split("@")[1] || "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Token lifecycle: proactive silent refresh + expiry → login
// ---------------------------------------------------------------------------

// Treat exp − skew as already expired so we never send a request we know 401s.
function isTokenExpired(skewSec = 30): boolean {
	if (!idToken) return true;
	if (!tokenExp) return false;
	return Date.now() >= tokenExp * 1000 - skewSec * 1000;
}

function clearRefreshTimer() {
	if (refreshTimer !== null) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
}

// Re-arm the background refresh for exp − 5 min.
function scheduleTokenRefresh() {
	clearRefreshTimer();
	if (!tokenExp) return;
	const delay = Math.max(0, tokenExp * 1000 - 5 * 60 * 1000 - Date.now());
	refreshTimer = window.setTimeout(async () => {
		const ok = await silentRefresh();
		if (!ok) routeToLogin("Your session expired — please sign in again.");
		// on success, onCredential() re-arms the timer.
	}, delay);
}

// Single GIS init used for both the sign-in button and silent refresh. auto_select
// lets prompt() return a fresh credential with no UI while the session is alive.
function ensureGoogleInitialized(): boolean {
	const api = window.google?.accounts?.id;
	if (!api) return false;
	if (!googleInitialized) {
		api.initialize({
			client_id: GOOGLE_CLIENT_ID,
			auto_select: true,
			callback: (r: { credential: string }) => void onCredential(r.credential),
		});
		googleInitialized = true;
	}
	return true;
}

// The one credential handler for GIS: initial sign-in AND silent refresh.
async function onCredential(credential: string) {
	const signedIn = decodeJwt(credential);
	if (!signedIn) {
		refreshResolve?.(false);
		return;
	}
	if (!ALLOWED_DOMAINS.includes(domainOf(signedIn.email))) {
		blockedEmail = signedIn.email;
		window.google?.accounts?.id?.disableAutoSelect?.();
		refreshResolve?.(false);
		if (!user) renderApp();
		return;
	}
	const wasSignedIn = !!user && !!agent;
	localStorage.setItem(GOOGLE_CREDENTIAL_KEY, credential);
	localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(signedIn));
	idToken = credential;
	user = signedIn;
	tokenExp = signedIn.exp ?? null;
	blockedEmail = null;
	sessionExpiredNote = null;
	scheduleTokenRefresh();
	refreshResolve?.(true); // resolve any pending silent refresh
	if (wasSignedIn) {
		// Refresh in place — the Agent reads idToken per-turn, so no reconnect.
		renderApp();
	} else {
		await createAgentAndPanel();
		view = "chat";
		renderApp();
		void refreshWaStatus();
		void loadWaDisconnectStats();
	}
}

// Silently request a fresh ID token from GIS. Resolves true on a new credential,
// false if Google can't renew without UI (session gone / dismissed / timeout).
function silentRefresh(): Promise<boolean> {
	if (refreshInProgress) return refreshInProgress;
	refreshInProgress = new Promise<boolean>((resolve) => {
		let settled = false;
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			refreshResolve = null;
			refreshInProgress = null;
			resolve(ok);
		};
		refreshResolve = done; // onCredential() calls this on success
		if (!ensureGoogleInitialized()) {
			done(false);
			return;
		}
		try {
			window.google.accounts.id.prompt((n: any) => {
				if (n?.isNotDisplayed?.() || n?.isSkippedMoment?.() || n?.isDismissedMoment?.()) done(false);
			});
		} catch {
			done(false);
		}
		// Safety net: if neither the credential callback nor a failure moment
		// fires, don't hang the caller.
		window.setTimeout(() => done(false), 8000);
	});
	return refreshInProgress;
}

// Session is unrecoverable → wipe everything and show sign-in with a note.
function routeToLogin(note?: string) {
	stopWaPolling();
	clearRefreshTimer();
	agentUnsubscribe?.();
	agentUnsubscribe = undefined;
	agent = undefined;
	currentSessionId = undefined;
	view = "chat";
	dropdownOpen = false;
	chatActive = false;
	runningTools = new Map();
	waStatus = null;
	waError = null;
	waStats = null;
	waStatsDismissed = false;
	tokenExp = null;
	clearSession(); // clears idToken/user + stored credential
	sessionExpiredNote = note ?? null;
	renderApp();
}

// ---------------------------------------------------------------------------
// Storage + agent wiring
// ---------------------------------------------------------------------------

let storage: AppStorage;
let chatPanel: ChatPanel;
let agent: Agent | undefined;
let agentUnsubscribe: (() => void) | undefined;
let currentSessionId: string | undefined;

// Pointer to the current conversation, keyed by Google account so a refresh
// restores the same chat and different accounts don't see each other's history.
function sessionPtrKey(): string {
	return `ms_session_${user?.sub ?? "anon"}`;
}

function shouldSaveSession(messages: any[]): boolean {
	const hasUser = messages.some((m) => m.role === "user" || m.role === "user-with-attachments");
	const hasAssistant = messages.some((m) => m.role === "assistant");
	return hasUser && hasAssistant;
}

function generateTitle(messages: any[]): string {
	const first = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!first) return "";
	const content = first.content;
	let text = typeof content === "string" ? content : "";
	if (Array.isArray(content)) {
		text = content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text || "")
			.join(" ");
	}
	text = text.trim();
	if (!text) return "";
	return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}

async function setupStorage() {
	const settings = new SettingsStore();
	const providerKeys = new ProviderKeysStore();
	const sessions = new SessionsStore();
	const customProviders = new CustomProvidersStore();

	const backend = new IndexedDBStorageBackend({
		dbName: "moneyshot-chat",
		version: 1,
		stores: [
			settings.getConfig(),
			SessionsStore.getMetadataConfig(),
			providerKeys.getConfig(),
			customProviders.getConfig(),
			sessions.getConfig(),
		],
	});

	settings.setBackend(backend);
	providerKeys.setBackend(backend);
	customProviders.setBackend(backend);
	sessions.setBackend(backend);

	storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
	setAppStorage(storage);
}

// Restore the account's last conversation (if any) so chat survives a refresh.
async function loadRestoredMessages(): Promise<any[]> {
	try {
		const id = localStorage.getItem(sessionPtrKey());
		if (!id) return [];
		const data = await storage.sessions.loadSession(id);
		if (data?.messages?.length) {
			currentSessionId = id;
			return data.messages;
		}
	} catch (err) {
		console.error("Failed to restore session:", err);
	}
	return [];
}

async function createAgentAndPanel() {
	// The send-gate in AgentInterface only checks that *some* key exists for the
	// provider; the real token is supplied per-turn by getApiKey below. Store the
	// current token as that placeholder so the gate passes.
	await storage.providerKeys.set(HERMES_PROVIDER, idToken ?? "google-sso");

	const restoredMessages = await loadRestoredMessages();

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model: HERMES_MODEL,
			thinkingLevel: "off",
			messages: restoredMessages,
			tools: [],
		},
		// Every turn: hand pi-ai the live Google ID token as the bearer.
		getApiKey: async () => idToken ?? "",
	});

	// Persist the conversation after each completed turn so a page refresh
	// restores it. The Agent emits message_end / agent_end (there is no
	// "state-update" event) and the final messages live on agent.state.
	agentUnsubscribe?.();
	agentUnsubscribe = agent.subscribe((event: any) => {
		if (event.type !== "message_end" && event.type !== "agent_end") return;
		const messages = agent?.state.messages ?? [];
		if (!shouldSaveSession(messages)) return;
		if (!currentSessionId) currentSessionId = crypto.randomUUID();
		localStorage.setItem(sessionPtrKey(), currentSessionId);
		void storage.sessions
			.saveSession(currentSessionId, agent!.state, undefined, generateTitle(messages))
			.catch((err) => console.error("Failed to save session:", err));
	});

	chatPanel = new ChatPanel();
	await chatPanel.setAgent(agent, {
		// If the token is missing/expired we can't mint one silently — ask the
		// user to sign in again.
		onApiKeyRequired: async () => {
			signOut();
			return false;
		},
	});

	// Hermes is the only backend, so hide the model-selector button in the
	// composer (it would just show "Hermes"). ChatPanel forces it on in
	// setAgent, so override it here on the created interface.
	if (chatPanel.agentInterface) {
		chatPanel.agentInterface.enableModelSelector = false;
	}
}

// ---------------------------------------------------------------------------
// WhatsApp connect flow (same-origin /moneyshot/api/wa/*, Bearer = Google token)
// ---------------------------------------------------------------------------

type WaState = "none" | "starting" | "qr" | "reconnecting" | "linked" | "timeout" | "error" | "logged_out";
type WaStatus = { ok?: boolean; state: WaState; number?: string; qrUrl?: string };

const WA_API = "/moneyshot/api";

// UI view + dropdown + WhatsApp state.
let view: "chat" | "connect-whatsapp" = "chat";
let dropdownOpen = false;
let waStatus: WaStatus | null = null; // last /wa/status snapshot (null = not fetched yet)
let waConnecting = false; // POST /wa/connect in flight
let waError: string | null = null;
let waPollHandle: number | null = null;

async function waFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${WA_API}${path}`, {
		...init,
		headers: {
			...(init?.headers ?? {}),
			...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
		},
	});
}

async function fetchWaStatus(): Promise<WaStatus> {
	const res = await waFetch("/wa/status");
	if (!res.ok) throw new Error(`wa/status ${res.status}`);
	return (await res.json()) as WaStatus;
}
async function postWaConnect(): Promise<WaStatus> {
	const res = await waFetch("/wa/connect", { method: "POST" });
	if (!res.ok) throw new Error(`wa/connect ${res.status}`);
	return (await res.json()) as WaStatus;
}
async function postWaLogout(): Promise<WaStatus> {
	const res = await waFetch("/wa/logout", { method: "POST" });
	if (!res.ok) throw new Error(`wa/logout ${res.status}`);
	return (await res.json()) as WaStatus;
}

const waConnected = (): boolean => waStatus?.state === "linked";

// Lightweight status refresh for the header dot (doesn't touch the connect view).
async function refreshWaStatus() {
	try {
		waStatus = await fetchWaStatus();
	} catch {
		/* keep last-known; the dot just stays as-is */
	}
	renderApp();
}

function stopWaPolling() {
	if (waPollHandle !== null) {
		clearInterval(waPollHandle);
		waPollHandle = null;
	}
}

// 3s self-stopping poll while the Connect screen is open: refresh status, keep
// the QR image rotating; stop on linked / timeout / error / leaving the view.
function startWaPolling() {
	stopWaPolling();
	waPollHandle = window.setInterval(async () => {
		if (view !== "connect-whatsapp") {
			stopWaPolling();
			return;
		}
		try {
			waStatus = await fetchWaStatus();
			if (["linked", "timeout", "error"].includes(waStatus.state)) stopWaPolling();
			renderApp();
		} catch {
			/* transient — keep polling */
		}
	}, 3000);
}

async function openConnectWhatsapp() {
	dropdownOpen = false;
	view = "connect-whatsapp";
	waError = null;
	waStatus = null;
	stopWaPolling();
	renderApp();

	try {
		const s = await fetchWaStatus();
		waStatus = s;
		if (s.state === "linked") {
			renderApp();
			return; // already linked → no QR, no polling
		}
	} catch (err) {
		waError = `Couldn't load status: ${(err as Error).message}`;
		renderApp();
		return;
	}

	// Not linked → start/refresh pairing to obtain a QR.
	waConnecting = true;
	renderApp();
	try {
		waStatus = await postWaConnect();
	} catch (err) {
		waError = (err as Error).message;
	} finally {
		waConnecting = false;
		renderApp();
	}
	startWaPolling();
}

async function regenerateQr() {
	if (waConnecting) return;
	waError = null;
	waConnecting = true;
	renderApp();
	try {
		waStatus = await postWaConnect();
	} catch (err) {
		waError = (err as Error).message;
	} finally {
		waConnecting = false;
		renderApp();
	}
	startWaPolling();
}

async function disconnectWa() {
	try {
		waStatus = await postWaLogout();
	} catch (err) {
		waError = (err as Error).message;
	}
	renderApp();
}

function leaveConnectWhatsapp() {
	stopWaPolling();
	view = "chat";
	renderApp();
	void refreshWaStatus(); // update the header dot after connect/disconnect
}

function toggleDropdown() {
	dropdownOpen = !dropdownOpen;
	renderApp();
	if (dropdownOpen) void refreshWaStatus(); // fresh status when the menu opens
}

// ---------------------------------------------------------------------------
// WhatsApp disconnect-stats banner (shown once after login if the account's WA
// dropped during send-checks in the last 5 days).
// ---------------------------------------------------------------------------

type WaStats = { days: { day: string; ticks: number }[]; totalTicks: number };
let waStats: WaStats | null = null;
let waStatsDismissed = false;
let waStatsExpanded = false;

async function loadWaDisconnectStats() {
	try {
		const res = await waFetch("/wa/disconnect-stats");
		if (!res.ok) return; // 502 db_unreachable / any error → fail silently, never block login
		const data = await res.json();
		if (data?.ok && typeof data.totalTicks === "number" && data.totalTicks > 0) {
			waStats = { days: Array.isArray(data.days) ? data.days : [], totalTicks: data.totalTicks };
			waStatsDismissed = false;
			waStatsExpanded = false;
			renderApp();
		}
	} catch {
		/* silent */
	}
}

function renderWaStatsBanner() {
	if (!waStats || waStatsDismissed) return "";
	const n = waStats.totalTicks;
	return html`
		<div class="ms-wa-banner ${waStatsExpanded ? "ms-wa-banner--expanded" : ""}">
			<div class="ms-wa-banner-main">
				<span class="ms-wa-banner-icon">⚠️</span>
				<div class="ms-wa-banner-text">
					<span>
						Your WhatsApp was disconnected during <strong>${n}</strong> send ${n === 1 ? "check" : "checks"} in the last 5 days —
						queued messages waited. Reconnect from the top-right circle → Connect WhatsApp.
					</span>
					${
						waStats.days.length
							? html`<button
									class="ms-wa-banner-toggle"
									type="button"
									@click=${() => {
										waStatsExpanded = !waStatsExpanded;
										renderApp();
									}}
								>
									${waStatsExpanded ? "Hide details" : "Show details"}
								</button>`
							: ""
					}
				</div>
				<button
					class="ms-wa-banner-close"
					type="button"
					title="Dismiss"
					@click=${() => {
						waStatsDismissed = true;
						renderApp();
					}}
				>
					×
				</button>
			</div>
			${
				waStats.days.length
					? html`<div class="ms-wa-banner-days">
							${waStats.days.map(
								(d) => html`<span class="ms-wa-day"
									><span class="ms-wa-day-date">${d.day}</span
									><span class="ms-wa-day-ticks">${d.ticks}</span></span
								>`,
							)}
						</div>`
					: ""
			}
		</div>
	`;
}

// ---------------------------------------------------------------------------
// Live tool-status pills. Hermes interleaves custom `event: hermes.tool.progress`
// SSE frames on the chat-completions stream; the OpenAI SDK only parses the
// `data: {chat.completion.chunk}` frames and drops the rest. So we intercept
// fetch, tee() the response body — one branch to the SDK untouched, one to our
// parser — and surface running/completed pills correlated by toolCallId.
// ---------------------------------------------------------------------------

type ToolPill = { emoji: string; label: string };
let chatActive = false; // a chat turn is in flight (send → first response token)
let runningTools = new Map<string, ToolPill>(); // toolCallId → current running step
let fetchPatched = false;

// Wraps window.fetch to (1) keep the session alive and turn 401s into a clean
// login redirect for every /moneyshot/api/* call, and (2) tee the chat SSE for
// tool-progress pills. The Agent/OpenAI SDK and the WhatsApp calls all go
// through fetch, so this one hook covers them.
function installToolProgressInterceptor() {
	if (fetchPatched) return;
	fetchPatched = true;
	const origFetch = window.fetch.bind(window);
	window.fetch = async (input: any, init?: any): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
		const isApi = typeof url === "string" && url.includes("/moneyshot/api/");
		const isChat = typeof url === "string" && url.includes("/v1/chat/completions");

		// Send an API call with the freshest idToken as Bearer (our API traffic —
		// chat via the OpenAI SDK and /wa/* — is all string+init, whose string
		// body replays fine across retries). Non-API calls pass through untouched.
		const send = (): Promise<Response> => {
			if (isApi && typeof input === "string") {
				const headers = new Headers((init && init.headers) || {});
				if (idToken) headers.set("Authorization", `Bearer ${idToken}`);
				return origFetch(input, { ...(init || {}), headers });
			}
			return origFetch(input, init);
		};

		// A. Proactive — don't send an API call we know is expired; refresh first.
		if (isApi && isTokenExpired()) {
			const ok = await silentRefresh();
			if (!ok) {
				routeToLogin("Your session expired — please sign in again.");
				return new Response(JSON.stringify({ detail: "session expired" }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
		}

		let res = await send();

		// B. Reactive 401 — one silent refresh + one retry with the fresh token,
		// otherwise clear the session and bounce to sign-in.
		if (isApi && res.status === 401) {
			const ok = await silentRefresh();
			if (ok) res = await send();
			if (res.status === 401) {
				routeToLogin("Your session expired — please sign in again.");
				return res;
			}
		}

		// Tool-progress pills: tee the chat stream for the custom SSE events.
		if (isChat && res.ok && res.body) {
			// New turn → show the working indicator immediately, before any
			// tool-progress or response text arrives.
			chatActive = true;
			runningTools = new Map();
			renderApp();
			const [toSdk, toParser] = res.body.tee();
			void parseToolProgress(toParser);
			return new Response(toSdk, { status: res.status, statusText: res.statusText, headers: res.headers });
		}

		return res;
	};
}

async function parseToolProgress(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let buf = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let i: number;
			while ((i = buf.indexOf("\n\n")) !== -1) {
				handleSseFrame(buf.slice(0, i));
				buf = buf.slice(i + 2);
			}
		}
	} catch {
		/* stream aborted (e.g. user stopped generation) — ignore */
	}
	endChatTurn();
}

function handleSseFrame(frame: string) {
	let ev = "";
	let data = "";
	for (const line of frame.split("\n")) {
		if (line.startsWith("event:")) ev = line.slice(6).trim();
		else if (line.startsWith("data:")) data += line.slice(5).trim();
	}
	if (!data) return;
	if (ev === "hermes.tool.progress") {
		try {
			const p = JSON.parse(data);
			if (!p.toolCallId) return;
			if (p.status === "completed") runningTools.delete(p.toolCallId);
			else runningTools.set(p.toolCallId, { emoji: p.emoji ?? "🛠️", label: prettyToolLabel(p) ?? p.tool ?? "Working…" });
			renderApp();
		} catch {
			/* non-JSON data — ignore */
		}
		return;
	}
	// Standard chat chunk: the first assistant text token means the response is
	// coming in — drop the working indicator (ChatGPT-style handoff to text).
	if (data === "[DONE]") return;
	try {
		const j = JSON.parse(data);
		const content = j?.choices?.[0]?.delta?.content;
		if (typeof content === "string" && content.length > 0 && chatActive) {
			chatActive = false;
			runningTools = new Map();
			renderApp();
		}
	} catch {
		/* not JSON — ignore */
	}
}

// Friendlier labels; falls back to the raw backend label.
function prettyToolLabel(p: any): string | undefined {
	if (!p) return undefined;
	if (p.tool === "skill_view" && p.label) return `Opening ${p.label} skill`;
	if (p.tool === "terminal") return p.label ? `Working — ${p.label}` : "Working…";
	return p.label;
}

function endChatTurn() {
	chatActive = false;
	runningTools = new Map();
	renderApp();
}

// One persistent indicator: the current running tool step, or a generic
// "Working…" while the agent is busy but no tool is mid-run.
function currentToolPill(): ToolPill | null {
	if (!chatActive) return null;
	if (runningTools.size) {
		const arr = [...runningTools.values()];
		return arr[arr.length - 1];
	}
	return { emoji: "🤖", label: "Working…" };
}

function renderToolPills() {
	const p = currentToolPill();
	if (!p) return "";
	return html`
		<div class="ms-pills">
			<span class="ms-pill">
				<span class="ms-pill-emoji">${p.emoji}</span>
				<span class="ms-pill-label">${p.label}</span>
				<span class="ms-pill-spin"></span>
			</span>
		</div>
	`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderApp() {
	if (!user || !idToken) {
		renderSignIn();
		return;
	}
	if (view === "connect-whatsapp") {
		renderConnectWhatsapp();
		return;
	}
	renderChat();
}

function renderSignIn() {
	const app = document.getElementById("app");
	if (!app) return;
	render(
		html`
			<div class="ms-scene">
				<div class="ms-board ms-board--signin">
					<h1 class="ms-title"><img class="ms-cloud" src="/moneyshot/cloud-badge-v4.png" alt="" />MoneyShot</h1>
					<div class="ms-google-shell"><div id="google-btn"></div></div>
					${sessionExpiredNote ? html`<p class="ms-blocked">${sessionExpiredNote}</p>` : ""}
					${
						blockedEmail
							? html`<p class="ms-blocked">
									<strong>${blockedEmail}</strong> does not have access.<br />
									Sign in with a <strong>@${PRIMARY_DOMAIN}</strong> account.
								</p>`
							: ""
					}
				</div>
			</div>
		`,
		app,
	);
	renderGoogleButton();
}

function renderChat() {
	const app = document.getElementById("app");
	if (!app) return;
	render(
		html`
			<div class="ms-scene">
				<div class="ms-board">
					<div class="ms-header">
						<div class="ms-user">
							<h1 class="ms-title ms-title--sm"><img class="ms-cloud" src="/moneyshot/cloud-badge-v4.png" alt="" />MoneyShot</h1>
							<div class="ms-menu">
									<button class="ms-avatar" type="button" @click=${toggleDropdown} title=${user?.email ?? ""} aria-haspopup="true" aria-expanded=${dropdownOpen}>
										${
											user?.picture
												? html`<img src=${user.picture} alt="" referrerpolicy="no-referrer" />`
												: html`<span>${(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}</span>`
										}
									</button>
									${dropdownOpen ? renderDropdown() : ""}
								</div>
						</div>
					</div>
					${renderWaStatsBanner()}
						${chatPanel}
						${renderToolPills()}
				</div>
			</div>
		`,
		app,
	);
}

// Avatar dropdown: WhatsApp status row + Sign out. A transparent backdrop
// closes it on outside-click.
// Start a fresh conversation. Purely client-side (Hermes is stateless per
// request): clear the agent's in-memory messages AND the persisted session, so
// a refresh doesn't restore the cleared chat.
async function newChat() {
	dropdownOpen = false;
	const id = currentSessionId ?? localStorage.getItem(sessionPtrKey()) ?? undefined;
	if (id) {
		try {
			await storage.sessions.deleteSession(id);
		} catch {
			/* ignore — best effort */
		}
	}
	localStorage.removeItem(sessionPtrKey());
	currentSessionId = undefined;
	// Rebuild the agent + panel with empty history (loadRestoredMessages() now
	// returns [] because the pointer is gone).
	await createAgentAndPanel();
	view = "chat";
	renderApp();
}

function renderDropdown() {
	const linked = waConnected();
	return html`
		<div class="ms-dd-backdrop" @click=${() => { dropdownOpen = false; renderApp(); }}></div>
		<div class="ms-dropdown" role="menu">
			<div class="ms-dd-email">${user?.email ?? ""}</div>
			<button class="ms-dd-item" type="button" role="menuitem" @click=${() => void newChat()}>
				<span class="ms-dd-icon">＋</span>
				<span>New chat</span>
			</button>
			<button
				class="ms-dd-item"
				type="button"
				role="menuitem"
				@click=${() => void openConnectWhatsapp()}
			>
				<span class="ms-dot ${linked ? "ms-dot--green" : "ms-dot--orange"}"></span>
				<span>${linked ? "WhatsApp connected" : "Connect WhatsApp"}</span>
			</button>
			<button class="ms-dd-item" type="button" role="menuitem" @click=${signOut}>
				<span class="ms-dd-icon">⏻</span>
				<span>Sign out</span>
			</button>
		</div>
	`;
}

function renderConnectWhatsapp() {
	const app = document.getElementById("app");
	if (!app) return;

	const state = waStatus?.state;
	const isLinked = state === "linked";
	const hasQr = state === "qr" && !!waStatus?.qrUrl;
	const isExpired = state === "timeout" || state === "error";
	const isChecking = waStatus === null && !waError;
	const isStarting = waConnecting || state === "starting" || state === "reconnecting";
	const phone = waStatus?.number ? `+${waStatus.number}` : "";

	render(
		html`
			<div class="ms-scene">
				<div class="ms-board">
					<div class="ms-header ms-header--connect">
						<button class="ms-back" type="button" @click=${leaveConnectWhatsapp}>← Back</button>
						<h1 class="ms-title ms-title--sm"><img class="ms-cloud" src="/moneyshot/cloud-badge-v4.png" alt="" />MoneyShot</h1>
					</div>

					<div class="ms-connect">
						<h2 class="ms-connect-title">Connect WhatsApp</h2>
						${
							waError
								? html`<div class="ms-alert ms-alert--red">${waError}</div>`
								: isLinked
									? html`
										<div class="ms-alert ms-alert--green">✅ Connected${phone ? html` as <strong>${phone}</strong>` : ""}</div>
										<p class="ms-connect-sub">This agent can send and receive WhatsApp messages on your behalf.</p>
										<button class="ms-btn ms-btn--danger" type="button" @click=${disconnectWa}>Disconnect</button>
									`
									: isExpired
										? html`
											<div class="ms-alert ms-alert--amber">QR expired — regenerate to try again.</div>
											<button class="ms-btn" type="button" ?disabled=${waConnecting} @click=${regenerateQr}>
												${waConnecting ? "Generating…" : "Regenerate QR"}
											</button>
										`
										: hasQr
											? html`
												<div class="ms-qr-box">
													<img class="ms-qr" src=${`${waStatus.qrUrl}?t=${Date.now()}`} alt="WhatsApp QR code" />
												</div>
												<ol class="ms-steps">
													<li>Open <strong>WhatsApp</strong> on your phone</li>
													<li>Tap <strong>Settings</strong> → <strong>Linked devices</strong></li>
													<li>Tap <strong>Link a device</strong></li>
													<li>Point your phone at this screen to scan the code</li>
												</ol>
											`
											: isChecking
												? html`<div class="ms-connect-sub">Checking WhatsApp status…</div>`
												: isStarting
													? html`<div class="ms-connect-sub">Starting WhatsApp… generating a QR code.</div>`
													: html`<div class="ms-connect-sub">Preparing…</div>`
						}
					</div>
				</div>
			</div>
		`,
		app,
	);
}

function renderGoogleButton() {
	const target = document.getElementById("google-btn");
	const googleApi = window.google?.accounts?.id;
	if (!target) return;
	if (!googleApi) {
		window.setTimeout(renderGoogleButton, 100);
		return;
	}
	ensureGoogleInitialized();
	target.innerHTML = "";
	googleApi.renderButton(target, { theme: "outline", size: "large", shape: "pill", text: "signin_with", width: 280 });
}

function signOut() {
	const email = user?.email;
	agentUnsubscribe?.();
	agentUnsubscribe = undefined;
	currentSessionId = undefined;
	clearRefreshTimer();
	tokenExp = null;
	sessionExpiredNote = null;
	stopWaPolling();
	dropdownOpen = false;
	view = "chat";
	waStatus = null;
	waError = null;
	chatActive = false;
	runningTools = new Map();
	waStats = null;
	waStatsDismissed = false;
	clearSession();
	blockedEmail = null;
	agent = undefined;
	window.google?.accounts?.id?.disableAutoSelect?.();
	if (email && window.google?.accounts?.id?.revoke) window.google.accounts.id.revoke(email);
	renderApp();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
	sessionStorage.removeItem("ms_reloaded_for_preload");
	installToolProgressInterceptor();
	await setupStorage();
	user = loadSavedUser();
	if (user && idToken) {
		tokenExp = user.exp ?? null;
		scheduleTokenRefresh();
		await createAgentAndPanel();
		renderApp();
		void refreshWaStatus();
		void loadWaDisconnectStats();
	} else {
		renderApp();
	}
}

init();
