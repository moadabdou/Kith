DROP INDEX IF EXISTS roles_guild_id_hoist_idx;
ALTER TABLE roles DROP COLUMN IF EXISTS hoist;
