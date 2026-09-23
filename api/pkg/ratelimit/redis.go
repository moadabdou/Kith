// Redis-backed fixed-window counter for Phase 7b (Issue #85).
//
// Multiple API replicas share the same buckets through Redis so the
// per-route budget (e.g. 5/5s per user+channel) holds globally instead
// of per-process. The Lua script keeps INCR+PEXPIRE atomic: without it
// a crash between INCR and EXPIRE leaks a key with no TTL.
//
// Contract matches Limiter: X-RateLimit-* headers on every response,
// 429 + Retry-After when over. On Redis errors the limiter fails OPEN
// (allows the request): rate limiting is load shaping, not security.
package ratelimit

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/moadabdou/Kith/api/pkg/errs"
	"github.com/redis/go-redis/v9"
)

// keyPrefix namespaces limiter keys away from anything else in Redis.
// Redis is the limits-only store since Phase 7b; events moved to NATS.
const keyPrefix = "ratelimit"

// takeScript atomically increments the window counter, arming the TTL
// on first hit. Returns {count, pttl_ms}.
var takeScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
	redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('PTTL', KEYS[1])}
`)

// RedisLimiter is a fixed-window counter per key stored in Redis.
// Construct one per route bucket; all API replicas share the counts.
type RedisLimiter struct {
	client redis.UniversalClient
	limit  int
	window time.Duration
}

// NewRedisLimiter creates a limiter allowing limit requests per window
// per key, counted globally in Redis.
func NewRedisLimiter(client redis.UniversalClient, limit int, window time.Duration) *RedisLimiter {
	return &RedisLimiter{
		client: client,
		limit:  limit,
		window: window,
	}
}

// Take consumes one request for key, returning the bucket state.
// namespacedKey must already include the route bucket (see Middleware).
// A Redis failure returns an allowed result: fail-open by design.
func (l *RedisLimiter) Take(ctx context.Context, namespacedKey string) Result {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 200*time.Millisecond)
		defer cancel()
	}

	res, err := takeScript.Run(ctx, l.client,
		[]string{keyPrefix + ":" + namespacedKey},
		l.window.Milliseconds(),
	).Slice()
	if err != nil {
		slog.Warn("ratelimit: redis take failed, failing open",
			"key", namespacedKey, "error", err)
		return Result{Allowed: true, Limit: l.limit, Remaining: l.limit, ResetAfter: l.window}
	}
	count, _ := res[0].(int64)
	ttlMs, _ := res[1].(int64)
	return decide(count, ttlMs, l.limit, l.window)
}

// decide maps a raw {count, ttl} pair onto a Result. Pure for testability.
func decide(count, ttlMs int64, limit int, window time.Duration) Result {
	resetAfter := time.Duration(ttlMs) * time.Millisecond
	if ttlMs < 0 {
		resetAfter = window
	}
	remaining := int(int64(limit) - count)
	if remaining < 0 {
		remaining = 0
	}
	return Result{
		Allowed:    count <= int64(limit),
		Limit:      limit,
		Remaining:  remaining,
		ResetAfter: resetAfter,
	}
}

// Middleware wraps next with rate limiting. The Redis key is
// "<bucketName>:<key(r)>", so each route bucket is its own namespace
// shared across replicas. Same headers/429 shape as Limiter.Middleware.
func (l *RedisLimiter) Middleware(key func(r *http.Request) string, bucketName string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		res := l.Take(r.Context(), bucketName+":"+key(r))
		setHeaders(w, bucketName, res)
		if !res.Allowed {
			w.Header().Set(HeaderRetryAfter, strconv.Itoa(int(res.ResetAfter.Seconds())+1))
			errs.Write(w, errs.RateLimited(res.ResetAfter.Seconds(), false))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Dial connects to Redis and pings it. Callers fall back to the
// in-memory Limiter when this errors (fail-open, see Take).
func Dial(ctx context.Context, redisURL string) (redis.UniversalClient, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("ratelimit: invalid redis url: %w", err)
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("ratelimit: failed to ping redis: %w", err)
	}
	return client, nil
}
