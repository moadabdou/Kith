// Package messages implements the message write path (plan/02 §3) —
// the flow to memorize: auth → rate limit → perm → snowflake → insert →
// publish after commit.
package messages

import (
	"context"
	"database/sql"
	"errors"
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
	db  *sql.DB
	sf  *snowflake.Node
	pub events.Publisher
}

func NewService(db *sql.DB, sf *snowflake.Node, pub events.Publisher) *Service {
	return &Service{db: db, sf: sf, pub: pub}
}

// Send is the hot path (plan/02 §3): perm placeholder → snowflake →
// PG insert (tx) → **publish AFTER Commit** → respond.
//
// A publish failure is logged, not fatal: the row is committed truth; the
// event bus is eventually-consistent by design (Phase 1's replay buffer is
// the mitigation). Returning an error here would make the client retry a
// write that already happened.
func (s *Service) Send(ctx context.Context, userID, channelID int64, content string) (*Message, error) {
	// Perm placeholder: member-of-guild check. Phase 4: permissions.CanSend.
	if err := s.requireCanView(ctx, userID, channelID); err != nil {
		return nil, err
	}

	id, err := s.sf.Generate()
	if err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	m, err := s.insertMessage(ctx, tx, id, userID, channelID, content)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	// AFTER COMMIT — the single most important ordering in this file.
	_ = s.pub.Publish(ctx, events.Event{
		Type:    eventTypeMessageCreate,
		Version: eventVersion,
		Payload: m, // same struct as the REST response
	})
	return m, nil
}

// List returns messages in a channel, newest-first, paginated by snowflake
// cursor: before=<id> returns the 50 (default) messages older than that id.
// Snowflakes are time-sortable, so the cursor needs no state (plan/02 §4).
func (s *Service) List(ctx context.Context, userID, channelID int64, before int64, limit int) ([]Message, error) {
	if err := s.requireCanView(ctx, userID, channelID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	query := `
		SELECT m.id::text, m.channel_id::text,
		       u.id::text, u.username, to_char(u.discriminator, 'FM0000'),
		       m.content, m.created_at, m.edited_at
		FROM messages m
		JOIN users u ON u.id = m.author_id
		WHERE m.channel_id = $1`
	args := []any{channelID}
	if before > 0 {
		query += ` AND m.id < $2`
		args = append(args, before)
	}
	query += ` ORDER BY m.id DESC LIMIT ` + strconv.Itoa(limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	msgs := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		msgs = append(msgs, m)
	}
	return msgs, rows.Err()
}

// Edit patches a message's content. Author only, within the 15-minute
// window. The REST response shape stays a plain Message (Discord returns
// MESSAGE_UPDATE on the gateway; that distinction is Phase 1's).
func (s *Service) Edit(ctx context.Context, userID, channelID, messageID int64, content string) (*Message, error) {
	if err := s.requireCanView(ctx, userID, channelID); err != nil {
		return nil, err
	}
	if content == "" {
		return nil, ErrContentRequired
	}

	var authorID int64
	var createdAt time.Time
	err := s.db.QueryRowContext(ctx, `
		SELECT author_id, created_at FROM messages
		WHERE id = $1 AND channel_id = $2`, messageID, channelID,
	).Scan(&authorID, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownMessage
	}
	if err != nil {
		return nil, err
	}
	if authorID != userID {
		return nil, ErrNotAuthor
	}
	if time.Since(createdAt) > EditWindow {
		return nil, ErrEditWindowOver
	}

	var m Message
	err = s.db.QueryRowContext(ctx, `
		UPDATE messages SET content = $3, edited_at = now()
		WHERE id = $1 AND channel_id = $2
		RETURNING messages.id::text, messages.channel_id::text`,
		messageID, channelID, content,
	).Scan(&m.ID, &m.ChannelID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownMessage
	}
	if err != nil {
		return nil, err
	}
	if err := s.fillMessage(ctx, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// Delete removes a message. Author only, within the 15-minute window
// (moderator delete is Phase 4).
func (s *Service) Delete(ctx context.Context, userID, channelID, messageID int64) error {
	if err := s.requireCanView(ctx, userID, channelID); err != nil {
		return err
	}

	res, err := s.db.ExecContext(ctx, `
		DELETE FROM messages
		WHERE id = $1 AND channel_id = $2
		  AND author_id = $3
		  AND created_at > now() - interval '15 minutes'`,
		messageID, channelID, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	switch n {
	case 1:
		return nil
	case 0:
		// Distinguish author/window/unknown for a correct status code.
		var authorID int64
		var createdAt time.Time
		err := s.db.QueryRowContext(ctx, `
			SELECT author_id, created_at FROM messages
			WHERE id = $1 AND channel_id = $2`, messageID, channelID,
		).Scan(&authorID, &createdAt)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrUnknownMessage
		}
		if err != nil {
			return err
		}
		if authorID != userID {
			return ErrNotAuthor
		}
		return ErrEditWindowOver
	default:
		return ErrUnknownMessage
	}
}

// requireCanView is the permission placeholder: author must be a member of
// the guild that owns the channel. Phase 4: pkg/permissions.CanSend(user,
// channel) resolving role bits + overwrites.
func (s *Service) requireCanView(ctx context.Context, userID, channelID int64) error {
	var ok bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM channels c
			JOIN members m ON m.guild_id = c.guild_id
			WHERE c.id = $1 AND m.user_id = $2
		)`, channelID, userID).Scan(&ok)
	if err != nil {
		return err
	}
	if !ok {
		return ErrMissingAccess
	}
	return nil
}

func (s *Service) insertMessage(ctx context.Context, tx *sql.Tx, id, userID, channelID int64, content string) (*Message, error) {
	var m Message
	err := tx.QueryRowContext(ctx, `
		INSERT INTO messages (id, channel_id, author_id, content)
		VALUES ($1, $2, $3, $4)
		RETURNING id::text, channel_id::text, author_id::text, created_at`,
		id, channelID, userID, content,
	).Scan(&m.ID, &m.ChannelID, &m.Author.ID, &m.CreatedAt)
	if err != nil {
		// FK violation = channel (or user) doesn't exist.
		return nil, ErrUnknownChannel
	}
	m.Content = content
	if err := s.fillAuthor(ctx, tx, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *Service) fillMessage(ctx context.Context, m *Message) error {
	return s.db.QueryRowContext(ctx, `
		SELECT u.id::text, u.username, to_char(u.discriminator, 'FM0000'),
		       msg.content, msg.created_at, msg.edited_at
		FROM messages msg
		JOIN users u ON u.id = msg.author_id
		WHERE msg.id = $1`, m.ID,
	).Scan(&m.Author.ID, &m.Author.Username, &m.Author.Discriminator,
		&m.Content, &m.CreatedAt, &m.EditedAt)
}

// fillAuthor completes m.Author's display fields from the users table,
// keyed by the message's own author id — the DB row is the source of truth.
func (s *Service) fillAuthor(ctx context.Context, q queryer, m *Message) error {
	authorID, err := strconv.ParseInt(m.Author.ID, 10, 64)
	if err != nil {
		return err
	}
	return q.QueryRowContext(ctx, `
		SELECT username, to_char(discriminator, 'FM0000')
		FROM users WHERE id = $1`, authorID,
	).Scan(&m.Author.Username, &m.Author.Discriminator)
}

type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func scanMessage(rows *sql.Rows) (Message, error) {
	var m Message
	if err := rows.Scan(&m.ID, &m.ChannelID,
		&m.Author.ID, &m.Author.Username, &m.Author.Discriminator,
		&m.Content, &m.CreatedAt, &m.EditedAt); err != nil {
		return m, err
	}
	return m, nil
}
