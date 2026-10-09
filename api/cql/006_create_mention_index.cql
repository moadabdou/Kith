-- 006_create_mention_index.cql
-- Exact-recipient index for mention delete-decrements (Issue #122 follow-up).
-- Written by the read-states mention counter per mentioning message with a
-- 30-day TTL; read + deleted when the message is deleted.

USE kith;

CREATE TABLE IF NOT EXISTS message_mention_index (
    message_id bigint PRIMARY KEY,
    channel_id bigint,
    user_ids list<bigint>
);
