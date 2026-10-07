package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/mail"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

// Integration tests run against a migrated Postgres (TEST_DATABASE_URL),
// e.g. the compose stack: postgres://discord:discord@127.0.0.1:5432/discord?sslmode=disable

func newTestService(t *testing.T) (*Service, *sql.DB, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() {
		db.Exec("DELETE FROM users WHERE username = $1", t.Name())
		db.Close()
	})
	b := make([]byte, 4)
	rand.Read(b)
	username := hex.EncodeToString(b)
	node, _ := snowflake.NewNode(999)
	return NewService(db, node, NewJWTManager([]byte("test"), time.Minute), time.Hour), db, username
}

func TestRegisterLoginRefreshFlow(t *testing.T) {
	svc, db, username := newTestService(t)
	ctx := context.Background()
	password := "password123"
	email := username + "@example.com"

	u, err := svc.Register(ctx, username, email, password)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if u.ID == 0 || u.Username != username {
		t.Fatalf("Register returned %+v", u)
	}

	if _, err := svc.Register(ctx, username, email+"2", password); err != ErrDuplicate {
		t.Errorf("duplicate username: err = %v, want ErrDuplicate", err)
	}
	if _, err := svc.Register(ctx, username+"x", email, password); err != ErrDuplicate {
		t.Errorf("duplicate email: err = %v, want ErrDuplicate", err)
	}

	if _, _, err := svc.Login(ctx, username, "wrong-password"); err != ErrInvalidCredentials {
		t.Errorf("Login(wrong pw): err = %v, want ErrInvalidCredentials", err)
	}

	got, refresh, err := svc.Login(ctx, email, password)
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if got.ID != u.ID {
		t.Errorf("login by email returned id %d, want %d", got.ID, u.ID)
	}

	uid, refresh2, err := svc.Refresh(ctx, refresh)
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if uid != u.ID {
		t.Errorf("Refresh uid = %d, want %d", uid, u.ID)
	}
	if refresh2 == refresh {
		t.Error("Refresh must rotate the token")
	}
	if _, _, err := svc.Refresh(ctx, refresh); err != ErrInvalidRefresh {
		t.Errorf("reused old refresh token: err = %v, want ErrInvalidRefresh", err)
	}
	if _, _, err := svc.Refresh(ctx, "garbage-token"); err != ErrInvalidRefresh {
		t.Errorf("garbage refresh token: err = %v, want ErrInvalidRefresh", err)
	}

	_, err = db.ExecContext(ctx,
		"UPDATE sessions SET expires_at = now() - interval '1 second' WHERE refresh_token_hash = $1",
		hashToken(refresh2))
	if err != nil {
		t.Fatalf("expire session: %v", err)
	}
	if _, _, err := svc.Refresh(ctx, refresh2); err != ErrInvalidRefresh {
		t.Errorf("expired refresh token: err = %v, want ErrInvalidRefresh (re-login required)", err)
	}

	// Test Revoke: active token is invalidated
	_, refresh3, err := svc.Login(ctx, email, password)
	if err != nil {
		t.Fatalf("Login for revoke test: %v", err)
	}
	if err := svc.Revoke(ctx, refresh3); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, _, err := svc.Refresh(ctx, refresh3); err != ErrInvalidRefresh {
		t.Errorf("revoked refresh token: err = %v, want ErrInvalidRefresh", err)
	}
}

func TestEmailVerificationFlow(t *testing.T) {
	svc, db, username := newTestService(t)
	logMailer := mail.NewLogMailer()
	svc.SetMailer(logMailer, "http://localhost:5173")
	ctx := context.Background()
	password := "password123"
	email := username + "_verify@example.com"

	u, err := svc.Register(ctx, username, email, password)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if u.EmailVerified {
		t.Error("newly registered user must not be email_verified")
	}

	// Verify that email was dispatched via LogMailer
	time.Sleep(50 * time.Millisecond) // Allow background goroutine to execute
	payload, ok := logMailer.GetLastSent(email)
	if !ok {
		t.Fatal("expected verification email to be dispatched")
	}
	if len(payload.Code) != 6 {
		t.Fatalf("expected 6-digit OTP code, got %s", payload.Code)
	}

	// Test resend rate limit (cooldown)
	cooldown, err := svc.ResendVerification(ctx, email)
	if !errors.Is(err, ErrVerificationCooldown) {
		t.Errorf("expected ErrVerificationCooldown on rapid resend, got %v (cooldown=%d)", err, cooldown)
	}

	// Test invalid code fails
	_, _, err = svc.VerifyEmail(ctx, "000000", email)
	if !errors.Is(err, ErrInvalidVerification) {
		t.Errorf("expected ErrInvalidVerification for wrong code, got %v", err)
	}

	// Test valid code succeeds
	verifiedUser, refresh, err := svc.VerifyEmail(ctx, payload.Code, email)
	if err != nil {
		t.Fatalf("VerifyEmail with correct code failed: %v", err)
	}
	if !verifiedUser.EmailVerified {
		t.Error("user should be marked as email_verified")
	}
	if refresh == "" {
		t.Error("expected valid refresh token session on successful verification")
	}

	// Verify user in database is now email_verified
	var dbVerified bool
	err = db.QueryRowContext(ctx, "SELECT email_verified FROM users WHERE id = $1", u.ID).Scan(&dbVerified)
	if err != nil || !dbVerified {
		t.Errorf("database email_verified = %v, want true", dbVerified)
	}

	// Test reusing same code fails
	_, _, err = svc.VerifyEmail(ctx, payload.Code, email)
	if !errors.Is(err, ErrInvalidVerification) {
		t.Errorf("expected ErrInvalidVerification on reused code, got %v", err)
	}
}
