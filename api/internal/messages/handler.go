package messages

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/internal/media"
	"github.com/moadabdou/Kith/api/pkg/errs"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

const (
	maxContentLen = 4000 // Discord's limit
	maxLimit      = 100
)

// Handler exposes the message endpoints.
type Handler struct {
	Svc *Service
	// Inflight bounds concurrent Send work (Issue #92): overflow fails
	// fast with 429 instead of queueing against the DB pool. Nil rejects
	// (fail closed) — construct with NewHandler.
	Inflight *Inflight
}

// NewHandler wires a Service with an in-flight cap for Send.
// Non-positive max falls back to DefaultMaxInflight.
func NewHandler(svc *Service, maxInflight int) *Handler {
	return &Handler{Svc: svc, Inflight: NewInflight(maxInflight)}
}

func (h *Handler) writeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUnknownChannel):
		errs.Write(w, errs.UnknownChannel())
	case errors.Is(err, ErrUnknownMessage):
		errs.Write(w, errs.UnknownMessage())
	case errors.Is(err, ErrMissingAccess):
		errs.Write(w, errs.MissingAccess())
	case errors.Is(err, ErrMissingPermissions):
		errs.Write(w, errs.MissingPermissions())
	case errors.Is(err, ErrNotAuthor):
		errs.Write(w, errs.CannotEditOther())
	case errors.Is(err, ErrEditWindowOver):
		errs.Write(w, &errs.Error{Status: http.StatusForbidden, Code: errs.CodeMissingPerms,
			Message: "The edit window for this message has passed"})
	case errors.Is(err, media.ErrAttachmentConflict):
		errs.Write(w, &errs.Error{Status: http.StatusBadRequest, Code: errs.CodeInvalidFormBody,
			Message: "Invalid or already linked attachment"})
	case errors.Is(err, ErrContentRequired):
		errs.Write(w, errs.FormBody("Invalid Form Body: content is required"))
	case errors.Is(err, ErrInvalidEmoji):
		errs.Write(w, errs.FormBody("Invalid Form Body: invalid emoji"))
	case errors.Is(err, ErrInvalidMessageID):
		errs.Write(w, errs.FormBody("Invalid Form Body: bad message id"))
	case errors.Is(err, ErrInvalidChannelID):
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
	case errors.Is(err, ErrInvalidUserID):
		errs.Write(w, errs.FormBody("Invalid Form Body: bad user id"))
	case errors.Is(err, ErrReferencedMessageNotFound):
		errs.Write(w, errs.FormBody("Invalid Form Body: referenced message not found"))
	case errors.Is(err, ErrReferencedMessageWrongChannel):
		errs.Write(w, errs.FormBody("Invalid Form Body: cannot reply to a message in another channel"))
	case errors.Is(err, ErrInvalidMessageReference):
		errs.Write(w, errs.FormBody("Invalid Form Body: invalid message reference"))
	default:
		errs.Write(w, errs.Internal())
	}
}

func mustUser(r *http.Request) int64 {
	uid, _ := auth.UserIDFrom(r.Context())
	return uid
}

func channelIDFromReq(r *http.Request) (int64, bool) {
	if cid, ok := pathID(r, "cid"); ok {
		return cid, true
	}
	return pathID(r, "id")
}

// Send handles POST /api/guilds/{id}/channels/{cid}/messages and POST /api/channels/{id}/messages.
// Rate limiting (#7) wraps this handler — the hot path stays readable.
func (h *Handler) Send(w http.ResponseWriter, r *http.Request) {
	cid, ok := channelIDFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
		return
	}
	var req struct {
		Content          string            `json:"content"`
		Attachments      []string          `json:"attachments"`
		AttachmentIDs    []string          `json:"attachment_ids"`
		MessageReference *MessageReference `json:"message_reference,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, errs.InvalidJSON())
		return
	}
	attachmentIDs := req.Attachments
	if len(attachmentIDs) == 0 && len(req.AttachmentIDs) > 0 {
		attachmentIDs = req.AttachmentIDs
	}
	if req.MessageReference != nil && req.MessageReference.MessageID == "" {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad message reference"))
		return
	}
	if e := validateContentOrAttachment(req.Content, len(attachmentIDs) > 0); e != nil {
		errs.Write(w, e)
		return
	}
	// Issue #92 fast-reject: validation (cheap) runs first so malformed
	// requests never consume a slot; the semaphore guards everything
	// downstream (perm checks, insert, publish). Rejection is immediate —
	// never a wait — and release is deferred to cover success, error,
	// and panic paths alike.
	if !h.Inflight.TryAcquire() {
		w.Header().Set("Retry-After", "1")
		errs.Write(w, errs.RateLimited(1, false))
		return
	}
	defer h.Inflight.Release()
	m, err := h.Svc.SendWithReference(r.Context(), mustUser(r), cid, req.Content, attachmentIDs, req.MessageReference)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	// Same shape as the MESSAGE_CREATE payload — one struct, two uses.
	httpx.JSON(w, http.StatusCreated, m)
}

// List handles GET /api/guilds/{id}/channels/{cid}/messages?before=<id>&limit=50.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	cid, ok := channelIDFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
		return
	}
	var before Cursor
	if b := r.URL.Query().Get("before"); b != "" {
		var err error
		before, err = ParseCursor(b)
		if err != nil {
			errs.Write(w, errs.FormBody("Invalid Form Body: bad before cursor"))
			return
		}
	}
	var after Cursor
	if a := r.URL.Query().Get("after"); a != "" {
		var err error
		after, err = ParseCursor(a)
		if err != nil {
			errs.Write(w, errs.FormBody("Invalid Form Body: bad after cursor"))
			return
		}
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		var err error
		limit, err = parseLimit(l)
		if err != nil {
			errs.Write(w, errs.FormBody("Invalid Form Body: limit must be 1-100"))
			return
		}
	}

	var msgs []Message
	var err error
	if after.MessageID > 0 {
		msgs, err = h.Svc.ListAfter(r.Context(), mustUser(r), cid, after, limit)
	} else {
		msgs, err = h.Svc.List(r.Context(), mustUser(r), cid, before, limit)
	}
	if err != nil {
		h.writeErr(w, err)
		return
	}
	if len(msgs) > 0 {
		w.Header().Set("X-Next-Cursor", NextCursorToken(msgs))
	}
	httpx.JSON(w, http.StatusOK, msgs)
}

// ChannelsLatest handles GET /api/guilds/{id}/channels/latest (Issue #105):
// bulk newest-message cursor per readable text channel so the client can
// hydrate unread badges on login/refresh in one round trip instead of N
// per-channel history fetches.
func (h *Handler) ChannelsLatest(w http.ResponseWriter, r *http.Request) {
	gid, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad guild id"))
		return
	}
	latest, err := h.Svc.GetChannelsLatest(r.Context(), mustUser(r), gid)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, latest)
}

// Edit handles PATCH /api/channels/{cid}/messages/{mid}.
func (h *Handler) Edit(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathID(r, "cid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad message id"))
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, errs.InvalidJSON())
		return
	}
	if e := validateContent(req.Content); e != nil {
		errs.Write(w, e)
		return
	}
	m, err := h.Svc.Edit(r.Context(), mustUser(r), cid, mid, req.Content)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, m)
}

// Delete handles DELETE /api/channels/{cid}/messages/{mid}.
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathID(r, "cid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad message id"))
		return
	}
	if err := h.Svc.Delete(r.Context(), mustUser(r), cid, mid); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func pathID(r *http.Request, key string) (int64, bool) {
	id, err := snowflake.Parse(r.PathValue(key))
	if err != nil || id == 0 {
		return 0, false
	}
	return id, true
}

// validateContent centralizes message-content validation in Discord's
// 50035 field-detail shape.
func validateContent(content string) *errs.Error {
	return validateContentOrAttachment(content, false)
}

func validateContentOrAttachment(content string, hasAttachments bool) *errs.Error {
	v := errs.NewValidator()
	if !hasAttachments {
		v.Check("content", content != "", errs.CodeRequired, "This field is required")
	}
	if content != "" {
		v.Check("content", len(content) <= maxContentLen, errs.CodeBadLength,
			"Must be between 1 and 4000 in length.")
	}
	return v.Err()
}

func parseLimit(s string) (int, error) {
	limit := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, errBadLimit
		}
		limit = limit*10 + int(c-'0')
		if limit > maxLimit {
			return 0, errBadLimit
		}
	}
	if limit == 0 {
		return 0, errBadLimit
	}
	return limit, nil
}

var errBadLimit = errors.New("bad limit")

func emojiFromReq(r *http.Request) (string, bool) {
	raw := r.PathValue("emoji")
	if raw == "" {
		return "", false
	}
	unescaped, err := url.PathUnescape(raw)
	if err == nil && unescaped != "" {
		return unescaped, true
	}
	return raw, true
}

// AddReaction handles PUT /api/channels/{cid}/messages/{mid}/reactions/{emoji}/@me
// and PUT /api/guilds/{id}/channels/{cid}/messages/{mid}/reactions/{emoji}/@me.
func (h *Handler) AddReaction(w http.ResponseWriter, r *http.Request) {
	cid, ok := channelIDFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad message id"))
		return
	}
	emoji, ok := emojiFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad emoji"))
		return
	}
	if err := h.Svc.AddReaction(r.Context(), mustUser(r), cid, mid, emoji); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemoveOwnReaction handles DELETE /api/channels/{cid}/messages/{mid}/reactions/{emoji}/@me
// and DELETE /api/guilds/{id}/channels/{cid}/messages/{mid}/reactions/{emoji}/@me.
func (h *Handler) RemoveOwnReaction(w http.ResponseWriter, r *http.Request) {
	cid, ok := channelIDFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad message id"))
		return
	}
	emoji, ok := emojiFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad emoji"))
		return
	}
	uid := mustUser(r)
	if err := h.Svc.RemoveReaction(r.Context(), uid, uid, cid, mid, emoji); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemoveUserReaction handles DELETE /api/channels/{cid}/messages/{mid}/reactions/{emoji}/{uid}
// and DELETE /api/guilds/{id}/channels/{cid}/messages/{mid}/reactions/{emoji}/{uid}.
func (h *Handler) RemoveUserReaction(w http.ResponseWriter, r *http.Request) {
	cid, ok := channelIDFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad message id"))
		return
	}
	emoji, ok := emojiFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad emoji"))
		return
	}
	targetUID, ok := pathID(r, "uid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad user id"))
		return
	}
	if err := h.Svc.RemoveReaction(r.Context(), mustUser(r), targetUID, cid, mid, emoji); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListReactors handles GET /api/channels/{cid}/messages/{mid}/reactions/{emoji}
// and GET /api/guilds/{id}/channels/{cid}/messages/{mid}/reactions/{emoji}.
func (h *Handler) ListReactors(w http.ResponseWriter, r *http.Request) {
	cid, ok := channelIDFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad channel id"))
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad message id"))
		return
	}
	emoji, ok := emojiFromReq(r)
	if !ok {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad emoji"))
		return
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := parseLimit(l); err == nil {
			limit = parsed
		}
	}
	var after int64
	if a := r.URL.Query().Get("after"); a != "" {
		if parsed, err := snowflake.Parse(a); err == nil {
			after = parsed
		}
	}
	reactors, err := h.Svc.ListReactors(r.Context(), mustUser(r), cid, mid, emoji, limit, after)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, reactors)
}
