package messages

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
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
	case errors.Is(err, ErrContentRequired):
		errs.Write(w, errs.FormBody("Invalid Form Body: content is required"))
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
		Content     string   `json:"content"`
		Attachments []string `json:"attachments"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, errs.InvalidJSON())
		return
	}
	if e := validateContent(req.Content); e != nil {
		errs.Write(w, e)
		return
	}
	m, err := h.Svc.Send(r.Context(), mustUser(r), cid, req.Content, req.Attachments)
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
	v := errs.NewValidator()
	v.Check("content", content != "", errs.CodeRequired, "This field is required")
	v.Check("content", len(content) <= maxContentLen, errs.CodeBadLength,
		"Must be between 1 and 4000 in length.")
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
