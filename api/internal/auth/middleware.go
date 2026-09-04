package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/moadabdou/Kith/api/pkg/errs"
)

type ctxKey int

const userIDKey ctxKey = 0

// UserIDFrom extracts the authenticated user id put on the context by
// RequireAuth.
func UserIDFrom(ctx context.Context) (int64, bool) {
	uid, ok := ctx.Value(userIDKey).(int64)
	return uid, ok
}

// RequireAuth wraps next with Bearer-JWT authentication. It only verifies
// the signature and expiry — no DB hit; REST re-reads Postgres in handlers
// when needed (plan/02 §6).
func RequireAuth(m *JWTManager, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(header, "Bearer ")
		if !ok || token == "" {
			errs.Write(w, errs.Unauthorized())
			return
		}
		uid, err := m.Verify(token)
		if err != nil {
			errs.Write(w, errs.Unauthorized())
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userIDKey, uid)))
	})
}
