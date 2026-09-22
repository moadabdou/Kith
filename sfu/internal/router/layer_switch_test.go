package router

import (
	"testing"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/pion/webrtc/v4"
)

// switchTestBed builds a router with one real subscriber peer (bob) and one
// publisher (alice) holding three video layer uplinks declared as camera.
func switchTestBed(t *testing.T) (*Router, *peer.Peer) {
	t.Helper()
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatal(err)
	}
	bobPeer, err := peer.NewPeer(api, webrtc.Configuration{}, "bob", "sess_bob_sw", "chan_sw", "guild")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bobPeer.Close() })
	go func() {
		for range bobPeer.Candidates {
		}
	}()

	r := NewRouter("chan_sw")
	t.Cleanup(func() { r.Close() })
	reneg := make(chan webrtc.SessionDescription, 16)
	r.AddPeer(bobPeer, func(offer webrtc.SessionDescription) { reneg <- offer })

	mkUplink := func(rid string) *PublisherUplink {
		up := NewPublisherUplink("alice", nil, nil)
		up.Kind = webrtc.RTPCodecTypeVideo
		up.CodecCap = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}
		up.TrackKey = "alice:video:" + rid
		r.publishers[up.TrackKey] = up
		return up
	}
	mkUplink(LayerFull)
	mkUplink(LayerHalf)
	mkUplink(LayerQuarter)
	// Seed a keyframe cache on h and q so DOWN switches (keyframe-gated)
	// proceed without waiting for live RTP in-test.
	for _, rid := range []string{LayerHalf, LayerQuarter} {
		up := r.publishers["alice:video:"+rid]
		for _, pkt := range keyframeRTP(t, 1000, 2) {
			up.observeKeyframe(pkt)
		}
	}
	r.SetVideoKind("alice", VideoKindCamera)

	// Drain the initial f-subscription offer (no far-end needed: the
	// switch tests assert map state, and TriggerRenegotiation only needs
	// the offer to be creatable, not answered).
	select {
	case <-reneg:
	case <-time.After(2 * time.Second):
		t.Fatalf("initial subscription offer never arrived")
	}
	return r, bobPeer
}

func TestLayerSwitch_DownOnBadScore(t *testing.T) {
	r, _ := switchTestBed(t)

	entry := r.subscribers["bob"]["alice:video:f"]
	if entry == nil {
		t.Fatalf("bob has no f downlink after setup")
	}
	// One bad window: loss pushes the score over the threshold.
	for i := 0; i < 3; i++ {
		entry.downlink.score.observeRR(26, 100, 90000) // ~10% loss
	}
	r.evalLayers()

	if _, ok := r.subscribers["bob"]["alice:video:h"]; !ok {
		t.Fatalf("bob did not switch f->h on bad score: %v", subKeys(r, "bob"))
	}
	if _, ok := r.subscribers["bob"]["alice:video:f"]; ok {
		t.Fatalf("old f entry survived the switch")
	}
	if got := entry.downlink.GetLayer(); got != LayerFull {
		// Old downlink object keeps its label (it is closed, not reused).
		t.Logf("old downlink layer = %s (closed, informational)", got)
	}
	newEntry := r.subscribers["bob"]["alice:video:h"]
	if newEntry.downlink.GetLayer() != LayerHalf {
		t.Fatalf("new downlink layer = %s, want h", newEntry.downlink.GetLayer())
	}
	if got := getCounterValue(metrics.LayerSwitches.WithLabelValues("down")); got < 1 {
		t.Fatalf("down-switch counter = %v, want >= 1", got)
	}
}

func TestLayerSwitch_UpRequiresSustained(t *testing.T) {
	r, _ := switchTestBed(t)

	// Force down first.
	entry := r.subscribers["bob"]["alice:video:f"]
	for i := 0; i < 3; i++ {
		entry.downlink.score.observeRR(26, 100, 90000)
	}
	r.evalLayers()
	hEntry := r.subscribers["bob"]["alice:video:h"]
	if hEntry == nil {
		t.Fatalf("setup: bob never reached h: %v", subKeys(r, "bob"))
	}

	// A few good windows: must HOLD (hysteresis), not step up.
	for i := 0; i < 3; i++ {
		hEntry.downlink.score.observeRR(0, 100, 90000)
	}
	// Clear cooldown so only hysteresis is under test.
	r.mu.Lock()
	delete(r.switchCooldown, switchCooldownKey("bob", "alice"))
	r.mu.Unlock()
	r.evalLayers()
	if _, ok := r.subscribers["bob"]["alice:video:f"]; ok {
		t.Fatalf("stepped up after only 3 good windows (want >= 5)")
	}

	// Sustained good: steps back up exactly one rank.
	for i := 0; i < 4; i++ {
		hEntry.downlink.score.observeRR(0, 100, 90000)
	}
	r.mu.Lock()
	delete(r.switchCooldown, switchCooldownKey("bob", "alice"))
	r.mu.Unlock()
	// The h entry object may have been replaced; re-resolve.
	hEntry = r.subscribers["bob"]["alice:video:h"]
	if hEntry == nil {
		t.Fatalf("lost h entry before sustained test")
	}
	r.evalLayers()
	if _, ok := r.subscribers["bob"]["alice:video:f"]; !ok {
		t.Fatalf("did not step h->f after sustained good: %v", subKeys(r, "bob"))
	}
}

func TestLayerSwitch_ScreenNeverSwitches(t *testing.T) {
	r, _ := switchTestBed(t)
	r.SetVideoKind("alice", VideoKindScreen)

	// Find the screen downlink (f key, screen-labeled).
	entry := r.subscribers["bob"]["alice:video:f"]
	if entry == nil {
		t.Fatalf("no screen downlink after relabel: %v", subKeys(r, "bob"))
	}
	for i := 0; i < 5; i++ {
		entry.downlink.score.observeRR(128, 5000, 90000) // 50% loss, terrible
	}
	r.evalLayers()
	if _, ok := r.subscribers["bob"]["alice:video:f"]; !ok {
		t.Fatalf("screen downlink moved under terrible score: %v", subKeys(r, "bob"))
	}
}

func TestLayerSwitch_CooldownPreventsFlap(t *testing.T) {
	r, _ := switchTestBed(t)
	entry := r.subscribers["bob"]["alice:video:f"]
	for i := 0; i < 3; i++ {
		entry.downlink.score.observeRR(26, 100, 90000)
	}
	r.evalLayers()
	if _, ok := r.subscribers["bob"]["alice:video:h"]; !ok {
		t.Fatalf("setup: no f->h switch")
	}
	// Immediately terrible on h too: cooldown must block h->q.
	hEntry := r.subscribers["bob"]["alice:video:h"]
	for i := 0; i < 3; i++ {
		hEntry.downlink.score.observeRR(200, 5000, 90000)
	}
	r.evalLayers()
	if _, ok := r.subscribers["bob"]["alice:video:q"]; ok {
		t.Fatalf("cooldown violated: h->q inside 10s window")
	}
}

func TestLayerSwitch_TwoViewersDiverge(t *testing.T) {
	r, _ := switchTestBed(t)

	// Second viewer carol with her own peer.
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatal(err)
	}
	carolPeer, err := peer.NewPeer(api, webrtc.Configuration{}, "carol", "sess_carol_sw", "chan_sw", "guild")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { carolPeer.Close() })
	go func() {
		for range carolPeer.Candidates {
		}
	}()
	r.AddPeer(carolPeer, func(offer webrtc.SessionDescription) {})
	r.SubscribeToExistingPublishers("carol")

	// Bob congested, carol clean.
	bobEntry := r.subscribers["bob"]["alice:video:f"]
	for i := 0; i < 3; i++ {
		bobEntry.downlink.score.observeRR(26, 100, 90000)
	}
	r.evalLayers()

	if _, ok := r.subscribers["bob"]["alice:video:h"]; !ok {
		t.Fatalf("bob did not step down: %v", subKeys(r, "bob"))
	}
	if _, ok := r.subscribers["carol"]["alice:video:f"]; !ok {
		t.Fatalf("carol (clean) lost f: %v", subKeys(r, "carol"))
	}
}

func TestLayerSwitch_AlwaysRequestsFreshPLI(t *testing.T) {
	r, _ := switchTestBed(t)

	entry := r.subscribers["bob"]["alice:video:f"]
	if entry == nil {
		t.Fatalf("bob has no f downlink after setup")
	}
	for i := 0; i < 3; i++ {
		entry.downlink.score.observeRR(26, 100, 90000) // ~10% loss
	}
	before := getCounterValue(metrics.PLIRequestsReceived)
	r.evalLayers()

	if _, ok := r.subscribers["bob"]["alice:video:h"]; !ok {
		t.Fatalf("setup: bob never reached h: %v", subKeys(r, "bob"))
	}
	// The switch must request a fresh keyframe EVEN THOUGH the seeded h
	// cache replays: replay alone anchors on possibly-stale state while
	// live deltas reference newer state. The limiter coalesces it free.
	if got := getCounterValue(metrics.PLIRequestsReceived) - before; got < 1 {
		t.Fatalf("switch requested no fresh PLI (received delta = %v)", got)
	}
}

// --- helpers ---

func subKeys(r *Router, subID string) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []string
	for k := range r.subscribers[subID] {
		out = append(out, k)
	}
	return out
}
