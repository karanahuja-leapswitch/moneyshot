---
name: send-whatsapp-bulk
description: "Send the same WhatsApp message to 2+ recipients / a list of numbers. ALWAYS use this (not single-send looped) whenever there is more than one recipient. Staged + paced, 9am–6pm IST."
version: 2.0.0
author: MoneyShot
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [WhatsApp, Bulk, RevenueRecovery, Scheduling]
    requires_toolsets: [terminal]
---

# send-whatsapp-bulk 📲

Queue the **same** WhatsApp message to **many** customers. Each message is stored in
Postgres and scheduled with a cumulative random **75–105s gap**, then a background
dispatcher (one cron job) sends them **one at a time** at their due time. The
**9am–6pm IST window governs only SCHEDULING** — new messages are only slotted into
that window (once it's full for the day, further numbers are rejected). The dispatcher
sends within **9:00am–7:30pm IST**: that's the 9–6 scheduling window plus 1.5h of grace
(6:00→7:30pm) to drain spillover and retries; it **stops sending after 7:30pm IST** and
resumes at 9am. Because it processes oldest-scheduled first, any leftover from the
previous day is drained before that day's fresh messages. Any number of recipients is
accepted — the daily 9am–6pm scheduling window is the real limit.

⚠️ Unofficial WhatsApp Web (Baileys) — against ToS; pacing + windowing + a 3h
per-number cooldown reduce (not eliminate) ban risk.

## When to Use
The user wants to message several customers at once (e.g. payment reminders). They give
ONLY the **message text** and a **list of recipient phone numbers** (any count). The
**sender is always the user's connected WhatsApp account** — never ask for or pass a
"from" number; the batch is sent from whatever WhatsApp is connected.

## ⚡ Do EXACTLY this — nothing else (speed + correctness)
This skill is ONE tool call. Run the single `start` command in step 1, then reply from its
JSON. That is the entire procedure.

**FORBIDDEN — never do any of these (they waste time and are blocked anyway):**
- ❌ Do NOT inspect, open, `grep`, or `cat` `bulk.js`, the database, `env`, or any config
  to find connection strings / cooldown state — `start` already handles connection,
  cooldown, validation, windowing, and scheduling internally.
- ❌ Do NOT write scratch scripts (e.g. to `/tmp`) or query Postgres yourself.
- ❌ Do NOT run `npm install`, a `node_modules` check, or a separate `wa.js status`.
- ❌ Do NOT call `skill_view` on other skills, or look for a single-send skill.

Everything you need is in the `start` JSON. The script returns in <1s; one tool call, one
reply. Anything beyond the single `start` command is wrong.

## Procedure
1. **Queue the batch** — run this ONE command (it stages + schedules; it does not send inline):
   ```bash
   node "$HERMES_HOME/skills/send-whatsapp-bulk/scripts/bulk.js" start --message "<MESSAGE>" --to "<n1>,<n2>,<n3>,..."
   ```
   `--to` is a comma/space-separated list (India-local / with-country-code / +E.164 all
   accepted). Every scheduled message is written to `customer_messages`; the phone is
   added to `customers` if new.
2. **Read the JSON and reply:**
   - `{"ok":true,"display":"…","results":[{phone,status}…],"scheduledCount":N,…}` → **output
     the `display` field VERBATIM and NOTHING ELSE.** It is a ready-made per-number status
     list: each recipient on its own line as `<phone>  ✅` (queued for sending) or
     `<phone>  ❌ <reason>` (couldn't queue: invalid number, already queued/pending, on 3h
     cooldown after a recent message, or today's 9–6pm IST window is full). Do NOT add
     firstAt/lastAt, batch ids, or extra commentary — just the list.
     (Structured `results` is there if you need it; `display` is what the user sees.)
   - `{"ok":false,"error":"not_connected","connectUrl":…}` → the user's WhatsApp is **not
     connected**. `start` checks this **first**, so nothing was staged. Reply with the
     `message` from the JSON (which says: "Your WhatsApp isn't connected — connect it by
     scanning the QR at **[Connect WhatsApp](https://ultron.lsnw.io/moneyshot/?connect=whatsapp)**,
     or click the top-right circle → Connect WhatsApp"), and STOP. Do not stage anything.
   - `{"ok":false,"error":"empty_message"|"no_recipients"}` → ask for the missing piece.
3. **Progress (when asked):**
   ```bash
   node "$WB/scripts/bulk.js" status
   ```
   Shows today's `counts` (scheduled / sending / sent / failed / skipped_cooldown),
   the `nextSend`, and the `queueTail` (last scheduled time today).

## Notes
- Sending is done by a background dispatcher cron (`wa-bulk-dispatcher`) — you do NOT
  need to run `dispatch` yourself.
- **If WhatsApp is disconnected when a message comes due, nothing is sent** — the message
  stays `scheduled` (its retry budget is NOT touched) and the dispatcher records a
  "disconnected tick" for that IST day. It sends automatically once the user reconnects
  (still within the 9:00–19:30 IST send window). The per-IST-day tick counts live in
  `disconnected_whatsapp_ticks_daily`; the UI shows the last 5 days on login.
- `node "$WB/scripts/bulk.js" disconnect-report` → `{"ok":true,"days":[{"day","ticks"}…5 days…],"totalTicks":N}`
  — last 5 IST days of disconnected ticks. Use this if the user asks whether their
  WhatsApp was disconnected recently / why messages didn't go out.
- A number that already got a successful message in the last 3h is auto-skipped at send
  time (`skipped_cooldown`).
- **Failed sends are retried automatically** up to 2 times (3 attempts total) — a
  failure re-queues the message with a fresh 75–105s delay; only after the 3rd failed
  attempt does it become terminal `failed`. The `attempts` count is stored per message.
- The message body is sent verbatim to every recipient.
