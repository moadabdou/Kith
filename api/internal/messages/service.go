// Package messages implements the message write path (plan/02 §3) —
// the flow to memorize: auth → rate limit → perm → snowflake → insert →
// publish after commit.
package messages

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/pkg/permissions"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

var (
	ErrUnknownChannel     = errors.New("messages: unknown channel")
	ErrUnknownMessage     = errors.New("messages: unknown message")
	ErrMissingAccess      = errors.New("messages: missing access")
	ErrMissingPermissions = errors.New("messages: missing permissions")
	ErrNotAuthor          = errors.New("messages: not the message author")
	ErrEditWindowOver     = errors.New("messages: edit window (15 min) has passed")
	ErrContentRequired    = errors.New("messages: content required")
)

// EditWindow is Discord's 15-minute edit/delete window for regular users.
// (Bots bypass; that distinction lands with permissions.)
const EditWindow = 15 * time.Minute

// Message is the wire shape — the SAME struct is the MESSAGE_CREATE payload
// and the REST response (DRY, plan/02 §3 step 8).
type Message struct {
	ID        string     `json:"id"`
	ChannelID string     `json:"channel_id"`
	GuildID   string     `json:"guild_id,omitempty"`
	Author    AuthorRef  `json:"author"`
	Content   string     `json:"content"`
	CreatedAt time.Time  `json:"timestamp"`
	EditedAt  *time.Time `json:"edited_timestamp"`
}

type AuthorRef struct {
	ID            string `json:"id"`
	Username      string `json:"username"`
	Discriminator string `json:"discriminator"`
}

const (
	eventTypeMessageCreate = "MESSAGE_CREATE"
	eventTypeMessageUpdate = "MESSAGE_UPDATE"
	eventTypeMessageDelete = "MESSAGE_DELETE"
	eventVersion           = 1
)

type MessageDeletePayload struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	GuildID   string `json:"guild_id,omitempty"`
}

type Service struct {
	db    *sql.DB
	store Store
	sf    *snowflake.Node
	pub   events.Publisher
}

func NewService(db *sql.DB, store Store, sf *snowflake.Node, pub events.Publisher) *Service {
	if store == nil && db != nil {
		store = NewPostgresStore(db)
	}
	return &Service{db: db, store: store, sf: sf, pub: pub}
}

// Send is the hot path (plan/02 §3): perm placeholder → snowflake →
// store insert → **publish AFTER Commit** → respond.
//
// A publish failure is logged, not fatal: the row is committed truth; the
// event bus is eventually-consistent by design (Phase 1's replay buffer is
// the mitigation). Returning an error here would make the client retry a
// write that already happened.
func (s *Service) Send(ctx context.Context, userID, channelID int64, content string, attachments ...[]string) (*Message, error) {
	ref, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return nil, ErrMissingAccess
	}
	if !permissions.Has(perms, permissions.SEND_MESSAGES) {
		return nil, ErrMissingPermissions
	}
	if len(attachments) > 0 && len(attachments[0]) > 0 {
		if !permissions.Has(perms, permissions.ATTACH_FILES) {
			return nil, ErrMissingPermissions
		}
	}
	if strings.Contains(content, "@everyone") || strings.Contains(content, "@here") {
		if !permissions.Has(perms, permissions.MENTION_EVERYONE) {
			return nil, ErrMissingPermissions
		}
	}

	id, err := s.sf.Generate()
	if err != nil {
		return nil, err
	}

	m := &Message{
		ID:        snowflake.String(id),
		ChannelID: strconv.FormatInt(channelID, 10),
		Author:    AuthorRef{ID: strconv.FormatInt(userID, 10)},
		Content:   content,
	}
	if ref.GuildID > 0 {
		m.GuildID = strconv.FormatInt(ref.GuildID, 10)
	}

	if err := s.store.Insert(ctx, m); err != nil {
		return nil, err
	}

	// AFTER COMMIT — the single most important ordering in this file.
	if err := s.pub.Publish(ctx, events.Event{
		Type:    eventTypeMessageCreate,
		Version: eventVersion,
		GuildID: m.GuildID,
		Payload: m, // same struct as the REST response
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish event", "type", eventTypeMessageCreate, "guild_id", m.GuildID, "error", err)
	}
	return m, nil
}

// List returns messages in a channel, newest-first, paginated by cursor:
// before returns messages older than that cursor position across partition buckets (plan/03 §4–5).
func (s *Service) List(ctx context.Context, userID, channelID int64, before Cursor, limit int) ([]Message, error) {
	_, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return nil, ErrMissingAccess
	}
	if !permissions.Has(perms, permissions.READ_MESSAGE_HISTORY) {
		return nil, ErrMissingPermissions
	}
	return s.store.List(ctx, channelID, before, limit)
}

// ListAfter returns messages in a channel newer than cursor position, ordered oldest-first (forward pagination).
func (s *Service) ListAfter(ctx context.Context, userID, channelID int64, after Cursor, limit int) ([]Message, error) {
	_, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return nil, ErrMissingAccess
	}
	if !permissions.Has(perms, permissions.READ_MESSAGE_HISTORY) {
		return nil, ErrMissingPermissions
	}
	return s.store.ListAfter(ctx, channelID, after, limit)
}

// Edit patches a message's content. Author only, within the 15-minute
// window. The REST response shape stays a plain Message (Discord returns
// MESSAGE_UPDATE on the gateway; that distinction is Phase 1's).
func (s *Service) Edit(ctx context.Context, userID, channelID, messageID int64, content string) (*Message, error) {
	ref, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return nil, ErrMissingAccess
	}
	if content == "" {
		return nil, ErrContentRequired
	}
	if strings.Contains(content, "@everyone") || strings.Contains(content, "@here") {
		if !permissions.Has(perms, permissions.MENTION_EVERYONE) {
			return nil, ErrMissingPermissions
		}
	}

	msg, err := s.store.Get(ctx, channelID, messageID)
	if err != nil {
		return nil, err
	}
	if msg.Author.ID != strconv.FormatInt(userID, 10) {
		return nil, ErrNotAuthor
	}
	if time.Since(msg.CreatedAt) > EditWindow {
		return nil, ErrEditWindowOver
	}

	edited, err := s.store.Edit(ctx, channelID, messageID, content)
	if err != nil {
		return nil, err
	}

	if ref.GuildID > 0 {
		edited.GuildID = strconv.FormatInt(ref.GuildID, 10)
	}

	if s.pub != nil {
		if err := s.pub.Publish(ctx, events.Event{
			Type:    eventTypeMessageUpdate,
			Version: eventVersion,
			GuildID: edited.GuildID,
			Payload: edited,
		}); err != nil {
			slog.ErrorContext(ctx, "failed to publish event", "type", eventTypeMessageUpdate, "guild_id", edited.GuildID, "error", err)
		}
	}

	return edited, nil
}

// Delete removes a message. Author only within 15-minute window,
// OR any caller holding MANAGE_MESSAGES.
func (s *Service) Delete(ctx context.Context, userID, channelID, messageID int64) error {
	ref, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return ErrMissingAccess
	}

	hasManageMessages := permissions.Has(perms, permissions.MANAGE_MESSAGES)
	if hasManageMessages {
		if err := s.store.Delete(ctx, channelID, messageID, 0); err != nil {
			return err
		}
	} else {
		if err := s.store.Delete(ctx, channelID, messageID, userID); err != nil {
			return err
		}
	}

	var gid string
	if ref.GuildID > 0 {
		gid = strconv.FormatInt(ref.GuildID, 10)
	}

	if s.pub != nil {
		if err := s.pub.Publish(ctx, events.Event{
			Type:    eventTypeMessageDelete,
			Version: eventVersion,
			GuildID: gid,
			Payload: MessageDeletePayload{
				ID:        strconv.FormatInt(messageID, 10),
				ChannelID: strconv.FormatInt(channelID, 10),
				GuildID:   gid,
			},
		}); err != nil {
			slog.ErrorContext(ctx, "failed to publish event", "type", eventTypeMessageDelete, "guild_id", gid, "error", err)
		}
	}

	return nil
}

// ChannelRef carries the minimal channel context resolved during access checks,
// such as GuildID for event bus routing.
type ChannelRef struct {
	GuildID int64
}

// requireCanView verifies the user has permission to view the channel.
func (s *Service) requireCanView(ctx context.Context, userID, channelID int64) (ChannelRef, error) {
	ref, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return ref, err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return ref, ErrMissingAccess
	}
	return ref, nil
}

func (s *Service) requireChannelPerms(ctx context.Context, userID, channelID int64) (ChannelRef, uint64, error) {
	if s.db == nil {
		return ChannelRef{}, permissions.ALL_PERMISSIONS, nil
	}

	var guildIDNull sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT guild_id FROM channels WHERE id = $1`, channelID).Scan(&guildIDNull)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelRef{}, 0, ErrMissingAccess
	}
	if err != nil {
		return ChannelRef{}, 0, err
	}
	if !guildIDNull.Valid {
		return ChannelRef{}, 0, ErrMissingAccess
	}
	guildID := guildIDNull.Int64
	ref := ChannelRef{GuildID: guildID}

	var ownerID int64
	err = s.db.QueryRowContext(ctx, `SELECT owner_id FROM guilds WHERE id = $1`, guildID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return ref, 0, ErrMissingAccess
	}
	if err != nil {
		return ref, 0, err
	}

	if userID == ownerID {
		return ref, permissions.ALL_PERMISSIONS, nil
	}

	var isMember bool
	err = s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`,
		guildID, userID).Scan(&isMember)
	if err != nil {
		return ref, 0, err
	}
	if !isMember {
		return ref, 0, ErrMissingAccess
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
		return ref, 0, err
	}
	defer rows.Close()

	callerRoles := make([]permissions.Role, 0)
	var hasEveryone bool
	for rows.Next() {
		var rid int64
		var pos int32
		var perms uint64
		if err := rows.Scan(&rid, &pos, &perms); err != nil {
			return ref, 0, err
		}
		if rid == guildID {
			hasEveryone = true
		}
		callerRoles = append(callerRoles, permissions.Role{
			ID:          rid,
			GuildID:     guildID,
			Position:    int(pos),
			Permissions: perms,
		})
	}
	if err := rows.Err(); err != nil {
		return ref, 0, err
	}

	if !hasEveryone {
		callerRoles = append(callerRoles, permissions.Role{
			ID:          guildID,
			GuildID:     guildID,
			Position:    0,
			Permissions: permissions.DEFAULT_EVERYONE_PERMISSIONS,
		})
	}

	// Fetch channel overwrites
	owRows, err := s.db.QueryContext(ctx, `
		SELECT channel_id, target_id, target_type, allow, deny
		FROM channel_overwrites
		WHERE channel_id = $1`, channelID)
	if err != nil {
		return ref, 0, err
	}
	defer owRows.Close()

	var overwrites []permissions.Overwrite
	for owRows.Next() {
		var cid, tid int64
		var ttype int16
		var a, d uint64
		if err := owRows.Scan(&cid, &tid, &ttype, &a, &d); err != nil {
			return ref, 0, err
		}
		overwrites = append(overwrites, permissions.Overwrite{
			ChannelID:  cid,
			TargetID:   tid,
			TargetType: permissions.TargetType(ttype),
			Allow:      a,
			Deny:       d,
		})
	}
	if err := owRows.Err(); err != nil {
		return ref, 0, err
	}

	resolvedPerms := permissions.Resolve(guildID, ownerID, userID, callerRoles, overwrites)
	return ref, resolvedPerms, nil
}

func scanMessage(rows *sql.Rows) (Message, error) {
	var m Message
	var gid sql.NullString
	if err := rows.Scan(&m.ID, &m.ChannelID, &gid,
		&m.Author.ID, &m.Author.Username, &m.Author.Discriminator,
		&m.Content, &m.CreatedAt, &m.EditedAt); err != nil {
		return m, err
	}
	if gid.Valid {
		m.GuildID = gid.String
	}
	return m, nil
}
