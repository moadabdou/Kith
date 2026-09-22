package router

import (
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// keyframeRTP builds synthetic VP8 RTP packets: first packet starts a
// keyframe (S=1, P=0), rest continue it; marker closes the frame.
func keyframeRTP(t *testing.T, seqStart uint16, n int) []*rtp.Packet {
	t.Helper()
	var out []*rtp.Packet
	for i := 0; i < n; i++ {
		var payload []byte
		if i == 0 {
			payload = []byte{0x10, 0x00, 0x9d, 0x01, 0xAA, 0xBB} // S=1,P=0 keyframe
		} else {
			payload = []byte{0x00, 0xCC, 0xDD} // continuation
		}
		out = append(out, &rtp.Packet{
			Header:  rtp.Header{SequenceNumber: seqStart + uint16(i), Timestamp: 9000, Marker: i == n-1},
			Payload: payload,
		})
	}
	return out
}

func interframeRTP(seqStart uint16) *rtp.Packet {
	return &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: seqStart, Timestamp: 9030, Marker: true},
		Payload: []byte{0x10, 0x01, 0x9d, 0x01, 0xEE}, // S=1,P=1 interframe
	}
}

func TestKeyframeCache_CollectAndReplay(t *testing.T) {
	up := NewPublisherUplink("pub_kf", nil, nil)
	defer up.Close()
	up.Kind = webrtc.RTPCodecTypeVideo
	up.CodecCap = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}

	// Feed a 3-packet keyframe through the ingest path.
	for _, pkt := range keyframeRTP(t, 1000, 3) {
		up.observeKeyframe(pkt)
	}
	cached := up.cachedKeyframe()
	if len(cached) != 3 {
		t.Fatalf("cached = %d packets, want 3", len(cached))
	}
	// Clones, not aliases: mutating the return must not corrupt the cache.
	cached[0].Header.SequenceNumber = 9999
	if again := up.cachedKeyframe(); again[0].Header.SequenceNumber == 9999 {
		t.Fatalf("cachedKeyframe must return clones")
	}

	// A later interframe must not rotate or pollute the cache.
	up.observeKeyframe(interframeRTP(2000))
	if got := up.cachedKeyframe(); len(got) != 3 {
		t.Fatalf("interframe polluted cache: %d packets", len(got))
	}

	// A newer keyframe rotates.
	for _, pkt := range keyframeRTP(t, 3000, 2) {
		up.observeKeyframe(pkt)
	}
	if got := up.cachedKeyframe(); len(got) != 2 || got[0].Header.SequenceNumber != 3000 {
		t.Fatalf("rotation failed: %+v", got)
	}
}

func TestKeyframeCache_PartialStartMissed(t *testing.T) {
	up := NewPublisherUplink("pub_kf_partial", nil, nil)
	defer up.Close()
	up.Kind = webrtc.RTPCodecTypeVideo
	up.CodecCap = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}

	// Joined mid-frame: first packet seen is a continuation — never cache.
	up.observeKeyframe(&rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 50, Marker: true},
		Payload: []byte{0x00, 0xCC},
	})
	if up.cachedKeyframe() != nil {
		t.Fatalf("partial frame must not be cached")
	}
}

func TestKeyframeCache_StaleExpires(t *testing.T) {
	up := NewPublisherUplink("pub_kf_stale", nil, nil)
	defer up.Close()
	up.Kind = webrtc.RTPCodecTypeVideo
	up.CodecCap = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}
	for _, pkt := range keyframeRTP(t, 100, 2) {
		up.observeKeyframe(pkt)
	}
	if up.cachedKeyframe() == nil {
		t.Fatalf("fresh cache must replay")
	}
	up.keyMu.Lock()
	up.keyframeAt = time.Now().Add(-10 * time.Second)
	up.keyMu.Unlock()
	if up.cachedKeyframe() != nil {
		t.Fatalf("stale cache must not replay")
	}
}

func TestKeyframeCache_NonVideoAndUnknownCodec(t *testing.T) {
	audio := NewPublisherUplink("pub_audio", nil, nil)
	defer audio.Close()
	audio.Kind = webrtc.RTPCodecTypeAudio
	audio.observeKeyframe(&rtp.Packet{Header: rtp.Header{Marker: true}, Payload: []byte{0x10, 0x00, 0x9d, 0x01}})
	if audio.cachedKeyframe() != nil {
		t.Fatalf("audio must never cache")
	}

	h264 := NewPublisherUplink("pub_h264", nil, nil)
	defer h264.Close()
	h264.Kind = webrtc.RTPCodecTypeVideo
	h264.CodecCap = webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}
	h264.observeKeyframe(&rtp.Packet{Header: rtp.Header{Marker: true}, Payload: []byte{0x10, 0x00}})
	if h264.cachedKeyframe() != nil {
		t.Fatalf("unimplemented codec must never cache")
	}
}
