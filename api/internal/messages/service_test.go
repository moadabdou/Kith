package messages

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

// Integration tests run against a migrated Postgres (TEST_DATABASE_URL).

type harness struct {
	svc  *Service
	db   *sql.DB
	node *snowflake.Node
	pfx  string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	var b [4]byte
	rand.Read(b[:])
	pfx := hex.EncodeToString(b[:])
	t.Cleanup(func() {
		db.Exec("DELETE FROM guilds WHERE name LIKE $1", pfx+"%")
		db.Exec("DELETE FROM users WHERE username LIKE $1", pfx+"%")
		db.Close()
	})
	node, _ := snowflake.NewNode(997)
	return &harness{db: db, node: node, pfx: pfx}
}

func (h *harness) user(t *testing.T, suffix string) int64 {
	t.Helper()
	id, err := h.node.Generate()
	if err != nil {
		t.Fatalf("snowflake: %v", err)
	}
	un := h.pfx + suffix
	if _, err := h.db.Exec(`
		INSERT INTO users (id, username, discriminator, email, password_hash)
		VALUES ($1, $2, 3, $3, 'x')`, id, un, un+"@example.com"); err != nil {
		t.Fatalf("create user: %v", err)
	}
	return id
}

// guildWithMember creates a guild owned by owner with member in it and
// returns a text channel id.
func (h *harness) guildWithMember(t *testing.T, suffix string, members ...int64) (guildID, channelID int64, ownerID int64) {
	t.Helper()
	ownerID = h.user(t, suffix+"-own")
	gid, err := h.node.Generate()
	if err != nil {
		t.Fatalf("snowflake: %v", err)
	}
	if _, err := h.db.Exec(`INSERT INTO guilds (id, name, owner_id) VALUES ($1, $2, $3)`,
		gid, h.pfx+suffix, ownerID); err != nil {
		t.Fatalf("create guild: %v", err)
	}
	if _, err := h.db.Exec(`INSERT INTO members (guild_id, user_id) VALUES ($1, $2)`, gid, ownerID); err != nil {
		t.Fatalf("create member: %v", err)
	}
	for _, uid := range members {
		if _, err := h.db.Exec(`INSERT INTO members (guild_id, user_id) VALUES ($1, $2)`, gid, uid); err != nil {
			t.Fatalf("create member: %v", err)
		}
	}
	cid, _ := h.node.Generate()
	if _, err := h.db.Exec(`
		INSERT INTO channels (id, guild_id, type, name) VALUES ($1, $2, 0, $3)`,
		cid, gid, h.pfx+"general"); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	return gid, cid, ownerID
}

func (h *harness) msgCount(t *testing.T, channelID int64) int {
	t.Helper()
	var n int
	if err := h.db.QueryRow(`SELECT count(*) FROM messages WHERE channel_id = $1`, channelID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func TestSendListPaginate(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	svc := NewService(h.db, h.node, NoopRecorder{})
	a := h.user(t, "a")
	_, cid, _ := h.guildWithMember(t, "g", a)

	// non-member cannot send
	outsider := h.user(t, "out")
	// unknown channel: the membership probe reports missing access
	// (unknown channel ⇒ no guild ⇒ not a member) — 403 is the right
	// status; leaking channel existence to strangers would be worse.
	if _, err := svc.Send(ctx, outsider, cid, "hi"); !errors.Is(err, ErrMissingAccess) {
		t.Errorf("Send(non-member) = %v, want ErrMissingAccess", err)
	}
	if _, err := svc.Send(ctx, a, 42, "hi"); !errors.Is(err, ErrMissingAccess) {
		t.Errorf("Send(unknown channel) = %v, want ErrMissingAccess", err)
	}

	// send 12 messages
	sent := []Message{}
	for i := 0; i < 12; i++ {
		m, err := svc.Send(ctx, a, cid, fmt.Sprintf("msg %02d", i))
		if err != nil {
			t.Fatalf("Send #%d: %v", i, err)
		}
		if m.Author.Username == "" || m.ID == "" {
			t.Fatalf("Send returned incomplete message: %+v", m)
		}
		sent = append(sent, *m)
	}

	// default list: newest first
	page, err := svc.List(ctx, a, cid, 0, 0)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(page) != 12 || page[0].Content != "msg 11" || page[11].Content != "msg 00" {
		t.Fatalf("List = %d msgs, first=%q last=%q", len(page), page[0].Content, page[len(page)-1].Content)
	}

	// cursor pagination: 5 at a time
	p1, _ := svc.List(ctx, a, cid, 0, 5)
	if len(p1) != 5 || p1[0].Content != "msg 11" {
		t.Fatalf("page1 = %+v", p1)
	}
	cursor, _ := snowflake.Parse(p1[len(p1)-1].ID)
	p2, _ := svc.List(ctx, a, cid, cursor, 5)
	if len(p2) != 5 || p2[0].Content != "msg 06" {
		t.Fatalf("page2 = %+v", p2)
	}
	cursor2, _ := snowflake.Parse(p2[len(p2)-1].ID)
	p3, _ := svc.List(ctx, a, cid, cursor2, 5)
	if len(p3) != 2 || p3[0].Content != "msg 01" {
		t.Fatalf("page3 = %+v", p3)
	}

	// non-member cannot list
	if _, err := svc.List(ctx, outsider, cid, 0, 0); !errors.Is(err, ErrMissingAccess) {
		t.Errorf("List(non-member) = %v, want ErrMissingAccess", err)
	}
}

func TestEditDeleteAuthorWindow(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	svc := NewService(h.db, h.node, NoopRecorder{})
	a := h.user(t, "a")
	b := h.user(t, "b")
	_, cid, _ := h.guildWithMember(t, "g", a, b)

	m, err := svc.Send(ctx, a, cid, "original")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	mid, _ := snowflake.Parse(m.ID)

	// non-author cannot edit
	if _, err := svc.Edit(ctx, b, cid, mid, "hacked"); !errors.Is(err, ErrNotAuthor) {
		t.Errorf("Edit(non-author) = %v, want ErrNotAuthor", err)
	}
	// author edits fine
	edited, err := svc.Edit(ctx, a, cid, mid, "edited!")
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if edited.Content != "edited!" || edited.EditedAt == nil {
		t.Errorf("Edit returned %+v", edited)
	}
	// unknown message
	if _, err := svc.Edit(ctx, a, cid, 42, "x"); !errors.Is(err, ErrUnknownMessage) {
		t.Errorf("Edit(unknown) = %v, want ErrUnknownMessage", err)
	}

	// age the message past the 15-minute window
	if _, err := h.db.Exec(`UPDATE messages SET created_at = now() - interval '16 minutes' WHERE id = $1`, mid); err != nil {
		t.Fatalf("age message: %v", err)
	}
	if _, err := svc.Edit(ctx, a, cid, mid, "too late"); !errors.Is(err, ErrEditWindowOver) {
		t.Errorf("Edit(window over) = %v, want ErrEditWindowOver", err)
	}
	if err := svc.Delete(ctx, a, cid, mid); !errors.Is(err, ErrEditWindowOver) {
		t.Errorf("Delete(window over) = %v, want ErrEditWindowOver", err)
	}

	// fresh message: author deletes, non-author cannot
	m2, _ := svc.Send(ctx, a, cid, "delete me")
	mid2, _ := snowflake.Parse(m2.ID)
	if err := svc.Delete(ctx, b, cid, mid2); !errors.Is(err, ErrNotAuthor) {
		t.Errorf("Delete(non-author) = %v, want ErrNotAuthor", err)
	}
	if err := svc.Delete(ctx, a, cid, mid2); err != nil {
		t.Fatalf("Delete(author): %v", err)
	}
	if err := svc.Delete(ctx, a, cid, mid2); !errors.Is(err, ErrUnknownMessage) {
		t.Errorf("Delete(again) = %v, want ErrUnknownMessage", err)
	}
	if n := h.msgCount(t, cid); n != 1 {
		t.Errorf("channel has %d messages, want 1", n)
	}
}

// recordingPublisher proves publish-after-commit: a publish callback that
// opens its own connection sees the committed row.
type recordingPublisher struct {
	mu     sync.Mutex
	events []events.Event
}

func (p *recordingPublisher) Publish(_ context.Context, e events.Event) error {
	p.mu.Lock()
	p.events = append(p.events, e)
	p.mu.Unlock()
	return nil
}

func TestPublishAfterCommit(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	// A second connection: if publish fired before commit, this reader
	// (READ COMMITTED, separate tx) would NOT see the row.
	other, err := sql.Open("pgx", os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatalf("open second conn: %v", err)
	}
	defer other.Close()

	pub := &publishProbe{db: other}
	svc := NewService(h.db, h.node, pub)
	a := h.user(t, "a")
	_, cid, _ := h.guildWithMember(t, "g", a)

	if _, err := svc.Send(ctx, a, cid, "must be visible when published"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !pub.visibleAtPublish {
		t.Fatal("publisher could not see the row — publish fired before commit")
	}
	if len(pub.seen) == 0 || pub.seen[0].Type != "MESSAGE_CREATE" {
		t.Fatalf("no MESSAGE_CREATE event captured: %+v", pub.seen)
	}
	payload, ok := pub.seen[0].Payload.(*Message)
	if !ok || payload.Content != "must be visible when published" {
		t.Fatalf("event payload = %+v", pub.seen[0].Payload)
	}
}

type publishProbe struct {
	db               *sql.DB
	visibleAtPublish bool
	seen             []events.Event
}

func (p *publishProbe) Publish(ctx context.Context, e events.Event) error {
	msg, ok := e.Payload.(*Message)
	if !ok {
		return nil
	}
	mid, err := snowflake.Parse(msg.ID)
	if err != nil {
		return err
	}
	// Separate connection, outside the writer's tx: only committed rows are
	// visible. If publish fired before Commit(), this read finds nothing.
	var n int
	if err := p.db.QueryRowContext(ctx,
		`SELECT count(*) FROM messages WHERE id = $1`, mid).Scan(&n); err != nil {
		return err
	}
	if n == 1 {
		p.visibleAtPublish = true
	}
	p.seen = append(p.seen, e)
	return nil
}

// noop recorder for other tests
type NoopRecorder struct{}

func (NoopRecorder) Publish(context.Context, events.Event) error { return nil }

// compile-time interface checks
var (
	_ events.Publisher = (*recordingPublisher)(nil)
	_ events.Publisher = (*publishProbe)(nil)
	_ events.Publisher = NoopRecorder{}
)

func TestEditWindowConstant(t *testing.T) {
	if EditWindow != 15*time.Minute {
		t.Errorf("EditWindow = %v, want 15m", EditWindow)
	}
}
