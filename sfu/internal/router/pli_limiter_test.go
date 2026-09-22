package router

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/pion/rtcp"
)

func TestPLILimiter_FirstRequestForwardsImmediately(t *testing.T) {
	var forwards atomic.Int32
	lim := newPLILimiter(50*time.Millisecond, func() { forwards.Add(1) })
	if !lim.request() {
		t.Fatalf("first request must forward synchronously")
	}
	if forwards.Load() != 1 {
		t.Fatalf("forwards = %d, want 1", forwards.Load())
	}
}

func TestPLILimiter_StormCoalesces(t *testing.T) {
	var forwards atomic.Int32
	lim := newPLILimiter(100*time.Millisecond, func() { forwards.Add(1) })
	if !lim.request() {
		t.Fatalf("first request must forward")
	}
	// 9 more inside the window: all coalesced, none forwarded inline.
	var wg sync.WaitGroup
	for i := 0; i < 9; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if lim.request() {
				t.Errorf("in-window request must coalesce, not forward")
			}
		}()
	}
	wg.Wait()
	if forwards.Load() != 1 {
		t.Fatalf("forwards = %d after storm, want 1", forwards.Load())
	}
	// Window end: exactly one coalesced forward fires.
	deadline := time.Now().Add(500 * time.Millisecond)
	for forwards.Load() != 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if forwards.Load() != 2 {
		t.Fatalf("forwards = %d after window, want 2 (1 immediate + 1 coalesced)", forwards.Load())
	}
	// No further forwards without new requests.
	time.Sleep(150 * time.Millisecond)
	if forwards.Load() != 2 {
		t.Fatalf("forwards = %d, want exactly 2 (no phantom)", forwards.Load())
	}
}

func TestPLILimiter_StopCancelsPending(t *testing.T) {
	var forwards atomic.Int32
	lim := newPLILimiter(50*time.Millisecond, func() { forwards.Add(1) })
	lim.request()
	lim.request() // coalesced, timer armed
	lim.stop()
	time.Sleep(120 * time.Millisecond)
	if forwards.Load() != 1 {
		t.Fatalf("forwards = %d, want 1 (pending cancelled)", forwards.Load())
	}
}

func TestPublisherRequestPLI_CoalescesAndCounts(t *testing.T) {
	up := NewPublisherUplink("pub_pli", nil, nil)
	defer up.Close()
	sent := make(chan []rtcp.Packet, 8)
	up.SetRTCPWriter(func(pkts []rtcp.Packet) error {
		sent <- pkts
		return nil
	})
	up.ensurePLILimiter()

	// Prime at the live clock (forwards inline: zero-value lastForward is
	// ancient). Drain it, then storm 10ms later — fully in-window, so all
	// 10 coalesce with nothing forwarded inline.
	t0 := time.Now()
	beforeRecv := getCounterValue(metrics.PLIRequestsReceived)
	beforeFwd := getCounterValue(metrics.PLIRequestsForwarded)
	up.requestPLIForTest(&rtcp.PictureLossIndication{MediaSSRC: 999}, t0)
	select {
	case <-sent:
	case <-time.After(time.Second):
		t.Fatalf("priming PLI never forwarded")
	}
	// No coalesce timer may be armed after an inline prime: assert it.
	// (The immediate branch stops any timer. If this fires, the seam
	// itself regressed.)
	select {
	case pkts := <-sent:
		t.Fatalf("prime must not arm a coalesce timer, got %+v", pkts)
	case <-time.After(100 * time.Millisecond):
	}
	stormAt := t0.Add(10 * time.Millisecond)
	for i := 0; i < 10; i++ {
		up.requestPLIForTest(&rtcp.PictureLossIndication{MediaSSRC: 999}, stormAt)
	}
	select {
	case pkts := <-sent:
		t.Fatalf("in-window storm must not forward inline, got %+v", pkts)
	case <-time.After(100 * time.Millisecond):
	}
	if got := getCounterValue(metrics.PLIRequestsReceived) - beforeRecv; got != 11 {
		t.Fatalf("received delta = %v, want 11 (prime + storm)", got)
	}
	if got := getCounterValue(metrics.PLIRequestsForwarded) - beforeFwd; got != 1 {
		t.Fatalf("forwarded delta = %v, want 1 (prime only, storm coalesced)", got)
	}
	// Coalesced forward arrives at window end (500ms + slack): exactly one.
	select {
	case pkts := <-sent:
		if _, ok := pkts[0].(*rtcp.PictureLossIndication); !ok {
			t.Fatalf("expected PLI, got %T", pkts[0])
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("coalesced PLI never forwarded")
	}
	if got := getCounterValue(metrics.PLIRequestsForwarded) - beforeFwd; got != 2 {
		t.Fatalf("forwarded delta = %v after window, want exactly 2", got)
	}
	// No further forwards without new requests.
	select {
	case pkts := <-sent:
		t.Fatalf("phantom forward without requests: %+v", pkts)
	case <-time.After(600 * time.Millisecond):
	}
}
