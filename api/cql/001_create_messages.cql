-- 001_create_messages.cql
-- Keyspace and messages table definition with TimeWindowCompactionStrategy (TWCS)

CREATE KEYSPACE IF NOT EXISTS kith
WITH replication = {
    'class': 'SimpleStrategy',
    'replication_factor': 1
};

USE kith;

CREATE TABLE IF NOT EXISTS messages (
    channel_id bigint,
    bucket int,
    message_id bigint,
    author_id bigint,
    content text,
    edits list<text>,
    attachments list<text>,
    mentions list<bigint>,
    type smallint,
    reply_to bigint,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 7
};
