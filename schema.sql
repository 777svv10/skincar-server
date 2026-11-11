CREATE TABLE IF NOT EXISTS users (
 telegram_id BIGINT PRIMARY KEY,
 display_name TEXT NOT NULL,
 lang TEXT NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru','kk','en')),
 theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
 balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY,
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '1 day'
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);


-- Additive migration: existing accounts and balances are preserved.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT CHECK (nickname ~ '^[a-z0-9_]{3,24}$');
CREATE UNIQUE INDEX IF NOT EXISTS users_nickname_unique ON users(lower(nickname));


CREATE TABLE IF NOT EXISTS generations (
 id UUID PRIMARY KEY,
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
 request_key UUID NOT NULL,
 request_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','processing','done','failed')),
 options JSONB NOT NULL,
 source_image BYTEA,
 result_image BYTEA,
 thumbnail BYTEA,
 model TEXT NOT NULL,
 prompt_version TEXT NOT NULL DEFAULT 'body-v1',
 usage JSONB,
 error_code TEXT,
 worker_token UUID,
 refunded BOOLEAN NOT NULL DEFAULT false,
 archived BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 started_at TIMESTAMPTZ,
 finished_at TIMESTAMPTZ,
 UNIQUE(telegram_id,request_key)
);
CREATE INDEX IF NOT EXISTS generations_queue ON generations(status,created_at);
CREATE INDEX IF NOT EXISTS generations_owner ON generations(telegram_id,created_at DESC);
CREATE TABLE IF NOT EXISTS credit_ledger (
 operation_key TEXT PRIMARY KEY,
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
 generation_id UUID REFERENCES generations(id),
 delta INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nickname_changes (
 id BIGSERIAL PRIMARY KEY,
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
 changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nickname_changes_owner_time ON nickname_changes(telegram_id,changed_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_debt INTEGER NOT NULL DEFAULT 0 CHECK(credit_debt>=0);
CREATE TABLE IF NOT EXISTS vehicles (
 id UUID PRIMARY KEY, telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
 name TEXT NOT NULL CHECK(char_length(name) BETWEEN 2 AND 80),
 source_image BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicles_owner ON vehicles(telegram_id,created_at DESC);
CREATE TABLE IF NOT EXISTS payment_orders (
 id UUID PRIMARY KEY, telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
 pack_id TEXT NOT NULL, credits INTEGER NOT NULL CHECK(credits>0),stars INTEGER NOT NULL CHECK(stars>0),
 checkout_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 minutes',paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payment_orders_owner ON payment_orders(telegram_id,created_at DESC);
CREATE TABLE IF NOT EXISTS payment_receipts (
 charge_id TEXT PRIMARY KEY,order_id UUID NOT NULL REFERENCES payment_orders(id),telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
 stars INTEGER NOT NULL,credits INTEGER NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),refunded_at TIMESTAMPTZ
);

-- Per-photo, server-timestamped consent audit. Existing photos are not auto-consented.
CREATE TABLE IF NOT EXISTS photo_consents (
 id UUID PRIMARY KEY,telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
 vehicle_id UUID NOT NULL REFERENCES vehicles(id),
 input_hash TEXT NOT NULL,source_hash TEXT NOT NULL,
 text_version TEXT NOT NULL,text_snapshot TEXT NOT NULL,language TEXT NOT NULL,
 privacy_version TEXT NOT NULL,terms_version TEXT NOT NULL,
 accepted BOOLEAN NOT NULL DEFAULT true CHECK(accepted),
 accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_consents_owner ON photo_consents(telegram_id,vehicle_id);
