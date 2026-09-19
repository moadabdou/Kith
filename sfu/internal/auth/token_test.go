package auth

import (
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testSecret = "my-ultra-secure-test-secret-key-12345"

func TestValidateVoiceToken(t *testing.T) {
	t.Run("valid token with sub", func(t *testing.T) {
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub": "user_1001",
			"exp": time.Now().Add(time.Hour).Unix(),
			"iat": time.Now().Unix(),
		})
		signed, err := token.SignedString([]byte(testSecret))
		if err != nil {
			t.Fatalf("failed to sign token: %v", err)
		}

		claims, err := ValidateVoiceToken(signed, testSecret)
		if err != nil {
			t.Fatalf("expected valid token, got error: %v", err)
		}
		if claims.UserID != "user_1001" {
			t.Errorf("expected UserID user_1001, got %s", claims.UserID)
		}
	})

	t.Run("valid token with user_id and channel_id", func(t *testing.T) {
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, &VoiceClaims{
			UserID:    "user_2002",
			ChannelID: "chan_555",
			GuildID:   "guild_999",
			RegisteredClaims: jwt.RegisteredClaims{
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			},
		})
		signed, err := token.SignedString([]byte(testSecret))
		if err != nil {
			t.Fatalf("failed to sign token: %v", err)
		}

		claims, err := ValidateVoiceToken(signed, testSecret)
		if err != nil {
			t.Fatalf("expected valid token, got: %v", err)
		}
		if claims.UserID != "user_2002" || claims.ChannelID != "chan_555" {
			t.Errorf("unexpected claims: %+v", claims)
		}
	})

	t.Run("expired token", func(t *testing.T) {
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub": "user_3003",
			"exp": time.Now().Add(-time.Hour).Unix(),
		})
		signed, _ := token.SignedString([]byte(testSecret))

		_, err := ValidateVoiceToken(signed, testSecret)
		if err == nil {
			t.Fatal("expected error for expired token, got nil")
		}
	})

	t.Run("tampered secret", func(t *testing.T) {
		token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub": "user_4004",
			"exp": time.Now().Add(time.Hour).Unix(),
		})
		signed, _ := token.SignedString([]byte("wrong-secret"))

		_, err := ValidateVoiceToken(signed, testSecret)
		if err == nil {
			t.Fatal("expected error for mismatched secret, got nil")
		}
	})
}
