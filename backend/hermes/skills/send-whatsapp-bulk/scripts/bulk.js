#!/usr/bin/env node
// 📲 Scheduled WhatsApp BULK send for Hermes (revenue-recovery outreach).
//
// Model: STAGE + DISPATCH (durable, restart-safe).
//   start    — validate, then STAGE one row per number into customer_messages
//              (status='scheduled', scheduled_at set with cumulative 75–105s gaps),
//              only within the 9am–6pm IST window. When the day's window fills up,
//              stops and reports "queue full" + the last number that made it in.
//              Any number of recipients (no 15 cap); the daily window is the limit.
//   dispatch — run every minute by ONE cron job (wa-bulk-dispatcher). Sends the
//              earliest DUE scheduled message via wa.js, one at a time, honoring a
//              ~75s min gap and a 3h per-number cooldown. Silent stdout.
//   status   — today's queue snapshot (scheduled / sent / failed / skipped, next send).
//
// ⚠️ Unofficial WhatsApp Web (Baileys) via wa.js — against ToS; pacing + windowing
// + cooldown reduce (not eliminate) ban risk.

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = join(dirname(SELF), "..");
const SKILLS_ROOT = join(SKILL_DIR, "..");
const WA_JS = join(SKILLS_ROOT, "whatsapp-web", "scripts", "wa.js");
// Shared debug log — same JSONL file wa.js writes to. Tail with:
//   docker compose exec hermes tail -f /opt/data/logs/whatsapp.log
const LOG_DIR = process.env.WA_LOG_DIR || "/opt/data/logs";
const LOG_FILE = join(LOG_DIR, "whatsapp.log");

const DELAY_MIN_MS = 75_000;
const DELAY_MAX_MS = 105_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30 (no DST)
// Window hours (env-overridable for tests; prod uses the defaults).
const envInt = (k, d) => (process.env[k] != null && process.env[k] !== "" ? Number(process.env[k]) : d);
const WINDOW_START_H = envInt("WA_WINDOW_START_H", 9); // 9am IST — scheduling window start
const WINDOW_END_H = envInt("WA_WINDOW_END_H", 18); // 6pm IST — scheduling window end (no NEW messages past this)
const DISPATCH_END_H = envInt("WA_DISPATCH_END_H", 19); // 7:30pm IST — hard SEND cutoff: dispatcher stops
const DISPATCH_END_M = envInt("WA_DISPATCH_END_M", 30); //   after this (6→7:30pm = 1.5h to drain), resumes 9am.
const COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3h per-number
const MIN_SEND_GAP_MS = 75_000; // dispatcher: min gap between real sends
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries on failure

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const randDelay = () => DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1));
// "now" is env-overridable (WA_NOW_MS) so time-window tests are deterministic.
const nowMs = () => (process.env.WA_NOW_MS ? Number(process.env.WA_NOW_MS) : Date.now());
function log(obj) {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), src: "bulk", pid: process.pid, ...obj }) + "\n");
	} catch {}
}

function parseArgs(argv) {
	const a = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
		else a._.push(argv[i]);
	}
	return a;
}

// India-friendly → digits with country code (no '+'), matching wa.js send.
function normalizePhone(raw) {
	let p = String(raw || "").trim();
	if (!p) return null;
	const hadPlus = p.startsWith("+");
	p = p.replace(/[^0-9]/g, "");
	if (!p) return null;
	if (!hadPlus && p.length === 10) return "91" + p;
	if (p.length === 11 && p.startsWith("0")) return "91" + p.slice(1);
	if (p.length === 12 && p.startsWith("91")) return p;
	if (p.length >= 11 && p.length <= 15) return p;
	return null;
}

// IST calendar day (YYYY-MM-DD) for an epoch-ms instant. Respects WA_NOW_MS via caller.
const istDayStr = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

// The 9am–6pm IST window (as UTC epoch ms) for the IST-day containing nowMs.
function istWindow(nowMs) {
	const ist = new Date(nowMs + IST_OFFSET_MS);
	const y = ist.getUTCFullYear(), mo = ist.getUTCMonth(), d = ist.getUTCDate();
	const at = (h, m = 0) => Date.UTC(y, mo, d, h, m, 0) - IST_OFFSET_MS;
	// startMs/endMs = scheduling window (9–18 IST); dispatchEndMs = send cutoff (19:30 IST).
	return { startMs: at(WINDOW_START_H), endMs: at(WINDOW_END_H), dispatchEndMs: at(DISPATCH_END_H, DISPATCH_END_M) };
}

function pool() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL not set");
	return new pg.Pool({ connectionString: url, max: 2 });
}
async function upsertCustomer(db, phone) {
	const r = await db.query(
		`INSERT INTO customers (phone) VALUES ($1)
		 ON CONFLICT (phone) DO UPDATE SET updated_at = now() RETURNING id`,
		[phone],
	);
	return r.rows[0].id;
}
// +1 the disconnected-tick counter for the given instant's IST day (upsert).
async function recordDisconnectTick(db, now) {
	await db.query(
		`INSERT INTO disconnected_whatsapp_ticks_daily (day, disconnected_ticks)
		 VALUES ($1, 1)
		 ON CONFLICT (day) DO UPDATE
		   SET disconnected_ticks = disconnected_whatsapp_ticks_daily.disconnected_ticks + 1,
		       updated_at = now()`,
		[istDayStr(now)],
	);
}

// Why a number can't be queued right now (checked at `start`, from the DB):
//   "already_queued" — it still has a pending (scheduled/sending) message; queuing
//                      again would be a duplicate. Caught even if the first hasn't sent yet.
//   "cooldown"       — it was successfully sent within the last 3h (mirrors dispatch).
// Returns null if the number is free to queue.
async function blockReason(db, phone, now) {
	const pend = await db.query(
		`SELECT 1 FROM customer_messages WHERE phone=$1 AND status IN ('scheduled','sending') LIMIT 1`,
		[phone],
	);
	if (pend.rowCount) return "already_queued";
	const r = await db.query(
		`SELECT max(created_at) AS last FROM customer_messages WHERE phone=$1 AND status='sent'`,
		[phone],
	);
	if (r.rows[0].last && now - new Date(r.rows[0].last).getTime() < COOLDOWN_MS) return "cooldown";
	return null;
}

// Last record currently in today's sending queue (latest scheduled_at, still pending).
async function queueTail(db, startMs, endMs) {
	const r = await db.query(
		`SELECT phone, message, scheduled_at FROM customer_messages
		 WHERE status IN ('scheduled','sending') AND scheduled_at >= $1 AND scheduled_at <= $2
		 ORDER BY scheduled_at DESC LIMIT 1`,
		[new Date(startMs), new Date(endMs)],
	);
	return r.rows[0] ? { phone: r.rows[0].phone, message: r.rows[0].message, scheduledAt: r.rows[0].scheduled_at } : null;
}

// ---- whatsapp (reuse wa.js) ------------------------------------------------
function waRun(argsArr) {
	return new Promise((resolve) => {
		const p = spawn(process.execPath, [WA_JS, ...argsArr], { stdio: ["ignore", "pipe", "ignore"] });
		let buf = "";
		p.stdout.on("data", (d) => (buf += d));
		p.on("close", () => {
			try {
				resolve(JSON.parse(buf.trim().split("\n").filter(Boolean).pop() || "{}"));
			} catch {
				resolve({ ok: false, error: "bad_wa_output" });
			}
		});
		p.on("error", (e) => resolve({ ok: false, error: "spawn_failed", message: String(e?.message || e) }));
	});
}
// Connection + the connected account's own number (the "from").
const waStatusInfo = async () => {
	// Test override: WA_BULK_FAKE_CONNECTED=1/0 (+ WA_BULK_FAKE_NUMBER) skips wa.js.
	const f = process.env.WA_BULK_FAKE_CONNECTED;
	if (f != null && f !== "") {
		const connected = f === "1" || f === "true";
		return { connected, number: connected ? process.env.WA_BULK_FAKE_NUMBER || "919999999999" : null };
	}
	const s = await waRun(["status"]);
	return { connected: s.connected === true, number: s.number || null };
};
const waSend = (phone, message) => {
	// Test override: WA_BULK_FAKE_SEND=ok|1 → fake success (no real send);
	// WA_BULK_FAKE_SEND=fail → fake failure. Unset → real wa.js send.
	const f = process.env.WA_BULK_FAKE_SEND;
	if (f != null && f !== "") {
		return Promise.resolve(f === "fail" ? { ok: false, error: "fake_fail" } : { ok: true, id: "FAKE-" + phone });
	}
	return waRun(["send", "--to", phone, "--text", message]);
};

// ---- start (stage + schedule) ----------------------------------------------
async function cmdStart(args) {
	// Gate FIRST: WhatsApp must be connected before we validate or stage anything.
	const conn = await waStatusInfo();
	if (!conn.connected)
		return (out({
			ok: false,
			error: "not_connected",
			connectUrl: "https://ultron.lsnw.io/moneyshot/?connect=whatsapp",
			message:
				"Your WhatsApp isn't connected to MoneyShot yet. Connect it by scanning the QR at " +
				"https://ultron.lsnw.io/moneyshot/?connect=whatsapp (or click the circle in the top-right " +
				"corner → Connect WhatsApp), then run the bulk send again.",
		}), 3);
	const fromNumber = conn.number; // the connected WhatsApp's own number (sender)
	const message = String(args.message || "").trim();
	if (!message) return (out({ ok: false, error: "empty_message" }), 4);
	const parts = String(args.to || args.numbers || "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
	if (parts.length === 0) return (out({ ok: false, error: "no_recipients" }), 4);

	// Normalize + dedupe. Invalid numbers are NOT fatal any more — they show up in
	// the per-number status list as ❌, and the valid ones are still queued.
	const seen = new Set();
	const recipients = []; // valid, deduped (normalized), in input order
	const invalidRaw = []; // raw inputs that failed normalization
	for (const p of parts) {
		const n = normalizePhone(p);
		if (!n) invalidRaw.push(p);
		else if (!seen.has(n)) { seen.add(n); recipients.push(n); }
	}

	const now = nowMs();
	const { startMs, endMs } = istWindow(now);
	const afterWindow = now >= endMs; // past 6pm IST → nothing new fits today

	const db = pool();
	try {
		// Base = later of window-start / now / the current queue tail today.
		const tailRec = await queueTail(db, startMs, endMs);
		const tailMs = tailRec ? new Date(tailRec.scheduledAt).getTime() : 0;
		let base = Math.max(now, startMs, tailMs);

		const batchId = "bulk_" + now;
		const results = []; // one entry per number: {phone, status: queued|cooldown|queue_full|invalid}
		let queuedCount = 0, firstAt = null, lastAt = null;

		for (const phone of recipients) {
			// Reject up front (❌) if already queued or on 3h cooldown — checked HERE
			// against the DB, not just at dispatch, so a duplicate/cooldown shows now.
			const block = await blockReason(db, phone, now);
			if (block) { results.push({ phone, status: block }); continue; }
			if (afterWindow) { results.push({ phone, status: "queue_full" }); continue; }
			const at = base + randDelay();
			if (at > endMs) { results.push({ phone, status: "queue_full" }); continue; }
			const customerId = await upsertCustomer(db, phone);
			await db.query(
				`INSERT INTO customer_messages (customer_id, phone, from_number, message, status, scheduled_at, batch_id)
				 VALUES ($1,$2,$3,$4,'scheduled',$5,$6)`,
				[customerId, phone, fromNumber, message, new Date(at), batchId],
			);
			const iso = new Date(at).toISOString();
			results.push({ phone, status: "queued", at: iso });
			if (!firstAt) firstAt = iso;
			lastAt = iso;
			queuedCount++;
			base = at;
		}
		for (const raw of invalidRaw) results.push({ phone: raw, status: "invalid" });

		// Pre-rendered status list — the skill echoes this VERBATIM. ✅ = queued for
		// sending, ❌ = couldn't queue (invalid number, or today's 9–6 IST window is full).
		// IST HH:MM for a scheduled instant (shown next to each queued number).
		const istHM = (iso) => {
			const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
			return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
		};
		const mark = (s) =>
			s === "invalid" ? "❌ invalid number"
			: s === "cooldown" ? "❌ on cooldown (messaged in last 3h)"
			: s === "already_queued" ? "❌ already queued (still pending)"
			: "❌ queue full for today";
		const lines = results
			.map((r) => (r.status === "queued" ? `${r.phone}  ✅ ~${istHM(r.at)} IST` : `${r.phone}  ${mark(r.status)}`))
			.join("\n");
		const display =
			`Bulk send queued (${queuedCount}):\n${lines}` +
			(queuedCount ? `\n\n(each sent at ~the time shown, one at a time, IST)` : ``);

		const cooldownCount = results.filter((r) => r.status === "cooldown").length;
		const res = {
			ok: true,
			batchId,
			from: fromNumber,
			scheduledCount: queuedCount,
			cooldownCount,
			queueFull: results.some((r) => r.status === "queue_full"),
			results,
			display,
		};
		log({ cmd: "start", batchId, from: fromNumber, recipients: recipients.length, queued: queuedCount, cooldown: cooldownCount, queueFull: res.queueFull, invalid: invalidRaw.length, firstAt, lastAt });
		out(res);
		return 0;
	} finally {
		await db.end().catch(() => {});
	}
}

// ---- dispatch (run every minute by cron) -----------------------------------
async function cmdDispatch() {
	// Send window = 9:00–19:30 IST. Scheduling is 9–18 (cmdStart); the dispatcher gets an
	// extra 1.5h (18:00→19:30) to drain spillover/retries, then STOPS for the night — no
	// sends after 7:30pm IST. It resumes at 9am and, because it processes by scheduled_at
	// ASC, drains any leftover from the previous day before that day's fresh messages.
	const now = nowMs();
	const { startMs, dispatchEndMs } = istWindow(now);
	if (now < startMs || now >= dispatchEndMs) return 0; // outside 9:00–19:30 IST → don't send
	const db = pool();
	try {
		// Is anything actually due right now? If not, do nothing (and don't even
		// probe WhatsApp — avoids spawning a status check every idle minute).
		const duePeek = await db.query(
			`SELECT 1 FROM customer_messages WHERE status='scheduled' AND scheduled_at <= $1 LIMIT 1`,
			[new Date(now)],
		);
		if (duePeek.rowCount === 0) return 0; // nothing due

		// A message is due — but we can only send with a live WhatsApp link. If the
		// user's WhatsApp is DISCONNECTED, leave the message 'scheduled' (attempts
		// untouched — a disconnect must NOT burn the retry budget) and just record a
		// disconnected tick for today's IST day. It'll send once they reconnect
		// (still within the 9:00–19:30 IST send window).
		const conn = await waStatusInfo();
		if (!conn.connected) {
			await recordDisconnectTick(db, now);
			log({ cmd: "dispatch", event: "skip_disconnected", istDay: istDayStr(now) });
			return 0;
		}

		// Preserve pacing: don't send if a real send happened < MIN_SEND_GAP ago.
		const gap = await db.query(`SELECT max(created_at) AS last FROM customer_messages WHERE status='sent'`);
		if (gap.rows[0].last && now - new Date(gap.rows[0].last).getTime() < MIN_SEND_GAP_MS) return 0;

		// Drain cooldown-skips fast, but send at most ONE real message per tick.
		for (let guard = 0; guard < 50; guard++) {
			const claim = await db.query(
				`WITH due AS (
				   SELECT id FROM customer_messages
				   WHERE status='scheduled' AND scheduled_at <= $1
				   ORDER BY scheduled_at ASC LIMIT 1
				   FOR UPDATE SKIP LOCKED)
				 UPDATE customer_messages m SET status='sending'
				 FROM due WHERE m.id = due.id
				 RETURNING m.id, m.phone, m.message, m.attempts`,
				[new Date(now)],
			);
			if (claim.rowCount === 0) return 0; // nothing due
			const { id, phone, message, attempts } = claim.rows[0];

			// 3h per-number cooldown (checked against real sends, not this claim).
			const cd = await db.query(
				`SELECT max(created_at) AS last FROM customer_messages WHERE phone=$1 AND status='sent'`,
				[phone],
			);
			if (cd.rows[0].last && now - new Date(cd.rows[0].last).getTime() < COOLDOWN_MS) {
				await db.query(`UPDATE customer_messages SET status='skipped_cooldown' WHERE id=$1`, [id]);
				log({ cmd: "dispatch", event: "skip_cooldown", id, phone });
				continue; // try the next due message this tick (skip isn't a real send)
			}

			const attemptNo = (attempts || 0) + 1;
			const r = await waSend(phone, message);
			if (r.ok) {
				await db.query(`UPDATE customer_messages SET status='sent', attempts=$2, wa_message_id=$3, error=NULL WHERE id=$1`, [id, attemptNo, r.id || null]);
				log({ cmd: "dispatch", event: "sent", id, phone, attempt: attemptNo, wa: r.id || null });
			} else if (attemptNo < MAX_ATTEMPTS) {
				// Retry: re-queue with a fresh paced delay (up to MAX_ATTEMPTS total).
				const retryAt = new Date(now + randDelay());
				await db.query(`UPDATE customer_messages SET status='scheduled', attempts=$2, scheduled_at=$3, error=$4 WHERE id=$1`, [id, attemptNo, retryAt, r.error || "send_failed"]);
				log({ cmd: "dispatch", event: "retry", id, phone, attempt: attemptNo, max: MAX_ATTEMPTS, next: retryAt.toISOString(), error: r.error || "send_failed" });
			} else {
				await db.query(`UPDATE customer_messages SET status='failed', attempts=$2, error=$3 WHERE id=$1`, [id, attemptNo, r.error || "send_failed"]);
				log({ cmd: "dispatch", event: "failed", id, phone, attempts: attemptNo, error: r.error || "send_failed" });
			}
			return 0; // one real send this tick
		}
		return 0;
	} finally {
		await db.end().catch(() => {});
	}
}

// ---- status ----------------------------------------------------------------
async function cmdStatus() {
	const { startMs, endMs } = istWindow(Date.now());
	const db = pool();
	try {
		const counts = await db.query(
			`SELECT status, count(*) FROM customer_messages
			 WHERE created_at::date = (now() AT TIME ZONE 'Asia/Kolkata')::date OR scheduled_at BETWEEN $1 AND $2
			 GROUP BY status`,
			[new Date(startMs), new Date(endMs)],
		);
		const next = await db.query(
			`SELECT phone, scheduled_at FROM customer_messages WHERE status='scheduled' ORDER BY scheduled_at ASC LIMIT 1`,
		);
		const tail = await db.query(
			`SELECT max(scheduled_at) AS last FROM customer_messages WHERE status IN ('scheduled','sending') AND scheduled_at BETWEEN $1 AND $2`,
			[new Date(startMs), new Date(endMs)],
		);
		out({
			ok: true,
			counts: Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.count)])),
			nextSend: next.rows[0] ? { phone: next.rows[0].phone, at: next.rows[0].scheduled_at } : null,
			queueTail: tail.rows[0].last || null,
			windowIST: "09:00–18:00 IST",
		});
		return 0;
	} finally {
		await db.end().catch(() => {});
	}
}

// ---- disconnect-report (last 5 IST days of disconnected ticks) --------------
// Same shape the bff /wa/disconnect-stats endpoint returns; lets the chat agent
// answer "was my WhatsApp disconnected recently?". Zero-filled, newest first.
async function cmdDisconnectReport() {
	const anchor = istDayStr(nowMs()); // today (IST); WA_NOW_MS-overridable for tests
	const db = pool();
	try {
		const r = await db.query(
			`SELECT to_char(d::date,'YYYY-MM-DD') AS day, COALESCE(t.disconnected_ticks,0) AS ticks
			 FROM generate_series($1::date - interval '4 days', $1::date, interval '1 day') d
			 LEFT JOIN disconnected_whatsapp_ticks_daily t ON t.day = d::date
			 ORDER BY day DESC`,
			[anchor],
		);
		const days = r.rows.map((x) => ({ day: x.day, ticks: Number(x.ticks) }));
		out({ ok: true, days, totalTicks: days.reduce((a, b) => a + b.ticks, 0) });
		return 0;
	} finally {
		await db.end().catch(() => {});
	}
}

// ---- main ------------------------------------------------------------------
(async () => {
	if (!existsSync(SKILL_DIR)) mkdirSync(SKILL_DIR, { recursive: true });
	const args = parseArgs(process.argv.slice(2));
	const cmd = args._[0];
	try {
		if (cmd === "start") process.exit(await cmdStart(args));
		else if (cmd === "dispatch") process.exit(await cmdDispatch());
		else if (cmd === "status") process.exit(await cmdStatus());
		else if (cmd === "disconnect-report") process.exit(await cmdDisconnectReport());
		else {
			out({ ok: false, error: "unknown_command", usage: 'start --message "<t>" --to "n1,n2,..." | status | dispatch | disconnect-report' });
			process.exit(4);
		}
	} catch (e) {
		log({ cmd, error: "exception", message: String(e?.stack || e) });
		out({ ok: false, error: "exception", message: String(e?.stack || e) });
		process.exit(1);
	}
})();
