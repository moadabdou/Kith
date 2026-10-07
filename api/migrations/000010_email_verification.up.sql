-- Migration 000010: Add email verification to users and email_verifications table
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT true;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false;

CREATE TABLE IF NOT EXISTS email_verifications (
    id bigint PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts smallint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verifications_user_id_idx ON email_verifications(user_id);
CREATE INDEX IF NOT EXISTS email_verifications_code_hash_idx ON email_verifications(code_hash);
CREATE INDEX IF NOT EXISTS email_verifications_token_hash_idx ON email_verifications(token_hash);
