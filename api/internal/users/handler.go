package users

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/httpx"
)

// Handler serves user endpoints.
type Handler struct {
	DB *sql.DB
}

// Me handles GET /api/users/@me — the current authenticated user.
func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserIDFrom(r.Context())
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, 0, "401: Unauthorized")
		return
	}
	var resp struct {
		ID            string    `json:"id"`
		Username      string    `json:"username"`
		Discriminator string    `json:"discriminator"`
		Email         string    `json:"email"`
		CreatedAt     time.Time `json:"created_at"`
	}
	err := h.DB.QueryRowContext(r.Context(), `
		SELECT id::text, username, to_char(discriminator, 'FM0000'), email, created_at
		FROM users WHERE id = $1`, uid,
	).Scan(&resp.ID, &resp.Username, &resp.Discriminator, &resp.Email, &resp.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(w, http.StatusUnauthorized, 0, "401: Unauthorized")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, 0, "Internal Server Error")
		return
	}
	httpx.JSON(w, http.StatusOK, resp)
}
