package router

import (
	"testing"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestIsRTXTrack(t *testing.T) {
	if IsRTXTrack(nil) {
		t.Fatalf("nil track must not classify as RTX")
	}
}

func TestRepairForDownlink_PreservesHeader(t *testing.T) {
	orig := &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 4100, Timestamp: 90000, SSRC: 0xdeadbeef, Marker: true},
		Payload: []byte{0x01, 0x02, 0x03},
	}
	out := repairForDownlink(orig, 77)
	if out.Header.SequenceNumber != 77 {
		t.Fatalf("seq = %d, want gap seq 77", out.Header.SequenceNumber)
	}
	if out.Header.Timestamp != 90000 || out.Header.SSRC != 0xdeadbeef || !out.Header.Marker {
		t.Fatalf("timestamp/SSRC/marker must pass through: %+v", out.Header)
	}
	if len(out.Payload) != 3 || out.Payload[0] != 0x01 {
		t.Fatalf("payload must pass through untouched")
	}
	// Input untouched (clone, not alias).
	if orig.Header.SequenceNumber != 4100 {
		t.Fatalf("input packet mutated: seq = %d", orig.Header.SequenceNumber)
	}
}

// TestDeliverRepair_TargetedDelivery replays the loss scenario end to end at
// the unit level: two subscribers share one uplink; only the one whose
// translator maps the repaired uplink seq gets a gap-seq write (observed via
// metrics, since unbound TrackLocal writes are silent no-ops).
func TestDeliverRepair_TargetedDelivery(t *testing.T) {
	up := NewPublisherUplink("pub_rtx", nil, nil)
	defer up.Close()
	up.Kind = webrtc.RTPCodecTypeVideo

	mkDownlink := func(subID string) *SubscriberDownlink {
		trackLocal, err := webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video-track-"+subID, "video-stream",
		)
		if err != nil {
			t.Fatalf("failed to create track local: %v", err)
		}
		d := NewSubscriberDownlink(subID, "pub_rtx", trackLocal, nil)
		defer d.Close()
		up.AddSubscriber(d)
		return d
	}
	// Bob missed uplink seq 500 (mapped to his downlink seq 60); carol has
	// no mapping for it (never missed / aged out).
	bob := mkDownlink("bob")
	bob.seqTr.note(60, 500)
	carol := mkDownlink("carol")
	carol.seqTr.note(61, 501)

	beforeFwd := getCounterValue(metrics.RTXForwarded)
	beforeUnmatched := getCounterValue(metrics.RTXUnmatched)

	up.deliverRepair(&rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 500, Timestamp: 424242, SSRC: 0x1111},
		Payload: []byte{0xAA},
	})

	if got := getCounterValue(metrics.RTXForwarded) - beforeFwd; got != 1 {
		t.Fatalf("forwarded delta = %v, want 1 (bob only)", got)
	}
	if got := getCounterValue(metrics.RTXUnmatched) - beforeUnmatched; got != 1 {
		t.Fatalf("unmatched delta = %v, want 1 (carol)", got)
	}
	_ = bob
	_ = carol
}

// TestDeliverRepair_NoMappingDropsSilently covers a repair for an uplink seq
// nobody forwarded (e.g. saturated-drop): nothing is written anywhere.
func TestDeliverRepair_NoMappingDropsSilently(t *testing.T) {
	up := NewPublisherUplink("pub_rtx_nomap", nil, nil)
	defer up.Close()
	up.Kind = webrtc.RTPCodecTypeVideo

	trackLocal, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video-track", "video-stream",
	)
	if err != nil {
		t.Fatalf("failed to create track local: %v", err)
	}
	d := NewSubscriberDownlink("solo", "pub_rtx_nomap", trackLocal, nil)
	defer d.Close()
	up.AddSubscriber(d)

	beforeFwd := getCounterValue(metrics.RTXForwarded)
	beforeUnmatched := getCounterValue(metrics.RTXUnmatched)

	up.deliverRepair(&rtp.Packet{
		Header:  rtp.Header{SequenceNumber: 9999, Timestamp: 1, SSRC: 0x2222},
		Payload: []byte{0xBB},
	})

	if got := getCounterValue(metrics.RTXForwarded) - beforeFwd; got != 0 {
		t.Fatalf("forwarded delta = %v, want 0", got)
	}
	if got := getCounterValue(metrics.RTXUnmatched) - beforeUnmatched; got != 1 {
		t.Fatalf("unmatched delta = %v, want 1", got)
	}
}
