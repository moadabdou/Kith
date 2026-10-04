-- init-cluster.cql
-- Keyspace and schema for multi-node cluster with NetworkTopologyStrategy (RF: 3)

CREATE KEYSPACE IF NOT EXISTS kith
WITH replication = {
    'class': 'NetworkTopologyStrategy',
    'datacenter1': 3
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
    mention_roles list<bigint>,
    mention_everyone boolean,
    type smallint,
    reply_to bigint,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 7
};

CREATE TABLE IF NOT EXISTS read_states (
    user_id bigint,
    channel_id bigint,
    last_read_message_id bigint,
    mention_count int,
    PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
    channel_id bigint,
    message_id bigint,
    emoji varchar,
    user_id bigint,
    created_at timestamp,
    PRIMARY KEY ((channel_id, message_id), emoji, user_id)
);

