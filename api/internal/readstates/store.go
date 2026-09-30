package readstates

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/gocql/gocql"
)

var (
	ErrNotFound = errors.New("readstates: not found")
)

// Store defines persistence operations for user read states.
type Store interface {
	Upsert(ctx context.Context, userID, channelID, messageID int64, mentionCount int) error
	Get(ctx context.Context, userID, channelID int64) (*ReadState, error)
	ListByUser(ctx context.Context, userID int64) ([]ReadState, error)
}

// ScyllaStore implements Store on ScyllaDB with LWT-free point upserts.
type ScyllaStore struct {
	session *gocql.Session
}

func NewScyllaStore(session *gocql.Session) *ScyllaStore {
	return &ScyllaStore{session: session}
}

// Upsert performs a coordination-free, LWT-free upsert of the user's read state.
func (s *ScyllaStore) Upsert(ctx context.Context, userID, channelID, messageID int64, mentionCount int) error {
	query := `
		INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count)
		VALUES (?, ?, ?, ?)
	`
	if err := s.session.Query(query, userID, channelID, messageID, mentionCount).WithContext(ctx).Exec(); err != nil {
		return fmt.Errorf("scylla read_states upsert: %w", err)
	}
	return nil
}

// Get retrieves a single read state entry for a user and channel.
func (s *ScyllaStore) Get(ctx context.Context, userID, channelID int64) (*ReadState, error) {
	query := `
		SELECT user_id, channel_id, last_read_message_id, mention_count
		FROM read_states
		WHERE user_id = ? AND channel_id = ?
	`
	var rs ReadState
	if err := s.session.Query(query, userID, channelID).WithContext(ctx).Scan(
		&rs.UserID, &rs.ChannelID, &rs.LastReadMessageID, &rs.MentionCount,
	); err != nil {
		if errors.Is(err, gocql.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("scylla read_states get: %w", err)
	}
	return &rs, nil
}

// ListByUser retrieves all channel read states for a given user in a single partition read.
func (s *ScyllaStore) ListByUser(ctx context.Context, userID int64) ([]ReadState, error) {
	query := `
		SELECT user_id, channel_id, last_read_message_id, mention_count
		FROM read_states
		WHERE user_id = ?
	`
	iter := s.session.Query(query, userID).WithContext(ctx).Iter()
	var results []ReadState
	var rs ReadState
	for iter.Scan(&rs.UserID, &rs.ChannelID, &rs.LastReadMessageID, &rs.MentionCount) {
		results = append(results, rs)
	}
	if err := iter.Close(); err != nil {
		return nil, fmt.Errorf("scylla read_states list by user: %w", err)
	}
	return results, nil
}

// MemoryStore is an in-memory Store implementation for testing.
type MemoryStore struct {
	mu     sync.RWMutex
	states map[int64]map[int64]ReadState // userID -> channelID -> ReadState
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		states: make(map[int64]map[int64]ReadState),
	}
}

func (m *MemoryStore) Upsert(_ context.Context, userID, channelID, messageID int64, mentionCount int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	userMap, ok := m.states[userID]
	if !ok {
		userMap = make(map[int64]ReadState)
		m.states[userID] = userMap
	}
	userMap[channelID] = ReadState{
		UserID:            userID,
		ChannelID:         channelID,
		LastReadMessageID: messageID,
		MentionCount:      mentionCount,
	}
	return nil
}

func (m *MemoryStore) Get(_ context.Context, userID, channelID int64) (*ReadState, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	userMap, ok := m.states[userID]
	if !ok {
		return nil, ErrNotFound
	}
	rs, ok := userMap[channelID]
	if !ok {
		return nil, ErrNotFound
	}
	return &rs, nil
}

func (m *MemoryStore) ListByUser(_ context.Context, userID int64) ([]ReadState, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	userMap, ok := m.states[userID]
	if !ok {
		return []ReadState{}, nil
	}
	var out []ReadState
	for _, rs := range userMap {
		out = append(out, rs)
	}
	return out, nil
}
