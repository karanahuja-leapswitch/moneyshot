#!/usr/bin/env bash
# Automated [A] tests for the send-whatsapp-bulk skill.
#
# Run ON THE SERVER from /opt/moneyshot:   bash hermes/data/skills/send-whatsapp-bulk/run-tests.sh
#   (it shells into the compose services via `docker compose exec`).
#
# SAFE: uses a separate `moneyshot_test` database (never the prod `moneyshot` DB),
# WA_BULK_FAKE_SEND (no real WhatsApp), and WA_NOW_MS (injected time). No messages
# are delivered and prod data is untouched.
#
# NOTE: the cooldown tests (CD-*) use the REAL clock, so run this during 09:00–19:30
# IST (the send window). All window tests (D-05/08/09, Q-03) inject time and run anytime.
set -uo pipefail
cd "$(dirname "$0")/../../../.." 2>/dev/null || cd /opt/moneyshot

CI="docker compose exec -T"
BULK=/opt/data/skills/send-whatsapp-bulk/scripts/bulk.js
PASS=0; FAIL=0
ok(){ printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad(){ printf '  \033[31mFAIL\033[0m  %s\n        got: %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

# --- test DB (separate from prod) ---
TESTURL=$($CI hermes sh -lc 'echo ${DATABASE_URL%/*}/moneyshot_test' | tr -d '\r')
# Fresh test DB from the CURRENT host schema (the container's mounted init.sql can be
# a stale inode after an rsync-rename, so we pipe db/init.sql in directly).
$CI db psql -U moneyshot -d moneyshot -qc "DROP DATABASE IF EXISTS moneyshot_test" >/dev/null 2>&1
$CI db psql -U moneyshot -d moneyshot -qc "CREATE DATABASE moneyshot_test OWNER moneyshot" >/dev/null 2>&1
$CI db psql -U moneyshot -d moneyshot_test -qf - < db/init.sql >/dev/null 2>&1

tdbc(){ $CI db psql -U moneyshot -d moneyshot_test -qtAc "$1" | tr -d '\r'; }
tdbx(){ $CI db psql -U moneyshot -d moneyshot_test -q -c "$1" >/dev/null 2>&1; }
reset(){ tdbx "TRUNCATE customer_messages, customers RESTART IDENTITY;"; }
# runbulk "ENV1=v ENV2=v" <bulk args...>
runbulk(){ local envs="$1"; shift; local ef=""; for kv in $envs; do ef="$ef -e $kv"; done
  $CI -u 10000 -e HOME=/opt/data -e DATABASE_URL="$TESTURL" $ef hermes node "$BULK" "$@" 2>/dev/null | tr -d '\r'; }
# epoch-ms for today's IST hour:min
istnow(){ $CI hermes node -e "const O=5.5*3600*1000,i=new Date(Date.now()+O);console.log(Date.UTC(i.getUTCFullYear(),i.getUTCMonth(),i.getUTCDate(),$1,${2:-0})-O)" | tr -d '\r'; }
# seed one 'scheduled' row at a fixed IST hour today
seed_sched(){ tdbx "INSERT INTO customers(phone) VALUES('$4') ON CONFLICT DO NOTHING;
  INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,batch_id)
  SELECT id,'$4','m','scheduled',((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '$1 hours $2 minutes') AT TIME ZONE 'Asia/Kolkata','$3'
  FROM customers WHERE phone='$4';"; }

N1500=$(istnow 15 0); N1830=$(istnow 18 30); N1945=$(istnow 19 45); N0830=$(istnow 8 30)
echo "== send-whatsapp-bulk automated tests (test db: moneyshot_test) =="

# ---- validation ----
reset; o=$(runbulk "WA_BULK_FAKE_CONNECTED=1" start --message "" --to "9820011185")
[[ "$o" == *'"error":"empty_message"'* ]] && ok "V-01 empty message" || bad "V-01" "$o"

reset; o=$(runbulk "WA_BULK_FAKE_CONNECTED=1" start --message "hi" --to "")
[[ "$o" == *'"no_recipients"'* ]] && ok "V-02 no recipients" || bad "V-02" "$o"

reset; o=$(runbulk "WA_BULK_FAKE_CONNECTED=1" start --message "hi" --to "12,abc,9820011185")
n=$(tdbc "select count(*) from customer_messages")
[[ "$o" == *'"invalid_numbers"'* && "$n" == "0" ]] && ok "V-03 invalid rejected, nothing staged" || bad "V-03" "$o rows=$n"

reset; runbulk "WA_BULK_FAKE_CONNECTED=1 WA_NOW_MS=$N1500" start --message "hi" --to "9820011185, 919820011185, 9820011185" >/dev/null
n=$(tdbc "select count(*) from customer_messages"); ph=$(tdbc "select distinct phone from customer_messages")
[[ "$n" == "1" && "$ph" == "919820011185" ]] && ok "V-04/08 normalize + dedupe" || bad "V-04/08" "rows=$n ph=$ph"

# ---- connection gate ----
reset; o=$(runbulk "WA_BULK_FAKE_CONNECTED=0" start --message "hi" --to "9820011185")
[[ "$o" == *'"not_connected"'* ]] && ok "C-01 not connected" || bad "C-01" "$o"

# ---- scheduling ----
reset; runbulk "WA_BULK_FAKE_CONNECTED=1 WA_NOW_MS=$N1500" start --message "hi" --to "9811111111,9822222222,9833333333,9844444444,9855555555" >/dev/null
n=$(tdbc "select count(*) from customer_messages where status='scheduled'")
[[ "$n" == "5" ]] && ok "S-01 staged 5 scheduled" || bad "S-01" "n=$n"
mind=$(tdbc "select coalesce(min(d),0) from (select extract(epoch from scheduled_at - lag(scheduled_at) over (order by scheduled_at)) d from customer_messages) t where d is not null")
maxd=$(tdbc "select coalesce(max(d),0) from (select extract(epoch from scheduled_at - lag(scheduled_at) over (order by scheduled_at)) d from customer_messages) t where d is not null")
awk "BEGIN{exit !($mind>=75 && $maxd<=105)}" && ok "S-02 spacing 75-105s (min=$mind max=$maxd)" || bad "S-02" "min=$mind max=$maxd"
c=$(tdbc "select count(*) from customers"); [[ "$c" == "5" ]] && ok "S-05 customers upserted" || bad "S-05" "customers=$c"

# ---- queue full ----
reset; o=$(runbulk "WA_BULK_FAKE_CONNECTED=1 WA_NOW_MS=$N1830" start --message "hi" --to "9820011185")
[[ "$o" == *'"reason":"after_window"'* ]] && ok "Q-03 after 6pm → after_window" || bad "Q-03" "$o"

reset; seed_sched 17 59 seed 910000009999
o=$(runbulk "WA_BULK_FAKE_CONNECTED=1 WA_NOW_MS=$N1500" start --message "newmsg" --to "918888888888")
[[ "$o" == *'"queueFull":true'* && "$o" == *'"scheduledCount":0'* && "$o" == *'910000009999'* ]] \
  && ok "Q-02 queue full → lastInQueue shown" || bad "Q-02" "$o"

# ---- dispatch: window gating (injected time) ----
reset; seed_sched 15 0 d01 919820011185
runbulk "WA_BULK_FAKE_SEND=ok WA_NOW_MS=$N1500" dispatch >/dev/null
r=$(tdbc "select status||' '||coalesce(wa_message_id,'-') from customer_messages where batch_id='d01'")
[[ "$r" == sent* && "$r" == *FAKE* ]] && ok "D-01 due → sent (+id)" || bad "D-01" "$r"

reset; seed_sched 17 0 d02 919820011185
runbulk "WA_BULK_FAKE_SEND=ok WA_NOW_MS=$N1500" dispatch >/dev/null
r=$(tdbc "select status from customer_messages where batch_id='d02'")
[[ "$r" == "scheduled" ]] && ok "D-02 not-due stays scheduled" || bad "D-02" "$r"

reset; seed_sched 15 0 d05 919820011185
runbulk "WA_BULK_FAKE_SEND=ok WA_NOW_MS=$N1830" dispatch >/dev/null
r=$(tdbc "select status from customer_messages where batch_id='d05'")
[[ "$r" == "sent" ]] && ok "D-05 6–7:30pm grace sends" || bad "D-05" "$r"

reset; seed_sched 15 0 d08 919820011185
runbulk "WA_BULK_FAKE_SEND=ok WA_NOW_MS=$N1945" dispatch >/dev/null
r=$(tdbc "select status from customer_messages where batch_id='d08'")
[[ "$r" == "scheduled" ]] && ok "D-08 after 7:30pm no send" || bad "D-08" "$r"

reset; seed_sched 8 0 d09 919820011185
runbulk "WA_BULK_FAKE_SEND=ok WA_NOW_MS=$N0830" dispatch >/dev/null
r=$(tdbc "select status from customer_messages where batch_id='d09'")
[[ "$r" == "scheduled" ]] && ok "D-09 before 9am no send" || bad "D-09" "$r"

# ---- dispatch: concurrency (no double send) ----
reset; seed_sched 15 0 d06 919820011185
runbulk "WA_BULK_FAKE_SEND=ok WA_NOW_MS=$N1500" dispatch >/dev/null &
runbulk "WA_BULK_FAKE_SEND=ok WA_NOW_MS=$N1500" dispatch >/dev/null &
wait
s=$(tdbc "select count(*) from customer_messages where batch_id='d06' and status='sent'")
[[ "$s" == "1" ]] && ok "D-06 no double-send (SKIP LOCKED)" || bad "D-06" "sent=$s"

# ---- retries ----
reset; seed_sched 15 0 r03 919820011185
o=$(runbulk "WA_BULK_FAKE_SEND=fail WA_NOW_MS=$N1500" dispatch)
r=$(tdbc "select status||' '||attempts from customer_messages where batch_id='r03'")
[[ "$r" == "scheduled 1" ]] && ok "R-01 fail → requeued attempt 1" || bad "R-01" "$r"
gap=$(tdbc "select round(extract(epoch from scheduled_at - (to_timestamp($N1500/1000.0)))) from customer_messages where batch_id='r03'"); gap=${gap:-0}
awk "BEGIN{exit !($gap>=75 && $gap<=105)}" && ok "R-02 retry delay 75-105s (=$gap)" || bad "R-02" "gap=$gap"
for i in 2 3; do
  tdbx "UPDATE customer_messages SET scheduled_at=((now() AT TIME ZONE 'Asia/Kolkata')::date + interval '15 hours') AT TIME ZONE 'Asia/Kolkata' WHERE batch_id='r03' AND status='scheduled';"
  runbulk "WA_BULK_FAKE_SEND=fail WA_NOW_MS=$N1500" dispatch >/dev/null
done
r=$(tdbc "select status||' '||attempts from customer_messages where batch_id='r03'")
[[ "$r" == "failed 3" ]] && ok "R-03 terminal failed after 3 attempts" || bad "R-03" "$r"

# ---- cooldown (REAL clock; run 09:00–19:30 IST) ----
reset
tdbx "INSERT INTO customers(phone) VALUES('919820011185') ON CONFLICT DO NOTHING;
  INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,created_at,batch_id)
  SELECT id,'919820011185','old','sent',now()-interval '1 hour',now()-interval '1 hour','cd1s' FROM customers WHERE phone='919820011185';
  INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,batch_id)
  SELECT id,'919820011185','new','scheduled',now()-interval '30 seconds','cd1' FROM customers WHERE phone='919820011185';"
runbulk "WA_BULK_FAKE_SEND=ok" dispatch >/dev/null
r=$(tdbc "select status from customer_messages where batch_id='cd1'")
[[ "$r" == "skipped_cooldown" ]] && ok "CD-01 skip within 3h" || bad "CD-01 (run 9-19:30 IST)" "$r"

reset
tdbx "INSERT INTO customers(phone) VALUES('919820011185') ON CONFLICT DO NOTHING;
  INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,created_at,batch_id)
  SELECT id,'919820011185','old','sent',now()-interval '4 hours',now()-interval '4 hours','cd2s' FROM customers WHERE phone='919820011185';
  INSERT INTO customer_messages(customer_id,phone,message,status,scheduled_at,batch_id)
  SELECT id,'919820011185','new','scheduled',now()-interval '30 seconds','cd2' FROM customers WHERE phone='919820011185';"
runbulk "WA_BULK_FAKE_SEND=ok" dispatch >/dev/null
r=$(tdbc "select status from customer_messages where batch_id='cd2'")
[[ "$r" == "sent" ]] && ok "CD-02 allowed after 3h" || bad "CD-02 (run 9-19:30 IST)" "$r"

# ---- status + logging ----
reset; runbulk "WA_BULK_FAKE_CONNECTED=1 WA_NOW_MS=$N1500" start --message "hi" --to "9811111111,9822222222" >/dev/null
o=$(runbulk "WA_NOW_MS=$N1500" status)
[[ "$o" == *'"scheduled":2'* ]] && ok "ST-01 status counts" || bad "ST-01" "$o"

echo; echo "== $PASS passed, $FAIL failed =="
exit $((FAIL>0 ? 1 : 0))
