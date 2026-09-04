package ratelimit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

func TestBucketAllowsLimitThenBlocks(t *testing.T) {
	l := NewLimiter(5, 50*time.Millisecond)

	for i := 5; i > 0; i-- {
		res := l.Take("u:c")
		if !res.Allowed {
			t.Fatalf("request #%d should be allowed", 6-i)
		}
		if res.Remaining != i-1 {
			t.Errorf("remaining = %d, want %d", res.Remaining, i-1)
		}
		if res.Limit != 5 {
			t.Errorf("limit = %d, want 5", res.Limit)
		}
	}
	res := l.Take("u:c")
	if res.Allowed || res.Remaining != 0 {
		t.Errorf("6th request: %+v, want blocked with 0 remaining", res)
	}
}

func TestWindowReset(t *testing.T) {
	l := NewLimiter(1, 30*time.Millisecond)
	if res := l.Take("k"); !res.Allowed {
		t.Fatal("first should pass")
	}
	if res := l.Take("k"); res.Allowed {
		t.Fatal("second should be blocked inside window")
	}
	time.Sleep(35 * time.Millisecond)
	if res := l.Take("k"); !res.Allowed {
		t.Fatalf("after window: %+v, want allowed", res)
	}
}

func TestKeysAreIndependent(t *testing.T) {
	l := NewLimiter(1, time.Hour)
	if res := l.Take("u1:c1"); !res.Allowed {
		t.Fatal("u1:c1 should pass")
	}
	if res := l.Take("u1:c2"); !res.Allowed {
		t.Error("different channel should have its own bucket")
	}
	if res := l.Take("u2:c1"); !res.Allowed {
		t.Error("different user should have its own bucket")
	}
	if res := l.Take("u1:c1"); res.Allowed {
		t.Error("same key should still be blocked")
	}
}

func TestMiddlewareHeadersAnd429(t *testing.T) {
	l := NewLimiter(2, 40*time.Millisecond)
	calls := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	})
	h := l.Middleware(func(*http.Request) string { return "k" }, "test-bucket", next)

	// First two: 200 + full header set.
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("req %d: status %d, want 200", i+1, rec.Code)
		}
		assertHeaders(t, rec.Header(), map[string]string{
			HeaderLimit:     "2",
			HeaderRemaining: strconv.Itoa(1 - i),
			HeaderBucket:    "test-bucket",
		})
		if rec.Header().Get(HeaderRetryAfter) != "" {
			t.Error("Retry-After must not be set on success")
		}
		if reset := rec.Header().Get(HeaderResetAfter); reset == "" {
			t.Error("X-RateLimit-Reset-After missing")
		}
	}

	// Third: 429 + Retry-After + envelope.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("3rd request: status %d, want 429", rec.Code)
	}
	assertHeaders(t, rec.Header(), map[string]string{
		HeaderLimit:     "2",
		HeaderRemaining: "0",
		HeaderBucket:    "test-bucket",
	})
	retry := rec.Header().Get(HeaderRetryAfter)
	if retry == "" || retry == "0" {
		t.Errorf("Retry-After = %q, want positive seconds", retry)
	}
	var body struct {
		Code       int     `json:"code"`
		Message    string  `json:"message"`
		RetryAfter float64 `json:"retry_after"`
		Global     bool    `json:"global"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("429 body not JSON: %v", err)
	}
	if body.Code != ErrCodeRateLimited || body.Message == "" {
		t.Errorf("429 body = %+v", body)
	}
	if body.RetryAfter <= 0 {
		t.Errorf("retry_after = %f, want positive", body.RetryAfter)
	}
	if body.Global {
		t.Error("per-route bucket must report global: false")
	}
	if calls != 2 {
		t.Errorf("next called %d times, want 2", calls)
	}

	// Waiting out Retry-After succeeds.
	wait, _ := strconv.Atoi(retry)
	time.Sleep(time.Duration(wait) * time.Second)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("after Retry-After: status %d, want 200", rec.Code)
	}
}

func TestMiddlewareWaitingOutRetryAfterRealClock(t *testing.T) {
	l := NewLimiter(1, 20*time.Millisecond)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := l.Middleware(func(*http.Request) string { return "k" }, "b", next)
	req := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
		return rec
	}
	if rec := req(); rec.Code != http.StatusOK {
		t.Fatal("first should pass")
	}
	rec := req()
	if rec.Code != http.StatusTooManyRequests {
		t.Fatal("second should 429")
	}
	retry, _ := strconv.Atoi(rec.Header().Get(HeaderRetryAfter))
	if retry < 1 {
		t.Fatalf("Retry-After = %d, want >= 1 (ceil)", retry)
	}
	time.Sleep(time.Duration(retry) * time.Second)
	if rec := req(); rec.Code != http.StatusOK {
		t.Errorf("after waiting %ds: status %d, want 200", retry, rec.Code)
	}
}

func TestConcurrentTakeNeverExceedsLimit(t *testing.T) {
	l := NewLimiter(5, time.Hour)
	const workers, per = 8, 10
	var mu sync.Mutex
	allowed := 0
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < per; i++ {
				if l.Take("shared").Allowed {
					mu.Lock()
					allowed++
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()
	if allowed != 5 {
		t.Errorf("allowed = %d, want exactly 5 under concurrency", allowed)
	}
}

func assertHeaders(t *testing.T, h http.Header, want map[string]string) {
	t.Helper()
	for k, v := range want {
		if got := h.Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
}
