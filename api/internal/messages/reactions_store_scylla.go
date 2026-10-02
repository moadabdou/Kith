package messages

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/gocql/gocql"
)

var _ ReactionsStore = (*ScyllaReactionsStore)(nil)

const (
	cqlInsertReaction      = `INSERT INTO message_reactions (channel_id, message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?, ?)`
	cqlDeleteReaction      = `DELETE FROM message_reactions WHERE channel_id = ? AND message_id = ? AND emoji = ? AND user_id = ?`
	cqlGetMessageReactions = `SELECT emoji, user_id FROM message_reactions WHERE channel_id = ? AND message_id = ?`
	cqlListReactors        = `SELECT user_id FROM message_reactions WHERE channel_id = ? AND message_id = ? AND emoji = ?`
)

// ScyllaReactionsStore implements ReactionsStore backed by ScyllaDB with TimeWindowCompactionStrategy.
// Reactions are colocated with messages on single-partition keys ((channel_id, message_id)).
type ScyllaReactionsStore struct {
	session *gocql.Session
}

func NewScyllaReactionsStore(session *gocql.Session) *ScyllaReactionsStore {
	return &ScyllaReactionsStore{session: session}
}

func (s *ScyllaReactionsStore) AddReaction(ctx context.Context, channelID, messageID int64, emoji string, userID int64) error {
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

	now := time.Now().UTC()
	if err := s.session.Query(cqlInsertReaction, channelID, messageID, emoji, userID, now).WithContext(ctx).Exec(); err != nil {
		return fmt.Errorf("scylla reactions insert: %w", err)
	}
	return nil
}

func (s *ScyllaReactionsStore) RemoveReaction(ctx context.Context, channelID, messageID int64, emoji string, userID int64) error {
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

	if err := s.session.Query(cqlDeleteReaction, channelID, messageID, emoji, userID).WithContext(ctx).Exec(); err != nil {
		return fmt.Errorf("scylla reactions delete: %w", err)
	}
	return nil
}

func (s *ScyllaReactionsStore) GetReactionsForMessages(ctx context.Context, channelID int64, messageIDs []int64, currentUserID int64) (map[string][]ReactionTally, error) {
	if channelID <= 0 {
		return nil, ErrInvalidChannelID
	}
	result := make(map[string][]ReactionTally, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}

	// Bounded concurrent partition queries (up to 8 in-flight)
	type msgResult struct {
		midStr  string
		tallies []ReactionTally
		err     error
	}

	resChan := make(chan msgResult, len(messageIDs))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup

	for _, mid := range messageIDs {
		wg.Add(1)
		go func(mID int64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			tallies, err := s.fetchMessageReactions(ctx, channelID, mID, currentUserID)
			resChan <- msgResult{
				midStr:  strconv.FormatInt(mID, 10),
				tallies: tallies,
				err:     err,
			}
		}(mid)
	}

	wg.Wait()
	close(resChan)

	for res := range resChan {
		if res.err != nil {
			return nil, res.err
		}
		if len(res.tallies) > 0 {
			result[res.midStr] = res.tallies
		}
	}

	return result, nil
}

func (s *ScyllaReactionsStore) fetchMessageReactions(ctx context.Context, channelID, messageID int64, currentUserID int64) ([]ReactionTally, error) {
	iter := s.session.Query(cqlGetMessageReactions, channelID, messageID).WithContext(ctx).Iter()

	var emoji string
	var uid int64
	counts := make(map[string]int)
	meMap := make(map[string]bool)

	for iter.Scan(&emoji, &uid) {
		counts[emoji]++
		if uid == currentUserID {
			meMap[emoji] = true
		}
	}

	if err := iter.Close(); err != nil {
		return nil, fmt.Errorf("scylla scan reactions mid %d: %w", messageID, err)
	}

	if len(counts) == 0 {
		return nil, nil
	}

	emojis := make([]string, 0, len(counts))
	for e := range counts {
		emojis = append(emojis, e)
	}
	sort.Strings(emojis)

	tallies := make([]ReactionTally, 0, len(emojis))
	for _, e := range emojis {
		tallies = append(tallies, ReactionTally{
			Emoji: e,
			Count: counts[e],
			Me:    meMap[e],
		})
	}
	return tallies, nil
}

func (s *ScyllaReactionsStore) ListReactors(ctx context.Context, channelID, messageID int64, emoji string, limit int, after int64) ([]int64, error) {
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

	iter := s.session.Query(cqlListReactors, channelID, messageID, emoji).WithContext(ctx).Iter()

	var uid int64
	var allReactors []int64
	for iter.Scan(&uid) {
		allReactors = append(allReactors, uid)
	}

	if err := iter.Close(); err != nil {
		return nil, fmt.Errorf("scylla list reactors: %w", err)
	}

	sort.Slice(allReactors, func(i, j int) bool {
		return allReactors[i] < allReactors[j]
	})

	var filtered []int64
	for _, id := range allReactors {
		if after > 0 && id <= after {
			continue
		}
		filtered = append(filtered, id)
		if len(filtered) >= limit {
			break
		}
	}

	if filtered == nil {
		return []int64{}, nil
	}
	return filtered, nil
}
