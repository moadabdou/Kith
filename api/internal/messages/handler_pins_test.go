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
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

type mockPinStore struct {
	messages map[int64]*Message
	pins     map[int64]bool
	pinErr   error
}

func newMockPinStore() *mockPinStore {
	return &mockPinStore{
		messages: make(map[int64]*Message),
		pins:     make(map[int64]bool),
	}
}

func (m *mockPinStore) Insert(ctx context.Context, msg *Message) error { return nil }
func (m *mockPinStore) List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error) {
	return nil, nil
}
func (m *mockPinStore) ListAfter(ctx context.Context, channelID int64, after Cursor, limit int) ([]Message, error) {
	return nil, nil
}
func (m *mockPinStore) Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error) {
	return nil, nil
}
func (m *mockPinStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	delete(m.messages, messageID)
	delete(m.pins, messageID)
	return nil
}
func (m *mockPinStore) Get(ctx context.Context, channelID, messageID int64) (*Message, error) {
	if msg, ok := m.messages[messageID]; ok {
		cp := *msg
		cp.Pinned = m.pins[messageID]
		return &cp, nil
	}
	return nil, ErrUnknownMessage
}
func (m *mockPinStore) Pin(ctx context.Context, channelID, messageID int64) error {
	if m.pinErr != nil {
		return m.pinErr
	}
	if _, ok := m.messages[messageID]; !ok {
		return ErrUnknownMessage
	}
	if len(m.pins) >= 50 && !m.pins[messageID] {
		return ErrMaxPinsReached
	}
	m.pins[messageID] = true
	return nil
}
func (m *mockPinStore) Unpin(ctx context.Context, channelID, messageID int64) error {
	delete(m.pins, messageID)
	return nil
}
func (m *mockPinStore) ListPins(ctx context.Context, channelID int64) ([]Message, error) {
	var res []Message
	for mid, isPinned := range m.pins {
		if isPinned {
			if msg, ok := m.messages[mid]; ok {
				cp := *msg
				cp.Pinned = true
				res = append(res, cp)
			}
		}
	}
	return res, nil
}

func TestHandler_Pins_CRUD(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	store := newMockPinStore()

	channelID := int64(100)
	messageID := int64(200)
	store.messages[messageID] = &Message{
		ID:        strconv.FormatInt(messageID, 10),
		ChannelID: strconv.FormatInt(channelID, 10),
		Author:    AuthorRef{ID: "50", Username: "bob"},
		Content:   "A very important pinned message",
		CreatedAt: time.Now(),
	}

	svc := NewService(nil, store, node, pub)
	handler := NewHandler(svc, 10)

	// 1. Pin the message
	{
		req := httptest.NewRequest(http.MethodPut, "/api/channels/100/pins/200", nil)
		req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
		req.SetPathValue("mid", strconv.FormatInt(messageID, 10))
		req = req.WithContext(auth.WithUserID(req.Context(), 50))

		w := httptest.NewRecorder()
		handler.Pin(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("expected 204 No Content for Pin, got %d: %s", w.Code, w.Body.String())
		}

		if len(pub.events) == 0 {
			t.Fatalf("expected CHANNEL_PINS_UPDATE event published")
		}
		lastEv := pub.events[len(pub.events)-1]
		if lastEv.Type != eventTypeChannelPinsUpdate {
			t.Errorf("expected event type %s, got %s", eventTypeChannelPinsUpdate, lastEv.Type)
		}
		payload, ok := lastEv.Payload.(ChannelPinsUpdatePayload)
		if !ok || payload.ChannelID != strconv.FormatInt(channelID, 10) {
			t.Errorf("expected ChannelPinsUpdatePayload for channel %d, got %+v", channelID, lastEv.Payload)
		}
	}

	// 2. List pins
	{
		req := httptest.NewRequest(http.MethodGet, "/api/channels/100/pins", nil)
		req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
		req = req.WithContext(auth.WithUserID(req.Context(), 50))

		w := httptest.NewRecorder()
		handler.ListPins(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected 200 OK for ListPins, got %d: %s", w.Code, w.Body.String())
		}

		var pins []Message
		if err := json.NewDecoder(w.Body).Decode(&pins); err != nil {
			t.Fatalf("failed to decode pins response: %v", err)
		}
		if len(pins) != 1 {
			t.Fatalf("expected 1 pin, got %d", len(pins))
		}
		if pins[0].ID != strconv.FormatInt(messageID, 10) || !pins[0].Pinned {
			t.Errorf("expected message %d with pinned=true, got %+v", messageID, pins[0])
		}
	}

	// 3. Max pins limit
	{
		store.pinErr = ErrMaxPinsReached
		req := httptest.NewRequest(http.MethodPut, "/api/channels/100/pins/200", nil)
		req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
		req.SetPathValue("mid", strconv.FormatInt(messageID, 10))
		req = req.WithContext(auth.WithUserID(req.Context(), 50))

		w := httptest.NewRecorder()
		handler.Pin(w, req)

		if w.Code != http.StatusBadRequest {
			t.Errorf("expected 400 Bad Request on max pins, got %d: %s", w.Code, w.Body.String())
		}
		store.pinErr = nil
	}

	// 4. Unpin the message
	{
		req := httptest.NewRequest(http.MethodDelete, "/api/channels/100/pins/200", nil)
		req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
		req.SetPathValue("mid", strconv.FormatInt(messageID, 10))
		req = req.WithContext(auth.WithUserID(req.Context(), 50))

		w := httptest.NewRecorder()
		handler.Unpin(w, req)

		if w.Code != http.StatusNoContent {
			t.Fatalf("expected 204 No Content for Unpin, got %d: %s", w.Code, w.Body.String())
		}

		lastEv := pub.events[len(pub.events)-1]
		if lastEv.Type != eventTypeChannelPinsUpdate {
			t.Errorf("expected event type %s on unpin, got %s", eventTypeChannelPinsUpdate, lastEv.Type)
		}
	}
}
