package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

const (
	// DefaultStreamName is the JetStream stream for Kith events.
	DefaultStreamName = "KITH_EVENTS"
	// DefaultStreamSubject is the wildcard subject covering all guild events.
	DefaultStreamSubject = "kith.events.>"
)

// NatsPublisher publishes events to NATS JetStream partitioned by guild_id.
// Subject format: kith.events.{guild_id}.
type NatsPublisher struct {
	nc     *nats.Conn
	js     nats.JetStreamContext
	stream string
}

// NatsOption configures a NatsPublisher.
type NatsOption func(*natsOptions)

type natsOptions struct {
	streamName string
	storage    nats.StorageType
	maxAge     time.Duration
}

// WithStreamName overrides the JetStream stream name.
func WithStreamName(name string) NatsOption {
	return func(o *natsOptions) {
		if name != "" {
			o.streamName = name
		}
	}
}

// WithStorageType overrides the JetStream storage type (e.g. MemoryStorage for tests).
func WithStorageType(storage nats.StorageType) NatsOption {
	return func(o *natsOptions) {
		o.storage = storage
	}
}

// WithMaxAge overrides the retention max age of events in the stream.
func WithMaxAge(d time.Duration) NatsOption {
	return func(o *natsOptions) {
		if d > 0 {
			o.maxAge = d
		}
	}
}

// NewNatsPublisher connects to NATS at natsURL, initializes the JetStream context,
// and ensures the stream exists.
func NewNatsPublisher(natsURL string, opts ...NatsOption) (*NatsPublisher, error) {
	nc, err := nats.Connect(
		natsURL,
		nats.Name("kith-api-publisher"),
		nats.Timeout(5*time.Second),
		nats.ReconnectWait(1*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("events: connect to nats at %s: %w", natsURL, err)
	}

	cfg := natsOptions{
		streamName: DefaultStreamName,
		storage:    nats.FileStorage,
		maxAge:     24 * time.Hour,
	}
	for _, o := range opts {
		o(&cfg)
	}

	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("events: init jetstream context: %w", err)
	}

	dupWindow := 2 * time.Minute
	if cfg.maxAge > 0 && cfg.maxAge < dupWindow {
		dupWindow = cfg.maxAge
	}

	// Ensure stream exists with guild wildcard subject
	streamCfg := &nats.StreamConfig{
		Name:       cfg.streamName,
		Subjects:   []string{DefaultStreamSubject},
		Storage:    cfg.storage,
		Retention:  nats.LimitsPolicy,
		Discard:    nats.DiscardOld,
		MaxAge:     cfg.maxAge,
		Duplicates: dupWindow,
	}

	if _, err := js.AddStream(streamCfg); err != nil {
		if errors.Is(err, nats.ErrStreamNameAlreadyInUse) {
			if _, err = js.UpdateStream(streamCfg); err != nil {
				nc.Close()
				return nil, fmt.Errorf("events: update jetstream stream %s: %w", cfg.streamName, err)
			}
		} else {
			nc.Close()
			return nil, fmt.Errorf("events: create jetstream stream %s: %w", cfg.streamName, err)
		}
	}

	return &NatsPublisher{
		nc:     nc,
		js:     js,
		stream: cfg.streamName,
	}, nil
}

// NewNatsPublisherClient wraps an existing NATS connection and JetStream context.
func NewNatsPublisherClient(nc *nats.Conn, js nats.JetStreamContext, stream string) *NatsPublisher {
	if stream == "" {
		stream = DefaultStreamName
	}
	return &NatsPublisher{
		nc:     nc,
		js:     js,
		stream: stream,
	}
}

// Publish writes the event envelope to the guild-scoped subject (kith.events.{guild_id}).
func (p *NatsPublisher) Publish(ctx context.Context, e Event) error {
	if e.GuildID == "" {
		return ErrMissingGuildID
	}

	data, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("events: marshal envelope: %w", err)
	}

	subject := fmt.Sprintf("kith.events.%s", e.GuildID)
	_, err = p.js.Publish(subject, data, nats.Context(ctx))
	if err != nil {
		return fmt.Errorf("events: jetstream publish to %s: %w", subject, err)
	}

	slog.DebugContext(ctx, "event published (nats)", "subject", subject, "type", e.Type)
	return nil
}

// Close closes the underlying NATS connection if created by NewNatsPublisher.
func (p *NatsPublisher) Close() error {
	if p.nc != nil {
		return p.nc.Drain()
	}
	return nil
}

var _ Publisher = (*NatsPublisher)(nil)
