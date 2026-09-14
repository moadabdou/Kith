package search

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/moadabdou/Kith/api/internal/messages"
)

var (
	ErrQueryRequired = errors.New("search: query parameter 'q' is required")
	ErrMissingAccess = errors.New("search: missing access to guild")
)

// SearchParams holds filters for searching messages within a guild.
type SearchParams struct {
	Query     string
	ChannelID int64
	AuthorID  int64
	Before    int64
	Limit     int
}

// SearchResponse matches Discord's message search envelope.
type SearchResponse struct {
	TotalResults int                `json:"total_results"`
	Messages     []messages.Message `json:"messages"`
}

// Service provides full-text search capabilities over messages.
// In Rung 1, this executes trigram-accelerated queries against PostgreSQL.
type Service struct {
	db *sql.DB
}

func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// SearchGuildMessages searches messages in a guild matching query and filters.
func (s *Service) SearchGuildMessages(ctx context.Context, userID, guildID int64, params SearchParams) (*SearchResponse, error) {
	if strings.TrimSpace(params.Query) == "" {
		return nil, ErrQueryRequired
	}

	// Verify requester is a member of the guild
	var memberCheck int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM members WHERE guild_id = $1 AND user_id = $2
	`, guildID, userID).Scan(&memberCheck)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrMissingAccess
	}
	if err != nil {
		return nil, fmt.Errorf("failed to verify guild membership: %w", err)
	}

	limit := params.Limit
	if limit <= 0 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}

	// Search Rung 1: PostgreSQL ILIKE query accelerated by pg_trgm GIN index (plan/04 §2)
	query := `
		SELECT m.id, m.channel_id, c.guild_id, m.author_id, u.username, to_char(u.discriminator, 'FM0000'),
		       m.content, m.created_at, m.edited_at
		FROM messages m
		JOIN channels c ON c.id = m.channel_id
		JOIN users u ON u.id = m.author_id
		WHERE c.guild_id = $1
		  AND m.content ILIKE '%' || $2 || '%'
		  AND ($3 = 0 OR m.channel_id = $3)
		  AND ($4 = 0 OR m.author_id = $4)
		  AND ($5 = 0 OR m.id < $5)
		ORDER BY m.id DESC
		LIMIT $6;
	`

	rows, err := s.db.QueryContext(ctx, query,
		guildID,
		params.Query,
		params.ChannelID,
		params.AuthorID,
		params.Before,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("search query failed: %w", err)
	}
	defer rows.Close()

	resMessages := make([]messages.Message, 0)
	for rows.Next() {
		var m messages.Message
		var gid sql.NullString
		if err := rows.Scan(
			&m.ID,
			&m.ChannelID,
			&gid,
			&m.Author.ID,
			&m.Author.Username,
			&m.Author.Discriminator,
			&m.Content,
			&m.CreatedAt,
			&m.EditedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan search message row: %w", err)
		}
		if gid.Valid {
			m.GuildID = gid.String
		}
		resMessages = append(resMessages, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows iteration error: %w", err)
	}

	return &SearchResponse{
		TotalResults: len(resMessages),
		Messages:     resMessages,
	}, nil
}
