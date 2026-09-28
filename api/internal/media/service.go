package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strconv"
	"time"

	"github.com/moadabdou/Kith/api/pkg/permissions"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

var (
	ErrMissingAccess      = errors.New("media: missing channel access")
	ErrMissingPermissions = errors.New("media: missing permissions to attach files")
	ErrUnauthorized       = errors.New("media: unauthorized action on attachment")
)

const (
	DefaultMaxUploadSize = 25 * 1024 * 1024 // 25 MB
	DefaultBucket        = "attachments"
	PresignExpiry        = 15 * time.Minute
)

// Service coordinates file ingestion, MIME validation, storage persistence,
// and event dispatching for the media pipeline.
type Service struct {
	db            *sql.DB
	store         Store
	storage       Storage
	sf            *snowflake.Node
	pub           EventPublisher
	bucket        string
	maxUploadSize int64
}

// NewService constructs a media pipeline service.
func NewService(
	db *sql.DB,
	store Store,
	storage Storage,
	sf *snowflake.Node,
	pub EventPublisher,
	bucket string,
	maxUploadSize int64,
) *Service {
	if bucket == "" {
		bucket = DefaultBucket
	}
	if maxUploadSize <= 0 {
		maxUploadSize = DefaultMaxUploadSize
	}
	if pub == nil {
		pub = NoopEventPublisher{}
	}
	return &Service{
		db:            db,
		store:         store,
		storage:       storage,
		sf:            sf,
		pub:           pub,
		bucket:        bucket,
		maxUploadSize: maxUploadSize,
	}
}

// UploadAttachment handles direct multipart stream ingestion (Option A).
// Memory budget <= 32 KB: streaming SHA-256 computation + MinIO direct stream.
func (s *Service) UploadAttachment(
	ctx context.Context,
	userID, channelID int64,
	declaredFilename string,
	reader io.Reader,
	size int64,
) (*Attachment, error) {
	// 1. Permission check: ATTACH_FILES & VIEW_CHANNEL
	if err := s.checkChannelPermissions(ctx, userID, channelID); err != nil {
		return nil, err
	}

	if size > s.maxUploadSize {
		return nil, ErrFileTooLarge
	}

	// 2. Sniff first 512 bytes for MIME detection & security check
	head := make([]byte, 512)
	n, err := io.ReadFull(reader, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("media: read header: %w", err)
	}
	head = head[:n]
	if len(head) == 0 {
		return nil, ErrEmptyFile
	}

	contentType, ext, cleanFilename, err := DetectAndValidateMIME(head, declaredFilename)
	if err != nil {
		return nil, err
	}

	// 3. Generate attachment snowflake ID
	sfID, err := s.sf.Generate()
	if err != nil {
		return nil, fmt.Errorf("media: generate snowflake: %w", err)
	}
	attIDStr := snowflake.String(sfID)
	chanIDStr := strconv.FormatInt(channelID, 10)
	userIDStr := strconv.FormatInt(userID, 10)

	// 4. Stream to temporary key while computing SHA-256
	tempKey := FormatTempKey(chanIDStr, attIDStr, ext)
	fullReader := io.MultiReader(bytes.NewReader(head), reader)
	limitReader := io.LimitReader(fullReader, s.maxUploadSize+1)

	hasher := sha256.New()
	teeReader := io.TeeReader(limitReader, hasher)

	// Stream into MinIO temp key
	putSize := size
	if putSize <= 0 {
		putSize = -1 // MinIO streams with multipart chunking
	}
	err = s.storage.PutObject(ctx, s.bucket, tempKey, teeReader, putSize, contentType)
	if err != nil {
		return nil, fmt.Errorf("media: storage put failed: %w", err)
	}

	// Verify actual uploaded size
	objInfo, err := s.storage.StatObject(ctx, s.bucket, tempKey)
	if err != nil {
		_ = s.storage.RemoveObject(ctx, s.bucket, tempKey)
		return nil, fmt.Errorf("media: stat temp object failed: %w", err)
	}

	if objInfo.Size > s.maxUploadSize {
		_ = s.storage.RemoveObject(ctx, s.bucket, tempKey)
		return nil, ErrFileTooLarge
	}

	// 5. Compute SHA-256 & copy to immutable content-addressed path
	sha256Hex := hex.EncodeToString(hasher.Sum(nil))
	finalKey := FormatAttachmentKey(chanIDStr, attIDStr, sha256Hex, ext)

	err = s.storage.CopyObject(ctx, s.bucket, finalKey, s.bucket, tempKey)
	if err != nil {
		_ = s.storage.RemoveObject(ctx, s.bucket, tempKey)
		return nil, fmt.Errorf("media: move to content-addressed key failed: %w", err)
	}
	_ = s.storage.RemoveObject(ctx, s.bucket, tempKey)

	// 6. Persist record in PostgreSQL
	att := &Attachment{
		ID:          attIDStr,
		ChannelID:   chanIDStr,
		UploaderID:  userIDStr,
		Filename:    cleanFilename,
		ContentType: contentType,
		ByteSize:    objInfo.Size,
		SHA256:      sha256Hex,
		S3Bucket:    s.bucket,
		S3Key:       finalKey,
		Status:      StatusPending,
		CreatedAt:   time.Now().UTC(),
	}

	if err := s.store.CreateAttachment(ctx, att); err != nil {
		// Clean up storage object on DB failure
		_ = s.storage.RemoveObject(ctx, s.bucket, finalKey)
		return nil, fmt.Errorf("media: save attachment to db: %w", err)
	}

	// 7. Dispatch FILE_UPLOAD event to JetStream for Rust worker
	if err := s.pub.PublishUpload(ctx, FileUploadPayload{
		AttachmentID: att.ID,
		ChannelID:    att.ChannelID,
		UploaderID:   att.UploaderID,
		Filename:     att.Filename,
		ContentType:  att.ContentType,
		ByteSize:     att.ByteSize,
		SHA256:       att.SHA256,
		S3Bucket:     att.S3Bucket,
		S3Key:        att.S3Key,
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish upload event to jetstream",
			"attachment_id", att.ID,
			"error", err,
		)
	}

	return att, nil
}

// CreatePresignedUpload generates a presigned S3 PUT URL for direct client-to-storage upload (Option B).
func (s *Service) CreatePresignedUpload(
	ctx context.Context,
	userID, channelID int64,
	req PresignRequest,
) (*PresignedUploadResponse, error) {
	if err := s.checkChannelPermissions(ctx, userID, channelID); err != nil {
		return nil, err
	}

	if req.ByteSize > s.maxUploadSize {
		return nil, ErrFileTooLarge
	}

	sfID, err := s.sf.Generate()
	if err != nil {
		return nil, fmt.Errorf("media: generate snowflake: %w", err)
	}
	attIDStr := snowflake.String(sfID)
	chanIDStr := strconv.FormatInt(channelID, 10)
	userIDStr := strconv.FormatInt(userID, 10)

	cleanFilename := filepath.Base(filepath.Clean(req.Filename))
	if cleanFilename == "" || cleanFilename == "." {
		cleanFilename = "attachment.bin"
	}
	ext := filepath.Ext(cleanFilename)

	// Preliminary staging key for presigned upload
	stagingKey := fmt.Sprintf("attachments/%s/%s/staged%s", chanIDStr, attIDStr, ext)

	uploadURL, err := s.storage.PresignedPutURL(ctx, s.bucket, stagingKey, PresignExpiry)
	if err != nil {
		return nil, fmt.Errorf("media: generate presigned put url: %w", err)
	}

	// Insert placeholder record in DB with StatusPending
	att := &Attachment{
		ID:          attIDStr,
		ChannelID:   chanIDStr,
		UploaderID:  userIDStr,
		Filename:    cleanFilename,
		ContentType: req.ContentType,
		ByteSize:    req.ByteSize,
		SHA256:      "",
		S3Bucket:    s.bucket,
		S3Key:       stagingKey,
		Status:      StatusPending,
		CreatedAt:   time.Now().UTC(),
	}

	if err := s.store.CreateAttachment(ctx, att); err != nil {
		return nil, fmt.Errorf("media: create placeholder attachment: %w", err)
	}

	return &PresignedUploadResponse{
		ID:        attIDStr,
		UploadURL: uploadURL,
		S3Key:     stagingKey,
		ExpiresAt: time.Now().Add(PresignExpiry),
	}, nil
}

// CompletePresignedUpload verifies the completed upload in MinIO, sniffs MIME,
// computes SHA-256, moves to the content-addressed key, and dispatches the worker event.
func (s *Service) CompletePresignedUpload(
	ctx context.Context,
	userID, channelID, attachmentID int64,
) (*Attachment, error) {
	att, err := s.store.GetAttachment(ctx, attachmentID)
	if err != nil {
		return nil, err
	}

	if att.ChannelID != strconv.FormatInt(channelID, 10) || att.UploaderID != strconv.FormatInt(userID, 10) {
		return nil, ErrUnauthorized
	}

	// 1. Verify object exists in storage
	info, err := s.storage.StatObject(ctx, s.bucket, att.S3Key)
	if err != nil {
		return nil, fmt.Errorf("media: staged object not found in storage: %w", err)
	}

	if info.Size > s.maxUploadSize {
		_ = s.storage.RemoveObject(ctx, s.bucket, att.S3Key)
		return nil, ErrFileTooLarge
	}

	// 2. Read object from storage to sniff MIME and compute SHA-256
	objReader, err := s.storage.GetObject(ctx, s.bucket, att.S3Key)
	if err != nil {
		return nil, fmt.Errorf("media: get staged object failed: %w", err)
	}
	defer objReader.Close()

	head := make([]byte, 512)
	n, err := io.ReadFull(objReader, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("media: read staged header: %w", err)
	}
	head = head[:n]

	contentType, ext, cleanFilename, err := DetectAndValidateMIME(head, att.Filename)
	if err != nil {
		_ = s.storage.RemoveObject(ctx, s.bucket, att.S3Key)
		_ = s.store.UpdateAttachmentStatus(ctx, attachmentID, StatusFailed, nil, nil, nil, nil)
		return nil, err
	}

	// 3. Compute SHA-256
	hasher := sha256.New()
	hasher.Write(head)
	if _, err := io.Copy(hasher, objReader); err != nil {
		return nil, fmt.Errorf("media: hash computation failed: %w", err)
	}
	sha256Hex := hex.EncodeToString(hasher.Sum(nil))

	// 4. Move to content-addressed immutable path
	finalKey := FormatAttachmentKey(att.ChannelID, att.ID, sha256Hex, ext)
	if finalKey != att.S3Key {
		err = s.storage.CopyObject(ctx, s.bucket, finalKey, s.bucket, att.S3Key)
		if err != nil {
			return nil, fmt.Errorf("media: copy to content-addressed key failed: %w", err)
		}
		_ = s.storage.RemoveObject(ctx, s.bucket, att.S3Key)
	}

	// 5. Update DB record
	att.S3Key = finalKey
	att.SHA256 = sha256Hex
	att.ContentType = contentType
	att.ByteSize = info.Size
	att.Filename = cleanFilename
	att.Status = StatusPending

	if err := s.store.UpdateCompletedUpload(ctx, attachmentID, finalKey, sha256Hex, contentType, info.Size, cleanFilename, StatusPending); err != nil {
		return nil, fmt.Errorf("media: update attachment db record: %w", err)
	}

	att.URL = s.storage.PublicURL(s.bucket, finalKey)

	// 6. Publish FILE_UPLOAD event
	if err := s.pub.PublishUpload(ctx, FileUploadPayload{
		AttachmentID: att.ID,
		ChannelID:    att.ChannelID,
		UploaderID:   att.UploaderID,
		Filename:     att.Filename,
		ContentType:  att.ContentType,
		ByteSize:     att.ByteSize,
		SHA256:       att.SHA256,
		S3Bucket:     att.S3Bucket,
		S3Key:        att.S3Key,
	}); err != nil {
		slog.ErrorContext(ctx, "failed to publish upload event to jetstream",
			"attachment_id", att.ID,
			"error", err,
		)
	}

	return att, nil
}

// GetAttachment fetches an attachment by snowflake ID.
func (s *Service) GetAttachment(ctx context.Context, id int64) (*Attachment, error) {
	return s.store.GetAttachment(ctx, id)
}

// LinkAttachments validates ownership and links attachments to a message.
func (s *Service) LinkAttachments(
	ctx context.Context,
	messageID int64,
	attachmentIDs []int64,
	channelID, uploaderID int64,
) ([]Attachment, error) {
	return s.store.LinkAttachmentsToMessage(ctx, messageID, attachmentIDs, channelID, uploaderID)
}

// checkChannelPermissions verifies the caller can view the channel and attach files.
func (s *Service) checkChannelPermissions(ctx context.Context, userID, channelID int64) error {
	if s.db == nil {
		return nil
	}

	var guildIDNull sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT guild_id FROM channels WHERE id = $1`, channelID).Scan(&guildIDNull)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrMissingAccess
	}
	if err != nil {
		return err
	}
	if !guildIDNull.Valid {
		// DM or standalone channel without guild
		return nil
	}

	guildID := guildIDNull.Int64
	var ownerID int64
	err = s.db.QueryRowContext(ctx, `SELECT owner_id FROM guilds WHERE id = $1`, guildID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrMissingAccess
	}
	if err != nil {
		return err
	}
	if userID == ownerID {
		return nil
	}

	var isMember bool
	err = s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`,
		guildID, userID).Scan(&isMember)
	if err != nil || !isMember {
		return ErrMissingAccess
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
		return err
	}
	defer rows.Close()

	callerRoles := make([]permissions.Role, 0)
	var hasEveryone bool
	for rows.Next() {
		var rid int64
		var pos int32
		var perms uint64
		if err := rows.Scan(&rid, &pos, &perms); err != nil {
			return err
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
		return err
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
		return err
	}
	defer owRows.Close()

	var overwrites []permissions.Overwrite
	for owRows.Next() {
		var cid, tid int64
		var ttype int16
		var a, d uint64
		if err := owRows.Scan(&cid, &tid, &ttype, &a, &d); err != nil {
			return err
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
		return err
	}

	perms := permissions.Resolve(guildID, ownerID, userID, callerRoles, overwrites)

	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return ErrMissingAccess
	}
	if !permissions.Has(perms, permissions.ATTACH_FILES) {
		return ErrMissingPermissions
	}

	return nil
}
