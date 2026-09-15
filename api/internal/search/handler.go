package search

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/pkg/errs"
)

// Handler serves HTTP requests for the search API (plan/04 §4).
type Handler struct {
	Svc        *Service
	Reconciler *Reconciler
}

func NewHandler(svc *Service, reconciler *Reconciler) *Handler {
	return &Handler{
		Svc:        svc,
		Reconciler: reconciler,
	}
}

// Reconcile handles POST /api/guilds/{id}/messages/search/reconcile.
func (h *Handler) Reconcile(w http.ResponseWriter, r *http.Request) {
	guildIDStr := r.PathValue("id")
	guildID, err := strconv.ParseInt(guildIDStr, 10, 64)
	if err != nil {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad guild id"))
		return
	}

	if h.Reconciler == nil {
		errs.Write(w, errs.Internal())
		return
	}

	sampleSize := 0
	if s := r.URL.Query().Get("sample_size"); s != "" {
		if val, err := strconv.Atoi(s); err == nil && val > 0 {
			sampleSize = val
		}
	}

	report, err := h.Reconciler.Run(r.Context(), guildID, sampleSize)
	if err != nil {
		slog.Error("search reconcile error", "guild_id", guildID, "error", err)
		errs.Write(w, errs.Internal())
		return
	}

	httpx.JSON(w, http.StatusOK, report)
}

// Search handles GET /api/guilds/{id}/messages/search.
// Enforces a strict 500ms deadline to protect API workers from slow full-text queries.
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	guildIDStr := r.PathValue("id")
	guildID, err := strconv.ParseInt(guildIDStr, 10, 64)
	if err != nil {
		errs.Write(w, errs.FormBody("Invalid Form Body: bad guild id"))
		return
	}

	userID, ok := auth.UserIDFrom(r.Context())
	if !ok {
		errs.Write(w, errs.Unauthorized())
		return
	}

	q := r.URL.Query().Get("q")
	if q == "" {
		errs.Write(w, errs.FormBody("Invalid Form Body: query parameter 'q' is required"))
		return
	}

	var channelID int64
	if cidStr := r.URL.Query().Get("channel_id"); cidStr != "" {
		channelID, err = strconv.ParseInt(cidStr, 10, 64)
		if err != nil {
			errs.Write(w, errs.FormBody("Invalid Form Body: bad channel_id"))
			return
		}
	}

	var authorID int64
	if aidStr := r.URL.Query().Get("author_id"); aidStr != "" {
		authorID, err = strconv.ParseInt(aidStr, 10, 64)
		if err != nil {
			errs.Write(w, errs.FormBody("Invalid Form Body: bad author_id"))
			return
		}
	}

	var before int64
	if beforeStr := r.URL.Query().Get("before"); beforeStr != "" {
		before, err = strconv.ParseInt(beforeStr, 10, 64)
		if err != nil {
			errs.Write(w, errs.FormBody("Invalid Form Body: bad before cursor"))
			return
		}
	}

	limit := 25
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		parsedLimit, err := strconv.Atoi(limitStr)
		if err != nil || parsedLimit <= 0 || parsedLimit > 100 {
			errs.Write(w, errs.FormBody("Invalid Form Body: limit must be between 1 and 100"))
			return
		}
		limit = parsedLimit
	}

	offset := 0
	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		parsedOffset, err := strconv.Atoi(offsetStr)
		if err == nil && parsedOffset >= 0 {
			offset = parsedOffset
		}
	}

	// Hard 500ms context timeout as required by plan/04 §4 to avoid worker starvation
	ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
	defer cancel()

	params := SearchParams{
		Query:     q,
		ChannelID: channelID,
		AuthorID:  authorID,
		Before:    before,
		Limit:     limit,
		Offset:    offset,
	}

	resp, err := h.Svc.SearchGuildMessages(ctx, userID, guildID, params)
	if err != nil {
		switch {
		case errors.Is(err, ErrQueryRequired):
			errs.Write(w, errs.FormBody("Invalid Form Body: query parameter 'q' is required"))
		case errors.Is(err, ErrMissingAccess):
			errs.Write(w, errs.MissingAccess())
		case errors.Is(err, context.DeadlineExceeded):
			errs.Write(w, &errs.Error{Status: http.StatusGatewayTimeout, Code: 0, Message: "Search query timed out"})
		default:
			errs.Write(w, errs.Internal())
		}
		return
	}

	httpx.JSON(w, http.StatusOK, resp)
}
