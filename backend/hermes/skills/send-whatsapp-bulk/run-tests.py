#!/usr/bin/env python3
"""Automated [A] tests for the send-whatsapp-bulk skill (Python port of run-tests.sh).

Run ON THE SERVER from /opt/moneyshot:
    python3 hermes/data/skills/send-whatsapp-bulk/run-tests.py

SAFE: uses a separate `moneyshot_test` database (never the prod `moneyshot` DB),
WA_BULK_FAKE_SEND (no real WhatsApp) and WA_NOW_MS (injected time). No messages are
delivered and prod data is untouched.

NOTE: the cooldown tests (CD-*) use the REAL clock — run during 09:00–19:30 IST.
"""
import os
import subprocess
import sys

# cd to the compose project dir (/opt/moneyshot).
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
if not os.path.isfile(os.path.join(ROOT, "docker-compose.yml")):
    ROOT = "/opt/moneyshot"
os.chdir(ROOT)

BULK = "/opt/data/skills/send-whatsapp-bulk/scripts/bulk.js"
GREEN, RED, RST = "\033[32m", "\033[31m", "\033[0m"
passed = failed = 0


def sh(args, inp=None):
    r = subprocess.run(args, input=inp, capture_output=True, text=True)
    return (r.stdout or "").strip()


def dc_exec(service, cmd, env=None, user=None, inp=None):
    base = ["docker", "compose", "exec", "-T"]
    if user:
        base += ["-u", user]
    for k, v in (env or {}).items():
        base += ["-e", f"{k}={v}"]
    return sh(base + [service, *cmd], inp=inp)


def psql(db, sql):
    return dc_exec("db", ["psql", "-U", "moneyshot", "-d", db, "-qtAc", sql])


def psqlx(db, sql):
    dc_exec("db", ["psql", "-U", "moneyshot", "-d", db, "-q", "-c", sql])


def ok(name):
    global passed
    print(f"  {GREEN}PASS{RST}  {name}")
    passed += 1


def bad(name, got):
    global failed
    print(f"  {RED}FAIL{RST}  {name}\n        got: {got}")
    failed += 1


def check(name, cond, got=""):
    ok(name) if cond else bad(name, got)


# --- test DB from the CURRENT host schema (mounted init.sql can be a stale inode) ---
TESTURL = dc_exec("hermes", ["sh", "-lc", "echo ${DATABASE_URL%/*}/moneyshot_test"])
psqlx("moneyshot", "DROP DATABASE IF EXISTS moneyshot_test")
psqlx("moneyshot", "CREATE DATABASE moneyshot_test OWNER moneyshot")
with open(os.path.join(ROOT, "db", "init.sql")) as f:
    dc_exec("db", ["psql", "-U", "moneyshot", "-d", "moneyshot_test", "-qf", "-"], inp=f.read())

BASE_ENV = {"HOME": "/opt/data", "DATABASE_URL": TESTURL}


def reset():
    psqlx("moneyshot_test",
          "TRUNCATE customer_messages, customers RESTART IDENTITY;"
          "TRUNCATE disconnected_whatsapp_ticks_daily;")


def runbulk(env, *args):
    return dc_exec("hermes", ["node", BULK, *args], env={**BASE_ENV, **env}, user="10000")


def istnow(h, m=0):
    js = ("const O=5.5*3600*1000,i=new Date(Date.now()+O);"
          f"console.log(Date.UTC(i.getUTCFullYear(),i.getUTCMonth(),i.getUTCDate(),{h},{m},0)-O)")
    return dc_exec("hermes", ["node", "-e", js])


def seed_sched(h, m, batch, phone):
    psqlx("moneyshot_test",
          f"INSERT INTO customers(phone) VALUES('{phone}') ON CONFLICT DO NOTHING;"
          f"INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,batch_id) "
          f"SELECT id,'{phone}','m','scheduled',"
          f"((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '{h} hours {m} minutes') AT TIME ZONE 'Asia/Kolkata',"
          f"'{batch}' FROM customers WHERE phone='{phone}';")


N1500, N1830, N1945, N0830 = istnow(15), istnow(18, 30), istnow(19, 45), istnow(8, 30)
print("== send-whatsapp-bulk automated tests (test db: moneyshot_test) ==")

# ---- validation ----
reset(); o = runbulk({"WA_BULK_FAKE_CONNECTED": "1"}, "start", "--message", "", "--to", "9820011185")
check("V-01 empty message", '"error":"empty_message"' in o, o)

reset(); o = runbulk({"WA_BULK_FAKE_CONNECTED": "1"}, "start", "--message", "hi", "--to", "")
check("V-02 no recipients", '"no_recipients"' in o, o)

reset(); o = runbulk({"WA_BULK_FAKE_CONNECTED": "1", "WA_NOW_MS": N1500}, "start", "--message", "hi", "--to", "12,abc,9820011185")
n = psql("moneyshot_test", "select count(*) from customer_messages")
check("V-03 invalid -> ❌ in list, valid still queued", '"status":"invalid"' in o and n == "1", f"{o} rows={n}")

reset(); runbulk({"WA_BULK_FAKE_CONNECTED": "1", "WA_NOW_MS": N1500}, "start", "--message", "hi",
                 "--to", "9820011185, 919820011185, 9820011185")
n = psql("moneyshot_test", "select count(*) from customer_messages")
ph = psql("moneyshot_test", "select distinct phone from customer_messages")
check("V-04/08 normalize + dedupe", n == "1" and ph == "919820011185", f"rows={n} ph={ph}")

# ---- connection gate ----
reset(); o = runbulk({"WA_BULK_FAKE_CONNECTED": "0"}, "start", "--message", "hi", "--to", "9820011185")
check("C-01 not connected", '"not_connected"' in o, o)

# ---- scheduling ----
reset(); runbulk({"WA_BULK_FAKE_CONNECTED": "1", "WA_NOW_MS": N1500}, "start", "--message", "hi",
                 "--to", "9811111111,9822222222,9833333333,9844444444,9855555555")
n = psql("moneyshot_test", "select count(*) from customer_messages where status='scheduled'")
check("S-01 staged 5 scheduled", n == "5", f"n={n}")
diffs = psql("moneyshot_test",
             "select coalesce(min(d),0)||' '||coalesce(max(d),0) from "
             "(select extract(epoch from scheduled_at - lag(scheduled_at) over (order by scheduled_at)) d "
             "from customer_messages) t where d is not null")
try:
    mn, mx = (float(x) for x in diffs.split())
except ValueError:
    mn, mx = 0.0, 0.0
check(f"S-02 spacing 75-105s (min={mn:.0f} max={mx:.0f})", 75 <= mn and mx <= 105, diffs)
c = psql("moneyshot_test", "select count(*) from customers")
check("S-05 customers upserted", c == "5", f"customers={c}")
fn = psql("moneyshot_test", "select distinct coalesce(from_number,'-') from customer_messages")
check("S-06 from_number stored (connected sender)", fn == "919999999999", f"from_number={fn}")

# ---- queue full ----
reset(); o = runbulk({"WA_BULK_FAKE_CONNECTED": "1", "WA_NOW_MS": N1830}, "start", "--message", "hi", "--to", "9820011185")
check("Q-03 after 6pm -> queue_full status", '"status":"queue_full"' in o and '"scheduledCount":0' in o, o)

reset(); seed_sched(17, 59, "seed", "910000009999")
o = runbulk({"WA_BULK_FAKE_CONNECTED": "1", "WA_NOW_MS": N1500}, "start", "--message", "newmsg", "--to", "918888888888")
check("Q-02 queue full -> overflow number marked ❌",
      '"queueFull":true' in o and '"scheduledCount":0' in o and '"phone":"918888888888","status":"queue_full"' in o, o)

# ---- display / status list ----
reset(); o = runbulk({"WA_BULK_FAKE_CONNECTED": "1", "WA_NOW_MS": N1500}, "start", "--message", "hi", "--to", "9811111111,9822222222")
check("DISP-01 display list with ✅ + scheduled time per number",
      "✅" in o and "Bulk send queued (2):" in o and " IST" in o and "~" in o and o.count('"status":"queued"') == 2, o)

# ---- dispatch: window gating (injected time) ----
# Dispatch tests declare a CONNECTED WhatsApp (WA_BULK_FAKE_CONNECTED=1) — otherwise
# the new connection gate treats them as disconnected and never sends.
CONN = {"WA_BULK_FAKE_CONNECTED": "1"}
reset(); seed_sched(15, 0, "d01", "919820011185")
runbulk({**CONN, "WA_BULK_FAKE_SEND": "ok", "WA_NOW_MS": N1500}, "dispatch")
r = psql("moneyshot_test", "select status||' '||coalesce(wa_message_id,'-') from customer_messages where batch_id='d01'")
check("D-01 due -> sent (+id)", r.startswith("sent") and "FAKE" in r, r)

reset(); seed_sched(17, 0, "d02", "919820011185")
runbulk({**CONN, "WA_BULK_FAKE_SEND": "ok", "WA_NOW_MS": N1500}, "dispatch")
r = psql("moneyshot_test", "select status from customer_messages where batch_id='d02'")
check("D-02 not-due stays scheduled", r == "scheduled", r)

reset(); seed_sched(15, 0, "d05", "919820011185")
runbulk({**CONN, "WA_BULK_FAKE_SEND": "ok", "WA_NOW_MS": N1830}, "dispatch")
r = psql("moneyshot_test", "select status from customer_messages where batch_id='d05'")
check("D-05 6-7:30pm grace sends", r == "sent", r)

reset(); seed_sched(15, 0, "d08", "919820011185")
runbulk({**CONN, "WA_BULK_FAKE_SEND": "ok", "WA_NOW_MS": N1945}, "dispatch")
r = psql("moneyshot_test", "select status from customer_messages where batch_id='d08'")
check("D-08 after 7:30pm no send", r == "scheduled", r)

reset(); seed_sched(8, 0, "d09", "919820011185")
runbulk({**CONN, "WA_BULK_FAKE_SEND": "ok", "WA_NOW_MS": N0830}, "dispatch")
r = psql("moneyshot_test", "select status from customer_messages where batch_id='d09'")
check("D-09 before 9am no send", r == "scheduled", r)

# ---- dispatch: WhatsApp disconnected while a message is due ----
reset(); seed_sched(15, 0, "dx1", "919820011185")
runbulk({"WA_BULK_FAKE_CONNECTED": "0", "WA_BULK_FAKE_SEND": "ok", "WA_NOW_MS": N1500}, "dispatch")
r = psql("moneyshot_test", "select status||' '||attempts from customer_messages where batch_id='dx1'")
day = dc_exec("hermes", ["node", "-e",
              f"const O=5.5*3600*1000;console.log(new Date({N1500}+O).toISOString().slice(0,10))"])
t = psql("moneyshot_test", f"select coalesce(disconnected_ticks,0) from disconnected_whatsapp_ticks_daily where day='{day}'")
check("DX-01 disconnected+due -> stays scheduled, attempts untouched, tick=1",
      r == "scheduled 0" and t == "1", f"msg={r} tick={t}")

# second disconnected tick same IST day -> counter increments, msg still scheduled
runbulk({"WA_BULK_FAKE_CONNECTED": "0", "WA_BULK_FAKE_SEND": "ok", "WA_NOW_MS": N1500}, "dispatch")
t = psql("moneyshot_test", f"select disconnected_ticks from disconnected_whatsapp_ticks_daily where day='{day}'")
r = psql("moneyshot_test", "select status||' '||attempts from customer_messages where batch_id='dx1'")
check("DX-02 second disconnected tick -> count=2, still scheduled", t == "2" and r == "scheduled 0", f"tick={t} msg={r}")

# disconnected but NOTHING due -> no tick recorded
reset(); seed_sched(17, 0, "dx3", "919820011185")  # scheduled for 17:00, now 15:00 -> not due
runbulk({"WA_BULK_FAKE_CONNECTED": "0", "WA_NOW_MS": N1500}, "dispatch")
t = psql("moneyshot_test", "select coalesce(sum(disconnected_ticks),0) from disconnected_whatsapp_ticks_daily")
check("DX-03 disconnected + nothing due -> no tick", t == "0", f"tick_sum={t}")

# report verb returns today's count (5-day window, zero-filled, newest first)
reset(); seed_sched(15, 0, "dx4", "919820011185")
runbulk({"WA_BULK_FAKE_CONNECTED": "0", "WA_NOW_MS": N1500}, "dispatch")
o = runbulk({"WA_NOW_MS": N1500}, "disconnect-report")
check("DX-04 disconnect-report shows today's tick",
      '"ok":true' in o and f'"day":"{day}","ticks":1' in o and '"totalTicks":1' in o, o)

# ---- dispatch: concurrency (no double send) ----
reset(); seed_sched(15, 0, "d06", "919820011185")
p1 = subprocess.Popen(["docker", "compose", "exec", "-T", "-u", "10000",
                       "-e", "HOME=/opt/data", "-e", f"DATABASE_URL={TESTURL}",
                       "-e", "WA_BULK_FAKE_CONNECTED=1",
                       "-e", "WA_BULK_FAKE_SEND=ok", "-e", f"WA_NOW_MS={N1500}",
                       "hermes", "node", BULK, "dispatch"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
p2 = subprocess.Popen(["docker", "compose", "exec", "-T", "-u", "10000",
                       "-e", "HOME=/opt/data", "-e", f"DATABASE_URL={TESTURL}",
                       "-e", "WA_BULK_FAKE_CONNECTED=1",
                       "-e", "WA_BULK_FAKE_SEND=ok", "-e", f"WA_NOW_MS={N1500}",
                       "hermes", "node", BULK, "dispatch"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
p1.wait(); p2.wait()
s = psql("moneyshot_test", "select count(*) from customer_messages where batch_id='d06' and status='sent'")
check("D-06 no double-send (SKIP LOCKED)", s == "1", f"sent={s}")

# ---- retries ----
reset(); seed_sched(15, 0, "r03", "919820011185")
runbulk({**CONN, "WA_BULK_FAKE_SEND": "fail", "WA_NOW_MS": N1500}, "dispatch")
r = psql("moneyshot_test", "select status||' '||attempts from customer_messages where batch_id='r03'")
check("R-01 fail -> requeued attempt 1", r == "scheduled 1", r)
gap = psql("moneyshot_test",
           f"select round(extract(epoch from scheduled_at - to_timestamp({N1500}/1000.0))) "
           f"from customer_messages where batch_id='r03'")
try:
    gapv = float(gap)
except ValueError:
    gapv = -1
check(f"R-02 retry delay 75-105s (={gap})", 75 <= gapv <= 105, gap)
for _ in range(2):
    psqlx("moneyshot_test",
          "UPDATE customer_messages SET scheduled_at="
          "((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '15 hours') AT TIME ZONE 'Asia/Kolkata' "
          "WHERE batch_id='r03' AND status='scheduled';")
    runbulk({**CONN, "WA_BULK_FAKE_SEND": "fail", "WA_NOW_MS": N1500}, "dispatch")
r = psql("moneyshot_test", "select status||' '||attempts from customer_messages where batch_id='r03'")
check("R-03 terminal failed after 3 attempts", r == "failed 3", r)

# ---- cooldown (REAL clock; run 09:00-19:30 IST) ----
reset()
psqlx("moneyshot_test",
      "INSERT INTO customers(phone) VALUES('919820011185') ON CONFLICT DO NOTHING;"
      "INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,created_at,batch_id) "
      "SELECT id,'919820011185','old','sent',now()-interval '1 hour',now()-interval '1 hour','cd1s' FROM customers WHERE phone='919820011185';"
      "INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,batch_id) "
      "SELECT id,'919820011185','new','scheduled',now()-interval '30 seconds','cd1' FROM customers WHERE phone='919820011185';")
runbulk({**CONN, "WA_BULK_FAKE_SEND": "ok"}, "dispatch")
r = psql("moneyshot_test", "select status from customer_messages where batch_id='cd1'")
check("CD-01 skip within 3h (run 9-19:30 IST)", r == "skipped_cooldown", r)

reset()
psqlx("moneyshot_test",
      "INSERT INTO customers(phone) VALUES('919820011185') ON CONFLICT DO NOTHING;"
      "INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,created_at,batch_id) "
      "SELECT id,'919820011185','old','sent',now()-interval '4 hours',now()-interval '4 hours','cd2s' FROM customers WHERE phone='919820011185';"
      "INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,batch_id) "
      "SELECT id,'919820011185','new','scheduled',now()-interval '30 seconds','cd2' FROM customers WHERE phone='919820011185';")
runbulk({**CONN, "WA_BULK_FAKE_SEND": "ok"}, "dispatch")
r = psql("moneyshot_test", "select status from customer_messages where batch_id='cd2'")
check("CD-02 allowed after 3h (run 9-19:30 IST)", r == "sent", r)

# start-time cooldown: a number messaged <3h ago is rejected at queue time with ❌,
# not silently skipped later (real clock; run 9-18 IST). Only the cooldown number is
# tested so the assertion is window-independent (cooldown is checked before staging).
reset()
psqlx("moneyshot_test",
      "INSERT INTO customers(phone) VALUES('919820011185') ON CONFLICT DO NOTHING;"
      "INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,created_at,batch_id) "
      "SELECT id,'919820011185','old','sent',now()-interval '10 minutes',now()-interval '10 minutes','cd3s' FROM customers WHERE phone='919820011185';")
o = runbulk({"WA_BULK_FAKE_CONNECTED": "1"}, "start", "--message", "hi", "--to", "9820011185")
n = psql("moneyshot_test", "select count(*) from customer_messages where status='scheduled'")
check("CD-03 start-time cooldown -> ❌ cooldown, not staged",
      '"phone":"919820011185","status":"cooldown"' in o and '"cooldownCount":1' in o and n == "0", f"{o} staged={n}")

# already-queued: a number with a still-pending (scheduled) row is rejected immediately at
# start (no duplicate), even though nothing has been SENT yet.
reset(); seed_sched(15, 0, "cd4", "919820011185")
o = runbulk({"WA_BULK_FAKE_CONNECTED": "1", "WA_NOW_MS": N1500}, "start", "--message", "hi", "--to", "9820011185")
n = psql("moneyshot_test", "select count(*) from customer_messages where status='scheduled'")
check("CD-04 already-queued -> ❌ not duplicated",
      '"phone":"919820011185","status":"already_queued"' in o and n == "1", f"{o} sched={n}")

# ---- status ----
reset(); runbulk({"WA_BULK_FAKE_CONNECTED": "1", "WA_NOW_MS": N1500}, "start", "--message", "hi", "--to", "9811111111,9822222222")
o = runbulk({"WA_NOW_MS": N1500}, "status")
check("ST-01 status counts", '"scheduled":2' in o, o)

print(f"\n== {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
