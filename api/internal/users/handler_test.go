package users

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/events"
)

type mockPublisher struct {
	events []events.Event
}

func (m *mockPublisher) Publish(ctx context.Context, e events.Event) error {
	m.events = append(m.events, e)
	return nil
}

func TestMe_Unauthorized(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodGet, "/api/users/@me", nil)
	w := httptest.NewRecorder()

	h.Me(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestUpdate_Unauthorized(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPatch, "/api/users/@me", bytes.NewBufferString("{}"))
	w := httptest.NewRecorder()

	h.Update(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestUpdate_InvalidJSON(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPatch, "/api/users/@me", bytes.NewBufferString("{invalid"))
	ctx := auth.WithUserID(req.Context(), 123)
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	h.Update(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestUpdate_Validation(t *testing.T) {
	h := &Handler{}

	tests := []struct {
		name    string
		payload string
	}{
		{
			name:    "username too short",
			payload: `{"username": "a"}`,
		},
		{
			name:    "username too long",
			payload: `{"username": "thisusernameiswaytoolongtobeallowedundertherulesofdiscordandkith"}`,
		},
		{
			name:    "bio too long",
			payload: `{"bio": "` + string(make([]byte, 195)) + `"}`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPatch, "/api/users/@me", bytes.NewBufferString(tc.payload))
			ctx := auth.WithUserID(req.Context(), 123)
			req = req.WithContext(ctx)
			w := httptest.NewRecorder()

			h.Update(w, req)

			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400 Bad Request, got %d", w.Code)
			}
		})
	}
}

func TestDatabase_MeAndUpdateRoundTrip(t *testing.T) {
	dbURL := os.Getenv("TEST_DATABASE_URL")
	if dbURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}

	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	pub := &mockPublisher{}
	h := &Handler{DB: db, Pub: pub}

	// Insert temporary test user
	var uid int64
	err = db.QueryRow(`
		INSERT INTO users (id, username, discriminator, email, password_hash)
		VALUES (99990001, 'testuser_profile', 1234, 'test_profile@example.com', 'hash')
		ON CONFLICT (id) DO UPDATE SET username = 'testuser_profile'
		RETURNING id`,
	).Scan(&uid)
	if err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	defer db.Exec(`DELETE FROM users WHERE id = $1`, uid)

	// 1. GET /api/users/@me
	req := httptest.NewRequest(http.MethodGet, "/api/users/@me", nil)
	req = req.WithContext(auth.WithUserID(req.Context(), uid))
	w := httptest.NewRecorder()
	h.Me(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Me() status = %d, want 200", w.Code)
	}
	var getResp UserResponse
	if err := json.Unmarshal(w.Body.Bytes(), &getResp); err != nil {
		t.Fatalf("unmarshal Me resp: %v", err)
	}
	if getResp.Username != "testuser_profile" {
		t.Fatalf("expected username 'testuser_profile', got %s", getResp.Username)
	}
	if getResp.Avatar != nil || getResp.Banner != nil || getResp.Bio != nil {
		t.Fatalf("expected nil avatar/banner/bio initially")
	}

	// 2. PATCH /api/users/@me
	avatarVal := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
	bannerVal := "#5865F2"
	bioVal := "Hello from Kith!"
	patchBody := map[string]any{
		"avatar": avatarVal,
		"banner": bannerVal,
		"bio":    bioVal,
	}
	bodyBytes, _ := json.Marshal(patchBody)
	patchReq := httptest.NewRequest(http.MethodPatch, "/api/users/@me", bytes.NewReader(bodyBytes))
	patchReq = patchReq.WithContext(auth.WithUserID(patchReq.Context(), uid))
	patchW := httptest.NewRecorder()

	h.Update(patchW, patchReq)
	if patchW.Code != http.StatusOK {
		t.Fatalf("Update() status = %d, body: %s", patchW.Code, patchW.Body.String())
	}

	var patchResp UserResponse
	if err := json.Unmarshal(patchW.Body.Bytes(), &patchResp); err != nil {
		t.Fatalf("unmarshal Update resp: %v", err)
	}
	if patchResp.Avatar == nil || *patchResp.Avatar != avatarVal {
		t.Fatalf("avatar not updated correctly")
	}
	if patchResp.Banner == nil || *patchResp.Banner != bannerVal {
		t.Fatalf("banner not updated correctly")
	}
	if patchResp.Bio == nil || *patchResp.Bio != bioVal {
		t.Fatalf("bio not updated correctly")
	}

	// 3. Verify GET reflects updated values
	reqAfter := httptest.NewRequest(http.MethodGet, "/api/users/@me", nil)
	reqAfter = reqAfter.WithContext(auth.WithUserID(reqAfter.Context(), uid))
	wAfter := httptest.NewRecorder()
	h.Me(wAfter, reqAfter)

	var getAfter UserResponse
	json.Unmarshal(wAfter.Body.Bytes(), &getAfter)
	if getAfter.Bio == nil || *getAfter.Bio != bioVal {
		t.Fatalf("GET /api/users/@me did not persist bio")
	}
}
