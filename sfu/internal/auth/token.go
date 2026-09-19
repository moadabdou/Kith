package auth

import (
	"errors"
	"fmt"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

var (
	ErrInvalidToken = errors.New("invalid or expired token")
	ErrMissingUser  = errors.New("token missing user identity (sub/user_id)")
)

// VoiceClaims represents the expected claims in a voice authentication token.
type VoiceClaims struct {
	UserID    string `json:"user_id,omitempty"`
	GuildID   string `json:"guild_id,omitempty"`
	ChannelID string `json:"channel_id,omitempty"`
	jwt.RegisteredClaims
}

// ValidateVoiceToken parses and validates a JWT token using HS256 secret.
func ValidateVoiceToken(tokenString, secret string) (*VoiceClaims, error) {
	if tokenString == "" {
		return nil, ErrInvalidToken
	}

	// In dev mode, if secret is explicitly "none", accept non-empty token and fallback
	if secret == "none" {
		return &VoiceClaims{
			UserID: "dev-user",
		}, nil
	}

	token, err := jwt.ParseWithClaims(tokenString, &VoiceClaims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	})

	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}

	claims, ok := token.Claims.(*VoiceClaims)
	if !ok || !token.Valid {
		return nil, ErrInvalidToken
	}

	// Standard JWT uses "sub" for user_id
	if claims.UserID == "" && claims.Subject != "" {
		claims.UserID = claims.Subject
	}

	if strings.TrimSpace(claims.UserID) == "" {
		return nil, ErrMissingUser
	}

	return claims, nil
}
