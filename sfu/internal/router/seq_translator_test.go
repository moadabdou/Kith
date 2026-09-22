package router

import (
	"testing"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/metrics"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// offsetLookup builds a lookup where downlink seq = uplink seq + offset
// (mirrors the monotonic rewrite over a contiguous range).
func offsetLookup(offset uint16, live func(down uint16) bool) func(uint16) (uint16, bool) {
	return func(down uint16) (uint16, bool) {
		if live != nil && !live(down) {
			return 0, false
		}
		return down - offset, true
	}
}

func TestSeqTranslator_ReverseRoundTrip(t *testing.T) {
	var tr seqTranslator
	// note() populates both directions atomically-enough for readers.
	for i := uint16(0); i < 100; i++ {
		tr.note(1000+i, 5000+i)
	}
	for i := uint16(0); i < 100; i++ {
		if u, ok := tr.lookup(1000 + i); !ok || u != 5000+i {
			t.Fatalf("forward lookup(%d) = %d,%v, want %d,true", 1000+i, u, ok, 5000+i)
		}
		if d, ok := tr.lookupDown(5000 + i); !ok || d != 1000+i {
			t.Fatalf("reverse lookupDown(%d) = %d,%v, want %d,true", 5000+i, d, ok, 1000+i)
		}
	}
}

func TestSeqTranslator_ReverseAgedOut(t *testing.T) {
	var tr seqTranslator
	tr.note(100, 200)
	// Overwrite the same reverse slot with a colliding uplink seq
	// (same % seqRingSize, different value): old mapping must miss.
	collide := uint16(200 + seqRingSize)
	tr.note(999, collide)
	if _, ok := tr.lookupDown(200); ok {
		t.Fatalf("stale reverse entry must miss after overwrite")
	}
	if d, ok := tr.lookupDown(collide); !ok || d != 999 {
		t.Fatalf("lookupDown(%d) = %d,%v, want 999,true", collide, d, ok)
	}
	// Untouched entries miss on both directions.
	if _, ok := tr.lookupDown(4242); ok {
		t.Fatalf("untouched reverse slot must miss")
	}
	if _, ok := tr.lookup(4242); ok {
		t.Fatalf("untouched forward slot must miss")
	}
}

func TestSeqTranslator_ReverseWraparound(t *testing.T) {
	var tr seqTranslator
	// Uplink seqs near uint16 max: reverse mapping must survive wrap.
	tr.note(10, 65534)
	tr.note(11, 65535)
	tr.note(12, 0)
	tr.note(13, 1)
	for down, up := range map[uint16]uint16{10: 65534, 11: 65535, 12: 0, 13: 1} {
		if d, ok := tr.lookupDown(up); !ok || d != down {
			t.Fatalf("lookupDown(%d) = %d,%v, want %d,true", up, d, ok, down)
		}
	}
}

func TestTranslateNackPairs_BasicRange(t *testing.T) {
	// Viewer lost downlink 100,101,102,103 (base + mask bits 0..2).
	pairs := []rtcp.NackPair{{PacketID: 100, LostPackets: 0b0111}}
	// Downlink = uplink + 7 in this window.
	out := translateNackPairs(pairs, offsetLookup(7, nil))
	if len(out) != 1 {
		t.Fatalf("expected 1 regrouped pair, got %d: %+v", len(out), out)
	}
	if out[0].PacketID != 93 {
		t.Errorf("base = %d, want 93", out[0].PacketID)
	}
	if out[0].LostPackets != 0b0111 {
		t.Errorf("mask = %b, want 111", out[0].LostPackets)
	}
}

func TestTranslateNackPairs_SkipsAgedOut(t *testing.T) {
	// Downlink 50 aged out of the ring; 51,52 live.
	live := func(down uint16) bool { return down != 50 }
	pairs := []rtcp.NackPair{{PacketID: 50, LostPackets: 0b0011}} // 50,51,52
	out := translateNackPairs(pairs, offsetLookup(10, live))
	if len(out) != 1 {
		t.Fatalf("expected 1 pair, got %+v", out)
	}
	// 50 dropped → base becomes 41 with only bit0 (42) set.
	if out[0].PacketID != 41 || out[0].LostPackets != 0b0001 {
		t.Errorf("got base=%d mask=%b, want base=41 mask=1", out[0].PacketID, out[0].LostPackets)
	}
}

func TestTranslateNackPairs_NothingTranslatable(t *testing.T) {
	pairs := []rtcp.NackPair{{PacketID: 9000, LostPackets: 0xFFFF}}
	out := translateNackPairs(pairs, func(uint16) (uint16, bool) { return 0, false })
	if out != nil {
		t.Errorf("expected nil, got %+v", out)
	}
}

func TestTranslateNackPairs_SplitsLongGaps(t *testing.T) {
	// Two distant losses must not merge into one pair.
	pairs := []rtcp.NackPair{
		{PacketID: 100, LostPackets: 0},
		{PacketID: 500, LostPackets: 0},
	}
	out := translateNackPairs(pairs, offsetLookup(0, nil))
	if len(out) != 2 {
		t.Fatalf("expected 2 pairs, got %+v", out)
	}
	if out[0].PacketID != 100 || out[1].PacketID != 500 {
		t.Errorf("bases = %d,%d, want 100,500", out[0].PacketID, out[1].PacketID)
	}
}

func TestTranslateNackPairs_DedupesAcrossPairs(t *testing.T) {
	// Overlapping pairs (retransmitted NACKs) collapse to one entry.
	pairs := []rtcp.NackPair{
		{PacketID: 100, LostPackets: 0b0001}, // 100,101
		{PacketID: 101, LostPackets: 0},      // 101 again
	}
	out := translateNackPairs(pairs, offsetLookup(0, nil))
	if len(out) != 1 {
		t.Fatalf("expected 1 pair, got %+v", out)
	}
	if out[0].PacketID != 100 || out[0].LostPackets != 0b0001 {
		t.Errorf("got base=%d mask=%b, want 100/1", out[0].PacketID, out[0].LostPackets)
	}
}

func TestSeqTranslator_RingRoundTrip(t *testing.T) {
	var tr seqTranslator
	// Fill more than the ring: oldest entries must age out, newest resolve.
	for i := uint16(0); i < seqRingSize+100; i++ {
		tr.note(1000+i, 5000+i)
	}
	if _, ok := tr.lookup(1000); ok {
		t.Errorf("expected seq 1000 to have aged out")
	}
	if u, ok := tr.lookup(1000 + seqRingSize + 99); !ok || u != 5000+seqRingSize+99 {
		t.Errorf("expected newest entry to resolve, got %d,%v", u, ok)
	}
	// Untouched slot never resolves.
	if _, ok := tr.lookup(40000); ok {
		t.Errorf("expected untouched slot to miss")
	}
}

func TestSeqTranslator_OffsetMapping(t *testing.T) {
	// End-to-end shape: forwarding rewrites uplink U as downlink D=U+7,
	// viewer NACKs D, translator recovers U.
	var tr seqTranslator
	for u := uint16(1000); u < 1100; u++ {
		tr.note(u+7, u)
	}
	out := translateNackPairs(
		[]rtcp.NackPair{{PacketID: 1050, LostPackets: 0b0011}}, // down 1050,1051,1052
		tr.lookup,
	)
	if len(out) != 1 || out[0].PacketID != 1043 || out[0].LostPackets != 0b0011 {
		t.Fatalf("got %+v, want base=1043 mask=11", out)
	}
}

func TestSubscriberForwardNack_EndToEnd(t *testing.T) {
	trackLocal, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video-track", "video-stream",
	)
	if err != nil {
		t.Fatalf("failed to create track local: %v", err)
	}

	uplink := NewPublisherUplink("pub_nack", nil, nil)
	uplink.Kind = webrtc.RTPCodecTypeVideo

	forwarded := make(chan []rtcp.Packet, 5)
	uplink.SetRTCPWriter(func(pkts []rtcp.Packet) error {
		forwarded <- pkts
		return nil
	})

	downlink := NewSubscriberDownlink("sub_nack", "pub_nack", trackLocal, nil)
	defer downlink.Close()
	uplink.AddSubscriber(downlink)

	// Simulate forwarding: uplink seqs 700..703 left as downlink 100..103.
	for i := uint16(0); i < 4; i++ {
		downlink.seqTr.note(100+i, 700+i)
	}

	initial := getCounterValue(metrics.RTCPNackForwarded)

	// Viewer reports downlink 101,102 lost (base + bit0).
	downlink.forwardNack(&rtcp.TransportLayerNack{
		SenderSSRC: 111,
		MediaSSRC:  222,
		Nacks:      []rtcp.NackPair{{PacketID: 101, LostPackets: 0b0001}},
	})

	select {
	case pkts := <-forwarded:
		if len(pkts) != 1 {
			t.Fatalf("expected 1 forwarded packet, got %d", len(pkts))
		}
		nack, ok := pkts[0].(*rtcp.TransportLayerNack)
		if !ok {
			t.Fatalf("expected *rtcp.TransportLayerNack, got %T", pkts[0])
		}
		if len(nack.Nacks) != 1 || nack.Nacks[0].PacketID != 701 || nack.Nacks[0].LostPackets != 0b0001 {
			t.Errorf("translated NACK = %+v, want base=701 mask=1", nack.Nacks)
		}
		if nack.MediaSSRC != 222 {
			t.Errorf("MediaSSRC = %d, want passthrough 222 (nil-track uplink skips rewrite)", nack.MediaSSRC)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timed out waiting for NACK forwarding")
	}

	if got := getCounterValue(metrics.RTCPNackForwarded); got <= initial {
		t.Errorf("expected RTCPNackForwarded to increase")
	}

	// Fully aged-out NACK: dropped silently, nothing forwarded, no metric.
	downlink.forwardNack(&rtcp.TransportLayerNack{
		SenderSSRC: 111,
		MediaSSRC:  222,
		Nacks:      []rtcp.NackPair{{PacketID: 9000, LostPackets: 0xFFFF}},
	})
	select {
	case pkts := <-forwarded:
		t.Fatalf("expected no forwarding for aged-out NACK, got %+v", pkts)
	case <-time.After(200 * time.Millisecond):
	}
}
