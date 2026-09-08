package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

func TestNatsPublisherMissingGuildID(t *testing.T) {
	p := NewNatsPublisherClient(nil, nil, "KITH_EVENTS")
	err := p.Publish(context.Background(), Event{
		Type:    "MESSAGE_CREATE",
		Version: 1,
		GuildID: "",
		Payload: map[string]string{"content": "hello"},
	})
	if !errors.Is(err, ErrMissingGuildID) {
		t.Fatalf("Publish without guild_id: got %v, want ErrMissingGuildID", err)
	}
}

func TestNatsPublisherPublishIntegration(t *testing.T) {
	natsURL := os.Getenv("TEST_NATS_URL")
	if natsURL == "" {
		natsURL = os.Getenv("NATS_URL")
	}
	if natsURL == "" {
		natsURL = "nats://127.0.0.1:4222"
	}

	streamName := fmt.Sprintf("TEST_KITH_EVENTS_%d", time.Now().UnixNano())
	p, err := NewNatsPublisher(
		natsURL,
		WithStreamName(streamName),
		WithStorageType(nats.MemoryStorage),
		WithMaxAge(1*time.Minute),
	)
	if err != nil {
		t.Skipf("NATS not reachable at %s (%v); skipping integration test", natsURL, err)
		return
	}
	defer p.Close()
	defer func() {
		_ = p.js.DeleteStream(streamName)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	guildID := fmt.Sprintf("999%d", time.Now().UnixNano())
	subject := fmt.Sprintf("kith.events.%s", guildID)

	// Create a subscriber on the subject to verify receipt
	sub, err := p.js.SubscribeSync(subject)
	if err != nil {
		t.Fatalf("SubscribeSync: %v", err)
	}
	defer sub.Unsubscribe()

	type msgPayload struct {
		ID      string `json:"id"`
		Content string `json:"content"`
	}

	event := Event{
		Type:    "MESSAGE_CREATE",
		Version: 1,
		GuildID: guildID,
		Payload: msgPayload{ID: "12345", Content: "nats jetstream test"},
	}

	if err := p.Publish(ctx, event); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	msg, err := sub.NextMsg(2 * time.Second)
	if err != nil {
		t.Fatalf("NextMsg: %v", err)
	}

	var readEvent Event
	if err := json.Unmarshal(msg.Data, &readEvent); err != nil {
		t.Fatalf("unmarshal event JSON: %v", err)
	}

	if readEvent.Type != event.Type {
		t.Errorf("got type %q, want %q", readEvent.Type, event.Type)
	}
	if readEvent.Version != event.Version {
		t.Errorf("got version %d, want %d", readEvent.Version, event.Version)
	}
	if readEvent.GuildID != event.GuildID {
		t.Errorf("got guild_id %q, want %q", readEvent.GuildID, event.GuildID)
	}

	if err := msg.Ack(); err != nil {
		t.Errorf("msg.Ack: %v", err)
	}
}
