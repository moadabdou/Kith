-- Retroactively ensure all existing guilds have their @everyone baseline role.
-- @everyone has id = guild_id, position = 0, and standard default permissions (104324673).
INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable)
SELECT g.id, g.id, '@everyone', 0, false, 0, 104324673, false
FROM guilds g
WHERE NOT EXISTS (
    SELECT 1 FROM roles r WHERE r.id = g.id AND r.guild_id = g.id
);
