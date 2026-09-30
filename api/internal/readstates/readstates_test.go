package readstates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/events"
)

type mockPublisher struct {
	events []events.Event
}

func (m *mockPublisher) Publish(_ context.Context, e events.Event) error {
	m.events = append(m.events, e)
	return nil
}

func TestReadStateLifecycle(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	pub := &mockPublisher{}
	svc := NewService(nil, store, pub)

	userID := int64(1001)
	channelID := int64(2001)
	msgID := int64(3001)

	// 1. Initial get should return ErrNotFound
	_, err := svc.GetReadState(ctx, userID, channelID)
	if err != ErrNotFound {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	// 2. Ack message
	if err := svc.AckMessage(ctx, userID, channelID, msgID, true, 0); err != nil {
		t.Fatalf("AckMessage failed: %v", err)
	}

	// 3. Verify event emitted
	if len(pub.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(pub.events))
	}
	evt := pub.events[0]
	if evt.Type != "MESSAGE_ACK" {
		t.Errorf("expected type MESSAGE_ACK, got %s", evt.Type)
	}
	if evt.GuildID != "user_1001" {
		t.Errorf("expected GuildID user_1001, got %s", evt.GuildID)
	}
	payload, ok := evt.Payload.(MessageAckEvent)
	if !ok || payload.ChannelID != "2001" || payload.MessageID != "3001" {
		t.Errorf("unexpected payload: %+v", evt.Payload)
	}

	// 4. Verify get returns updated state
	rs, err := svc.GetReadState(ctx, userID, channelID)
	if err != nil {
		t.Fatalf("GetReadState failed: %v", err)
	}
	if rs.LastReadMessageID != msgID {
		t.Errorf("expected LastReadMessageID %d, got %d", msgID, rs.LastReadMessageID)
	}

	// 5. Verify ListReadStates
	states, err := svc.ListReadStates(ctx, userID)
	if err != nil {
		t.Fatalf("ListReadStates failed: %v", err)
	}
	if len(states) != 1 || states[0].ChannelID != channelID {
		t.Errorf("unexpected states: %+v", states)
	}
}

func TestReadStateHandler(t *testing.T) {
	store := NewMemoryStore()
	pub := &mockPublisher{}
	svc := NewService(nil, store, pub)
	h := NewHandler(svc)

	userID := int64(42)

	// Test Ack Endpoint
	req := httptest.NewRequest(http.MethodPost, "/api/channels/100/messages/500/ack", nil)
	req.SetPathValue("id", "100")
	req.SetPathValue("mid", "500")
	req = req.WithContext(auth.WithUserID(req.Context(), userID))

	rr := httptest.NewRecorder()
	h.Ack(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("expected 204 No Content, got %d", rr.Code)
	}

	// Test GetChannelReadState
	reqGet := httptest.NewRequest(http.MethodGet, "/api/channels/100/read-state", nil)
	reqGet.SetPathValue("id", "100")
	reqGet = reqGet.WithContext(auth.WithUserID(reqGet.Context(), userID))

	rrGet := httptest.NewRecorder()
	h.GetChannelReadState(rrGet, reqGet)

	if rrGet.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rrGet.Code)
	}
}
