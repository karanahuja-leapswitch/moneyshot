# Plan — Multi-user WhatsApp bulk sending (MoneyShot)

**Goal:** let several signed-in Gmail users each connect their own WhatsApp and have
their bulk sends go **from their own number**, with multiple WhatsApp sessions living on
disk at the same time. Today only one connected number is supported (a shared sender);
a second connection breaks sending with `need_from`.

Status: PLAN — not yet implemented. Owner: backend agent (this repo, `deploy/…`).
UI touchpoints handed to the UI agent where noted.

---

## 1. Why it doesn't work today (recap)

- WhatsApp sessions are stored **per Google email** by the `wa` sidecar (connect flow).
- The **bulk skill has no caller identity**: Hermes' `api_server` does **not** pass
  `X-Hermes-User` (the caller email) down to the skill subprocess (verified in
  `/opt/hermes/gateway/platforms/api_server.py` + `agent/tool_executor.py` — no user env).
- So `bulk.js`/`wa.js` resolve "the WhatsApp session" from **all linked sessions on disk**:
  - 1 linked → works (that number).
  - ≥2 linked → `wa.js status` returns `multiple:true` (no single number) → `start` stores
    `from_number=null`; at dispatch `wa.js send` (no `--from`) returns `need_from` →
    retries → `failed`. **Nothing sends.** It does NOT pick "the latest".

The fix has two halves. Half 1 is trivial; Half 2 is the real work.

---

## 2. Design overview

```
Browser (chat)                bff (knows caller)            Hermes agent            skill / cron
   │  "bulk to A,B,C: msg"       │                              │                      │
   │  Bearer <Google token> ───► │ verify token → email         │                      │
   │                             │ look up caller's WA number   │                      │
   │                             │   via wa /status?user=email  │                      │
   │                             │ INJECT note into request ──► │  runs:               │
   │                             │  "sender = 9198..., pass     │  bulk.js start       │
   │                             │   --from 9198..."            │   --from 9198... ───► │ store from_number=9198... on each row
   │                             │                              │                      │
   │                             │                              │        dispatcher ─► │ wa.js send --from 9198...  (Half 1)
   │                             │                              │                      │   sends from that session,
   │                             │                              │                      │   other sessions untouched
```

- **Half 1 — dispatcher targets the row's `from_number`.** Small, safe, unlocks
  multiple-sessions-on-disk. Buildable independently.
- **Half 2 — capture the *caller's* number at queue time.** Needs the caller's number to
  reach `start`, supplied by the **bff** (the only component that knows the caller).

`from_number TEXT` already exists on `customer_messages` (added earlier), so no schema
change is required for the happy path.

---

## 3. Half 1 — dispatcher sends via the row's `from_number`

**File:** `deploy/hermes/skills/send-whatsapp-bulk/scripts/bulk.js`

- `waSend(phone, message, fromNumber)` → `wa.js send --to <phone> --text <msg> --from <fromNumber>`.
  `wa.js resolveFrom()` already suffix-matches a number to its session dir, so `--from
  919820011185` targets exactly that account regardless of how many are linked.
- In `cmdDispatch`, the claim query already returns the row; also select `from_number`
  and pass it to `waSend`.
- If a row's `from_number` is NULL (legacy / single-number era), fall back to current
  behaviour (no `--from`).

**Dispatcher disconnect gate becomes per-sender:** the existing "skip when WhatsApp
disconnected" check must test **that row's `from_number`** session
(`wa.js status --key <from_number>` → connected?), not the global state. If that sender is
disconnected, leave the row `scheduled` + record a disconnect tick (as today) instead of
burning attempts.

---

## 4. Half 2 — store the caller's number at queue time

### 4.1 bff injects the caller's connected number
**File:** `deploy/bff/main.py`

- On `POST /v1/chat/completions` (and `/v1/responses`), after verifying the token:
  1. Resolve `email = claims["email"]`.
  2. Look up the caller's connected WhatsApp number: call the `wa` sidecar
     `GET /status?user=<email>` (same path `_wa_proxy` already uses). Extract `number` if
     `connected`.
  3. If a number is found, **inject a system note** into the request body before proxying:
     > `Caller's connected WhatsApp sender number is <NUMBER>. When invoking the`
     > `send-whatsapp-bulk skill, always pass \`--from <NUMBER>\`.`
     - Prepend as a `system` message (or append to an existing system message). Keep it
       tiny (~30 tokens).
  4. If **no** number is connected, inject nothing → `start` will get no `--from` and
     fail safe (see 4.3), telling the user to connect.
- **Cache** `email → number` briefly (e.g. 30–60s TTL, in-process dict) so we don't call
  the sidecar on every chat turn. Invalidate on `/wa/connect` and `/wa/logout`.

### 4.2 SKILL.md instructs the agent to pass `--from`
**File:** `deploy/hermes/skills/send-whatsapp-bulk/SKILL.md`

- Add to the ⚡ contract: "If the context provides a caller sender number, you MUST pass
  `--from <that number>` on the `start` command. Never invent or omit it."

### 4.3 `bulk.js start` accepts + validates `--from` (fail-safe)
**File:** `deploy/hermes/skills/send-whatsapp-bulk/scripts/bulk.js` (`cmdStart`)

- Read `args.from`. Determine the sender:
  - If `--from` given → validate it maps to a **currently-connected** session
    (`wa.js status --key <from>` → connected). If yes, `fromNumber = <that number>`.
  - If `--from` missing or not connected → **do not guess**. Return
    `{ok:false, error:"sender_unresolved", message:"Couldn't determine your connected
    WhatsApp — open Connect WhatsApp, link your number, and retry."}` and stop.
  - Back-compat: if exactly one session is linked and no `--from` was passed, keep today's
    "single connected session" behaviour (so single-user keeps working during rollout).
- Store `from_number = fromNumber` on every staged row (already implemented).

Net effect: the worst case is a **clear error**, never "sent from the wrong number."

---

## 5. Scoping decisions (the heart of "multi-user")

Today these are all **global**. Decide per item whether they become **per-sender
(`from_number`)**. Recommendation in bold.

| Concern | Today (global) | Per-sender option | Recommendation |
|---|---|---|---|
| 3h cooldown | recipient blocked if messaged by ANYONE in 3h | blocked only per (from_number, phone) | **Keep GLOBAL** — revenue-recovery is customer-centric; don't let two accounts double-contact a customer. |
| Duplicate / already-queued | blocked if pending for the recipient anywhere | per (from_number, phone) | **Keep GLOBAL** — same reason. |
| Send pacing (`MIN_SEND_GAP` 75s) | one real send / 75s across ALL accounts | each account paces independently | **Per-sender** — each WhatsApp has its own ban risk; global would throttle everyone to one shared rate. |
| Dispatcher throughput | 1 real send per tick (global) | 1 send per tick **per from_number** | **Per-sender** — otherwise users serialize behind each other. |
| Scheduling base / queue tail (9–6 IST) | based on the global queue tail | based on that sender's queue tail | **Per-sender** — user B's ETA shouldn't be pushed by user A's backlog. |
| Disconnect gate + ticks | global connection | that row's `from_number` session | **Per-sender** (see Half 1). |

> If we keep cooldown/dedup **global** but make pacing/scheduling/dispatch **per-sender**,
> we get correct isolation on rate + timing while still protecting customers from being
> double-contacted. This is the recommended split.

Implementation impact of the per-sender items: the dispatcher loop changes from "claim the
single earliest-due row" to "for each connected `from_number`, if its own 75s gap has
elapsed, claim+send its earliest-due row." The `MIN_SEND_GAP` and scheduling-base queries
gain a `from_number` filter.

---

## 6. Edge cases

- **Sender disconnects mid-queue:** rows keep `from_number`; dispatcher's per-sender
  disconnect gate leaves them `scheduled` + ticks; they drain when that number reconnects
  (within the send window). No attempts burned.
- **Sender logs out (session wiped) with rows pending:** those rows can never send from
  that number. Decide: (a) leave `scheduled` (drain if they reconnect same number later),
  or (b) mark a terminal `failed`/`sender_gone`. **Recommend (a)** + surface count in
  `status`.
- **Caller's connected number changes** (relink a different number under same email):
  new sends use the new number; old pending rows still target the old `from_number`
  (correct — they were queued from that number).
- **bff can't reach the wa sidecar** to resolve the number: inject nothing → `start`
  fails safe with `sender_unresolved`. Don't queue from a guessed number.
- **Two users, same recipient:** with global cooldown/dedup, the second is rejected
  (`already_queued`/`cooldown`) — intended (customer-centric).

---

## 7. Test plan (`deploy/hermes/skills/send-whatsapp-bulk/run-tests.py`)

Add (hooks: `WA_BULK_FAKE_CONNECTED`, a new `WA_BULK_FAKE_SESSIONS` to simulate several
linked numbers, `--from`):
- **MU-01** `start --from 91A` with A connected → rows stored `from_number=91A`.
- **MU-02** `start --from 91A` with A **not** connected → `sender_unresolved`, nothing staged.
- **MU-03** `start` with no `--from` and 2 sessions linked → `sender_unresolved` (no guess).
- **MU-04** back-compat: no `--from`, exactly 1 session → works (single-number path).
- **MU-05** dispatch a row with `from_number=91A` → `wa.js send` called with `--from 91A`
  (assert via a fake wa that echoes the `--from` it received).
- **MU-06** two batches, `from_number` 91A and 91B → each dispatched with its own `--from`;
  per-sender pacing lets both progress (not serialized) — assert both sent within a tick
  window.
- **MU-07** per-sender disconnect: row `from_number=91A`, A disconnected, B connected →
  A's row stays `scheduled` + tick; B's row sends.
- **MU-08** global cooldown across senders: A sent to X <3h ago; B tries X → `cooldown`.
- Keep all existing tests green (single-number path unchanged).

Also a bff unit/manual check: `/v1/chat/completions` injects the sender note when a number
is connected for the caller; injects nothing when not.

---

## 8. Rollout (order of operations)

1. **Half 1** (`bulk.js` dispatch `--from` + per-sender disconnect gate) + tests. Deploy.
   (Safe: single-number rows have `from_number` already; behaviour unchanged for them.)
2. **`start` `--from` + validation** (`bulk.js` + SKILL.md) + tests. Deploy.
3. **bff injection** (`main.py` + cache) — rebuild bff. Verify a chat turn injects the note
   and `start` receives `--from`.
4. **Per-sender pacing/scheduling** (dispatcher + scheduling queries) + tests. Deploy.
5. Restart hermes once (cold-start note), verify end-to-end with **two** connected numbers
   (two test emails) → both send from their own number concurrently.
6. Update `SESSION-HANDOFF.md` (§8 bulk) + memory.

Deploy = `rsync` to `/opt/moneyshot/…` (bulk.js → `scripts/`, watch the flatten trap);
bff = `docker compose up -d --build bff`. Prefer NO extra hermes restarts (cold-start cost).

---

## 9. Risks & mitigations

- **Model omits `--from`** (weak/fast model): mitigated by explicit SKILL contract + bff
  note **and** the `start` fail-safe (errors instead of guessing). No silent wrong-sender.
- **Editing vendored Hermes:** avoided — all logic lives in bff + skill, none in Hermes.
- **bff latency** (extra wa `/status` per turn): mitigated by short-TTL cache + invalidate
  on connect/logout.
- **Throughput expectations:** per-sender pacing means total send rate scales with number
  of connected accounts; make sure that's desired (more accounts = more WhatsApp ban
  surface). Document for operators.
- **Cooldown/dedup semantics** (global vs per-sender) is a product decision — see §5;
  default global (customer-centric).

---

## 10. Decisions needed before build

1. Cooldown & dedup: **global** (recommended) or per-sender?
2. Pacing/scheduling/dispatch: **per-sender** (recommended) or keep global one-at-a-time?
3. Pending rows when a sender logs out: **leave scheduled** (recommended) or mark failed?
4. Scope: build all of Half 1 + Half 2 now, or ship **Half 1 + single-number-safe** first
   and add true multi-user (bff injection + per-sender) as Phase 2?

---

## 11. Alternatives considered (not recommended)

- **Dedicated bff `POST /wa/bulk` endpoint** (bff runs `bulk.js start --from <caller#>`
  directly, bypassing the chat agent): most robust/deterministic (no model reliance), but
  changes bulk from a chat prompt to a form/action — a product change. Keep as a fallback
  if model reliance on `--from` proves flaky.
- **Patch Hermes to expose `X-Hermes-User` to the skill env:** robust in-chat, but edits
  vendored Hermes and breaks on upstream updates. Avoid.
