package auth

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

var (
	ErrInvalidCredentials = errors.New("auth: invalid credentials")
	ErrInvalidRefresh     = errors.New("auth: invalid or expired refresh token")
	ErrDuplicate          = errors.New("auth: username or email already taken")
)

// User is the persisted shape; handlers serialize it with string IDs.
type User struct {
	ID            int64
	Username      string
	Discriminator int16
	Email         string
	CreatedAt     time.Time
}

// Service owns register/login/refresh against Postgres.
type Service struct {
	db         *sql.DB
	sf         *snowflake.Node
	jwt        *JWTManager
	refreshTTL time.Duration
}

func NewService(db *sql.DB, sf *snowflake.Node, jwt *JWTManager, refreshTTL time.Duration) *Service {
	return &Service{db: db, sf: sf, jwt: jwt, refreshTTL: refreshTTL}
}

func (s *Service) JWT() *JWTManager { return s.jwt }

// Register creates a user with an argon2id password hash.
func (s *Service) Register(ctx context.Context, username, email, password string) (*User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}
	id, err := s.sf.Generate()
	if err != nil {
		return nil, err
	}
	discriminator, err := randomDiscriminator()
	if err != nil {
		return nil, err
	}

	u := &User{ID: id, Username: username, Email: email, Discriminator: discriminator}
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO users (id, username, discriminator, email, password_hash)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING created_at`,
		id, username, discriminator, email, hash,
	).Scan(&u.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrDuplicate
		}
		return nil, err
	}
	return u, nil
}

// Login verifies credentials and opens a session (creating a refresh token).
func (s *Service) Login(ctx context.Context, login, password string) (*User, string, error) {
	u := &User{}
	var hash string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, username, discriminator, email, password_hash, created_at
		FROM users
		WHERE username = $1 OR email = $1`,
		login,
	).Scan(&u.ID, &u.Username, &u.Discriminator, &u.Email, &hash, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrInvalidCredentials
	}
	if err != nil {
		return nil, "", err
	}
	ok, err := VerifyPassword(password, hash)
	if err != nil || !ok {
		return nil, "", ErrInvalidCredentials
	}

	refresh, err := s.createSession(ctx, u.ID)
	if err != nil {
		return nil, "", err
	}
	return u, refresh, nil
}

// Refresh rotates a valid refresh token: the old session row is deleted and a
// new one inserted atomically; a token can only ever be used once.
func (s *Service) Refresh(ctx context.Context, refreshToken string) (userID int64, newRefresh string, err error) {
	newSessionID, err := s.sf.Generate()
	if err != nil {
		return 0, "", err
	}
	newRefresh, err = randomToken()
	if err != nil {
		return 0, "", err
	}

	err = s.db.QueryRowContext(ctx, `
		WITH rotated AS (
			DELETE FROM sessions
			WHERE refresh_token_hash = $1 AND expires_at > now()
			RETURNING user_id
		)
		INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
		SELECT $2, user_id, $3, $4 FROM rotated
		RETURNING user_id`,
		hashToken(refreshToken), newSessionID, hashToken(newRefresh), time.Now().Add(s.refreshTTL),
	).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", ErrInvalidRefresh
	}
	if err != nil {
		return 0, "", err
	}
	return userID, newRefresh, nil
}

func (s *Service) createSession(ctx context.Context, userID int64) (string, error) {
	sessionID, err := s.sf.Generate()
	if err != nil {
		return "", err
	}
	refresh, err := randomToken()
	if err != nil {
		return "", err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at)
		VALUES ($1, $2, $3, $4)`,
		sessionID, userID, hashToken(refresh), time.Now().Add(s.refreshTTL),
	)
	if err != nil {
		return "", err
	}
	return refresh, nil
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}
