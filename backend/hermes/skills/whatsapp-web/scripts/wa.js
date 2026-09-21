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

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import makeWASocket, {
	useMultiFileAuthState,
	DisconnectReason,
	fetchLatestBaileysVersion,
	Browsers,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";

const __dirname = dirname(fileURLToPath(import.meta.url));
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

async function makeSock(fromDigits) {
	const dir = sessionDir(fromDigits);
	mkdirSync(dir, { recursive: true });
	const { state, saveCreds } = await useMultiFileAuthState(dir);
	const { version } = await fetchLatestBaileysVersion();
	const sock = makeWASocket({
		version,
		auth: state,
		logger,
		printQRInTerminal: false,
		browser: Browsers.ubuntu("Chrome"),
		syncFullHistory: false,
		markOnlineOnConnect: false,
	});
	sock.ev.on("creds.update", saveCreds);
	return sock;
}

// Is there a usable (registered) credential set on disk?
function hasCreds(fromDigits) {
	try {
		const creds = JSON.parse(readFileSync(join(sessionDir(fromDigits), "creds.json"), "utf8"));
		return Boolean(creds?.registered && creds?.me?.id);
	} catch {
		return false;
	}
}

// ---- link -----------------------------------------------------------------
async function cmdLink(fromDigits, { timeoutMs = 120000 } = {}) {
	if (hasCreds(fromDigits)) {
		writeStatus(fromDigits, { state: "linked", number: linkedNumber(fromDigits), qr: null });
		out({ ok: true, state: "linked", number: linkedNumber(fromDigits) });
		return 0;
	}
	// One stable token per link attempt → stable QR URL even as the code rotates.
	const token = randomBytes(16).toString("hex");
	writeStatus(fromDigits, { state: "starting", qr: null, token });
	const sock = await makeSock(fromDigits);
	let done = false;

	const finish = (code) => {
		if (done) return;
		done = true;
		try {
			sock.ws?.close();
		} catch {}
		process.exit(code);
	};

	const timer = setTimeout(() => {
		if (!hasCreds(fromDigits)) {
			writeStatus(fromDigits, { state: "timeout", qr: null });
			out({ ok: false, state: "timeout" });
		}
		finish(hasCreds(fromDigits) ? 0 : 2);
	}, timeoutMs);

	sock.ev.on("connection.update", async (u) => {
		const { connection, lastDisconnect, qr } = u;
		if (qr) {
			// Preferred: a served PNG at a short URL (reliable in chat). Also keep a
			// data-URI + UTF-8 as fallbacks (terminal / no shared volume).
			const qrUrl = await writeQrPng(token, qr);
			const dataUri = await QRCode.toDataURL(qr, { margin: 1, scale: 6 });
			const ascii = await QRCode.toString(qr, { type: "utf8", small: true });
			writeStatus(fromDigits, { state: "qr", qrUrl, token, qr: dataUri, qrAscii: ascii });
		}
		if (connection === "open") {
			clearTimeout(timer);
			const number = linkedNumber(fromDigits);
			writeStatus(fromDigits, { state: "linked", number, qr: null, qrAscii: null });
			out({ ok: true, state: "linked", number });
			// Give creds a beat to flush, then exit.
			setTimeout(() => finish(0), 1500);
		}
		if (connection === "close") {
			const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
			if (code === DisconnectReason.loggedOut) {
				// Bad/rejected credentials — wipe so the next link starts clean.
				try {
					rmSync(sessionDir(fromDigits), { recursive: true, force: true });
				} catch {}
				writeStatus(fromDigits, { state: "error", error: "logged_out", qr: null });
				out({ ok: false, state: "error", error: "logged_out" });
				finish(1);
			}
			// Any other close before "open": let the timer or a fresh QR handle it.
		}
	});
	return new Promise(() => {}); // keep alive; finish()/timer exits the process
}

function linkedNumber(fromDigits) {
	try {
		const creds = JSON.parse(readFileSync(join(sessionDir(fromDigits), "creds.json"), "utf8"));
		return digits((creds?.me?.id || "").split(":")[0].split("@")[0]);
	} catch {
		return null;
	}
}

// ---- status ---------------------------------------------------------------
function cmdStatus(fromDigits) {
	const s = readStatus(fromDigits);
	if (hasCreds(fromDigits) && s.state !== "linked") s.state = "linked";
	if (s.state === "linked") s.number = linkedNumber(fromDigits);
	out({ ok: true, ...s });
	return 0;
}

// ---- send ------------------------------------------------------------------
async function cmdSend(fromDigits, toDigits, text) {
	if (!hasCreds(fromDigits)) {
		out({ ok: false, error: "not_linked", message: `No linked WhatsApp for ${fromDigits}. Run link first.` });
		return 3;
	}
	if (!toDigits) return (out({ ok: false, error: "bad_to" }), 4);
	if (!text) return (out({ ok: false, error: "empty_text" }), 4);

	const sock = await makeSock(fromDigits);
	return await new Promise((resolve) => {
		let settled = false;
		const done = (obj, code) => {
			if (settled) return;
			settled = true;
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
					const linked = linkedNumber(fromDigits);
					if (linked && linked !== fromDigits) {
						clearTimeout(guard);
						return done(
							{ ok: false, error: "from_mismatch", linked, requested: fromDigits },
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

// ---- main ------------------------------------------------------------------
(async () => {
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];
	const from = digits(args.from);
	if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
	try {
		if (!from && cmd !== "help") return (out({ ok: false, error: "missing_from" }), process.exit(4));
		if (cmd === "link") process.exit(await cmdLink(from));
		else if (cmd === "status") process.exit(cmdStatus(from));
		else if (cmd === "send") process.exit(await cmdSend(from, digits(args.to), args.text));
		else {
			out({ ok: false, error: "unknown_command", usage: "link|status|send --from <n> [--to <n> --text <msg>]" });
			process.exit(4);
		}
	} catch (e) {
		out({ ok: false, error: "exception", message: String(e?.stack || e) });
		process.exit(1);
	}
})();
