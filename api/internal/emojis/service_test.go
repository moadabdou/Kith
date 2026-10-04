package emojis

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"testing"

	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

// In-memory mock storage
type mockStorage struct {
	objects map[string][]byte
}

func newMockStorage() *mockStorage {
	return &mockStorage{objects: make(map[string][]byte)}
}

func (m *mockStorage) PutObject(_ context.Context, bucket, key string, reader io.Reader, _ int64, _ string) error {
	data, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	m.objects[bucket+"/"+key] = data
	return nil
}

func (m *mockStorage) GetObject(_ context.Context, bucket, key string) (io.ReadCloser, error) {
	data, ok := m.objects[bucket+"/"+key]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (m *mockStorage) RemoveObject(_ context.Context, bucket, key string) error {
	delete(m.objects, bucket+"/"+key)
	return nil
}

func (m *mockStorage) PublicURL(bucket, key string) string {
	return fmt.Sprintf("http://localhost/%s/%s", bucket, key)
}

// In-memory mock Store
type mockStore struct {
	emojis   map[int64]*Emoji
	stickers map[int64]*Sticker
	members  map[string]bool // "guildID:userID"
}

func newMockStore() *mockStore {
	return &mockStore{
		emojis:   make(map[int64]*Emoji),
		stickers: make(map[int64]*Sticker),
		members:  make(map[string]bool),
	}
}

func (m *mockStore) CreateEmoji(_ context.Context, e *Emoji) error {
	var id int64
	_, _ = fmt.Sscanf(e.ID, "%d", &id)
	e.URL = fmt.Sprintf("http://localhost/emojis/%s.png", e.ID)
	m.emojis[id] = e
	return nil
}

func (m *mockStore) GetEmoji(_ context.Context, id int64) (*Emoji, error) {
	if e, ok := m.emojis[id]; ok {
		return e, nil
	}
	return nil, ErrNotFound
}

func (m *mockStore) ListGuildEmojis(_ context.Context, guildID int64) ([]Emoji, error) {
	gidStr := fmt.Sprintf("%d", guildID)
	res := make([]Emoji, 0)
	for _, e := range m.emojis {
		if e.GuildID == gidStr {
			res = append(res, *e)
		}
	}
	return res, nil
}

func (m *mockStore) DeleteEmoji(_ context.Context, guildID, id int64) error {
	gidStr := fmt.Sprintf("%d", guildID)
	if e, ok := m.emojis[id]; ok && e.GuildID == gidStr {
		delete(m.emojis, id)
		return nil
	}
	return ErrNotFound
}

func (m *mockStore) CreateSticker(_ context.Context, s *Sticker) error {
	var id int64
	_, _ = fmt.Sscanf(s.ID, "%d", &id)
	s.URL = fmt.Sprintf("http://localhost/stickers/%s.png", s.ID)
	m.stickers[id] = s
	return nil
}

func (m *mockStore) GetSticker(_ context.Context, id int64) (*Sticker, error) {
	if s, ok := m.stickers[id]; ok {
		return s, nil
	}
	return nil, ErrNotFound
}

func (m *mockStore) ListGuildStickers(_ context.Context, guildID int64) ([]Sticker, error) {
	gidStr := fmt.Sprintf("%d", guildID)
	res := make([]Sticker, 0)
	for _, s := range m.stickers {
		if s.GuildID == gidStr {
			res = append(res, *s)
		}
	}
	return res, nil
}

func (m *mockStore) DeleteSticker(_ context.Context, guildID, id int64) error {
	gidStr := fmt.Sprintf("%d", guildID)
	if s, ok := m.stickers[id]; ok && s.GuildID == gidStr {
		delete(m.stickers, id)
		return nil
	}
	return ErrNotFound
}

func (m *mockStore) IsGuildMember(_ context.Context, guildID, userID int64) (bool, error) {
	key := fmt.Sprintf("%d:%d", guildID, userID)
	return m.members[key], nil
}

func (m *mockStore) GetBatchEmojis(_ context.Context, ids []int64) (map[int64]*Emoji, error) {
	res := make(map[int64]*Emoji)
	for _, id := range ids {
		if e, ok := m.emojis[id]; ok {
			res[id] = e
		}
	}
	return res, nil
}

func (m *mockStore) GetBatchStickers(_ context.Context, ids []int64) (map[int64]*Sticker, error) {
	res := make(map[int64]*Sticker)
	for _, id := range ids {
		if s, ok := m.stickers[id]; ok {
			res[id] = s
		}
	}
	return res, nil
}

type mockPublisher struct {
	events []events.Event
}

func (p *mockPublisher) Publish(_ context.Context, e events.Event) error {
	p.events = append(p.events, e)
	return nil
}

func samplePNG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	img.Set(0, 0, color.RGBA{R: 255, G: 0, B: 0, A: 255})
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func TestEmojis_NameValidation(t *testing.T) {
	cases := []struct {
		name  string
		valid bool
	}{
		{"a", false},                                // too short
		{"valid_emoji", true},                       // ok
		{"pepe123", true},                           // ok
		{"pepe-emoji", false},                        // invalid hyphen
		{"this_name_is_way_too_long_for_an_emoji_123456", false}, // > 32 chars
		{"emoji with space", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			match := validNameRegex.MatchString(tc.name)
			if match != tc.valid {
				t.Fatalf("name %q valid = %v, want %v", tc.name, match, tc.valid)
			}
		})
	}
}

func TestStickers_NameValidation(t *testing.T) {
	cases := []struct {
		name  string
		valid bool
	}{
		{"a", false},
		{"dancing cat", true},
		{"party_popper-1", true},
		{"cool-sticker", true},
		{"this_name_is_way_too_long_for_a_sticker_123456", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			match := validStickerNameRegex.MatchString(tc.name)
			if match != tc.valid {
				t.Fatalf("sticker name %q valid = %v, want %v", tc.name, match, tc.valid)
			}
		})
	}
}

func TestEmojis_CrossServerAccessValidation(t *testing.T) {
	store := newMockStore()
	node, _ := snowflake.NewNode(1)
	svc := &Service{
		store: store,
		sf:    node,
	}

	guildA := int64(1001)
	guildB := int64(2002)
	userA := int64(500)
	userB := int64(600)

	// User A is in Guild A only
	store.members[fmt.Sprintf("%d:%d", guildA, userA)] = true
	// User B is in Guild A and Guild B
	store.members[fmt.Sprintf("%d:%d", guildA, userB)] = true
	store.members[fmt.Sprintf("%d:%d", guildB, userB)] = true

	// Emoji belongs to Guild B
	emojiB := &Emoji{
		ID:         "9001",
		GuildID:    fmt.Sprintf("%d", guildB),
		Name:       "guild_b_pepe",
		UploaderID: "1",
	}
	_ = store.CreateEmoji(context.Background(), emojiB)

	// User B (in Guild B) uses emojiB in Guild A with external perms -> OK
	err := svc.ValidateEmojisAccess(context.Background(), userB, guildA, []int64{9001}, true)
	if err != nil {
		t.Fatalf("expected userB to be allowed to use external emoji, got: %v", err)
	}

	// User B lacks USE_EXTERNAL_EMOJIS in Guild A -> REJECTED
	err = svc.ValidateEmojisAccess(context.Background(), userB, guildA, []int64{9001}, false)
	if err == nil {
		t.Fatalf("expected error when user lacks external emoji permission")
	}

	// User A (NOT in Guild B) tries to use emojiB -> REJECTED (anti-spoofing)
	err = svc.ValidateEmojisAccess(context.Background(), userA, guildA, []int64{9001}, true)
	if err == nil {
		t.Fatalf("expected error when userA is not a member of emoji's home guild")
	}
}

func TestStickers_CrossServerAccessValidation(t *testing.T) {
	store := newMockStore()
	node, _ := snowflake.NewNode(1)
	svc := &Service{
		store: store,
		sf:    node,
	}

	guildA := int64(1001)
	guildB := int64(2002)
	userA := int64(500)
	userB := int64(600)

	store.members[fmt.Sprintf("%d:%d", guildA, userA)] = true
	store.members[fmt.Sprintf("%d:%d", guildA, userB)] = true
	store.members[fmt.Sprintf("%d:%d", guildB, userB)] = true

	stickerB := &Sticker{
		ID:         "8001",
		GuildID:    fmt.Sprintf("%d", guildB),
		Name:       "wave",
		UploaderID: "1",
	}
	_ = store.CreateSticker(context.Background(), stickerB)

	// User B uses sticker in Guild A with external perms -> OK
	err := svc.ValidateStickersAccess(context.Background(), userB, guildA, []int64{8001}, true)
	if err != nil {
		t.Fatalf("expected userB allowed, got: %v", err)
	}

	// User A (not in Guild B) tries to use sticker -> REJECTED
	err = svc.ValidateStickersAccess(context.Background(), userA, guildA, []int64{8001}, true)
	if err == nil {
		t.Fatalf("expected userA rejected for spoofing external sticker")
	}
}

func TestEmojis_PublishUpdates(t *testing.T) {
	store := newMockStore()
	pub := &mockPublisher{}
	svc := &Service{
		store: store,
		pub:   pub,
	}

	guildID := int64(12345)
	_ = store.CreateEmoji(context.Background(), &Emoji{
		ID:      "111",
		GuildID: fmt.Sprintf("%d", guildID),
		Name:    "emoji1",
	})

	svc.publishEmojisUpdate(context.Background(), guildID)

	if len(pub.events) != 1 {
		t.Fatalf("expected 1 event published, got %d", len(pub.events))
	}
	if pub.events[0].Type != EventTypeGuildEmojisUpdate {
		t.Fatalf("expected %s event, got %s", EventTypeGuildEmojisUpdate, pub.events[0].Type)
	}
	payload, ok := pub.events[0].Payload.(GuildEmojisUpdatePayload)
	if !ok || len(payload.Emojis) != 1 {
		t.Fatalf("expected payload with 1 emoji, got %+v", pub.events[0].Payload)
	}
}
