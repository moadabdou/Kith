-- 003_create_reactions.cql
-- Message reactions table tracking user emoji reactions per message.
-- Composite Partition Key: (channel_id, message_id)
-- Colocates all reactions for a single message in the exact same ScyllaDB shard/partition,
-- enabling single-partition slice queries: WHERE channel_id = ? AND message_id = ?
-- Clustering Keys: emoji, user_id for conflict-free, LWT-free point mutations.

USE kith;

CREATE TABLE IF NOT EXISTS message_reactions (
    channel_id bigint,
    message_id bigint,
    emoji varchar,
    user_id bigint,
    created_at timestamp,
    PRIMARY KEY ((channel_id, message_id), emoji, user_id)
);
