package guilds

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/pkg/permissions"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

// Integration tests run against a migrated Postgres (TEST_DATABASE_URL).

func newTestService(t *testing.T) (*Service, *sql.DB, *snowflake.Node, string) {
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
	prefix := "t" + hex.EncodeToString(b[:])
	t.Cleanup(func() {
		// guilds cascade channels/members/invites; then users (owner FK is RESTRICT)
		db.Exec("DELETE FROM guilds WHERE name LIKE $1", prefix+"%")
		db.Exec("DELETE FROM users WHERE username LIKE $1", prefix+"%")
		db.Close()
	})
	node, _ := snowflake.NewNode(998)
	return NewService(db, node, events.NoopPublisher{}), db, node, prefix
}

func createTestUser(t *testing.T, db *sql.DB, node *snowflake.Node, prefix, suffix string) int64 {
	t.Helper()
	id, err := node.Generate()
	if err != nil {
		t.Fatalf("snowflake: %v", err)
	}
	username := prefix + suffix
	_, err = db.Exec(`
		INSERT INTO users (id, username, discriminator, email, password_hash)
		VALUES ($1, $2, $3, $4, 'x')`,
		id, username, 1, username+"@example.com")
	if err != nil {
		t.Fatalf("create user %s: %v", username, err)
	}
	return id
}

func memberExists(t *testing.T, db *sql.DB, guildID, userID int64) bool {
	t.Helper()
	var ok bool
	if err := db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`,
		guildID, userID).Scan(&ok); err != nil {
		t.Fatalf("member check: %v", err)
	}
	return ok
}

func inviteUses(t *testing.T, db *sql.DB, code string) int32 {
	t.Helper()
	var uses int32
	if err := db.QueryRow(`SELECT uses FROM invites WHERE code = $1`, code).Scan(&uses); err != nil {
		t.Fatalf("invite uses: %v", err)
	}
	return uses
}

func TestGuildLifecycle(t *testing.T) {
	svc, db, node, p := newTestService(t)
	ctx := context.Background()
	a := createTestUser(t, db, node, p, "a")
	b := createTestUser(t, db, node, p, "b")

	g, err := svc.CreateGuild(ctx, a, p+"hq")
	if err != nil {
		t.Fatalf("CreateGuild: %v", err)
	}
	if g.OwnerID != fmt.Sprint(a) {
		t.Errorf("owner = %s, want %d", g.OwnerID, a)
	}
	gid, _ := snowflake.Parse(g.ID)
	if !memberExists(t, db, gid, a) {
		t.Error("creator must be auto-inserted as member")
	}

	if _, err := svc.GetGuild(ctx, a, gid); err != nil {
		t.Errorf("GetGuild(owner): %v", err)
	}
	if _, err := svc.GetGuild(ctx, b, gid); !errors.Is(err, ErrMissingAccess) {
		t.Errorf("GetGuild(non-member) = %v, want ErrMissingAccess", err)
	}
	if _, err := svc.GetGuild(ctx, a, 123); !errors.Is(err, ErrUnknownGuild) {
		t.Errorf("GetGuild(unknown) = %v, want ErrUnknownGuild", err)
	}

	if _, err := svc.UpdateGuild(ctx, b, gid, p+"renamed"); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("UpdateGuild(non-owner) = %v, want ErrMissingPermissions", err)
	}
	upd, err := svc.UpdateGuild(ctx, a, gid, p+"renamed")
	if err != nil || upd.Name != p+"renamed" {
		t.Errorf("UpdateGuild(owner) = %v, %q; want nil, %q", err, upd.Name, p+"renamed")
	}

	if err := svc.AddMember(ctx, a, gid, b); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	mine, err := svc.MyGuilds(ctx, b)
	if err != nil {
		t.Fatalf("MyGuilds: %v", err)
	}
	found := false
	for _, mg := range mine {
		if mg.ID == g.ID {
			found = true
		}
	}
	if !found {
		t.Errorf("MyGuilds(b) = %v, want to contain %s", mine, g.ID)
	}
}

func TestChannelLifecycle(t *testing.T) {
	svc, db, node, p := newTestService(t)
	ctx := context.Background()
	a := createTestUser(t, db, node, p, "a")
	b := createTestUser(t, db, node, p, "b")

	g, err := svc.CreateGuild(ctx, a, p+"hq")
	if err != nil {
		t.Fatalf("CreateGuild: %v", err)
	}
	gid, _ := snowflake.Parse(g.ID)
	if err := svc.AddMember(ctx, a, gid, b); err != nil {
		t.Fatalf("AddMember(b): %v", err)
	}

	c, err := svc.CreateChannel(ctx, a, gid, 0, "General Chat", 0, nil)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if c.Name != "general-chat" {
		t.Errorf("text channel name = %q, want normalized %q", c.Name, "general-chat")
	}
	v, err := svc.CreateChannel(ctx, a, gid, 2, "Lounge", 0, nil)
	if err != nil {
		t.Fatalf("CreateChannel(voice): %v", err)
	}
	if v.Name != "Lounge" {
		t.Errorf("voice channel name = %q, want %q (no normalization)", v.Name, "Lounge")
	}

	if _, err := svc.CreateChannel(ctx, b, gid, 0, "nope", 0, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("CreateChannel(non-owner) = %v, want ErrMissingPermissions", err)
	}

	chans, err := svc.ListChannels(ctx, b, gid)
	if err != nil {
		t.Fatalf("ListChannels(member): %v", err)
	}
	if len(chans) != 2 {
		t.Fatalf("ListChannels = %d channels, want 2", len(chans))
	}
	if chans[0].Type != 0 || chans[1].Type != 2 {
		t.Errorf("ordering by type broken: %+v", chans)
	}

	if _, err := svc.ListChannels(ctx, createTestUser(t, db, node, p, "z"), gid); !errors.Is(err, ErrMissingAccess) {
		t.Errorf("ListChannels(non-member) = %v, want ErrMissingAccess", err)
	}

	cid, _ := snowflake.Parse(c.ID)
	upd, err := svc.UpdateChannel(ctx, a, gid, cid, strPtr("announcements"), nil, nil)
	if err != nil || upd.Name != "announcements" {
		t.Errorf("UpdateChannel = %v, %q", err, upd.Name)
	}

	// wrong guild scope: channel of another guild is "unknown" here
	g2, _ := svc.CreateGuild(ctx, a, p+"other")
	g2id, _ := snowflake.Parse(g2.ID)
	if _, err := svc.UpdateChannel(ctx, a, g2id, cid, strPtr("x"), nil, nil); !errors.Is(err, ErrUnknownChannel) {
		t.Errorf("UpdateChannel(wrong guild) = %v, want ErrUnknownChannel", err)
	}

	if err := svc.DeleteChannel(ctx, a, gid, cid); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}
	chans, _ = svc.ListChannels(ctx, a, gid)
	if len(chans) != 1 {
		t.Fatalf("after delete: %d channels, want 1", len(chans))
	}
	if err := svc.DeleteChannel(ctx, a, gid, cid); !errors.Is(err, ErrUnknownChannel) {
		t.Errorf("DeleteChannel(again) = %v, want ErrUnknownChannel", err)
	}
}

func TestMemberLifecycle(t *testing.T) {
	svc, db, node, p := newTestService(t)
	ctx := context.Background()
	a := createTestUser(t, db, node, p, "a")
	b := createTestUser(t, db, node, p, "b")
	c := createTestUser(t, db, node, p, "c")
	ghost, _ := node.Generate() // never inserted

	g, _ := svc.CreateGuild(ctx, a, p+"hq")
	gid, _ := snowflake.Parse(g.ID)

	members, err := svc.ListMembers(ctx, a, gid)
	if err != nil || len(members) != 1 || members[0].User.ID != fmt.Sprint(a) {
		t.Fatalf("ListMembers(initial) = %v, %v", members, err)
	}

	if err := svc.AddMember(ctx, a, gid, ghost); !errors.Is(err, ErrUnknownUser) {
		t.Errorf("AddMember(unknown user) = %v, want ErrUnknownUser", err)
	}
	if err := svc.AddMember(ctx, b, gid, c); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("AddMember(non-owner) = %v, want ErrMissingPermissions", err)
	}

	if err := svc.AddMember(ctx, a, gid, b); err != nil {
		t.Fatalf("AddMember(b): %v", err)
	}
	if err := svc.AddMember(ctx, a, gid, b); err != nil {
		t.Errorf("AddMember(b, again) = %v, want idempotent nil", err)
	}

	members, err = svc.ListMembers(ctx, b, gid)
	if err != nil || len(members) != 2 {
		t.Fatalf("ListMembers(after add) = %d, %v; want 2", len(members), err)
	}

	if err := svc.RemoveMember(ctx, b, gid, a); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("RemoveMember(owner target) = %v, want ErrMissingPermissions", err)
	}
	if err := svc.RemoveMember(ctx, c, gid, b); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("RemoveMember(non-owner kicker) = %v, want ErrMissingPermissions", err)
	}
	if err := svc.RemoveMember(ctx, b, gid, b); err != nil {
		t.Errorf("RemoveMember(self-leave) = %v, want nil", err)
	}
	if memberExists(t, db, gid, b) {
		t.Error("b should have left")
	}

	svc.AddMember(ctx, a, gid, b)
	if err := svc.RemoveMember(ctx, a, gid, b); err != nil {
		t.Errorf("RemoveMember(kick) = %v, want nil", err)
	}
	if err := svc.RemoveMember(ctx, a, gid, b); !errors.Is(err, ErrUnknownMember) {
		t.Errorf("RemoveMember(again) = %v, want ErrUnknownMember", err)
	}
}

func TestInviteLifecycle(t *testing.T) {
	svc, db, node, p := newTestService(t)
	ctx := context.Background()
	a := createTestUser(t, db, node, p, "a")
	b := createTestUser(t, db, node, p, "b")
	c := createTestUser(t, db, node, p, "c")
	d := createTestUser(t, db, node, p, "d")

	g, _ := svc.CreateGuild(ctx, a, p+"hq")
	gid, _ := snowflake.Parse(g.ID)
	ch, err := svc.CreateChannel(ctx, a, gid, 0, "general", 0, nil)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	cid, _ := snowflake.Parse(ch.ID)

	// non-member cannot invite
	if _, err := svc.CreateInvite(ctx, b, cid, time.Hour, 0); !errors.Is(err, ErrMissingAccess) {
		t.Errorf("CreateInvite(non-member) = %v, want ErrMissingAccess", err)
	}
	// unknown channel
	if _, err := svc.CreateInvite(ctx, a, 42, time.Hour, 0); !errors.Is(err, ErrUnknownChannel) {
		t.Errorf("CreateInvite(unknown channel) = %v, want ErrUnknownChannel", err)
	}

	inv, err := svc.CreateInvite(ctx, a, cid, time.Hour, 0)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if inv.Code == "" || inv.Channel.ID != ch.ID || inv.Guild.ID != g.ID {
		t.Errorf("invite = %+v", inv)
	}

	joined, err := svc.JoinInvite(ctx, b, inv.Code)
	if err != nil {
		t.Fatalf("JoinInvite: %v", err)
	}
	if joined.ID != g.ID || !memberExists(t, db, gid, b) {
		t.Errorf("join returned %+v, member=%v", joined, memberExists(t, db, gid, b))
	}
	if uses := inviteUses(t, db, inv.Code); uses != 1 {
		t.Errorf("uses = %d, want 1", uses)
	}

	// re-join: no-op, does not consume a use
	if _, err := svc.JoinInvite(ctx, b, inv.Code); err != nil {
		t.Fatalf("re-join: %v", err)
	}
	if uses := inviteUses(t, db, inv.Code); uses != 1 {
		t.Errorf("uses after re-join = %d, want 1", uses)
	}

	// any member can create invites (@everyone default)
	if _, err := svc.CreateInvite(ctx, b, cid, time.Hour, 0); err != nil {
		t.Errorf("CreateInvite(member) = %v, want nil", err)
	}

	// max_uses = 1: one join then exhausted
	limited, err := svc.CreateInvite(ctx, a, cid, time.Hour, 1)
	if err != nil {
		t.Fatalf("CreateInvite(limited): %v", err)
	}
	if _, err := svc.JoinInvite(ctx, c, limited.Code); err != nil {
		t.Fatalf("first use of limited invite: %v", err)
	}
	if _, err := svc.JoinInvite(ctx, d, limited.Code); !errors.Is(err, ErrUnknownInvite) {
		t.Errorf("exhausted invite = %v, want ErrUnknownInvite", err)
	}

	// expiry
	expired, err := svc.CreateInvite(ctx, a, cid, time.Minute, 0)
	if err != nil {
		t.Fatalf("CreateInvite(expiring): %v", err)
	}
	if _, err := db.Exec(`UPDATE invites SET expires_at = now() - interval '1 second' WHERE code = $1`, expired.Code); err != nil {
		t.Fatalf("age invite: %v", err)
	}
	if _, err := svc.JoinInvite(ctx, d, expired.Code); !errors.Is(err, ErrUnknownInvite) {
		t.Errorf("expired invite = %v, want ErrUnknownInvite", err)
	}

	// unknown code
	if _, err := svc.JoinInvite(ctx, d, "nope1234"); !errors.Is(err, ErrUnknownInvite) {
		t.Errorf("unknown code = %v, want ErrUnknownInvite", err)
	}
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
func int32Ptr(i int32) *int32 { return &i }
func int64Ptr(i int64) *int64 { return &i }

func TestRoles_Lifecycle(t *testing.T) {
	svc, db, node, prefix := newTestService(t)
	ctx := context.Background()

	owner := createTestUser(t, db, node, prefix, "_owner")
	other := createTestUser(t, db, node, prefix, "_other")

	g, err := svc.CreateGuild(ctx, owner, prefix+"-roles-guild")
	if err != nil {
		t.Fatalf("CreateGuild: %v", err)
	}
	gid, _ := snowflake.Parse(g.ID)

	// Non-member cannot list roles
	if _, err := svc.ListRoles(ctx, other, gid); !errors.Is(err, ErrMissingAccess) {
		t.Errorf("ListRoles(non-member) = %v, want ErrMissingAccess", err)
	}

	// Non-member cannot create roles
	if _, err := svc.CreateRole(ctx, other, gid, "Admin", int32Ptr(100), boolPtr(true), int32Ptr(1), int64Ptr(8), boolPtr(true)); !errors.Is(err, ErrMissingAccess) {
		t.Errorf("CreateRole(non-member) = %v, want ErrMissingAccess", err)
	}

	if err := svc.AddMember(ctx, owner, gid, other); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	// Non-owner member without manage-roles permission cannot create roles
	if _, err := svc.CreateRole(ctx, other, gid, "Admin", int32Ptr(100), boolPtr(true), int32Ptr(1), int64Ptr(8), boolPtr(true)); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("CreateRole(non-owner member) = %v, want ErrMissingPermissions", err)
	}

	// Owner creates hoisted role
	adminRole, err := svc.CreateRole(ctx, owner, gid, "Admin", int32Ptr(15158332), boolPtr(true), int32Ptr(2), int64Ptr(8), boolPtr(true))
	if err != nil {
		t.Fatalf("CreateRole(Admin): %v", err)
	}
	if !adminRole.Hoist {
		t.Errorf("adminRole.Hoist = false, want true")
	}
	if adminRole.Permissions != "8" {
		t.Errorf("adminRole.Permissions = %q, want \"8\"", adminRole.Permissions)
	}
	if adminRole.Color != 15158332 {
		t.Errorf("adminRole.Color = %d, want 15158332", adminRole.Color)
	}

	// Owner creates unhoisted role
	memberRole, err := svc.CreateRole(ctx, owner, gid, "Regular", int32Ptr(0), boolPtr(false), int32Ptr(1), int64Ptr(0), boolPtr(false))
	if err != nil {
		t.Fatalf("CreateRole(Regular): %v", err)
	}
	if memberRole.Hoist {
		t.Errorf("memberRole.Hoist = true, want false")
	}

	// Owner lists roles: Admin (pos 2), Regular (pos 1), @everyone (pos 0)
	roles, err := svc.ListRoles(ctx, owner, gid)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	if len(roles) != 3 {
		t.Fatalf("len(roles) = %d, want 3", len(roles))
	}
	if roles[0].Name != "Admin" || !roles[0].Hoist {
		t.Errorf("first role = %+v, want Admin (hoisted)", roles[0])
	}
	if roles[1].Name != "Regular" || roles[1].Hoist {
		t.Errorf("second role = %+v, want Regular (unhoisted)", roles[1])
	}
	if roles[2].Name != "@everyone" || roles[2].Position != 0 {
		t.Errorf("third role = %+v, want @everyone (pos 0)", roles[2])
	}

	// Update regular role to hoisted
	mrid, _ := snowflake.Parse(memberRole.ID)
	updated, err := svc.UpdateRole(ctx, owner, gid, mrid, strPtr("VIP"), nil, boolPtr(true), nil, nil, nil)
	if err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if updated.Name != "VIP" || !updated.Hoist {
		t.Errorf("updated role = %+v, want VIP (hoist=true)", updated)
	}

	// Delete role
	arid, _ := snowflake.Parse(adminRole.ID)
	if err := svc.DeleteRole(ctx, owner, gid, arid); err != nil {
		t.Fatalf("DeleteRole: %v", err)
	}

	// Unknown role on update / delete
	if _, err := svc.UpdateRole(ctx, owner, gid, arid, strPtr("Ghost"), nil, nil, nil, nil, nil); !errors.Is(err, ErrUnknownRole) {
		t.Errorf("UpdateRole(deleted) = %v, want ErrUnknownRole", err)
	}
	if err := svc.DeleteRole(ctx, owner, gid, arid); !errors.Is(err, ErrUnknownRole) {
		t.Errorf("DeleteRole(deleted) = %v, want ErrUnknownRole", err)
	}
}

func TestRoles_EveryoneProtections(t *testing.T) {
	svc, db, node, prefix := newTestService(t)
	ctx := context.Background()

	owner := createTestUser(t, db, node, prefix, "_owner")
	g, err := svc.CreateGuild(ctx, owner, prefix+"-ev-guild")
	if err != nil {
		t.Fatalf("CreateGuild: %v", err)
	}
	gid, _ := snowflake.Parse(g.ID)

	roles, err := svc.ListRoles(ctx, owner, gid)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	if len(roles) != 1 {
		t.Fatalf("len(roles) = %d, want 1 (@everyone)", len(roles))
	}
	ev := roles[0]
	if ev.ID != g.ID || ev.Name != "@everyone" || ev.Position != 0 {
		t.Errorf("unexpected @everyone role: %+v", ev)
	}
	if ev.Permissions != strconv.FormatUint(permissions.DEFAULT_EVERYONE_PERMISSIONS, 10) {
		t.Errorf("expected permissions %d, got %s", permissions.DEFAULT_EVERYONE_PERMISSIONS, ev.Permissions)
	}

	// Attempting to delete @everyone must return ErrMissingPermissions
	if err := svc.DeleteRole(ctx, owner, gid, gid); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("DeleteRole(@everyone) = %v, want ErrMissingPermissions", err)
	}

	// Attempting to change @everyone position must return ErrMissingPermissions
	if _, err := svc.UpdateRole(ctx, owner, gid, gid, nil, nil, nil, int32Ptr(1), nil, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("UpdateRole(@everyone, pos=1) = %v, want ErrMissingPermissions", err)
	}

	// Attempting to hoist @everyone must return ErrMissingPermissions
	if _, err := svc.UpdateRole(ctx, owner, gid, gid, nil, nil, boolPtr(true), nil, nil, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("UpdateRole(@everyone, hoist=true) = %v, want ErrMissingPermissions", err)
	}

	// Updating color or valid permissions on @everyone succeeds
	updated, err := svc.UpdateRole(ctx, owner, gid, gid, nil, int32Ptr(255), nil, nil, int64Ptr(int64(permissions.VIEW_CHANNEL)), nil)
	if err != nil {
		t.Fatalf("UpdateRole(@everyone, color) failed: %v", err)
	}
	if updated.Color != 255 || updated.Permissions != strconv.FormatUint(permissions.VIEW_CHANNEL, 10) {
		t.Errorf("updated @everyone = %+v", updated)
	}
}

func TestRoles_HierarchyAndEscalation(t *testing.T) {
	svc, db, node, prefix := newTestService(t)
	ctx := context.Background()

	owner := createTestUser(t, db, node, prefix, "_owner")
	modUser := createTestUser(t, db, node, prefix, "_mod")
	memberUser := createTestUser(t, db, node, prefix, "_mem")

	g, err := svc.CreateGuild(ctx, owner, prefix+"-hier-guild")
	if err != nil {
		t.Fatalf("CreateGuild: %v", err)
	}
	gid, _ := snowflake.Parse(g.ID)

	// Add mod and member to guild
	if err := svc.AddMember(ctx, owner, gid, modUser); err != nil {
		t.Fatalf("AddMember(mod): %v", err)
	}
	if err := svc.AddMember(ctx, owner, gid, memberUser); err != nil {
		t.Fatalf("AddMember(mem): %v", err)
	}

	// Owner creates Moderator role: position 10, MANAGE_ROLES | VIEW_CHANNEL | SEND_MESSAGES
	modPerms := int64(permissions.MANAGE_ROLES | permissions.VIEW_CHANNEL | permissions.SEND_MESSAGES)
	modRole, err := svc.CreateRole(ctx, owner, gid, "Moderator", nil, nil, int32Ptr(10), &modPerms, nil)
	if err != nil {
		t.Fatalf("CreateRole(Moderator): %v", err)
	}
	mrid, _ := snowflake.Parse(modRole.ID)

	// Assign Moderator role to modUser
	if _, err := db.Exec(`INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)`, gid, modUser, mrid); err != nil {
		t.Fatalf("assign role: %v", err)
	}

	// 1. Mod attempts to create a role at position 10 (>= highest position 10) -> rejected
	if _, err := svc.CreateRole(ctx, modUser, gid, "IllegalPos10", nil, nil, int32Ptr(10), nil, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("CreateRole(pos=10) = %v, want ErrMissingPermissions", err)
	}
	if _, err := svc.CreateRole(ctx, modUser, gid, "IllegalPos11", nil, nil, int32Ptr(11), nil, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("CreateRole(pos=11) = %v, want ErrMissingPermissions", err)
	}

	// 2. Mod attempts privilege escalation: granting ADMINISTRATOR (which mod lacks) -> rejected
	adminPerms := int64(permissions.ADMINISTRATOR)
	if _, err := svc.CreateRole(ctx, modUser, gid, "EscalateAdmin", nil, nil, int32Ptr(5), &adminPerms, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("CreateRole(EscalateAdmin) = %v, want ErrMissingPermissions", err)
	}

	// 3. Mod creates a role below own position with held permissions -> succeeds
	subPerms := int64(permissions.VIEW_CHANNEL)
	subRole, err := svc.CreateRole(ctx, modUser, gid, "JuniorMod", nil, nil, int32Ptr(5), &subPerms, nil)
	if err != nil {
		t.Fatalf("CreateRole(JuniorMod) failed: %v", err)
	}
	srid, _ := snowflake.Parse(subRole.ID)

	// 4. Mod attempts to edit the Moderator role (position 10 >= caller's position 10) -> rejected
	if _, err := svc.UpdateRole(ctx, modUser, gid, mrid, strPtr("RenamedMod"), nil, nil, nil, nil, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("UpdateRole(Moderator) = %v, want ErrMissingPermissions", err)
	}

	// 5. Mod attempts to promote JuniorMod to position 10 -> rejected
	if _, err := svc.UpdateRole(ctx, modUser, gid, srid, nil, nil, nil, int32Ptr(10), nil, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("UpdateRole(promote to 10) = %v, want ErrMissingPermissions", err)
	}

	// 6. Mod attempts to grant BAN_MEMBERS to JuniorMod (mod lacks BAN_MEMBERS) -> rejected
	banPerms := int64(permissions.BAN_MEMBERS)
	if _, err := svc.UpdateRole(ctx, modUser, gid, srid, nil, nil, nil, nil, &banPerms, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("UpdateRole(grant BAN_MEMBERS) = %v, want ErrMissingPermissions", err)
	}

	// 7. Mod edits JuniorMod successfully with allowed changes
	updatedSub, err := svc.UpdateRole(ctx, modUser, gid, srid, strPtr("JuniorMod2"), int32Ptr(123), nil, int32Ptr(6), nil, nil)
	if err != nil {
		t.Fatalf("UpdateRole(JuniorMod2) failed: %v", err)
	}
	if updatedSub.Name != "JuniorMod2" || updatedSub.Position != 6 {
		t.Errorf("unexpected updated JuniorMod: %+v", updatedSub)
	}

	// 8. Mod attempts to delete Moderator role -> rejected
	if err := svc.DeleteRole(ctx, modUser, gid, mrid); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("DeleteRole(Moderator) = %v, want ErrMissingPermissions", err)
	}

	// 9. Mod deletes JuniorMod (below caller's position) -> succeeds
	if err := svc.DeleteRole(ctx, modUser, gid, srid); err != nil {
		t.Fatalf("DeleteRole(JuniorMod) failed: %v", err)
	}

	// 10. Member with no permissions cannot create, update, or delete roles
	if _, err := svc.CreateRole(ctx, memberUser, gid, "Hacker", nil, nil, int32Ptr(1), nil, nil); !errors.Is(err, ErrMissingPermissions) {
		t.Errorf("CreateRole(regular member) = %v, want ErrMissingPermissions", err)
	}
}

func TestRoles_Events(t *testing.T) {
	_, db, node, prefix := newTestService(t)
	pub := &recordingPublisher{}
	svc := NewService(db, node, pub)
	ctx := context.Background()

	owner := createTestUser(t, db, node, prefix, "_owner")
	g, err := svc.CreateGuild(ctx, owner, prefix+"-events-guild")
	if err != nil {
		t.Fatalf("CreateGuild: %v", err)
	}
	gid, _ := snowflake.Parse(g.ID)

	// Create role
	created, err := svc.CreateRole(ctx, owner, gid, "Tester", int32Ptr(111), boolPtr(true), int32Ptr(2), int64Ptr(8), boolPtr(true))
	if err != nil {
		t.Fatalf("CreateRole: %v", err)
	}

	creates := pub.ofType(eventTypeRoleCreate)
	if len(creates) != 1 {
		t.Fatalf("expected 1 GUILD_ROLE_CREATE event, got %d", len(creates))
	}
	if creates[0].GuildID != g.ID {
		t.Errorf("event guild_id = %s, want %s", creates[0].GuildID, g.ID)
	}

	// Update role
	rid, _ := snowflake.Parse(created.ID)
	_, err = svc.UpdateRole(ctx, owner, gid, rid, strPtr("TesterUpdated"), nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}

	updates := pub.ofType(eventTypeRoleUpdate)
	if len(updates) != 1 {
		t.Fatalf("expected 1 GUILD_ROLE_UPDATE event, got %d", len(updates))
	}

	// Delete role
	if err := svc.DeleteRole(ctx, owner, gid, rid); err != nil {
		t.Fatalf("DeleteRole: %v", err)
	}

	deletes := pub.ofType(eventTypeRoleDelete)
	if len(deletes) != 1 {
		t.Fatalf("expected 1 GUILD_ROLE_DELETE event, got %d", len(deletes))
	}
}

// recordingPublisher captures published events for member-lifecycle asserts.
type recordingPublisher struct {
	seen []events.Event
}

func (p *recordingPublisher) Publish(_ context.Context, e events.Event) error {
	p.seen = append(p.seen, e)
	return nil
}

func (p *recordingPublisher) ofType(t string) []events.Event {
	var out []events.Event
	for _, e := range p.seen {
		if e.Type == t {
			out = append(out, e)
		}
	}
	return out
}

func TestMemberLifecycleEvents(t *testing.T) {
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
	prefix := "t" + hex.EncodeToString(b[:])
	t.Cleanup(func() {
		db.Exec("DELETE FROM guilds WHERE name LIKE $1", prefix+"%")
		db.Exec("DELETE FROM users WHERE username LIKE $1", prefix+"%")
		db.Close()
	})
	node, _ := snowflake.NewNode(997)

	pub := &recordingPublisher{}
	svc := NewService(db, node, pub)
	ctx := context.Background()

	owner := createTestUser(t, db, node, prefix, "own")
	joiner := createTestUser(t, db, node, prefix, "joi")
	kicked := createTestUser(t, db, node, prefix, "kck")

	g, err := svc.CreateGuild(ctx, owner, prefix+"hq")
	if err != nil {
		t.Fatalf("CreateGuild: %v", err)
	}
	gid, _ := snowflake.Parse(g.ID)
	ch, err := svc.CreateChannel(ctx, owner, gid, 0, prefix+"general", 0, nil)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	chid, _ := snowflake.Parse(ch.ID)

	// 1. Owner adds a member -> exactly one GUILD_MEMBER_ADD with full payload
	if err := svc.AddMember(ctx, owner, gid, kicked); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	adds := pub.ofType(eventTypeMemberAdd)
	if len(adds) != 1 {
		t.Fatalf("AddMember published %d ADD events, want 1", len(adds))
	}
	if adds[0].GuildID != g.ID {
		t.Errorf("ADD guild_id = %s, want %s", adds[0].GuildID, g.ID)
	}
	payload, ok := adds[0].Payload.(memberAddPayload)
	if !ok {
		t.Fatalf("ADD payload type = %T, want memberAddPayload", adds[0].Payload)
	}
	if payload.User.ID != fmt.Sprint(kicked) || payload.User.Username == "" {
		t.Errorf("ADD user = %+v, want id=%d with username", payload.User, kicked)
	}
	if payload.Roles == nil {
		t.Error("ADD roles must be present (empty slice), not nil")
	}
	if payload.JoinedAt.IsZero() {
		t.Error("ADD joined_at must be set")
	}

	// 2. Idempotent re-add: no duplicate event
	if err := svc.AddMember(ctx, owner, gid, kicked); err != nil {
		t.Fatalf("AddMember(idempotent): %v", err)
	}
	if got := len(pub.ofType(eventTypeMemberAdd)); got != 1 {
		t.Errorf("re-add published %d ADD events total, want 1", got)
	}

	// 3. Invite join -> one more ADD (different user)
	inv, err := svc.CreateInvite(ctx, owner, chid, 0, 0)
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if _, err := svc.JoinInvite(ctx, joiner, inv.Code); err != nil {
		t.Fatalf("JoinInvite: %v", err)
	}
	adds = pub.ofType(eventTypeMemberAdd)
	if len(adds) != 2 {
		t.Fatalf("JoinInvite published %d ADD events total, want 2", len(adds))
	}
	if adds[1].Payload.(memberAddPayload).User.ID != fmt.Sprint(joiner) {
		t.Errorf("join ADD user = %+v, want id=%d", adds[1].Payload, joiner)
	}

	// 4. Already-member join: no-op, no event
	if _, err := svc.JoinInvite(ctx, joiner, inv.Code); err != nil {
		t.Fatalf("JoinInvite(already member): %v", err)
	}
	if got := len(pub.ofType(eventTypeMemberAdd)); got != 2 {
		t.Errorf("already-member join published %d ADD events total, want 2", got)
	}

	// 5. Kick -> one GUILD_MEMBER_REMOVE
	if err := svc.RemoveMember(ctx, owner, gid, kicked); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	removes := pub.ofType(eventTypeMemberRemove)
	if len(removes) != 1 {
		t.Fatalf("RemoveMember published %d REMOVE events, want 1", len(removes))
	}
	rp, ok := removes[0].Payload.(memberRemovePayload)
	if !ok {
		t.Fatalf("REMOVE payload type = %T, want memberRemovePayload", removes[0].Payload)
	}
	if rp.GuildID != g.ID || rp.User.ID != fmt.Sprint(kicked) {
		t.Errorf("REMOVE payload = %+v, want guild %s user %d", rp, g.ID, kicked)
	}

	// 6. Remove non-member: error, no event
	if err := svc.RemoveMember(ctx, owner, gid, kicked); !errors.Is(err, ErrUnknownMember) {
		t.Errorf("RemoveMember(unknown) = %v, want ErrUnknownMember", err)
	}
	if got := len(pub.ofType(eventTypeMemberRemove)); got != 1 {
		t.Errorf("unknown remove published %d REMOVE events total, want 1", got)
	}
}
