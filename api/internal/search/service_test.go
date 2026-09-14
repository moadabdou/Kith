package search

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/moadabdou/Kith/api/internal/messages"
)

type mockSearchClient struct {
	lastQuery   SearchQuery
	searchRes   *SearchResult
	searchErr   error
	docs        map[string]MessageDocument
	indexedDocs []MessageDocument
	deletedIDs  []string
}

func newMockSearchClient() *mockSearchClient {
	return &mockSearchClient{
		docs:        make(map[string]MessageDocument),
		indexedDocs: make([]MessageDocument, 0),
		deletedIDs:  make([]string, 0),
	}
}

func (m *mockSearchClient) Search(ctx context.Context, index string, q SearchQuery) (*SearchResult, error) {
	m.lastQuery = q
	if m.searchErr != nil {
		return nil, m.searchErr
	}
	if m.searchRes != nil {
		return m.searchRes, nil
	}
	return &SearchResult{
		Hits:               []SearchHit{},
		EstimatedTotalHits: 0,
	}, nil
}

func (m *mockSearchClient) GetDocument(ctx context.Context, index, id string) (*MessageDocument, error) {
	doc, ok := m.docs[id]
	if !ok {
		return nil, ErrDocumentNotFound
	}
	return &doc, nil
}

func (m *mockSearchClient) IndexDocuments(ctx context.Context, index string, docs []MessageDocument) error {
	for _, d := range docs {
		m.docs[d.ID] = d
		m.indexedDocs = append(m.indexedDocs, d)
	}
	return nil
}

func (m *mockSearchClient) DeleteDocuments(ctx context.Context, index string, ids []string) error {
	for _, id := range ids {
		delete(m.docs, id)
		m.deletedIDs = append(m.deletedIDs, id)
	}
	return nil
}

type mockMessageStore struct {
	messages map[string]*messages.Message
}

func newMockMessageStore() *mockMessageStore {
	return &mockMessageStore{
		messages: make(map[string]*messages.Message),
	}
}

func (m *mockMessageStore) Insert(ctx context.Context, msg *messages.Message) error {
	m.messages[fmt.Sprintf("%s:%s", msg.ChannelID, msg.ID)] = msg
	return nil
}

func (m *mockMessageStore) List(ctx context.Context, channelID int64, before messages.Cursor, limit int) ([]messages.Message, error) {
	return nil, nil
}

func (m *mockMessageStore) Edit(ctx context.Context, channelID, messageID int64, content string) (*messages.Message, error) {
	return nil, nil
}

func (m *mockMessageStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	delete(m.messages, fmt.Sprintf("%d:%d", channelID, messageID))
	return nil
}

func (m *mockMessageStore) Get(ctx context.Context, channelID, messageID int64) (*messages.Message, error) {
	msg, ok := m.messages[fmt.Sprintf("%d:%d", channelID, messageID)]
	if !ok {
		return nil, messages.ErrUnknownMessage
	}
	return msg, nil
}

func TestSearchParamsValidation(t *testing.T) {
	svc := NewService(nil)

	// Empty query returns ErrQueryRequired
	_, err := svc.SearchGuildMessages(context.Background(), 1, 1, SearchParams{Query: ""})
	if err != ErrQueryRequired {
		t.Fatalf("expected ErrQueryRequired, got %v", err)
	}

	_, err = svc.SearchGuildMessages(context.Background(), 1, 1, SearchParams{Query: "   "})
	if err != ErrQueryRequired {
		t.Fatalf("expected ErrQueryRequired for whitespace query, got %v", err)
	}
}

func TestSearch_MeilisearchFilterAndHydration(t *testing.T) {
	mockClient := newMockSearchClient()
	mockStore := newMockMessageStore()

	// Seed message in store
	mockStore.messages["200:1001"] = &messages.Message{
		ID:        "1001",
		ChannelID: "200",
		Content:   "hydrated content",
		Author: messages.AuthorRef{
			ID:       "50",
			Username: "alice",
		},
		CreatedAt: time.Now(),
	}

	// Mock Meilisearch returning hit for 1001
	mockClient.searchRes = &SearchResult{
		Hits: []SearchHit{
			{ID: "1001", ChannelID: "200"},
		},
		EstimatedTotalHits: 1,
	}

	svc := NewService(nil, WithSearchClient(mockClient), WithMessageStore(mockStore))

	res, err := svc.SearchGuildMessages(context.Background(), 1, 999, SearchParams{
		Query:     "hydrated",
		ChannelID: 200,
		AuthorID:  50,
		Limit:     10,
	})
	if err != nil {
		t.Fatalf("SearchGuildMessages failed: %v", err)
	}

	// Verify filter generated
	expectedFilter := "guild_id = '999' AND channel_id = '200' AND author_id = '50'"
	if mockClient.lastQuery.Filter != expectedFilter {
		t.Errorf("expected filter %q, got %q", expectedFilter, mockClient.lastQuery.Filter)
	}

	// Verify message was hydrated from store
	if res.TotalResults != 1 || len(res.Messages) != 1 {
		t.Fatalf("expected 1 result, got %d", len(res.Messages))
	}
	if res.Messages[0].ID != "1001" || res.Messages[0].Author.Username != "alice" {
		t.Errorf("unexpected hydrated message: %+v", res.Messages[0])
	}
}

func TestReconciler_DetectAndRepair(t *testing.T) {
	mockClient := newMockSearchClient()
	mockStore := newMockMessageStore()

	reconciler := NewReconciler(ReconcilerConfig{
		IndexName:  "messages",
		SampleSize: 10,
		AutoRepair: true,
	}, nil, mockStore, mockClient)

	// Inject a missing document scenario
	report := &ReconciliationReport{}
	msg := SampleMessage{
		ID:        777,
		ChannelID: 888,
		GuildID:   999,
		AuthorID:  111,
		Content:   "missing in meili",
		CreatedAt: time.Now(),
	}

	// Document is missing in mockClient.docs
	doc, err := mockClient.GetDocument(context.Background(), "messages", "777")
	if err != ErrDocumentNotFound {
		t.Fatalf("expected ErrDocumentNotFound, got %v", doc)
	}

	// Repair missing document
	if reconciler.cfg.AutoRepair {
		err := mockClient.IndexDocuments(context.Background(), "messages", []MessageDocument{
			{
				ID:        "777",
				GuildID:   "999",
				ChannelID: "888",
				AuthorID:  "111",
				Content:   msg.Content,
				Timestamp: msg.CreatedAt.Unix(),
			},
		})
		if err != nil {
			t.Fatalf("failed to repair: %v", err)
		}
		report.MissingFixed++
	}

	if report.MissingFixed != 1 {
		t.Errorf("expected 1 missing fixed, got %d", report.MissingFixed)
	}

	// Now document should exist in mockClient
	doc, err = mockClient.GetDocument(context.Background(), "messages", "777")
	if err != nil || doc.Content != "missing in meili" {
		t.Fatalf("expected restored document, got %v", doc)
	}
}

func TestSearch_ReadRepairGhostEviction(t *testing.T) {
	mockClient := newMockSearchClient()
	mockStore := newMockMessageStore()

	// Seed one valid message and leave one ghost message missing in store
	mockStore.messages["200:1001"] = &messages.Message{
		ID:        "1001",
		ChannelID: "200",
		Content:   "valid message",
		Author: messages.AuthorRef{
			ID:       "50",
			Username: "alice",
		},
		CreatedAt: time.Now(),
	}

	// Meilisearch returns two hits: 1001 (exists in store) and 1002 (ghost/deleted from store)
	mockClient.searchRes = &SearchResult{
		Hits: []SearchHit{
			{ID: "1001", ChannelID: "200"},
			{ID: "1002", ChannelID: "200"},
		},
		EstimatedTotalHits: 2,
	}

	svc := NewService(nil, WithSearchClient(mockClient), WithMessageStore(mockStore))

	res, err := svc.SearchGuildMessages(context.Background(), 1, 999, SearchParams{
		Query: "hello",
	})
	if err != nil {
		t.Fatalf("SearchGuildMessages failed: %v", err)
	}

	// Verify that ghost document 1002 was filtered out from response
	if len(res.Messages) != 1 {
		t.Fatalf("expected 1 hydrated message, got %d", len(res.Messages))
	}
	if res.Messages[0].ID != "1001" {
		t.Errorf("expected message 1001, got %s", res.Messages[0].ID)
	}

	// Wait briefly for the asynchronous read-repair eviction goroutine to execute
	deadline := time.Now().Add(500 * time.Millisecond)
	evicted := false
	for time.Now().Before(deadline) {
		for _, id := range mockClient.deletedIDs {
			if id == "1002" {
				evicted = true
				break
			}
		}
		if evicted {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if !evicted {
		t.Errorf("expected ghost document 1002 to be asynchronously evicted via DeleteDocuments, deletedIDs=%v", mockClient.deletedIDs)
	}
}

