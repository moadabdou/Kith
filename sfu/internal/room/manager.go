package room

import (
	"log/slog"
	"sync"
)

// Manager coordinates room lifecycles across the SFU.
type Manager struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

// NewManager creates a new Room Manager.
func NewManager() *Manager {
	return &Manager{
		rooms: make(map[string]*Room),
	}
}

// GetOrCreate returns an existing room actor or spawns a new one.
func (m *Manager) GetOrCreate(channelID string) *Room {
	m.mu.Lock()
	defer m.mu.Unlock()

	if r, ok := m.rooms[channelID]; ok {
		return r
	}

	r := NewRoom(channelID, func(roomID string) {
		m.Remove(roomID)
	})

	m.rooms[channelID] = r
	slog.Info("Spawned new room actor", "room_id", channelID)
	return r
}

// Get returns the room actor for channelID if present.
func (m *Manager) Get(channelID string) (*Room, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	r, ok := m.rooms[channelID]
	return r, ok
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
