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

// formBody is a 400/50035 with a plain message.
func formBody(msg string) *errs.Error {
	return &errs.Error{Status: http.StatusBadRequest, Code: errs.CodeInvalidFormBody, Message: msg}
}

func (h *Handler) writeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUnknownChannel):
		errs.Write(w, errs.UnknownChannel())
	case errors.Is(err, ErrUnknownMessage):
		errs.Write(w, errs.UnknownMessage())
	case errors.Is(err, ErrMissingAccess):
		errs.Write(w, errs.MissingAccess())
	case errors.Is(err, ErrNotAuthor):
		errs.Write(w, errs.CannotEditOther())
	case errors.Is(err, ErrEditWindowOver):
		errs.Write(w, &errs.Error{Status: http.StatusForbidden, Code: errs.CodeMissingPerms,
			Message: "The edit window for this message has passed"})
	case errors.Is(err, ErrContentRequired):
		errs.Write(w, formBody("Invalid Form Body: content is required"))
	default:
		errs.Write(w, errs.Internal())
	}
}

func mustUser(r *http.Request) int64 {
	uid, _ := auth.UserIDFrom(r.Context())
	return uid
}

// Send handles POST /api/guilds/{id}/channels/{cid}/messages.
// Rate limiting (#7) wraps this handler — the hot path stays readable.
func (h *Handler) Send(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathID(r, "cid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad channel id"))
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, formBody("Invalid Form Body"))
		return
	}
	if e := validateContent(req.Content); e != nil {
		errs.Write(w, e)
		return
	}
	m, err := h.Svc.Send(r.Context(), mustUser(r), cid, req.Content)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	// Same shape as the MESSAGE_CREATE payload — one struct, two uses.
	httpx.JSON(w, http.StatusCreated, m)
}

// List handles GET /api/guilds/{id}/channels/{cid}/messages?before=<id>&limit=50.
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathID(r, "cid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad channel id"))
		return
	}
	var before int64
	if b := r.URL.Query().Get("before"); b != "" {
		var err error
		before, err = snowflake.Parse(b)
		if err != nil || before <= 0 {
			errs.Write(w, formBody("Invalid Form Body: bad before cursor"))
			return
		}
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		var err error
		limit, err = parseLimit(l)
		if err != nil {
			errs.Write(w, formBody("Invalid Form Body: limit must be 1-100"))
			return
		}
	}
	msgs, err := h.Svc.List(r.Context(), mustUser(r), cid, before, limit)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, msgs)
}

// Edit handles PATCH /api/channels/{cid}/messages/{mid}.
func (h *Handler) Edit(w http.ResponseWriter, r *http.Request) {
	cid, ok := pathID(r, "cid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad channel id"))
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad message id"))
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, formBody("Invalid Form Body"))
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
		errs.Write(w, formBody("Invalid Form Body: bad channel id"))
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad message id"))
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
