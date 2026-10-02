package messages

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

type mockPublisher struct {
	mu     sync.Mutex
	events []events.Event
}

func (m *mockPublisher) Publish(ctx context.Context, e events.Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, e)
	return nil
}

func (m *mockPublisher) lastEvent() (events.Event, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.events) == 0 {
		return events.Event{}, false
	}
	return m.events[len(m.events)-1], true
}

func TestHandler_AddReaction_Success(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	mockStore := &mockHandlerStore{}
	memReactions := NewMemoryReactionsStore()

	svc := NewService(nil, mockStore, node, pub)
	svc.SetReactionsStore(memReactions)
	handler := NewHandler(svc, 10)

	channelID := int64(100)
	messageID := int64(200)
	userID := int64(300)
	emoji := "👍"

	req := httptest.NewRequest("PUT", "/api/channels/100/messages/200/reactions/"+url.PathEscape(emoji)+"/@me", nil)
	req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
	req.SetPathValue("mid", strconv.FormatInt(messageID, 10))
	req.SetPathValue("emoji", url.PathEscape(emoji))
	req = req.WithContext(auth.WithUserID(req.Context(), userID))

	w := httptest.NewRecorder()
	handler.AddReaction(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204 No Content, got %d: %s", w.Code, w.Body.String())
	}

	// Verify reaction in memory store
	tallies, err := memReactions.GetReactionsForMessages(context.Background(), channelID, []int64{messageID}, userID)
	if err != nil {
		t.Fatalf("unexpected error fetching reactions: %v", err)
	}
	midStr := strconv.FormatInt(messageID, 10)
	tList := tallies[midStr]
	if len(tList) != 1 || tList[0].Emoji != emoji || tList[0].Count != 1 || !tList[0].Me {
		t.Fatalf("unexpected tallies: %+v", tList)
	}

	// Verify NATS event published
	ev, ok := pub.lastEvent()
	if !ok {
		t.Fatalf("expected event to be published, got none")
	}
	if ev.Type != eventTypeMessageReactionAdd {
		t.Errorf("expected %s, got %s", eventTypeMessageReactionAdd, ev.Type)
	}
	rxEv, ok := ev.Payload.(MessageReactionEvent)
	if !ok {
		t.Fatalf("expected MessageReactionEvent payload, got %T", ev.Payload)
	}
	if rxEv.UserID != strconv.FormatInt(userID, 10) || rxEv.ChannelID != strconv.FormatInt(channelID, 10) ||
		rxEv.MessageID != strconv.FormatInt(messageID, 10) || rxEv.Emoji != emoji {
		t.Errorf("unexpected event payload: %+v", rxEv)
	}
}

func TestHandler_RemoveOwnReaction_Success(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	mockStore := &mockHandlerStore{}
	memReactions := NewMemoryReactionsStore()

	svc := NewService(nil, mockStore, node, pub)
	svc.SetReactionsStore(memReactions)
	handler := NewHandler(svc, 10)

	channelID := int64(100)
	messageID := int64(200)
	userID := int64(300)
	emoji := "🔥"

	// Pre-add reaction
	_ = memReactions.AddReaction(context.Background(), channelID, messageID, emoji, userID)

	req := httptest.NewRequest("DELETE", "/api/channels/100/messages/200/reactions/"+emoji+"/@me", nil)
	req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
	req.SetPathValue("mid", strconv.FormatInt(messageID, 10))
	req.SetPathValue("emoji", emoji)
	req = req.WithContext(auth.WithUserID(req.Context(), userID))

	w := httptest.NewRecorder()
	handler.RemoveOwnReaction(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204 No Content, got %d: %s", w.Code, w.Body.String())
	}

	// Verify removal from store
	tallies, _ := memReactions.GetReactionsForMessages(context.Background(), channelID, []int64{messageID}, userID)
	if len(tallies[strconv.FormatInt(messageID, 10)]) != 0 {
		t.Errorf("expected 0 tallies after delete, got %+v", tallies)
	}

	// Verify NATS event published
	ev, ok := pub.lastEvent()
	if !ok {
		t.Fatalf("expected event to be published, got none")
	}
	if ev.Type != eventTypeMessageReactionRemove {
		t.Errorf("expected %s, got %s", eventTypeMessageReactionRemove, ev.Type)
	}
}

func TestHandler_ListReactors_Success(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	mockStore := &mockHandlerStore{}
	memReactions := NewMemoryReactionsStore()

	svc := NewService(nil, mockStore, node, pub)
	svc.SetReactionsStore(memReactions)
	handler := NewHandler(svc, 10)

	channelID := int64(100)
	messageID := int64(200)
	callerID := int64(300)
	emoji := "🚀"

	_ = memReactions.AddReaction(context.Background(), channelID, messageID, emoji, 101)
	_ = memReactions.AddReaction(context.Background(), channelID, messageID, emoji, 102)

	req := httptest.NewRequest("GET", "/api/channels/100/messages/200/reactions/"+emoji+"?limit=10", nil)
	req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
	req.SetPathValue("mid", strconv.FormatInt(messageID, 10))
	req.SetPathValue("emoji", emoji)
	req = req.WithContext(auth.WithUserID(req.Context(), callerID))

	w := httptest.NewRecorder()
	handler.ListReactors(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", w.Code, w.Body.String())
	}

	var reactors []AuthorRef
	if err := json.NewDecoder(w.Body).Decode(&reactors); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if len(reactors) != 2 {
		t.Fatalf("expected 2 reactors, got %d", len(reactors))
	}
	if reactors[0].ID != "101" || reactors[1].ID != "102" {
		t.Errorf("expected [101, 102], got %+v", reactors)
	}
}

func TestHandler_TimelineHydration_IncludesReactions(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	channelID := int64(100)
	messageID := int64(200)
	callerID := int64(300)

	mockStore := &mockHandlerStore{
		messagesToReturn: []Message{
			{
				ID:        strconv.FormatInt(messageID, 10),
				ChannelID: strconv.FormatInt(channelID, 10),
				Author:    AuthorRef{ID: "500", Username: "Alice"},
				Content:   "Hello world with reactions!",
				CreatedAt: time.Now().UTC(),
			},
		},
	}
	memReactions := NewMemoryReactionsStore()
	_ = memReactions.AddReaction(context.Background(), channelID, messageID, "🎉", callerID)
	_ = memReactions.AddReaction(context.Background(), channelID, messageID, "🎉", 400)

	svc := NewService(nil, mockStore, node, pub)
	svc.SetReactionsStore(memReactions)
	handler := NewHandler(svc, 10)

	req := httptest.NewRequest("GET", "/api/channels/100/messages?limit=50", nil)
	req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
	req = req.WithContext(auth.WithUserID(req.Context(), callerID))

	w := httptest.NewRecorder()
	handler.List(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", w.Code, w.Body.String())
	}

	var msgs []Message
	if err := json.NewDecoder(w.Body).Decode(&msgs); err != nil {
		t.Fatalf("failed to decode messages: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if len(msgs[0].Reactions) != 1 {
		t.Fatalf("expected 1 reaction tally, got %d", len(msgs[0].Reactions))
	}
	rx := msgs[0].Reactions[0]
	if rx.Emoji != "🎉" || rx.Count != 2 || !rx.Me {
		t.Errorf("expected {🎉, count: 2, me: true}, got %+v", rx)
	}
}
