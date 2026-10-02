package messages_test

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/moadabdou/Kith/api/internal/messages"
)

func TestMemoryReactionsStore_Validation(t *testing.T) {
	store := messages.NewMemoryReactionsStore()
	ctx := context.Background()

	if err := store.AddReaction(ctx, 1, 1, "", 10); err == nil {
		t.Errorf("expected error on empty emoji, got nil")
	}
	if err := store.AddReaction(ctx, 0, 1, "👍", 10); err == nil {
		t.Errorf("expected error on channelID <= 0, got nil")
	}
	if err := store.AddReaction(ctx, 1, 0, "👍", 10); err == nil {
		t.Errorf("expected error on messageID <= 0, got nil")
	}
	if err := store.AddReaction(ctx, 1, 1, "👍", 0); err == nil {
		t.Errorf("expected error on userID <= 0, got nil")
	}

	if err := store.RemoveReaction(ctx, 1, 1, "", 10); err == nil {
		t.Errorf("expected error on empty emoji, got nil")
	}
	if _, err := store.ListReactors(ctx, 1, 1, "", 50, 0); err == nil {
		t.Errorf("expected error on empty emoji, got nil")
	}
}

func TestMemoryReactionsStore_IdempotencyAndCounters(t *testing.T) {
	store := messages.NewMemoryReactionsStore()
	ctx := context.Background()

	channelID := int64(1001)
	messageID := int64(2001)
	userA := int64(501)
	userB := int64(502)

	// User A reacts with "👍"
	if err := store.AddReaction(ctx, channelID, messageID, "👍", userA); err != nil {
		t.Fatalf("unexpected add reaction error: %v", err)
	}

	// User A reacts again with "👍" (idempotency check)
	if err := store.AddReaction(ctx, channelID, messageID, "👍", userA); err != nil {
		t.Fatalf("unexpected add reaction repeat error: %v", err)
	}

	// Fetch reactions for User A
	resA, err := store.GetReactionsForMessages(ctx, channelID, []int64{messageID}, userA)
	if err != nil {
		t.Fatalf("unexpected get error: %v", err)
	}
	talliesA := resA[strconv.FormatInt(messageID, 10)]
	if len(talliesA) != 1 {
		t.Fatalf("expected 1 tally, got %d", len(talliesA))
	}
	if talliesA[0].Emoji != "👍" || talliesA[0].Count != 1 || !talliesA[0].Me {
		t.Errorf("expected {👍, count: 1, me: true}, got %+v", talliesA[0])
	}

	// User B also reacts with "👍"
	if err := store.AddReaction(ctx, channelID, messageID, "👍", userB); err != nil {
		t.Fatalf("unexpected add userB reaction error: %v", err)
	}

	// User B reacts with "🔥"
	if err := store.AddReaction(ctx, channelID, messageID, "🔥", userB); err != nil {
		t.Fatalf("unexpected add userB fire error: %v", err)
	}

	// Fetch reactions for User A
	resA, err = store.GetReactionsForMessages(ctx, channelID, []int64{messageID}, userA)
	if err != nil {
		t.Fatalf("unexpected get error: %v", err)
	}
	talliesA = resA[strconv.FormatInt(messageID, 10)]
	if len(talliesA) != 2 {
		t.Fatalf("expected 2 tallies, got %d", len(talliesA))
	}

	// Emojis are sorted alphabetically: "👍", "🔥"
	// Check 👍: count 2, me: true (for userA)
	// Check 🔥: count 1, me: false (for userA)
	var thumb, fire *messages.ReactionTally
	for i := range talliesA {
		if talliesA[i].Emoji == "👍" {
			thumb = &talliesA[i]
		} else if talliesA[i].Emoji == "🔥" {
			fire = &talliesA[i]
		}
	}
	if thumb == nil || thumb.Count != 2 || !thumb.Me {
		t.Errorf("unexpected thumb tally: %+v", thumb)
	}
	if fire == nil || fire.Count != 1 || fire.Me {
		t.Errorf("unexpected fire tally: %+v", fire)
	}

	// User A removes reaction
	if err := store.RemoveReaction(ctx, channelID, messageID, "👍", userA); err != nil {
		t.Fatalf("unexpected remove error: %v", err)
	}

	resA, err = store.GetReactionsForMessages(ctx, channelID, []int64{messageID}, userA)
	if err != nil {
		t.Fatalf("unexpected get error: %v", err)
	}
	talliesA = resA[strconv.FormatInt(messageID, 10)]
	for _, tal := range talliesA {
		if tal.Emoji == "👍" {
			if tal.Count != 1 || tal.Me {
				t.Errorf("expected thumb count 1, me: false, got %+v", tal)
			}
		}
	}

	// User B removes "🔥" -> tally should be completely purged
	if err := store.RemoveReaction(ctx, channelID, messageID, "🔥", userB); err != nil {
		t.Fatalf("unexpected remove error: %v", err)
	}
	resA, err = store.GetReactionsForMessages(ctx, channelID, []int64{messageID}, userA)
	if err != nil {
		t.Fatalf("unexpected get error: %v", err)
	}
	talliesA = resA[strconv.FormatInt(messageID, 10)]
	if len(talliesA) != 1 || talliesA[0].Emoji != "👍" {
		t.Errorf("expected only thumb remaining, got %+v", talliesA)
	}
}

func TestMemoryReactionsStore_ListReactors(t *testing.T) {
	store := messages.NewMemoryReactionsStore()
	ctx := context.Background()

	channelID := int64(10)
	messageID := int64(20)
	emoji := "🚀"

	uids := []int64{101, 102, 103, 104, 105}
	for _, u := range uids {
		_ = store.AddReaction(ctx, channelID, messageID, emoji, u)
	}

	// Page 1: limit 2
	p1, err := store.ListReactors(ctx, channelID, messageID, emoji, 2, 0)
	if err != nil {
		t.Fatalf("unexpected list error: %v", err)
	}
	if len(p1) != 2 || p1[0] != 101 || p1[1] != 102 {
		t.Errorf("expected [101, 102], got %+v", p1)
	}

	// Page 2: after 102, limit 2
	p2, err := store.ListReactors(ctx, channelID, messageID, emoji, 2, 102)
	if err != nil {
		t.Fatalf("unexpected list error: %v", err)
	}
	if len(p2) != 2 || p2[0] != 103 || p2[1] != 104 {
		t.Errorf("expected [103, 104], got %+v", p2)
	}

	// Non-existent emoji
	empty, err := store.ListReactors(ctx, channelID, messageID, "👾", 50, 0)
	if err != nil {
		t.Fatalf("unexpected error on empty: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("expected empty slice, got %+v", empty)
	}
}

func TestMemoryReactionsStore_ConcurrentAccess(t *testing.T) {
	store := messages.NewMemoryReactionsStore()
	ctx := context.Background()

	channelID := int64(999)
	messageID := int64(888)
	emoji := "🎉"

	var wg sync.WaitGroup
	numWorkers := 20
	opsPerWorker := 50

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			uid := int64(1000 + workerID)
			for j := 0; j < opsPerWorker; j++ {
				_ = store.AddReaction(ctx, channelID, messageID, emoji, uid)
				_, _ = store.GetReactionsForMessages(ctx, channelID, []int64{messageID}, uid)
				if j%2 == 0 {
					_ = store.RemoveReaction(ctx, channelID, messageID, emoji, uid)
				}
			}
		}(i)
	}

	wg.Wait()
}

func TestScyllaReactionsStore_Integration(t *testing.T) {
	scyllaHosts := os.Getenv("SCYLLA_HOSTS")
	if scyllaHosts == "" {
		t.Skip("skipping ScyllaReactionsStore integration test: SCYLLA_HOSTS not set")
	}

	session, err := messages.NewScyllaSession(messages.ScyllaConfig{
		Hosts:       strings.Split(scyllaHosts, ","),
		Keyspace:    "kith",
		Consistency: messages.ParseConsistency("LOCAL_QUORUM"),
	})
	if err != nil {
		t.Skipf("cannot connect to ScyllaDB at %s: %v", scyllaHosts, err)
	}
	defer session.Close()

	store := messages.NewScyllaReactionsStore(session)
	ctx := context.Background()

	channelID := int64(99999)
	messageID := int64(88888)
	userA := int64(701)
	userB := int64(702)

	_ = store.RemoveReaction(ctx, channelID, messageID, "⭐", userA)
	_ = store.RemoveReaction(ctx, channelID, messageID, "⭐", userB)

	if err := store.AddReaction(ctx, channelID, messageID, "⭐", userA); err != nil {
		t.Fatalf("scylla add reaction error: %v", err)
	}
	if err := store.AddReaction(ctx, channelID, messageID, "⭐", userB); err != nil {
		t.Fatalf("scylla add reaction error: %v", err)
	}

	res, err := store.GetReactionsForMessages(ctx, channelID, []int64{messageID}, userA)
	if err != nil {
		t.Fatalf("scylla get reactions error: %v", err)
	}
	tallies := res[strconv.FormatInt(messageID, 10)]
	if len(tallies) != 1 || tallies[0].Emoji != "⭐" || tallies[0].Count != 2 || !tallies[0].Me {
		t.Errorf("unexpected scylla tallies: %+v", tallies)
	}

	reactors, err := store.ListReactors(ctx, channelID, messageID, "⭐", 10, 0)
	if err != nil {
		t.Fatalf("scylla list reactors error: %v", err)
	}
	if len(reactors) != 2 || reactors[0] != userA || reactors[1] != userB {
		t.Errorf("unexpected reactors: %+v", reactors)
	}

	// Clean up
	_ = store.RemoveReaction(ctx, channelID, messageID, "⭐", userA)
	_ = store.RemoveReaction(ctx, channelID, messageID, "⭐", userB)
}
