package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"
)

var (
	ErrSignatureMissing = errors.New("media: missing signature parameters")
	ErrSignatureExpired = errors.New("media: signature has expired")
	ErrSignatureInvalid = errors.New("media: invalid signature HMAC")
)

const DefaultSignedURLTTL = 24 * time.Hour

// URLSigner implements short-lived HMAC-signed URLs matching Discord CDN semantics
// (?ex=<hex_expiry>&is=<hex_issued>&hm=<sha256_hmac>).
type URLSigner struct {
	secret []byte
	ttl    time.Duration
}

// NewURLSigner creates a URLSigner with the given secret and default TTL.
func NewURLSigner(secret []byte, ttl time.Duration) *URLSigner {
	if ttl <= 0 {
		ttl = DefaultSignedURLTTL
	}
	return &URLSigner{
		secret: secret,
		ttl:    ttl,
	}
}

// SignURL signs a raw URL by appending ?ex=...&is=...&hm=... query parameters.
func (s *URLSigner) SignURL(rawURL string, ttl time.Duration) (string, error) {
	if ttl <= 0 {
		ttl = s.ttl
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("media: invalid url to sign: %w", err)
	}

	now := time.Now().UTC()
	expiry := now.Add(ttl)

	exHex := strconv.FormatInt(expiry.Unix(), 16)
	isHex := strconv.FormatInt(now.Unix(), 16)
	hmHex := s.computeHMAC(u.Path, exHex, isHex)

	q := u.Query()
	q.Set("ex", exHex)
	q.Set("is", isHex)
	q.Set("hm", hmHex)
	u.RawQuery = q.Encode()

	return u.String(), nil
}

// VerifyURL checks that the URL contains valid and unexpired ex, is, and hm query parameters.
func (s *URLSigner) VerifyURL(u *url.URL) error {
	q := u.Query()
	exHex := q.Get("ex")
	isHex := q.Get("is")
	hmHex := q.Get("hm")

	if exHex == "" || isHex == "" || hmHex == "" {
		return ErrSignatureMissing
	}

	expiryUnix, err := strconv.ParseInt(exHex, 16, 64)
	if err != nil {
		return ErrSignatureInvalid
	}

	if time.Now().UTC().Unix() > expiryUnix {
		return ErrSignatureExpired
	}

	expectedHM := s.computeHMAC(u.Path, exHex, isHex)
	if !hmac.Equal([]byte(stringsToLower(hmHex)), []byte(stringsToLower(expectedHM))) {
		return ErrSignatureInvalid
	}

	return nil
}

// SignAttachment signs the main URL and thumbnail URLs of an attachment if it is private.
func (s *URLSigner) SignAttachment(att *Attachment, isPrivate bool, ttl time.Duration) {
	if !isPrivate || att == nil {
		return
	}

	if att.URL != "" {
		if signed, err := s.SignURL(att.URL, ttl); err == nil {
			att.URL = signed
		}
	}

	if len(att.Thumbnails) > 0 {
		signedThumbnails := make(map[string]any, len(att.Thumbnails))
		for k, v := range att.Thumbnails {
			if thumbMap, ok := v.(map[string]any); ok {
				newThumb := make(map[string]any, len(thumbMap))
				for tk, tv := range thumbMap {
					if tk == "url" {
						if thumbURL, ok := tv.(string); ok && thumbURL != "" {
							if signed, err := s.SignURL(thumbURL, ttl); err == nil {
								newThumb[tk] = signed
								continue
							}
						}
					}
					newThumb[tk] = tv
				}
				signedThumbnails[k] = newThumb
			} else {
				signedThumbnails[k] = v
			}
		}
		att.Thumbnails = signedThumbnails
	}
}

func (s *URLSigner) computeHMAC(path, ex, is string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(path))
	mac.Write([]byte(":"))
	mac.Write([]byte(ex))
	mac.Write([]byte(":"))
	mac.Write([]byte(is))
	return hex.EncodeToString(mac.Sum(nil))
}

func stringsToLower(s string) string {
	b := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'A' <= c && c <= 'Z' {
			c += 'a' - 'A'
		}
		b[i] = c
	}
	return string(b)
}
