package room

import (
	"errors"
	"log/slog"
	"sync"

	"github.com/moadabdou/Kith/sfu/internal/bus"
)

var ErrNoSuchRoom = errors.New("room not found")

// Manager coordinates room lifecycles across the SFU.
type Manager struct {
	mu        sync.RWMutex
	rooms     map[string]*Room
	publisher bus.Publisher
}

// NewManager creates a new Room Manager with the given event publisher.
func NewManager(publisher bus.Publisher) *Manager {
	if publisher == nil {
		publisher = &bus.NoopPublisher{}
	}
	return &Manager{
		rooms:     make(map[string]*Room),
		publisher: publisher,
	}
}

// GetOrCreate returns an existing room actor or spawns a new one.
func (m *Manager) GetOrCreate(channelID string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()

	if r, ok := m.rooms[channelID]; ok {
		return r
	}

	r := NewRoom(channelID, m.publisher, func(roomID string) {
		m.Remove(roomID)
	})

	m.rooms[channelID] = r
	slog.Info("Spawned new room actor", "room_id", channelID)
	return r
}

// HasRoom checks if a room is currently active.
func (m *Manager) HasRoom(channelID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.rooms[channelID]
	return ok
}

// Broadcast sends an event to all other peers in a specific room. Returns true if room was found.
func (m *Manager) Broadcast(channelID, sourceUserID string, event Event) bool {
	m.mu.RLock()
	r, ok := m.rooms[channelID]
	m.mu.RUnlock()

	if !ok {
		return false
	}
	r.Broadcast(sourceUserID, event)
	return true
}

// GetPeers queries the list of connected user IDs in a channel.
func (m *Manager) GetPeers(channelID string) ([]string, error) {
	m.mu.RLock()
	r, ok := m.rooms[channelID]
	m.mu.RUnlock()

	if !ok {
		return nil, ErrNoSuchRoom
	}
	return r.GetPeers()
}

// Remove closes and deletes a room from the manager.
func (m *Manager) Remove(channelID string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if r, ok := m.rooms[channelID]; ok {
		r.Close()
		delete(m.rooms, channelID)
		slog.Info("Removed empty room actor", "room_id", channelID)
	}
}

// Count returns the number of active rooms.
func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.rooms)
}

// Close terminates all active room actors.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for id, r := range m.rooms {
		r.Close()
		delete(m.rooms, id)
	}
}
