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
	"github.com/moadabdou/Kith/api/internal/media"
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
	ID          string             `json:"id"`
	ChannelID   string             `json:"channel_id"`
	GuildID     string             `json:"guild_id,omitempty"`
	Author      AuthorRef          `json:"author"`
	Content     string             `json:"content"`
	CreatedAt   time.Time          `json:"timestamp"`
	EditedAt    *time.Time         `json:"edited_timestamp"`
	Attachments []media.Attachment `json:"attachments,omitempty"`
	Reactions   []ReactionTally    `json:"reactions,omitempty"`
}

type AuthorRef struct {
	ID            string `json:"id"`
	Username      string `json:"username"`
	Discriminator string `json:"discriminator"`
}

const (
	eventTypeMessageCreate         = "MESSAGE_CREATE"
	eventTypeMessageUpdate         = "MESSAGE_UPDATE"
	eventTypeMessageDelete         = "MESSAGE_DELETE"
	eventTypeMessageReactionAdd    = "MESSAGE_REACTION_ADD"
	eventTypeMessageReactionRemove = "MESSAGE_REACTION_REMOVE"
	eventVersion                   = 1
)

type MessageDeletePayload struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	GuildID   string `json:"guild_id,omitempty"`
}

type MessageReactionEvent struct {
	UserID    string `json:"user_id"`
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	GuildID   string `json:"guild_id,omitempty"`
	Emoji     string `json:"emoji"`
}

// MediaLinker abstracts attachment linking and retrieval for messages.
type MediaLinker interface {
	GetAttachmentsForMessages(ctx context.Context, messageIDs []int64) (map[string][]media.Attachment, error)
	LinkAttachmentsToMessage(ctx context.Context, messageID int64, attachmentIDs []int64, channelID, uploaderID int64) ([]media.Attachment, error)
}

type Service struct {
	db         *sql.DB
	store      Store
	sf         *snowflake.Node
	pub        events.Publisher
	mediaStore MediaLinker
	signer     *media.URLSigner
	reactions  ReactionsStore
}

func NewService(db *sql.DB, store Store, sf *snowflake.Node, pub events.Publisher, mediaStores ...MediaLinker) *Service {
	if store == nil && db != nil {
		store = NewPostgresStore(db)
	}
	var ms MediaLinker
	if len(mediaStores) > 0 {
		ms = mediaStores[0]
	}
	return &Service{db: db, store: store, sf: sf, pub: pub, mediaStore: ms}
}

// SetSigner sets the media URLSigner for signing attachments in private channels.
func (s *Service) SetSigner(signer *media.URLSigner) {
	s.signer = signer
}

// SetReactionsStore sets the ReactionsStore for emoji reaction mutations and hydration.
func (s *Service) SetReactionsStore(reactions ReactionsStore) {
	s.reactions = reactions
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
	var attIDs []string
	if len(attachments) > 0 && len(attachments[0]) > 0 {
		if !permissions.Has(perms, permissions.ATTACH_FILES) {
			return nil, ErrMissingPermissions
		}
		attIDs = attachments[0]
	}
	if content == "" && len(attIDs) == 0 {
		return nil, ErrContentRequired
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

	var parsedIDs []int64
	if len(attIDs) > 0 && s.mediaStore != nil {
		parsedIDs = make([]int64, 0, len(attIDs))
		for _, rawID := range attIDs {
			pID, err := strconv.ParseInt(rawID, 10, 64)
			if err != nil || pID <= 0 {
				return nil, media.ErrAttachmentConflict
			}
			parsedIDs = append(parsedIDs, pID)
		}
	}

	if err := s.store.Insert(ctx, m); err != nil {
		return nil, err
	}

	if len(parsedIDs) > 0 && s.mediaStore != nil {
		var linked []media.Attachment
		if linker, ok := s.mediaStore.(interface {
			FinalizeAndLink(ctx context.Context, messageID int64, attachmentIDs []int64, channelID, uploaderID, guildID int64) ([]media.Attachment, error)
		}); ok {
			linked, err = linker.FinalizeAndLink(ctx, id, parsedIDs, channelID, userID, ref.GuildID)
		} else {
			linked, err = s.mediaStore.LinkAttachmentsToMessage(ctx, id, parsedIDs, channelID, userID)
		}
		if err != nil {
			_ = s.store.Delete(ctx, channelID, id, userID)
			return nil, err
		}
		if s.signer != nil && s.isChannelPrivate(ctx, channelID, ref.GuildID) {
			for j := range linked {
				s.signer.SignAttachment(&linked[j], true, 24*time.Hour)
			}
		}
		m.Attachments = linked
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
	ref, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return nil, ErrMissingAccess
	}
	if !permissions.Has(perms, permissions.READ_MESSAGE_HISTORY) {
		return nil, ErrMissingPermissions
	}
	msgs, err := s.store.List(ctx, channelID, before, limit)
	if err != nil {
		return nil, err
	}
	_ = s.hydrateAttachments(ctx, msgs, channelID, ref.GuildID)
	_ = s.hydrateReactions(ctx, msgs, channelID, userID)
	return msgs, nil
}

// ListAfter returns messages in a channel newer than cursor position, ordered oldest-first (forward pagination).
func (s *Service) ListAfter(ctx context.Context, userID, channelID int64, after Cursor, limit int) ([]Message, error) {
	ref, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return nil, ErrMissingAccess
	}
	if !permissions.Has(perms, permissions.READ_MESSAGE_HISTORY) {
		return nil, ErrMissingPermissions
	}
	msgs, err := s.store.ListAfter(ctx, channelID, after, limit)
	if err != nil {
		return nil, err
	}
	_ = s.hydrateAttachments(ctx, msgs, channelID, ref.GuildID)
	_ = s.hydrateReactions(ctx, msgs, channelID, userID)
	return msgs, nil
}

func (s *Service) hydrateAttachments(ctx context.Context, msgs []Message, channelID, guildID int64) error {
	if s.mediaStore == nil || len(msgs) == 0 {
		return nil
	}
	msgIDs := make([]int64, 0, len(msgs))
	for _, m := range msgs {
		if id, err := strconv.ParseInt(m.ID, 10, 64); err == nil && id > 0 {
			msgIDs = append(msgIDs, id)
		}
	}
	if len(msgIDs) == 0 {
		return nil
	}
	attMap, err := s.mediaStore.GetAttachmentsForMessages(ctx, msgIDs)
	if err != nil {
		return err
	}
	isPrivate := s.isChannelPrivate(ctx, channelID, guildID)
	for i := range msgs {
		if atts, ok := attMap[msgs[i].ID]; ok {
			if s.signer != nil && isPrivate {
				for j := range atts {
					s.signer.SignAttachment(&atts[j], true, 24*time.Hour)
				}
			}
			msgs[i].Attachments = atts
		}
	}
	return nil
}

func (s *Service) isChannelPrivate(ctx context.Context, channelID, guildID int64) bool {
	if guildID == 0 {
		return true
	}
	if s.db == nil {
		return false
	}
	var deny uint64
	err := s.db.QueryRowContext(ctx, `
		SELECT deny FROM channel_overwrites 
		WHERE channel_id = $1 AND target_id = $2`, channelID, guildID).Scan(&deny)
	if err == nil {
		return permissions.Has(deny, permissions.VIEW_CHANNEL)
	}
	return false
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

func (s *Service) hydrateReactions(ctx context.Context, msgs []Message, channelID, userID int64) error {
	if s.reactions == nil || len(msgs) == 0 {
		return nil
	}
	msgIDs := make([]int64, 0, len(msgs))
	for _, m := range msgs {
		if id, err := strconv.ParseInt(m.ID, 10, 64); err == nil && id > 0 {
			msgIDs = append(msgIDs, id)
		}
	}
	if len(msgIDs) == 0 {
		return nil
	}
	talliesMap, err := s.reactions.GetReactionsForMessages(ctx, channelID, msgIDs, userID)
	if err != nil {
		return err
	}
	for i := range msgs {
		if tallies, ok := talliesMap[msgs[i].ID]; ok {
			msgs[i].Reactions = tallies
		}
	}
	return nil
}

func (s *Service) AddReaction(ctx context.Context, userID, channelID, messageID int64, emoji string) error {
	if emoji == "" {
		return ErrInvalidEmoji
	}
	ref, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return ErrMissingAccess
	}

	if s.reactions == nil {
		return errors.New("messages: reactions store not configured")
	}

	if s.store != nil {
		if _, err := s.store.Get(ctx, channelID, messageID); err != nil {
			return err
		}
	}

	if !permissions.Has(perms, permissions.ADD_REACTIONS) {
		talliesMap, err := s.reactions.GetReactionsForMessages(ctx, channelID, []int64{messageID}, userID)
		if err != nil {
			return err
		}
		midStr := strconv.FormatInt(messageID, 10)
		hasEmoji := false
		for _, t := range talliesMap[midStr] {
			if t.Emoji == emoji {
				hasEmoji = true
				break
			}
		}
		if !hasEmoji {
			return ErrMissingPermissions
		}
	}

	if err := s.reactions.AddReaction(ctx, channelID, messageID, emoji, userID); err != nil {
		return err
	}

	if s.pub != nil {
		var gid string
		if ref.GuildID > 0 {
			gid = strconv.FormatInt(ref.GuildID, 10)
		}
		if err := s.pub.Publish(ctx, events.Event{
			Type:    eventTypeMessageReactionAdd,
			Version: eventVersion,
			GuildID: gid,
			Payload: MessageReactionEvent{
				UserID:    strconv.FormatInt(userID, 10),
				ChannelID: strconv.FormatInt(channelID, 10),
				MessageID: strconv.FormatInt(messageID, 10),
				GuildID:   gid,
				Emoji:     emoji,
			},
		}); err != nil {
			slog.ErrorContext(ctx, "failed to publish reaction add event", "error", err)
		}
	}

	return nil
}

func (s *Service) RemoveReaction(ctx context.Context, actorID, targetUserID, channelID, messageID int64, emoji string) error {
	if emoji == "" {
		return ErrInvalidEmoji
	}
	ref, perms, err := s.requireChannelPerms(ctx, actorID, channelID)
	if err != nil {
		return err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return ErrMissingAccess
	}

	if actorID != targetUserID && !permissions.Has(perms, permissions.MANAGE_MESSAGES) {
		return ErrMissingPermissions
	}

	if s.reactions == nil {
		return errors.New("messages: reactions store not configured")
	}

	if err := s.reactions.RemoveReaction(ctx, channelID, messageID, emoji, targetUserID); err != nil {
		return err
	}

	if s.pub != nil {
		var gid string
		if ref.GuildID > 0 {
			gid = strconv.FormatInt(ref.GuildID, 10)
		}
		if err := s.pub.Publish(ctx, events.Event{
			Type:    eventTypeMessageReactionRemove,
			Version: eventVersion,
			GuildID: gid,
			Payload: MessageReactionEvent{
				UserID:    strconv.FormatInt(targetUserID, 10),
				ChannelID: strconv.FormatInt(channelID, 10),
				MessageID: strconv.FormatInt(messageID, 10),
				GuildID:   gid,
				Emoji:     emoji,
			},
		}); err != nil {
			slog.ErrorContext(ctx, "failed to publish reaction remove event", "error", err)
		}
	}

	return nil
}

func (s *Service) ListReactors(ctx context.Context, userID, channelID, messageID int64, emoji string, limit int, after int64) ([]AuthorRef, error) {
	if emoji == "" {
		return nil, ErrInvalidEmoji
	}
	_, perms, err := s.requireChannelPerms(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	if !permissions.Has(perms, permissions.VIEW_CHANNEL) {
		return nil, ErrMissingAccess
	}

	if s.reactions == nil {
		return []AuthorRef{}, nil
	}

	uids, err := s.reactions.ListReactors(ctx, channelID, messageID, emoji, limit, after)
	if err != nil {
		return nil, err
	}
	if len(uids) == 0 {
		return []AuthorRef{}, nil
	}

	return s.hydrateUsers(ctx, uids)
}

func (s *Service) hydrateUsers(ctx context.Context, uids []int64) ([]AuthorRef, error) {
	if s.db == nil || len(uids) == 0 {
		authors := make([]AuthorRef, len(uids))
		for i, id := range uids {
			authors[i] = AuthorRef{ID: strconv.FormatInt(id, 10)}
		}
		return authors, nil
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT id, username, to_char(discriminator, 'FM0000')
		FROM users WHERE id = ANY($1)`, uids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	userMap := make(map[int64]AuthorRef)
	for rows.Next() {
		var uid int64
		var ref AuthorRef
		if err := rows.Scan(&uid, &ref.Username, &ref.Discriminator); err != nil {
			return nil, err
		}
		ref.ID = strconv.FormatInt(uid, 10)
		userMap[uid] = ref
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	result := make([]AuthorRef, 0, len(uids))
	for _, uid := range uids {
		if ref, ok := userMap[uid]; ok {
			result = append(result, ref)
		} else {
			result = append(result, AuthorRef{ID: strconv.FormatInt(uid, 10)})
		}
	}
	return result, nil
}
