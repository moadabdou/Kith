package messages

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"testing"
)

// Chaos Drill 1 (Issue #116, plan/13 §7): concurrent reply + delete race.
//
// N paired rounds: Client A replies to message X while Client B deletes X,
// both released from a start barrier. Every round must land in exactly one
// legal outcome — never a 500, orphan, or partial:
//
//	reply-wins:  reply 201 with Type=19 + reply_to set; read-back tombstones
//	             (referenced_message == nil after the parent delete lands).
//	delete-wins: reply 400 ErrReferencedMessageNotFound; parent gone, no reply.
func TestRace_ReplyVsDelete(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	svc := NewService(h.db, NewPostgresStore(h.db), h.node, NoopRecorder{})

	// Owner deletes via the author path (owner authored the parents below);
	// replier is a plain member.
	replier := h.user(t, "replier")
	_, cid, owner := h.guildWithMember(t, "race-guild", replier)

	const rounds = 20
	var mu sync.Mutex
	replyWins, deleteWins := 0, 0
	var illegal []string

	for i := 0; i < rounds; i++ {
		parent, err := svc.Send(ctx, owner, cid, fmt.Sprintf("race parent %d", i))
		if err != nil {
			t.Fatalf("round %d: seed parent: %v", i, err)
		}
		parentID, _ := strconv.ParseInt(parent.ID, 10, 64)

		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)

		var replyMsg *Message
		var replyErr error
		go func() {
			defer wg.Done()
			<-start
			replyMsg, replyErr = svc.SendWithReference(ctx, replier, cid,
				fmt.Sprintf("race reply %d", i), nil,
				&MessageReference{MessageID: strconv.FormatInt(parentID, 10)})
		}()

		var delErr error
		go func() {
			defer wg.Done()
			<-start
			delErr = svc.Delete(ctx, owner, cid, parentID)
		}()

		close(start)
		wg.Wait()

		if delErr != nil {
			illegal = append(illegal, fmt.Sprintf("round %d: delete failed: %v", i, delErr))
			continue
		}

		if replyErr == nil {
			// Reply won the race: must be a well-formed reply row.
			if replyMsg.Type != 19 || replyMsg.ReplyTo == nil ||
				*replyMsg.ReplyTo != strconv.FormatInt(parentID, 10) {
				illegal = append(illegal, fmt.Sprintf("round %d: reply malformed: %+v", i, replyMsg))
				continue
			}
			mu.Lock()
			replyWins++
			mu.Unlock()
		} else if errors.Is(replyErr, ErrReferencedMessageNotFound) {
			// Delete won: parent must be gone and no reply row may exist.
			if _, err := svc.Get(ctx, owner, cid, parentID); !errors.Is(err, ErrUnknownMessage) {
				illegal = append(illegal, fmt.Sprintf("round %d: parent still present after delete-wins", i))
				continue
			}
			mu.Lock()
			deleteWins++
			mu.Unlock()
		} else {
			illegal = append(illegal, fmt.Sprintf("round %d: illegal reply error: %v", i, replyErr))
		}
	}

	if len(illegal) > 0 {
		for _, s := range illegal {
			t.Error(s)
		}
	}
	t.Logf("race: %d rounds, replyWins=%d deleteWins=%d illegal=%d", rounds, replyWins, deleteWins, len(illegal))
	if replyWins+deleteWins != rounds {
		t.Fatalf("outcome accounting broken: %d + %d != %d", replyWins, deleteWins, rounds)
	}
}

// Tombstone read-back: a reply whose parent was deleted must hydrate with
// reply_to preserved and referenced_message == nil. Uses the mock store so
// no DB is needed (mirrors TestHandler_List_ReplyHydrationAndTombstone's
// style); the live storm asserts the real Scylla read-back.
func TestRace_ReplyTombstoneHydration(t *testing.T) {
	store := newMockReplyStore()
	svc := NewService(nil, store, nil, NoopRecorder{})
	ctx := context.Background()

	// Seed parent + reply directly (bypasses perm checks: nil db = ALL_PERMS
	// in requireChannelPerms, matching existing mock-based reply tests).
	parent := &Message{ID: "1001", ChannelID: "10", Author: AuthorRef{ID: "5"}, Content: "parent"}
	store.messages[1001] = parent
	reply := &Message{
		ID: "1002", ChannelID: "10", Author: AuthorRef{ID: "6"},
		Content: "reply", Type: 19, ReplyTo: strptr("1001"),
	}
	store.messages[1002] = reply

	msgs, err := svc.List(ctx, 6, 10, Cursor{}, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var got *Message
	for i := range msgs {
		if msgs[i].ID == "1002" {
			got = &msgs[i]
		}
	}
	if got == nil {
		t.Fatalf("reply missing from List")
	}
	if got.ReferencedMsg == nil || got.ReferencedMsg.Content != "parent" {
		t.Fatalf("expected hydrated parent, got %+v", got.ReferencedMsg)
	}

	// Delete the parent: read-back must tombstone, preserving reply_to.
	delete(store.messages, 1001)
	msgs, err = svc.List(ctx, 6, 10, Cursor{}, 10)
	if err != nil {
		t.Fatalf("List after delete: %v", err)
	}
	for i := range msgs {
		if msgs[i].ID == "1002" {
			got = &msgs[i]
		}
	}
	if got.ReplyTo == nil || *got.ReplyTo != "1001" {
		t.Fatalf("reply_to not preserved: %+v", got.ReplyTo)
	}
	if got.ReferencedMsg != nil {
		t.Fatalf("expected nil referenced_message (tombstone), got %+v", got.ReferencedMsg)
	}
}

func strptr(s string) *string { return &s }
