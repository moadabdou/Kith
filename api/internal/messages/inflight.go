package messages

// Inflight bounds concurrent message writes (Issue #92).
//
// The per-route 5/5s limiter caps individual (user, channel) buckets, but
// 120+ distinct writers sail through it and pile thousands of concurrent
// DB operations onto a 25-conn pool — POST tails explode to seconds while
// requests queue in RAM. This semaphore caps total in-flight Send work at
// ~2x pool size; overflow fails fast with 429 instead of queueing.
//
// Implemented as a buffered channel (stdlib-only): acquisition is a
// non-blocking select/default (~50ns), never a wait. Callers that cannot
// acquire must reject immediately, never block.
type Inflight struct {
	sem chan struct{}
}

// DefaultMaxInflight caps concurrent Send work at 2x the DB pool size
// (pool is 25; a request can hold a conn across sequential ops).
const DefaultMaxInflight = 50

// NewInflight creates a semaphore holding at most max concurrent slots.
// Non-positive max falls back to DefaultMaxInflight (fail-loud defaults:
// an unlimited semaphore would silently reintroduce the T2 collapse).
func NewInflight(max int) *Inflight {
	if max <= 0 {
		max = DefaultMaxInflight
	}
	return &Inflight{sem: make(chan struct{}, max)}
}

// TryAcquire takes a slot if one is free, reporting immediately.
// Never blocks — the whole point is failing fast under burst.
func (l *Inflight) TryAcquire() bool {
	if l == nil {
		return false
	}
	select {
	case l.sem <- struct{}{}:
		return true
	default:
		return false
	}
}

// Release frees a previously acquired slot. Calling Release without a
// matching acquire panics (programmer error, loud by design).
func (l *Inflight) Release() {
	if l == nil {
		return
	}
	<-l.sem
}

// InUse reports currently held slots (tests, diagnostics).
func (l *Inflight) InUse() int {
	if l == nil {
		return 0
	}
	return len(l.sem)
}

// Cap reports the configured maximum.
func (l *Inflight) Cap() int {
	if l == nil {
		return 0
	}
	return cap(l.sem)
}
