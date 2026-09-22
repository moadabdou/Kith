package router

import (
	"sort"
	"sync/atomic"

	"github.com/pion/rtcp"
)

// seqRingSize is the downlink→uplink sequence-number history depth used for
// NACK translation. 2048 entries comfortably cover several video frames at
// 90kHz pacing while staying tiny.
const seqRingSize = 2048

// seqTranslator maps rewritten per-downlink sequence numbers back to the
// publisher uplink sequence numbers. The forwarding loop rewrites seqs (one
// space per subscriber), so a viewer NACK — which references downlink seqs —
// must be translated before it means anything to the publisher.
//
// Lock-free: single atomic slot per entry (high 16 bits: downlink seq,
// low 16 bits: uplink seq). An entry is valid only when the stored downlink
// seq equals the queried one, so wraparound/overwrite can only drop (never
// corrupt) a translation.
type seqTranslator struct {
	slots [seqRingSize]atomic.Uint32
	// rev maps uplink -> downlink (the inverse direction), populated by the
	// same note() call at zero extra hot-path cost. Used by the RTX repair
	// path: a retransmitted packet carries its original uplink seq, and must
	// be written with the exact missing downlink seq to fill the viewer's
	// gap (a fresh seq would arrive as an out-of-window duplicate).
	rev [seqRingSize]atomic.Uint32
}

// note records that uplink sequence up was forwarded as downlink sequence down.
func (t *seqTranslator) note(down, up uint16) {
	t.slots[down%seqRingSize].Store(uint32(down)<<16 | uint32(up))
	t.rev[up%seqRingSize].Store(uint32(up)<<16 | uint32(down))
}

// lookup returns the uplink sequence for a downlink sequence, or false when
// the entry aged out (or was never forwarded, e.g. dropped on saturation).
func (t *seqTranslator) lookup(down uint16) (uint16, bool) {
	v := t.slots[down%seqRingSize].Load()
	if uint16(v>>16) != down {
		return 0, false
	}
	return uint16(v), true
}

// lookupDown returns the downlink sequence for an uplink sequence, or false
// when the entry aged out or that uplink packet was never forwarded on this
// downlink. Same staleness semantics as lookup: overwrite can only drop,
// never corrupt.
func (t *seqTranslator) lookupDown(up uint16) (uint16, bool) {
	v := t.rev[up%seqRingSize].Load()
	if uint16(v>>16) != up {
		return 0, false
	}
	return uint16(v), true
}

// translateNackPairs converts viewer NACK pairs (downlink seq space) into
// publisher NACK pairs (uplink seq space), regrouping consecutive sequences.
// Untranslatable sequences (aged out / never forwarded) are dropped —
// retransmitting what we never sent is impossible. Returns nil when nothing
// survived translation.
func translateNackPairs(pairs []rtcp.NackPair, lookup func(down uint16) (uint16, bool)) []rtcp.NackPair {
	var ups []uint16
	seen := make(map[uint16]bool)
	for _, p := range pairs {
		base := p.PacketID
		candidates := make([]uint16, 0, 17)
		candidates = append(candidates, base)
		for i := uint16(0); i < 16; i++ {
			if p.LostPackets&(1<<i) != 0 {
				candidates = append(candidates, base+1+i)
			}
		}
		for _, d := range candidates {
			if u, ok := lookup(d); ok && !seen[u] {
				seen[u] = true
				ups = append(ups, u)
			}
		}
	}
	if len(ups) == 0 {
		return nil
	}
	sort.Slice(ups, func(i, j int) bool { return ups[i] < ups[j] })

	var out []rtcp.NackPair
	for i := 0; i < len(ups); {
		base := ups[i]
		var mask rtcp.PacketBitmap
		j := i + 1
		for j < len(ups) && ups[j] == ups[j-1]+1 && ups[j]-base <= 16 {
			mask |= 1 << (ups[j] - base - 1)
			j++
		}
		out = append(out, rtcp.NackPair{PacketID: base, LostPackets: mask})
		i = j
	}
	return out
}
