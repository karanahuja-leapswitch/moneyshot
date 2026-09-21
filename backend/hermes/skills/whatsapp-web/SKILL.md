---
name: whatsapp-web
description: "Send a WhatsApp message from a user-linked personal number (QR pairing). Use when asked to send/deliver a WhatsApp message and a from/to number is given."
version: 1.0.0
author: MoneyShot
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [WhatsApp, Messaging, QR, Baileys, Send]
    requires_toolsets: [terminal]
---

# WhatsApp Web (send via QR-linked number)

Send a WhatsApp text message from a **personal WhatsApp account** the user links by
scanning a QR code. Backed by `scripts/wa.js` (Baileys, WhatsApp Web multi-device).

⚠️ **Unofficial + risky.** This uses the unofficial WhatsApp Web protocol — it
violates WhatsApp's ToS and the linked number can be **banned**, especially for
bulk sending. Only send to recipients the user explicitly named. Never mass-send.
If the user asks to blast many numbers, warn them and confirm first.

## When to Use
The user wants to send a WhatsApp message and provides (or can provide) a **from
number** (the sender's own WhatsApp), a **to number** (recipient), and the **message
text**. If any of the three is missing, ask for it before proceeding.

## Setup (once)
The skill lives at `$HERMES_HOME/skills/whatsapp-web`. Define this shorthand first and
reuse it in every command (invoke wa.js by absolute path — cwd does not matter):

```bash
WA="$HERMES_HOME/skills/whatsapp-web"
```

If `node_modules` is absent, install deps once (needs internet):

```bash
[ -d "$WA/node_modules" ] || (cd "$WA" && npm install --omit=dev --no-audit --no-fund)
```

## Quick Reference
`--from`/`--to` accept any format (digits are extracted). All commands print one line
of JSON. (`WA` is set as above.)

| Command | Purpose |
|---|---|
| `node "$WA/scripts/wa.js" status --from <FROM>` | Link state: `none`/`qr`/`linked`/`timeout`/`error` |
| `node "$WA/scripts/wa.js" link --from <FROM>` | Start QR pairing (long-running — background it) |
| `node "$WA/scripts/wa.js" send --from <FROM> --to <TO> --text "<MSG>"` | Send the message |

## Procedure
1. **Check link state:** `node "$WA/scripts/wa.js" status --from <FROM>`.
2. **If `state` is `linked`** → skip to step 5.
3. **If not linked, start pairing in the background** so you can poll it:
   ```bash
   nohup node "$WA/scripts/wa.js" link --from <FROM> >/tmp/wa-link-<FROM>.log 2>&1 &
   ```
   Then poll `node "$WA/scripts/wa.js" status --from <FROM>` every ~3s until `state` becomes `qr`.
4. **Show the QR to the user and wait for the scan:**
   - The `status` JSON carries `qrUrl` (a short image URL like
     `/moneyshot/api/qr/<token>.png`), plus `qr` (a data-URI) and `qrAscii` as fallbacks.
   - On a web/chat surface, render the image with markdown using **`qrUrl`**:
     `![Scan in WhatsApp → Linked devices](<qrUrl>)`. **Do NOT paste the `qr`
     data-URI into chat** — echo the short `qrUrl` only. If `qrUrl` is null (no
     shared volume, e.g. a plain terminal), print the `qrAscii` block instead.
   - Tell them: **WhatsApp → Settings → Linked devices → Link a device → scan.**
   - Keep polling `status` every ~3s. The QR rotates (~every 20–60s) — if `state`
     is still `qr` with a new `qr` value, show the refreshed code. Continue until
     `state` is `linked`, or `timeout`/`error` (then tell the user and offer to retry).
5. **Send:**
   ```bash
   node "$WA/scripts/wa.js" send --from <FROM> --to <TO> --text "<MSG>"
   ```
   On `{"ok":true,...}` confirm to the user (include the recipient). On error, report
   the `error` field verbatim and what it means (see Pitfalls).

## Pitfalls
- `not_linked` — no valid session; run the pairing flow (step 3).
- `timeout` (during `link`) — the user didn't scan in time; restart `link` for a fresh QR.
- `from_mismatch` — the linked account's number ≠ the requested `--from` (they scanned
  a different phone). Tell the user; either re-link with the right phone or use the
  number that's actually linked (`linked` field).
- `recipient_not_on_whatsapp` — the `--to` number has no WhatsApp account.
- `logged_out` — WhatsApp invalidated the session (or it was unlinked/banned); the
  session was cleared, so re-link.
- Message text with quotes/newlines: pass it as a single `--text` argument (quote it).

## Verification
A successful send prints `{"ok":true,"to":"…","id":"…","from":"…"}`. You can confirm
the link with `status --from <FROM>` showing `"state":"linked"` and the `number`.
