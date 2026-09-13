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
	"time"

	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

var (
	ErrUnknownChannel  = errors.New("messages: unknown channel")
	ErrUnknownMessage  = errors.New("messages: unknown message")
	ErrMissingAccess   = errors.New("messages: missing access")
	ErrNotAuthor       = errors.New("messages: not the message author")
	ErrEditWindowOver  = errors.New("messages: edit window (15 min) has passed")
	ErrContentRequired = errors.New("messages: content required")
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

const eventTypeMessageCreate = "MESSAGE_CREATE"
const eventVersion = 1

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
func (s *Service) Send(ctx context.Context, userID, channelID int64, content string) (*Message, error) {
	// Perm placeholder: member-of-guild check. Phase 4: permissions.CanSend.
	channel, err := s.requireCanView(ctx, userID, channelID)
	if err != nil {
		return nil, err
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
	if channel.GuildID > 0 {
		m.GuildID = strconv.FormatInt(channel.GuildID, 10)
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
	if _, err := s.requireCanView(ctx, userID, channelID); err != nil {
		return nil, err
	}
	return s.store.List(ctx, channelID, before, limit)
}

// Edit patches a message's content. Author only, within the 15-minute
// window. The REST response shape stays a plain Message (Discord returns
// MESSAGE_UPDATE on the gateway; that distinction is Phase 1's).
func (s *Service) Edit(ctx context.Context, userID, channelID, messageID int64, content string) (*Message, error) {
	if _, err := s.requireCanView(ctx, userID, channelID); err != nil {
		return nil, err
	}
	if content == "" {
		return nil, ErrContentRequired
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

	return s.store.Edit(ctx, channelID, messageID, content)
}

// Delete removes a message. Author only, within the 15-minute window
// (moderator delete is Phase 4).
func (s *Service) Delete(ctx context.Context, userID, channelID, messageID int64) error {
	if _, err := s.requireCanView(ctx, userID, channelID); err != nil {
		return err
	}
	return s.store.Delete(ctx, channelID, messageID, userID)
}

// ChannelRef carries the minimal channel context resolved during access checks,
// such as GuildID for event bus routing.
type ChannelRef struct {
	GuildID int64
}

// requireCanView verifies the user has permission to view/interact with the channel
// and returns its ChannelRef in a single database round-trip. This avoids a redundant
// SELECT for guild_id on the message hot path.
//
// Phase 4 will replace this membership placeholder with pkg/permissions.CanSend(user, channel)
// once channel and member permissions are resolved via in-memory bitwise operations.
func (s *Service) requireCanView(ctx context.Context, userID, channelID int64) (ChannelRef, error) {
	var guildID sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT c.guild_id FROM channels c
		JOIN members m ON m.guild_id = c.guild_id
		WHERE c.id = $1 AND m.user_id = $2
	`, channelID, userID).Scan(&guildID)
	if errors.Is(err, sql.ErrNoRows) {
		return ChannelRef{}, ErrMissingAccess
	}
	if err != nil {
		return ChannelRef{}, err
	}
	var ref ChannelRef
	if guildID.Valid {
		ref.GuildID = guildID.Int64
	}
	return ref, nil
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
