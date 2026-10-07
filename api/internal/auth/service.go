package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/moadabdou/Kith/api/internal/mail"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

var (
	ErrInvalidCredentials   = errors.New("auth: invalid credentials")
	ErrInvalidRefresh       = errors.New("auth: invalid or expired refresh token")
	ErrDuplicate            = errors.New("auth: username or email already taken")
	ErrInvalidVerification  = errors.New("auth: invalid or expired verification code")
	ErrVerificationCooldown = errors.New("auth: verification email requested too frequently")
	ErrMaxAttemptsExceeded  = errors.New("auth: maximum verification attempts exceeded")
)

// User is the persisted shape; handlers serialize it with string IDs.
type User struct {
	ID            int64
	Username      string
	Discriminator int16
	Email         string
	EmailVerified bool
	CreatedAt     time.Time
}

// Service owns register/login/refresh against Postgres.
type Service struct {
	db         *sql.DB
	sf         *snowflake.Node
	jwt        *JWTManager
	refreshTTL time.Duration
	mailer     mail.Mailer
	clientURL  string
}

func NewService(db *sql.DB, sf *snowflake.Node, jwt *JWTManager, refreshTTL time.Duration) *Service {
	return &Service{db: db, sf: sf, jwt: jwt, refreshTTL: refreshTTL}
}

func (s *Service) SetMailer(mailer mail.Mailer, clientURL string) {
	s.mailer = mailer
	s.clientURL = clientURL
}

func (s *Service) Mailer() mail.Mailer {
	return s.mailer
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

	u := &User{ID: id, Username: username, Email: email, Discriminator: discriminator, EmailVerified: false}
	err = s.db.QueryRowContext(ctx, `
		INSERT INTO users (id, username, discriminator, email, password_hash, email_verified)
		VALUES ($1, $2, $3, $4, $5, false)
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

	_, _, _ = s.createVerification(ctx, id, email, username)
	return u, nil
}

func (s *Service) createVerification(ctx context.Context, userID int64, email, username string) (string, string, error) {
	verID, err := s.sf.Generate()
	if err != nil {
		return "", "", err
	}
	code, err := randomOTP()
	if err != nil {
		return "", "", err
	}
	token, err := randomToken()
	if err != nil {
		return "", "", err
	}

	expiresAt := time.Now().Add(15 * time.Minute)
	// Delete any previous pending verifications for this user
	_, _ = s.db.ExecContext(ctx, `DELETE FROM email_verifications WHERE user_id = $1`, userID)

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO email_verifications (id, user_id, code_hash, token_hash, expires_at)
		VALUES ($1, $2, $3, $4, $5)`,
		verID, userID, hashToken(code), hashToken(token), expiresAt,
	)
	if err != nil {
		return "", "", err
	}

	if s.mailer != nil {
		clientURL := s.clientURL
		if clientURL == "" {
			clientURL = "http://localhost:5173"
		}
		verifyURL := fmt.Sprintf("%s/verify?token=%s", clientURL, token)
		go func() {
			if err := s.mailer.SendVerification(context.Background(), email, username, code, verifyURL); err != nil {
				slog.Error("failed to dispatch verification email", "email", email, "err", err)
			}
		}()
	}

	return code, token, nil
}

// VerifyEmail verifies an account via a 6-digit OTP code or a 32-byte URL token and returns a session.
func (s *Service) VerifyEmail(ctx context.Context, codeOrToken, email string) (*User, string, error) {
	codeOrToken = strings.TrimSpace(codeOrToken)
	var (
		verID     int64
		userID    int64
		attempts  int
		expiresAt time.Time
		codeHash  string
		u         User
	)

	// Route 1: 6-digit OTP code with email
	if len(codeOrToken) == 6 && email != "" {
		err := s.db.QueryRowContext(ctx, `
			SELECT v.id, v.user_id, v.code_hash, v.attempts, v.expires_at,
			       u.username, u.discriminator, u.email, u.email_verified, u.created_at
			FROM email_verifications v
			JOIN users u ON v.user_id = u.id
			WHERE u.email = $1`,
			email,
		).Scan(&verID, &userID, &codeHash, &attempts, &expiresAt, &u.Username, &u.Discriminator, &u.Email, &u.EmailVerified, &u.CreatedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, "", ErrInvalidVerification
		}
		if err != nil {
			return nil, "", err
		}
		u.ID = userID

		if time.Now().After(expiresAt) {
			_, _ = s.db.ExecContext(ctx, `DELETE FROM email_verifications WHERE id = $1`, verID)
			return nil, "", ErrInvalidVerification
		}

		if hashToken(codeOrToken) != codeHash {
			if attempts >= 4 {
				_, _ = s.db.ExecContext(ctx, `DELETE FROM email_verifications WHERE id = $1`, verID)
				return nil, "", ErrMaxAttemptsExceeded
			}
			_, _ = s.db.ExecContext(ctx, `UPDATE email_verifications SET attempts = attempts + 1 WHERE id = $1`, verID)
			return nil, "", ErrInvalidVerification
		}
	} else {
		// Route 2: URL token
		err := s.db.QueryRowContext(ctx, `
			SELECT v.id, v.user_id, v.expires_at,
			       u.username, u.discriminator, u.email, u.email_verified, u.created_at
			FROM email_verifications v
			JOIN users u ON v.user_id = u.id
			WHERE v.token_hash = $1`,
			hashToken(codeOrToken),
		).Scan(&verID, &userID, &expiresAt, &u.Username, &u.Discriminator, &u.Email, &u.EmailVerified, &u.CreatedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, "", ErrInvalidVerification
		}
		if err != nil {
			return nil, "", err
		}
		u.ID = userID

		if time.Now().After(expiresAt) {
			_, _ = s.db.ExecContext(ctx, `DELETE FROM email_verifications WHERE id = $1`, verID)
			return nil, "", ErrInvalidVerification
		}
	}

	_, err := s.db.ExecContext(ctx, `UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1`, userID)
	if err != nil {
		return nil, "", err
	}
	_, _ = s.db.ExecContext(ctx, `DELETE FROM email_verifications WHERE user_id = $1`, userID)
	u.EmailVerified = true

	refresh, err := s.createSession(ctx, userID)
	if err != nil {
		return nil, "", err
	}
	return &u, refresh, nil
}

// ResendVerification dispatches a new verification code if not on cooldown.
func (s *Service) ResendVerification(ctx context.Context, email string) (int, error) {
	email = strings.TrimSpace(email)
	var u User
	err := s.db.QueryRowContext(ctx, `
		SELECT id, username, discriminator, email, email_verified, created_at
		FROM users
		WHERE email = $1`,
		email,
	).Scan(&u.ID, &u.Username, &u.Discriminator, &u.Email, &u.EmailVerified, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 60, nil
	}
	if err != nil {
		return 0, err
	}
	if u.EmailVerified {
		return 0, nil
	}

	var lastCreatedAt time.Time
	err = s.db.QueryRowContext(ctx, `
		SELECT created_at
		FROM email_verifications
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT 1`,
		u.ID,
	).Scan(&lastCreatedAt)
	if err == nil {
		remaining := 60 - int(time.Since(lastCreatedAt).Seconds())
		if remaining > 0 {
			return remaining, ErrVerificationCooldown
		}
	}

	_, _, err = s.createVerification(ctx, u.ID, u.Email, u.Username)
	if err != nil {
		return 0, err
	}
	return 60, nil
}

// Login verifies credentials and opens a session (creating a refresh token).
func (s *Service) Login(ctx context.Context, login, password string) (*User, string, error) {
	u := &User{}
	var hash string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, username, discriminator, email, password_hash, email_verified, created_at
		FROM users
		WHERE username = $1 OR email = $1`,
		login,
	).Scan(&u.ID, &u.Username, &u.Discriminator, &u.Email, &hash, &u.EmailVerified, &u.CreatedAt)
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

// Revoke deletes the session identified by refreshToken, invalidating it.
func (s *Service) Revoke(ctx context.Context, refreshToken string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM sessions
		WHERE refresh_token_hash = $1`,
		hashToken(refreshToken),
	)
	return err
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

func randomOTP() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	val := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	return fmt.Sprintf("%06d", val%1000000), nil
}
