CREATE TABLE IF NOT EXISTS guild_emojis (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name VARCHAR(32) NOT NULL,
    uploader_id BIGINT NOT NULL REFERENCES users(id),
    animated BOOLEAN NOT NULL DEFAULT FALSE,
    content_type VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guild_emojis_guild ON guild_emojis(guild_id);

CREATE TABLE IF NOT EXISTS guild_stickers (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    name VARCHAR(32) NOT NULL,
    description VARCHAR(100),
    uploader_id BIGINT NOT NULL REFERENCES users(id),
    content_type VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guild_stickers_guild ON guild_stickers(guild_id);
