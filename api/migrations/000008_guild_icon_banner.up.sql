-- Migration 000008: Add icon and banner to guilds
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE guilds ADD COLUMN IF NOT EXISTS banner text;
