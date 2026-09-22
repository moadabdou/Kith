package router

import (
	"math"
	"sync"
	"time"
)

// Layer selection for per-viewer simulcast switching (issue #82).
//
// The SFU is a forwarder: it never sees raw bitrate, so the estimator works
// from what RTCP Receiver Reports actually carry — fraction lost, jitter,
// and (via our own counters) NACK rate. Score bands map onto the issue's
// layer thresholds; hysteresis + cooldown (below) keep viewers from
// flapping on transient spikes.
//
// Timing policy (conservative): switch DOWN fast (1 bad window, ~1-2s — a
// congested viewer needs relief now), switch UP only after sustainedGood
// consecutive good windows (~5s) plus a per-pair cooldown. Sitting on q a
// little longer after recovery beats a flap-induced freeze every time.

// Layer ranks: higher is better quality.
var layerRank = map[string]int{LayerQuarter: 0, LayerHalf: 1, LayerFull: 2}

// Estimation windows.
const (
	// scoreAlpha is the EWMA weight for each new Receiver Report sample.
	scoreAlpha = 0.4
	// badScoreThreshold: smoothed loss fraction at/above this means DOWN now.
	badScoreThreshold = 0.05
	// goodScoreThreshold: smoothed loss fraction at/below this counts as a
	// good window toward stepping back up.
	goodScoreThreshold = 0.01
	// sustainedGoodWindows: consecutive good windows required before UP.
	sustainedGoodWindows = 5
	// highJitterMs: jitter at/above this (with any loss) forces DOWN —
	// jitter spikes precede loss on congested links.
	highJitterMs = 50.0
	// nackRateWindow: sliding window over which NACK rate is measured.
	nackRateWindow = 5 * time.Second
	// nackRateMaxEntries: cap on stored NACK timestamps (storm protection).
	nackRateMaxEntries = 512
	// nackRateDownThreshold: NACKs/sec at/above this means DOWN now, even
	// when reported loss looks clean. Repair hides damage from loss % but
	// not from repair effort: heavy NACKing IS congestion. Calibrated
	// between the smooth-8% case (stays) and the laggy-32% case (steps
	// down); see manual gate. Conservative on purpose — too low would
	// needlessly drop the smooth case to q.
	nackRateDownThreshold = 20.0
)

// downlinkScore is the smoothed health of one subscriber downlink.
// All fields guarded by mu; updates arrive from the rtcpLoop goroutine,
// reads from the router evaluation ticker.
type downlinkScore struct {
	mu          sync.Mutex
	lossEWMA    float64
	jitterMs    float64
	nackCount   uint64
	nackTimes   []time.Time
	goodWindows int
}

// observeRR folds one Receiver Report block into the score.
func (s *downlinkScore) observeRR(fractionLost uint8, jitter uint32, clockRate uint32) {
	loss := float64(fractionLost) / 256.0
	var jitterMs float64
	if clockRate > 0 {
		jitterMs = float64(jitter) / float64(clockRate) * 1000.0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lossEWMA = scoreAlpha*loss + (1-scoreAlpha)*s.lossEWMA
	s.jitterMs = scoreAlpha*jitterMs + (1-scoreAlpha)*s.jitterMs
	if s.lossEWMA <= goodScoreThreshold {
		s.goodWindows++
	} else {
		s.goodWindows = 0
	}
}

// observeNack records one NACK for rate tracking (called per NACK packet).
func (s *downlinkScore) observeNack() {
	s.observeNackAt(time.Now())
}

// observeNackAt is observeNack with an injected clock (tests).
func (s *downlinkScore) observeNackAt(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nackCount++
	s.nackTimes = append(s.nackTimes, now)
	if len(s.nackTimes) > nackRateMaxEntries {
		// Drop oldest; storms must not grow this unbounded.
		copy(s.nackTimes, s.nackTimes[len(s.nackTimes)-nackRateMaxEntries:])
		s.nackTimes = s.nackTimes[:nackRateMaxEntries]
	}
}

// snapshot returns the current smoothed values, including NACKs/sec over
// the rate window (pruned inline; snapshot already holds the lock).
// Repair effort IS congestion signal: heavy NACKing with clean loss %
// means retransmits are masking damage (the 180p floor case).
func (s *downlinkScore) snapshot() (loss, jitterMs float64, goodWindows int, nacks uint64, nackRate float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-nackRateWindow)
	kept := s.nackTimes[:0]
	for _, t := range s.nackTimes {
		if !t.Before(cutoff) {
			kept = append(kept, t)
		}
	}
	for i := len(kept); i < len(s.nackTimes); i++ {
		s.nackTimes[i] = time.Time{}
	}
	s.nackTimes = kept
	return s.lossEWMA, s.jitterMs, s.goodWindows, s.nackCount, float64(len(kept)) / nackRateWindow.Seconds()
}

// desiredLayer maps a score snapshot onto a layer RID given the current
// layer. DOWN is immediate on one bad window; UP requires sustainedGood
// consecutive good windows AND only steps one rank per evaluation (f→h→q
// climbs back gradually, never jumping q→f on a single good read).
// nackRate is repair effort (NACKs/sec): heavy NACKing with clean loss %
// means retransmits are masking damage, so it forces DOWN exactly like
// high loss — and blocks UP until the repair storm passes, since stepping
// into more bitrate mid-storm just re-congests.
func desiredLayer(current string, loss, jitterMs float64, goodWindows int, nackRate float64) string {
	cur := layerRank[current]
	if _, ok := layerRank[current]; !ok {
		cur = layerRank[LayerFull]
	}
	bad := loss >= badScoreThreshold ||
		(jitterMs >= highJitterMs && loss > 0) ||
		nackRate >= nackRateDownThreshold
	if bad {
		if cur == layerRank[LayerQuarter] {
			return LayerQuarter
		}
		return rankToLayer(cur - 1)
	}
	// UP needs a truly healthy link on ALL signals: heavy repair effort
	// blocks climbing even when reported loss looks clean (otherwise we'd
	// step straight back into the congestion that forced us down).
	if loss <= goodScoreThreshold && goodWindows >= sustainedGoodWindows && nackRate < nackRateDownThreshold {
		if cur == layerRank[LayerFull] {
			return LayerFull
		}
		return rankToLayer(cur + 1)
	}
	return rankToLayer(cur)
}

func rankToLayer(rank int) string {
	switch rank {
	case 0:
		return LayerQuarter
	case 1:
		return LayerHalf
	default:
		return LayerFull
	}
}

// jitterMs converts an RTP-timestamp jitter value to milliseconds.
func jitterMs(jitter, clockRate uint32) float64 {
	if clockRate == 0 {
		return 0
	}
	return float64(jitter) / float64(clockRate) * 1000.0
}

// sanitizeScore clamps NaN/Inf observations (corrupt RTCP) to worst-case so
// a malformed report degrades one viewer, never the estimator.
func sanitizeScore(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 1.0
	}
	return v
}
