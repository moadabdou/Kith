package router

import (
	"strings"

	"github.com/pion/rtp/codecs"
)

// KeyframeDetector reports whether an RTP payload is the start of a video
// keyframe (full picture). Used to cache the latest keyframe per uplink for
// instant rendering of late joiners (#81) instead of waiting out the
// natural keyframe cadence (punishing on static screen content).
type KeyframeDetector interface {
	// IsKeyframeStart reports whether payload begins a keyframe. The payload
	// must be the RTP payload (after the fixed RTP header + extensions) of
	// the first packet of a frame partition (S bit set for VP8); callers
	// decide partition tracking.
	IsKeyframeStart(payload []byte) bool
	// Codec returns the MIME type this detector handles.
	Codec() string
}

// VP8KeyframeDetector detects VP8 keyframes (RFC 7741 §4.2): the payload
// descriptor's S bit marks partition 0, and the frame tag's P bit (LSB of
// the first payload byte) is 0 for keyframes, 1 for interframes.
type VP8KeyframeDetector struct{}

func (VP8KeyframeDetector) Codec() string { return "video/VP8" }

func (VP8KeyframeDetector) IsKeyframeStart(payload []byte) bool {
	if len(payload) < 1 {
		return false
	}
	var pkt codecs.VP8Packet
	if _, err := pkt.Unmarshal(payload); err != nil {
		return false
	}
	if pkt.S != 1 || pkt.PID != 0 {
		return false
	}
	frame := pkt.Payload
	if len(frame) < 3 {
		return false
	}
	// Frame tag P bit: bit 0 of byte 0. 0 = key frame, 1 = interframe.
	return frame[0]&0x01 == 0
}

// DetectorFor returns the keyframe detector for a codec MIME type, or nil
// when no detector exists yet (H.264 lands here next; unknown codecs never
// match so caching stays safely disabled for them).
func DetectorFor(mimeType string) KeyframeDetector {
	if strings.EqualFold(strings.TrimSpace(mimeType), "video/VP8") {
		return VP8KeyframeDetector{}
	}
	return nil
}
