// Package events is the outbound event publisher seam (plan/02 §3 step 7).
//
// Phase 0 ships NoopPublisher; Phase 1 swaps in Redis Streams (then NATS
// JetStream) behind the same interface — a config change, not a call-site
// change. The rule that never changes: publish AFTER the PG transaction
// commits. Publishing before commit = phantom events for rolled-back data;
// publishing via LISTEN/NOTIFY = coupling the bus to Postgres.
package events

import (
	"context"
	"errors"
	"log/slog"
)

var ErrMissingGuildID = errors.New("events: missing guild_id for routable event")

// Event is the wire envelope, versioned so the encoding (JSON in v1) can
// change later without breaking consumers (00-architecture §8.2).
type Event struct {
	Type    string `json:"type"` // e.g. MESSAGE_CREATE
	Version int    `json:"version"`
	GuildID string `json:"guild_id,omitempty"`
	Payload any    `json:"payload"`
}

// Publisher fans an event out to whoever is listening (gateway, Phase 1+).
// At-least-once delivery; consumers dedupe by event/payload id.
type Publisher interface {
	Publish(ctx context.Context, e Event) error
}

// NoopPublisher logs and drops events — the Phase 0 stand-in.
type NoopPublisher struct{}

func (NoopPublisher) Publish(_ context.Context, e Event) error {
	slog.Debug("event published (noop)", "type", e.Type)
	return nil
}
