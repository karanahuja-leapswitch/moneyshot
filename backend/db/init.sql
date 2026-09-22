-- MoneyShot revenue-recovery DB. Runs once on first Postgres init.
CREATE TABLE IF NOT EXISTS customers (
    id          SERIAL PRIMARY KEY,
    phone       TEXT UNIQUE NOT NULL,          -- normalized E.164, no '+', e.g. 919820011185
    name        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_messages (
    id            SERIAL PRIMARY KEY,
    customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    phone         TEXT NOT NULL,               -- recipient (to)
    from_number   TEXT,                          -- sender = connected WhatsApp number at queue time
    message       TEXT NOT NULL,
    -- scheduled | sending | sent | failed | skipped_cooldown
    status        TEXT NOT NULL,
    scheduled_at  TIMESTAMPTZ,                  -- when the dispatcher should send it
    attempts      INTEGER NOT NULL DEFAULT 0,   -- send attempts so far (retry up to 3 total)
    wa_message_id TEXT,                          -- WhatsApp message id when sent
    error         TEXT,                          -- last error detail
    batch_id      TEXT,                          -- groups one bulk-send turn
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cust_msg_phone_time ON customer_messages (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cust_msg_status ON customer_messages (status);
-- Dispatcher: earliest due scheduled message.
CREATE INDEX IF NOT EXISTS idx_cust_msg_sched ON customer_messages (status, scheduled_at);

-- Per-IST-day count of dispatcher ticks where a message was due but the user's
-- WhatsApp was DISCONNECTED (so nothing could be sent; the message stayed
-- 'scheduled' with attempts untouched). Surfaced to the user on login as the
-- "disconnected ticks in the past 5 days" figure.
CREATE TABLE IF NOT EXISTS disconnected_whatsapp_ticks_daily (
    day                 DATE PRIMARY KEY,            -- IST calendar day
    disconnected_ticks  INTEGER NOT NULL DEFAULT 0,  -- dispatcher ticks blocked by a disconnect that day
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
