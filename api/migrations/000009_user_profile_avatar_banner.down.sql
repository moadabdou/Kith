-- Migration 000009 (down): Remove avatar, banner, and bio from users
ALTER TABLE users DROP COLUMN IF EXISTS avatar;
ALTER TABLE users DROP COLUMN IF EXISTS banner;
ALTER TABLE users DROP COLUMN IF EXISTS bio;
