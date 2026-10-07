package mail

import (
	"context"
	"log/slog"
	"sync"
)

// LogMailer logs verification emails to slog without connecting to an SMTP server.
type LogMailer struct {
	mu       sync.Mutex
	lastSent map[string]VerificationPayload
}

// VerificationPayload records sent email details for testing and inspection.
type VerificationPayload struct {
	ToEmail   string
	Username  string
	Code      string
	VerifyURL string
}

// NewLogMailer returns a new LogMailer instance.
func NewLogMailer() *LogMailer {
	return &LogMailer{
		lastSent: make(map[string]VerificationPayload),
	}
}

// SendVerification logs the verification code and URL.
func (m *LogMailer) SendVerification(_ context.Context, toEmail, username, code, verifyURL string) error {
	m.mu.Lock()
	m.lastSent[toEmail] = VerificationPayload{
		ToEmail:   toEmail,
		Username:  username,
		Code:      code,
		VerifyURL: verifyURL,
	}
	m.mu.Unlock()

	slog.Info("[MAILER] Verification email sent",
		"to", toEmail,
		"username", username,
		"code", code,
		"verify_url", verifyURL,
	)
	return nil
}

// GetLastSent returns the last recorded verification payload for an email.
func (m *LogMailer) GetLastSent(email string) (VerificationPayload, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.lastSent[email]
	return p, ok
}
