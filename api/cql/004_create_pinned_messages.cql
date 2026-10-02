-- 004_create_pinned_messages.cql
-- Pinned messages table partitioned by channel_id, sorted descending by message_id

USE kith;

CREATE TABLE IF NOT EXISTS pinned_messages (
    channel_id bigint,
    message_id bigint,
    pinned_at timestamp,
    PRIMARY KEY (channel_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
