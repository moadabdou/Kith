package media

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
)

var (
	ErrAttachmentNotFound       = errors.New("media: attachment not found")
	ErrAttachmentConflict       = errors.New("media: attachment is invalid, unauthorized, or already attached")
	ErrInvalidAttachmentData    = errors.New("media: invalid attachment data")
)

type Store interface {
	CreateAttachment(ctx context.Context, att *Attachment) error
	GetAttachment(ctx context.Context, id int64) (*Attachment, error)
	GetAttachmentsByIDs(ctx context.Context, ids []int64) ([]Attachment, error)
	GetAttachmentsForMessage(ctx context.Context, messageID int64) ([]Attachment, error)
	GetAttachmentsForMessages(ctx context.Context, messageIDs []int64) (map[string][]Attachment, error)
	LinkAttachmentsToMessage(ctx context.Context, messageID int64, attachmentIDs []int64, channelID, uploaderID int64) ([]Attachment, error)
	UpdateAttachmentStatus(ctx context.Context, id int64, status string, width, height *int, duration *float64, thumbnails map[string]any) error
	UpdateCompletedUpload(ctx context.Context, id int64, s3Key, sha256Hex, contentType string, byteSize int64, filename, status string) error
}

type PostgresStore struct {
	db        *sql.DB
	publicURL func(bucket, key string) string
}

func NewPostgresStore(db *sql.DB, publicURL func(bucket, key string) string) *PostgresStore {
	if publicURL == nil {
		publicURL = func(bucket, key string) string {
			return fmt.Sprintf("/%s/%s", bucket, key)
		}
	}
	return &PostgresStore{
		db:        db,
		publicURL: publicURL,
	}
}

func (s *PostgresStore) CreateAttachment(ctx context.Context, att *Attachment) error {
	id, err := strconv.ParseInt(att.ID, 10, 64)
	if err != nil {
		return fmt.Errorf("media: invalid id %q: %w", att.ID, err)
	}
	channelID, err := strconv.ParseInt(att.ChannelID, 10, 64)
	if err != nil {
		return fmt.Errorf("media: invalid channel_id %q: %w", att.ChannelID, err)
	}
	uploaderID, err := strconv.ParseInt(att.UploaderID, 10, 64)
	if err != nil {
		return fmt.Errorf("media: invalid uploader_id %q: %w", att.UploaderID, err)
	}

	var messageID sql.NullInt64
	if att.MessageID != nil && *att.MessageID != "" {
		mid, err := strconv.ParseInt(*att.MessageID, 10, 64)
		if err != nil {
			return fmt.Errorf("media: invalid message_id %q: %w", *att.MessageID, err)
		}
		messageID = sql.NullInt64{Int64: mid, Valid: true}
	}

	thumbJSON, err := json.Marshal(att.Thumbnails)
	if err != nil || len(thumbJSON) == 0 {
		thumbJSON = []byte("{}")
	}

	createdAt := att.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}

	query := `
		INSERT INTO attachments (
			id, channel_id, uploader_id, message_id, filename, content_type,
			byte_size, sha256, s3_bucket, s3_key, status, width, height,
			duration_seconds, thumbnails, created_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
		)`

	_, err = s.db.ExecContext(ctx, query,
		id,
		channelID,
		uploaderID,
		messageID,
		att.Filename,
		att.ContentType,
		att.ByteSize,
		att.SHA256,
		att.S3Bucket,
		att.S3Key,
		att.Status,
		att.Width,
		att.Height,
		att.DurationSeconds,
		thumbJSON,
		createdAt,
	)
	if err != nil {
		return fmt.Errorf("media: insert attachment: %w", err)
	}

	att.URL = s.publicURL(att.S3Bucket, att.S3Key)
	return nil
}

func (s *PostgresStore) GetAttachment(ctx context.Context, id int64) (*Attachment, error) {
	query := `
		SELECT id, channel_id, uploader_id, message_id, filename, content_type,
		       byte_size, sha256, s3_bucket, s3_key, status, width, height,
		       duration_seconds, thumbnails, created_at
		FROM attachments
		WHERE id = $1`

	row := s.db.QueryRowContext(ctx, query, id)
	att, err := s.scanAttachment(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrAttachmentNotFound
		}
		return nil, fmt.Errorf("media: get attachment %d: %w", id, err)
	}
	return att, nil
}

func (s *PostgresStore) GetAttachmentsByIDs(ctx context.Context, ids []int64) ([]Attachment, error) {
	if len(ids) == 0 {
		return []Attachment{}, nil
	}

	query := `
		SELECT id, channel_id, uploader_id, message_id, filename, content_type,
		       byte_size, sha256, s3_bucket, s3_key, status, width, height,
		       duration_seconds, thumbnails, created_at
		FROM attachments
		WHERE id = ANY($1)
		ORDER BY id ASC`

	rows, err := s.db.QueryContext(ctx, query, ids)
	if err != nil {
		return nil, fmt.Errorf("media: get attachments by ids: %w", err)
	}
	defer rows.Close()

	return s.scanAttachments(rows)
}

func (s *PostgresStore) GetAttachmentsForMessage(ctx context.Context, messageID int64) ([]Attachment, error) {
	query := `
		SELECT id, channel_id, uploader_id, message_id, filename, content_type,
		       byte_size, sha256, s3_bucket, s3_key, status, width, height,
		       duration_seconds, thumbnails, created_at
		FROM attachments
		WHERE message_id = $1
		ORDER BY id ASC`

	rows, err := s.db.QueryContext(ctx, query, messageID)
	if err != nil {
		return nil, fmt.Errorf("media: get attachments for message %d: %w", messageID, err)
	}
	defer rows.Close()

	return s.scanAttachments(rows)
}

func (s *PostgresStore) GetAttachmentsForMessages(ctx context.Context, messageIDs []int64) (map[string][]Attachment, error) {
	res := make(map[string][]Attachment)
	if len(messageIDs) == 0 {
		return res, nil
	}

	query := `
		SELECT id, channel_id, uploader_id, message_id, filename, content_type,
		       byte_size, sha256, s3_bucket, s3_key, status, width, height,
		       duration_seconds, thumbnails, created_at
		FROM attachments
		WHERE message_id = ANY($1)
		ORDER BY id ASC`

	rows, err := s.db.QueryContext(ctx, query, messageIDs)
	if err != nil {
		return nil, fmt.Errorf("media: get attachments for messages: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		att, err := s.scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		if att.MessageID != nil {
			res[*att.MessageID] = append(res[*att.MessageID], *att)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("media: iterate attachments: %w", err)
	}

	return res, nil
}

func (s *PostgresStore) LinkAttachmentsToMessage(ctx context.Context, messageID int64, attachmentIDs []int64, channelID, uploaderID int64) ([]Attachment, error) {
	if len(attachmentIDs) == 0 {
		return []Attachment{}, nil
	}

	query := `
		UPDATE attachments
		SET message_id = $1
		WHERE id = ANY($2)
		  AND channel_id = $3
		  AND uploader_id = $4
		  AND message_id IS NULL
		RETURNING id, channel_id, uploader_id, message_id, filename, content_type,
		          byte_size, sha256, s3_bucket, s3_key, status, width, height,
		          duration_seconds, thumbnails, created_at`

	rows, err := s.db.QueryContext(ctx, query, messageID, attachmentIDs, channelID, uploaderID)
	if err != nil {
		return nil, fmt.Errorf("media: link attachments: %w", err)
	}
	defer rows.Close()

	linked, err := s.scanAttachments(rows)
	if err != nil {
		return nil, err
	}

	if len(linked) != len(attachmentIDs) {
		return nil, ErrAttachmentConflict
	}

	return linked, nil
}

func (s *PostgresStore) UpdateAttachmentStatus(ctx context.Context, id int64, status string, width, height *int, duration *float64, thumbnails map[string]any) error {
	var thumbJSON []byte
	var err error
	if thumbnails != nil {
		thumbJSON, err = json.Marshal(thumbnails)
		if err != nil {
			thumbJSON = []byte("{}")
		}
	}

	query := `
		UPDATE attachments
		SET status = $2,
		    width = COALESCE($3, width),
		    height = COALESCE($4, height),
		    duration_seconds = COALESCE($5, duration_seconds),
		    thumbnails = CASE WHEN $6::jsonb IS NOT NULL THEN $6::jsonb ELSE thumbnails END
		WHERE id = $1`

	res, err := s.db.ExecContext(ctx, query, id, status, width, height, duration, thumbJSON)
	if err != nil {
		return fmt.Errorf("media: update attachment status %d: %w", id, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrAttachmentNotFound
	}
	return nil
}

func (s *PostgresStore) UpdateCompletedUpload(ctx context.Context, id int64, s3Key, sha256Hex, contentType string, byteSize int64, filename, status string) error {
	query := `
		UPDATE attachments
		SET s3_key = $2, sha256 = $3, content_type = $4, byte_size = $5, filename = $6, status = $7
		WHERE id = $1`

	res, err := s.db.ExecContext(ctx, query, id, s3Key, sha256Hex, contentType, byteSize, filename, status)
	if err != nil {
		return fmt.Errorf("media: update completed upload %d: %w", id, err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrAttachmentNotFound
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func (s *PostgresStore) scanAttachment(row rowScanner) (*Attachment, error) {
	var (
		id              int64
		channelID       int64
		uploaderID      int64
		messageID       sql.NullInt64
		filename        string
		contentType     string
		byteSize        int64
		sha256Hex       string
		s3Bucket        string
		s3Key           string
		status          string
		width           sql.NullInt32
		height          sql.NullInt32
		durationSeconds sql.NullFloat64
		thumbnailsRaw   []byte
		createdAt       time.Time
	)

	err := row.Scan(
		&id,
		&channelID,
		&uploaderID,
		&messageID,
		&filename,
		&contentType,
		&byteSize,
		&sha256Hex,
		&s3Bucket,
		&s3Key,
		&status,
		&width,
		&height,
		&durationSeconds,
		&thumbnailsRaw,
		&createdAt,
	)
	if err != nil {
		return nil, err
	}

	att := &Attachment{
		ID:          strconv.FormatInt(id, 10),
		ChannelID:   strconv.FormatInt(channelID, 10),
		UploaderID:  strconv.FormatInt(uploaderID, 10),
		Filename:    filename,
		ContentType: contentType,
		ByteSize:    byteSize,
		SHA256:      sha256Hex,
		S3Bucket:    s3Bucket,
		S3Key:       s3Key,
		Status:      status,
		CreatedAt:   createdAt,
		URL:         s.publicURL(s3Bucket, s3Key),
	}

	if messageID.Valid {
		mStr := strconv.FormatInt(messageID.Int64, 10)
		att.MessageID = &mStr
	}
	if width.Valid {
		w := int(width.Int32)
		att.Width = &w
	}
	if height.Valid {
		h := int(height.Int32)
		att.Height = &h
	}
	if durationSeconds.Valid {
		att.DurationSeconds = &durationSeconds.Float64
	}
	if len(thumbnailsRaw) > 0 {
		_ = json.Unmarshal(thumbnailsRaw, &att.Thumbnails)
	}

	return att, nil
}

func (s *PostgresStore) scanAttachments(rows *sql.Rows) ([]Attachment, error) {
	var list []Attachment
	for rows.Next() {
		att, err := s.scanAttachment(rows)
		if err != nil {
			return nil, fmt.Errorf("media: scan attachment row: %w", err)
		}
		list = append(list, *att)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("media: iterate attachments: %w", err)
	}
	return list, nil
}
