package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/mail"
	"regexp"
	"time"

	"github.com/moadabdou/Kith/api/internal/httpx"
)

var usernameRe = regexp.MustCompile(`^[a-z0-9._]{3,32}$`)

// Handler exposes the auth endpoints.
type Handler struct {
	Svc *Service
}

type userResponse struct {
	ID            string    `json:"id"`
	Username      string    `json:"username"`
	Discriminator string    `json:"discriminator"`
	Email         string    `json:"email"`
	CreatedAt     time.Time `json:"created_at"`
}

func toUserResponse(u *User) userResponse {
	return userResponse{
		ID:            itoa(u.ID),
		Username:      u.Username,
		Discriminator: fmt.Sprintf("%04d", u.Discriminator),
		Email:         u.Email,
		CreatedAt:     u.CreatedAt,
	}
}

// Register handles POST /api/auth/register.
func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.Error(w, http.StatusBadRequest, 50035, "Invalid Form Body")
		return
	}
	if err := validateRegister(req.Username, req.Email, req.Password); err != "" {
		httpx.Error(w, http.StatusBadRequest, 50035, "Invalid Form Body: "+err)
		return
	}
	u, err := h.Svc.Register(r.Context(), req.Username, req.Email, req.Password)
	switch {
	case err == ErrDuplicate:
		httpx.Error(w, http.StatusConflict, 0, "Username or email already taken")
	case err != nil:
		httpx.Error(w, http.StatusInternalServerError, 0, "Internal Server Error")
	default:
		httpx.JSON(w, http.StatusCreated, toUserResponse(u))
	}
}

// Login handles POST /api/auth/login. Login accepts username or email.
func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Login    string `json:"login"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Login == "" || req.Password == "" {
		httpx.Error(w, http.StatusBadRequest, 50035, "Invalid Form Body")
		return
	}
	u, refresh, err := h.Svc.Login(r.Context(), req.Login, req.Password)
	if err == ErrInvalidCredentials {
		httpx.Error(w, http.StatusUnauthorized, 0, "401: Unauthorized")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, 0, "Internal Server Error")
		return
	}
	h.writeTokenPair(w, http.StatusOK, u.ID, refresh, u)
}

// Refresh handles POST /api/auth/refresh.
func (h *Handler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RefreshToken == "" {
		httpx.Error(w, http.StatusBadRequest, 50035, "Invalid Form Body")
		return
	}
	uid, newRefresh, err := h.Svc.Refresh(r.Context(), req.RefreshToken)
	if err == ErrInvalidRefresh {
		httpx.Error(w, http.StatusUnauthorized, 0, "401: Unauthorized")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, 0, "Internal Server Error")
		return
	}
	h.writeTokenPair(w, http.StatusOK, uid, newRefresh, nil)
}

func (h *Handler) writeTokenPair(w http.ResponseWriter, status int, uid int64, refresh string, u *User) {
	token, err := h.Svc.JWT().Issue(uid)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, 0, "Internal Server Error")
		return
	}
	resp := map[string]any{
		"token":         token,
		"refresh_token": refresh,
		"expires_in":    int(h.Svc.JWT().TTL().Seconds()),
	}
	if u != nil {
		resp["user"] = toUserResponse(u)
	}
	httpx.JSON(w, status, resp)
}

func validateRegister(username, email, password string) string {
	switch {
	case !usernameRe.MatchString(username):
		return "username must be 3-32 chars of a-z, 0-9, ., _"
	case len(email) > 254 || !validEmail(email):
		return "invalid email"
	case len(password) < 8 || len(password) > 128:
		return "password must be 8-128 chars"
	}
	return ""
}

func validEmail(email string) bool {
	addr, err := mail.ParseAddress(email)
	return err == nil && addr.Address == email
}
