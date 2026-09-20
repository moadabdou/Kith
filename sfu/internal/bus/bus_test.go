package bus

import (
	"context"
	"testing"
)

func TestNoopPublisher(t *testing.T) {
	p := NoopPublisher{}
	err := p.Publish(context.Background(), Event{
		Type:    "voice.peer_joined",
		GuildID: "12345",
		Payload: map[string]string{"user_id": "u1"},
	})
	if err != nil {
		t.Fatalf("expected nil error, got: %v", err)
	}

	if err := p.Close(); err != nil {
		t.Fatalf("expected nil error on close, got: %v", err)
	}
}

func TestNatsPublisherMissingGuildID(t *testing.T) {
	p := &NatsPublisher{}
	err := p.Publish(context.Background(), Event{
		Type:    "voice.peer_joined",
		Payload: map[string]string{"user_id": "u1"},
	})
	if err != ErrMissingGuildID {
		t.Fatalf("expected ErrMissingGuildID, got: %v", err)
	}
}
