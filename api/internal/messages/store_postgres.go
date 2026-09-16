package messages

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

var _ Store = (*PostgresStore)(nil)

// PostgresStore implements Store against the PostgreSQL messages table (plan/03 §3, §7).
type PostgresStore struct {
	db *sql.DB
}

// NewPostgresStore creates a new PostgreSQL-backed message store.
func NewPostgresStore(db *sql.DB) *PostgresStore {
	return &PostgresStore{db: db}
}

// Insert writes a new message row to PostgreSQL and populates its author details and CreatedAt.
func (s *PostgresStore) Insert(ctx context.Context, msg *Message) error {
	id, err := strconv.ParseInt(msg.ID, 10, 64)
	if err != nil {
		return err
	}
	channelID, err := strconv.ParseInt(msg.ChannelID, 10, 64)
	if err != nil {
		return err
	}
	authorID, err := strconv.ParseInt(msg.Author.ID, 10, 64)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var createdAt time.Time
	err = tx.QueryRowContext(ctx, `
		INSERT INTO messages (id, channel_id, author_id, content)
		VALUES ($1, $2, $3, $4)
		RETURNING created_at`,
		id, channelID, authorID, msg.Content,
	).Scan(&createdAt)
	if err != nil {
		return ErrUnknownChannel
	}
	msg.CreatedAt = createdAt

	// Populate author fields from users table
	err = tx.QueryRowContext(ctx, `
		SELECT username, to_char(discriminator, 'FM0000')
		FROM users WHERE id = $1`, authorID,
	).Scan(&msg.Author.Username, &msg.Author.Discriminator)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// List returns messages from a channel ordered newest-first, bounded by limit and cursor.
func (s *PostgresStore) List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	query := `
		SELECT m.id::text, m.channel_id::text, coalesce(c.guild_id::text, ''),
		       u.id::text, u.username, to_char(u.discriminator, 'FM0000'),
		       m.content, m.created_at, m.edited_at
		FROM messages m
		JOIN channels c ON c.id = m.channel_id
		JOIN users u ON u.id = m.author_id
		WHERE m.channel_id = $1`
	args := []any{channelID}
	if before.MessageID > 0 {
		query += ` AND m.id < $2`
		args = append(args, before.MessageID)
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

// ListAfter returns messages from a channel newer than after cursor, ordered oldest-first (ASC).
func (s *PostgresStore) ListAfter(ctx context.Context, channelID int64, after Cursor, limit int) ([]Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	query := `
		SELECT m.id::text, m.channel_id::text, coalesce(c.guild_id::text, ''),
		       u.id::text, u.username, to_char(u.discriminator, 'FM0000'),
		       m.content, m.created_at, m.edited_at
		FROM messages m
		JOIN channels c ON c.id = m.channel_id
		JOIN users u ON u.id = m.author_id
		WHERE m.channel_id = $1`
	args := []any{channelID}
	if after.MessageID > 0 {
		query += ` AND m.id > $2`
		args = append(args, after.MessageID)
	}
	query += ` ORDER BY m.id ASC LIMIT ` + strconv.Itoa(limit)

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

// Edit updates the content and edited_at timestamp of a message.
func (s *PostgresStore) Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error) {
	var m Message
	err := s.db.QueryRowContext(ctx, `
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

	return s.Get(ctx, channelID, messageID)
}

// Delete removes a message if within the 15-minute edit window and author matches,
// returning precise errors on failure.
func (s *PostgresStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	if authorID == 0 {
		res, err := s.db.ExecContext(ctx, `
			DELETE FROM messages
			WHERE id = $1 AND channel_id = $2`,
			messageID, channelID)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return ErrUnknownMessage
		}
		return nil
	}

	res, err := s.db.ExecContext(ctx, `
		DELETE FROM messages
		WHERE id = $1 AND channel_id = $2
		  AND author_id = $3
		  AND created_at > now() - interval '15 minutes'`,
		messageID, channelID, authorID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 1 {
		return nil
	}

	// Distinguish author/window/unknown for status code accuracy
	var existingAuthorID int64
	var createdAt time.Time
	err = s.db.QueryRowContext(ctx, `
		SELECT author_id, created_at FROM messages
		WHERE id = $1 AND channel_id = $2`, messageID, channelID,
	).Scan(&existingAuthorID, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownMessage
	}
	if err != nil {
		return err
	}
	if existingAuthorID != authorID {
		return ErrNotAuthor
	}
	if time.Since(createdAt) > EditWindow {
		return ErrEditWindowOver
	}
	return ErrUnknownMessage
}

// Get fetches a single message by channel and message ID, including author and channel context.
func (s *PostgresStore) Get(ctx context.Context, channelID, messageID int64) (*Message, error) {
	var m Message
	var gid sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT m.id::text, m.channel_id::text, coalesce(c.guild_id::text, ''),
		       u.id::text, u.username, to_char(u.discriminator, 'FM0000'),
		       m.content, m.created_at, m.edited_at
		FROM messages msg
		JOIN messages m ON m.id = msg.id
		JOIN channels c ON c.id = m.channel_id
		JOIN users u ON u.id = m.author_id
		WHERE m.channel_id = $1 AND m.id = $2`, channelID, messageID,
	).Scan(&m.ID, &m.ChannelID, &gid,
		&m.Author.ID, &m.Author.Username, &m.Author.Discriminator,
		&m.Content, &m.CreatedAt, &m.EditedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownMessage
	}
	if err != nil {
		return nil, err
	}
	if gid.Valid {
		m.GuildID = gid.String
	}
	return &m, nil
}
