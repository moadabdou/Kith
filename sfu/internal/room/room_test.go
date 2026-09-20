package room

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/bus"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/pion/webrtc/v4"
)

func createTestPeer(t *testing.T, userID, channelID string) *peer.Peer {
	api, err := peer.CreateAPI(peer.Config{})
	if err != nil {
		t.Fatalf("failed to create API: %v", err)
	}

	p, err := peer.NewPeer(api, webrtc.Configuration{}, userID, "sess-1", channelID, "guild_test_1")
	if err != nil {
		t.Fatalf("failed to create peer: %v", err)
	}
	return p
}

func TestRoomLifecycle(t *testing.T) {
	var emptyCalled bool
	var mu sync.Mutex

	r := NewRoom("chan_test_1", nil, func(roomID string) {
		mu.Lock()
		emptyCalled = true
		mu.Unlock()
	})
	defer r.Close()

	p1 := createTestPeer(t, "user_1", "chan_test_1")
	p2 := createTestPeer(t, "user_2", "chan_test_1")

	var p2ReceivedJoin bool
	var p2ReceivedSpeaking bool
	var p2Mu sync.Mutex

	sender2 := func(targetUID string, ev Event) {
		p2Mu.Lock()
		defer p2Mu.Unlock()
		if ev.Type == "peer_joined" && ev.UserID == "user_1" {
			p2ReceivedJoin = true
		}
		if ev.Type == "speaking" && ev.UserID == "user_1" {
			p2ReceivedSpeaking = true
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

	// Test broadcast
	speaking := true
	r.Broadcast("user_1", Event{
		Type:      "speaking",
		UserID:    "user_1",
		ChannelID: "chan_test_1",
		Speaking:  &speaking,
	})

	time.Sleep(50 * time.Millisecond)
	p2Mu.Lock()
	if !p2ReceivedSpeaking {
		t.Errorf("expected p2 to receive speaking broadcast event")
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
	m := NewManager(nil)
	defer m.Close()

	r1 := m.GetOrCreate("chan_a")
	if r1 == nil {
		t.Fatal("expected room actor")
	}

	r2 := m.GetOrCreate("chan_a")
	if r1 != r2 {
		t.Errorf("expected same room instance for chan_a")
	}

	if !m.HasRoom("chan_a") {
		t.Errorf("expected HasRoom(chan_a) to be true")
	}

	if m.HasRoom("chan_nonexistent") {
		t.Errorf("expected HasRoom(chan_nonexistent) to be false")
	}

	if m.Count() != 1 {
		t.Errorf("expected count 1, got %d", m.Count())
	}

	// Join a peer to chan_a to test Manager.GetPeers and Manager.Broadcast
	var receivedEvent bool
	var mu sync.Mutex
	p := createTestPeer(t, "user_mgr_test", "chan_a")
	err := r1.Join(p, func(targetUID string, ev Event) {
		if ev.Type == "system_announcement" {
			mu.Lock()
			receivedEvent = true
			mu.Unlock()
		}
	})
	if err != nil {
		t.Fatalf("failed to join peer: %v", err)
	}

	peers, err := m.GetPeers("chan_a")
	if err != nil || len(peers) != 1 || peers[0] != "user_mgr_test" {
		t.Errorf("unexpected peers from manager: %v, err: %v", peers, err)
	}

	// Test Manager Broadcast
	broadcastOk := m.Broadcast("chan_a", "system", Event{Type: "system_announcement"})
	if !broadcastOk {
		t.Errorf("expected Broadcast to return true for existing room")
	}

	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	if !receivedEvent {
		t.Errorf("expected peer to receive announcement from manager broadcast")
	}
	mu.Unlock()

	m.Remove("chan_a")
	if m.Count() != 0 {
		t.Errorf("expected count 0 after removal, got %d", m.Count())
	}
}

type mockPublisher struct {
	mu     sync.Mutex
	events []bus.Event
}

func (m *mockPublisher) Publish(ctx context.Context, e bus.Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, e)
	return nil
}

func (m *mockPublisher) Close() error {
	return nil
}

func TestRoomEventBusPublishing(t *testing.T) {
	mockPub := &mockPublisher{}
	r := NewRoom("chan_bus_1", mockPub, nil)
	defer r.Close()

	p := createTestPeer(t, "user_bus_1", "chan_bus_1")
	p.GuildID = "guild_test_bus"

	// Join peer
	if err := r.Join(p, nil); err != nil {
		t.Fatalf("failed to join peer: %v", err)
	}

	// Give goroutine time to publish
	time.Sleep(50 * time.Millisecond)

	mockPub.mu.Lock()
	if len(mockPub.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(mockPub.events))
	}
	ev1 := mockPub.events[0]
	mockPub.mu.Unlock()

	if ev1.Type != "voice.peer_joined" {
		t.Errorf("expected voice.peer_joined, got %s", ev1.Type)
	}
	if ev1.GuildID != "guild_test_bus" {
		t.Errorf("expected guild_test_bus, got %s", ev1.GuildID)
	}

	// Leave peer
	if err := r.Leave("user_bus_1"); err != nil {
		t.Fatalf("failed to leave peer: %v", err)
	}

	time.Sleep(50 * time.Millisecond)

	mockPub.mu.Lock()
	if len(mockPub.events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(mockPub.events))
	}
	ev2 := mockPub.events[1]
	mockPub.mu.Unlock()

	if ev2.Type != "voice.peer_left" {
		t.Errorf("expected voice.peer_left, got %s", ev2.Type)
	}
	if ev2.GuildID != "guild_test_bus" {
		t.Errorf("expected guild_test_bus, got %s", ev2.GuildID)
	}
}
