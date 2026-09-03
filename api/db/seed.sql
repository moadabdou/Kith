-- Kith seed — plan/02-rest-api.md §7: 1 user, 1 guild, 3 channels.
-- Idempotent: safe to run on every `docker compose up`.
-- Fixed snowflake-shaped IDs; real IDs come from pkg/snowflake (#3).
-- password_hash is a placeholder — argon2id lands with auth (#4).

INSERT INTO users (id, username, discriminator, email, password_hash)
VALUES (87000000000000001, 'moad', 1, 'moad@kith.dev', 'seed-placeholder-no-login')
ON CONFLICT DO NOTHING;

INSERT INTO guilds (id, name, owner_id)
VALUES (87000000000000100, 'Kith HQ', 87000000000000001)
ON CONFLICT DO NOTHING;

-- Owner must be a member for the guild to be consistent.
INSERT INTO members (guild_id, user_id)
VALUES (87000000000000100, 87000000000000001)
ON CONFLICT DO NOTHING;

INSERT INTO channels (id, guild_id, type, name, position)
VALUES
    (87000000000000201, 87000000000000100, 0, 'general', 0),
    (87000000000000202, 87000000000000100, 0, 'random', 1),
    (87000000000000203, 87000000000000100, 2, 'General Voice', 0)
ON CONFLICT DO NOTHING;
