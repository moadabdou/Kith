package emojis

import (
	"errors"
	"net/http"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/pkg/errs"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

type Handler struct {
	Svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{Svc: svc}
}

func (h *Handler) writeErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrUnknownGuild):
		errs.Write(w, errs.UnknownGuild())
	case errors.Is(err, ErrMissingAccess):
		errs.Write(w, errs.MissingAccess())
	case errors.Is(err, ErrMissingPermissions):
		errs.Write(w, errs.MissingPermissions())
	case errors.Is(err, ErrNotFound):
		errs.Write(w, notFound())
	case errors.Is(err, ErrInvalidName):
		errs.Write(w, errs.FormBody("Invalid Form Body: name must be 2-32 alphanumeric characters"))
	case errors.Is(err, ErrInvalidFileType):
		errs.Write(w, &errs.Error{
			Status:  http.StatusBadRequest,
			Code:    errs.CodeInvalidFormBody,
			Message: "Unsupported file type (only PNG, JPEG, GIF, and WEBP supported)",
		})
	case errors.Is(err, ErrFileTooLarge):
		errs.Write(w, &errs.Error{
			Status:  http.StatusBadRequest,
			Code:    errs.CodeInvalidFormBody,
			Message: "File exceeds maximum allowed size",
		})
	case errors.Is(err, ErrEmptyFile):
		errs.Write(w, errs.FormBody("Invalid Form Body: file is required"))
	default:
		errs.Write(w, errs.Internal())
	}
}

func notFound() *errs.Error {
	return &errs.Error{Status: http.StatusNotFound, Code: 10014, Message: "Unknown Emoji or Sticker"}
}

func mustUser(r *http.Request) int64 {
	uid, _ := auth.UserIDFrom(r.Context())
	return uid
}

func guildIDFromReq(r *http.Request) (int64, bool) {
	id, err := snowflake.Parse(r.PathValue("id"))
	if err != nil || id == 0 {
		return 0, false
	}
	return id, true
}

func pathSnowflake(r *http.Request, key string) (int64, bool) {
	id, err := snowflake.Parse(r.PathValue(key))
	if err != nil || id == 0 {
		return 0, false
	}
	return id, true
}

// ── Emojis Endpoints ───────────────────────────────────────────────────

// ListEmojis handles GET /api/guilds/{id}/emojis.
func (h *Handler) ListEmojis(w http.ResponseWriter, r *http.Request) {
	gid, ok := guildIDFromReq(r)
	if !ok {
		errs.Write(w, errs.UnknownGuild())
		return
	}
	emojis, err := h.Svc.ListEmojis(r.Context(), gid, mustUser(r))
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, emojis)
}

// CreateEmoji handles POST /api/guilds/{id}/emojis.
func (h *Handler) CreateEmoji(w http.ResponseWriter, r *http.Request) {
	gid, ok := guildIDFromReq(r)
	if !ok {
		errs.Write(w, errs.UnknownGuild())
		return
	}

	// Limit body to MaxEmojiSizeBytes + 32KB form metadata
	r.Body = http.MaxBytesReader(w, r.Body, MaxEmojiSizeBytes+32*1024)
	if err := r.ParseMultipartForm(MaxEmojiSizeBytes + 32*1024); err != nil {
		errs.Write(w, errs.FormBody("Invalid Form Body: could not parse multipart form"))
		return
	}

	name := r.FormValue("name")
	file, fileHeader, err := r.FormFile("image")
	if err != nil {
		file, fileHeader, err = r.FormFile("file")
	}
	if err != nil {
		errs.Write(w, errs.FormBody("Invalid Form Body: missing 'image' or 'file' form field"))
		return
	}
	defer file.Close()

	emoji, err := h.Svc.CreateEmoji(r.Context(), gid, mustUser(r), name, file, fileHeader.Size)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, emoji)
}

// DeleteEmoji handles DELETE /api/guilds/{id}/emojis/{emoji_id}.
func (h *Handler) DeleteEmoji(w http.ResponseWriter, r *http.Request) {
	gid, ok := guildIDFromReq(r)
	if !ok {
		errs.Write(w, errs.UnknownGuild())
		return
	}
	emojiID, ok := pathSnowflake(r, "emoji_id")
	if !ok {
		errs.Write(w, notFound())
		return
	}

	if err := h.Svc.DeleteEmoji(r.Context(), gid, mustUser(r), emojiID); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Stickers Endpoints ─────────────────────────────────────────────────

// ListStickers handles GET /api/guilds/{id}/stickers.
func (h *Handler) ListStickers(w http.ResponseWriter, r *http.Request) {
	gid, ok := guildIDFromReq(r)
	if !ok {
		errs.Write(w, errs.UnknownGuild())
		return
	}
	stickers, err := h.Svc.ListStickers(r.Context(), gid, mustUser(r))
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, stickers)
}

// CreateSticker handles POST /api/guilds/{id}/stickers.
func (h *Handler) CreateSticker(w http.ResponseWriter, r *http.Request) {
	gid, ok := guildIDFromReq(r)
	if !ok {
		errs.Write(w, errs.UnknownGuild())
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, MaxStickerSizeBytes+32*1024)
	if err := r.ParseMultipartForm(MaxStickerSizeBytes + 32*1024); err != nil {
		errs.Write(w, errs.FormBody("Invalid Form Body: could not parse multipart form"))
		return
	}

	name := r.FormValue("name")
	desc := r.FormValue("description")
	file, fileHeader, err := r.FormFile("file")
	if err != nil {
		file, fileHeader, err = r.FormFile("image")
	}
	if err != nil {
		errs.Write(w, errs.FormBody("Invalid Form Body: missing 'file' form field"))
		return
	}
	defer file.Close()

	sticker, err := h.Svc.CreateSticker(r.Context(), gid, mustUser(r), name, desc, file, fileHeader.Size)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, sticker)
}

// DeleteSticker handles DELETE /api/guilds/{id}/stickers/{sticker_id}.
func (h *Handler) DeleteSticker(w http.ResponseWriter, r *http.Request) {
	gid, ok := guildIDFromReq(r)
	if !ok {
		errs.Write(w, errs.UnknownGuild())
		return
	}
	stickerID, ok := pathSnowflake(r, "sticker_id")
	if !ok {
		errs.Write(w, notFound())
		return
	}

	if err := h.Svc.DeleteSticker(r.Context(), gid, mustUser(r), stickerID); err != nil {
		h.writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
