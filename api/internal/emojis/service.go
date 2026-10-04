package emojis

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/internal/media"
	"github.com/moadabdou/Kith/api/pkg/permissions"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

var (
	ErrUnknownGuild       = errors.New("emojis: unknown guild")
	ErrMissingAccess      = errors.New("emojis: missing access")
	ErrMissingPermissions = errors.New("emojis: missing permissions")
	ErrInvalidName        = errors.New("emojis: invalid name, must be 2-32 alphanumeric or underscore characters")
	ErrInvalidFileType    = errors.New("emojis: unsupported image type")
	ErrFileTooLarge       = errors.New("emojis: file exceeds maximum allowed size")
	ErrEmptyFile          = errors.New("emojis: empty file")
)

const (
	MaxEmojiSizeBytes   = 256 * 1024 // 256 KB
	MaxStickerSizeBytes = 512 * 1024 // 512 KB
)

var (
	validNameRegex = regexp.MustCompile(`^[a-zA-Z0-9_]{2,32}$`)
)

// Service provides emoji and sticker management and cross-server authorization.
type Service struct {
	db      *sql.DB
	store   Store
	sf      *snowflake.Node
	storage media.Storage
	pub     events.Publisher
}

func NewService(db *sql.DB, store Store, sf *snowflake.Node, storage media.Storage, pub events.Publisher) *Service {
	return &Service{
		db:      db,
		store:   store,
		sf:      sf,
		storage: storage,
		pub:     pub,
	}
}

func (s *Service) checkManageGuild(ctx context.Context, guildID, userID int64) error {
	var ownerID int64
	err := s.db.QueryRowContext(ctx, `SELECT owner_id FROM guilds WHERE id = $1`, guildID).Scan(&ownerID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownGuild
	}
	if err != nil {
		return err
	}
	if ownerID == userID {
		return nil
	}

	// Check member roles
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.permissions
		FROM roles r
		JOIN member_roles mr ON mr.role_id = r.id
		WHERE mr.guild_id = $1 AND mr.user_id = $2
	`, guildID, userID)
	if err != nil {
		return err
	}
	defer rows.Close()

	var totalPerms uint64
	for rows.Next() {
		var p uint64
		if err := rows.Scan(&p); err != nil {
			return err
		}
		totalPerms |= p
	}

	// Also check @everyone role (role_id == guild_id)
	var everyonePerms uint64
	err = s.db.QueryRowContext(ctx, `SELECT permissions FROM roles WHERE id = $1 AND guild_id = $1`, guildID).Scan(&everyonePerms)
	if err == nil {
		totalPerms |= everyonePerms
	}

	if permissions.Has(totalPerms, permissions.ADMINISTRATOR) || permissions.Has(totalPerms, permissions.MANAGE_GUILD) {
		return nil
	}

	return ErrMissingPermissions
}

func (s *Service) requireMember(ctx context.Context, guildID, userID int64) error {
	member, err := s.store.IsGuildMember(ctx, guildID, userID)
	if err != nil {
		return err
	}
	if !member {
		return ErrMissingAccess
	}
	return nil
}

// ── Emojis ─────────────────────────────────────────────────────────────

func (s *Service) ListEmojis(ctx context.Context, guildID, userID int64) ([]Emoji, error) {
	if err := s.requireMember(ctx, guildID, userID); err != nil {
		return nil, err
	}
	return s.store.ListGuildEmojis(ctx, guildID)
}

func (s *Service) CreateEmoji(ctx context.Context, guildID, userID int64, name string, file io.Reader, size int64) (*Emoji, error) {
	if err := s.checkManageGuild(ctx, guildID, userID); err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if !validNameRegex.MatchString(name) {
		return nil, ErrInvalidName
	}
	if size <= 0 {
		return nil, ErrEmptyFile
	}
	if size > MaxEmojiSizeBytes {
		return nil, ErrFileTooLarge
	}

	data, err := io.ReadAll(io.LimitReader(file, MaxEmojiSizeBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxEmojiSizeBytes {
		return nil, ErrFileTooLarge
	}
	if len(data) == 0 {
		return nil, ErrEmptyFile
	}

	contentType := http.DetectContentType(data)
	if idx := strings.Index(contentType, ";"); idx != -1 {
		contentType = strings.TrimSpace(contentType[:idx])
	}

	animated := false
	var ext string
	switch contentType {
	case "image/png":
		ext = ".png"
	case "image/jpeg":
		ext = ".png" // stored canonically as .png or .jpg
	case "image/gif":
		ext = ".gif"
		animated = true
	case "image/webp":
		ext = ".png"
	default:
		return nil, ErrInvalidFileType
	}

	emojiID, err := s.sf.Generate()
	if err != nil {
		return nil, err
	}
	emojiIDStr := strconv.FormatInt(emojiID, 10)
	key := fmt.Sprintf("%s%s", emojiIDStr, ext)

	if s.storage != nil {
		if err := s.storage.PutObject(ctx, "emojis", key, bytes.NewReader(data), int64(len(data)), contentType); err != nil {
			return nil, fmt.Errorf("emojis: upload to storage failed: %w", err)
		}
	}

	e := &Emoji{
		ID:          emojiIDStr,
		GuildID:     strconv.FormatInt(guildID, 10),
		Name:        name,
		UploaderID:  strconv.FormatInt(userID, 10),
		Animated:    animated,
		ContentType: contentType,
		CreatedAt:   time.Now().UTC(),
	}

	if err := s.store.CreateEmoji(ctx, e); err != nil {
		if s.storage != nil {
			_ = s.storage.RemoveObject(ctx, "emojis", key)
		}
		return nil, err
	}

	s.publishEmojisUpdate(ctx, guildID)
	return e, nil
}

func (s *Service) DeleteEmoji(ctx context.Context, guildID, userID, emojiID int64) error {
	if err := s.checkManageGuild(ctx, guildID, userID); err != nil {
		return err
	}

	emoji, err := s.store.GetEmoji(ctx, emojiID)
	if err != nil {
		return err
	}
	if emoji.GuildID != strconv.FormatInt(guildID, 10) {
		return ErrNotFound
	}

	if err := s.store.DeleteEmoji(ctx, guildID, emojiID); err != nil {
		return err
	}

	if s.storage != nil {
		ext := ".png"
		if emoji.Animated {
			ext = ".gif"
		}
		key := fmt.Sprintf("%d%s", emojiID, ext)
		_ = s.storage.RemoveObject(ctx, "emojis", key)
	}

	s.publishEmojisUpdate(ctx, guildID)
	return nil
}

func (s *Service) publishEmojisUpdate(ctx context.Context, guildID int64) {
	if s.pub == nil {
		return
	}
	emojis, err := s.store.ListGuildEmojis(ctx, guildID)
	if err != nil {
		slog.Error("emojis: failed to list guild emojis for update event", "guild_id", guildID, "error", err)
		return
	}
	gidStr := strconv.FormatInt(guildID, 10)
	_ = s.pub.Publish(ctx, events.Event{
		Type:    EventTypeGuildEmojisUpdate,
		Version: EventVersion,
		GuildID: gidStr,
		Payload: GuildEmojisUpdatePayload{
			GuildID: gidStr,
			Emojis:  emojis,
		},
	})
}

// ── Stickers ───────────────────────────────────────────────────────────

func (s *Service) ListStickers(ctx context.Context, guildID, userID int64) ([]Sticker, error) {
	if err := s.requireMember(ctx, guildID, userID); err != nil {
		return nil, err
	}
	return s.store.ListGuildStickers(ctx, guildID)
}

func (s *Service) CreateSticker(ctx context.Context, guildID, userID int64, name, description string, file io.Reader, size int64) (*Sticker, error) {
	if err := s.checkManageGuild(ctx, guildID, userID); err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if !validNameRegex.MatchString(name) {
		return nil, ErrInvalidName
	}
	if len(description) > 100 {
		description = description[:100]
	}
	if size <= 0 {
		return nil, ErrEmptyFile
	}
	if size > MaxStickerSizeBytes {
		return nil, ErrFileTooLarge
	}

	data, err := io.ReadAll(io.LimitReader(file, MaxStickerSizeBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > MaxStickerSizeBytes {
		return nil, ErrFileTooLarge
	}
	if len(data) == 0 {
		return nil, ErrEmptyFile
	}

	contentType := http.DetectContentType(data)
	if idx := strings.Index(contentType, ";"); idx != -1 {
		contentType = strings.TrimSpace(contentType[:idx])
	}

	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		// Allowed image formats
	default:
		return nil, ErrInvalidFileType
	}

	stickerID, err := s.sf.Generate()
	if err != nil {
		return nil, err
	}
	stickerIDStr := strconv.FormatInt(stickerID, 10)
	key := fmt.Sprintf("%s.png", stickerIDStr)

	if s.storage != nil {
		if err := s.storage.PutObject(ctx, "stickers", key, bytes.NewReader(data), int64(len(data)), contentType); err != nil {
			return nil, fmt.Errorf("stickers: upload to storage failed: %w", err)
		}
	}

	st := &Sticker{
		ID:          stickerIDStr,
		GuildID:     strconv.FormatInt(guildID, 10),
		Name:        name,
		Description: description,
		UploaderID:  strconv.FormatInt(userID, 10),
		ContentType: contentType,
		CreatedAt:   time.Now().UTC(),
	}

	if err := s.store.CreateSticker(ctx, st); err != nil {
		if s.storage != nil {
			_ = s.storage.RemoveObject(ctx, "stickers", key)
		}
		return nil, err
	}

	s.publishStickersUpdate(ctx, guildID)
	return st, nil
}

func (s *Service) DeleteSticker(ctx context.Context, guildID, userID, stickerID int64) error {
	if err := s.checkManageGuild(ctx, guildID, userID); err != nil {
		return err
	}

	sticker, err := s.store.GetSticker(ctx, stickerID)
	if err != nil {
		return err
	}
	if sticker.GuildID != strconv.FormatInt(guildID, 10) {
		return ErrNotFound
	}

	if err := s.store.DeleteSticker(ctx, guildID, stickerID); err != nil {
		return err
	}

	if s.storage != nil {
		key := fmt.Sprintf("%d.png", stickerID)
		_ = s.storage.RemoveObject(ctx, "stickers", key)
	}

	s.publishStickersUpdate(ctx, guildID)
	return nil
}

func (s *Service) publishStickersUpdate(ctx context.Context, guildID int64) {
	if s.pub == nil {
		return
	}
	stickers, err := s.store.ListGuildStickers(ctx, guildID)
	if err != nil {
		slog.Error("stickers: failed to list guild stickers for update event", "guild_id", guildID, "error", err)
		return
	}
	gidStr := strconv.FormatInt(guildID, 10)
	_ = s.pub.Publish(ctx, events.Event{
		Type:    EventTypeGuildStickersUpdate,
		Version: EventVersion,
		GuildID: gidStr,
		Payload: GuildStickersUpdatePayload{
			GuildID:  gidStr,
			Stickers: stickers,
		},
	})
}

// ── Cross-Server Authorization ─────────────────────────────────────────

// ValidateEmojisAccess validates that for all emojis used by a user:
// 1. If the emoji belongs to another guild, the user must be a member of that guild.
// 2. If using cross-guild emojis, the user must hold USE_EXTERNAL_EMOJIS (hasExternalPerm).
func (s *Service) ValidateEmojisAccess(ctx context.Context, userID, currentGuildID int64, emojiIDs []int64, hasExternalPerm bool) error {
	if len(emojiIDs) == 0 {
		return nil
	}
	emojisMap, err := s.store.GetBatchEmojis(ctx, emojiIDs)
	if err != nil {
		return err
	}

	for _, id := range emojiIDs {
		e, ok := emojisMap[id]
		if !ok {
			// Emoji does not exist or was deleted -> treat as invalid / missing access
			return ErrMissingAccess
		}
		emojiGuildID, err := strconv.ParseInt(e.GuildID, 10, 64)
		if err != nil {
			return err
		}

		// Same guild -> always allowed for members
		if currentGuildID > 0 && emojiGuildID == currentGuildID {
			continue
		}

		// Cross-guild emoji usage ("No Nitro paywall"):
		// Must hold USE_EXTERNAL_EMOJIS in the posting channel/guild
		if !hasExternalPerm {
			return ErrMissingPermissions
		}

		// Must be an active member of the emoji's home guild
		isMember, err := s.store.IsGuildMember(ctx, emojiGuildID, userID)
		if err != nil {
			return err
		}
		if !isMember {
			return ErrMissingPermissions
		}
	}
	return nil
}

// ValidateStickersAccess validates that the user is a member of the sticker's home guild
// and holds USE_EXTERNAL_EMOJIS if cross-guild.
func (s *Service) ValidateStickersAccess(ctx context.Context, userID, currentGuildID int64, stickerIDs []int64, hasExternalPerm bool) error {
	if len(stickerIDs) == 0 {
		return nil
	}
	stickersMap, err := s.store.GetBatchStickers(ctx, stickerIDs)
	if err != nil {
		return err
	}

	for _, id := range stickerIDs {
		st, ok := stickersMap[id]
		if !ok {
			return ErrMissingAccess
		}
		stickerGuildID, err := strconv.ParseInt(st.GuildID, 10, 64)
		if err != nil {
			return err
		}

		if currentGuildID > 0 && stickerGuildID == currentGuildID {
			continue
		}

		if !hasExternalPerm {
			return ErrMissingPermissions
		}

		isMember, err := s.store.IsGuildMember(ctx, stickerGuildID, userID)
		if err != nil {
			return err
		}
		if !isMember {
			return ErrMissingPermissions
		}
	}
	return nil
}
