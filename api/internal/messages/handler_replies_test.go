package messages

import (
	"bytes"
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

type mockReplyStore struct {
	messages map[int64]*Message
}

func newMockReplyStore() *mockReplyStore {
	return &mockReplyStore{
		messages: make(map[int64]*Message),
	}
}

func (m *mockReplyStore) Insert(ctx context.Context, msg *Message) error {
	id, _ := strconv.ParseInt(msg.ID, 10, 64)
	m.messages[id] = msg
	return nil
}

func (m *mockReplyStore) List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error) {
	var list []Message
	cidStr := strconv.FormatInt(channelID, 10)
	for _, msg := range m.messages {
		if msg.ChannelID == cidStr {
			list = append(list, *msg)
		}
	}
	return list, nil
}

func (m *mockReplyStore) ListAfter(ctx context.Context, channelID int64, after Cursor, limit int) ([]Message, error) {
	var list []Message
	cidStr := strconv.FormatInt(channelID, 10)
	for _, msg := range m.messages {
		if msg.ChannelID == cidStr {
			list = append(list, *msg)
		}
	}
	return list, nil
}

func (m *mockReplyStore) Edit(ctx context.Context, channelID, messageID int64, content string, mentions ResolvedMentions) (*Message, error) {
	if msg, ok := m.messages[messageID]; ok {
		msg.Content = content
		now := time.Now()
		msg.EditedAt = &now
		return msg, nil
	}
	return nil, ErrUnknownMessage
}

func (m *mockReplyStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	delete(m.messages, messageID)
	return nil
}

func (m *mockReplyStore) Get(ctx context.Context, channelID, messageID int64) (*Message, error) {
	if msg, ok := m.messages[messageID]; ok {
		return msg, nil
	}
	return nil, ErrUnknownMessage
}

func (m *mockReplyStore) Pin(ctx context.Context, channelID, messageID int64) error {
	if msg, ok := m.messages[messageID]; ok {
		msg.Pinned = true
		return nil
	}
	return ErrUnknownMessage
}

func (m *mockReplyStore) Unpin(ctx context.Context, channelID, messageID int64) error {
	if msg, ok := m.messages[messageID]; ok {
		msg.Pinned = false
	}
	return nil
}

func (m *mockReplyStore) ListPins(ctx context.Context, channelID int64) ([]Message, error) {
	var list []Message
	cidStr := strconv.FormatInt(channelID, 10)
	for _, msg := range m.messages {
		if msg.ChannelID == cidStr && msg.Pinned {
			list = append(list, *msg)
		}
	}
	return list, nil
}

func TestHandler_Send_Reply_Success(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	store := newMockReplyStore()

	channelID := int64(100)
	parentID := int64(200)
	parentIDStr := strconv.FormatInt(parentID, 10)

	// Pre-seed parent message in store
	parentMsg := &Message{
		ID:        parentIDStr,
		ChannelID: strconv.FormatInt(channelID, 10),
		Author:    AuthorRef{ID: "456", Username: "alice"},
		Content:   "Hello from the parent message!",
		CreatedAt: time.Now(),
	}
	store.messages[parentID] = parentMsg

	svc := NewService(nil, store, node, pub)
	handler := NewHandler(svc, 10)

	body := map[string]any{
		"content": "This is a reply to alice",
		"message_reference": map[string]string{
			"message_id": parentIDStr,
		},
	}
	bodyBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/guilds/1/channels/100/messages", bytes.NewReader(bodyBytes))
	req.SetPathValue("cid", strconv.FormatInt(channelID, 10))
	req = req.WithContext(auth.WithUserID(req.Context(), 789))

	w := httptest.NewRecorder()
	handler.Send(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d: %s", w.Code, w.Body.String())
	}

	var res Message
	if err := json.NewDecoder(w.Body).Decode(&res); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if res.Type != 19 {
		t.Errorf("expected type 19 (reply), got %d", res.Type)
	}
	if res.ReplyTo == nil || *res.ReplyTo != parentIDStr {
		t.Errorf("expected reply_to %s, got %v", parentIDStr, res.ReplyTo)
	}
	if res.ReferencedMsg == nil {
		t.Fatalf("expected referenced_message to be non-nil")
	}
	if res.ReferencedMsg.ID != parentIDStr {
		t.Errorf("expected referenced_message.id %s, got %s", parentIDStr, res.ReferencedMsg.ID)
	}
	if res.ReferencedMsg.Author.ID != "456" {
		t.Errorf("expected referenced_message.author.id 456, got %s", res.ReferencedMsg.Author.ID)
	}
	if res.ReferencedMsg.Content != parentMsg.Content {
		t.Errorf("expected referenced_message.content %q, got %q", parentMsg.Content, res.ReferencedMsg.Content)
	}

	// Verify published NATS event
	ev, ok := pub.lastEvent()
	if !ok {
		t.Fatalf("expected event to be published")
	}
	if ev.Type != eventTypeMessageCreate {
		t.Errorf("expected event type %s, got %s", eventTypeMessageCreate, ev.Type)
	}
	evMsg, ok := ev.Payload.(*Message)
	if !ok || evMsg.Type != 19 || evMsg.ReplyTo == nil || *evMsg.ReplyTo != parentIDStr {
		t.Errorf("unexpected event payload: %+v", ev.Payload)
	}
	if evMsg.ReferencedMsg == nil || evMsg.ReferencedMsg.ID != parentIDStr {
		t.Errorf("expected event payload referenced_message to be hydrated: %+v", evMsg.ReferencedMsg)
	}
}

func TestHandler_Send_Reply_ParentNotFound(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	store := newMockReplyStore()

	svc := NewService(nil, store, node, pub)
	handler := NewHandler(svc, 10)

	body := map[string]any{
		"content": "Replying to a ghost",
		"message_reference": map[string]string{
			"message_id": "9999999",
		},
	}
	bodyBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/guilds/1/channels/100/messages", bytes.NewReader(bodyBytes))
	req.SetPathValue("cid", "100")
	req = req.WithContext(auth.WithUserID(req.Context(), 789))

	w := httptest.NewRecorder()
	handler.Send(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandler_Send_Reply_CrossChannelRejection(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	store := newMockReplyStore()

	parentID := int64(200)
	// Parent message belongs to channel 101, not 100
	store.messages[parentID] = &Message{
		ID:        strconv.FormatInt(parentID, 10),
		ChannelID: "101",
		Author:    AuthorRef{ID: "456"},
		Content:   "Wrong channel message",
		CreatedAt: time.Now(),
	}

	svc := NewService(nil, store, node, pub)
	handler := NewHandler(svc, 10)

	body := map[string]any{
		"content": "Trying cross-channel reply",
		"message_reference": map[string]string{
			"message_id": strconv.FormatInt(parentID, 10),
		},
	}
	bodyBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/guilds/1/channels/100/messages", bytes.NewReader(bodyBytes))
	req.SetPathValue("cid", "100")
	req = req.WithContext(auth.WithUserID(req.Context(), 789))

	w := httptest.NewRecorder()
	handler.Send(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandler_Send_Reply_InvalidReferenceFormat(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	store := newMockReplyStore()

	svc := NewService(nil, store, node, pub)
	handler := NewHandler(svc, 10)

	body := map[string]any{
		"content": "Bad format",
		"message_reference": map[string]string{
			"message_id": "not-a-number",
		},
	}
	bodyBytes, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/guilds/1/channels/100/messages", bytes.NewReader(bodyBytes))
	req.SetPathValue("cid", "100")
	req = req.WithContext(auth.WithUserID(req.Context(), 789))

	w := httptest.NewRecorder()
	handler.Send(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d: %s", w.Code, w.Body.String())
	}
}

func TestHandler_List_ReplyHydrationAndTombstone(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	store := newMockReplyStore()

	channelID := int64(100)
	cidStr := strconv.FormatInt(channelID, 10)

	// Parent message exists
	parentID := int64(1001)
	parentIDStr := strconv.FormatInt(parentID, 10)
	store.messages[parentID] = &Message{
		ID:        parentIDStr,
		ChannelID: cidStr,
		Author:    AuthorRef{ID: "501", Username: "parent_user"},
		Content:   "Active parent content",
		CreatedAt: time.Now().Add(-2 * time.Minute),
	}

	// Reply 1: points to existing parent 1001
	reply1ID := int64(1002)
	reply1IDStr := strconv.FormatInt(reply1ID, 10)
	store.messages[reply1ID] = &Message{
		ID:        reply1IDStr,
		ChannelID: cidStr,
		Author:    AuthorRef{ID: "502", Username: "replier_1"},
		Content:   "Reply 1 content",
		Type:      19,
		ReplyTo:   &parentIDStr,
		CreatedAt: time.Now().Add(-1 * time.Minute),
	}

	// Reply 2: points to deleted parent 9999 (tombstone)
	deletedParentIDStr := "9999"
	reply2ID := int64(1003)
	reply2IDStr := strconv.FormatInt(reply2ID, 10)
	store.messages[reply2ID] = &Message{
		ID:        reply2IDStr,
		ChannelID: cidStr,
		Author:    AuthorRef{ID: "503", Username: "replier_2"},
		Content:   "Reply 2 content (orphaned)",
		Type:      19,
		ReplyTo:   &deletedParentIDStr,
		CreatedAt: time.Now(),
	}

	svc := NewService(nil, store, node, pub)
	handler := NewHandler(svc, 10)

	req := httptest.NewRequest(http.MethodGet, "/api/guilds/1/channels/100/messages", nil)
	req.SetPathValue("cid", cidStr)
	req = req.WithContext(auth.WithUserID(req.Context(), 501))

	w := httptest.NewRecorder()
	handler.List(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d: %s", w.Code, w.Body.String())
	}

	var msgs []Message
	if err := json.NewDecoder(w.Body).Decode(&msgs); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	var foundReply1, foundReply2 bool
	for _, m := range msgs {
		if m.ID == reply1IDStr {
			foundReply1 = true
			if m.ReferencedMsg == nil {
				t.Errorf("expected reply1 to have hydrated referenced_message")
			} else {
				if m.ReferencedMsg.ID != parentIDStr {
					t.Errorf("expected referenced_message.id %s, got %s", parentIDStr, m.ReferencedMsg.ID)
				}
				if m.ReferencedMsg.Content != "Active parent content" {
					t.Errorf("expected referenced_message.content %q, got %q", "Active parent content", m.ReferencedMsg.Content)
				}
			}
		}
		if m.ID == reply2IDStr {
			foundReply2 = true
			if m.ReplyTo == nil || *m.ReplyTo != deletedParentIDStr {
				t.Errorf("expected reply2 reply_to to be %s, got %v", deletedParentIDStr, m.ReplyTo)
			}
			if m.ReferencedMsg != nil {
				t.Errorf("expected reply2 to have nil referenced_message (tombstone), got %+v", m.ReferencedMsg)
			}
		}
	}

	if !foundReply1 || !foundReply2 {
		t.Errorf("expected to find both replies in list response")
	}
}

func TestService_Get_ReplyHydration(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	store := newMockReplyStore()

	channelID := int64(100)
	cidStr := strconv.FormatInt(channelID, 10)

	parentID := int64(2001)
	parentIDStr := strconv.FormatInt(parentID, 10)
	store.messages[parentID] = &Message{
		ID:        parentIDStr,
		ChannelID: cidStr,
		Author:    AuthorRef{ID: "501", Username: "parent_user"},
		Content:   "Get parent test",
		CreatedAt: time.Now(),
	}

	replyID := int64(2002)
	replyIDStr := strconv.FormatInt(replyID, 10)
	store.messages[replyID] = &Message{
		ID:        replyIDStr,
		ChannelID: cidStr,
		Author:    AuthorRef{ID: "502", Username: "replier"},
		Content:   "Get reply test",
		Type:      19,
		ReplyTo:   &parentIDStr,
		CreatedAt: time.Now(),
	}

	svc := NewService(nil, store, node, pub)
	msg, err := svc.Get(context.Background(), 501, channelID, replyID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if msg.Type != 19 {
		t.Errorf("expected type 19, got %d", msg.Type)
	}
	if msg.ReferencedMsg == nil || msg.ReferencedMsg.ID != parentIDStr {
		t.Fatalf("expected referenced_message to be hydrated: %+v", msg.ReferencedMsg)
	}
	if msg.ReferencedMsg.Content != "Get parent test" {
		t.Errorf("expected referenced_message content 'Get parent test', got %q", msg.ReferencedMsg.Content)
	}
}
