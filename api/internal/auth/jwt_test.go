package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestJWTRoundTrip(t *testing.T) {
	m := NewJWTManager([]byte("secret"), time.Minute)
	token, err := m.Issue(87000000000000001)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	uid, err := m.Verify(token)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if uid != 87000000000000001 {
		t.Errorf("uid = %d, want 87000000000000001", uid)
	}
}

func TestJWTExpired(t *testing.T) {
	m := NewJWTManager([]byte("secret"), -time.Minute)
	token, _ := m.Issue(1)
	if _, err := m.Verify(token); err == nil {
		t.Fatal("expired token must not verify")
	}
}

func TestJWTWrongSecret(t *testing.T) {
	token, _ := NewJWTManager([]byte("secret"), time.Minute).Issue(1)
	if _, err := NewJWTManager([]byte("other"), time.Minute).Verify(token); err == nil {
		t.Fatal("token signed with different secret must not verify")
	}
}

func TestJWTGarbage(t *testing.T) {
	m := NewJWTManager([]byte("secret"), time.Minute)
	for _, bad := range []string{"", "garbage", "a.b.c", "eyJhbGciOiJIUzI1NiJ9.e30.fakedsig"} {
		if _, err := m.Verify(bad); err == nil {
			t.Errorf("Verify(%q) should fail", bad)
		}
	}
}

func TestRequireAuthMiddleware(t *testing.T) {
	m := NewJWTManager([]byte("secret"), time.Minute)
	valid, _ := m.Issue(42)

	called := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if uid, ok := UserIDFrom(r.Context()); !ok || uid != 42 {
			t.Errorf("ctx uid = %d, %v; want 42, true", uid, ok)
		}
		w.WriteHeader(http.StatusOK)
	})
	h := RequireAuth(m, next)

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"not bearer", valid, http.StatusUnauthorized},
		{"empty bearer", "Bearer ", http.StatusUnauthorized},
		{"malformed", "Bearer not.a.jwt", http.StatusUnauthorized},
		{"valid", "Bearer " + valid, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			called = false
			req := httptest.NewRequest(http.MethodGet, "/api/users/@me", nil)
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d", rec.Code, tc.want)
			}
			if called != (tc.want == http.StatusOK) {
				t.Errorf("next called = %v, want %v", called, tc.want == http.StatusOK)
			}
		})
	}
}
