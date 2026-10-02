package messages

import (
	"context"
	"sort"
	"strconv"
	"sync"
	"time"
)

type msgKey struct {
	channelID int64
	messageID int64
}

// MemoryReactionsStore is a thread-safe in-memory ReactionsStore for hermetic unit testing.
type MemoryReactionsStore struct {
	mu   sync.RWMutex
	data map[msgKey]map[string]map[int64]time.Time
}

func NewMemoryReactionsStore() *MemoryReactionsStore {
	return &MemoryReactionsStore{
		data: make(map[msgKey]map[string]map[int64]time.Time),
	}
}

func (m *MemoryReactionsStore) AddReaction(ctx context.Context, channelID, messageID int64, emoji string, userID int64) error {
	if emoji == "" {
		return ErrInvalidEmoji
	}
	if channelID <= 0 {
		return ErrInvalidChannelID
	}
	if messageID <= 0 {
		return ErrInvalidMessageID
	}
	if userID <= 0 {
		return ErrInvalidUserID
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	k := msgKey{channelID: channelID, messageID: messageID}
	emojis, ok := m.data[k]
	if !ok {
		emojis = make(map[string]map[int64]time.Time)
		m.data[k] = emojis
	}

	users, ok := emojis[emoji]
	if !ok {
		users = make(map[int64]time.Time)
		emojis[emoji] = users
	}

	users[userID] = time.Now().UTC()
	return nil
}

func (m *MemoryReactionsStore) RemoveReaction(ctx context.Context, channelID, messageID int64, emoji string, userID int64) error {
	if emoji == "" {
		return ErrInvalidEmoji
	}
	if channelID <= 0 {
		return ErrInvalidChannelID
	}
	if messageID <= 0 {
		return ErrInvalidMessageID
	}
	if userID <= 0 {
		return ErrInvalidUserID
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	k := msgKey{channelID: channelID, messageID: messageID}
	emojis, ok := m.data[k]
	if !ok {
		return nil
	}

	users, ok := emojis[emoji]
	if !ok {
		return nil
	}

	delete(users, userID)
	if len(users) == 0 {
		delete(emojis, emoji)
	}
	if len(emojis) == 0 {
		delete(m.data, k)
	}
	return nil
}

func (m *MemoryReactionsStore) GetReactionsForMessages(ctx context.Context, channelID int64, messageIDs []int64, currentUserID int64) (map[string][]ReactionTally, error) {
	if channelID <= 0 {
		return nil, ErrInvalidChannelID
	}
	result := make(map[string][]ReactionTally, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, mid := range messageIDs {
		k := msgKey{channelID: channelID, messageID: mid}
		midStr := strconv.FormatInt(mid, 10)
		emojis, ok := m.data[k]
		if !ok || len(emojis) == 0 {
			continue
		}

		emojiNames := make([]string, 0, len(emojis))
		for e := range emojis {
			emojiNames = append(emojiNames, e)
		}
		sort.Strings(emojiNames)

		tallies := make([]ReactionTally, 0, len(emojiNames))
		for _, e := range emojiNames {
			users := emojis[e]
			cnt := len(users)
			if cnt == 0 {
				continue
			}
			_, me := users[currentUserID]
			tallies = append(tallies, ReactionTally{
				Emoji: e,
				Count: cnt,
				Me:    me,
			})
		}
		if len(tallies) > 0 {
			result[midStr] = tallies
		}
	}

	return result, nil
}

func (m *MemoryReactionsStore) ListReactors(ctx context.Context, channelID, messageID int64, emoji string, limit int, after int64) ([]int64, error) {
	if emoji == "" {
		return nil, ErrInvalidEmoji
	}
	if channelID <= 0 {
		return nil, ErrInvalidChannelID
	}
	if messageID <= 0 {
		return nil, ErrInvalidMessageID
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	k := msgKey{channelID: channelID, messageID: messageID}
	emojis, ok := m.data[k]
	if !ok {
		return []int64{}, nil
	}
	users, ok := emojis[emoji]
	if !ok || len(users) == 0 {
		return []int64{}, nil
	}

	allUsers := make([]int64, 0, len(users))
	for uid := range users {
		allUsers = append(allUsers, uid)
	}
	sort.Slice(allUsers, func(i, j int) bool {
		return allUsers[i] < allUsers[j]
	})

	var filtered []int64
	for _, uid := range allUsers {
		if after > 0 && uid <= after {
			continue
		}
		filtered = append(filtered, uid)
		if len(filtered) >= limit {
			break
		}
	}

	return filtered, nil
}
