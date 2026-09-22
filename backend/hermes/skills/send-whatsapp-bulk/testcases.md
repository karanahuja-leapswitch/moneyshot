# Test cases — `send-whatsapp-bulk` (paced, scheduled, Postgres-backed)

Covers `bulk.js` (`start` / `dispatch` / `status`), the Postgres tables
(`customers`, `customer_messages`), the 9am–6pm IST scheduling window, the
dispatcher cron, the 3h cooldown, retries, queue-full behaviour, and logging.

Legend: **[A]** = automatable (CLI + SQL asserts, no real phone), **[M]** = manual
(needs a real WhatsApp device / UI / real time).

---

## 0. Test harness / conventions

Run commands inside the hermes container (skill runs as uid 10000, HERMES_HOME=/opt/data):

```bash
cd /opt/moneyshot
EX="docker compose exec -T -u 10000 -e HOME=/opt/data hermes"
B="$EX node /opt/data/skills/send-whatsapp-bulk/scripts/bulk.js"
PSQL="docker compose exec -T db psql -U moneyshot -d moneyshot -tAc"
# examples:  $B start --message "hi" --to "9820011185,919812345678"
#            $B status ;  $B dispatch
#            $PSQL "select status,count(*) from customer_messages group by status"
```

**Isolation:** each test should start from a clean slate:
```bash
docker compose exec -T db psql -U moneyshot -d moneyshot -c 'TRUNCATE customer_messages, customers RESTART IDENTITY;'
$EX sh -lc ': > /walogs/whatsapp.log'
```

**Avoiding real sends in [A] tests.** Two safe techniques used below:
- **Force a real FAILURE without delivering anything:** send to a number that is not on
  WhatsApp (e.g. `910000000001`) → `wa.js send` returns `recipient_not_on_whatsapp` → the
  row goes `failed`/retry. No message is delivered.
- **Assert scheduling/validation/queue/cooldown logic** purely from the JSON output and the
  DB, which never touch WhatsApp.
- The only path that needs a genuine delivery is the **`sent` success** case — that requires
  a linked test WhatsApp number (send-to-self) or a stub. **Recommended harness addition:**
  a `WA_BULK_FAKE_SEND=1` env that makes `waSend()` return `{ok:true,id:"FAKE"}` without
  spawning `wa.js`, so the full sent→cooldown→pacing path is testable in CI without a phone.
  (Not yet implemented — see TODO at bottom.)

**Cron note:** the live `wa-bulk-dispatcher` cron fires every minute and will also process
due rows. For deterministic [A] tests, either pause it (`docker compose exec hermes hermes
cron pause wa-bulk-dispatcher`) and drive `dispatch` manually, or account for it.

---

## 1. Input validation & normalization  [A]

| ID | Case | Setup / Action | Expected |
|----|------|----------------|----------|
| BULK-V-01 | Empty message | `start --message "" --to "9820011185"` | JSON `{ok:false,error:"empty_message"}`; nothing staged. |
| BULK-V-02 | No recipients | `start --message "hi" --to ""` | `{ok:false,error:"no_recipients"}`. |
| BULK-V-03 | Invalid number rejected | `start --message "hi" --to "12,abcd,9820011185"` | `{ok:false,error:"invalid_numbers",invalid:[...]}`; **0 rows** staged (whole batch rejected). |
| BULK-V-04 | India local → +91 form | `start --message "hi" --to "9820011185"` (connected) | staged row `phone='919820011185'`. |
| BULK-V-05 | Already has country code | `--to "919812345678"` | `phone='919812345678'`. |
| BULK-V-06 | `+`E.164 | `--to "+14155550123"` | `phone='14155550123'`. |
| BULK-V-07 | Leading 0 local | `--to "09820011185"` | `phone='919820011185'`. |
| BULK-V-08 | Duplicate numbers deduped | `--to "9820011185, 919820011185, 9820011185"` | staged **1** row (all resolve to `919820011185`). |
| BULK-V-09 | Whitespace/comma mix | `--to "9811111111 9822222222,9833333333"` | 3 rows staged. |

Assert with: `$PSQL "select phone from customer_messages order by id"`.

## 2. Connection gate  [A]

| ID | Case | Setup | Expected |
|----|------|-------|----------|
| BULK-C-01 | Not connected | No linked WhatsApp session (`wa.js status` → connected:false) | `start` returns `{ok:false,error:"not_connected",connectUrl:"https://ultron.lsnw.io/moneyshot/?connect=whatsapp"}`; **0 rows** staged. |
| BULK-C-02 | Connected proceeds | A linked session exists | `start` stages rows and returns `ok:true`. |

## 3. Scheduling & 9am–6pm IST window  [A]

| ID | Case | Setup / Action | Expected |
|----|------|----------------|----------|
| BULK-S-01 | Staged as `scheduled` | `start` 3 numbers | 3 rows `status='scheduled'`, each with `scheduled_at` set. |
| BULK-S-02 | Cumulative 75–105s spacing | `start` 5 numbers | consecutive `scheduled_at` diffs all in **[75,105] s**. Assert: `select extract(epoch from scheduled_at - lag(scheduled_at) over (order by scheduled_at)) from customer_messages`. |
| BULK-S-03 | First slot respects "now" | during window, empty queue | first `scheduled_at` ≈ now + 75–105s (not in the past). |
| BULK-S-04 | Appends to existing queue tail | Seed a `scheduled` row at IST 12:00; then `start` 2 more | new rows' `scheduled_at` > 12:00 (base = tail), still 75–105s apart. |
| BULK-S-05 | Customers upserted | `start` a new number, then `start` same number | `customers` has **1** row for that phone (not duplicated); `updated_at` refreshed. |
| BULK-S-06 | Before 9am IST | Simulate empty queue; set system/test clock < 9am IST (or seed logic test) | first `scheduled_at` ≥ 09:00 IST that day. *(Hard to automate without clock control — see [M] BULK-T-04.)* |

## 4. Queue-full behaviour  [A]

| ID | Case | Setup | Expected |
|----|------|-------|----------|
| BULK-Q-01 | Batch partially fills then overflows | Seed a `scheduled` row near 17:59 IST; `start` several numbers | response `queueFull:true`, `scheduledCount` = however many fit, `rejected:[...]`, `lastInQueue:{phone,message,scheduledAt}` = the last row actually in the queue; note contains `Last record in the queue: <phone> — "<message>"`. |
| BULK-Q-02 | Queue already full (0 scheduled) | Seed a `scheduled` row at 17:59:30 IST; `start` 1 new number | `queueFull:true, scheduledCount:0, rejected:[thatNumber]`, `lastInQueue` = the 17:59:30 record. |
| BULK-Q-03 | After 6pm IST | Call `start` when now ≥ 18:00 IST (seed a row so tail exists) | `{ok:false,error:"queue_full",reason:"after_window",lastInQueue:{...}}`; nothing new staged. *(Time-dependent — see [M] BULK-T-03.)* |
| BULK-Q-04 | Unlimited count (no 15 cap) | `start` with 20 numbers early in the day | up to ~all fit (limited only by window), NOT capped at 15. |

Seed helper (row at 17:59:30 IST today):
```sql
INSERT INTO customers(phone) VALUES('910000009999') ON CONFLICT DO NOTHING;
INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,batch_id)
SELECT id,'910000009999','tail','scheduled',
  ((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '17 hours 59 minutes 30 seconds') AT TIME ZONE 'Asia/Kolkata','seed'
FROM customers WHERE phone='910000009999';
```

## 5. Dispatcher — sending, pacing, draining  [A/M]

| ID | Case | Setup / Action | Expected |
|----|------|----------------|----------|
| BULK-D-01 | Sends a due message | stage a row, `UPDATE ... scheduled_at=now()-'10s'`, run `dispatch` | row → `sending` then `sent` (or `failed`); `wa_message_id` set on success. **[A]** with a fake/self send or non-WA number. |
| BULK-D-02 | Not-due not sent | stage a row with future `scheduled_at`; run `dispatch` | row stays `scheduled` (dispatch returns nothing due). **[A]** |
| BULK-D-03 | Min-gap pacing | Set a recent `sent` row (created_at = now-30s); make another due; run `dispatch` | the due row is **not** sent this tick (gap <75s) — stays `scheduled`/`sending` claim skipped. **[A]** |
| BULK-D-04 | One real send per tick | Make 3 rows due; run `dispatch` once | exactly **1** goes `sent`; the rest remain `scheduled`. **[A]** (with non-WA numbers or fake send) |
| BULK-D-05 | Drains during 6–7:30pm grace | Stage a due row; run `dispatch` with now ∈ (18:00, 19:30) IST | it **sends** (spillover grace). **[A]** with `WA_NOW_MS` override, else **[M]**. |
| BULK-D-06 | Concurrency / no double-send | Run two `dispatch` processes simultaneously against one due row | row sent **once**; `FOR UPDATE SKIP LOCKED` prevents a second claim. **[A]** |
| BULK-D-07 | End-to-end via the real cron | Stage a message to a real number within window; wait | `wa-bulk-dispatcher` sends it within ~1–2 min; row `sent` + wa id; message arrives. **[M]** |
| BULK-D-08 | **No send after 7:30pm IST** | Stage a due row; run `dispatch` with now ≥ 19:30 IST | **nothing sent**; row stays `scheduled` (dispatcher returns without claiming). **[A]** with `WA_NOW_MS`, else **[M]**. |
| BULK-D-09 | No send before 9am IST | Stage a due (past) row; `dispatch` with now < 09:00 IST | nothing sent; row stays `scheduled`. **[A]**/**[M]** as above. |
| BULK-D-10 | Next day drains previous day's leftover first | Seed leftover rows with `scheduled_at` = yesterday 17:xx (status `scheduled`) + today's rows (09:xx+); at 9am, run `dispatch` repeatedly | yesterday's rows (earliest `scheduled_at`) are sent **before** today's, in order. **[A]** (seed timestamps) / **[M]**. |

## 6. 3-hour per-number cooldown  [A]

| ID | Case | Setup | Expected |
|----|------|-------|----------|
| BULK-CD-01 | Skip within 3h | Insert a `sent` row for phone X at now-1h; stage+due another to X; `dispatch` | row → `skipped_cooldown`; no send. |
| BULK-CD-02 | Allowed after 3h | `sent` row for X at now-4h; stage+due another to X; `dispatch` | row is **sent** (not skipped). |
| BULK-CD-03 | Skip logged | as BULK-CD-01 | `/walogs/whatsapp.log` has `{"src":"bulk","event":"skip_cooldown",...}`. |

Seed a "sent 1h ago": `INSERT ... status='sent', created_at=now()-interval '1 hour', wa_message_id='X'`.

## 7. Retries (up to 2, i.e. 3 total attempts)  [A]

| ID | Case | Setup / Action | Expected |
|----|------|----------------|----------|
| BULK-R-01 | Fail → retry re-queues | stage a due row to a non-WA number `910000000001`; `dispatch` | after send fails → row back to `status='scheduled'`, `attempts=1`, new future `scheduled_at`, `error` set. |
| BULK-R-02 | Retry delay is 75–105s | as BULK-R-01 | the new `scheduled_at` − now ∈ [75,105] s. |
| BULK-R-03 | Terminal after 3 attempts | force the row due and `dispatch` repeatedly (3×) | final `status='failed'`, `attempts=3`; no further re-queue. |
| BULK-R-04 | Success resets error | make a previously-failed row succeed | `status='sent'`, `error IS NULL`, `attempts` = attempt number. |

## 8. `status` command  [A]

| ID | Case | Expected |
|----|------|----------|
| BULK-ST-01 | Counts by state | `status` returns `counts` matching `select status,count(*) ...` for today. |
| BULK-ST-02 | Next send | `nextSend` = earliest `scheduled` row (phone + scheduled_at). |
| BULK-ST-03 | Queue tail | `queueTail` = latest pending `scheduled_at` in today's window. |

## 9. Logging  [A]

| ID | Case | Expected |
|----|------|----------|
| BULK-L-01 | start logged | after `start`, `/walogs/whatsapp.log` has a `{"src":"bulk","cmd":"start","recipients":N,"scheduled":M,...}` line (valid JSON). |
| BULK-L-02 | dispatch outcomes logged | `sent` / `retry` / `failed` / `skip_cooldown` each produce a matching JSON line with `id`,`phone`. |
| BULK-L-03 | exceptions logged | force an error (e.g. stop `db`, run `start`) → a `{"error":"exception",...}` line; command returns `{ok:false,error:"exception"}`. |
| BULK-L-04 | shared file | wa.js `send` and bulk lines coexist in the same `whatsapp.log` (`src` distinguishes). |

## 10. Failure / resilience  [A/M]

| ID | Case | Setup | Expected |
|----|------|-------|----------|
| BULK-F-01 | DB down at `start` | stop `db`; `start` | `{ok:false,error:"exception"}` (logged); no crash of the agent. **[A]** |
| BULK-F-02 | DB down at `dispatch` | stop `db`; cron tick | dispatch errors silently (logged), row stays `scheduled`, retried next tick. **[A]** |
| BULK-F-03 | Container restart mid-queue | stage several future rows; `docker compose restart hermes` | scheduled rows persist in Postgres; dispatcher resumes sending due ones (durable). **[M]** |
| BULK-F-04 | Stuck `sending` recovery | leave a row in `sending` (kill dispatch mid-send) | *(Known gap)* it is not auto-reset today; verify/decide whether a reaper is needed. **[M]** |

---

## Manual-only end-to-end  [M]

| ID | Case | Steps | Expected |
|----|------|-------|----------|
| BULK-T-01 | Real batch delivery | Connect WhatsApp; `start` to 2–3 **real** numbers you own | messages actually arrive on the phones, spaced 75–105s apart. |
| BULK-T-02 | Agent-driven (chat) | In the MoneyShot chat: "send this to these customers: … " | agent invokes `send-whatsapp-bulk`, reports jobId/queued count; check DB + phones. |
| BULK-T-03 | After-6pm rejection | Near/after 18:00 IST, try to queue a new batch | agent shows "sending queue is filled for today" + the last record (phone + message). |
| BULK-T-04 | Before-9am scheduling | Before 09:00 IST, `start` a batch | first send scheduled at ≥ 09:00 IST; nothing sent before 9am. |
| BULK-T-05 | Past-6pm drain | Queue messages so the tail is ~5:58pm; observe after 6pm | dispatcher keeps sending the pre-6pm-scheduled ones after 6pm until done. |
| BULK-T-06 | Ban-safety soak | Send a realistic batch to consenting test numbers over a day | no WhatsApp ban / no "temporarily banned"; pacing holds. |
| BULK-T-07 | Cooldown in practice | Send to a real number, then try again <3h via a new batch | second attempt shows `skipped_cooldown`; recipient gets only one message. |

---

## TODO to make more of these fully automated
1. Add `WA_BULK_FAKE_SEND=1` (and a matching hook in `wa.js send`) so success/pacing/cooldown
   paths run in CI without a real phone.
2. Allow overriding "now" / the IST window via env (e.g. `WA_NOW_MS`, `WA_WINDOW_START_H`,
   `WA_WINDOW_END_H`) so window/queue-full/before-9am/after-6pm cases are deterministic.
3. A tiny test runner (bash or node) that TRUNCATEs, seeds, runs the CLI, and asserts DB/JSON
   for each **[A]** case above, exiting non-zero on mismatch.
