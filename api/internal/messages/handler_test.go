package messages

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/moadabdou/Kith/api/internal/auth"
)

type mockHandlerStore struct {
	lastListChannelID int64
	lastBefore        Cursor
	lastLimit         int

	lastAfterChannelID int64
	lastAfter          Cursor
	lastAfterLimit     int

	messagesToReturn []Message
}

func (m *mockHandlerStore) Insert(ctx context.Context, msg *Message) error {
	return nil
}

func (m *mockHandlerStore) List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error) {
	m.lastListChannelID = channelID
	m.lastBefore = before
	m.lastLimit = limit
	return m.messagesToReturn, nil
}

func (m *mockHandlerStore) ListAfter(ctx context.Context, channelID int64, after Cursor, limit int) ([]Message, error) {
	m.lastAfterChannelID = channelID
	m.lastAfter = after
	m.lastAfterLimit = limit
	return m.messagesToReturn, nil
}

func (m *mockHandlerStore) Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error) {
	return nil, nil
}

func (m *mockHandlerStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	return nil
}

func (m *mockHandlerStore) Get(ctx context.Context, channelID, messageID int64) (*Message, error) {
	return nil, nil
}

func TestHandler_List_BeforeAndAfterRouting(t *testing.T) {
	mockStore := &mockHandlerStore{
		messagesToReturn: []Message{
			{
				ID:        "999",
				ChannelID: "123",
				Author:    AuthorRef{ID: "456"},
				Content:   "test message",
				CreatedAt: time.Now(),
			},
		},
	}

	svc := NewService(nil, mockStore, nil, nil)
	handler := &Handler{Svc: svc}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/guilds/{id}/channels/{cid}/messages", handler.List)

	// 1. Test ?before= query routing
	reqBefore := httptest.NewRequest(http.MethodGet, "/api/guilds/1/channels/123/messages?before=5000&limit=25", nil)
	reqBefore = reqBefore.WithContext(auth.ContextWithUserID(reqBefore.Context(), 456))
	recBefore := httptest.NewRecorder()
	mux.ServeHTTP(recBefore, reqBefore)

	if recBefore.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for before query, got %d: %s", recBefore.Code, recBefore.Body.String())
	}
	if mockStore.lastListChannelID != 123 {
		t.Errorf("expected channelID 123, got %d", mockStore.lastListChannelID)
	}
	if mockStore.lastBefore.MessageID != 5000 {
		t.Errorf("expected before.MessageID 5000, got %d", mockStore.lastBefore.MessageID)
	}
	if mockStore.lastLimit != 25 {
		t.Errorf("expected limit 25, got %d", mockStore.lastLimit)
	}

	var resBefore []Message
	if err := json.NewDecoder(recBefore.Body).Decode(&resBefore); err != nil {
		t.Fatalf("decode before response: %v", err)
	}
	if len(resBefore) != 1 || resBefore[0].ID != "999" {
		t.Errorf("unexpected before response payload: %+v", resBefore)
	}

	// 2. Test ?after= query routing
	reqAfter := httptest.NewRequest(http.MethodGet, "/api/guilds/1/channels/123/messages?after=7000&limit=30", nil)
	reqAfter = reqAfter.WithContext(auth.ContextWithUserID(reqAfter.Context(), 456))
	recAfter := httptest.NewRecorder()
	mux.ServeHTTP(recAfter, reqAfter)

	if recAfter.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for after query, got %d: %s", recAfter.Code, recAfter.Body.String())
	}
	if mockStore.lastAfterChannelID != 123 {
		t.Errorf("expected channelID 123, got %d", mockStore.lastAfterChannelID)
	}
	if mockStore.lastAfter.MessageID != 7000 {
		t.Errorf("expected after.MessageID 7000, got %d", mockStore.lastAfter.MessageID)
	}
	if mockStore.lastAfterLimit != 30 {
		t.Errorf("expected afterLimit 30, got %d", mockStore.lastAfterLimit)
	}

	// 3. Test invalid cursor format returns 400 Bad Request
	reqInvalid := httptest.NewRequest(http.MethodGet, "/api/guilds/1/channels/123/messages?after=not-a-number", nil)
	reqInvalid = reqInvalid.WithContext(auth.ContextWithUserID(reqInvalid.Context(), 456))
	recInvalid := httptest.NewRecorder()
	mux.ServeHTTP(recInvalid, reqInvalid)

	if recInvalid.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request for invalid cursor, got %d", recInvalid.Code)
	}

	_ = strconv.Itoa(0)
}
