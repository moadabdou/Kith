package room

import (
	"sync"
	"testing"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/pion/webrtc/v4"
)

func createTestPeer(t *testing.T, userID, channelID string) *peer.Peer {
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatalf("failed to create API: %v", err)
	}

	p, err := peer.NewPeer(api, webrtc.Configuration{}, userID, "sess-1", channelID)
	if err != nil {
		t.Fatalf("failed to create peer: %v", err)
	}
	return p
}

func TestRoomLifecycle(t *testing.T) {
	var emptyCalled bool
	var mu sync.Mutex

	r := NewRoom("chan_test_1", func(roomID string) {
		mu.Lock()
		emptyCalled = true
		mu.Unlock()
	})
	defer r.Close()

	p1 := createTestPeer(t, "user_1", "chan_test_1")
	p2 := createTestPeer(t, "user_2", "chan_test_1")

	var p2ReceivedJoin bool
	var p2Mu sync.Mutex

	sender2 := func(targetUID, msgType string, payload interface{}) {
		if msgType == "peer_joined" {
			p2Mu.Lock()
			p2ReceivedJoin = true
			p2Mu.Unlock()
		}
	}

	// Join p2 first
	if err := r.Join(p2, sender2); err != nil {
		t.Fatalf("failed to join p2: %v", err)
	}

	// Join p1
	if err := r.Join(p1, nil); err != nil {
		t.Fatalf("failed to join p1: %v", err)
	}

	// Verify peers in room
	peers, err := r.GetPeers()
	if err != nil {
		t.Fatalf("failed to get peers: %v", err)
	}
	if len(peers) != 2 {
		t.Errorf("expected 2 peers, got %d", len(peers))
	}

	// Verify p2 received peer_joined event
	time.Sleep(50 * time.Millisecond)
	p2Mu.Lock()
	if !p2ReceivedJoin {
		t.Errorf("expected p2 to receive peer_joined event")
	}
	p2Mu.Unlock()

	// Leave p1
	if err := r.Leave("user_1"); err != nil {
		t.Fatalf("failed to leave p1: %v", err)
	}

	peers, _ = r.GetPeers()
	if len(peers) != 1 {
		t.Errorf("expected 1 peer remaining, got %d", len(peers))
	}

	// Leave p2 -> room becomes empty
	if err := r.Leave("user_2"); err != nil {
		t.Fatalf("failed to leave p2: %v", err)
	}

	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	if !emptyCalled {
		t.Errorf("expected onEmpty callback to be called when all peers left")
	}
	mu.Unlock()
}

func TestManager(t *testing.T) {
	m := NewManager()
	defer m.Close()

	r1 := m.GetOrCreate("chan_a")
	if r1 == nil {
		t.Fatal("expected room actor")
	}

	r2 := m.GetOrCreate("chan_a")
	if r1 != r2 {
		t.Errorf("expected same room instance for chan_a")
	}

	if m.Count() != 1 {
		t.Errorf("expected count 1, got %d", m.Count())
	}

	m.Remove("chan_a")
	if m.Count() != 0 {
		t.Errorf("expected count 0 after removal, got %d", m.Count())
	}
}
