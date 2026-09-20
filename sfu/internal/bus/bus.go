package bus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

var ErrMissingGuildID = errors.New("bus: missing guild_id for routable event")

// Event represents a wire event envelope matching Kith gateway / API formats.
type Event struct {
	Type    string `json:"type"`
	Version int    `json:"version"`
	GuildID string `json:"guild_id,omitempty"`
	Payload any    `json:"payload"`
}

// Publisher is an interface for publishing events to the internal event bus.
type Publisher interface {
	Publish(ctx context.Context, e Event) error
	Close() error
}

// NoopPublisher is a fallback publisher that logs events without network operations.
type NoopPublisher struct{}

func (NoopPublisher) Publish(_ context.Context, e Event) error {
	slog.Debug("SFU event published (noop)", "type", e.Type, "guild_id", e.GuildID)
	return nil
}

func (NoopPublisher) Close() error {
	return nil
}

// NatsPublisher publishes room lifecycle events to NATS JetStream stream KITH_EVENTS.
type NatsPublisher struct {
	nc     *nats.Conn
	js     nats.JetStreamContext
	stream string
}

// NewNatsPublisher connects to NATS at natsURL, initializes JetStream, and returns a NatsPublisher.
func NewNatsPublisher(natsURL string) (*NatsPublisher, error) {
	if natsURL == "" || natsURL == "none" {
		return nil, errors.New("empty nats url")
	}

	nc, err := nats.Connect(
		natsURL,
		nats.Name("kith-sfu-publisher"),
		nats.Timeout(5*time.Second),
		nats.ReconnectWait(1*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("bus: connect to nats at %s: %w", natsURL, err)
	}

	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("bus: init jetstream context: %w", err)
	}

	return &NatsPublisher{
		nc:     nc,
		js:     js,
		stream: "KITH_EVENTS",
	}, nil
}

// Publish writes the event envelope to NATS JetStream topic kith.events.voice.{guild_id}.
func (p *NatsPublisher) Publish(ctx context.Context, e Event) error {
	if e.GuildID == "" {
		return ErrMissingGuildID
	}

	if e.Version == 0 {
		e.Version = 1
	}

	data, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("bus: marshal event: %w", err)
	}

	subject := fmt.Sprintf("kith.events.voice.%s", e.GuildID)

	// Publish with timeout context
	pubCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	_, err = p.js.Publish(subject, data, nats.Context(pubCtx))
	if err != nil {
		slog.Error("Failed to publish event to NATS JetStream", "subject", subject, "type", e.Type, "err", err)
		return fmt.Errorf("bus: jetstream publish to %s: %w", subject, err)
	}

	slog.Info("Event published to NATS JetStream", "subject", subject, "type", e.Type, "guild_id", e.GuildID)
	return nil
}

// Close gracefully flushes and closes the NATS connection.
func (p *NatsPublisher) Close() error {
	if p.nc != nil {
		return p.nc.Drain()
	}
	return nil
}
