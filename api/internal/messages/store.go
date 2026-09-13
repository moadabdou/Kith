package messages

import (
	"context"

	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

const (
	// BucketDurationMs is 10 days in milliseconds (10 * 24 * 60 * 60 * 1000 = 864,000,000 ms).
	// Discord divides channel history into 10-day partitions (plan/03 §4).
	BucketDurationMs int64 = 10 * 24 * 60 * 60 * 1000
)

// Cursor represents an opaque position in the message timeline.
type Cursor struct {
	MessageID int64
	Bucket    int32
}

// CursorFromMessageID constructs a Cursor from a snowflake message ID,
// automatically computing its 10-day partition bucket.
func CursorFromMessageID(id int64) Cursor {
	if id <= 0 {
		return Cursor{}
	}
	return Cursor{
		MessageID: id,
		Bucket:    BucketForMessageID(id),
	}
}

// BucketForMessageID derives the 10-day bucket partition deterministically from a snowflake ID.
// Formula: ((id >> 22)) / (1000 * 60 * 60 * 24 * 10).
// In Kith's snowflake layout, id >> 22 yields milliseconds since epoch (2026-01-01T00:00:00Z).
func BucketForMessageID(id int64) int32 {
	if id <= 0 {
		return 0
	}
	ms := id >> (snowflake.NodeBits + snowflake.SeqBits) // id >> 22
	if ms < 0 {
		return 0
	}
	return int32(ms / BucketDurationMs)
}

// Store abstracts the persistence layer for messages (plan/03 §3, §7).
// Pluggable behind PostgreSQL (PostgresStore) and ScyllaDB (ScyllaStore).
type Store interface {
	Insert(ctx context.Context, msg *Message) error
	List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error)
	Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error)
	Delete(ctx context.Context, channelID, messageID, authorID int64) error
	Get(ctx context.Context, channelID, messageID int64) (*Message, error)
}
