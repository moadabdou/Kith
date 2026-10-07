package mail

import (
	"context"
	"fmt"
	"log/slog"
	"net/mail"
	"net/smtp"
	"strings"
)

// SMTPMailer delivers verification emails via an external SMTP server.
type SMTPMailer struct {
	cfg Config
}

// NewSMTPMailer creates a new SMTPMailer.
func NewSMTPMailer(cfg Config) *SMTPMailer {
	return &SMTPMailer{cfg: cfg}
}

// BuildVerificationHTML generates a responsive HTML body for account verification.
func BuildVerificationHTML(username, code, verifyURL string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify your Kith account</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #1e1f22; color: #dbdee1; margin: 0; padding: 0; }
    .container { max-width: 520px; margin: 40px auto; background-color: #2b2d31; border-radius: 12px; padding: 40px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
    .brand { font-size: 24px; font-weight: 800; color: #5865f2; margin-bottom: 24px; text-align: center; }
    h1 { font-size: 20px; font-weight: 700; color: #f2f3f5; margin-bottom: 12px; text-align: center; }
    p { font-size: 15px; line-height: 1.5; color: #949ba4; margin-bottom: 24px; text-align: center; }
    .code-box { background-color: #1e1f22; border: 1px solid #35363c; border-radius: 8px; padding: 18px 24px; text-align: center; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #5865f2; margin: 28px 0; }
    .btn-container { text-align: center; margin: 28px 0; }
    .btn { display: inline-block; background-color: #5865f2; color: #ffffff !important; font-size: 15px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 6px; }
    .footer { font-size: 12px; color: #80848e; text-align: center; margin-top: 32px; border-top: 1px solid #35363c; padding-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">KITH</div>
    <h1>Hey %s, welcome to Kith!</h1>
    <p>Please use the verification code below to verify your email address and activate your account. This code expires in 15 minutes.</p>
    <div class="code-box">%s</div>
    <div class="btn-container">
      <a href="%s" class="btn">Verify Email Directly</a>
    </div>
    <p style="font-size: 13px; color: #80848e;">If you didn't create an account on Kith, you can safely ignore this email.</p>
    <div class="footer">
      Sent with &hearts; from Kith &bull; Secure Realtime Voice &amp; Chat
    </div>
  </div>
</body>
</html>`, username, code, verifyURL)
}

// SendVerification sends the verification email using net/smtp.
func (m *SMTPMailer) SendVerification(_ context.Context, toEmail, username, code, verifyURL string) error {
	addr := fmt.Sprintf("%s:%d", m.cfg.Host, m.cfg.Port)

	var auth smtp.Auth
	if m.cfg.Username != "" && m.cfg.Password != "" {
		auth = smtp.PlainAuth("", m.cfg.Username, m.cfg.Password, m.cfg.Host)
	}

	envelopeFrom := m.cfg.Username
	if parsed, err := mail.ParseAddress(m.cfg.From); err == nil && parsed.Address != "" {
		if envelopeFrom == "" || !strings.Contains(strings.ToLower(m.cfg.Host), "gmail.com") {
			envelopeFrom = parsed.Address
		}
	} else if envelopeFrom == "" {
		envelopeFrom = m.cfg.From
	}

	fromHeader := m.cfg.From
	if strings.Contains(strings.ToLower(m.cfg.Host), "gmail.com") && m.cfg.Username != "" {
		fromHeader = fmt.Sprintf("Kith <%s>", m.cfg.Username)
	}

	htmlBody := BuildVerificationHTML(username, code, verifyURL)

	msg := strings.Builder{}
	msg.WriteString(fmt.Sprintf("From: %s\r\n", fromHeader))
	msg.WriteString(fmt.Sprintf("To: %s\r\n", toEmail))
	msg.WriteString(fmt.Sprintf("Subject: %s - Your Kith verification code\r\n", code))
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	msg.WriteString("\r\n")
	msg.WriteString(htmlBody)

	slog.Info("dispatching verification email via SMTP", "host", m.cfg.Host, "port", m.cfg.Port, "to", toEmail, "from", envelopeFrom)
	err := smtp.SendMail(addr, auth, envelopeFrom, []string{toEmail}, []byte(msg.String()))
	if err != nil {
		slog.Error("SMTP delivery error", "err", err, "host", m.cfg.Host, "to", toEmail)
		return err
	}
	slog.Info("SMTP verification email successfully delivered", "to", toEmail)
	return nil
}
