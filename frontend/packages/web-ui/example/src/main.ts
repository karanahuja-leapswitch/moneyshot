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
// Render
// ---------------------------------------------------------------------------

function renderSignIn() {
	const app = document.getElementById("app");
	if (!app) return;
	render(
		html`
			<div class="ms-scene">
				<div class="ms-board ms-board--signin">
					<h1 class="ms-title"><img class="ms-cloud" src="/moneyshot/cloud-badge-v3.png" alt="" />MoneyShot</h1>
					<div class="ms-google-shell"><div id="google-btn"></div></div>
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
							<h1 class="ms-title ms-title--sm"><img class="ms-cloud" src="/moneyshot/cloud-badge-v3.png" alt="" />MoneyShot</h1>
							<button class="ms-avatar" type="button" @click=${signOut} title=${`Sign out ${user?.email ?? ""}`}>
								${
									user?.picture
										? html`<img src=${user.picture} alt="Sign out" referrerpolicy="no-referrer" />`
										: html`<span>${(user?.name || user?.email || "?").slice(0, 1).toUpperCase()}</span>`
								}
							</button>
						</div>
					</div>
					${chatPanel}
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
	if (!googleInitialized) {
		googleApi.initialize({
			client_id: GOOGLE_CLIENT_ID,
			callback: async (response: { credential: string }) => {
				const signedIn = decodeJwt(response.credential);
				if (!signedIn) return;
				if (!ALLOWED_DOMAINS.includes(domainOf(signedIn.email))) {
					blockedEmail = signedIn.email;
					window.google?.accounts?.id?.disableAutoSelect?.();
					renderSignIn();
					return;
				}
				localStorage.setItem(GOOGLE_CREDENTIAL_KEY, response.credential);
				localStorage.setItem(GOOGLE_USER_KEY, JSON.stringify(signedIn));
				idToken = response.credential;
				user = signedIn;
				blockedEmail = null;
				await createAgentAndPanel();
				renderChat();
			},
		});
		googleInitialized = true;
	}
	target.innerHTML = "";
	googleApi.renderButton(target, { theme: "outline", size: "large", shape: "pill", text: "signin_with", width: 280 });
}

function signOut() {
	const email = user?.email;
	agentUnsubscribe?.();
	agentUnsubscribe = undefined;
	currentSessionId = undefined;
	clearSession();
	blockedEmail = null;
	agent = undefined;
	window.google?.accounts?.id?.disableAutoSelect?.();
	if (email && window.google?.accounts?.id?.revoke) window.google.accounts.id.revoke(email);
	renderSignIn();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
	await setupStorage();
	user = loadSavedUser();
	if (user && idToken) {
		await createAgentAndPanel();
		renderChat();
	} else {
		renderSignIn();
	}
}

init();
