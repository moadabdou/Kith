package messages

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

const (
	// BucketDurationMs is 10 days in milliseconds (10 * 24 * 60 * 60 * 1000 = 864,000,000 ms).
	// Discord divides channel history into 10-day partitions (plan/03 §4).
	BucketDurationMs int64 = 10 * 24 * 60 * 60 * 1000
)

// Cursor represents an opaque position in the message timeline.
type Cursor struct {
	MessageID int64 `json:"message_id"`
	Bucket    int32 `json:"bucket"`
}

// Encode converts the cursor to an opaque URL-safe base64 string.
func (c Cursor) Encode() string {
	if c.MessageID <= 0 {
		return ""
	}
	data, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(data)
}

// ParseCursor parses a cursor token from a client query parameter.
// It transparently handles both opaque Base64 tokens and legacy raw Snowflake IDs (?before=<id>).
func ParseCursor(s string) (Cursor, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return Cursor{}, nil
	}

	// 1. Legacy raw Snowflake integer (digits only)
	if id, err := strconv.ParseInt(s, 10, 64); err == nil && id > 0 {
		return CursorFromMessageID(id), nil
	}

	// 2. Base64-encoded token (URL-safe, unpadded or standard padded)
	data, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		data, err = base64.URLEncoding.DecodeString(s)
	}
	if err != nil {
		data, err = base64.StdEncoding.DecodeString(s)
	}
	if err == nil {

		var c Cursor
		if err := json.Unmarshal(data, &c); err == nil && c.MessageID > 0 {
			if c.Bucket == 0 {
				c.Bucket = BucketForMessageID(c.MessageID)
			}
			return c, nil
		}
		if len(data) == 12 {
			mid := int64(binary.BigEndian.Uint64(data[0:8]))
			bkt := int32(binary.BigEndian.Uint32(data[8:12]))
			if mid > 0 {
				return Cursor{MessageID: mid, Bucket: bkt}, nil
			}
		}
	}

	return Cursor{}, errors.New("invalid cursor")
}

// NextCursor extracts the cursor pointing to the oldest message in a message slice.
func NextCursor(msgs []Message) Cursor {
	if len(msgs) == 0 {
		return Cursor{}
	}
	oldest := msgs[len(msgs)-1]
	mid, err := strconv.ParseInt(oldest.ID, 10, 64)
	if err != nil || mid <= 0 {
		return Cursor{}
	}
	return CursorFromMessageID(mid)
}

// NextCursorToken returns the opaque base64 string for the oldest message in a slice.
func NextCursorToken(msgs []Message) string {
	return NextCursor(msgs).Encode()
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
	ListAfter(ctx context.Context, channelID int64, after Cursor, limit int) ([]Message, error)
	Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error)
	Delete(ctx context.Context, channelID, messageID, authorID int64) error
	Get(ctx context.Context, channelID, messageID int64) (*Message, error)
}
