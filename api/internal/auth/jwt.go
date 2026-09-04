package auth

import (
	"errors"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// ErrInvalidToken is returned for malformed, bad-signature or expired JWTs.
var ErrInvalidToken = errors.New("auth: invalid token")

// JWTManager issues and verifies stateless HS256 access tokens.
// Verification never touches the database (plan/02 §3 step 1).
type JWTManager struct {
	secret []byte
	ttl    time.Duration
}

func NewJWTManager(secret []byte, ttl time.Duration) *JWTManager {
	return &JWTManager{secret: secret, ttl: ttl}
}

// TTL is the access-token lifetime, exposed for expires_in.
func (m *JWTManager) TTL() time.Duration { return m.ttl }

// Issue returns a signed access token for userID.
func (m *JWTManager) Issue(userID int64) (string, error) {
	now := time.Now()
	claims := jwt.RegisteredClaims{
		Subject:   strconv.FormatInt(userID, 10),
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(m.ttl)),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
}

// Verify parses a token and returns the user id from its subject claim.
func (m *JWTManager) Verify(token string) (int64, error) {
	parsed, err := jwt.ParseWithClaims(token, &jwt.RegisteredClaims{}, func(*jwt.Token) (any, error) {
		return m.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithExpirationRequired())
	if err != nil || !parsed.Valid {
		return 0, ErrInvalidToken
	}
	claims, ok := parsed.Claims.(*jwt.RegisteredClaims)
	if !ok {
		return 0, ErrInvalidToken
	}
	uid, err := strconv.ParseInt(claims.Subject, 10, 64)
	if err != nil {
		return 0, ErrInvalidToken
	}
	return uid, nil
}
