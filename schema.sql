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
