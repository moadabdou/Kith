package emojis

import "time"

// Event types emitted over NATS and Gateway.
const (
	EventTypeGuildEmojisUpdate   = "GUILD_EMOJIS_UPDATE"
	EventTypeGuildStickersUpdate = "GUILD_STICKERS_UPDATE"
	EventVersion                 = 1
)

// Emoji represents a custom guild emoji.
type Emoji struct {
	ID          string    `json:"id"`
	GuildID     string    `json:"guild_id"`
	Name        string    `json:"name"`
	UploaderID  string    `json:"uploader_id"`
	Animated    bool      `json:"animated"`
	ContentType string    `json:"content_type"`
	CreatedAt   time.Time `json:"created_at"`
	URL         string    `json:"url,omitempty"`
}

// Sticker represents a custom guild sticker.
type Sticker struct {
	ID          string    `json:"id"`
	GuildID     string    `json:"guild_id"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	UploaderID  string    `json:"uploader_id"`
	ContentType string    `json:"content_type"`
	CreatedAt   time.Time `json:"created_at"`
	URL         string    `json:"url,omitempty"`
}

// GuildEmojisUpdatePayload is broadcast when emojis are added, modified, or removed.
type GuildEmojisUpdatePayload struct {
	GuildID string  `json:"guild_id"`
	Emojis  []Emoji `json:"emojis"`
}

// GuildStickersUpdatePayload is broadcast when stickers are added or removed.
type GuildStickersUpdatePayload struct {
	GuildID  string    `json:"guild_id"`
	Stickers []Sticker `json:"stickers"`
}
