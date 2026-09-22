package router

import (
	"math"
	"testing"
	"time"
)

func TestDesiredLayer_DownFast(t *testing.T) {
	// One bad window steps down immediately from any layer.
	if got := desiredLayer(LayerFull, 0.10, 5, 0, 0); got != LayerHalf {
		t.Errorf("f + 10%% loss = %s, want h", got)
	}
	if got := desiredLayer(LayerHalf, 0.30, 5, 0, 0); got != LayerQuarter {
		t.Errorf("h + 30%% loss = %s, want q", got)
	}
	if got := desiredLayer(LayerQuarter, 0.50, 5, 0, 0); got != LayerQuarter {
		t.Errorf("q + 50%% loss = %s, want q (floor)", got)
	}
}

func TestDesiredLayer_JitterWithLoss(t *testing.T) {
	// High jitter + any loss also steps down (congestion precedes loss).
	if got := desiredLayer(LayerFull, 0.02, 80, 0, 0); got != LayerHalf {
		t.Errorf("f + jitter 80ms + 2%% loss = %s, want h", got)
	}
	// High jitter alone (no loss) does NOT step down.
	if got := desiredLayer(LayerFull, 0.0, 80, 10, 0); got != LayerFull {
		t.Errorf("f + jitter only = %s, want f", got)
	}
}

func TestDesiredLayer_UpRequiresSustained(t *testing.T) {
	// Good score but impatient: stays put.
	if got := desiredLayer(LayerQuarter, 0.0, 5, 2, 0); got != LayerQuarter {
		t.Errorf("q + 2 good windows = %s, want q", got)
	}
	// Sustained: steps exactly one rank.
	if got := desiredLayer(LayerQuarter, 0.0, 5, 5, 0); got != LayerHalf {
		t.Errorf("q + 5 good windows = %s, want h", got)
	}
	if got := desiredLayer(LayerHalf, 0.005, 5, 9, 0); got != LayerFull {
		t.Errorf("h + 9 good windows = %s, want f", got)
	}
	// At ceiling: stays.
	if got := desiredLayer(LayerFull, 0.0, 5, 99, 0); got != LayerFull {
		t.Errorf("f + 99 good windows = %s, want f", got)
	}
}

func TestDesiredLayer_HoldInBetween(t *testing.T) {
	// Mediocre-but-not-bad holds the current layer (no flap).
	if got := desiredLayer(LayerHalf, 0.03, 10, 0, 0); got != LayerHalf {
		t.Errorf("h + 3%% loss = %s, want h (hold)", got)
	}
	// Unknown current layer defaults to f behavior.
	if got := desiredLayer("bogus", 0.0, 5, 99, 0); got != LayerFull {
		t.Errorf("bogus layer = %s, want f", got)
	}
}

func TestDesiredLayer_NackRateForcesDown(t *testing.T) {
	// Heavy repair effort with CLEAN loss % still steps down: retransmits
	// masking damage is congestion (the 180p floor case).
	if got := desiredLayer(LayerHalf, 0.02, 10, 0, nackRateDownThreshold+5); got != LayerQuarter {
		t.Errorf("h + low loss + high NACK rate = %s, want q", got)
	}
	if got := desiredLayer(LayerFull, 0.0, 5, 9, nackRateDownThreshold); got != LayerHalf {
		t.Errorf("f + zero loss + threshold NACK rate = %s, want h", got)
	}
	// Below threshold: NACKs alone don't move anything (smooth-8% case).
	if got := desiredLayer(LayerHalf, 0.02, 10, 0, nackRateDownThreshold-1); got != LayerHalf {
		t.Errorf("h + low loss + sub-threshold NACK rate = %s, want h (hold)", got)
	}
	// Heavy repair effort blocks climbing even when reported loss looks
	// clean: stepping into more bitrate mid-storm just re-congests.
	if got := desiredLayer(LayerQuarter, 0.0, 5, 9, nackRateDownThreshold+100); got != LayerQuarter {
		t.Errorf("q + clean + sustained good + high NACK rate = %s, want q (hold)", got)
	}
	// Once NACKs age out, the same healthy link climbs normally.
	if got := desiredLayer(LayerQuarter, 0.0, 5, 9, 0); got != LayerHalf {
		t.Errorf("q + clean + sustained good + quiet NACKs = %s, want h", got)
	}
	// Floor still holds at q no matter the NACK storm.
	if got := desiredLayer(LayerQuarter, 0.50, 80, 0, nackRateDownThreshold+100); got != LayerQuarter {
		t.Errorf("q + storm = %s, want q (floor)", got)
	}
}

func TestDownlinkScore_EWMAAndWindows(t *testing.T) {
	var s downlinkScore
	// Clean reports: EWMA decays toward 0, good windows accumulate.
	for i := 0; i < 6; i++ {
		s.observeRR(0, 100, 90000)
	}
	loss, _, good, _, _ := s.snapshot()
	if loss != 0 {
		t.Errorf("loss = %v, want 0", loss)
	}
	if good != 6 {
		t.Errorf("goodWindows = %d, want 6", good)
	}
	// One bad report: EWMA jumps (0.4 * 25%), windows reset.
	s.observeRR(64, 100, 90000) // 64/256 = 25% loss
	loss, _, good, _, _ = s.snapshot()
	if loss < 0.09 || loss > 0.11 {
		t.Errorf("loss = %v, want ~0.10", loss)
	}
	if good != 0 {
		t.Errorf("goodWindows = %d, want 0 after bad report", good)
	}
	s.observeNack()
	s.observeNack()
	if _, _, _, n, _ := s.snapshot(); n != 2 {
		t.Errorf("nacks = %d, want 2", n)
	}
}

func TestDownlinkScore_NackRateWindow(t *testing.T) {
	var s downlinkScore
	// 10 recent NACKs over a 5s window => ~2/sec.
	for i := 0; i < 10; i++ {
		s.observeNack()
	}
	_, _, _, n, rate := s.snapshot()
	if n != 10 {
		t.Fatalf("nacks = %d, want 10", n)
	}
	if rate < 1.9 || rate > 2.1 {
		t.Fatalf("rate = %v, want ~2.0/s", rate)
	}
	// Stale NACKs (older than the window) don't count.
	var old downlinkScore
	old.observeNackAt(time.Now().Add(-time.Hour))
	if _, _, _, _, rate := old.snapshot(); rate != 0 {
		t.Fatalf("stale NACK rate = %v, want 0", rate)
	}
	// Cap: storms can't grow the buffer unbounded.
	var capped downlinkScore
	for i := 0; i < nackRateMaxEntries+100; i++ {
		capped.observeNack()
	}
	capped.mu.Lock()
	buflen := len(capped.nackTimes)
	capped.mu.Unlock()
	if buflen != nackRateMaxEntries {
		t.Fatalf("buffer len = %d, want cap %d", buflen, nackRateMaxEntries)
	}
}

func TestSanitizeScore(t *testing.T) {
	if sanitizeScore(0.5) != 0.5 {
		t.Errorf("finite value must pass through")
	}
	if sanitizeScore(math.Inf(1)) != 1.0 {
		t.Errorf("+Inf must clamp to 1.0")
	}
	if sanitizeScore(math.NaN()) != 1.0 {
		t.Errorf("NaN must clamp to 1.0")
	}
}
