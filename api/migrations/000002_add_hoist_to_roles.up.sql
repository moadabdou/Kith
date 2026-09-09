-- Add hoist column to roles table (Phase 2: #29)
ALTER TABLE roles ADD COLUMN hoist boolean NOT NULL DEFAULT false;
CREATE INDEX roles_guild_id_hoist_idx ON roles(guild_id, hoist);
