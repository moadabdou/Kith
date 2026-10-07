package mail

import (
	"context"
	"log/slog"
	"os"
	"strconv"
)

// Mailer provides methods to deliver transactional emails to users.
type Mailer interface {
	SendVerification(ctx context.Context, toEmail, username, code, verifyURL string) error
}

// Config holds SMTP connection and sender options.
type Config struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
}

// NewMailerFromEnv initializes a Mailer based on environment configuration.
// If SMTP_HOST is unset or "stdout", it falls back to LogMailer.
func NewMailerFromEnv() Mailer {
	host := os.Getenv("SMTP_HOST")
	if host == "" || host == "stdout" || host == "log" {
		slog.Info("mailer configured in development log mode (emails written to stdout)")
		return NewLogMailer()
	}

	port := 587
	if p := os.Getenv("SMTP_PORT"); p != "" {
		if parsed, err := strconv.Atoi(p); err == nil {
			port = parsed
		}
	}

	from := os.Getenv("SMTP_FROM")
	if from == "" {
		from = "Kith <noreply@kith.chat>"
	}

	cfg := Config{
		Host:     host,
		Port:     port,
		Username: os.Getenv("SMTP_USER"),
		Password: os.Getenv("SMTP_PASS"),
		From:     from,
	}

	slog.Info("mailer initialized with SMTP backend", "host", host, "port", port, "from", from)
	return NewSMTPMailer(cfg)
}
