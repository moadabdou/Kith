package emojis

import "context"

// Store abstracts database operations for emojis and stickers.
type Store interface {
	CreateEmoji(ctx context.Context, e *Emoji) error
	GetEmoji(ctx context.Context, id int64) (*Emoji, error)
	ListGuildEmojis(ctx context.Context, guildID int64) ([]Emoji, error)
	DeleteEmoji(ctx context.Context, guildID, id int64) error

	CreateSticker(ctx context.Context, s *Sticker) error
	GetSticker(ctx context.Context, id int64) (*Sticker, error)
	ListGuildStickers(ctx context.Context, guildID int64) ([]Sticker, error)
	DeleteSticker(ctx context.Context, guildID, id int64) error

	IsGuildMember(ctx context.Context, guildID, userID int64) (bool, error)
	GetBatchEmojis(ctx context.Context, ids []int64) (map[int64]*Emoji, error)
	GetBatchStickers(ctx context.Context, ids []int64) (map[int64]*Sticker, error)
}
