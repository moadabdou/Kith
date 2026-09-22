package router

import (
	"sync"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/pion/rtcp"
)

// pliWindow is the minimum interval between PLIs forwarded to one publisher.
// Concurrent requests inside the window coalesce into exactly one forward at
// window end (issue #81 acceptance: 10 subscribers → 1 PLI per 500ms).
const pliWindow = 500 * time.Millisecond

// pliLimiter coalesces Picture Loss Indications (and Full Intra Requests,
// which need the same protection) per publisher uplink so a join/leave storm
// can't stampede the sharer's encoder with back-to-back keyframe demands.
type pliLimiter struct {
	mu          sync.Mutex
	window      time.Duration
	lastForward time.Time
	pending     bool
	timer       *time.Timer
	// forward emits one coalesced PLI/FIR to the publisher.
	forward func()
}

func newPLILimiter(window time.Duration, forward func()) *pliLimiter {
	return &pliLimiter{window: window, forward: forward}
}

// request records one subscriber PLI/FIR. Returns true when a PLI was
// forwarded synchronously (window elapsed), false when coalesced (a single
// forward is scheduled at window end). Thread-safe; cheap under storm load
// (one mutex, no allocations on the hot path).
func (l *pliLimiter) request() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.lastForward) >= l.window {
		l.lastForward = now
		l.pending = false
		if l.timer != nil {
			l.timer.Stop()
			l.timer = nil
		}
		fwd := l.forward
		l.mu.Unlock()
		// Forward outside the lock: SendRTCP takes the uplink RLock, and
		// holding both orderings elsewhere risks lock-order inversion.
		// Re-lock state is already consistent (lastForward stamped).
		if fwd != nil {
			fwd()
		}
		l.mu.Lock()
		return true
	}
	if !l.pending {
		l.pending = true
		delay := l.window - now.Sub(l.lastForward)
		if l.timer != nil {
			l.timer.Stop()
		}
		l.timer = time.AfterFunc(delay, func() {
			l.mu.Lock()
			l.pending = false
			l.lastForward = time.Now()
			l.timer = nil
			fwd := l.forward
			l.mu.Unlock()
			if fwd != nil {
				fwd()
			}
		})
	}
	return false
}

// stop cancels a scheduled coalesced forward. Called on uplink teardown so
// a dead publisher never receives a stale PLI.
func (l *pliLimiter) stop() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.timer != nil {
		l.timer.Stop()
		l.timer = nil
	}
	l.pending = false
}

// requestPLI routes one subscriber PLI through the uplink limiter,
// coalescing storms. Increments the received/forwarded metrics per #81.
func (p *PublisherUplink) requestPLI(pkt *rtcp.PictureLossIndication) {
	p.requestPLIForTest(pkt, time.Now())
}

// requestPLIForTest is the test seam for requestPLI with an injected clock.
// In-window requests are coalesced exactly like production; the coalesced
// forward is delivered via the limiter's forward closure (SendRTCP +
// counting) because requestForTest shares request()'s closure contract.
func (p *PublisherUplink) requestPLIForTest(pkt *rtcp.PictureLossIndication, now time.Time) {
	metrics.PLIRequestsReceived.Inc()
	p.pliMu.Lock()
	lim := p.pliLimiter
	p.pliMu.Unlock()
	if lim == nil {
		return
	}
	if lim.requestForTest(now) {
		metrics.PLIRequestsForwarded.Inc()
		_ = p.SendRTCP([]rtcp.Packet{pkt})
		return
	}
	// Coalesced: nothing inline. The limiter's forward closure (installed by
	// ensurePLILimiter) re-emits a fresh PLI + counts at window end.
}

// requestFIR routes one subscriber FIR identically to a PLI.
func (p *PublisherUplink) requestFIR(pkt *rtcp.FullIntraRequest) {
	metrics.PLIRequestsReceived.Inc()
	p.pliMu.Lock()
	lim := p.pliLimiter
	p.pliMu.Unlock()
	if lim == nil {
		return
	}
	if lim.request() {
		metrics.PLIRequestsForwarded.Inc()
		_ = p.SendRTCP([]rtcp.Packet{pkt})
		return
	}
}

// testCoalesceDelay caps how long a coalesced test forward waits in real
// time. Production request() always waits the full remaining window; the
// test seam compresses it so coalescing is observable without sleeping
// 500ms per case. Must stay comfortably ABOVE the test's own in-window
// assertion time (the storm loop + channel drain below) so the compressed
// forward can't win the race against the assertions. Never used outside
// tests.
const testCoalesceDelay = 500 * time.Millisecond

// requestForTest is the deterministic test seam for request: identical
// window math with an injected clock (compressed coalesce delay above).
func (l *pliLimiter) requestForTest(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastForward) >= l.window {
		l.lastForward = now
		l.pending = false
		if l.timer != nil {
			l.timer.Stop()
			l.timer = nil
		}
		return true
	}
	if !l.pending {
		l.pending = true
		if l.timer != nil {
			l.timer.Stop()
		}
		fwd := l.forward
		l.timer = time.AfterFunc(testCoalesceDelay, func() {
			l.mu.Lock()
			l.pending = false
			l.lastForward = time.Now()
			l.timer = nil
			l.mu.Unlock()
			// Same contract as production: the forward closure re-emits
			// (fresh PLI via SendRTCP) and counts forwarded.
			if fwd != nil {
				fwd()
			}
		})
	}
	return false
}

// ensurePLILimiter installs the limiter (idempotent). The forward closure
// re-emits a fresh PLI (SSRC rewritten at send time) and counts it.
func (p *PublisherUplink) ensurePLILimiter() {
	p.pliMu.Lock()
	defer p.pliMu.Unlock()
	if p.pliLimiter != nil {
		return
	}
	p.pliLimiter = newPLILimiter(pliWindow, func() {
		metrics.PLIRequestsForwarded.Inc()
		_ = p.SendRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: p.uplinkSSRC()}})
	})
}

// uplinkSSRC returns the publisher track SSRC for feedback addressing
// (0 when unknown — SendRTCP rewrites it anyway when the track exists).
func (p *PublisherUplink) uplinkSSRC() uint32 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.TrackRemote != nil {
		return uint32(p.TrackRemote.SSRC())
	}
	return 0
}
