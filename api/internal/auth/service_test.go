package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
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
}
