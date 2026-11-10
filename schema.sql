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
