package messages

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

// Discord error codes — registry moves to pkg/errs in #8.
const (
	codeUnknownChannel  = 10003
	codeUnknownMessage  = 10008
	codeMissingAccess   = 50001
	codeMissingPerms    = 50013
	codeInvalidFormBody = 50035
	codeCannotEditOther = 50005
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
		httpx.Error(w, http.StatusNotFound, codeUnknownChannel, "Unknown Channel")
	case errors.Is(err, ErrUnknownMessage):
		httpx.Error(w, http.StatusNotFound, codeUnknownMessage, "Unknown Message")
	case errors.Is(err, ErrMissingAccess):
		httpx.Error(w, http.StatusForbidden, codeMissingAccess, "Missing Access")
	case errors.Is(err, ErrNotAuthor):
		httpx.Error(w, http.StatusForbidden, codeCannotEditOther, "Cannot edit a message authored by another user")
	case errors.Is(err, ErrEditWindowOver):
		httpx.Error(w, http.StatusForbidden, codeMissingPerms, "The edit window for this message has passed")
	case errors.Is(err, ErrContentRequired):
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: content is required")
	default:
		httpx.Error(w, http.StatusInternalServerError, 0, "Internal Server Error")
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
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: bad channel id")
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body")
		return
	}
	if req.Content == "" || len(req.Content) > maxContentLen {
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody,
			"Invalid Form Body: content must be 1-4000 chars")
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
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: bad channel id")
		return
	}
	var before int64
	if b := r.URL.Query().Get("before"); b != "" {
		var err error
		before, err = snowflake.Parse(b)
		if err != nil || before <= 0 {
			httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: bad before cursor")
			return
		}
	}
	limit := 50
	if l := r.URL.Query().Get("limit"); l != "" {
		var err error
		limit, err = parseLimit(l)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: limit must be 1-100")
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
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: bad channel id")
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: bad message id")
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body")
		return
	}
	if req.Content == "" || len(req.Content) > maxContentLen {
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody,
			"Invalid Form Body: content must be 1-4000 chars")
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
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: bad channel id")
		return
	}
	mid, ok := pathID(r, "mid")
	if !ok {
		httpx.Error(w, http.StatusBadRequest, codeInvalidFormBody, "Invalid Form Body: bad message id")
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
