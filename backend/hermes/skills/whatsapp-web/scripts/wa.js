#!/usr/bin/env node
// WhatsApp Web (multi-device) CLI for the Hermes `whatsapp-web` skill.
//
// Subcommands:
//   link   --from <number>                 Start/refresh a QR link for <number>.
//                                           Long-running: writes a QR to status
//                                           until the phone scans it, then persists
//                                           creds and exits. Run it backgrounded.
//   status --from <number>                 Print JSON link state (none|qr|linked|
//                                           timeout|error) + the current QR data-URI.
//   send   --from <number> --to <number>   Send <text> from a linked account.
//          --text <message>
//
// Sessions persist under  <skill>/sessions/<fromDigits>/  (on the /opt/data volume),
// so a number stays linked across restarts until it is logged out.
//
// NOTE: this uses the UNOFFICIAL WhatsApp Web protocol (Baileys). It violates
// WhatsApp's ToS and the linked number can be banned. Send only to recipients the
// user explicitly provided; never bulk-blast.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import makeWASocket, {
	useMultiFileAuthState,
	DisconnectReason,
	fetchLatestBaileysVersion,
	Browsers,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";

const SELF = fileURLToPath(import.meta.url);
const __dirname = dirname(SELF);
const SKILL_DIR = join(__dirname, "..");
const SESSIONS_DIR = join(SKILL_DIR, "sessions");
// Shared scratch dir served by the bff, and the public URL prefix it maps to.
// The model won't reliably echo a multi-KB data-URI into chat, so we serve the
// QR as a real image at a short, unguessable URL and hand that to the model.
const QR_DIR = process.env.WA_QR_DIR || "/waqr";
const QR_URL_PREFIX = process.env.WA_QR_URL_PREFIX || "/moneyshot/api/qr";
const logger = pino({ level: "silent" });

// Write the QR PNG to the shared dir; return the public URL, or null if the dir
// isn't available (e.g. local runs without the volume — data-URI still works).
async function writeQrPng(token, qr) {
	try {
		mkdirSync(QR_DIR, { recursive: true });
		await QRCode.toFile(join(QR_DIR, `${token}.png`), qr, { margin: 2, scale: 8 });
		return `${QR_URL_PREFIX}/${token}.png`;
	} catch {
		return null;
	}
}

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
		else out._.push(a);
	}
	return out;
}
// Keep only digits — WhatsApp JIDs and session keys are digit-only.
const digits = (s) => String(s || "").replace(/[^0-9]/g, "");

// Normalize a recipient number to WhatsApp form (digits, WITH country code — no
// '+'). A bare 10-digit Indian mobile is prepended with 91; WhatsApp's
// onWhatsApp() resolution is unreliable for country-code-less numbers (it may
// "accept" the send but never deliver). Mirrors bulk.js normalizePhone so the
// single-send and bulk skills treat numbers identically. Returns "" if unusable.
const normalizeTo = (raw) => {
	let p = String(raw || "").trim();
	if (!p) return "";
	const hadPlus = p.startsWith("+");
	p = p.replace(/[^0-9]/g, "");
	if (!p) return "";
	if (!hadPlus && p.length === 10) return "91" + p; // 10-digit India local → +91
	if (p.length === 11 && p.startsWith("0")) return "91" + p.slice(1); // 0XXXXXXXXXX
	if (p.length === 12 && p.startsWith("91")) return p; // already 91XXXXXXXXXX
	if (p.length >= 11 && p.length <= 15) return p; // other full international
	return ""; // too short / clearly invalid
};

function sessionDir(fromDigits) {
	return join(SESSIONS_DIR, fromDigits);
}
function statusPath(fromDigits) {
	return join(sessionDir(fromDigits), "status.json");
}
function readStatus(fromDigits) {
	try {
		return JSON.parse(readFileSync(statusPath(fromDigits), "utf8"));
	} catch {
		return { state: "none" };
	}
}
function writeStatus(fromDigits, obj) {
	const dir = sessionDir(fromDigits);
	mkdirSync(dir, { recursive: true });
	const cur = readStatus(fromDigits);
	writeFileSync(statusPath(fromDigits), JSON.stringify({ ...cur, ...obj, updated: Date.now() }, null, 2));
}
function out(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

// Shared debug log — one greppable JSONL file for all WhatsApp activity.
// Tail with:  docker compose exec hermes tail -f /opt/data/logs/whatsapp.log
const LOG_DIR = process.env.WA_LOG_DIR || "/opt/data/logs";
const LOG_FILE = join(LOG_DIR, "whatsapp.log");
function log(obj) {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), src: "wa", pid: process.pid, ...obj }) + "\n");
	} catch {}
}

async function makeSock(fromDigits, log = logger) {
	const dir = sessionDir(fromDigits);
	mkdirSync(dir, { recursive: true });
	const { state, saveCreds } = await useMultiFileAuthState(dir);
	const { version } = await fetchLatestBaileysVersion();
	const sock = makeWASocket({
		version,
		auth: state,
		logger: log,
		printQRInTerminal: false,
		browser: Browsers.ubuntu("Chrome"),
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});
	sock.ev.on("creds.update", saveCreds);
	return sock;
}

// Is there a usable credential set on disk? A linked multi-device session always
// has `me.id`; the `registered` flag is not reliably true post-pairing, so key off
// me.id (the authoritative "this account is linked" signal).
function hasCreds(fromDigits) {
	try {
		const creds = JSON.parse(readFileSync(join(sessionDir(fromDigits), "creds.json"), "utf8"));
		return Boolean(creds?.me?.id);
	} catch {
		return false;
	}
}

// Authoritative "this account is actually linked" — mirrors pektown: trust the
// explicit `connected` boolean the worker writes (true ONLY on connection:"open",
// false on qr/close/timeout). WhatsApp can write creds.me.id during a HALF-finished
// pairing (device id present, link never opened) — so me.id alone is NOT enough.
// Fallback for sessions written before the explicit flag: creds + state "linked".
function isLinked(fromDigits) {
	const s = readStatus(fromDigits);
	if (typeof s.connected === "boolean") return s.connected && hasCreds(fromDigits);
	return hasCreds(fromDigits) && s.state === "linked";
}

// ---- link (fast spawner) ---------------------------------------------------
// The pairing handshake completes only when the user scans — which happens
// seconds-to-minutes later, across agent turns. So the Baileys socket must
// OUTLIVE this command. We spawn a DETACHED worker (its own session via
// detached:true, so Hermes' terminal tool killing the turn's process group
// doesn't take it down) and return immediately — no nohup/& (which Hermes
// rejects). The agent then polls `status` for the QR and the link result.
function pidPath(fromDigits) {
	return join(sessionDir(fromDigits), "worker.pid");
}
function workerAlive(fromDigits) {
	try {
		const pid = parseInt(readFileSync(pidPath(fromDigits), "utf8").trim(), 10);
		if (!pid) return false;
		process.kill(pid, 0); // throws if not running
		return true;
	} catch {
		return false;
	}
}
function killWorker(fromDigits) {
	try {
		const pid = parseInt(readFileSync(pidPath(fromDigits), "utf8").trim(), 10);
		if (pid) process.kill(pid, "SIGTERM");
	} catch {}
	try {
		rmSync(pidPath(fromDigits), { force: true });
	} catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdLink(fromDigits) {
	fromDigits = resolveFrom(fromDigits);
	if (isLinked(fromDigits)) {
		out({ ok: true, connected: true, state: "linked", number: linkedNumber(fromDigits) });
		return 0;
	}
	// Not linked (or a half-finished pairing): start fresh. Kill any prior worker.
	if (workerAlive(fromDigits)) killWorker(fromDigits);
	mkdirSync(sessionDir(fromDigits), { recursive: true });
	writeStatus(fromDigits, { state: "starting", connected: false, qr: null, qrUrl: null });
	const child = spawn(process.execPath, [SELF, "__worker", "--key", fromDigits], {
		detached: true,
		stdio: "ignore",
	});
	writeFileSync(pidPath(fromDigits), String(child.pid));
	child.unref();
	// Block briefly for the worker to produce the QR, then return the URL directly
	// so the agent NEVER needs to poll in a loop (a poll loop is what blocks the
	// turn for ~150s). The detached worker keeps the socket alive for the scan.
	for (let i = 0; i < 30; i++) {
		await sleep(500);
		const s = readStatus(fromDigits);
		if (s.state === "qr" && s.qrUrl) {
			out({ ok: true, state: "qr", qrUrl: s.qrUrl, qrAscii: s.qrAscii });
			return 0;
		}
		if (s.state === "linked") {
			out({ ok: true, state: "linked", number: linkedNumber(fromDigits) });
			return 0;
		}
		if (s.state === "error") {
			out({ ok: false, state: "error", error: s.error });
			return 1;
		}
	}
	out({ ok: true, state: "starting", note: "QR not ready yet — run `status` once more in a few seconds" });
	return 0;
}

// ---- link worker (detached, long-lived, self-reconnecting) -----------------
async function cmdWorker(fromDigits, { timeoutMs = 240000 } = {}) {
	const dir = sessionDir(fromDigits);
	mkdirSync(dir, { recursive: true });
	// Log Baileys to a file so a failed handshake ("couldn't link device") has a
	// diagnosable reason instead of vanishing into a silent logger.
	const flog = pino({ level: "info" }, pino.destination({ dest: join(dir, "link.log"), sync: false }));
	const token = randomBytes(16).toString("hex");
	writeStatus(fromDigits, { state: "starting", connected: false, qr: null, token });

	const deadline = Date.now() + timeoutMs;
	let done = false;
	const finish = (code) => {
		if (done) return;
		done = true;
		try {
			rmSync(pidPath(fromDigits), { force: true });
		} catch {}
		process.exit(code);
	};
	setTimeout(() => {
		if (!isLinked(fromDigits)) writeStatus(fromDigits, { state: "timeout", connected: false, qr: null, qrUrl: null });
		finish(isLinked(fromDigits) ? 0 : 2);
	}, timeoutMs);

	// (Re)connect until linked or the deadline. A close before scan (QR expiry,
	// network blip) recreates the socket so a fresh QR keeps flowing.
	async function connect() {
		if (done) return;
		const sock = await makeSock(fromDigits, flog);
		sock.ev.on("connection.update", async (u) => {
			const { connection, lastDisconnect, qr } = u;
			if (qr) {
				const qrUrl = await writeQrPng(token, qr);
				const dataUri = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
				const ascii = await QRCode.toString(qr, { type: "utf8", small: true });
				writeStatus(fromDigits, { state: "qr", connected: false, qrUrl, token, qr: dataUri, qrAscii: ascii });
				log({ cmd: "link", key: fromDigits, event: "qr", qrUrl });
			}
			if (connection === "open") {
				const number = linkedNumber(fromDigits);
				// connected:true is written ONLY here (a real, live open) — the
				// authoritative signal the status/dot trusts.
				writeStatus(fromDigits, { state: "linked", connected: true, number, qr: null, qrUrl: null, qrAscii: null });
				log({ cmd: "link", key: fromDigits, event: "linked", number });
				setTimeout(() => finish(0), 1500); // let creds flush
			}
			if (connection === "close") {
				const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
				flog.info({ code, reason: String(lastDisconnect?.error?.message || "") }, "connection close");
				log({ cmd: "link", key: fromDigits, event: "close", code, reason: String(lastDisconnect?.error?.message || "") });
				if (code === DisconnectReason.loggedOut) {
					try {
						rmSync(dir, { recursive: true, force: true });
					} catch {}
					writeStatus(fromDigits, { state: "error", connected: false, error: "logged_out", qr: null, qrUrl: null });
					finish(1);
				} else if (!isLinked(fromDigits) && Date.now() < deadline) {
					writeStatus(fromDigits, { state: "reconnecting", connected: false, lastCode: code || null });
					try {
						sock.ws?.close();
					} catch {}
					setTimeout(() => connect().catch(() => {}), 1500);
				}
			}
		});
	}
	await connect();
	return new Promise(() => {}); // stay alive; timer/finish exits
}

function linkedNumber(fromDigits) {
	try {
		const creds = JSON.parse(readFileSync(join(sessionDir(fromDigits), "creds.json"), "utf8"));
		return digits((creds?.me?.id || "").split(":")[0].split("@")[0]);
	} catch {
		return null;
	}
}

// Resolve the session key for a from-number: prefer an exact linked session,
// else any linked session whose number suffix-matches (handles the user giving
// 10 vs 12 digits — with/without country code). Falls back to the input.
function resolveFrom(fromDigits) {
	if (isLinked(fromDigits)) return fromDigits;
	try {
		for (const name of readdirSync(SESSIONS_DIR)) {
			if (!isLinked(name)) continue;
			const ln = linkedNumber(name);
			if (ln && (ln === fromDigits || ln.endsWith(fromDigits) || fromDigits.endsWith(ln))) return name;
		}
	} catch {}
	return fromDigits;
}

// All session keys on disk that hold a genuinely-linked WhatsApp (connected:true).
function linkedSessions() {
	try {
		return readdirSync(SESSIONS_DIR).filter(isLinked);
	} catch {
		return [];
	}
}

// ---- status ---------------------------------------------------------------
// Always reports a top-level `connected` boolean so the caller can gate on it.
// With no key, reflects the single linked session (the common case), or flags
// `multiple` if more than one account is linked.
function cmdStatus(fromKey) {
	if (!fromKey) {
		const linked = linkedSessions();
		if (linked.length === 0) return (out({ ok: true, connected: false, state: "none" }), 0);
		if (linked.length === 1)
			return (out({ ok: true, connected: true, state: "linked", number: linkedNumber(linked[0]) }), 0);
		return (out({ ok: true, connected: true, state: "linked", multiple: true, numbers: linked.map(linkedNumber) }), 0);
	}
	const key = resolveFrom(fromKey);
	const s = readStatus(key);
	const connected = isLinked(key);
	if (connected) s.number = linkedNumber(key);
	out({ ok: true, connected, ...s });
	return 0;
}

// ---- send ------------------------------------------------------------------
async function cmdSend(fromArg, toDigits, text) {
	// An explicitly-typed sender NUMBER (for the mismatch guard). The resolved
	// session key may be a non-numeric per-user key (e.g. an email), so we must
	// not compare the linked number against the key.
	const requestedNumber = /^[0-9]{5,}$/.test(String(fromArg || "")) ? String(fromArg) : "";
	// Resolve which linked session to send from. No arg → the single linked
	// session (common case); >1 linked → ask which number. Never pair here.
	let key;
	if (!fromArg) {
		const linked = linkedSessions();
		if (linked.length === 0) return (out({ ok: false, error: "not_linked" }), 3);
		if (linked.length > 1) return (out({ ok: false, error: "need_from", numbers: linked.map(linkedNumber) }), 6);
		key = linked[0];
	} else {
		key = resolveFrom(fromArg);
	}
	if (!isLinked(key)) {
		log({ cmd: "send", to: toDigits, ok: false, error: "not_linked", key });
		out({ ok: false, error: "not_linked", message: `No connected WhatsApp for ${fromArg || "this user"}.` });
		return 3;
	}
	if (!toDigits) return (out({ ok: false, error: "bad_to" }), 4);
	if (!text) return (out({ ok: false, error: "empty_text" }), 4);

	const sock = await makeSock(key);
	return await new Promise((resolve) => {
		let settled = false;
		const done = (obj, code) => {
			if (settled) return;
			settled = true;
			log({ cmd: "send", to: toDigits, ok: !!obj.ok, id: obj.id, error: obj.error, code });
			out(obj);
			try {
				sock.ws?.close();
			} catch {}
			setTimeout(() => resolve(code), 500);
		};
		const guard = setTimeout(() => done({ ok: false, error: "timeout" }, 5), 45000);

		sock.ev.on("connection.update", async (u) => {
			const { connection, lastDisconnect } = u;
			if (connection === "open") {
				try {
					const linked = linkedNumber(key);
					// The user often omits the country code (e.g. 9820011185 vs the
					// linked 919820011185). Treat it as a match when one number is a
					// suffix of the other; only a genuinely different account errors.
					const loose =
						linked &&
						(!requestedNumber || linked === requestedNumber || linked.endsWith(requestedNumber) || requestedNumber.endsWith(linked));
					if (linked && !loose) {
						clearTimeout(guard);
						return done(
							{ ok: false, error: "from_mismatch", linked, requested: requestedNumber },
							6,
						);
					}
					const [chk] = await sock.onWhatsApp(toDigits).catch(() => [null]);
					if (!chk?.exists) {
						clearTimeout(guard);
						return done({ ok: false, error: "recipient_not_on_whatsapp", to: toDigits }, 7);
					}
					const res = await sock.sendMessage(chk.jid, { text });
					clearTimeout(guard);
					done({ ok: true, to: toDigits, id: res?.key?.id, from: linked }, 0);
				} catch (e) {
					clearTimeout(guard);
					done({ ok: false, error: "send_failed", message: String(e?.message || e) }, 8);
				}
			}
			if (connection === "close") {
				const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
				if (code === DisconnectReason.loggedOut) {
					clearTimeout(guard);
					done({ ok: false, error: "logged_out" }, 3);
				}
			}
		});
	});
}

// ---- logout ----------------------------------------------------------------
async function cmdLogout(key) {
	killWorker(key);
	// Best-effort server-side device unlink (so WhatsApp drops it), then wipe local
	// creds. If the socket can't open quickly, just wipe — status will read as none.
	if (hasCreds(key)) {
		try {
			const sock = await makeSock(key);
			await Promise.race([
				new Promise((r) => sock.ev.on("connection.update", (u) => u.connection === "open" && r())),
				sleep(4000),
			]);
			await sock.logout().catch(() => {});
			try {
				sock.ws?.close();
			} catch {}
		} catch {}
	}
	try {
		rmSync(sessionDir(key), { recursive: true, force: true });
	} catch {}
	log({ cmd: "logout", key });
	out({ ok: true, state: "logged_out" });
	return 0;
}

// ---- serve (HTTP helper the bff proxies, pektown-style) --------------------
// Runs the CLI verbs as subprocesses so it reuses the exact battle-tested paths.
// Keyed per user via ?user= (the bff passes the verified Google email). Internal
// only (msnet) — the bff enforces auth + ownership before proxying here.
function runCli(verb, key) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [SELF, verb, "--key", key], { stdio: ["ignore", "pipe", "ignore"] });
		let buf = "";
		p.stdout.on("data", (d) => (buf += d));
		p.on("close", () => {
			const line = buf.trim().split("\n").filter(Boolean).pop() || "{}";
			try {
				resolve(JSON.parse(line));
			} catch {
				resolve({ ok: false, error: "bad_output", raw: buf.slice(0, 300) });
			}
		});
		p.on("error", (e) => resolve({ ok: false, error: "spawn_failed", message: String(e?.message || e) }));
	});
}

function cmdServe() {
	const port = parseInt(process.env.WA_SVC_PORT || "8100", 10);
	const server = createServer(async (req, res) => {
		const u = new URL(req.url, "http://x");
		const send = (o, code = 200) => {
			res.writeHead(code, { "content-type": "application/json" });
			res.end(JSON.stringify(o));
		};
		try {
			if (u.pathname === "/health") return send({ ok: true, service: "wa" });
			const raw = u.searchParams.get("user") || u.searchParams.get("key") || "";
			const key = raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128);
			if (!key) return send({ ok: false, error: "missing_user" }, 400);
			if (req.method === "GET" && u.pathname === "/status") return send(await runCli("status", key));
			if (req.method === "POST" && u.pathname === "/login") {
				log({ cmd: "serve", route: "login", key });
				return send(await runCli("link", key));
			}
			if (req.method === "POST" && u.pathname === "/logout") {
				log({ cmd: "serve", route: "logout", key });
				return send(await runCli("logout", key));
			}
			send({ ok: false, error: "not_found" }, 404);
		} catch (e) {
			log({ cmd: "serve", error: "exception", message: String(e?.message || e) });
			send({ ok: false, error: "exception", message: String(e?.message || e) }, 500);
		}
	});
	server.listen(port, "0.0.0.0", () => out({ ok: true, state: "serving", port }));
	return new Promise(() => {}); // run forever
}

// ---- main ------------------------------------------------------------------
(async () => {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];
	// `--key` is a raw session key (verbatim, e.g. a per-user id); `--from` is a
	// phone number (digit-stripped). Connect-screen flows use --key; chat uses --from.
	const from = args.key != null ? String(args.key) : digits(args.from);
	if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
	try {
		// link/logout/__worker operate on a specific session key; status/send can
		// run without one (they resolve the single linked session).
		if (!from && (cmd === "link" || cmd === "logout" || cmd === "__worker"))
			return (out({ ok: false, error: "missing_from" }), process.exit(4));
		if (cmd === "link") process.exit(await cmdLink(from));
		else if (cmd === "__worker") await cmdWorker(from); // detached; exits via finish()
		else if (cmd === "status") process.exit(cmdStatus(from));
		else if (cmd === "logout") process.exit(await cmdLogout(from));
		else if (cmd === "send") process.exit(await cmdSend(from, normalizeTo(args.to), args.text));
		else if (cmd === "serve") await cmdServe(); // long-lived HTTP helper
		else {
			out({
				ok: false,
				error: "unknown_command",
				usage: "link|status|logout|send --from <n> [--to <n> --text <msg>] | serve",
			});
			process.exit(4);
		}
	} catch (e) {
		log({ cmd, error: "exception", message: String(e?.stack || e) });
		out({ ok: false, error: "exception", message: String(e?.stack || e) });
		process.exit(1);
	}
})();
