package search

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/moadabdou/Kith/api/internal/messages"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

var (
	ErrQueryRequired = errors.New("search: query parameter 'q' is required")
	ErrMissingAccess = errors.New("search: missing access to guild")
)

// SearchClient abstracts Meilisearch operations for search querying and testing.
type SearchClient interface {
	Search(ctx context.Context, index string, q SearchQuery) (*SearchResult, error)
	GetDocument(ctx context.Context, index, id string) (*MessageDocument, error)
	IndexDocuments(ctx context.Context, index string, docs []MessageDocument) error
	DeleteDocuments(ctx context.Context, index string, ids []string) error
}

// SearchParams holds filters for searching messages within a guild.
type SearchParams struct {
	Query     string
	ChannelID int64
	AuthorID  int64
	Before    int64
	Limit     int
	Offset    int
}

// SearchResponse matches Discord's message search envelope.
type SearchResponse struct {
	TotalResults int                `json:"total_results"`
	Messages     []messages.Message `json:"messages"`
}

// Service provides full-text search capabilities over messages.
// In Rung 2, it executes queries against Meilisearch and hydrates full messages
// from primary storage (ScyllaDB / PostgresStore) with Search-Index-Only efficiency.
// Falls back to PostgreSQL pg_trgm (Rung 1) when Meilisearch is not configured.
type Service struct {
	db          *sql.DB
	meiliClient SearchClient
	msgStore    messages.Store
}

// ServiceOption configures the Search Service.
type ServiceOption func(*Service)

// WithSearchClient injects a Meilisearch client.
func WithSearchClient(client SearchClient) ServiceOption {
	return func(s *Service) {
		s.meiliClient = client
	}
}

// WithMessageStore injects the primary message store for hydration.
func WithMessageStore(store messages.Store) ServiceOption {
	return func(s *Service) {
		s.msgStore = store
	}
}

// NewService creates a new search service instance.
func NewService(db *sql.DB, opts ...ServiceOption) *Service {
	s := &Service{db: db}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// SearchGuildMessages searches messages in a guild matching query and filters.
func (s *Service) SearchGuildMessages(ctx context.Context, userID, guildID int64, params SearchParams) (*SearchResponse, error) {
	if strings.TrimSpace(params.Query) == "" {
		return nil, ErrQueryRequired
	}

	// TODO(Phase 4): Enhance permissions verification.
	// Currently, this is a coarse guild membership check. In the next phase:
	// - Channel-level access: Ensure users cannot search or view messages from channels
	//   they don't have permission to view (e.g. private channels, hidden staff channels).
	//   If params.ChannelID is provided, verify view permission on that channel; if searching
	//   guild-wide, restrict/filter query results to only channels accessible by the user.
	// - Detailed role/overwrite permission bitmasks will be evaluated once the full permissions
	//   engine is integrated.
	if s.db != nil {
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
	}

	limit := params.Limit
	if limit <= 0 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}

	if s.meiliClient == nil {
		return nil, errors.New("search engine unavailable: meilisearch client not configured")
	}

	return s.searchMeilisearch(ctx, guildID, params, limit)
}

func (s *Service) searchMeilisearch(ctx context.Context, guildID int64, params SearchParams, limit int) (*SearchResponse, error) {
	filters := []string{
		fmt.Sprintf("guild_id = '%d'", guildID),
	}
	if params.ChannelID != 0 {
		filters = append(filters, fmt.Sprintf("channel_id = '%d'", params.ChannelID))
	}
	if params.AuthorID != 0 {
		filters = append(filters, fmt.Sprintf("author_id = '%d'", params.AuthorID))
	}
	if params.Before != 0 {
		beforeTS := snowflake.Time(params.Before).Unix()
		filters = append(filters, fmt.Sprintf("timestamp <= %d", beforeTS))
	}

	filterExpr := strings.Join(filters, " AND ")
	q := SearchQuery{
		Query:                params.Query,
		Filter:               filterExpr,
		Limit:                limit,
		Offset:               params.Offset,
		Sort:                 []string{"timestamp:desc"},
		AttributesToRetrieve: []string{"id", "channel_id"},
	}

	res, err := s.meiliClient.Search(ctx, DefaultIndexName, q)
	if err != nil {
		return nil, fmt.Errorf("meilisearch search error: %w", err)
	}

	// Hydrate full messages from primary store (ScyllaDB / PostgresStore)
	resMessages := make([]messages.Message, 0, len(res.Hits))
	for _, hit := range res.Hits {
		mid, err := strconv.ParseInt(hit.ID, 10, 64)
		if err != nil || mid == 0 {
			continue
		}
		cid, _ := strconv.ParseInt(hit.ChannelID, 10, 64)

		var msg *messages.Message
		if s.msgStore != nil && cid != 0 {
			m, err := s.msgStore.Get(ctx, cid, mid)
			if err == nil && m != nil {
				msg = m
			}
		}
		if msg != nil {
			resMessages = append(resMessages, *msg)
		} else {
			// Read-Repair (Discord scale hydration pattern):
			// If Meilisearch returned an index hit but primary store (ScyllaDB/Postgres) returned nil,
			// the document was deleted during an outage or dropped event. Evict it immediately
			// so the search index self-heals in real time without background table scans.
			go func(ghostID string) {
				repairCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := s.meiliClient.DeleteDocuments(repairCtx, DefaultIndexName, []string{ghostID}); err != nil {
					slog.Warn("search read-repair: failed to evict ghost document", "message_id", ghostID, "error", err)
				}
			}(hit.ID)
		}
	}

	return &SearchResponse{
		TotalResults: res.EstimatedTotalHits,
		Messages:     resMessages,
	}, nil
}
