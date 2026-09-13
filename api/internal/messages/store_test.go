package messages

import (
	"testing"
	"time"

	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

func TestBucketForMessageID(t *testing.T) {
	const (
		oneHourMs = int64(time.Hour / time.Millisecond)
		oneDayMs  = 24 * oneHourMs
	)

	makeSnowflake := func(msOffset int64, nodeID int64, seq int64) int64 {
		return (msOffset << (snowflake.NodeBits + snowflake.SeqBits)) |
			(nodeID << snowflake.SeqBits) |
			(seq & snowflake.MaxSeq)
	}

	tests := []struct {
		name     string
		id       int64
		expected int32
	}{
		{
			name:     "zero id",
			id:       0,
			expected: 0,
		},
		{
			name:     "negative id",
			id:       -100,
			expected: 0,
		},
		{
			name:     "epoch start (day 0, 0ms)",
			id:       makeSnowflake(0, 1, 0),
			expected: 0,
		},
		{
			name:     "day 5 middle of bucket 0",
			id:       makeSnowflake(5*oneDayMs, 42, 100),
			expected: 0,
		},
		{
			name:     "day 9 last ms of bucket 0",
			id:       makeSnowflake(10*oneDayMs-1, 1023, 4095),
			expected: 0,
		},
		{
			name:     "day 10 boundary (exact start of bucket 1)",
			id:       makeSnowflake(10*oneDayMs, 0, 0),
			expected: 1,
		},
		{
			name:     "day 15 middle of bucket 1",
			id:       makeSnowflake(15*oneDayMs, 512, 2048),
			expected: 1,
		},
		{
			name:     "day 19 last ms of bucket 1",
			id:       makeSnowflake(20*oneDayMs-1, 999, 12),
			expected: 1,
		},
		{
			name:     "day 20 boundary (exact start of bucket 2)",
			id:       makeSnowflake(20*oneDayMs, 1, 1),
			expected: 2,
		},
		{
			name:     "day 29 last ms of bucket 2",
			id:       makeSnowflake(30*oneDayMs-1, 100, 500),
			expected: 2,
		},
		{
			name:     "day 30 boundary (start of bucket 3)",
			id:       makeSnowflake(30*oneDayMs, 2, 0),
			expected: 3,
		},
		{
			name:     "day 365 (bucket 36)",
			id:       makeSnowflake(365*oneDayMs, 10, 15),
			expected: 36,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := BucketForMessageID(tc.id)
			if got != tc.expected {
				t.Errorf("BucketForMessageID(%d) = %d, want %d", tc.id, got, tc.expected)
			}
		})
	}
}

func TestBucketBitshiftIsolation(t *testing.T) {
	const oneDayMs = int64(24 * time.Hour / time.Millisecond)
	targetDay := int64(14) // bucket 1
	expectedBucket := int32(1)

	// Vary node id and sequence over their full bit ranges; bucket must remain identical
	nodeIDs := []int64{0, 1, 42, 512, 1023}
	seqs := []int64{0, 1, 100, 2048, 4095}

	for _, nodeID := range nodeIDs {
		for _, seq := range seqs {
			id := (targetDay * oneDayMs << (snowflake.NodeBits + snowflake.SeqBits)) |
				(nodeID << snowflake.SeqBits) |
				seq
			got := BucketForMessageID(id)
			if got != expectedBucket {
				t.Fatalf("nodeID=%d seq=%d: BucketForMessageID(%d) = %d, want %d",
					nodeID, seq, id, got, expectedBucket)
			}
		}
	}
}

func TestCursorFromMessageID(t *testing.T) {
	const oneDayMs = int64(24 * time.Hour / time.Millisecond)

	// ID at day 25 -> Bucket 2
	id := (25 * oneDayMs) << (snowflake.NodeBits + snowflake.SeqBits)
	cursor := CursorFromMessageID(id)
	if cursor.MessageID != id {
		t.Errorf("cursor.MessageID = %d, want %d", cursor.MessageID, id)
	}
	if cursor.Bucket != 2 {
		t.Errorf("cursor.Bucket = %d, want 2", cursor.Bucket)
	}

	// Zero ID
	zeroCursor := CursorFromMessageID(0)
	if zeroCursor.MessageID != 0 || zeroCursor.Bucket != 0 {
		t.Errorf("zeroCursor = %+v, want all zeros", zeroCursor)
	}
}

func TestOpaqueCursorEngine(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	msgID, _ := node.Generate()
	bucket := BucketForMessageID(msgID)

	cursor := Cursor{
		MessageID: msgID,
		Bucket:    bucket,
	}

	// 1. Encode to opaque token
	token := cursor.Encode()
	if token == "" {
		t.Fatalf("cursor.Encode() returned empty string")
	}

	// 2. Decode opaque token
	parsed, err := ParseCursor(token)
	if err != nil {
		t.Fatalf("ParseCursor(token): %v", err)
	}
	if parsed.MessageID != msgID {
		t.Errorf("parsed.MessageID = %d, want %d", parsed.MessageID, msgID)
	}
	if parsed.Bucket != bucket {
		t.Errorf("parsed.Bucket = %d, want %d", parsed.Bucket, bucket)
	}

	// 3. Backward compatibility with legacy Snowflake ID string
	legacyStr := snowflake.String(msgID)
	legacyParsed, err := ParseCursor(legacyStr)
	if err != nil {
		t.Fatalf("ParseCursor(legacyStr): %v", err)
	}
	if legacyParsed.MessageID != msgID {
		t.Errorf("legacyParsed.MessageID = %d, want %d", legacyParsed.MessageID, msgID)
	}
	if legacyParsed.Bucket != bucket {
		t.Errorf("legacyParsed.Bucket = %d, want %d", legacyParsed.Bucket, bucket)
	}

	// 4. Empty string
	empty, err := ParseCursor("")
	if err != nil {
		t.Errorf("ParseCursor(\"\") error = %v", err)
	}
	if empty.MessageID != 0 || empty.Bucket != 0 {
		t.Errorf("empty cursor = %+v, want zeros", empty)
	}

	// 5. Invalid string
	if _, err := ParseCursor("invalid-not-base64-or-id!@#$%"); err == nil {
		t.Errorf("ParseCursor(invalid) should error, got nil")
	}
}

func TestNextCursor(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	id1, _ := node.Generate()
	time.Sleep(2 * time.Millisecond)
	id2, _ := node.Generate()

	msgs := []Message{
		{ID: snowflake.String(id2)},
		{ID: snowflake.String(id1)}, // oldest is at the end of DESC slice
	}

	c := NextCursor(msgs)
	if c.MessageID != id1 {
		t.Errorf("NextCursor ID = %d, want %d", c.MessageID, id1)
	}
	if c.Bucket != BucketForMessageID(id1) {
		t.Errorf("NextCursor Bucket = %d, want %d", c.Bucket, BucketForMessageID(id1))
	}

	token := NextCursorToken(msgs)
	if token != c.Encode() {
		t.Errorf("NextCursorToken = %q, want %q", token, c.Encode())
	}

	// Empty slice
	if empty := NextCursor(nil); empty.MessageID != 0 {
		t.Errorf("NextCursor(nil) = %+v, want empty", empty)
	}
}
