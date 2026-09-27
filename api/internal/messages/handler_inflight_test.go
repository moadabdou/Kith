package messages

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

// errStore fails inserts; embeds the shared mock for every other method.
type errStore struct {
	mockHandlerStore
	insertCalls int
}

func (m *errStore) Insert(ctx context.Context, msg *Message) error {
	m.insertCalls++
	return errors.New("boom")
}

func sendMux(h *Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/guilds/{id}/channels/{cid}/messages", h.Send)
	return mux
}

func sendReq(uid int64, body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/guilds/1/channels/123/messages", strings.NewReader(body))
	return req.WithContext(auth.ContextWithUserID(req.Context(), uid))
}

func testNode(t *testing.T) *snowflake.Node {
	t.Helper()
	node, err := snowflake.NewNode(998)
	if err != nil {
		t.Fatalf("snowflake node: %v", err)
	}
	return node
}

func TestSendSaturatedRejects429WithRetryAfter(t *testing.T) {
	svc := NewService(nil, &mockHandlerStore{}, testNode(t), NoopRecorder{})
	h := NewHandler(svc, 1)
	if !h.Inflight.TryAcquire() {
		t.Fatal("setup acquire failed")
	}
	defer h.Inflight.Release()

	rec := httptest.NewRecorder()
	sendMux(h).ServeHTTP(rec, sendReq(456, `{"content":"hi"}`))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d: %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1", got)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode 429 body: %v", err)
	}
	if body["retry_after"] != float64(1) {
		t.Fatalf("body retry_after = %v, want 1", body["retry_after"])
	}
}

func TestSendSuccessReleasesSlot(t *testing.T) {
	svc := NewService(nil, &mockHandlerStore{}, testNode(t), NoopRecorder{})
	h := NewHandler(svc, 2)

	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		sendMux(h).ServeHTTP(rec, sendReq(456, `{"content":"hello"}`))
		if rec.Code != http.StatusCreated {
			t.Fatalf("request %d: expected 201, got %d: %s", i, rec.Code, rec.Body.String())
		}
	}
	if got := h.Inflight.InUse(); got != 0 {
		t.Fatalf("slots leaked, InUse() = %d", got)
	}
}

func TestSendServiceErrorStillReleases(t *testing.T) {
	store := &errStore{}
	svc := NewService(nil, store, testNode(t), NoopRecorder{})
	h := NewHandler(svc, 1)

	rec := httptest.NewRecorder()
	sendMux(h).ServeHTTP(rec, sendReq(456, `{"content":"hi"}`))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", rec.Code, rec.Body.String())
	}
	if store.insertCalls != 1 {
		t.Fatalf("service ran %d inserts, want exactly 1 (no swallow, no retry)", store.insertCalls)
	}
	if got := h.Inflight.InUse(); got != 0 {
		t.Fatalf("slot leaked on error path, InUse() = %d", got)
	}
}

func TestSendInvalidContentConsumesNoSlot(t *testing.T) {
	svc := NewService(nil, &mockHandlerStore{}, testNode(t), NoopRecorder{})
	h := NewHandler(svc, 1)

	rec := httptest.NewRecorder()
	sendMux(h).ServeHTTP(rec, sendReq(456, `{"content":""}`))
	if rec.Code == http.StatusTooManyRequests {
		t.Fatal("validation failure must not consume a slot")
	}
	if got := h.Inflight.InUse(); got != 0 {
		t.Fatalf("InUse() = %d after invalid request", got)
	}
}

func TestSendConcurrentHammerBounded(t *testing.T) {
	svc := NewService(nil, &mockHandlerStore{}, testNode(t), NoopRecorder{})
	h := NewHandler(svc, 4)
	mux := sendMux(h)

	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, sendReq(int64(1000+i), `{"content":"x"}`))
			mu.Lock()
			codes[rec.Code]++
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	if codes[http.StatusCreated]+codes[http.StatusTooManyRequests] != 100 {
		t.Fatalf("unexpected status mix: %v", codes)
	}
	if codes[http.StatusTooManyRequests] == 0 {
		t.Fatal("expected some fast-rejections under 100-way hammer on cap 4")
	}
	if got := h.Inflight.InUse(); got != 0 {
		t.Fatalf("slots leaked after hammer, InUse() = %d", got)
	}
}

var _ events.Publisher = NoopRecorder{}
