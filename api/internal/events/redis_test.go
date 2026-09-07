package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestRedisPublisherMissingGuildID(t *testing.T) {
	p := NewRedisPublisherClient(nil, 100)
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

func TestRedisPublisherPublishIntegration(t *testing.T) {
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		redisURL = os.Getenv("REDIS_URL")
	}
	if redisURL == "" {
		t.Skip("TEST_REDIS_URL or REDIS_URL not set; skipping redis integration test")
	}

	p, err := NewRedisPublisher(redisURL, WithMaxLen(1000))
	if err != nil {
		t.Fatalf("NewRedisPublisher: %v", err)
	}
	defer p.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	guildID := fmt.Sprintf("999%d", time.Now().UnixNano())
	streamKey := "kith:events:" + guildID

	// Clean up before and after test
	_ = p.client.Del(context.Background(), streamKey).Err()
	t.Cleanup(func() {
		_ = p.client.Del(context.Background(), streamKey).Err()
	})

	type msgPayload struct {
		ID      string `json:"id"`
		Content string `json:"content"`
	}

	event := Event{
		Type:    "MESSAGE_CREATE",
		Version: 1,
		GuildID: guildID,
		Payload: msgPayload{ID: "12345", Content: "redis streams test"},
	}

	if err := p.Publish(ctx, event); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Verify with XRange
	entries, err := p.client.XRange(ctx, streamKey, "-", "+").Result()
	if err != nil {
		t.Fatalf("XRange: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry in %s, got %d", streamKey, len(entries))
	}

	val, ok := entries[0].Values["event"]
	if !ok {
		t.Fatalf("entry missing 'event' field: %+v", entries[0].Values)
	}

	eventStr, ok := val.(string)
	if !ok {
		t.Fatalf("expected string event value, got %T", val)
	}

	var readEvent Event
	if err := json.Unmarshal([]byte(eventStr), &readEvent); err != nil {
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
}
