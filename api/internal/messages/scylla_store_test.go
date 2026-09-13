package messages

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gocql/gocql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

func newTestScyllaSession(t *testing.T) *gocql.Session {
	t.Helper()
	hostsEnv := os.Getenv("TEST_SCYLLA_HOSTS")
	if hostsEnv == "" {
		hostsEnv = os.Getenv("SCYLLA_HOSTS")
	}
	if hostsEnv == "" {
		hostsEnv = "127.0.0.1:9042"
	}
	hosts := strings.Split(hostsEnv, ",")

	session, err := NewScyllaSession(ScyllaConfig{
		Hosts:       hosts,
		Keyspace:    "kith",
		Consistency: gocql.One, // Single-node local Scylla in dev
		Timeout:     3 * time.Second,
	})
	if err != nil {
		t.Skipf("ScyllaDB not reachable at %v: %v", hosts, err)
	}
	t.Cleanup(func() {
		session.Close()
	})
	return session
}

func TestScyllaStore_CRUD(t *testing.T) {
	session := newTestScyllaSession(t)
	ctx := context.Background()

	node, _ := snowflake.NewNode(1)
	channelID, _ := node.Generate()
	authorID, _ := node.Generate()

	var hydrator AuthorHydrator
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn != "" {
		if db, err := sql.Open("pgx", dsn); err == nil {
			hydrator = NewPostgresAuthorHydrator(db)
			t.Cleanup(func() { db.Close() })
		}
	}

	store := NewScyllaStore(session, hydrator)

	// 1. Insert
	msgID, _ := node.Generate()
	msg := &Message{
		ID:        strconv.FormatInt(msgID, 10),
		ChannelID: strconv.FormatInt(channelID, 10),
		Author:    AuthorRef{ID: strconv.FormatInt(authorID, 10)},
		Content:   "Hello ScyllaDB!",
	}

	if err := store.Insert(ctx, msg); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if msg.CreatedAt.IsZero() {
		t.Fatalf("Insert did not set CreatedAt")
	}

	// 2. Get
	fetched, err := store.Get(ctx, channelID, msgID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if fetched.ID != msg.ID {
		t.Errorf("Get ID = %s, want %s", fetched.ID, msg.ID)
	}
	if fetched.Content != "Hello ScyllaDB!" {
		t.Errorf("Get Content = %q, want %q", fetched.Content, "Hello ScyllaDB!")
	}
	if fetched.Author.ID != strconv.FormatInt(authorID, 10) {
		t.Errorf("Get Author.ID = %s, want %d", fetched.Author.ID, authorID)
	}
	if fetched.EditedAt != nil {
		t.Errorf("Get EditedAt should be nil before edits")
	}

	// 3. Edit
	edited, err := store.Edit(ctx, channelID, msgID, "Updated content")
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if edited.Content != "Updated content" {
		t.Errorf("Edit Content = %q, want %q", edited.Content, "Updated content")
	}
	if edited.EditedAt == nil {
		t.Errorf("Edit EditedAt must not be nil")
	}

	// Verify edit persisted on subsequent Get
	reGet, err := store.Get(ctx, channelID, msgID)
	if err != nil {
		t.Fatalf("Get after Edit: %v", err)
	}
	if reGet.Content != "Updated content" {
		t.Errorf("reGet Content = %q, want %q", reGet.Content, "Updated content")
	}
	if reGet.EditedAt == nil {
		t.Errorf("reGet EditedAt must be set")
	}

	// 4. List within partition
	var lastMsgID int64
	for i := 0; i < 5; i++ {
		time.Sleep(2 * time.Millisecond) // ensure distinct snowflake timestamps
		id, _ := node.Generate()
		lastMsgID = id
		m := &Message{
			ID:        strconv.FormatInt(id, 10),
			ChannelID: strconv.FormatInt(channelID, 10),
			Author:    AuthorRef{ID: strconv.FormatInt(authorID, 10)},
			Content:   fmt.Sprintf("Message %d", i),
		}
		if err := store.Insert(ctx, m); err != nil {
			t.Fatalf("Insert #%d: %v", i, err)
		}
	}

	// Query latest messages with limit 3
	listLatest, err := store.List(ctx, channelID, Cursor{}, 3)
	if err != nil {
		t.Fatalf("List latest: %v", err)
	}
	if len(listLatest) != 3 {
		t.Fatalf("List latest count = %d, want 3", len(listLatest))
	}
	// Verify DESC order
	firstID, _ := strconv.ParseInt(listLatest[0].ID, 10, 64)
	secondID, _ := strconv.ParseInt(listLatest[1].ID, 10, 64)
	if firstID <= secondID {
		t.Errorf("List messages not in DESC order: %d <= %d", firstID, secondID)
	}

	// Query with cursor
	cursor := CursorFromMessageID(lastMsgID)
	paginated, err := store.List(ctx, channelID, cursor, 10)
	if err != nil {
		t.Fatalf("List with cursor: %v", err)
	}
	for _, p := range paginated {
		pid, _ := strconv.ParseInt(p.ID, 10, 64)
		if pid >= lastMsgID {
			t.Errorf("Paginated message id %d is >= cursor %d", pid, lastMsgID)
		}
	}

	// 5. Delete
	otherAuthor, _ := node.Generate()
	if err := store.Delete(ctx, channelID, msgID, otherAuthor); !errors.Is(err, ErrNotAuthor) {
		t.Errorf("Delete with wrong author = %v, want ErrNotAuthor", err)
	}

	if err := store.Delete(ctx, channelID, msgID, authorID); err != nil {
		t.Fatalf("Delete with author: %v", err)
	}

	// Subsequent Get should return ErrUnknownMessage
	if _, err := store.Get(ctx, channelID, msgID); !errors.Is(err, ErrUnknownMessage) {
		t.Errorf("Get after delete = %v, want ErrUnknownMessage", err)
	}
}

func TestCrossBucketPagination(t *testing.T) {
	session := newTestScyllaSession(t)
	ctx := context.Background()
	store := NewScyllaStore(session, nil)

	const oneDayMs = int64(24 * time.Hour / time.Millisecond)

	makeSnowflake := func(dayOffset int64, seq int64) int64 {
		return (dayOffset * oneDayMs << (snowflake.NodeBits + snowflake.SeqBits)) |
			(1 << snowflake.SeqBits) |
			seq
	}

	// Channel created at Day 10 -> channelCreationBucket is Bucket 1
	channelID := makeSnowflake(10, 0)
	authorID := int64(999999)

	// Seed messages across 3 bucket hops:
	// Bucket 1: Day 11, 12, 13 (3 messages)
	// Bucket 2: (0 messages - gap)
	// Bucket 3: Day 31, 32 (2 messages)
	m1 := makeSnowflake(11, 1)
	m2 := makeSnowflake(12, 1)
	m3 := makeSnowflake(13, 1)
	m4 := makeSnowflake(31, 1)
	m5 := makeSnowflake(32, 1)

	for _, mid := range []int64{m1, m2, m3, m4, m5} {
		msg := &Message{
			ID:        strconv.FormatInt(mid, 10),
			ChannelID: strconv.FormatInt(channelID, 10),
			Author:    AuthorRef{ID: strconv.FormatInt(authorID, 10)},
			Content:   fmt.Sprintf("Message %d", mid),
		}
		if err := store.Insert(ctx, msg); err != nil {
			t.Fatalf("seed message %d: %v", mid, err)
		}
	}

	// 1. Multi-bucket hop: query from Bucket 3 with limit 5
	// Should return m5, m4 from Bucket 3, hop across empty Bucket 2, and return m3, m2, m1 from Bucket 1
	startCursor := CursorFromMessageID(m5 + 1)
	page, err := store.List(ctx, channelID, startCursor, 5)
	if err != nil {
		t.Fatalf("List across buckets: %v", err)
	}
	if len(page) != 5 {
		t.Fatalf("got %d messages, want 5 across bucket hops", len(page))
	}

	expectedIDs := []int64{m5, m4, m3, m2, m1}
	for i, expected := range expectedIDs {
		gotID, _ := strconv.ParseInt(page[i].ID, 10, 64)
		if gotID != expected {
			t.Errorf("page[%d] = %d, want %d", i, gotID, expected)
		}
	}

	// 2. Cursor pagination from oldest message in Bucket 3 (m4)
	cursorM4 := CursorFromMessageID(m4)
	pageFromM4, err := store.List(ctx, channelID, cursorM4, 10)
	if err != nil {
		t.Fatalf("List from m4: %v", err)
	}
	if len(pageFromM4) != 3 {
		t.Fatalf("pageFromM4 len = %d, want 3", len(pageFromM4))
	}
	expectedOlder := []int64{m3, m2, m1}
	for i, expected := range expectedOlder {
		gotID, _ := strconv.ParseInt(pageFromM4[i].ID, 10, 64)
		if gotID != expected {
			t.Errorf("pageFromM4[%d] = %d, want %d", i, gotID, expected)
		}
	}

	// 3. Backward compatibility: query with legacy raw Snowflake ID string
	legacyCursor, err := ParseCursor(strconv.FormatInt(m4, 10))
	if err != nil {
		t.Fatalf("ParseCursor(legacy): %v", err)
	}
	legacyPage, err := store.List(ctx, channelID, legacyCursor, 10)
	if err != nil {
		t.Fatalf("List with legacy cursor: %v", err)
	}
	if len(legacyPage) != 3 {
		t.Fatalf("legacyPage len = %d, want 3", len(legacyPage))
	}

	// 4. Backward compatibility: query with opaque Base64 cursor token
	opaqueToken := cursorM4.Encode()
	opaqueCursor, err := ParseCursor(opaqueToken)
	if err != nil {
		t.Fatalf("ParseCursor(opaque): %v", err)
	}
	opaquePage, err := store.List(ctx, channelID, opaqueCursor, 10)
	if err != nil {
		t.Fatalf("List with opaque cursor: %v", err)
	}
	if len(opaquePage) != 3 {
		t.Fatalf("opaquePage len = %d, want 3", len(opaquePage))
	}

	// 5. Channel creation epoch boundary termination
	// Asking for limit 20 when only 5 exist should stop at Bucket 1 (channel creation bucket)
	exhaustPage, err := store.List(ctx, channelID, startCursor, 20)
	if err != nil {
		t.Fatalf("List exhaust: %v", err)
	}
	if len(exhaustPage) != 5 {
		t.Errorf("exhaustPage len = %d, want 5", len(exhaustPage))
	}
}
