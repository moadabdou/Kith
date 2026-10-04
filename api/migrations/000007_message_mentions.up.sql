ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mention_roles bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mention_everyone boolean NOT NULL DEFAULT false;
