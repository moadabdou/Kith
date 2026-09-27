package messages

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNewInflightDefaults(t *testing.T) {
	if got := NewInflight(0).Cap(); got != DefaultMaxInflight {
		t.Fatalf("NewInflight(0).Cap() = %d, want %d", got, DefaultMaxInflight)
	}
	if got := NewInflight(-3).Cap(); got != DefaultMaxInflight {
		t.Fatalf("NewInflight(-3).Cap() = %d, want %d", got, DefaultMaxInflight)
	}
	if got := NewInflight(7).Cap(); got != 7 {
		t.Fatalf("NewInflight(7).Cap() = %d, want %d", got, 7)
	}
}

func TestTryAcquireReleaseAccounting(t *testing.T) {
	l := NewInflight(2)
	if !l.TryAcquire() || !l.TryAcquire() {
		t.Fatal("first two acquires must succeed")
	}
	if l.TryAcquire() {
		t.Fatal("third acquire past cap must fail")
	}
	if got := l.InUse(); got != 2 {
		t.Fatalf("InUse() = %d, want 2", got)
	}
	l.Release()
	if !l.TryAcquire() {
		t.Fatal("acquire after release must succeed")
	}
	l.Release()
	l.Release()
	if got := l.InUse(); got != 0 {
		t.Fatalf("InUse() = %d, want 0 after full drain", got)
	}
}

func TestSaturatedRejectIsImmediate(t *testing.T) {
	l := NewInflight(1)
	if !l.TryAcquire() {
		t.Fatal("setup acquire failed")
	}
	start := time.Now()
	for i := 0; i < 1000; i++ {
		if l.TryAcquire() {
			t.Fatal("saturated acquire must fail")
		}
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("1000 saturated rejects took %v, must be near-instant", elapsed)
	}
	l.Release()
}

func TestConcurrentHammerRespectsCap(t *testing.T) {
	const cap = 5
	l := NewInflight(cap)
	var current, maxSeen int64
	var rejected int64
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if !l.TryAcquire() {
				atomic.AddInt64(&rejected, 1)
				return
			}
			n := atomic.AddInt64(&current, 1)
			for {
				m := atomic.LoadInt64(&maxSeen)
				if n <= m || atomic.CompareAndSwapInt64(&maxSeen, m, n) {
					break
				}
			}
			time.Sleep(time.Millisecond)
			atomic.AddInt64(&current, -1)
			l.Release()
		}()
	}
	wg.Wait()
	if got := atomic.LoadInt64(&maxSeen); got > cap {
		t.Fatalf("max concurrent holders = %d, exceeds cap %d", got, cap)
	}
	if got := atomic.LoadInt64(&rejected); got == 0 {
		t.Fatal("expected rejections under 200-way hammer on cap 5")
	}
	if got := l.InUse(); got != 0 {
		t.Fatalf("semaphore not fully drained, InUse() = %d", got)
	}
}

func TestNilLimiterIsFailClosed(t *testing.T) {
	var l *Inflight
	if l.TryAcquire() {
		t.Fatal("nil limiter must reject (fail closed, never silently unlimited)")
	}
	// Release/InUse/Cap on nil must not panic.
	l.Release()
	if l.InUse() != 0 || l.Cap() != 0 {
		t.Fatal("nil limiter accessors must report zero")
	}
}
