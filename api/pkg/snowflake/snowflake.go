// Package snowflake generates 64-bit, time-sortable, unique IDs.
//
// Layout (plan/02-rest-api.md §4):
//
//	1 unused bit | 41 bits ms since epoch | 10 bits node id | 12 bits sequence
//
// Custom epoch 2026-01-01T00:00:00Z → IDs valid until ~2093.
// The same layout must be kept in Elixir's gateway port (Phase 1).
package snowflake

import (
	"errors"
	"strconv"
	"sync/atomic"
	"time"
)

const (
	// Epoch is the custom epoch in Unix milliseconds (2026-01-01T00:00:00Z).
	Epoch int64 = 1767225600000

	NodeBits  = 10
	SeqBits   = 12
	MaxNodeID = int64(1)<<NodeBits - 1 // 1023
	MaxSeq    = int64(1)<<SeqBits - 1  // 4095

	nodeShift = SeqBits
	timeShift = NodeBits + SeqBits

	// MaxTimestamp is the largest storable ms offset (~year 2093).
	MaxTimestamp int64 = 1<<41 - 1
)

// ErrClockMovedBackwards is returned when the system clock reads earlier
// than the last ID's timestamp.
var ErrClockMovedBackwards = errors.New("snowflake: clock moved backwards")

// Node generates snowflake IDs for one node id (0–1023).
type Node struct {
	nodeID int64
	state  atomic.Int64 // packed: timestamp<<20 | sequence
	now    func() time.Time
}

// NewNode returns a generator for nodeID. It panics if nodeID is out of
// range — node id is config, not runtime data (fail fast at startup).
func NewNode(nodeID int64) (*Node, error) {
	if nodeID < 0 || nodeID > MaxNodeID {
		return nil, errors.New("snowflake: node id must be in [0, 1023]")
	}
	return &Node{nodeID: nodeID}, nil
}

// Generate returns a new unique ID.
func (n *Node) Generate() (int64, error) {
	for {
		state := n.state.Load()
		now := time.Now().UnixMilli() - Epoch
		last := state >> (NodeBits + SeqBits)
		seq := state & MaxSeq

		switch {
		case now > last:
			seq = 0
		case now == last:
			if seq == MaxSeq {
				// Exhausted 4096 IDs this ms — wait for the next ms.
				next := last + 1
				n.state.Store(next<<timeShift | 0)
				sleepUntil(next)
				continue
			}
			seq++
		default: // now < last
			return 0, ErrClockMovedBackwards
		}

		packed := now<<timeShift | seq
		if n.state.CompareAndSwap(state, packed) {
			return now<<timeShift | n.nodeID<<nodeShift | seq, nil
		}
		// CAS failed: another goroutine won; retry.
	}
}

// Parts decodes an ID into (timestamp offset ms, node id, sequence).
func Parts(id int64) (ms int64, nodeID int64, seq int64) {
	ms = id >> timeShift
	nodeID = id >> nodeShift & MaxNodeID
	seq = id & MaxSeq
	return
}

// Time returns the creation time of an ID.
func Time(id int64) time.Time {
	ms, _, _ := Parts(id)
	return time.UnixMilli(Epoch + ms).UTC()
}

// String formats an ID as a base-10 string (Discord's wire format).
func String(id int64) string {
	return strconv.FormatInt(id, 10)
}

// ErrInvalidID is returned by Parse for malformed strings.
var ErrInvalidID = errors.New("snowflake: invalid id string")

// Parse converts a base-10 string back to an ID.
func Parse(s string) (int64, error) {
	id, err := strconv.ParseInt(s, 10, 64)
	if err != nil || id < 0 {
		return 0, ErrInvalidID
	}
	return id, nil
}

func sleepUntil(nextMs int64) {
	target := time.UnixMilli(Epoch + nextMs)
	if d := time.Until(target); d > 0 {
		time.Sleep(d)
	}
}
