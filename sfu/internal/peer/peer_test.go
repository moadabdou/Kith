package peer

import (
	"strings"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

func TestCreateAPI_VideoCodecsAndFeedback(t *testing.T) {
	api, err := CreateAPI(Config{})
	if err != nil {
		t.Fatalf("failed to create API: %v", err)
	}

	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("failed to create PeerConnection: %v", err)
	}
	defer pc.Close()

	// Add a VP8 video track
	trackVP8, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		"video-vp8",
		"stream-video",
	)
	if err != nil {
		t.Fatalf("failed to create VP8 track: %v", err)
	}

	_, err = pc.AddTrack(trackVP8)
	if err != nil {
		t.Fatalf("failed to add VP8 track: %v", err)
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("failed to create offer: %v", err)
	}

	sdp := offer.SDP

	// Verify VP8 codec is present in SDP
	if !strings.Contains(sdp, "VP8/90000") {
		t.Errorf("expected offer SDP to contain VP8/90000, got:\n%s", sdp)
	}

	// Verify required RTCP feedback mechanisms are present
	requiredFeedback := []string{
		"rtcp-fb:96 nack",
		"rtcp-fb:96 nack pli",
		"rtcp-fb:96 goog-remb",
		"rtcp-fb:96 ccm fir",
	}

	for _, fb := range requiredFeedback {
		if !strings.Contains(sdp, fb) {
			t.Errorf("expected offer SDP to contain feedback %q", fb)
		}
	}
}

func TestPeer_WriteRTCP(t *testing.T) {
	api, err := CreateAPI(Config{})
	if err != nil {
		t.Fatalf("failed to create API: %v", err)
	}

	p1, err := NewPeer(api, webrtc.Configuration{}, "user_1", "sess_1", "chan_test", "guild_test")
	if err != nil {
		t.Fatalf("failed to create p1: %v", err)
	}
	defer p1.Close()

	p2, err := NewPeer(api, webrtc.Configuration{}, "user_2", "sess_2", "chan_test", "guild_test")
	if err != nil {
		t.Fatalf("failed to create p2: %v", err)
	}
	defer p2.Close()

	// Exchange candidates
	go func() {
		for c := range p1.Candidates {
			_ = p2.AddCandidate(c)
		}
	}()
	go func() {
		for c := range p2.Candidates {
			_ = p1.AddCandidate(c)
		}
	}()

	// Add track to p1 to initiate media and DTLS handshake
	track, _ := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "stream",
	)
	_, _ = p1.AddTrack(track)

	offer, err := p1.CreateOffer()
	if err != nil {
		t.Fatalf("failed to create offer: %v", err)
	}

	answer, err := p2.HandleOffer(offer.SDP)
	if err != nil {
		t.Fatalf("failed to handle offer on p2: %v", err)
	}

	if err := p1.HandleAnswer(answer.SDP); err != nil {
		t.Fatalf("failed to handle answer on p1: %v", err)
	}

	// Wait for DTLS to establish or connection to become connected
	connected := make(chan struct{})
	p1.PC.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			select {
			case <-connected:
			default:
				close(connected)
			}
		}
	})

	select {
	case <-connected:
	case <-time.After(2 * time.Second):
		// Even if ICE gathering takes a moment locally, test WriteRTCP
	}

	pli := &rtcp.PictureLossIndication{
		MediaSSRC: 12345,
	}

	// When peer is closed, WriteRTCP must return error
	_ = p1.Close()
	err = p1.WriteRTCP([]rtcp.Packet{pli})
	if err == nil {
		t.Errorf("expected error writing RTCP to closed peer, got nil")
	}
}
