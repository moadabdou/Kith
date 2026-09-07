package events

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// DefaultMaxLen caps the stream length (~1M entries) with approximate trimming (XADD ~ MAXLEN).
	DefaultMaxLen int64 = 1_000_000
)

// RedisPublisher publishes events to Redis Streams partitioned by guild_id.
// Stream key format: kith:events:{guild_id}.
type RedisPublisher struct {
	client redis.UniversalClient
	maxLen int64
	closer io.Closer
}

// Option configures a RedisPublisher.
type Option func(*RedisPublisher)

// WithMaxLen overrides the stream cap.
func WithMaxLen(n int64) Option {
	return func(p *RedisPublisher) {
		if n > 0 {
			p.maxLen = n
		}
	}
}

// NewRedisPublisher connects to Redis using the provided URL and pings it.
func NewRedisPublisher(redisURL string, opts ...Option) (*RedisPublisher, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("events: invalid redis url: %w", err)
	}

	rdb := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, fmt.Errorf("events: failed to ping redis: %w", err)
	}

	p := &RedisPublisher{
		client: rdb,
		maxLen: DefaultMaxLen,
		closer: rdb,
	}
	for _, o := range opts {
		o(p)
	}
	return p, nil
}

// NewRedisPublisherClient wraps an existing Redis client.
func NewRedisPublisherClient(client redis.UniversalClient, maxLen int64) *RedisPublisher {
	if maxLen <= 0 {
		maxLen = DefaultMaxLen
	}
	return &RedisPublisher{
		client: client,
		maxLen: maxLen,
	}
}

// Publish writes the event envelope to the guild's stream (kith:events:{guild_id}).
func (p *RedisPublisher) Publish(ctx context.Context, e Event) error {
	if e.GuildID == "" {
		return ErrMissingGuildID
	}

	data, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("events: marshal envelope: %w", err)
	}

	streamKey := fmt.Sprintf("kith:events:%s", e.GuildID)
	err = p.client.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey,
		MaxLen: p.maxLen,
		Approx: true,
		Values: map[string]any{
			"event": string(data),
		},
	}).Err()

	if err != nil {
		return fmt.Errorf("events: xadd to %s: %w", streamKey, err)
	}

	slog.DebugContext(ctx, "event published (redis)", "stream", streamKey, "type", e.Type)
	return nil
}

// Close closes the Redis client connection if opened by NewRedisPublisher.
func (p *RedisPublisher) Close() error {
	if p.closer != nil {
		return p.closer.Close()
	}
	return nil
}

var _ Publisher = (*RedisPublisher)(nil)
