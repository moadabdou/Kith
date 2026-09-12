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
    type smallint,
    reply_to bigint,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 7
};
