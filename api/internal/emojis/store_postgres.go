package emojis

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
)

var (
	ErrNotFound = errors.New("emojis: not found")
)

type PostgresStore struct {
	db          *sql.DB
	urlResolver func(bucket, key string) string
}

func NewPostgresStore(db *sql.DB, urlResolver func(bucket, key string) string) *PostgresStore {
	return &PostgresStore{
		db:          db,
		urlResolver: urlResolver,
	}
}

func (s *PostgresStore) resolveEmojiURL(e *Emoji) {
	ext := ".png"
	if e.Animated {
		ext = ".gif"
	}
	key := fmt.Sprintf("%s%s", e.ID, ext)
	if s.urlResolver != nil {
		e.URL = s.urlResolver("emojis", key)
	} else {
		e.URL = fmt.Sprintf("/emojis/%s", key)
	}
}

func (s *PostgresStore) resolveStickerURL(st *Sticker) {
	key := fmt.Sprintf("%s.png", st.ID)
	if s.urlResolver != nil {
		st.URL = s.urlResolver("stickers", key)
	} else {
		st.URL = fmt.Sprintf("/stickers/%s", key)
	}
}

func (s *PostgresStore) CreateEmoji(ctx context.Context, e *Emoji) error {
	id, err := strconv.ParseInt(e.ID, 10, 64)
	if err != nil {
		return err
	}
	guildID, err := strconv.ParseInt(e.GuildID, 10, 64)
	if err != nil {
		return err
	}
	uploaderID, err := strconv.ParseInt(e.UploaderID, 10, 64)
	if err != nil {
		return err
	}

	const query = `
		INSERT INTO guild_emojis (id, guild_id, name, uploader_id, animated, content_type, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`
	_, err = s.db.ExecContext(ctx, query, id, guildID, e.Name, uploaderID, e.Animated, e.ContentType, e.CreatedAt)
	if err != nil {
		return err
	}
	s.resolveEmojiURL(e)
	return nil
}

func (s *PostgresStore) GetEmoji(ctx context.Context, id int64) (*Emoji, error) {
	const query = `
		SELECT id, guild_id, name, uploader_id, animated, content_type, created_at
		FROM guild_emojis
		WHERE id = $1
	`
	var e Emoji
	var idVal, gidVal, uidVal int64
	err := s.db.QueryRowContext(ctx, query, id).Scan(
		&idVal,
		&gidVal,
		&e.Name,
		&uidVal,
		&e.Animated,
		&e.ContentType,
		&e.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	e.ID = strconv.FormatInt(idVal, 10)
	e.GuildID = strconv.FormatInt(gidVal, 10)
	e.UploaderID = strconv.FormatInt(uidVal, 10)
	s.resolveEmojiURL(&e)
	return &e, nil
}

func (s *PostgresStore) ListGuildEmojis(ctx context.Context, guildID int64) ([]Emoji, error) {
	const query = `
		SELECT id, guild_id, name, uploader_id, animated, content_type, created_at
		FROM guild_emojis
		WHERE guild_id = $1
		ORDER BY created_at ASC
	`
	rows, err := s.db.QueryContext(ctx, query, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	emojis := make([]Emoji, 0)
	for rows.Next() {
		var e Emoji
		var idVal, gidVal, uidVal int64
		if err := rows.Scan(
			&idVal,
			&gidVal,
			&e.Name,
			&uidVal,
			&e.Animated,
			&e.ContentType,
			&e.CreatedAt,
		); err != nil {
			return nil, err
		}
		e.ID = strconv.FormatInt(idVal, 10)
		e.GuildID = strconv.FormatInt(gidVal, 10)
		e.UploaderID = strconv.FormatInt(uidVal, 10)
		s.resolveEmojiURL(&e)
		emojis = append(emojis, e)
	}
	return emojis, rows.Err()
}

func (s *PostgresStore) DeleteEmoji(ctx context.Context, guildID, id int64) error {
	const query = `
		DELETE FROM guild_emojis
		WHERE guild_id = $1 AND id = $2
	`
	res, err := s.db.ExecContext(ctx, query, guildID, id)
	if err != nil {
		return err
	}
	ra, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if ra == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) CreateSticker(ctx context.Context, st *Sticker) error {
	id, err := strconv.ParseInt(st.ID, 10, 64)
	if err != nil {
		return err
	}
	guildID, err := strconv.ParseInt(st.GuildID, 10, 64)
	if err != nil {
		return err
	}
	uploaderID, err := strconv.ParseInt(st.UploaderID, 10, 64)
	if err != nil {
		return err
	}

	const query = `
		INSERT INTO guild_stickers (id, guild_id, name, description, uploader_id, content_type, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`
	_, err = s.db.ExecContext(ctx, query, id, guildID, st.Name, st.Description, uploaderID, st.ContentType, st.CreatedAt)
	if err != nil {
		return err
	}
	s.resolveStickerURL(st)
	return nil
}

func (s *PostgresStore) GetSticker(ctx context.Context, id int64) (*Sticker, error) {
	const query = `
		SELECT id, guild_id, name, description, uploader_id, content_type, created_at
		FROM guild_stickers
		WHERE id = $1
	`
	var st Sticker
	var idVal, gidVal, uidVal int64
	var desc sql.NullString
	err := s.db.QueryRowContext(ctx, query, id).Scan(
		&idVal,
		&gidVal,
		&st.Name,
		&desc,
		&uidVal,
		&st.ContentType,
		&st.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	st.ID = strconv.FormatInt(idVal, 10)
	st.GuildID = strconv.FormatInt(gidVal, 10)
	st.UploaderID = strconv.FormatInt(uidVal, 10)
	if desc.Valid {
		st.Description = desc.String
	}
	s.resolveStickerURL(&st)
	return &st, nil
}

func (s *PostgresStore) ListGuildStickers(ctx context.Context, guildID int64) ([]Sticker, error) {
	const query = `
		SELECT id, guild_id, name, description, uploader_id, content_type, created_at
		FROM guild_stickers
		WHERE guild_id = $1
		ORDER BY created_at ASC
	`
	rows, err := s.db.QueryContext(ctx, query, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stickers := make([]Sticker, 0)
	for rows.Next() {
		var st Sticker
		var idVal, gidVal, uidVal int64
		var desc sql.NullString
		if err := rows.Scan(
			&idVal,
			&gidVal,
			&st.Name,
			&desc,
			&uidVal,
			&st.ContentType,
			&st.CreatedAt,
		); err != nil {
			return nil, err
		}
		st.ID = strconv.FormatInt(idVal, 10)
		st.GuildID = strconv.FormatInt(gidVal, 10)
		st.UploaderID = strconv.FormatInt(uidVal, 10)
		if desc.Valid {
			st.Description = desc.String
		}
		s.resolveStickerURL(&st)
		stickers = append(stickers, st)
	}
	return stickers, rows.Err()
}

func (s *PostgresStore) DeleteSticker(ctx context.Context, guildID, id int64) error {
	const query = `
		DELETE FROM guild_stickers
		WHERE guild_id = $1 AND id = $2
	`
	res, err := s.db.ExecContext(ctx, query, guildID, id)
	if err != nil {
		return err
	}
	ra, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if ra == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PostgresStore) IsGuildMember(ctx context.Context, guildID, userID int64) (bool, error) {
	const query = `
		SELECT 1 FROM members
		WHERE guild_id = $1 AND user_id = $2
	`
	var dummy int
	err := s.db.QueryRowContext(ctx, query, guildID, userID).Scan(&dummy)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *PostgresStore) GetBatchEmojis(ctx context.Context, ids []int64) (map[int64]*Emoji, error) {
	if len(ids) == 0 {
		return make(map[int64]*Emoji), nil
	}
	const query = `
		SELECT id, guild_id, name, uploader_id, animated, content_type, created_at
		FROM guild_emojis
		WHERE id = ANY($1)
	`
	rows, err := s.db.QueryContext(ctx, query, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	res := make(map[int64]*Emoji)
	for rows.Next() {
		var e Emoji
		var idVal, gidVal, uidVal int64
		if err := rows.Scan(
			&idVal,
			&gidVal,
			&e.Name,
			&uidVal,
			&e.Animated,
			&e.ContentType,
			&e.CreatedAt,
		); err != nil {
			return nil, err
		}
		e.ID = strconv.FormatInt(idVal, 10)
		e.GuildID = strconv.FormatInt(gidVal, 10)
		e.UploaderID = strconv.FormatInt(uidVal, 10)
		s.resolveEmojiURL(&e)
		res[idVal] = &e
	}
	return res, rows.Err()
}

func (s *PostgresStore) GetBatchStickers(ctx context.Context, ids []int64) (map[int64]*Sticker, error) {
	if len(ids) == 0 {
		return make(map[int64]*Sticker), nil
	}
	const query = `
		SELECT id, guild_id, name, description, uploader_id, content_type, created_at
		FROM guild_stickers
		WHERE id = ANY($1)
	`
	rows, err := s.db.QueryContext(ctx, query, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	res := make(map[int64]*Sticker)
	for rows.Next() {
		var st Sticker
		var idVal, gidVal, uidVal int64
		var desc sql.NullString
		if err := rows.Scan(
			&idVal,
			&gidVal,
			&st.Name,
			&desc,
			&uidVal,
			&st.ContentType,
			&st.CreatedAt,
		); err != nil {
			return nil, err
		}
		st.ID = strconv.FormatInt(idVal, 10)
		st.GuildID = strconv.FormatInt(gidVal, 10)
		st.UploaderID = strconv.FormatInt(uidVal, 10)
		if desc.Valid {
			st.Description = desc.String
		}
		s.resolveStickerURL(&st)
		res[idVal] = &st
	}
	return res, rows.Err()
}
