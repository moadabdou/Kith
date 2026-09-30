package readstates

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/pkg/errs"
)

// Handler exposes HTTP REST endpoints for read states.
type Handler struct {
	Svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{Svc: svc}
}

// Ack handles POST /api/channels/{id}/messages/{mid}/ack
func (h *Handler) Ack(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFrom(r.Context())
	if !ok || userID == 0 {
		errs.Write(w, errs.Unauthorized())
		return
	}

	cidStr := r.PathValue("id")
	if cidStr == "" {
		cidStr = r.PathValue("cid")
	}
	channelID, err := strconv.ParseInt(cidStr, 10, 64)
	if err != nil || channelID <= 0 {
		errs.Write(w, errs.UnknownChannel())
		return
	}

	midStr := r.PathValue("mid")
	messageID, err := strconv.ParseInt(midStr, 10, 64)
	if err != nil || messageID <= 0 {
		errs.Write(w, errs.UnknownMessage())
		return
	}

	var req AckRequest
	if r.Body != nil && r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&req)
	}

	if err := h.Svc.AckMessage(r.Context(), userID, channelID, messageID, req.Manual, req.MentionCount); err != nil {
		if errors.Is(err, ErrMissingAccess) {
			errs.Write(w, errs.MissingAccess())
			return
		}
		errs.Write(w, errs.Internal())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetUserReadStates handles GET /api/users/@me/read-states
func (h *Handler) GetUserReadStates(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFrom(r.Context())
	if !ok || userID == 0 {
		errs.Write(w, errs.Unauthorized())
		return
	}

	states, err := h.Svc.ListReadStates(r.Context(), userID)
	if err != nil {
		errs.Write(w, errs.Internal())
		return
	}
	if states == nil {
		states = []ReadState{}
	}

	httpx.JSON(w, http.StatusOK, states)
}

// GetChannelReadState handles GET /api/channels/{id}/read-state
func (h *Handler) GetChannelReadState(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFrom(r.Context())
	if !ok || userID == 0 {
		errs.Write(w, errs.Unauthorized())
		return
	}

	cidStr := r.PathValue("id")
	if cidStr == "" {
		cidStr = r.PathValue("cid")
	}
	channelID, err := strconv.ParseInt(cidStr, 10, 64)
	if err != nil || channelID <= 0 {
		errs.Write(w, errs.UnknownChannel())
		return
	}

	rs, err := h.Svc.GetReadState(r.Context(), userID, channelID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httpx.JSON(w, http.StatusOK, ReadState{
				UserID:            userID,
				ChannelID:         channelID,
				LastReadMessageID: 0,
				MentionCount:      0,
			})
			return
		}
		errs.Write(w, errs.Internal())
		return
	}

	httpx.JSON(w, http.StatusOK, rs)
}
