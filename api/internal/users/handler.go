package users

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/pkg/errs"
)

// UserResponse represents a user returned to the client.
type UserResponse struct {
	ID            string    `json:"id"`
	Username      string    `json:"username"`
	Discriminator string    `json:"discriminator"`
	Email         string    `json:"email"`
	EmailVerified bool      `json:"email_verified"`
	Avatar        *string   `json:"avatar"`
	Banner        *string   `json:"banner"`
	Bio           *string   `json:"bio"`
	CreatedAt     time.Time `json:"created_at"`
}

// Handler serves user endpoints.
type Handler struct {
	DB  *sql.DB
	Pub events.Publisher
}

// Me handles GET /api/users/@me — the current authenticated user.
func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserIDFrom(r.Context())
	if !ok {
		errs.Write(w, errs.Unauthorized())
		return
	}
	var resp UserResponse
	var avatar, banner, bio sql.NullString
	err := h.DB.QueryRowContext(r.Context(), `
		SELECT id::text, username, to_char(discriminator, 'FM0000'), email, email_verified, avatar, banner, bio, created_at
		FROM users WHERE id = $1`, uid,
	).Scan(&resp.ID, &resp.Username, &resp.Discriminator, &resp.Email, &resp.EmailVerified, &avatar, &banner, &bio, &resp.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		errs.Write(w, errs.Unauthorized())
		return
	}
	if err != nil {
		errs.Write(w, errs.Internal())
		return
	}
	if avatar.Valid {
		resp.Avatar = &avatar.String
	}
	if banner.Valid {
		resp.Banner = &banner.String
	}
	if bio.Valid {
		resp.Bio = &bio.String
	}
	httpx.JSON(w, http.StatusOK, resp)
}

// Update handles PATCH /api/users/@me — update avatar, banner, bio, or username.
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	uid, ok := auth.UserIDFrom(r.Context())
	if !ok {
		errs.Write(w, errs.Unauthorized())
		return
	}

	var req struct {
		Username *string `json:"username"`
		Avatar   *string `json:"avatar"`
		Banner   *string `json:"banner"`
		Bio      *string `json:"bio"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errs.Write(w, errs.InvalidJSON())
		return
	}

	v := errs.NewValidator()
	if req.Username != nil {
		trimmed := strings.TrimSpace(*req.Username)
		v.Check("username", len(trimmed) >= 2 && len(trimmed) <= 32, errs.CodeBadLength, "Username must be between 2 and 32 characters.")
		req.Username = &trimmed
	}
	if req.Bio != nil {
		trimmed := strings.TrimSpace(*req.Bio)
		v.Check("bio", len(trimmed) <= 190, errs.CodeBadLength, "Bio cannot exceed 190 characters.")
		req.Bio = &trimmed
	}
	if v.Err() != nil {
		errs.Write(w, v.Err())
		return
	}

	// Fetch current user row first
	var curUsername, curDiscriminator, curEmail string
	var curAvatar, curBanner, curBio sql.NullString
	var createdAt time.Time
	err := h.DB.QueryRowContext(r.Context(), `
		SELECT username, to_char(discriminator, 'FM0000'), email, avatar, banner, bio, created_at
		FROM users WHERE id = $1`, uid,
	).Scan(&curUsername, &curDiscriminator, &curEmail, &curAvatar, &curBanner, &curBio, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		errs.Write(w, errs.Unauthorized())
		return
	}
	if err != nil {
		errs.Write(w, errs.Internal())
		return
	}

	newUsername := curUsername
	if req.Username != nil {
		newUsername = *req.Username
	}

	var newAvatar *string
	if curAvatar.Valid {
		newAvatar = &curAvatar.String
	}
	if req.Avatar != nil {
		if *req.Avatar == "" {
			newAvatar = nil
		} else {
			newAvatar = req.Avatar
		}
	}

	var newBanner *string
	if curBanner.Valid {
		newBanner = &curBanner.String
	}
	if req.Banner != nil {
		if *req.Banner == "" {
			newBanner = nil
		} else {
			newBanner = req.Banner
		}
	}

	var newBio *string
	if curBio.Valid {
		newBio = &curBio.String
	}
	if req.Bio != nil {
		if *req.Bio == "" {
			newBio = nil
		} else {
			newBio = req.Bio
		}
	}

	var updatedUser UserResponse
	var resAvatar, resBanner, resBio sql.NullString
	err = h.DB.QueryRowContext(r.Context(), `
		UPDATE users
		SET username = $2, avatar = $3, banner = $4, bio = $5, updated_at = NOW()
		WHERE id = $1
		RETURNING id::text, username, to_char(discriminator, 'FM0000'), email, avatar, banner, bio, created_at`,
		uid, newUsername, newAvatar, newBanner, newBio,
	).Scan(&updatedUser.ID, &updatedUser.Username, &updatedUser.Discriminator, &updatedUser.Email,
		&resAvatar, &resBanner, &resBio, &updatedUser.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			errs.Write(w, &errs.Error{
				Status:  http.StatusConflict,
				Code:    errs.CodeInvalidFormBody,
				Message: "Username is already taken",
			})
			return
		}
		errs.Write(w, errs.Internal())
		return
	}

	if resAvatar.Valid {
		updatedUser.Avatar = &resAvatar.String
	}
	if resBanner.Valid {
		updatedUser.Banner = &resBanner.String
	}
	if resBio.Valid {
		updatedUser.Bio = &resBio.String
	}

	// Fan out real-time updates to all mutual guilds
	if h.Pub != nil {
		h.publishMemberUpdates(r.Context(), uid, updatedUser)
	}

	httpx.JSON(w, http.StatusOK, updatedUser)
}

func (h *Handler) publishMemberUpdates(ctx context.Context, uid int64, user UserResponse) {
	guildRows, err := h.DB.QueryContext(ctx, `SELECT guild_id, nickname FROM members WHERE user_id = $1`, uid)
	if err != nil {
		slog.ErrorContext(ctx, "failed to query mutual guilds for user update", "user_id", uid, "err", err)
		return
	}
	defer guildRows.Close()

	type memberInfo struct {
		guildID  int64
		nickname *string
	}
	var guilds []memberInfo
	for guildRows.Next() {
		var gid int64
		var nick sql.NullString
		if err := guildRows.Scan(&gid, &nick); err != nil {
			continue
		}
		var nickPtr *string
		if nick.Valid {
			nickPtr = &nick.String
		}
		guilds = append(guilds, memberInfo{guildID: gid, nickname: nickPtr})
	}
	if err := guildRows.Err(); err != nil {
		return
	}

	for _, g := range guilds {
		gidStr := strconv.FormatInt(g.guildID, 10)
		roleRows, err := h.DB.QueryContext(ctx, `
			SELECT role_id::text
			FROM member_roles
			WHERE guild_id = $1 AND user_id = $2`, g.guildID, uid)
		if err != nil {
			continue
		}
		roles := make([]string, 0)
		for roleRows.Next() {
			var rid string
			if err := roleRows.Scan(&rid); err == nil {
				roles = append(roles, rid)
			}
		}
		roleRows.Close()

		if err := h.Pub.Publish(ctx, events.Event{
			Type:    "GUILD_MEMBER_UPDATE",
			Version: 1,
			GuildID: gidStr,
			Payload: map[string]any{
				"guild_id": gidStr,
				"roles":    roles,
				"user": map[string]any{
					"id":            user.ID,
					"username":      user.Username,
					"discriminator": user.Discriminator,
					"avatar":        user.Avatar,
					"banner":        user.Banner,
					"bio":           user.Bio,
				},
				"nick": g.nickname,
			},
		}); err != nil {
			slog.ErrorContext(ctx, "failed to publish GUILD_MEMBER_UPDATE", "guild_id", gidStr, "user_id", uid, "err", err)
		}
	}
}
