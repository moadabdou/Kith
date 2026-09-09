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
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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
	db *sql.DB
	sf *snowflake.Node
}

func NewService(db *sql.DB, sf *snowflake.Node) *Service {
	return &Service{db: db, sf: sf}
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
	if err := s.requireMember(ctx, guildID, userID); err != nil {
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

	channels := []Channel{}
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		channels = append(channels, c)
	}
	return channels, rows.Err()
}

// CreateChannel adds a channel to a guild (owner only until Phase 4).
// Text-channel names are normalized Discord-style: lowercase, spaces→dashes.
func (s *Service) CreateChannel(ctx context.Context, userID, guildID int64, chType int16, name string, position int32, parentID *int64) (*Channel, error) {
	if err := s.requireOwner(ctx, guildID, userID); err != nil {
		return nil, err
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

// UpdateChannel patches a channel's name/position/parent (owner only until
// Phase 4). The guild_id in WHERE scopes it: wrong guild ⇒ unknown channel.
func (s *Service) UpdateChannel(ctx context.Context, userID, guildID, channelID int64, name *string, position *int32, parentID *int64) (*Channel, error) {
	if err := s.requireOwner(ctx, guildID, userID); err != nil {
		return nil, err
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
	err := s.db.QueryRowContext(ctx, `
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

// DeleteChannel removes a channel (owner only until Phase 4).
func (s *Service) DeleteChannel(ctx context.Context, userID, guildID, channelID int64) error {
	if err := s.requireOwner(ctx, guildID, userID); err != nil {
		return err
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
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO members (guild_id, user_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, guildID, targetID)
	return err
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
	return nil
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

func (s *Service) CreateRole(ctx context.Context, userID, guildID int64, name string, color *int32, hoist *bool, position *int32, permissions *int64, mentionable *bool) (*Role, error) {
	if err := s.requireOwner(ctx, guildID, userID); err != nil {
		return nil, err
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
	}
	var perms int64
	if permissions != nil {
		perms = *permissions
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
	return &r, nil
}

func (s *Service) UpdateRole(ctx context.Context, userID, guildID, roleID int64, name *string, color *int32, hoist *bool, position *int32, permissions *int64, mentionable *bool) (*Role, error) {
	if err := s.requireOwner(ctx, guildID, userID); err != nil {
		return nil, err
	}
	var nameNull sql.NullString
	if name != nil {
		nameNull = sql.NullString{String: *name, Valid: true}
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
	if permissions != nil {
		permsNull = sql.NullInt64{Int64: *permissions, Valid: true}
	}
	var menNull sql.NullBool
	if mentionable != nil {
		menNull = sql.NullBool{Bool: *mentionable, Valid: true}
	}

	var r Role
	err := s.db.QueryRowContext(ctx, `
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
	return &r, nil
}

func (s *Service) DeleteRole(ctx context.Context, userID, guildID, roleID int64) error {
	if err := s.requireOwner(ctx, guildID, userID); err != nil {
		return err
	}
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM roles WHERE id = $1 AND guild_id = $2`, roleID, guildID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrUnknownRole
	}
	return nil
}

