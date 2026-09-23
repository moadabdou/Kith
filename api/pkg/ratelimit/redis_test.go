package ratelimit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestDecide(t *testing.T) {
	window := 5 * time.Second

	res := decide(3, 4000, 5, window)
	if !res.Allowed || res.Remaining != 2 || res.ResetAfter != 4*time.Second {
		t.Fatalf("within budget: %+v", res)
	}

	res = decide(5, 1000, 5, window)
	if !res.Allowed || res.Remaining != 0 {
		t.Fatalf("exactly at budget must allow: %+v", res)
	}

	res = decide(6, 1000, 5, window)
	if res.Allowed || res.Remaining != 0 {
		t.Fatalf("over budget must deny: %+v", res)
	}

	res = decide(1, -1, 5, window)
	if res.ResetAfter != window {
		t.Fatalf("missing TTL must fall back to window: %+v", res)
	}
}

func TestRedisLimiterFailOpen(t *testing.T) {
	// Port 1 refuses connections: Take must allow, never block the request.
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	defer client.Close()

	l := NewRedisLimiter(client, 1, time.Second)
	res := l.Take(context.Background(), "test:failopen")
	if !res.Allowed {
		t.Fatalf("redis down must fail open: %+v", res)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	l.Middleware(func(r *http.Request) string { return "k" }, "b", next).
		ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("middleware must pass through when redis is down, got %d", rec.Code)
	}
	if rec.Header().Get(HeaderLimit) != "1" {
		t.Fatalf("headers must still be set on fail-open: %v", rec.Header())
	}
}

func redisTestClient(t *testing.T) redis.UniversalClient {
	t.Helper()
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		redisURL = os.Getenv("REDIS_URL")
	}
	if redisURL == "" {
		t.Skip("TEST_REDIS_URL or REDIS_URL not set; skipping redis limiter integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := Dial(ctx, redisURL)
	if err != nil {
		t.Skipf("redis unreachable at %s: %v", redisURL, err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestRedisLimiterSharedBudget(t *testing.T) {
	client := redisTestClient(t)
	ctx := context.Background()

	// Two limiter instances = two API replicas sharing one bucket.
	// Note: Middleware namespaces keys as "<bucket>:<key>", so the manual
	// Takes below use the same namespaced key the Middleware call will.
	a := NewRedisLimiter(client, 2, 5*time.Second)
	b := NewRedisLimiter(client, 2, 5*time.Second)
	rawKey := "test:shared:" + t.Name()
	key := "test-bucket:" + rawKey

	if _, err := client.Del(ctx, keyPrefix+":"+key).Result(); err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	if !a.Take(ctx, key).Allowed {
		t.Fatal("request 1 (replica A) must allow")
	}
	if !b.Take(ctx, key).Allowed {
		t.Fatal("request 2 (replica B) must allow: budget is global, not per-replica")
	}
	res := a.Take(ctx, key)
	if res.Allowed || res.Remaining != 0 {
		t.Fatalf("request 3 must deny with 0 remaining: %+v", res)
	}

	// Middleware path denies with Discord-shaped 429 + headers.
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	a.Middleware(func(r *http.Request) string { return rawKey }, "test-bucket", next).
		ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over budget must be 429, got %d", rec.Code)
	}
	if rec.Header().Get(HeaderBucket) != "test-bucket" {
		t.Fatalf("bucket header missing: %v", rec.Header())
	}
}
