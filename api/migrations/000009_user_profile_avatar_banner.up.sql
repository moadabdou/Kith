-- Migration 000009: Add avatar, banner, and bio to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
