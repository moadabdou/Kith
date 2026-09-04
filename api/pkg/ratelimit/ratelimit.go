// Package ratelimit implements Discord's per-route bucket model
// (plan/02 §5): POST /messages = 5 per 5s per (user, channel).
//
// Phase 0 is in-memory; Phase 1 swaps the same Middleware for a Redis
// (INCR+EXPIRE) implementation. The contract — X-RateLimit-* headers on
// every response, 429 + Retry-After when over — never changes.
//
// Rate limiting is a contract with well-behaved clients (bots):
// load shaping, not security. Security is authz + validation.
package ratelimit

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/moadabdou/Kith/api/pkg/errs"
)

// Headers set on every response passing through the limiter.
const (
	HeaderLimit      = "X-RateLimit-Limit"
	HeaderRemaining  = "X-RateLimit-Remaining"
	HeaderResetAfter = "X-RateLimit-Reset-After"
	HeaderBucket     = "X-RateLimit-Bucket"
	HeaderRetryAfter = "Retry-After"
)

// Limiter is a fixed-window counter per key. Windows feel cruder than a
// token bucket but match Discord's actual behavior (buckets reset on a
// schedule, not on spend) and are trivially portable to Redis INCR+EXPIRE.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	limit  int
	window time.Duration
}

type bucket struct {
	count   int
	resetAt time.Time
}

// NewLimiter creates a limiter allowing limit requests per window per key.
func NewLimiter(limit int, window time.Duration) *Limiter {
	return &Limiter{
		buckets: map[string]*bucket{},
		limit:   limit,
		window:  window,
	}
}

// Result describes the state of a bucket after taking one request.
type Result struct {
	Allowed   bool
	Limit     int
	Remaining int
	// ResetAfter is when the window resets, from now.
	ResetAfter time.Duration
}

// Take consumes one request for key, returning the bucket state.
func (l *Limiter) Take(key string) Result {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	b, ok := l.buckets[key]
	if !ok || !now.Before(b.resetAt) {
		b = &bucket{count: 0, resetAt: now.Add(l.window)}
		l.buckets[key] = b
	}

	if b.count < l.limit {
		b.count++
		return Result{
			Allowed:    true,
			Limit:      l.limit,
			Remaining:  l.limit - b.count,
			ResetAfter: time.Until(b.resetAt),
		}
	}
	return Result{
		Allowed:    false,
		Limit:      l.limit,
		Remaining:  0,
		ResetAfter: time.Until(b.resetAt),
	}
}

// Middleware wraps next with rate limiting. key extracts the bucket key
// from the request (e.g. "user:channel"); bucketName identifies the route
// bucket for the X-RateLimit-Bucket header (Discord hashes the route).
// The 429 body is Discord's shape, rendered by pkg/errs.
func (l *Limiter) Middleware(key func(r *http.Request) string, bucketName string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		res := l.Take(key(r))
		setHeaders(w, bucketName, res)
		if !res.Allowed {
			w.Header().Set(HeaderRetryAfter, strconv.Itoa(int(res.ResetAfter.Seconds())+1))
			errs.Write(w, errs.RateLimited(res.ResetAfter.Seconds(), false))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func setHeaders(w http.ResponseWriter, bucketName string, res Result) {
	h := w.Header()
	h.Set(HeaderLimit, strconv.Itoa(res.Limit))
	h.Set(HeaderRemaining, strconv.Itoa(res.Remaining))
	h.Set(HeaderResetAfter, strconv.FormatFloat(res.ResetAfter.Seconds(), 'f', 3, 64))
	h.Set(HeaderBucket, bucketName)
}
