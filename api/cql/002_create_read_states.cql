-- 002_create_read_states.cql
-- Read states table tracking last read message ID and mention count per user per channel.
-- Partition key: user_id (all channels for a user live in a single partition for efficient bulk retrieval)
-- Clustering key: channel_id

USE kith;

CREATE TABLE IF NOT EXISTS read_states (
    user_id bigint,
    channel_id bigint,
    last_read_message_id bigint,
    mention_count int,
    PRIMARY KEY (user_id, channel_id)
);
