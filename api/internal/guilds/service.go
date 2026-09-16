// Package guilds implements guild/channel/member CRUD and invites.
//
// Permission checks are deliberately crude (owner vs member) until
// pkg/permissions lands in Phase 4 — every check routes through
// requireOwner/requireMember, the seam where Resolve() will plug in.
package guilds

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/pkg/permissions"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

// Entity errors — mapped to Discord error codes in the handler.
// The numeric registry moves to pkg/errs in #8.
var (
	ErrUnknownGuild       = errors.New("guilds: unknown guild")
	ErrUnknownChannel     = errors.New("guilds: unknown channel")
	ErrUnknownInvite      = errors.New("guilds: unknown invite")
	ErrUnknownMember      = errors.New("guilds: unknown member")
	ErrUnknownRole        = errors.New("guilds: unknown role")
	ErrUnknownUser        = errors.New("guilds: unknown user")
	ErrMissingAccess      = errors.New("guilds: missing access")
	ErrMissingPermissions = errors.New("guilds: missing permissions")
)

// Service owns all guild-domain persistence.
type Service struct {
	db  *sql.DB
	sf  *snowflake.Node
	pub events.Publisher
}

func NewService(db *sql.DB, sf *snowflake.Node, pub events.Publisher) *Service {
	return &Service{db: db, sf: sf, pub: pub}
}

// Member lifecycle events (plan/01 §3). The gateway routes these generically
// by guild_id — subscribers learn about joins/leaves in real time, which the
// member sidebar (op 8 snapshot) otherwise could not.
const (
	eventTypeMemberAdd         = "GUILD_MEMBER_ADD"
	eventTypeMemberRemove      = "GUILD_MEMBER_REMOVE"
	eventTypeGuildMemberUpdate = "GUILD_MEMBER_UPDATE"
	eventTypeRoleCreate        = "GUILD_ROLE_CREATE"
	eventTypeRoleUpdate        = "GUILD_ROLE_UPDATE"
	eventTypeRoleDelete        = "GUILD_ROLE_DELETE"
	eventTypeChannelUpdate     = "CHANNEL_UPDATE"
	eventVersion               = 1
)

// memberAddPayload mirrors the GUILD_MEMBERS_CHUNK member shape so clients
// handle both with the same code path.
type memberAddPayload struct {
	GuildID  string    `json:"guild_id"`
	User     UserRef   `json:"user"`
	Nick     *string   `json:"nick"`
	Roles    []string  `json:"roles"`
	JoinedAt time.Time `json:"joined_at"`
}

type memberRemovePayload struct {
	GuildID string  `json:"guild_id"`
	User    UserRef `json:"user"`
}

type memberUpdateEventPayload struct {
	GuildID string   `json:"guild_id"`
	Roles   []string `json:"roles"`
	User    UserRef  `json:"user"`
	Nick    *string  `json:"nick"`
}

type roleEventPayload struct {
	GuildID string `json:"guild_id"`
	Role    Role   `json:"role"`
}

type roleDeleteEventPayload struct {
	GuildID string `json:"guild_id"`
	RoleID  string `json:"role_id"`
}

type channelUpdateEventPayload struct {
	GuildID              string             `json:"guild_id"`
	Channel              Channel            `json:"channel"`
	PermissionOverwrites []ChannelOverwrite `json:"permission_overwrites"`
}

// ── types (wire shapes; IDs are strings like Discord) ─────────────────────

type Guild struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}

type Channel struct {
	ID        string    `json:"id"`
	GuildID   string    `json:"guild_id"`
	Type      int16     `json:"type"`
	Name      string    `json:"name"`
	Position  int32     `json:"position"`
	ParentID  *string   `json:"parent_id"`
	CreatedAt time.Time `json:"created_at"`
}

type UserRef struct {
	ID            string `json:"id"`
	Username      string `json:"username"`
	Discriminator string `json:"discriminator"`
}

type Member struct {
	User     UserRef   `json:"user"`
	Nick     *string   `json:"nick"`
	JoinedAt time.Time `json:"joined_at"`
}

type GuildRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ChannelRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type int16  `json:"type"`
}

type Invite struct {
	Code      string     `json:"code"`
	Guild     GuildRef   `json:"guild"`
	Channel   ChannelRef `json:"channel"`
	Inviter   UserRef    `json:"inviter"`
	Uses      int32      `json:"uses"`
	MaxUses   int32      `json:"max_uses"`
	ExpiresAt *time.Time `json:"expires_at"`
}

type Role struct {
	ID          string    `json:"id"`
	GuildID     string    `json:"guild_id"`
	Name        string    `json:"name"`
	Color       int32     `json:"color"`
	Hoist       bool      `json:"hoist"`
	Position    int32     `json:"position"`
	Permissions string    `json:"permissions"`
	Mentionable bool      `json:"mentionable"`
	CreatedAt   time.Time `json:"created_at"`
}

type ChannelOverwrite struct {
	ChannelID  string `json:"channel_id"`
	TargetID   string `json:"target_id"`
	TargetType int16  `json:"type"` // 0 role, 1 member
	Allow      string `json:"allow"`
	Deny       string `json:"deny"`
}

// ── permission seams (Phase 4: pkg/permissions.Resolve) ───────────────────

func (s *Service) requireMember(ctx context.Context, guildID, userID int64) error {
	var member bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`,
		guildID, userID).Scan(&member)
	if err != nil {
		return err
	}
	if !member {
		return ErrMissingAccess
	}
	return nil
}

// Phase 4: "owner" becomes MANAGE_GUILD/permission-bitfield resolution.
func (s *Service) requireOwner(ctx context.Context, guildID, userID int64) error {
	var ownerID int64
	err := s.db.QueryRowContext(ctx,
		`SELECT owner_id FROM guilds WHERE id = $1`, guildID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownGuild
	}
	if err != nil {
		return err
	}
	if ownerID != userID {
		return ErrMissingPermissions
	}
	return nil
}

// ── guilds ────────────────────────────────────────────────────────────────

// CreateGuild creates a guild and makes the creator owner + first member,
// atomically.
func (s *Service) CreateGuild(ctx context.Context, ownerID int64, name string) (*Guild, error) {
	id, err := s.sf.Generate()
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var g Guild
	err = tx.QueryRowContext(ctx, `
		INSERT INTO guilds (id, name, owner_id)
		VALUES ($1, $2, $3)
		RETURNING id::text, name, owner_id::text, created_at`,
		id, name, ownerID).Scan(&g.ID, &g.Name, &g.OwnerID, &g.CreatedAt)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO members (guild_id, user_id) VALUES ($1, $2)`, id, ownerID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable)
		 VALUES ($1, $1, '@everyone', 0, false, 0, $2, false)`,
		id, permissions.DEFAULT_EVERYONE_PERMISSIONS); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &g, nil
}

// GetGuild returns a guild the user is a member of.
func (s *Service) GetGuild(ctx context.Context, userID, guildID int64) (*Guild, error) {
	var g Guild
	err := s.db.QueryRowContext(ctx, `
		SELECT id::text, name, owner_id::text, created_at
		FROM guilds WHERE id = $1`, guildID,
	).Scan(&g.ID, &g.Name, &g.OwnerID, &g.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownGuild
	}
	if err != nil {
		return nil, err
	}
	if err := s.requireMember(ctx, guildID, userID); err != nil {
		return nil, err
	}
	return &g, nil
}

// UpdateGuild renames a guild (owner only until Phase 4).
func (s *Service) UpdateGuild(ctx context.Context, userID, guildID int64, name string) (*Guild, error) {
	if err := s.requireOwner(ctx, guildID, userID); err != nil {
		return nil, err
	}
	var g Guild
	err := s.db.QueryRowContext(ctx, `
		UPDATE guilds SET name = $2
		WHERE id = $1
		RETURNING id::text, name, owner_id::text, created_at`,
		guildID, name).Scan(&g.ID, &g.Name, &g.OwnerID, &g.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownGuild
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

// MyGuilds lists guilds the user belongs to ("my guilds" query, members(user_id) index).
func (s *Service) MyGuilds(ctx context.Context, userID int64) ([]Guild, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT g.id::text, g.name, g.owner_id::text, g.created_at
		FROM members m
		JOIN guilds g ON g.id = m.guild_id
		WHERE m.user_id = $1
		ORDER BY g.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	guilds := []Guild{}
	for rows.Next() {
		var g Guild
		if err := rows.Scan(&g.ID, &g.Name, &g.OwnerID, &g.CreatedAt); err != nil {
			return nil, err
		}
		guilds = append(guilds, g)
	}
	return guilds, rows.Err()
}

// ── channels ──────────────────────────────────────────────────────────────

func (s *Service) ListChannels(ctx context.Context, userID, guildID int64) ([]Channel, error) {
	state, err := s.getMemberRoleState(ctx, guildID, userID)
	if err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, guild_id::text, type, name, position, parent_id, created_at
		FROM channels
		WHERE guild_id = $1
		ORDER BY type, position, id`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	allChannels := []Channel{}
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		allChannels = append(allChannels, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Owner or ADMINISTRATOR can view all channels
	if state.IsOwner || permissions.Has(state.Permissions, permissions.ADMINISTRATOR) {
		return allChannels, nil
	}

	overwritesByChannel, err := s.getGuildChannelOverwrites(ctx, guildID)
	if err != nil {
		return nil, err
	}

	visibleChannels := make([]Channel, 0, len(allChannels))
	for _, c := range allChannels {
		cid, err := snowflake.Parse(c.ID)
		if err != nil {
			continue
		}
		resolved := permissions.Resolve(guildID, 0, userID, state.Roles, overwritesByChannel[cid])
		if permissions.Has(resolved, permissions.VIEW_CHANNEL) {
			visibleChannels = append(visibleChannels, c)
		}
	}

	return visibleChannels, nil
}

// CreateChannel adds a channel to a guild. Requires MANAGE_CHANNELS, ADMINISTRATOR, or owner.
// Text-channel names are normalized Discord-style: lowercase, spaces→dashes.
func (s *Service) CreateChannel(ctx context.Context, userID, guildID int64, chType int16, name string, position int32, parentID *int64) (*Channel, error) {
	state, err := s.getMemberRoleState(ctx, guildID, userID)
	if err != nil {
		return nil, err
	}
	if !state.IsOwner && !permissions.Has(state.Permissions, permissions.ADMINISTRATOR) && !permissions.Has(state.Permissions, permissions.MANAGE_CHANNELS) {
		return nil, ErrMissingPermissions
	}
	id, err := s.sf.Generate()
	if err != nil {
		return nil, err
	}
	name = normalizeChannelName(name, chType)
	var parent sql.NullInt64
	if parentID != nil {
		parent = sql.NullInt64{Int64: *parentID, Valid: true}
	}
	var c Channel
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO channels (id, guild_id, type, name, position, parent_id)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id::text, guild_id::text, type, name, position, parent_id, created_at`,
		id, guildID, chType, name, position, parent).Scan(
		&c.ID, &c.GuildID, &c.Type, &c.Name, &c.Position, &parent, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	c.ParentID = idPtr(parent)
	return &c, nil
}

// UpdateChannel patches a channel's name/position/parent. Requires MANAGE_CHANNELS, ADMINISTRATOR, or owner.
func (s *Service) UpdateChannel(ctx context.Context, userID, guildID, channelID int64, name *string, position *int32, parentID *int64) (*Channel, error) {
	chGid, perms, _, isOwner, err := s.getChannelGuildAndPerms(ctx, channelID, userID)
	if err != nil {
		return nil, err
	}
	if guildID > 0 && chGid != guildID {
		return nil, ErrUnknownChannel
	}
	guildID = chGid

	if !isOwner && !permissions.Has(perms, permissions.ADMINISTRATOR) && !permissions.Has(perms, permissions.MANAGE_CHANNELS) {
		return nil, ErrMissingPermissions
	}

	var nameNull sql.NullString
	if name != nil {
		nameNull = sql.NullString{String: *name, Valid: true}
	}
	var posNull sql.NullInt32
	if position != nil {
		posNull = sql.NullInt32{Int32: *position, Valid: true}
	}
	var parentNull sql.NullInt64
	if parentID != nil {
		parentNull = sql.NullInt64{Int64: *parentID, Valid: true}
	}
	var c Channel
	var parent sql.NullInt64
	err = s.db.QueryRowContext(ctx, `
		UPDATE channels
		SET name = COALESCE($3::text, name),
		    position = COALESCE($4::integer, position),
		    parent_id = COALESCE($5::bigint, parent_id)
		WHERE id = $1 AND guild_id = $2
		RETURNING id::text, guild_id::text, type, name, position, parent_id, created_at`,
		channelID, guildID, nameNull, posNull, parentNull).Scan(
		&c.ID, &c.GuildID, &c.Type, &c.Name, &c.Position, &parent, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownChannel
	}
	if err != nil {
		return nil, err
	}
	c.ParentID = idPtr(parent)
	return &c, nil
}

// DeleteChannel removes a channel. Requires MANAGE_CHANNELS, ADMINISTRATOR, or owner.
func (s *Service) DeleteChannel(ctx context.Context, userID, guildID, channelID int64) error {
	chGid, perms, _, isOwner, err := s.getChannelGuildAndPerms(ctx, channelID, userID)
	if err != nil {
		return err
	}
	if guildID > 0 && chGid != guildID {
		return ErrUnknownChannel
	}
	guildID = chGid

	if !isOwner && !permissions.Has(perms, permissions.ADMINISTRATOR) && !permissions.Has(perms, permissions.MANAGE_CHANNELS) {
		return ErrMissingPermissions
	}

	res, err := s.db.ExecContext(ctx,
		`DELETE FROM channels WHERE id = $1 AND guild_id = $2`, channelID, guildID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownChannel
	}
	return nil
}

// ── members ───────────────────────────────────────────────────────────────

func (s *Service) ListMembers(ctx context.Context, userID, guildID int64) ([]Member, error) {
	if err := s.requireMember(ctx, guildID, userID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id::text, u.username, to_char(u.discriminator, 'FM0000'),
		       m.nickname, m.joined_at
		FROM members m
		JOIN users u ON u.id = m.user_id
		WHERE m.guild_id = $1
		ORDER BY m.joined_at, u.id`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := []Member{}
	for rows.Next() {
		var m Member
		var nick sql.NullString
		if err := rows.Scan(&m.User.ID, &m.User.Username, &m.User.Discriminator, &nick, &m.JoinedAt); err != nil {
			return nil, err
		}
		if nick.Valid {
			m.Nick = &nick.String
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

// AddMember puts a user into a guild (owner only until Phase 4; idempotent).
// Publishes GUILD_MEMBER_ADD only when the insert actually happened — the
// idempotent re-add path is a no-op, not an event.
func (s *Service) AddMember(ctx context.Context, actorID, guildID, targetID int64) error {
	if err := s.requireOwner(ctx, guildID, actorID); err != nil {
		return err
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, targetID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrUnknownUser
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO members (guild_id, user_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, guildID, targetID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil
	}
	s.publishMemberAdd(ctx, guildID, targetID)
	return nil
}

// publishMemberAdd builds the ADD payload from the committed row and fans it
// out after the fact. Publish failures are logged, not fatal — the row is
// committed truth (same policy as the messages service).
func (s *Service) publishMemberAdd(ctx context.Context, guildID, userID int64) {
	var p memberAddPayload
	p.GuildID = strconv.FormatInt(guildID, 10)
	err := s.db.QueryRowContext(ctx, `
		SELECT u.id::text, u.username, to_char(u.discriminator, 'FM0000'),
		       m.nickname, m.joined_at
		FROM members m
		JOIN users u ON u.id = m.user_id
		WHERE m.guild_id = $1 AND m.user_id = $2`, guildID, userID,
	).Scan(&p.User.ID, &p.User.Username, &p.User.Discriminator, &p.Nick, &p.JoinedAt)
	if err != nil {
		slog.ErrorContext(ctx, "failed to build member_add payload",
			"guild_id", guildID, "user_id", userID, "error", err)
		return
	}
	p.Roles = []string{}
	if err := s.pub.Publish(ctx, events.Event{
		Type:    eventTypeMemberAdd,
		Version: eventVersion,
		GuildID: p.GuildID,
		Payload: p,
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish event",
			"type", eventTypeMemberAdd, "guild_id", p.GuildID, "error", err)
	}
}

// RemoveMember kicks (owner) or self-leaves. The owner is untouchable.
func (s *Service) RemoveMember(ctx context.Context, actorID, guildID, targetID int64) error {
	var ownerID int64
	err := s.db.QueryRowContext(ctx,
		`SELECT owner_id FROM guilds WHERE id = $1`, guildID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownGuild
	}
	if err != nil {
		return err
	}
	if targetID == ownerID {
		return ErrMissingPermissions // owner cannot be removed; delete guild instead (later)
	}
	if actorID != targetID && actorID != ownerID {
		return ErrMissingPermissions // only the owner kicks
	}
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM members WHERE guild_id = $1 AND user_id = $2`, guildID, targetID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownMember
	}

	s.publishMemberRemove(ctx, guildID, targetID)
	return nil
}

func (s *Service) publishMemberRemove(ctx context.Context, guildID, userID int64) {
	gid := strconv.FormatInt(guildID, 10)
	uid := strconv.FormatInt(userID, 10)
	if err := s.pub.Publish(ctx, events.Event{
		Type:    eventTypeMemberRemove,
		Version: eventVersion,
		GuildID: gid,
		Payload: memberRemovePayload{
			GuildID: gid,
			User:    UserRef{ID: uid},
		},
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish event",
			"type", eventTypeMemberRemove, "guild_id", gid, "error", err)
	}
}

// ── invites ───────────────────────────────────────────────────────────────

const inviteAlphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// CreateInvite issues an invite for a channel. Any guild member can create
// one (Discord's @everyone default grants CREATE_INVITE).
func (s *Service) CreateInvite(ctx context.Context, inviterID, channelID int64, maxAge time.Duration, maxUses int32) (*Invite, error) {
	var guildID int64
	var chName string
	var chType int16
	err := s.db.QueryRowContext(ctx,
		`SELECT guild_id, name, type FROM channels WHERE id = $1`, channelID,
	).Scan(&guildID, &chName, &chType)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownChannel
	}
	if err != nil {
		return nil, err
	}
	if err := s.requireMember(ctx, guildID, inviterID); err != nil {
		return nil, err
	}

	var expires any // nil ⇒ never expires
	if maxAge > 0 {
		expires = time.Now().Add(maxAge)
	}

	var code string
	for range 5 {
		c, err := randomInviteCode()
		if err != nil {
			return nil, err
		}
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO invites (code, guild_id, channel_id, inviter_id, uses, max_uses, expires_at)
			VALUES ($1, $2, $3, $4, 0, $5, $6)`,
			c, guildID, channelID, inviterID, maxUses, expires)
		if err == nil {
			code = c
			break
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
			return nil, err
		}
		// code collision (astronomically unlikely) — retry
	}
	if code == "" {
		return nil, errors.New("guilds: invite code collision")
	}
	return s.inviteByCode(ctx, code)
}

// JoinInvite consumes an invite: enforces max_uses and expires_at, bumps
// uses, and inserts the member row — atomically. Re-joining a guild you are
// already in is a no-op that does not consume a use.
func (s *Service) JoinInvite(ctx context.Context, userID int64, code string) (*Guild, error) {
	var guildID int64
	err := s.db.QueryRowContext(ctx,
		`SELECT guild_id FROM invites WHERE code = $1`, code).Scan(&guildID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownInvite
	}
	if err != nil {
		return nil, err
	}

	// Already a member ⇒ no-op, no use consumed.
	if err := s.requireMember(ctx, guildID, userID); err == nil {
		return s.guildByID(ctx, guildID)
	} else if !errors.Is(err, ErrMissingAccess) {
		return nil, err
	}

	err = s.db.QueryRowContext(ctx, `
		WITH bumped AS (
			UPDATE invites SET uses = uses + 1
			WHERE code = $1
			  AND (max_uses = 0 OR uses < max_uses)
			  AND (expires_at IS NULL OR expires_at > now())
			RETURNING guild_id
		)
		INSERT INTO members (guild_id, user_id)
		SELECT guild_id, $2 FROM bumped
		ON CONFLICT DO NOTHING
		RETURNING guild_id`, code, userID).Scan(&guildID)
	if errors.Is(err, sql.ErrNoRows) {
		// Lost a race to ourselves (concurrent join) or the invite is
		// exhausted/expired — the former means we are a member now.
		if member, _ := s.isMember(ctx, guildID, userID); member {
			return s.guildByID(ctx, guildID)
		}
		return nil, ErrUnknownInvite
	}
	if err != nil {
		return nil, err
	}

	// The RETURNING insert fired — this call is the one that joined.
	s.publishMemberAdd(ctx, guildID, userID)
	return s.guildByID(ctx, guildID)
}

func (s *Service) guildByID(ctx context.Context, guildID int64) (*Guild, error) {
	var g Guild
	err := s.db.QueryRowContext(ctx, `
		SELECT id::text, name, owner_id::text, created_at
		FROM guilds WHERE id = $1`, guildID,
	).Scan(&g.ID, &g.Name, &g.OwnerID, &g.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownGuild
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

func (s *Service) inviteByCode(ctx context.Context, code string) (*Invite, error) {
	var inv Invite
	var expires sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT i.code,
		       g.id::text, g.name,
		       c.id::text, c.name, c.type,
		       u.id::text, u.username, to_char(u.discriminator, 'FM0000'),
		       i.uses, i.max_uses, i.expires_at
		FROM invites i
		JOIN guilds g ON g.id = i.guild_id
		JOIN channels c ON c.id = i.channel_id
		JOIN users u ON u.id = i.inviter_id
		WHERE i.code = $1`, code,
	).Scan(&inv.Code, &inv.Guild.ID, &inv.Guild.Name,
		&inv.Channel.ID, &inv.Channel.Name, &inv.Channel.Type,
		&inv.Inviter.ID, &inv.Inviter.Username, &inv.Inviter.Discriminator,
		&inv.Uses, &inv.MaxUses, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownInvite
	}
	if err != nil {
		return nil, err
	}
	if expires.Valid {
		inv.ExpiresAt = &expires.Time
	}
	return &inv, nil
}

func (s *Service) isMember(ctx context.Context, guildID, userID int64) (bool, error) {
	var member bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`,
		guildID, userID).Scan(&member)
	return member, err
}

// ── scan helpers ──────────────────────────────────────────────────────────

func scanChannel(rows *sql.Rows) (Channel, error) {
	var c Channel
	var parent sql.NullInt64
	if err := rows.Scan(&c.ID, &c.GuildID, &c.Type, &c.Name, &c.Position, &parent, &c.CreatedAt); err != nil {
		return c, err
	}
	c.ParentID = idPtr(parent)
	return c, nil
}

func idPtr(n sql.NullInt64) *string {
	if !n.Valid {
		return nil
	}
	s := strconv.FormatInt(n.Int64, 10)
	return &s
}

// normalizeChannelName applies Discord's text-channel rules: lowercase,
// spaces become dashes. Voice channels keep their casing.
func normalizeChannelName(name string, chType int16) string {
	name = strings.TrimSpace(name)
	if chType == 0 {
		name = strings.ToLower(strings.ReplaceAll(name, " ", "-"))
	}
	return name
}

func randomInviteCode() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, 8)
	for i, v := range b {
		out[i] = inviteAlphabet[int(v)%len(inviteAlphabet)]
	}
	return string(out), nil
}

// ── roles ─────────────────────────────────────────────────────────────────

func (s *Service) ListRoles(ctx context.Context, userID, guildID int64) ([]Role, error) {
	if err := s.requireMember(ctx, guildID, userID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id::text, guild_id::text, name, color, hoist, position, permissions::text, mentionable, created_at
		FROM roles
		WHERE guild_id = $1
		ORDER BY position DESC, id ASC`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	roles := []Role{}
	for rows.Next() {
		var r Role
		if err := rows.Scan(&r.ID, &r.GuildID, &r.Name, &r.Color, &r.Hoist, &r.Position, &r.Permissions, &r.Mentionable, &r.CreatedAt); err != nil {
			return nil, err
		}
		roles = append(roles, r)
	}
	return roles, rows.Err()
}

type memberRoleState struct {
	IsOwner         bool
	HighestPosition int32
	Permissions     uint64
	Roles           []permissions.Role
}

func (s *Service) getMemberRoleState(ctx context.Context, guildID, userID int64) (*memberRoleState, error) {
	var ownerID int64
	err := s.db.QueryRowContext(ctx, `SELECT owner_id FROM guilds WHERE id = $1`, guildID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownGuild
	}
	if err != nil {
		return nil, err
	}

	if userID == ownerID {
		return &memberRoleState{
			IsOwner:         true,
			HighestPosition: math.MaxInt32,
			Permissions:     permissions.ALL_PERMISSIONS,
			Roles:           nil,
		}, nil
	}

	// Verify member belongs to guild
	var isMember bool
	err = s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`,
		guildID, userID).Scan(&isMember)
	if err != nil {
		return nil, err
	}
	if !isMember {
		return nil, ErrMissingAccess
	}

	// Query caller's roles: @everyone (id == guildID) + assigned roles
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.id, r.position, r.permissions
		FROM roles r
		WHERE r.id = $1 AND r.guild_id = $1
		UNION
		SELECT r.id, r.position, r.permissions
		FROM roles r
		JOIN member_roles mr ON mr.role_id = r.id
		WHERE mr.guild_id = $1 AND mr.user_id = $2`,
		guildID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	callerRoles := make([]permissions.Role, 0)
	var highestPos int32 = 0
	var callerPerms uint64 = 0
	var hasEveryone bool
	for rows.Next() {
		var rid int64
		var pos int32
		var p uint64
		if err := rows.Scan(&rid, &pos, &p); err != nil {
			return nil, err
		}
		if rid == guildID {
			hasEveryone = true
		}
		if pos > highestPos {
			highestPos = pos
		}
		callerPerms |= p
		callerRoles = append(callerRoles, permissions.Role{
			ID:          rid,
			GuildID:     guildID,
			Position:    int(pos),
			Permissions: p,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if !hasEveryone {
		callerRoles = append(callerRoles, permissions.Role{
			ID:          guildID,
			GuildID:     guildID,
			Position:    0,
			Permissions: permissions.DEFAULT_EVERYONE_PERMISSIONS,
		})
		callerPerms |= permissions.DEFAULT_EVERYONE_PERMISSIONS
	}

	if permissions.Has(callerPerms, permissions.ADMINISTRATOR) {
		callerPerms = permissions.ALL_PERMISSIONS
	}

	return &memberRoleState{
		IsOwner:         false,
		HighestPosition: highestPos,
		Permissions:     callerPerms,
		Roles:           callerRoles,
	}, nil
}

func (s *Service) getChannelOverwrites(ctx context.Context, channelID int64) ([]permissions.Overwrite, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT channel_id, target_id, target_type, allow, deny
		FROM channel_overwrites
		WHERE channel_id = $1`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var overwrites []permissions.Overwrite
	for rows.Next() {
		var cid, tid int64
		var ttype int16
		var a, d uint64
		if err := rows.Scan(&cid, &tid, &ttype, &a, &d); err != nil {
			return nil, err
		}
		overwrites = append(overwrites, permissions.Overwrite{
			ChannelID:  cid,
			TargetID:   tid,
			TargetType: permissions.TargetType(ttype),
			Allow:      a,
			Deny:       d,
		})
	}
	return overwrites, rows.Err()
}

func (s *Service) getGuildChannelOverwrites(ctx context.Context, guildID int64) (map[int64][]permissions.Overwrite, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT co.channel_id, co.target_id, co.target_type, co.allow, co.deny
		FROM channel_overwrites co
		JOIN channels c ON c.id = co.channel_id
		WHERE c.guild_id = $1`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	overwritesByChannel := make(map[int64][]permissions.Overwrite)
	for rows.Next() {
		var cid, tid int64
		var ttype int16
		var a, d uint64
		if err := rows.Scan(&cid, &tid, &ttype, &a, &d); err != nil {
			return nil, err
		}
		overwritesByChannel[cid] = append(overwritesByChannel[cid], permissions.Overwrite{
			ChannelID:  cid,
			TargetID:   tid,
			TargetType: permissions.TargetType(ttype),
			Allow:      a,
			Deny:       d,
		})
	}
	return overwritesByChannel, rows.Err()
}

func canManageRoles(state *memberRoleState) bool {
	if state.IsOwner {
		return true
	}
	return permissions.Has(state.Permissions, permissions.ADMINISTRATOR) ||
		permissions.Has(state.Permissions, permissions.MANAGE_ROLES) ||
		permissions.Has(state.Permissions, permissions.MANAGE_GUILD)
}

func (s *Service) CreateRole(ctx context.Context, userID, guildID int64, name string, color *int32, hoist *bool, position *int32, permsArg *int64, mentionable *bool) (*Role, error) {
	state, err := s.getMemberRoleState(ctx, guildID, userID)
	if err != nil {
		return nil, err
	}
	if !canManageRoles(state) {
		return nil, ErrMissingPermissions
	}

	// Hierarchy invariant: caller cannot create a role with position >= caller's highest position
	if !state.IsOwner {
		if position != nil && *position >= state.HighestPosition {
			return nil, ErrMissingPermissions
		}
	}

	// Escalation prevention: caller cannot grant permissions they do not possess
	if permsArg != nil && !state.IsOwner && !permissions.Has(state.Permissions, permissions.ADMINISTRATOR) {
		requested := uint64(*permsArg)
		if (requested & ^state.Permissions) != 0 {
			return nil, ErrMissingPermissions
		}
	}

	id, err := s.sf.Generate()
	if err != nil {
		return nil, err
	}
	var c int32
	if color != nil {
		c = *color
	}
	var h bool
	if hoist != nil {
		h = *hoist
	}
	var pos int32
	if position != nil {
		pos = *position
	} else {
		pos = 1
		if !state.IsOwner && pos >= state.HighestPosition {
			return nil, ErrMissingPermissions
		}
	}
	var perms int64
	if permsArg != nil {
		perms = *permsArg
	}
	var men bool
	if mentionable != nil {
		men = *mentionable
	}

	var r Role
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id::text, guild_id::text, name, color, hoist, position, permissions::text, mentionable, created_at`,
		id, guildID, name, c, h, pos, perms, men).Scan(
		&r.ID, &r.GuildID, &r.Name, &r.Color, &r.Hoist, &r.Position, &r.Permissions, &r.Mentionable, &r.CreatedAt)
	if err != nil {
		return nil, err
	}

	s.publishRoleCreate(ctx, guildID, &r)
	return &r, nil
}

func (s *Service) UpdateRole(ctx context.Context, userID, guildID, roleID int64, name *string, color *int32, hoist *bool, position *int32, permsArg *int64, mentionable *bool) (*Role, error) {
	state, err := s.getMemberRoleState(ctx, guildID, userID)
	if err != nil {
		return nil, err
	}
	if !canManageRoles(state) {
		return nil, ErrMissingPermissions
	}

	var targetPos int32
	var targetName string
	err = s.db.QueryRowContext(ctx, `SELECT position, name FROM roles WHERE id = $1 AND guild_id = $2`, roleID, guildID).Scan(&targetPos, &targetName)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownRole
	}
	if err != nil {
		return nil, err
	}

	isEveryone := (roleID == guildID)

	// Hierarchy check: cannot edit role at or above caller's highest position
	if !state.IsOwner {
		if targetPos >= state.HighestPosition {
			return nil, ErrMissingPermissions
		}
		if position != nil && *position >= state.HighestPosition {
			return nil, ErrMissingPermissions
		}
	}

	// @everyone invariants: cannot be repositioned (must remain 0), cannot be hoisted
	if isEveryone {
		if position != nil && *position != 0 {
			return nil, ErrMissingPermissions
		}
		if hoist != nil && *hoist {
			return nil, ErrMissingPermissions
		}
	}

	// Escalation prevention: cannot grant permissions the caller does not hold
	if permsArg != nil && !state.IsOwner && !permissions.Has(state.Permissions, permissions.ADMINISTRATOR) {
		requested := uint64(*permsArg)
		if (requested & ^state.Permissions) != 0 {
			return nil, ErrMissingPermissions
		}
	}

	var nameNull sql.NullString
	if name != nil {
		if isEveryone {
			nameNull = sql.NullString{String: "@everyone", Valid: true}
		} else {
			nameNull = sql.NullString{String: *name, Valid: true}
		}
	}
	var colorNull sql.NullInt32
	if color != nil {
		colorNull = sql.NullInt32{Int32: *color, Valid: true}
	}
	var hoistNull sql.NullBool
	if hoist != nil {
		hoistNull = sql.NullBool{Bool: *hoist, Valid: true}
	}
	var posNull sql.NullInt32
	if position != nil {
		posNull = sql.NullInt32{Int32: *position, Valid: true}
	}
	var permsNull sql.NullInt64
	if permsArg != nil {
		permsNull = sql.NullInt64{Int64: *permsArg, Valid: true}
	}
	var menNull sql.NullBool
	if mentionable != nil {
		menNull = sql.NullBool{Bool: *mentionable, Valid: true}
	}

	var r Role
	err = s.db.QueryRowContext(ctx, `
		UPDATE roles
		SET name = COALESCE($3::text, name),
		    color = COALESCE($4::integer, color),
		    hoist = COALESCE($5::boolean, hoist),
		    position = COALESCE($6::integer, position),
		    permissions = COALESCE($7::bigint, permissions),
		    mentionable = COALESCE($8::boolean, mentionable)
		WHERE id = $1 AND guild_id = $2
		RETURNING id::text, guild_id::text, name, color, hoist, position, permissions::text, mentionable, created_at`,
		roleID, guildID, nameNull, colorNull, hoistNull, posNull, permsNull, menNull).Scan(
		&r.ID, &r.GuildID, &r.Name, &r.Color, &r.Hoist, &r.Position, &r.Permissions, &r.Mentionable, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownRole
	}
	if err != nil {
		return nil, err
	}

	s.publishRoleUpdate(ctx, guildID, &r)
	return &r, nil
}

func (s *Service) DeleteRole(ctx context.Context, userID, guildID, roleID int64) error {
	// @everyone cannot be deleted
	if roleID == guildID {
		return ErrMissingPermissions
	}

	state, err := s.getMemberRoleState(ctx, guildID, userID)
	if err != nil {
		return err
	}
	if !canManageRoles(state) {
		return ErrMissingPermissions
	}

	var targetPos int32
	err = s.db.QueryRowContext(ctx, `SELECT position FROM roles WHERE id = $1 AND guild_id = $2`, roleID, guildID).Scan(&targetPos)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownRole
	}
	if err != nil {
		return err
	}

	// Hierarchy check: cannot delete role at or above caller's highest position
	if !state.IsOwner {
		if targetPos >= state.HighestPosition {
			return ErrMissingPermissions
		}
	}

	res, err := s.db.ExecContext(ctx,
		`DELETE FROM roles WHERE id = $1 AND guild_id = $2`, roleID, guildID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownRole
	}

	s.publishRoleDelete(ctx, guildID, roleID)
	return nil
}

func (s *Service) publishRoleCreate(ctx context.Context, guildID int64, role *Role) {
	gidStr := strconv.FormatInt(guildID, 10)
	if err := s.pub.Publish(ctx, events.Event{
		Type:    eventTypeRoleCreate,
		Version: eventVersion,
		GuildID: gidStr,
		Payload: roleEventPayload{
			GuildID: gidStr,
			Role:    *role,
		},
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish event",
			"type", eventTypeRoleCreate, "guild_id", gidStr, "err", err)
	}
}

func (s *Service) publishRoleUpdate(ctx context.Context, guildID int64, role *Role) {
	gidStr := strconv.FormatInt(guildID, 10)
	if err := s.pub.Publish(ctx, events.Event{
		Type:    eventTypeRoleUpdate,
		Version: eventVersion,
		GuildID: gidStr,
		Payload: roleEventPayload{
			GuildID: gidStr,
			Role:    *role,
		},
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish event",
			"type", eventTypeRoleUpdate, "guild_id", gidStr, "err", err)
	}
}

func (s *Service) publishRoleDelete(ctx context.Context, guildID, roleID int64) {
	gidStr := strconv.FormatInt(guildID, 10)
	ridStr := strconv.FormatInt(roleID, 10)
	if err := s.pub.Publish(ctx, events.Event{
		Type:    eventTypeRoleDelete,
		Version: eventVersion,
		GuildID: gidStr,
		Payload: roleDeleteEventPayload{
			GuildID: gidStr,
			RoleID:  ridStr,
		},
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish event",
			"type", eventTypeRoleDelete, "guild_id", gidStr, "err", err)
	}
}

func (s *Service) getTargetMemberHighestPos(ctx context.Context, guildID, targetUID int64) (int32, error) {
	var ownerID int64
	err := s.db.QueryRowContext(ctx, `SELECT owner_id FROM guilds WHERE id = $1`, guildID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrUnknownGuild
	}
	if err != nil {
		return 0, err
	}
	if targetUID == ownerID {
		return math.MaxInt32, nil
	}

	var isMember bool
	err = s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`,
		guildID, targetUID).Scan(&isMember)
	if err != nil {
		return 0, err
	}
	if !isMember {
		return 0, ErrUnknownMember
	}

	var highestPos int32 = 0
	err = s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(r.position), 0)
		FROM member_roles mr
		JOIN roles r ON mr.role_id = r.id
		WHERE mr.guild_id = $1 AND mr.user_id = $2`,
		guildID, targetUID).Scan(&highestPos)
	if err != nil {
		return 0, err
	}
	return highestPos, nil
}

func (s *Service) AssignMemberRole(ctx context.Context, callerID, guildID, targetUID, roleID int64) error {
	state, err := s.getMemberRoleState(ctx, guildID, callerID)
	if err != nil {
		return err
	}
	if !canManageRoles(state) {
		return ErrMissingPermissions
	}

	if roleID == guildID {
		return ErrMissingPermissions // cannot assign @everyone
	}

	var targetRolePos int32
	err = s.db.QueryRowContext(ctx, `SELECT position FROM roles WHERE id = $1 AND guild_id = $2`, roleID, guildID).Scan(&targetRolePos)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownRole
	}
	if err != nil {
		return err
	}

	targetMemberHighestPos, err := s.getTargetMemberHighestPos(ctx, guildID, targetUID)
	if err != nil {
		return err
	}

	// Hierarchy checks
	if !state.IsOwner {
		if targetRolePos >= state.HighestPosition {
			return ErrMissingPermissions
		}
		if targetMemberHighestPos >= state.HighestPosition {
			return ErrMissingPermissions
		}
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO member_roles (guild_id, user_id, role_id)
		VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING`,
		guildID, targetUID, roleID)
	if err != nil {
		return err
	}

	s.publishMemberUpdate(ctx, guildID, targetUID)
	return nil
}

func (s *Service) UnassignMemberRole(ctx context.Context, callerID, guildID, targetUID, roleID int64) error {
	state, err := s.getMemberRoleState(ctx, guildID, callerID)
	if err != nil {
		return err
	}
	if !canManageRoles(state) {
		return ErrMissingPermissions
	}

	if roleID == guildID {
		return ErrMissingPermissions // cannot unassign @everyone
	}

	var targetRolePos int32
	err = s.db.QueryRowContext(ctx, `SELECT position FROM roles WHERE id = $1 AND guild_id = $2`, roleID, guildID).Scan(&targetRolePos)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownRole
	}
	if err != nil {
		return err
	}

	targetMemberHighestPos, err := s.getTargetMemberHighestPos(ctx, guildID, targetUID)
	if err != nil {
		return err
	}

	// Hierarchy checks
	if !state.IsOwner {
		if targetRolePos >= state.HighestPosition {
			return ErrMissingPermissions
		}
		if targetMemberHighestPos >= state.HighestPosition {
			return ErrMissingPermissions
		}
	}

	_, err = s.db.ExecContext(ctx, `
		DELETE FROM member_roles
		WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
		guildID, targetUID, roleID)
	if err != nil {
		return err
	}

	s.publishMemberUpdate(ctx, guildID, targetUID)
	return nil
}

func (s *Service) getChannelGuildAndPerms(ctx context.Context, channelID, callerID int64) (guildID int64, callerChannelPerms uint64, callerHighestPos int32, isOwner bool, err error) {
	var gidNull sql.NullInt64
	err = s.db.QueryRowContext(ctx, `SELECT guild_id FROM channels WHERE id = $1`, channelID).Scan(&gidNull)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, 0, 0, false, ErrUnknownChannel
	}
	if err != nil {
		return 0, 0, 0, false, err
	}
	if !gidNull.Valid {
		return 0, 0, 0, false, ErrUnknownGuild
	}
	guildID = gidNull.Int64

	state, err := s.getMemberRoleState(ctx, guildID, callerID)
	if err != nil {
		return 0, 0, 0, false, err
	}

	if state.IsOwner || permissions.Has(state.Permissions, permissions.ADMINISTRATOR) {
		return guildID, permissions.ALL_PERMISSIONS, state.HighestPosition, state.IsOwner, nil
	}

	overwrites, err := s.getChannelOverwrites(ctx, channelID)
	if err != nil {
		return 0, 0, 0, false, err
	}

	resolvedPerms := permissions.Resolve(guildID, 0, callerID, state.Roles, overwrites)
	return guildID, resolvedPerms, state.HighestPosition, false, nil
}

func (s *Service) SetChannelOverwrite(ctx context.Context, callerID, channelID, targetID int64, targetType int16, allow, deny uint64) error {
	if targetType != int16(permissions.TargetTypeRole) && targetType != int16(permissions.TargetTypeMember) {
		return ErrMissingPermissions
	}

	gid, callerPerms, callerHighestPos, isOwner, err := s.getChannelGuildAndPerms(ctx, channelID, callerID)
	if err != nil {
		return err
	}

	// Authority check: MANAGE_ROLES, MANAGE_CHANNELS, ADMINISTRATOR (or owner)
	hasAuth := isOwner ||
		permissions.Has(callerPerms, permissions.ADMINISTRATOR) ||
		permissions.Has(callerPerms, permissions.MANAGE_ROLES) ||
		permissions.Has(callerPerms, permissions.MANAGE_CHANNELS)
	if !hasAuth {
		return ErrMissingPermissions
	}

	// Hierarchy on target (unless owner)
	if !isOwner {
		if targetType == int16(permissions.TargetTypeRole) {
			var rolePos int32
			err := s.db.QueryRowContext(ctx, `SELECT position FROM roles WHERE id = $1 AND guild_id = $2`, targetID, gid).Scan(&rolePos)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrUnknownRole
			}
			if err != nil {
				return err
			}
			if rolePos >= callerHighestPos {
				return ErrMissingPermissions
			}
		} else {
			targetHighestPos, err := s.getTargetMemberHighestPos(ctx, gid, targetID)
			if err != nil {
				return err
			}
			if targetHighestPos >= callerHighestPos {
				return ErrMissingPermissions
			}
		}

		// Privilege escalation: cannot allow permissions caller lacks
		if !permissions.Has(callerPerms, permissions.ADMINISTRATOR) {
			if (allow & ^callerPerms) != 0 {
				return ErrMissingPermissions
			}
		}
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO channel_overwrites (channel_id, target_id, target_type, allow, deny)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (channel_id, target_id)
		DO UPDATE SET target_type = EXCLUDED.target_type, allow = EXCLUDED.allow, deny = EXCLUDED.deny`,
		channelID, targetID, targetType, allow, deny)
	if err != nil {
		return err
	}

	s.publishChannelUpdate(ctx, gid, channelID)
	return nil
}

func (s *Service) DeleteChannelOverwrite(ctx context.Context, callerID, channelID, targetID int64) error {
	gid, callerPerms, callerHighestPos, isOwner, err := s.getChannelGuildAndPerms(ctx, channelID, callerID)
	if err != nil {
		return err
	}

	hasAuth := isOwner ||
		permissions.Has(callerPerms, permissions.ADMINISTRATOR) ||
		permissions.Has(callerPerms, permissions.MANAGE_ROLES) ||
		permissions.Has(callerPerms, permissions.MANAGE_CHANNELS)
	if !hasAuth {
		return ErrMissingPermissions
	}

	var targetType int16
	err = s.db.QueryRowContext(ctx, `SELECT target_type FROM channel_overwrites WHERE channel_id = $1 AND target_id = $2`, channelID, targetID).Scan(&targetType)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // idempotent delete in Discord
	}
	if err != nil {
		return err
	}

	// Hierarchy check
	if !isOwner {
		if targetType == int16(permissions.TargetTypeRole) {
			var rolePos int32
			err := s.db.QueryRowContext(ctx, `SELECT position FROM roles WHERE id = $1 AND guild_id = $2`, targetID, gid).Scan(&rolePos)
			if err == nil && rolePos >= callerHighestPos {
				return ErrMissingPermissions
			}
		} else {
			targetHighestPos, err := s.getTargetMemberHighestPos(ctx, gid, targetID)
			if err == nil && targetHighestPos >= callerHighestPos {
				return ErrMissingPermissions
			}
		}
	}

	_, err = s.db.ExecContext(ctx, `DELETE FROM channel_overwrites WHERE channel_id = $1 AND target_id = $2`, channelID, targetID)
	if err != nil {
		return err
	}

	s.publishChannelUpdate(ctx, gid, channelID)
	return nil
}

func (s *Service) ListChannelOverwrites(ctx context.Context, callerID, channelID int64) ([]ChannelOverwrite, error) {
	var gid int64
	err := s.db.QueryRowContext(ctx, `SELECT guild_id FROM channels WHERE id = $1`, channelID).Scan(&gid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownChannel
	}
	if err != nil {
		return nil, err
	}

	if err := s.requireMember(ctx, gid, callerID); err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT channel_id::text, target_id::text, target_type, allow::text, deny::text
		FROM channel_overwrites
		WHERE channel_id = $1`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	overwrites := make([]ChannelOverwrite, 0)
	for rows.Next() {
		var ow ChannelOverwrite
		if err := rows.Scan(&ow.ChannelID, &ow.TargetID, &ow.TargetType, &ow.Allow, &ow.Deny); err != nil {
			return nil, err
		}
		overwrites = append(overwrites, ow)
	}
	return overwrites, rows.Err()
}

func (s *Service) GetMyPermissions(ctx context.Context, callerID, guildID int64) (uint64, error) {
	state, err := s.getMemberRoleState(ctx, guildID, callerID)
	if err != nil {
		return 0, err
	}
	return state.Permissions, nil
}

func (s *Service) publishMemberUpdate(ctx context.Context, guildID, userID int64) {
	gidStr := strconv.FormatInt(guildID, 10)
	var user UserRef
	var nick sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT u.id::text, u.username, LPAD(u.discriminator::text, 4, '0'), m.nickname
		FROM members m
		JOIN users u ON m.user_id = u.id
		WHERE m.guild_id = $1 AND m.user_id = $2`,
		guildID, userID).Scan(&user.ID, &user.Username, &user.Discriminator, &nick)
	if err != nil {
		return
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT role_id::text
		FROM member_roles
		WHERE guild_id = $1 AND user_id = $2`,
		guildID, userID)
	if err != nil {
		return
	}
	defer rows.Close()

	roleIDs := make([]string, 0)
	for rows.Next() {
		var rid string
		if err := rows.Scan(&rid); err == nil {
			roleIDs = append(roleIDs, rid)
		}
	}

	var nickPtr *string
	if nick.Valid {
		nickPtr = &nick.String
	}

	if err := s.pub.Publish(ctx, events.Event{
		Type:    eventTypeGuildMemberUpdate,
		Version: eventVersion,
		GuildID: gidStr,
		Payload: memberUpdateEventPayload{
			GuildID: gidStr,
			Roles:   roleIDs,
			User:    user,
			Nick:    nickPtr,
		},
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish event",
			"type", eventTypeGuildMemberUpdate, "guild_id", gidStr, "err", err)
	}
}

func (s *Service) publishChannelUpdate(ctx context.Context, guildID, channelID int64) {
	gidStr := strconv.FormatInt(guildID, 10)
	var ch Channel
	var pid sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id::text, guild_id::text, type, name, position, parent_id, created_at
		FROM channels
		WHERE id = $1`, channelID).Scan(&ch.ID, &ch.GuildID, &ch.Type, &ch.Name, &ch.Position, &pid, &ch.CreatedAt)
	if err != nil {
		return
	}
	ch.ParentID = idPtr(pid)

	owRows, err := s.db.QueryContext(ctx, `
		SELECT channel_id::text, target_id::text, target_type, allow::text, deny::text
		FROM channel_overwrites
		WHERE channel_id = $1`, channelID)
	if err != nil {
		return
	}
	defer owRows.Close()

	overwrites := make([]ChannelOverwrite, 0)
	for owRows.Next() {
		var ow ChannelOverwrite
		if err := owRows.Scan(&ow.ChannelID, &ow.TargetID, &ow.TargetType, &ow.Allow, &ow.Deny); err == nil {
			overwrites = append(overwrites, ow)
		}
	}

	if err := s.pub.Publish(ctx, events.Event{
		Type:    eventTypeChannelUpdate,
		Version: eventVersion,
		GuildID: gidStr,
		Payload: channelUpdateEventPayload{
			GuildID:              gidStr,
			Channel:              ch,
			PermissionOverwrites: overwrites,
		},
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish event",
			"type", eventTypeChannelUpdate, "guild_id", gidStr, "err", err)
	}
}

