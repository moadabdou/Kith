package messages

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/pkg/permissions"
)

// latestStubStore returns canned tails per channel, optionally failing per
// channel to exercise the fail-soft path.
type latestStubStore struct {
	tails map[int64][]Message
	fail  map[int64]bool
}

func (s *latestStubStore) Insert(ctx context.Context, msg *Message) error { return nil }

func (s *latestStubStore) List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error) {
	if s.fail[channelID] {
		return nil, errors.New("partition unavailable")
	}
	return s.tails[channelID], nil
}

func (s *latestStubStore) ListAfter(ctx context.Context, channelID int64, after Cursor, limit int) ([]Message, error) {
	return s.tails[channelID], nil
}

func (s *latestStubStore) Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error) {
	return nil, nil
}

func (s *latestStubStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	return nil
}

func (s *latestStubStore) Get(ctx context.Context, channelID, messageID int64) (*Message, error) {
	return nil, nil
}

func TestGetChannelsLatestRequiresDB(t *testing.T) {
	svc := NewService(nil, &latestStubStore{}, nil, nil)
	if _, err := svc.GetChannelsLatest(context.Background(), 1, 2); err == nil {
		t.Fatal("expected error with nil db, got nil")
	}
}

// latestFixture creates owner + member + guild with two text channels
// (general, secret), one voice channel, and one message in general.
func latestFixture(t *testing.T, h *harness, member int64) (gid, general, secret, voice int64) {
	t.Helper()
	owner := h.user(t, "own")
	gid, err := h.node.Generate()
	if err != nil {
		t.Fatalf("snowflake: %v", err)
	}
	if _, err := h.db.Exec(`INSERT INTO guilds (id, name, owner_id) VALUES ($1, $2, $3)`,
		gid, h.pfx+"g", owner); err != nil {
		t.Fatalf("create guild: %v", err)
	}
	for _, uid := range []int64{owner, member} {
		if _, err := h.db.Exec(`INSERT INTO members (guild_id, user_id) VALUES ($1, $2)`, gid, uid); err != nil {
			t.Fatalf("create member: %v", err)
		}
	}
	mkChan := func(typ int16, name string) int64 {
		t.Helper()
		cid, _ := h.node.Generate()
		if _, err := h.db.Exec(`INSERT INTO channels (id, guild_id, type, name) VALUES ($1, $2, $3, $4)`,
			cid, gid, typ, h.pfx+name); err != nil {
			t.Fatalf("create channel: %v", err)
		}
		return cid
	}
	general, secret, voice = mkChan(0, "general"), mkChan(0, "secret"), mkChan(2, "voice")
	// @everyone role row so permission resolution has a base to work from.
	if _, err := h.db.Exec(`INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable)
		VALUES ($1, $1, '@everyone', 0, false, 0, $2, false)`,
		gid, permissions.DEFAULT_EVERYONE_PERMISSIONS); err != nil {
		t.Fatalf("create everyone role: %v", err)
	}
	return gid, general, secret, voice
}

func latestMsg(channelID int64, id string) Message {
	return Message{ID: id, ChannelID: strconv.FormatInt(channelID, 10), Content: "hi", CreatedAt: time.Now()}
}

func latestIDs(out []ChannelLatest) []string {
	ids := make([]string, 0, len(out))
	for _, r := range out {
		ids = append(ids, r.ChannelID+":"+r.LastMessageID)
	}
	sort.Strings(ids)
	return ids
}

func TestGetChannelsLatestHydratesReadableTails(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	member := h.user(t, "mem")
	gid, general, secret, _ := latestFixture(t, h, member)

	secretID := strconv.FormatInt(secret, 10)
	generalID := strconv.FormatInt(general, 10)
	svc := NewService(h.db, &latestStubStore{tails: map[int64][]Message{
		general: {latestMsg(general, "9001")},
		secret:  {latestMsg(secret, "9002")},
	}}, h.node, NoopRecorder{})

	// Deny the member VIEW_CHANNEL on secret via member overwrite.
	if _, err := h.db.Exec(`INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny)
		VALUES ($1, $2, 1, 0, $3)`, secret, member, permissions.VIEW_CHANNEL); err != nil {
		t.Fatalf("insert overwrite: %v", err)
	}

	out, err := svc.GetChannelsLatest(ctx, member, gid)
	if err != nil {
		t.Fatalf("GetChannelsLatest: %v", err)
	}
	// general hydrated, secret hidden, voice excluded, empty omitted implicitly.
	if got := latestIDs(out); len(got) != 1 || got[0] != generalID+":9001" {
		t.Fatalf("got %v, want [%s:9001]", got, generalID)
	}

	// Owner bypasses overwrites and sees both tails.
	out, err = svc.GetChannelsLatest(ctx, h.ownerOf(t, gid), gid)
	if err != nil {
		t.Fatalf("GetChannelsLatest(owner): %v", err)
	}
	wantOwner := []string{generalID + ":9001", secretID + ":9002"}
	sort.Strings(wantOwner)
	if got := latestIDs(out); fmt.Sprint(got) != fmt.Sprint(wantOwner) {
		t.Fatalf("owner got %v, want %v", got, wantOwner)
	}
}

func TestGetChannelsLatestNonMemberDenied(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	member := h.user(t, "mem")
	gid, _, _, _ := latestFixture(t, h, member)
	outsider := h.user(t, "out")
	svc := NewService(h.db, &latestStubStore{}, h.node, NoopRecorder{})
	if _, err := svc.GetChannelsLatest(ctx, outsider, gid); !errors.Is(err, ErrMissingAccess) {
		t.Fatalf("non-member = %v, want ErrMissingAccess", err)
	}
	if _, err := svc.GetChannelsLatest(ctx, member, 999999999); !errors.Is(err, ErrMissingAccess) {
		t.Fatalf("unknown guild = %v, want ErrMissingAccess", err)
	}
}

func TestGetChannelsLatestFailSoft(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	member := h.user(t, "mem")
	gid, general, secret, _ := latestFixture(t, h, member)
	svc := NewService(h.db, &latestStubStore{
		tails: map[int64][]Message{general: {latestMsg(general, "42")}},
		fail:  map[int64]bool{secret: true},
	}, h.node, NoopRecorder{})
	out, err := svc.GetChannelsLatest(ctx, member, gid)
	if err != nil {
		t.Fatalf("GetChannelsLatest: %v", err)
	}
	if got := latestIDs(out); len(got) != 1 {
		t.Fatalf("expected partial result of 1, got %v", got)
	}
}

func TestHandlerChannelsLatest(t *testing.T) {
	h := newHarness(t)
	member := h.user(t, "mem")
	gid, general, _, _ := latestFixture(t, h, member)
	svc := NewService(h.db, &latestStubStore{tails: map[int64][]Message{
		general: {latestMsg(general, "777")},
	}}, h.node, NoopRecorder{})
	handler := &Handler{Svc: svc}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/guilds/{id}/channels/latest", handler.ChannelsLatest)

	gidStr := strconv.FormatInt(gid, 10)
	req := httptest.NewRequest(http.MethodGet, "/api/guilds/"+gidStr+"/channels/latest", nil)
	req = req.WithContext(auth.ContextWithUserID(req.Context(), member))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); body == "" || len(body) < 10 {
		t.Fatalf("empty body: %q", body)
	}

	// Bad guild id shape -> 400-ish form error, not 500.
	bad := httptest.NewRequest(http.MethodGet, "/api/guilds/abc/channels/latest", nil)
	bad = bad.WithContext(auth.ContextWithUserID(bad.Context(), member))
	badRec := httptest.NewRecorder()
	mux.ServeHTTP(badRec, bad)
	if badRec.Code == http.StatusOK {
		t.Fatalf("bad guild id returned 200")
	}
}

func (h *harness) ownerOf(t *testing.T, gid int64) int64 {
	t.Helper()
	var owner int64
	if err := h.db.QueryRow(`SELECT owner_id FROM guilds WHERE id = $1`, gid).Scan(&owner); err != nil {
		t.Fatalf("ownerOf: %v", err)
	}
	return owner
}
