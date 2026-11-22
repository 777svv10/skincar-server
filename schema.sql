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
-- SK-082: price frozen per job. Old jobs were billed 1 credit.
ALTER TABLE generations ADD COLUMN IF NOT EXISTS charged_credits INTEGER NOT NULL DEFAULT 1 CHECK (charged_credits BETWEEN 1 AND 100);
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

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS original_image BYTEA;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS original_mime TEXT;

-- SK-060: user-owned unfinished editor drafts, automatically expired after 7 days.
CREATE TABLE IF NOT EXISTS drafts (
 id UUID PRIMARY KEY,
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
 vehicle_id UUID NOT NULL REFERENCES vehicles(id),
 options JSONB NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_owner_updated ON drafts(telegram_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS drafts_expiration ON drafts(updated_at);

-- SK-078: UUID-owned cars have structured identity independent of labels.
-- Existing car IDs, images, consents, credits and drafts remain untouched.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS make TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS generation TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS modification TEXT;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS nickname TEXT;
CREATE INDEX IF NOT EXISTS vehicles_make_model_owner ON vehicles(telegram_id,make,model);
-- Extra photos of the same physical vehicle (primary photo remains in vehicles).
CREATE TABLE IF NOT EXISTS vehicle_photos (
 id UUID PRIMARY KEY,
 vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
 source_image BYTEA NOT NULL,
 original_image BYTEA NOT NULL,
 original_mime TEXT NOT NULL CHECK(original_mime IN ('image/jpeg','image/png','image/webp')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_photos_owner ON vehicle_photos(telegram_id,vehicle_id,created_at DESC);

-- SK-106: private Telegram bot support, preferences, flood control and opt-in notices.
-- Additive only; no existing images, users, balances or orders are modified.
CREATE TABLE IF NOT EXISTS bot_preferences (
 telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
 notify_ready BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_rate_limits (
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
 scope TEXT NOT NULL,
 window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
 hits INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(telegram_id,scope)
);
CREATE TABLE IF NOT EXISTS bot_support_state (
 telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
 awaiting BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_tickets (
 id UUID PRIMARY KEY,
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
 subject TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','closed')),
 answer TEXT,
 admin_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bot_tickets_open ON bot_tickets(status,created_at DESC);
CREATE TABLE IF NOT EXISTS bot_notification_outbox (
 generation_id UUID PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bot_notifications_pending ON bot_notification_outbox(next_try_at) WHERE sent_at IS NULL;

-- SK-106: audited, two-step administrator credit adjustments.
CREATE TABLE IF NOT EXISTS bot_admin_credit_actions (
 id UUID PRIMARY KEY,
 admin_id BIGINT NOT NULL,
 target_id BIGINT NOT NULL REFERENCES users(telegram_id),
 delta INTEGER NOT NULL CHECK(delta BETWEEN -100 AND 100 AND delta <> 0),
 reason TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('pending','cancelled','applied')),
 applied_delta INTEGER,
 debt_repaid INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bot_admin_credit_audit ON bot_admin_credit_actions(admin_id,created_at DESC);
-- Expiring one-time-per-user promo codes; the plaintext code is shown only once at issuance.
CREATE TABLE IF NOT EXISTS bot_promo_codes (
 code_hash TEXT PRIMARY KEY,
 credits INTEGER NOT NULL CHECK(credits BETWEEN 1 AND 20),
 max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 100),
 uses INTEGER NOT NULL DEFAULT 0 CHECK(uses>=0),
 active BOOLEAN NOT NULL DEFAULT true,
 expires_at TIMESTAMPTZ NOT NULL,
 created_by BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_promo_redemptions (
 code_hash TEXT NOT NULL REFERENCES bot_promo_codes(code_hash),
 telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(code_hash,telegram_id)
);

-- Idempotent Telegram callback processing, separate from Stars receipt idempotency.
CREATE TABLE IF NOT EXISTS bot_callback_receipts (
 query_id TEXT PRIMARY KEY,
 received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_callback_receipts_expiry ON bot_callback_receipts(received_at);

-- SK-110: globally shared, bounded API rate-limit counters (never raw Telegram IDs).
CREATE TABLE IF NOT EXISTS api_rate_limits (
 scope TEXT NOT NULL,
 actor_hash TEXT NOT NULL,
 period_seconds INTEGER NOT NULL CHECK(period_seconds IN (60,3600)),
 window_start TIMESTAMPTZ NOT NULL,
 hits INTEGER NOT NULL DEFAULT 1 CHECK(hits>=1),
 PRIMARY KEY(scope,actor_hash,period_seconds,window_start)
);
CREATE INDEX IF NOT EXISTS api_rate_limits_expiration ON api_rate_limits(window_start);
