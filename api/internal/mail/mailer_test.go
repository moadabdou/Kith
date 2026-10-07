package mail

import (
	"context"
	"strings"
	"testing"
)

func TestLogMailer(t *testing.T) {
	m := NewLogMailer()
	ctx := context.Background()

	err := m.SendVerification(ctx, "alice@example.com", "alice", "123456", "http://localhost:5173/verify?token=abc")
	if err != nil {
		t.Fatalf("SendVerification failed: %v", err)
	}

	payload, ok := m.GetLastSent("alice@example.com")
	if !ok {
		t.Fatal("expected payload to be recorded")
	}
	if payload.Code != "123456" {
		t.Errorf("got code %s, want 123456", payload.Code)
	}
	if payload.Username != "alice" {
		t.Errorf("got username %s, want alice", payload.Username)
	}
	if payload.VerifyURL != "http://localhost:5173/verify?token=abc" {
		t.Errorf("got url %s", payload.VerifyURL)
	}
}

func TestBuildVerificationHTML(t *testing.T) {
	html := BuildVerificationHTML("tester", "998877", "http://localhost:5173/verify?token=xyz")
	if !strings.Contains(html, "998877") {
		t.Error("expected html to contain code 998877")
	}
	if !strings.Contains(html, "tester") {
		t.Error("expected html to contain username tester")
	}
	if !strings.Contains(html, "http://localhost:5173/verify?token=xyz") {
		t.Error("expected html to contain verification link")
	}
}
