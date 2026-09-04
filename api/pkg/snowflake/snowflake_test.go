package snowflake

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func mustNode(t *testing.T, nodeID int64) *Node {
	t.Helper()
	n, err := NewNode(nodeID)
	if err != nil {
		t.Fatalf("NewNode(%d): %v", nodeID, err)
	}
	return n
}

func TestNewNodeRejectsOutOfRange(t *testing.T) {
	for _, id := range []int64{-1, MaxNodeID + 1, 1 << 20} {
		if _, err := NewNode(id); err == nil {
			t.Errorf("NewNode(%d) should fail", id)
		}
	}
	if _, err := NewNode(0); err != nil {
		t.Errorf("NewNode(0) failed: %v", err)
	}
	if _, err := NewNode(MaxNodeID); err != nil {
		t.Errorf("NewNode(MaxNodeID) failed: %v", err)
	}
}

func TestBitLayout(t *testing.T) {
	before := time.Now().UnixMilli()
	n := mustNode(t, 42)
	id, err := n.Generate()
	after := time.Now().UnixMilli()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if id < 0 {
		t.Fatalf("top bit must be unused (id %d is negative)", id)
	}
	ms, nodeID, seq := Parts(id)
	if nodeID != 42 {
		t.Errorf("node = %d, want 42", nodeID)
	}
	if ts := Epoch + ms; ts < before || ts > after {
		t.Errorf("timestamp %d outside [%d, %d]", ts, before, after)
	}
	if seq > MaxSeq {
		t.Errorf("seq %d exceeds 4095", seq)
	}
}

func TestRoundTripParts(t *testing.T) {
	for _, tc := range []struct{ ms, nodeID, seq int64 }{
		{0, 0, 0},
		{1, 1, 1},
		{MaxTimestamp, MaxNodeID, MaxSeq},
	} {
		id := tc.ms<<timeShift | tc.nodeID<<nodeShift | tc.seq
		gotMS, gotNode, gotSeq := Parts(id)
		if gotMS != tc.ms || gotNode != tc.nodeID || gotSeq != tc.seq {
			t.Errorf("round trip (%d,%d,%d) → %d → (%d,%d,%d)",
				tc.ms, tc.nodeID, tc.seq, id, gotMS, gotNode, gotSeq)
		}
	}
}

func TestTimeDecoding(t *testing.T) {
	before := time.Now().UTC().Truncate(time.Millisecond)
	n := mustNode(t, 7)
	id, err := n.Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	after := time.Now().UTC().Add(time.Millisecond)
	got := Time(id)
	if got.Before(before) || got.After(after) {
		t.Errorf("Time(id) = %v, want within [%v, %v]", got, before, after)
	}
}

func TestMonotonicAndUnique(t *testing.T) {
	n := mustNode(t, 1)
	seen := make(map[int64]struct{}, 20000)
	var prev int64
	for i := 0; i < 20000; i++ {
		id, err := n.Generate()
		if err != nil {
			t.Fatalf("Generate #%d: %v", i, err)
		}
		if id <= prev && i > 0 {
			t.Fatalf("id %d not > prev %d at i=%d (ms %d)", id, prev, i, time.Now().UnixMilli())
		}
		prev = id
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate id %d at i=%d", id, i)
		}
		seen[id] = struct{}{}
	}
}

func TestSortableAcrossMs(t *testing.T) {
	n := mustNode(t, 3)
	a, _ := n.Generate()
	time.Sleep(5 * time.Millisecond)
	b, _ := n.Generate()
	time.Sleep(5 * time.Millisecond)
	c, _ := n.Generate()
	if !(a < b && b < c) {
		t.Errorf("IDs not time-sortable: %d < %d < %d failed", a, b, c)
	}
}

func TestRolloverWithinMs(t *testing.T) {
	n := mustNode(t, 0)
	// Force state: current ms, seq = MaxSeq - 1 → next Generate exhausts and rolls to next ms.
	now := time.Now().UnixMilli() - Epoch
	n.state.Store(now<<timeShift | (MaxSeq - 1))

	start := time.Now().UnixMilli()
	id, err := n.Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if id>>timeShift < now {
		t.Fatalf("rollover ID ms = %d, want >= %d", id>>timeShift, now)
	}
	if elapsed := time.Now().UnixMilli() - start; elapsed > 50 {
		t.Logf("rollover took %dms (sleep to next ms is expected)", elapsed)
	}
	// After rollover the next ID continues in the next ms without sleeping.
	if _, err := n.Generate(); err != nil {
		t.Fatalf("Generate after rollover: %v", err)
	}
}

func TestClockMovedBackwards(t *testing.T) {
	n := mustNode(t, 5)
	n.state.Store((time.Now().UnixMilli() - Epoch + 3600_000) << timeShift) // 1h ahead
	if _, err := n.Generate(); err != ErrClockMovedBackwards {
		t.Fatalf("Generate with regressed clock: err = %v, want ErrClockMovedBackwards", err)
	}
}

func TestStringParseRoundTrip(t *testing.T) {
	before := time.Now().UnixMilli()
	n := mustNode(t, 9)
	id, err := n.Generate()
	after := time.Now().UnixMilli()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	ms, _, _ := Parts(id)
	if ts := Epoch + ms; ts < before || ts > after {
		t.Errorf("timestamp %d outside [%d, %d]", ts, before, after)
	}
	got, err := Parse(String(id))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if got != id {
		t.Errorf("Parse(String(%d)) = %d", id, got)
	}
	for _, bad := range []string{"", "abc", "12.5", "-1", "99999999999999999999"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("Parse(%q) should fail", bad)
		}
	}
}

func TestConcurrentUniqueness(t *testing.T) {
	const workers, perWorker = 8, 2000
	// ONE Node shared by all workers: node id = one generator per process,
	// and the CAS loop is what keeps it correct under contention.
	n := mustNode(t, 100)

	var mu sync.Mutex
	seen := make(map[int64]struct{}, workers*perWorker)
	var wg sync.WaitGroup
	errs := make(chan error, workers)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(n *Node, w int) {
			defer wg.Done()
			local := make([]int64, 0, perWorker)
			for j := 0; j < perWorker; j++ {
				id, err := n.Generate()
				if err != nil {
					errs <- fmt.Errorf("worker %d: %w", w, err)
					return
				}
				local = append(local, id)
			}
			mu.Lock()
			for _, id := range local {
				seen[id] = struct{}{}
			}
			mu.Unlock()
		}(n, i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if len(seen) != workers*perWorker {
		t.Fatalf("got %d unique IDs, want %d", len(seen), workers*perWorker)
	}
}

func TestEpochIs2026(t *testing.T) {
	if want := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli(); Epoch != want {
		t.Errorf("Epoch = %d, want %d", Epoch, want)
	}
}
