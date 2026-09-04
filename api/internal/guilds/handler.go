package guilds

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/pkg/errs"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

const (
	maxInviteAgeSec     = 7 * 24 * 60 * 60 // 7 days, like Discord
	defaultInviteAgeSec = 24 * 60 * 60
	maxInviteUses       = 100
)

// Handler exposes the guild-domain HTTP API.
type Handler struct {
	Svc *Service
}

// formBody is a 400/50035 with a plain message (path params etc.).
func formBody(msg string) *errs.Error {
	return &errs.Error{Status: http.StatusBadRequest, Code: errs.CodeInvalidFormBody, Message: msg}
}

// writeErr maps service errors to the shared Discord envelope (pkg/errs).
func (h *Handler) writeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUnknownGuild):
		errs.Write(w, errs.UnknownGuild())
	case errors.Is(err, ErrUnknownChannel):
		errs.Write(w, errs.UnknownChannel())
	case errors.Is(err, ErrUnknownInvite):
		errs.Write(w, errs.UnknownInvite())
	case errors.Is(err, ErrUnknownMember):
		errs.Write(w, errs.UnknownMember())
	case errors.Is(err, ErrUnknownUser):
		errs.Write(w, errs.UnknownUser())
	case errors.Is(err, ErrMissingAccess):
		errs.Write(w, errs.MissingAccess())
	case errors.Is(err, ErrMissingPermissions):
		errs.Write(w, errs.MissingPermissions())
	default:
		errs.Write(w, errs.Internal())
	}
}

func mustUser(r *http.Request) int64 {
	uid, _ := auth.UserIDFrom(r.Context())
	return uid
}

func pathID(r *http.Request, key string) (int64, bool) {
	id, err := snowflake.Parse(r.PathValue(key))
	if err != nil || id == 0 {
		return 0, false
	}
	return id, true
}

// ── guilds ────────────────────────────────────────────────────────────────

// CreateGuild handles POST /api/guilds.
func (h *Handler) CreateGuild(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, formBody("Invalid Form Body"))
		return
	}
	if name := strings.TrimSpace(req.Name); len(name) < 2 || len(name) > 100 {
		errs.Write(w, formBody("Invalid Form Body: name must be 2-100 chars"))
		return
	}
	g, err := h.Svc.CreateGuild(r.Context(), mustUser(r), strings.TrimSpace(req.Name))
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, g)
}

// GetGuild handles GET /api/guilds/{id}.
func (h *Handler) GetGuild(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	g, err := h.Svc.GetGuild(r.Context(), mustUser(r), id)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, g)
}

// UpdateGuild handles PATCH /api/guilds/{id}.
func (h *Handler) UpdateGuild(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	var req struct {
		Name *string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, formBody("Invalid Form Body"))
		return
	}
	if req.Name == nil {
		g, err := h.Svc.GetGuild(r.Context(), mustUser(r), id)
		if err != nil {
			h.writeErr(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, g)
		return
	}
	name := strings.TrimSpace(*req.Name)
	if len(name) < 2 || len(name) > 100 {
		errs.Write(w, formBody("Invalid Form Body: name must be 2-100 chars"))
		return
	}
	g, err := h.Svc.UpdateGuild(r.Context(), mustUser(r), id, name)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, g)
}

// MyGuilds handles GET /api/users/@me/guilds.
func (h *Handler) MyGuilds(w http.ResponseWriter, r *http.Request) {
	guilds, err := h.Svc.MyGuilds(r.Context(), mustUser(r))
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, guilds)
}

// ── channels ──────────────────────────────────────────────────────────────

// ListChannels handles GET /api/guilds/{id}/channels.
func (h *Handler) ListChannels(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	channels, err := h.Svc.ListChannels(r.Context(), mustUser(r), id)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, channels)
}

// CreateChannel handles POST /api/guilds/{id}/channels.
func (h *Handler) CreateChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	var req struct {
		Name     string  `json:"name"`
		Type     int     `json:"type"`
		Position *int    `json:"position"`
		ParentID *string `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, formBody("Invalid Form Body"))
		return
	}
	if req.Type != 0 && req.Type != 2 {
		errs.Write(w, formBody("Invalid Form Body: type must be 0 (text) or 2 (voice)"))
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 100 {
		errs.Write(w, formBody("Invalid Form Body: name must be 1-100 chars"))
		return
	}
	var position int32
	if req.Position != nil {
		position = int32(*req.Position)
	}
	var parentID *int64
	if req.ParentID != nil {
		pid, err := snowflake.Parse(*req.ParentID)
		if err != nil || pid == 0 {
			errs.Write(w, formBody("Invalid Form Body: bad parent_id"))
			return
		}
		parentID = &pid
	}
	c, err := h.Svc.CreateChannel(r.Context(), mustUser(r), id, int16(req.Type), name, position, parentID)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, c)
}

// UpdateChannel handles PATCH /api/guilds/{id}/channels/{cid}.
func (h *Handler) UpdateChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	cid, ok := pathID(r, "cid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad channel id"))
		return
	}
	var req struct {
		Name     *string `json:"name"`
		Position *int    `json:"position"`
		ParentID *string `json:"parent_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, formBody("Invalid Form Body"))
		return
	}
	var name *string
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" || len(n) > 100 {
			errs.Write(w, formBody("Invalid Form Body: name must be 1-100 chars"))
			return
		}
		name = &n
	}
	var position *int32
	if req.Position != nil {
		p := int32(*req.Position)
		position = &p
	}
	var parentID *int64
	if req.ParentID != nil {
		pid, err := snowflake.Parse(*req.ParentID)
		if err != nil || pid == 0 {
			errs.Write(w, formBody("Invalid Form Body: bad parent_id"))
			return
		}
		parentID = &pid
	}
	c, err := h.Svc.UpdateChannel(r.Context(), mustUser(r), id, cid, name, position, parentID)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, c)
}

// DeleteChannel handles DELETE /api/guilds/{id}/channels/{cid}.
func (h *Handler) DeleteChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	cid, ok := pathID(r, "cid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad channel id"))
		return
	}
	if err := h.Svc.DeleteChannel(r.Context(), mustUser(r), id, cid); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── members ───────────────────────────────────────────────────────────────

// ListMembers handles GET /api/guilds/{id}/members.
func (h *Handler) ListMembers(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	members, err := h.Svc.ListMembers(r.Context(), mustUser(r), id)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, members)
}

// AddMember handles PUT /api/guilds/{id}/members/{uid}.
func (h *Handler) AddMember(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	uid, ok := pathID(r, "uid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad user id"))
		return
	}
	if err := h.Svc.AddMember(r.Context(), mustUser(r), id, uid); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RemoveMember handles DELETE /api/guilds/{id}/members/{uid} (kick or leave).
func (h *Handler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "id")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad guild id"))
		return
	}
	uid, ok := pathID(r, "uid")
	if !ok {
		errs.Write(w, formBody("Invalid Form Body: bad user id"))
		return
	}
	if err := h.Svc.RemoveMember(r.Context(), mustUser(r), id, uid); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── invites ───────────────────────────────────────────────────────────────

// CreateInvite handles POST /api/invites.
func (h *Handler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChannelID string `json:"channel_id"`
		MaxAge    *int   `json:"max_age"`  // seconds; 0 = never; default 86400
		MaxUses   *int   `json:"max_uses"` // 0 = unlimited; default 0
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, formBody("Invalid Form Body"))
		return
	}
	channelID, err := snowflake.Parse(req.ChannelID)
	if err != nil || channelID == 0 {
		errs.Write(w, formBody("Invalid Form Body: bad channel_id"))
		return
	}
	maxAge := defaultInviteAgeSec
	if req.MaxAge != nil {
		if *req.MaxAge < 0 || *req.MaxAge > maxInviteAgeSec {
			errs.Write(w, formBody("Invalid Form Body: max_age must be 0-604800 seconds"))
			return
		}
		maxAge = *req.MaxAge
	}
	maxUses := 0
	if req.MaxUses != nil {
		if *req.MaxUses < 0 || *req.MaxUses > maxInviteUses {
			errs.Write(w, formBody("Invalid Form Body: max_uses must be 0-100"))
			return
		}
		maxUses = *req.MaxUses
	}
	inv, err := h.Svc.CreateInvite(r.Context(), mustUser(r), channelID,
		durationFromSeconds(maxAge), int32(maxUses))
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, inv)
}

// JoinInvite handles POST /api/invites/{code}/join.
func (h *Handler) JoinInvite(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	if code == "" || len(code) > 32 {
		errs.Write(w, formBody("Invalid Form Body: bad invite code"))
		return
	}
	g, err := h.Svc.JoinInvite(r.Context(), mustUser(r), code)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, g)
}

func durationFromSeconds(sec int) time.Duration {
	return time.Duration(sec) * time.Second
}
