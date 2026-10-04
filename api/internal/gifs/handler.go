package gifs

import (
	"net/http"
	"strconv"

	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/pkg/errs"
)

type Handler struct {
	Svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{Svc: svc}
}

// Trending handles GET /api/gifs/trending.
func (h *Handler) Trending(w http.ResponseWriter, r *http.Request) {
	page := parseQueryInt(r, "page", 1)
	perPage := parseQueryInt(r, "per_page", 24)
	if perPage > 50 {
		perPage = 50
	}

	resp, err := h.Svc.Trending(r.Context(), page, perPage)
	if err != nil {
		errs.Write(w, errs.Internal())
		return
	}

	httpx.JSON(w, http.StatusOK, resp)
}

// Search handles GET /api/gifs/search.
func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	page := parseQueryInt(r, "page", 1)
	perPage := parseQueryInt(r, "per_page", 24)
	if perPage > 50 {
		perPage = 50
	}

	resp, err := h.Svc.Search(r.Context(), q, page, perPage)
	if err != nil {
		errs.Write(w, errs.Internal())
		return
	}

	httpx.JSON(w, http.StatusOK, resp)
}

// Categories handles GET /api/gifs/categories.
func (h *Handler) Categories(w http.ResponseWriter, r *http.Request) {
	cats, err := h.Svc.Categories(r.Context())
	if err != nil {
		errs.Write(w, errs.Internal())
		return
	}

	httpx.JSON(w, http.StatusOK, cats)
}

func parseQueryInt(r *http.Request, key string, fallback int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}
