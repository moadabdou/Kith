package messages

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"testing"

	"github.com/moadabdou/Kith/api/pkg/permissions"
)

// mentionFixture builds a guild with sender + bob as members, outsider as a
// non-member user, one mentionable role (r1) and one non-mentionable role
// (r2). Returns ids for wiring mention syntax.
func mentionFixture(t *testing.T, h *harness, ctx context.Context) (sender, bob, outsider, r1, r2, cid int64) {
	t.Helper()
	sender = h.user(t, "sender")
	bob = h.user(t, "bob")
	outsider = h.user(t, "outsider")
	_, cid, _ = h.guildWithMember(t, "mention-guild", sender, bob)

	var gid int64
	if err := h.db.QueryRow(`SELECT guild_id FROM channels WHERE id = $1`, cid).Scan(&gid); err != nil {
		t.Fatalf("guild id: %v", err)
	}
	mkRole := func(name string, mentionable bool) int64 {
		rid, err := h.node.Generate()
		if err != nil {
			t.Fatalf("snowflake: %v", err)
		}
		if _, err := h.db.Exec(`INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable)
			VALUES ($1, $2, $3, 0, false, 1, $4, $5)`,
			rid, gid, name, permissions.DEFAULT_EVERYONE_PERMISSIONS, mentionable); err != nil {
			t.Fatalf("create role: %v", err)
		}
		return rid
	}
	// @everyone row so overwrites/permission resolution behave like prod.
	if _, err := h.db.Exec(`INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable)
		VALUES ($1, $1, '@everyone', 0, false, 0, $2, false) ON CONFLICT (id) DO NOTHING`,
		gid, permissions.DEFAULT_EVERYONE_PERMISSIONS); err != nil {
		t.Fatalf("create everyone role: %v", err)
	}
	r1 = mkRole("pingable", true)
	r2 = mkRole("quiet", false)
	return sender, bob, outsider, r1, r2, cid
}

func denyMentionEveryone(t *testing.T, h *harness, cid, userID int64) {
	t.Helper()
	if _, err := h.db.Exec(`INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny)
		VALUES ($1, $2, 1, 0, $3)`, cid, userID, permissions.MENTION_EVERYONE); err != nil {
		t.Fatalf("insert overwrite: %v", err)
	}
}

func TestSendResolvesMentions(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	pub := &recordingPublisher{}
	svc := NewService(h.db, NewPostgresStore(h.db), h.node, pub)
	sender, bob, outsider, r1, r2, cid := mentionFixture(t, h, ctx)

	content := fmt.Sprintf("hi <@%d> <@%d> <@%d> roles <@&%d> <@&%d> @everyone",
		bob, outsider, 987654321, r1, r2)
	m, err := svc.Send(ctx, sender, cid, content)
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	// Content is never mutated.
	if m.Content != content {
		t.Fatalf("Content mutated: %q", m.Content)
	}
	// Only the member survives; outsider + unknown IDs are stripped.
	if !reflect.DeepEqual(m.Mentions, []string{strconv.FormatInt(bob, 10)}) {
		t.Fatalf("Mentions = %v", m.Mentions)
	}
	// Sender holds MENTION_EVERYONE via defaults: bypass keeps r2.
	wantRoles := []string{strconv.FormatInt(r1, 10), strconv.FormatInt(r2, 10)}
	if !reflect.DeepEqual(m.MentionRoles, wantRoles) {
		t.Fatalf("MentionRoles = %v, want %v", m.MentionRoles, wantRoles)
	}
	if !m.MentionEveryone {
		t.Fatalf("MentionEveryone = false, want true")
	}

	// Published MESSAGE_CREATE carries the same resolved set.
	if len(pub.events) != 1 {
		t.Fatalf("published %d events, want 1", len(pub.events))
	}
	payload, ok := pub.events[0].Payload.(*Message)
	if !ok {
		t.Fatalf("payload type = %T", pub.events[0].Payload)
	}
	if !reflect.DeepEqual(payload.Mentions, m.Mentions) ||
		!reflect.DeepEqual(payload.MentionRoles, m.MentionRoles) ||
		payload.MentionEveryone != m.MentionEveryone {
		t.Fatalf("published mentions %+v diverge from response %+v", payload, m)
	}

	// Persisted row reads back identically.
	stored, err := svc.Get(ctx, sender, cid, mustParseID(t, m.ID))
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !reflect.DeepEqual(stored.Mentions, m.Mentions) ||
		!reflect.DeepEqual(stored.MentionRoles, m.MentionRoles) ||
		stored.MentionEveryone != m.MentionEveryone {
		t.Fatalf("stored mentions %+v diverge from response %+v", stored, m)
	}
}

func TestSendMentionGatesWithoutBroadcastPerm(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	svc := NewService(h.db, NewPostgresStore(h.db), h.node, NoopRecorder{})
	sender, bob, _, r1, r2, cid := mentionFixture(t, h, ctx)
	denyMentionEveryone(t, h, cid, sender)

	// Literal broadcast without the perm still hard-fails (existing gate).
	if _, err := svc.Send(ctx, sender, cid, "hello @everyone"); !errors.Is(err, ErrMissingPermissions) {
		t.Fatalf("Send(@everyone) = %v, want ErrMissingPermissions", err)
	}

	// Role mentions: mentionable kept, non-mentionable stripped, no bypass.
	m, err := svc.Send(ctx, sender, cid,
		fmt.Sprintf("roles <@&%d> <@&%d>", r1, r2))
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !reflect.DeepEqual(m.MentionRoles, []string{strconv.FormatInt(r1, 10)}) {
		t.Fatalf("MentionRoles = %v, want only r1", m.MentionRoles)
	}
	if m.MentionEveryone {
		t.Fatalf("MentionEveryone = true without perm")
	}

	// Direct user mentions are unaffected by the broadcast perm.
	m2, err := svc.Send(ctx, sender, cid, fmt.Sprintf("hi <@%d>", bob))
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !reflect.DeepEqual(m2.Mentions, []string{strconv.FormatInt(bob, 10)}) {
		t.Fatalf("Mentions = %v", m2.Mentions)
	}
}

func TestEditReparsesMentions(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	svc := NewService(h.db, NewPostgresStore(h.db), h.node, NoopRecorder{})
	sender, bob, _, _, _, cid := mentionFixture(t, h, ctx)

	m, err := svc.Send(ctx, sender, cid, fmt.Sprintf("hi <@%d>", bob))
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if len(m.Mentions) != 1 {
		t.Fatalf("Mentions = %v", m.Mentions)
	}

	edited, err := svc.Edit(ctx, sender, cid, mustParseID(t, m.ID), "no mentions anymore")
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if edited.Mentions != nil || edited.MentionRoles != nil || edited.MentionEveryone {
		t.Fatalf("edited mentions not cleared: %+v", edited)
	}
	if edited.Content != "no mentions anymore" {
		t.Fatalf("Content = %q", edited.Content)
	}

	edited2, err := svc.Edit(ctx, sender, cid, mustParseID(t, m.ID), "shout @everyone")
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if !edited2.MentionEveryone {
		t.Fatalf("MentionEveryone = false after edit")
	}
}

func mustParseID(t *testing.T, raw string) int64 {
	t.Helper()
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		t.Fatalf("parse id: %v", err)
	}
	return id
}
