package readstates

// ReadState represents a user's read position and mention count in a channel.
type ReadState struct {
	UserID            int64 `json:"user_id,string"`
	ChannelID         int64 `json:"channel_id,string"`
	LastReadMessageID int64 `json:"last_read_message_id,string"`
	MentionCount      int   `json:"mention_count"`
}

// AckRequest is the optional JSON payload for message acknowledgement.
type AckRequest struct {
	Token        *string `json:"token,omitempty"`
	Manual       bool    `json:"manual,omitempty"`
	MentionCount int     `json:"mention_count,omitempty"`
}

// MessageAckEvent is the wire payload for the gateway MESSAGE_ACK event.
type MessageAckEvent struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	Version   int    `json:"version,omitempty"`
}
