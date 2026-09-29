package media

import (
	"fmt"
	"net/url"
	"strconv"
	"testing"
	"time"
)

func TestURLSigner(t *testing.T) {
	secret := []byte("test-media-secret-key-1234")
	signer := NewURLSigner(secret, 1*time.Hour)

	rawURL := "http://localhost:80/attachments/1001/2002/video.mp4"

	// 1. Sign URL
	signedURL, err := signer.SignURL(rawURL, 1*time.Hour)
	if err != nil {
		t.Fatalf("failed to sign URL: %v", err)
	}

	u, err := url.Parse(signedURL)
	if err != nil {
		t.Fatalf("failed to parse signed URL: %v", err)
	}

	if u.Query().Get("ex") == "" || u.Query().Get("is") == "" || u.Query().Get("hm") == "" {
		t.Fatalf("missing signature params in signed URL: %s", signedURL)
	}

	// 2. Verify valid URL
	if err := signer.VerifyURL(u); err != nil {
		t.Errorf("expected valid signature to pass verification, got: %v", err)
	}

	// 3. Verify tampered path fails
	tamperedPathURL, _ := url.Parse(signedURL)
	tamperedPathURL.Path = "/attachments/1001/9999/other.mp4"
	if err := signer.VerifyURL(tamperedPathURL); err != ErrSignatureInvalid {
		t.Errorf("expected ErrSignatureInvalid for tampered path, got: %v", err)
	}

	// 4. Verify tampered HMAC fails
	tamperedHMACURL, _ := url.Parse(signedURL)
	q := tamperedHMACURL.Query()
	q.Set("hm", "deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd")
	tamperedHMACURL.RawQuery = q.Encode()
	if err := signer.VerifyURL(tamperedHMACURL); err != ErrSignatureInvalid {
		t.Errorf("expected ErrSignatureInvalid for tampered HMAC, got: %v", err)
	}

	// 5. Verify expired URL fails
	expiredURL, _ := url.Parse(rawURL)
	pastExpiry := time.Now().UTC().Add(-10 * time.Minute)
	pastIssue := time.Now().UTC().Add(-1 * time.Hour)
	exHex := strconv.FormatInt(pastExpiry.Unix(), 16)
	isHex := strconv.FormatInt(pastIssue.Unix(), 16)
	hmHex := signer.computeHMAC(expiredURL.Path, exHex, isHex)

	eq := expiredURL.Query()
	eq.Set("ex", exHex)
	eq.Set("is", isHex)
	eq.Set("hm", hmHex)
	expiredURL.RawQuery = eq.Encode()

	if err := signer.VerifyURL(expiredURL); err != ErrSignatureExpired {
		t.Errorf("expected ErrSignatureExpired for expired URL, got: %v", err)
	}

	// 6. Verify missing params
	noSigURL, _ := url.Parse(rawURL)
	if err := signer.VerifyURL(noSigURL); err != ErrSignatureMissing {
		t.Errorf("expected ErrSignatureMissing for unsigned URL, got: %v", err)
	}
}

func TestSignAttachment(t *testing.T) {
	secret := []byte("secret")
	signer := NewURLSigner(secret, 1*time.Hour)

	att := &Attachment{
		ID:  "123",
		URL: "http://localhost/attachments/1/123/file.png",
		Thumbnails: map[string]any{
			"poster": map[string]any{
				"url":   "http://localhost/attachments/1/123/poster.webp",
				"width": 1920,
			},
			"128": map[string]any{
				"url":   "http://localhost/attachments/1/123/thumb_128.webp",
				"width": 128,
			},
		},
	}

	// When public (not private), URL should not change
	signer.SignAttachment(att, false, 1*time.Hour)
	if att.URL != "http://localhost/attachments/1/123/file.png" {
		t.Errorf("expected public attachment not to be signed")
	}

	// When private, main URL and thumbnails should have ?ex=...&hm=...
	signer.SignAttachment(att, true, 1*time.Hour)
	u, _ := url.Parse(att.URL)
	if u.Query().Get("hm") == "" {
		t.Errorf("expected private attachment URL to be signed")
	}

	posterMap := att.Thumbnails["poster"].(map[string]any)
	posterURL, _ := url.Parse(fmt.Sprint(posterMap["url"]))
	if posterURL.Query().Get("hm") == "" {
		t.Errorf("expected poster thumbnail URL to be signed")
	}
}
