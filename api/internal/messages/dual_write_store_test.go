package messages

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/moadabdou/Kith/api/pkg/snowflake"
	dto "github.com/prometheus/client_model/go"
)

// mockStore is an in-memory Store implementation for unit testing DualWriteStore.
type mockStore struct {
	messages  map[int64]Message
	insertErr error
	editErr   error
	deleteErr error
	getErr    error
	listErr   error
}

func newMockStore() *mockStore {
	return &mockStore{
		messages: make(map[int64]Message),
	}
}

func (m *mockStore) Insert(ctx context.Context, msg *Message) error {
	if m.insertErr != nil {
		return m.insertErr
	}
	id, _ := strconv.ParseInt(msg.ID, 10, 64)
	m.messages[id] = *msg
	return nil
}

func (m *mockStore) List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	var res []Message
	for _, msg := range m.messages {
		cid, _ := strconv.ParseInt(msg.ChannelID, 10, 64)
		if cid == channelID {
			res = append(res, msg)
		}
	}
	return res, nil
}

func (m *mockStore) ListAfter(ctx context.Context, channelID int64, after Cursor, limit int) ([]Message, error) {
	return m.List(ctx, channelID, after, limit)
}

func (m *mockStore) Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error) {
	if m.editErr != nil {
		return nil, m.editErr
	}
	msg, ok := m.messages[messageID]
	if !ok {
		return nil, ErrUnknownMessage
	}
	msg.Content = content
	now := time.Now()
	msg.EditedAt = &now
	m.messages[messageID] = msg
	return &msg, nil
}

func (m *mockStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.messages, messageID)
	return nil
}

func (m *mockStore) Get(ctx context.Context, channelID, messageID int64) (*Message, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	msg, ok := m.messages[messageID]
	if !ok {
		return nil, ErrUnknownMessage
	}
	return &msg, nil
}

func getCounterValue(counter *dto.Counter) float64 {
	if counter == nil {
		return 0
	}
	return counter.GetValue()
}

func TestDualWriteMode_Parsing(t *testing.T) {
	tests := []struct {
		input string
		want  DualWriteMode
	}{
		{"", ModePostgresOnly},
		{"postgres", ModePostgresOnly},
		{"postgres_only", ModePostgresOnly},
		{"dual_write_pg_primary", ModeDualWritePGPrimary},
		{"DUAL_WRITE_PG_PRIMARY", ModeDualWritePGPrimary},
		{"dual_write_scylla_primary", ModeDualWriteScyllaPrimary},
		{"scylla", ModeScyllaOnly},
		{"scylla_only", ModeScyllaOnly},
		{"unknown", ModePostgresOnly},
	}

	for _, tc := range tests {
		got := ParseDualWriteMode(tc.input)
		if got != tc.want {
			t.Errorf("ParseDualWriteMode(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestDualWriteStore_WriteResilience(t *testing.T) {
	ctx := context.Background()
	primary := newMockStore()
	secondary := newMockStore()

	store := NewDualWriteStore(ModeDualWritePGPrimary, primary, secondary)
	// Synchronous runner for immediate deterministic assertions
	store.SetAsyncRunner(func(fn func()) { fn() })

	testMsg := &Message{
		ID:        snowflake.String(1001),
		ChannelID: "500",
		Author:    AuthorRef{ID: "99"},
		Content:   "Dual write resilient message",
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}

	// 1. Success on both primary and secondary
	if err := store.Insert(ctx, testMsg); err != nil {
		t.Fatalf("unexpected insert error: %v", err)
	}
	if len(primary.messages) != 1 || len(secondary.messages) != 1 {
		t.Errorf("expected msg in both stores; primary=%d, secondary=%d", len(primary.messages), len(secondary.messages))
	}

	// 2. Secondary write failure does NOT fail user request
	secondary.insertErr = errors.New("scylla connection timeout")
	testMsg2 := &Message{
		ID:        snowflake.String(1002),
		ChannelID: "500",
		Author:    AuthorRef{ID: "99"},
		Content:   "Secondary fails, primary succeeds",
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}

	var beforeMetric dto.Metric
	_ = SecondaryWriteFailuresTotal.WithLabelValues("insert", "scylla").Write(&beforeMetric)
	beforeVal := getCounterValue(beforeMetric.GetCounter())

	if err := store.Insert(ctx, testMsg2); err != nil {
		t.Fatalf("expected nil error on secondary write failure, got: %v", err)
	}

	if _, ok := primary.messages[1002]; !ok {
		t.Errorf("expected message 1002 in primary store")
	}

	var afterMetric dto.Metric
	_ = SecondaryWriteFailuresTotal.WithLabelValues("insert", "scylla").Write(&afterMetric)
	afterVal := getCounterValue(afterMetric.GetCounter())

	if afterVal != beforeVal+1 {
		t.Errorf("expected SecondaryWriteFailuresTotal incremented from %v to %v, got %v", beforeVal, beforeVal+1, afterVal)
	}

	// 3. Primary failure aborts and does NOT touch secondary
	primary.insertErr = errors.New("postgres disk full")
	secondary.insertErr = nil
	testMsg3 := &Message{
		ID:        snowflake.String(1003),
		ChannelID: "500",
		Author:    AuthorRef{ID: "99"},
		Content:   "Primary fails",
	}

	if err := store.Insert(ctx, testMsg3); err == nil {
		t.Fatalf("expected error when primary fails, got nil")
	}
	if _, ok := secondary.messages[1003]; ok {
		t.Errorf("secondary should not receive write when primary fails")
	}
}

func TestDualWriteStore_EditAndDeleteResilience(t *testing.T) {
	ctx := context.Background()
	primary := newMockStore()
	secondary := newMockStore()

	store := NewDualWriteStore(ModeDualWritePGPrimary, primary, secondary)
	store.SetAsyncRunner(func(fn func()) { fn() })

	msg := &Message{
		ID:        snowflake.String(2001),
		ChannelID: "500",
		Author:    AuthorRef{ID: "99"},
		Content:   "Original Content",
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}
	_ = store.Insert(ctx, msg)

	// Test Edit with secondary failure
	secondary.editErr = errors.New("scylla edit failure")
	edited, err := store.Edit(ctx, 500, 2001, "Updated Content")
	if err != nil {
		t.Fatalf("expected edit to succeed despite secondary error: %v", err)
	}
	if edited.Content != "Updated Content" {
		t.Errorf("expected content 'Updated Content', got %q", edited.Content)
	}

	// Test Delete with secondary failure
	secondary.deleteErr = errors.New("scylla tombstone timeout")
	if err := store.Delete(ctx, 500, 2001, 99); err != nil {
		t.Fatalf("expected delete to succeed despite secondary error: %v", err)
	}
	if _, ok := primary.messages[2001]; ok {
		t.Errorf("expected message 2001 deleted from primary")
	}
}

func TestDualWriteStore_ShadowDiffGet(t *testing.T) {
	ctx := context.Background()
	primary := newMockStore()
	secondary := newMockStore()

	store := NewDualWriteStore(ModeDualWritePGPrimary, primary, secondary)
	store.SetAsyncRunner(func(fn func()) { fn() })

	createdAt := time.Now().Truncate(time.Millisecond)
	pMsg := Message{
		ID:        snowflake.String(3001),
		ChannelID: "500",
		Author:    AuthorRef{ID: "99"},
		Content:   "Primary Content",
		CreatedAt: createdAt,
	}
	primary.messages[3001] = pMsg
	secondary.messages[3001] = pMsg

	// 1. Identical responses -> zero mismatches
	var mBefore dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("get", "field_mismatch").Write(&mBefore)
	vBefore := getCounterValue(mBefore.GetCounter())

	got, err := store.Get(ctx, 500, 3001)
	if err != nil || got == nil {
		t.Fatalf("unexpected Get error: %v", err)
	}

	var mAfter dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("get", "field_mismatch").Write(&mAfter)
	vAfter := getCounterValue(mAfter.GetCounter())

	if vAfter != vBefore {
		t.Errorf("expected no mismatch on identical message, got increment from %v to %v", vBefore, vAfter)
	}

	// 2. Field mismatch (secondary has divergent content)
	secMsg := pMsg
	secMsg.Content = "Divergent Content in Scylla"
	secondary.messages[3001] = secMsg

	got, err = store.Get(ctx, 500, 3001)
	if err != nil || got.Content != "Primary Content" {
		t.Fatalf("caller must receive primary content, got %v", got)
	}

	var mAfterField dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("get", "field_mismatch").Write(&mAfterField)
	vAfterField := getCounterValue(mAfterField.GetCounter())
	if vAfterField != vAfter+1 {
		t.Errorf("expected field_mismatch incremented, got %v -> %v", vAfter, vAfterField)
	}

	// 3. Existence mismatch (message missing in secondary)
	delete(secondary.messages, 3001)
	secondary.getErr = ErrUnknownMessage

	var mBeforeExist dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("get", "existence").Write(&mBeforeExist)
	vBeforeExist := getCounterValue(mBeforeExist.GetCounter())

	got, err = store.Get(ctx, 500, 3001)
	if err != nil || got == nil {
		t.Fatalf("caller should get primary message, got err: %v", err)
	}

	var mAfterExist dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("get", "existence").Write(&mAfterExist)
	vAfterExist := getCounterValue(mAfterExist.GetCounter())
	if vAfterExist != vBeforeExist+1 {
		t.Errorf("expected existence mismatch incremented, got %v -> %v", vBeforeExist, vAfterExist)
	}
}

func TestDualWriteStore_ShadowDiffList(t *testing.T) {
	ctx := context.Background()
	primary := newMockStore()
	secondary := newMockStore()

	store := NewDualWriteStore(ModeDualWritePGPrimary, primary, secondary)
	store.SetAsyncRunner(func(fn func()) { fn() })

	now := time.Now().Truncate(time.Millisecond)
	m1 := Message{ID: snowflake.String(4001), ChannelID: "600", Author: AuthorRef{ID: "1"}, Content: "One", CreatedAt: now}
	m2 := Message{ID: snowflake.String(4002), ChannelID: "600", Author: AuthorRef{ID: "1"}, Content: "Two", CreatedAt: now}

	primary.messages[4001] = m1
	primary.messages[4002] = m2
	secondary.messages[4001] = m1
	secondary.messages[4002] = m2

	// 1. Identical list -> 0 diff
	msgs, err := store.List(ctx, 600, Cursor{}, 10)
	if err != nil || len(msgs) != 2 {
		t.Fatalf("unexpected List result: %d msgs, err=%v", len(msgs), err)
	}

	// 2. Count mismatch (secondary has fewer messages)
	delete(secondary.messages, 4002)

	var mBeforeCount dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("list", "count_mismatch").Write(&mBeforeCount)
	vBeforeCount := getCounterValue(mBeforeCount.GetCounter())

	msgs, err = store.List(ctx, 600, Cursor{}, 10)
	if err != nil || len(msgs) != 2 {
		t.Fatalf("caller must receive primary list, got %d msgs", len(msgs))
	}

	var mAfterCount dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("list", "count_mismatch").Write(&mAfterCount)
	vAfterCount := getCounterValue(mAfterCount.GetCounter())
	if vAfterCount != vBeforeCount+1 {
		t.Errorf("expected count_mismatch incremented, got %v -> %v", vBeforeCount, vAfterCount)
	}

	// 3. Item mismatch (same count, different item content)
	m2Divergent := m2
	m2Divergent.Content = "Corrupted or Divergent Content"
	secondary.messages[4002] = m2Divergent

	var mBeforeItem dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("list", "item_mismatch").Write(&mBeforeItem)
	vBeforeItem := getCounterValue(mBeforeItem.GetCounter())

	msgs, err = store.List(ctx, 600, Cursor{}, 10)
	if err != nil {
		t.Fatalf("unexpected List error: %v", err)
	}

	var mAfterItem dto.Metric
	_ = ShadowDiffMismatchesTotal.WithLabelValues("list", "item_mismatch").Write(&mAfterItem)
	vAfterItem := getCounterValue(mAfterItem.GetCounter())
	if vAfterItem != vBeforeItem+1 {
		t.Errorf("expected item_mismatch incremented, got %v -> %v", vBeforeItem, vAfterItem)
	}
}

func TestDualWriteStore_ModesSwitching(t *testing.T) {
	ctx := context.Background()
	primary := newMockStore()
	secondary := newMockStore()

	// ModeDualWriteScyllaPrimary: Scylla is primary, Postgres is secondary
	store := NewDualWriteStore(ModeDualWriteScyllaPrimary, primary, secondary)
	store.SetAsyncRunner(func(fn func()) { fn() })

	msg := &Message{
		ID:        snowflake.String(5001),
		ChannelID: "700",
		Author:    AuthorRef{ID: "10"},
		Content:   "Scylla Primary",
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}

	if err := store.Insert(ctx, msg); err != nil {
		t.Fatalf("insert failed: %v", err)
	}

	// Under ScyllaPrimary: secondary is mockStore (primary passed was pgStore, scyllaStore)
	// NewDualWriteStore(ModeDualWriteScyllaPrimary, pgStore, scyllaStore) sets primary=scyllaStore, secondary=pgStore
	if store.primaryName != "scylla" || store.secondaryName != "postgres" {
		t.Errorf("expected scylla primary and postgres secondary, got %q / %q", store.primaryName, store.secondaryName)
	}

	// ModeScyllaOnly
	scyllaOnly := NewDualWriteStore(ModeScyllaOnly, primary, secondary)
	if scyllaOnly.secondary != nil {
		t.Errorf("expected secondary to be nil in scylla_only mode")
	}
	if scyllaOnly.primaryName != "scylla" {
		t.Errorf("expected primary to be scylla, got %s", scyllaOnly.primaryName)
	}

	// ModePostgresOnly
	pgOnly := NewDualWriteStore(ModePostgresOnly, primary, secondary)
	if pgOnly.secondary != nil {
		t.Errorf("expected secondary to be nil in postgres_only mode")
	}
	if pgOnly.primaryName != "postgres" {
		t.Errorf("expected primary to be postgres, got %s", pgOnly.primaryName)
	}
}
