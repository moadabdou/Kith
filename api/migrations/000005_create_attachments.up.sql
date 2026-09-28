CREATE TABLE IF NOT EXISTS attachments (
    id               bigint PRIMARY KEY,
    channel_id       bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    uploader_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id       bigint REFERENCES messages(id) ON DELETE SET NULL,
    filename         varchar(255) NOT NULL,
    content_type     varchar(128) NOT NULL,
    byte_size        bigint NOT NULL,
    sha256           char(64) NOT NULL,
    s3_bucket        varchar(64) NOT NULL DEFAULT 'attachments',
    s3_key           text NOT NULL,
    status           varchar(32) NOT NULL DEFAULT 'pending',
    width            int,
    height           int,
    duration_seconds double precision,
    thumbnails       jsonb DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_channel_id_idx ON attachments(channel_id);
CREATE INDEX IF NOT EXISTS attachments_message_id_idx ON attachments(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_sha256_idx ON attachments(sha256);
CREATE INDEX IF NOT EXISTS attachments_status_created_idx ON attachments(status, created_at);
