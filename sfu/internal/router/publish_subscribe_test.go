package router

// L2 integration: full publish → subscribe chain through REAL Pion
// PeerConnections (real offer/answer SDP, real TrackRemote identity —
// the offer SDP is Chrome-shaped with a rid + simulcast block injected,
// exactly as a browser client sends).
//
// The test drives Pion negotiation exactly as the room does, then ingests
// the negotiated receiver tracks into the router the same way room.go's
// OnTrack callback does (in production OnTrack fires on first RTP; here we
// read the same TrackRemote objects straight off the receivers — identity
// fields are SDP-derived and identical either way).
//
// What it proves (simulcast #80 + negotiate-once kind flag): one uplink per
// RID (f/h/q), RID-keyed publisher map with no key collision, only the f
// layer fanned out to viewers under stable Kith downlink ids, kind switches
// relabeling the f uplink in place (offer shape changes, uplink object
// retained), kind none retaining the uplink for stream reuse, and a late
// joiner receiving exactly the live set.
//
// What it does NOT prove: live RTP bytes (no media flows here; the
// readingLoop goroutines started per uplink block on ReadRTP until test end —
// harmless. Packet fanout is covered by TestPublisherUplink_FanoutAndCloning
// and the L3 E2E soak).

import (
	"strings"
	"testing"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/pion/webrtc/v4"
)

type seenTrack struct {
	id       string
	streamID string
	kind     webrtc.RTPCodecType
}

// injectSimulcast rewrites a locally-generated offer into Chrome shape: a
// rid + simulcast block on the video m-section. Production browsers generate
// this natively; Pion's sender side does not (verified by spike). Only the
// copy handed to the SFU is rewritten — never the sender's own local
// description (Pion rejects hand-edited local SDP).
func injectSimulcast(sdp string) string {
	return injectVideoSimulcast(sdp)
}

func injectVideoSimulcast(sdp string) string {
	lines := strings.Split(sdp, "\r\n")
	var out []string
	inVideo := false
	injected := false
	for _, l := range lines {
		if strings.HasPrefix(l, "m=") {
			inVideo = strings.HasPrefix(l, "m=video")
		}
		out = append(out, l)
		if inVideo && !injected && strings.HasPrefix(l, "a=mid:") {
			out = append(out,
				"a=rid:f send",
				"a=rid:h send",
				"a=rid:q send",
				"a=simulcast:send f;h;q",
			)
			injected = true
		}
	}
	return strings.Join(out, "\r\n")
}

// nextOffer reads exactly one queued renegotiation offer.
func nextOffer(t *testing.T, ch chan webrtc.SessionDescription) webrtc.SessionDescription {
	t.Helper()
	select {
	case o := <-ch:
		return o
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for renegotiation offer")
		return webrtc.SessionDescription{}
	}
}

// latestOffer drains a renegotiation channel and returns the newest offer.
// SFU offers are full-state, so latest wins.
func latestOffer(t *testing.T, ch chan webrtc.SessionDescription) webrtc.SessionDescription {
	t.Helper()
	select {
	case o := <-ch:
		latest := o
		for {
			select {
			case o := <-ch:
				latest = o
			case <-time.After(200 * time.Millisecond):
				return latest
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for renegotiation offer")
		return webrtc.SessionDescription{}
	}
}

// completeOffer answers an SFU-side offer with the given client peer and feeds
// the answer back.
func completeOffer(t *testing.T, sfuPeer, clientPeer *peer.Peer, offer webrtc.SessionDescription) {
	t.Helper()
	answer, err := clientPeer.HandleOffer(offer.SDP)
	if err != nil {
		t.Fatalf("client failed to handle offer: %v", err)
	}
	if err := sfuPeer.HandleAnswer(answer.SDP); err != nil {
		t.Fatalf("sfu peer failed to handle answer: %v", err)
	}
}

// collectReceiverTracks returns the currently negotiated downlink tracks on a
// client peer.
func collectReceiverTracks(clientPeer *peer.Peer) map[string]seenTrack {
	byID := make(map[string]seenTrack)
	for _, rx := range clientPeer.PC.GetReceivers() {
		for _, track := range rx.Tracks() {
			byID[track.ID()] = seenTrack{id: track.ID(), streamID: track.StreamID(), kind: track.Kind()}
		}
	}
	return byID
}

func TestRouter_PublishSubscribeCamScreenChain(t *testing.T) {
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatalf("failed to create api: %v", err)
	}
	newPeer := func(userID, sessionID string) *peer.Peer {
		t.Helper()
		p, err := peer.NewPeer(api, webrtc.Configuration{}, userID, sessionID, "chan_l2", "guild_l2")
		if err != nil {
			t.Fatalf("failed to create peer %s: %v", userID, err)
		}
		return p
	}

	// SFU-side endpoints + client-side endpoints.
	sfuAlice := newPeer("alice", "sess_sfu_alice")
	defer sfuAlice.Close()
	sfuBob := newPeer("bob", "sess_sfu_bob")
	defer sfuBob.Close()
	clientAlice := newPeer("alice", "sess_cli_alice")
	defer clientAlice.Close()
	clientBob := newPeer("bob", "sess_cli_bob")
	defer clientBob.Close()

	r := NewRouter("chan_l2")
	defer r.Close()

	bobReneg := make(chan webrtc.SessionDescription, 8)
	r.AddPeer(sfuAlice, nil)
	r.AddPeer(sfuBob, func(offer webrtc.SessionDescription) { bobReneg <- offer })

	// Chrome-simulcast shape: Alice publishes audio + ONE video track with
	// 3 send encodings (f/h/q). Kind is declared out-of-band afterwards
	// (SetVideoKind, as the video:true/screen:true signals do).
	micTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "browser-mic-xyz", "browser-mic-stream",
	)
	if err != nil {
		t.Fatalf("failed to create mic track: %v", err)
	}
	if _, err := clientAlice.AddTrack(micTrack); err != nil {
		t.Fatalf("failed to add mic uplink: %v", err)
	}
	camTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "browser-cam-xyz", "browser-stream-xyz",
	)
	if err != nil {
		t.Fatalf("failed to create cam track: %v", err)
	}
	if _, err := clientAlice.PC.AddTransceiverFromTrack(camTrack, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionSendonly,
		SendEncodings: []webrtc.RTPEncodingParameters{
			{RTPCodingParameters: webrtc.RTPCodingParameters{RID: "f"}},
			{RTPCodingParameters: webrtc.RTPCodingParameters{RID: "h"}},
			{RTPCodingParameters: webrtc.RTPCodingParameters{RID: "q"}},
		},
	}); err != nil {
		t.Fatalf("failed to add simulcast uplink: %v", err)
	}

	offer, err := clientAlice.CreateOffer()
	if err != nil {
		t.Fatalf("clientAlice failed to create offer: %v", err)
	}
	// peer.CreateOffer already set the local description; hand the SFU a
	// Chrome-shaped copy (rid + simulcast block on the video m-section).
	// The sender's own local description stays pristine (Pion rejects
	// hand-edited local SDP).
	chromeSDP := injectVideoSimulcast(offer.SDP)
	answer, err := sfuAlice.HandleOffer(chromeSDP)
	if err != nil {
		t.Fatalf("sfuAlice failed to handle offer: %v", err)
	}
	if err := clientAlice.HandleAnswer(answer.SDP); err != nil {
		t.Fatalf("clientAlice failed to handle answer: %v", err)
	}

	// Ingest one negotiated uplink at a time, completing each downstream
	// offer before the next (mirrors production, where answers arrive between
	// OnTrack events; batching without answering would correctly postpone
	// offers 2+ on signaling glare).
	type incoming struct {
		track *webrtc.TrackRemote
		rx    *webrtc.RTPReceiver
	}
	var incomingTracks []incoming
	for _, rx := range sfuAlice.PC.GetReceivers() {
		for _, track := range rx.Tracks() {
			incomingTracks = append(incomingTracks, incoming{track: track, rx: rx})
		}
	}
	if len(incomingTracks) != 4 {
		t.Fatalf("expected 4 negotiated uplinks (audio + f/h/q), got %d", len(incomingTracks))
	}
	for _, in := range incomingTracks {
		r.AddPublisher("alice", in.track, in.rx)
		// Only the audio uplink fans out: video layers are dormant until
		// their kind is declared, so at most one downstream offer fires here.
		select {
		case o := <-bobReneg:
			completeOffer(t, sfuBob, clientBob, o)
		case <-time.After(500 * time.Millisecond):
		}
	}

	// Audio + 3 layers registered under distinct RID keys (no collision);
	// bob holds audio only (video dormant).
	r.mu.RLock()
	if len(r.publishers) != 4 {
		r.mu.RUnlock()
		t.Fatalf("expected 4 publisher uplinks, got %d", len(r.publishers))
	}
	for _, key := range []string{"alice:video:f", "alice:video:h", "alice:video:q"} {
		if _, ok := r.publishers[key]; !ok {
			r.mu.RUnlock()
			t.Fatalf("missing layer uplink %s", key)
		}
	}
	r.mu.RUnlock()
	if layers := r.Layers("alice"); len(layers) != 3 {
		t.Fatalf("Layers() = %+v, want 3 layers", layers)
	} else if layers[0].RID != "f" || layers[1].RID != "h" || layers[2].RID != "q" {
		t.Fatalf("Layers() order = %+v, want f/h/q", layers)
	}
	byID := collectReceiverTracks(clientBob)
	if len(byID) != 1 {
		t.Fatalf("expected audio-only downlinks before kind declaration, got %+v", byID)
	}

	// Declare camera (video:true): bob gains the stable f-layer cam downlink.
	r.SetVideoKind("alice", VideoKindCamera)
	completeOffer(t, sfuBob, clientBob, nextOffer(t, bobReneg))
	byID = collectReceiverTracks(clientBob)
	if len(byID) != 2 {
		t.Fatalf("expected 2 downlink tracks after camera declaration, got %+v", byID)
	}
	if tr, ok := byID["kith-track-alice-video"]; !ok || tr.streamID != "kith-stream-alice" {
		t.Errorf("bob missing cam downlink (kith-track-alice-video/kith-stream-alice), got %+v", byID)
	}

	// Switch to screen (screen:true): f uplink relabeled, cam downlink
	// replaced by the screen downlink in the next offer. h/q stay
	// ingested-but-dormant throughout.
	r.SetVideoKind("alice", VideoKindScreen)
	screenOffer := latestOffer(t, bobReneg)
	completeOffer(t, sfuBob, clientBob, screenOffer)
	if !strings.Contains(screenOffer.SDP, "kith-track-alice-screen") {
		t.Errorf("screen m-section missing after kind switch")
	}
	if strings.Contains(screenOffer.SDP, "kith-track-alice-video") {
		t.Errorf("cam m-section still present after kind switch to screen")
	}
	byID = collectReceiverTracks(clientBob)
	if len(byID) != 2 {
		t.Fatalf("expected 2 downlink tracks after screen switch, got %+v", byID)
	}
	if tr, ok := byID["kith-track-alice-screen"]; !ok || tr.streamID != "kith-screen-alice" {
		t.Errorf("bob missing screen downlink (kith-track-alice-screen/kith-screen-alice), got %+v", byID)
	}
	r.mu.RLock()
	for key, pub := range r.publishers {
		if pub.PublisherID == "alice" && pub.Kind == webrtc.RTPCodecTypeVideo && layerOfKey(key) == LayerFull && !pub.IsScreen {
			r.mu.RUnlock()
			t.Errorf("f uplink still cam-labeled after switch: %s", key)
		}
	}
	if len(r.publishers) != 4 {
		r.mu.RUnlock()
		t.Fatalf("h/q layer uplinks lost on kind switch (want 4 publishers)")
	}
	r.mu.RUnlock()

	// Kind none (video:false): f downlinks torn down, all 4 uplink objects
	// retained for stream reuse.
	r.SetVideoKind("alice", VideoKindNone)
	noneOffer := latestOffer(t, bobReneg)
	completeOffer(t, sfuBob, clientBob, noneOffer)
	byID = collectReceiverTracks(clientBob)
	if len(byID) != 1 {
		t.Fatalf("expected audio-only downlinks after kind none, got %+v", byID)
	}
	r.mu.RLock()
	if len(r.publishers) != 4 {
		r.mu.RUnlock()
		t.Fatalf("uplink objects dropped on kind none (stream reuse broken)")
	}
	r.mu.RUnlock()

	// Re-declare camera: downlinks rebuilt on the retained uplink.
	r.SetVideoKind("alice", VideoKindCamera)
	completeOffer(t, sfuBob, clientBob, nextOffer(t, bobReneg))
	byID = collectReceiverTracks(clientBob)
	if tr, ok := byID["kith-track-alice-video"]; !ok || tr.streamID != "kith-stream-alice" {
		t.Errorf("bob missing rebuilt cam downlink, got %+v", byID)
	}

	// G: late joiner Carol subscribes mid cam-share → audio + cam only.
	sfuCarol := newPeer("carol", "sess_sfu_carol")
	defer sfuCarol.Close()
	clientCarol := newPeer("carol", "sess_cli_carol")
	defer clientCarol.Close()
	carolReneg := make(chan webrtc.SessionDescription, 8)
	r.AddPeer(sfuCarol, func(o webrtc.SessionDescription) { carolReneg <- o })
	r.SubscribeToExistingPublishers("carol")
	completeOffer(t, sfuCarol, clientCarol, latestOffer(t, carolReneg))
	carolTracks := collectReceiverTracks(clientCarol)
	if len(carolTracks) != 2 {
		t.Fatalf("expected 2 downlink tracks for late joiner, got %+v", carolTracks)
	}
	if _, ok := carolTracks["kith-track-alice-video"]; !ok {
		t.Errorf("late joiner missing cam downlink: %+v", carolTracks)
	}
}
