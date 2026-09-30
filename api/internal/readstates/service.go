package readstates

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strconv"

	"github.com/moadabdou/Kith/api/internal/events"
)

// ErrMissingAccess indicates the user is not a member of the guild or lacks access to the channel.
var ErrMissingAccess = errors.New("readstates: missing channel access")

// Service coordinates read state persistence and self-targeted gateway dispatch.
type Service struct {
	db    *sql.DB
	store Store
	pub   events.Publisher
}

func NewService(db *sql.DB, store Store, pub events.Publisher) *Service {
	return &Service{
		db:    db,
		store: store,
		pub:   pub,
	}
}

// AckMessage updates the user's read state in ScyllaDB and emits a self-targeted
// MESSAGE_ACK event to the user's active gateway sessions only.
func (s *Service) AckMessage(ctx context.Context, userID, channelID, messageID int64, manual bool, mentionCount int) error {
	// 1. Verify channel access if db is available
	if s.db != nil {
		if err := s.checkChannelAccess(ctx, userID, channelID); err != nil {
			return err
		}
	}

	// 2. Perform LWT-free point upsert in ScyllaDB
	if err := s.store.Upsert(ctx, userID, channelID, messageID, mentionCount); err != nil {
		return fmt.Errorf("readstates service: upsert: %w", err)
	}

	// 3. Emit self-targeted MESSAGE_ACK event to the user's virtual guild subject
	if s.pub != nil {
		evt := events.Event{
			Type:    "MESSAGE_ACK",
			Version: 1,
			GuildID: fmt.Sprintf("user_%d", userID), // Route to user virtual guild
			Payload: MessageAckEvent{
				ChannelID: strconv.FormatInt(channelID, 10),
				MessageID: strconv.FormatInt(messageID, 10),
			},
		}
		if err := s.pub.Publish(ctx, evt); err != nil {
			slog.WarnContext(ctx, "failed to publish self-targeted MESSAGE_ACK", "user_id", userID, "channel_id", channelID, "error", err)
		}
	}

	return nil
}

// GetReadState returns the read state for a specific channel.
func (s *Service) GetReadState(ctx context.Context, userID, channelID int64) (*ReadState, error) {
	return s.store.Get(ctx, userID, channelID)
}

// ListReadStates returns all channel read states for the current user.
func (s *Service) ListReadStates(ctx context.Context, userID int64) ([]ReadState, error) {
	return s.store.ListByUser(ctx, userID)
}

func (s *Service) checkChannelAccess(ctx context.Context, userID, channelID int64) error {
	var guildID int64
	err := s.db.QueryRowContext(ctx, `SELECT guild_id FROM channels WHERE id = $1`, channelID).Scan(&guildID)
	if err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("unknown channel: %d", channelID)
		}
		return err
	}

	// If DM channel (guild_id == 0)
	if guildID == 0 {
		return nil
	}

	// Verify user is member of the guild
	var exists bool
	err = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2)`, guildID, userID).Scan(&exists)
	if err != nil || !exists {
		return ErrMissingAccess
	}
	return nil
}
