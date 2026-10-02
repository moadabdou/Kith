package messages

import (
	"context"
	"errors"
)

var (
	ErrInvalidEmoji     = errors.New("reactions: invalid emoji")
	ErrInvalidMessageID = errors.New("reactions: invalid message id")
	ErrInvalidChannelID = errors.New("reactions: invalid channel id")
	ErrInvalidUserID    = errors.New("reactions: invalid user id")
)

// ReactionTally aggregates counts of a specific emoji on a message.
type ReactionTally struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Me    bool   `json:"me"`
}

// ReactionsStore defines persistence operations for message emoji reactions.
// Reactions are partitioned in ScyllaDB by ((channel_id, message_id), emoji, user_id)
// for sub-millisecond single-partition slice lookups.
type ReactionsStore interface {
	// AddReaction idempotently records a reaction by a user on a message.
	AddReaction(ctx context.Context, channelID, messageID int64, emoji string, userID int64) error

	// RemoveReaction idempotently removes a user's reaction from a message.
	RemoveReaction(ctx context.Context, channelID, messageID int64, emoji string, userID int64) error

	// GetReactionsForMessages fetches grouped reaction tallies for a batch of messages in a channel,
	// checking if currentUserID has reacted to set Me = true.
	// Returns a map keyed by message ID string.
	GetReactionsForMessages(ctx context.Context, channelID int64, messageIDs []int64, currentUserID int64) (map[string][]ReactionTally, error)

	// ListReactors returns paginated user IDs who reacted with a specific emoji on a message.
	ListReactors(ctx context.Context, channelID, messageID int64, emoji string, limit int, after int64) ([]int64, error)
}
