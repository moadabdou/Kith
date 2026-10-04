package messages

import (
	"context"
	"fmt"
	"testing"

	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

type mockEmojiValidator struct {
	guildMembers map[string]bool // "guildID:userID"
	emojiGuilds  map[int64]int64 // emojiID -> guildID
	stickerGuilds map[int64]int64 // stickerID -> guildID
}

func (m *mockEmojiValidator) ValidateEmojisAccess(ctx context.Context, userID, currentGuildID int64, emojiIDs []int64, hasExternalPerm bool) error {
	for _, eid := range emojiIDs {
		homeGuildID, ok := m.emojiGuilds[eid]
		if !ok {
			return ErrMissingAccess
		}
		if currentGuildID > 0 && homeGuildID == currentGuildID {
			continue
		}
		if !hasExternalPerm {
			return ErrMissingPermissions
		}
		key := fmt.Sprintf("%d:%d", homeGuildID, userID)
		if !m.guildMembers[key] {
			return ErrMissingPermissions
		}
	}
	return nil
}

func (m *mockEmojiValidator) ValidateStickersAccess(ctx context.Context, userID, currentGuildID int64, stickerIDs []int64, hasExternalPerm bool) error {
	for _, sid := range stickerIDs {
		homeGuildID, ok := m.stickerGuilds[sid]
		if !ok {
			return ErrMissingAccess
		}
		if currentGuildID > 0 && homeGuildID == currentGuildID {
			continue
		}
		if !hasExternalPerm {
			return ErrMissingPermissions
		}
		key := fmt.Sprintf("%d:%d", homeGuildID, userID)
		if !m.guildMembers[key] {
			return ErrMissingPermissions
		}
	}
	return nil
}

func TestMessages_CrossServerCustomEmojiValidation(t *testing.T) {
	node, _ := snowflake.NewNode(1)
	pub := &mockPublisher{}
	mockStore := &mockHandlerStore{}
	memReactions := NewMemoryReactionsStore()

	svc := NewService(nil, mockStore, node, pub)
	svc.SetReactionsStore(memReactions)

	validator := &mockEmojiValidator{
		guildMembers:  make(map[string]bool),
		emojiGuilds:   make(map[int64]int64),
		stickerGuilds: make(map[int64]int64),
	}
	svc.SetEmojiValidator(validator)

	channelID := int64(100)
	guildA := int64(1001)
	guildB := int64(2002)
	userA := int64(500) // member of guild A and B
	userB := int64(600) // member of guild A only

	validator.guildMembers[fmt.Sprintf("%d:%d", guildA, userA)] = true
	validator.guildMembers[fmt.Sprintf("%d:%d", guildB, userA)] = true
	validator.guildMembers[fmt.Sprintf("%d:%d", guildA, userB)] = true

	// Custom emoji 999 belongs to Guild B
	validator.emojiGuilds[999] = guildB
	// Custom sticker 888 belongs to Guild B
	validator.stickerGuilds[888] = guildB

	// 1. User A posts <:pepe:999> in channel of guild A (user A is member of B and has USE_EXTERNAL_EMOJIS by default)
	msg, err := svc.Send(context.Background(), userA, channelID, "Look at this <:pepe:999> emoji")
	if err != nil {
		t.Fatalf("expected user A to send message with external emoji, got: %v", err)
	}
	if msg == nil {
		t.Fatalf("expected message to be created")
	}

	// 2. User B (NOT in Guild B) tries to post <:pepe:999> in guild A -> REJECTED (anti-spoofing)
	_, err = svc.Send(context.Background(), userB, channelID, "Spoofing <:pepe:999>")
	if err == nil {
		t.Fatalf("expected user B to be rejected for spoofing emoji from guild they do not belong to")
	}

	// 3. User A reacts with pepe:999 on existing message -> SUCCESS
	messageID := int64(12345)
	err = svc.AddReaction(context.Background(), userA, channelID, messageID, "pepe:999")
	if err != nil {
		t.Fatalf("expected user A reaction to succeed, got: %v", err)
	}

	// 4. User B (NOT in Guild B) tries to react with pepe:999 -> REJECTED
	err = svc.AddReaction(context.Background(), userB, channelID, messageID, "pepe:999")
	if err == nil {
		t.Fatalf("expected user B reaction to fail for spoofed external emoji")
	}

	// 5. User A sends sticker from Guild B -> SUCCESS
	msg, err = svc.SendWithReference(context.Background(), userA, channelID, "", nil, nil, []string{"888"})
	if err != nil {
		t.Fatalf("expected user A to send sticker, got: %v", err)
	}
	if len(msg.StickerIDs) != 1 || msg.StickerIDs[0] != "888" {
		t.Fatalf("expected sticker_ids ['888'], got: %v", msg.StickerIDs)
	}

	// 6. User B sends sticker from Guild B -> REJECTED
	_, err = svc.SendWithReference(context.Background(), userB, channelID, "", nil, nil, []string{"888"})
	if err == nil {
		t.Fatalf("expected user B to be rejected for external sticker without guild membership")
	}
}
