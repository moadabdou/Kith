package router

import (
	"testing"
)

// vp8Payload builds a minimal VP8 RTP payload: 1-byte descriptor (X=0,
// N=0, S=s, PID=0) + 3-byte frame tag with P bit = pbit.
func vp8Payload(s, pbit uint8) []byte {
	desc := (s << 4) & 0x10
	tag0 := pbit & 0x01
	return []byte{desc, tag0, 0x9d, 0x01}
}

func TestVP8Detector_Keyframe(t *testing.T) {
	d := VP8KeyframeDetector{}
	if !d.IsKeyframeStart(vp8Payload(1, 0)) {
		t.Errorf("S=1,P=0 must be a keyframe start")
	}
}

func TestVP8Detector_Interframe(t *testing.T) {
	d := VP8KeyframeDetector{}
	if d.IsKeyframeStart(vp8Payload(1, 1)) {
		t.Errorf("S=1,P=1 (interframe) must not be a keyframe")
	}
}

func TestVP8Detector_NonPartitionStart(t *testing.T) {
	d := VP8KeyframeDetector{}
	// S=0: continuation of a frame, never a keyframe start even with P=0.
	if d.IsKeyframeStart(vp8Payload(0, 0)) {
		t.Errorf("S=0 must not be a keyframe start")
	}
}

func TestVP8Detector_Malformed(t *testing.T) {
	d := VP8KeyframeDetector{}
	for _, p := range [][]byte{nil, {}, {0x10}, {0x10, 0x00}} {
		if d.IsKeyframeStart(p) {
			t.Errorf("payload %v must not be a keyframe", p)
		}
	}
}

func TestVP8Detector_ExtendedDescriptor(t *testing.T) {
	d := VP8KeyframeDetector{}
	// X=1, no extensions (I=L=T=K=0), S=1, then keyframe tag.
	p := []byte{0x80 | 0x10, 0x00, 0x00, 0x9d, 0x01}
	if !d.IsKeyframeStart(p) {
		t.Errorf("extended descriptor with S=1,P=0 must be a keyframe start")
	}
	// Same with PictureID present (I=1, 8-bit PID).
	p = []byte{0x80 | 0x10, 0x80, 0x42, 0x00, 0x9d, 0x01}
	if !d.IsKeyframeStart(p) {
		t.Errorf("extended descriptor with PictureID, S=1,P=0 must be a keyframe start")
	}
}

func TestDetectorFor(t *testing.T) {
	if DetectorFor("video/VP8") == nil {
		t.Errorf("expected VP8 detector")
	}
	if DetectorFor("VIDEO/vp8") == nil {
		t.Errorf("expected case-insensitive VP8 match")
	}
	if DetectorFor("video/H264") != nil {
		t.Errorf("H264 detector not implemented yet; must be nil")
	}
	if DetectorFor("audio/opus") != nil {
		t.Errorf("audio must never match")
	}
	if DetectorFor("") != nil {
		t.Errorf("empty mime must never match")
	}
}
