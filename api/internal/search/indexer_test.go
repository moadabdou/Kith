package search

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

type mockDocIndexer struct {
	mu           sync.Mutex
	indexedDocs  []MessageDocument
	deletedIDs   []string
	indexCalls   int
	deleteCalls  int
	flushNotify  chan struct{}
}

func newMockDocIndexer() *mockDocIndexer {
	return &mockDocIndexer{
		indexedDocs: make([]MessageDocument, 0),
		deletedIDs:  make([]string, 0),
		flushNotify: make(chan struct{}, 10),
	}
}

func (m *mockDocIndexer) IndexDocuments(ctx context.Context, index string, docs []MessageDocument) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.indexedDocs = append(m.indexedDocs, docs...)
	m.indexCalls++
	select {
	case m.flushNotify <- struct{}{}:
	default:
	}
	return nil
}

func (m *mockDocIndexer) DeleteDocuments(ctx context.Context, index string, ids []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.deletedIDs = append(m.deletedIDs, ids...)
	m.deleteCalls++
	select {
	case m.flushNotify <- struct{}{}:
	default:
	}
	return nil
}

func makeTestMsg(t *testing.T, evType string, payload any, guildID string) *nats.Msg {
	t.Helper()
	pBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	ev := rawEvent{
		Type:    evType,
		Version: 1,
		GuildID: guildID,
		Payload: pBytes,
	}
	data, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	return &nats.Msg{
		Subject: "kith.events." + guildID,
		Data:    data,
	}
}

func TestIndexer_BatchFlushOnTimer(t *testing.T) {
	mock := newMockDocIndexer()
	cfg := IndexerConfig{
		IndexName:   "messages",
		BatchSize:   100,
		FlushWindow: 50 * time.Millisecond,
	}

	idx := NewIndexer(cfg, mock, nil, nil)
	if err := idx.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer idx.Stop()

	// Send 2 messages
	msg1 := makeTestMsg(t, "MESSAGE_CREATE", messagePayload{
		ID:        "msg_1",
		ChannelID: "chan_1",
		GuildID:   "guild_1",
		Author:    authorPayload{ID: "user_1"},
		Content:   "First message",
		Timestamp: json.RawMessage(`"2026-09-14T12:00:00Z"`),
	}, "guild_1")

	msg2 := makeTestMsg(t, "MESSAGE_CREATE", messagePayload{
		ID:        "msg_2",
		ChannelID: "chan_1",
		GuildID:   "guild_1",
		Author:    authorPayload{ID: "user_2"},
		Content:   "Second message",
		Timestamp: json.RawMessage(`1789396600`),
	}, "guild_1")

	idx.msgChan <- msg1
	idx.msgChan <- msg2

	// Await flush on timer
	select {
	case <-mock.flushNotify:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for batch flush on timer")
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()
	if len(mock.indexedDocs) != 2 {
		t.Fatalf("expected 2 indexed docs, got %d", len(mock.indexedDocs))
	}
	if mock.indexedDocs[0].ID != "msg_1" && mock.indexedDocs[1].ID != "msg_1" {
		t.Errorf("msg_1 not found in indexed docs: %+v", mock.indexedDocs)
	}
}

func TestIndexer_BatchFlushOnSize(t *testing.T) {
	mock := newMockDocIndexer()
	cfg := IndexerConfig{
		IndexName:   "messages",
		BatchSize:   3,
		FlushWindow: 5 * time.Second, // Large window to ensure size triggers flush
	}

	idx := NewIndexer(cfg, mock, nil, nil)
	if err := idx.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer idx.Stop()

	for i := 1; i <= 3; i++ {
		m := makeTestMsg(t, "MESSAGE_CREATE", messagePayload{
			ID:        string(rune('0' + i)),
			ChannelID: "c1",
			GuildID:   "g1",
			Content:   "test content",
		}, "g1")
		idx.msgChan <- m
	}

	// Should flush immediately because BatchSize 3 reached
	select {
	case <-mock.flushNotify:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for batch flush on size trigger")
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()
	if len(mock.indexedDocs) != 3 {
		t.Fatalf("expected 3 indexed docs, got %d", len(mock.indexedDocs))
	}
}

func TestIndexer_IdempotentUpsertAndDedup(t *testing.T) {
	mock := newMockDocIndexer()
	cfg := IndexerConfig{
		IndexName:   "messages",
		BatchSize:   10,
		FlushWindow: 50 * time.Millisecond,
	}

	idx := NewIndexer(cfg, mock, nil, nil)
	if err := idx.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer idx.Stop()

	// Send CREATE then UPDATE for the exact same message ID
	msgCreate := makeTestMsg(t, "MESSAGE_CREATE", messagePayload{
		ID:        "same_id",
		ChannelID: "c1",
		GuildID:   "g1",
		Content:   "initial content",
	}, "g1")

	msgUpdate := makeTestMsg(t, "MESSAGE_UPDATE", messagePayload{
		ID:        "same_id",
		ChannelID: "c1",
		GuildID:   "g1",
		Content:   "updated content",
	}, "g1")

	idx.msgChan <- msgCreate
	idx.msgChan <- msgUpdate

	select {
	case <-mock.flushNotify:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for batch flush")
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()
	if len(mock.indexedDocs) != 1 {
		t.Fatalf("expected 1 deduplicated doc in batch, got %d", len(mock.indexedDocs))
	}
	if mock.indexedDocs[0].Content != "updated content" {
		t.Errorf("expected updated content, got %s", mock.indexedDocs[0].Content)
	}
}

func TestIndexer_DeleteHandling(t *testing.T) {
	mock := newMockDocIndexer()
	cfg := IndexerConfig{
		IndexName:   "messages",
		BatchSize:   10,
		FlushWindow: 50 * time.Millisecond,
	}

	idx := NewIndexer(cfg, mock, nil, nil)
	if err := idx.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer idx.Stop()

	delMsg := makeTestMsg(t, "MESSAGE_DELETE", deletePayload{
		ID:        "del_123",
		ChannelID: "c1",
		GuildID:   "g1",
	}, "g1")

	idx.msgChan <- delMsg

	select {
	case <-mock.flushNotify:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for delete flush")
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()
	if len(mock.deletedIDs) != 1 || mock.deletedIDs[0] != "del_123" {
		t.Fatalf("expected deleted ID 'del_123', got %+v", mock.deletedIDs)
	}
}

func TestParseTimestamp(t *testing.T) {
	// ISO8601 string
	ts := parseTimestamp(json.RawMessage(`"2026-09-14T12:30:00Z"`))
	if ts != 1789389000 {
		t.Errorf("unexpected parsed ts: %d", ts)
	}

	// Int64 number
	tsNum := parseTimestamp(json.RawMessage(`1234567890`))
	if tsNum != 1234567890 {
		t.Errorf("unexpected parsed numeric ts: %d", tsNum)
	}

	// Empty fallback
	tsEmpty := parseTimestamp(nil)
	if tsEmpty <= 0 {
		t.Errorf("expected non-zero fallback timestamp, got %d", tsEmpty)
	}
}
