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
)

// ReconciliationReport contains metrics from a reconciliation scan run.
type ReconciliationReport struct {
	ScannedCount      int           `json:"scanned_count"`
	MissingFixed      int           `json:"missing_fixed"`
	ContentDriftFixed int           `json:"content_drift_fixed"`
	TombstonesPurged  int           `json:"tombstones_purged"`
	Duration          time.Duration `json:"duration"`
}

// ReconcilerConfig configures the reconciliation job.
type ReconcilerConfig struct {
	IndexName  string
	SampleSize int
	AutoRepair bool
}

// Reconciler compares primary message storage against Meilisearch to detect and repair consistency drift (plan/04 §3).
type Reconciler struct {
	cfg         ReconcilerConfig
	db          *sql.DB
	msgStore    messages.Store
	meiliClient SearchClient
}

// NewReconciler creates a reconciler instance.
func NewReconciler(cfg ReconcilerConfig, db *sql.DB, msgStore messages.Store, client SearchClient) *Reconciler {
	if cfg.IndexName == "" {
		cfg.IndexName = DefaultIndexName
	}
	if cfg.SampleSize <= 0 {
		cfg.SampleSize = 100
	}
	return &Reconciler{
		cfg:         cfg,
		db:          db,
		msgStore:    msgStore,
		meiliClient: client,
	}
}

// SampleMessage represents a message read from primary storage.
type SampleMessage struct {
	ID        int64
	ChannelID int64
	GuildID   int64
	AuthorID  int64
	Content   string
	CreatedAt time.Time
}

// Run executes the reconciliation scan against a guild or across all channels.
func (r *Reconciler) Run(ctx context.Context, guildID int64) (*ReconciliationReport, error) {
	start := time.Now()
	report := &ReconciliationReport{}

	if r.meiliClient == nil {
		return nil, errors.New("reconciler: meilisearch client not configured")
	}

	// 1. Sample primary storage messages
	sampleMsgs, err := r.samplePrimaryMessages(ctx, guildID, r.cfg.SampleSize)
	if err != nil {
		return nil, fmt.Errorf("reconciler: sample primary messages: %w", err)
	}

	report.ScannedCount = len(sampleMsgs)

	// 2. Check each primary message against Meilisearch
	for _, m := range sampleMsgs {
		idStr := strconv.FormatInt(m.ID, 10)
		doc, err := r.meiliClient.GetDocument(ctx, r.cfg.IndexName, idStr)
		if errors.Is(err, ErrDocumentNotFound) {
			// Missing document: re-index into Meilisearch
			slog.Warn("reconciliation: detected missing document in search index", "message_id", idStr)
			if r.cfg.AutoRepair {
				trimmed := strings.TrimSpace(m.Content)
				if trimmed != "" {
					content := m.Content
					if len(content) > 2000 {
						content = content[:2000]
					}
					upsertDoc := MessageDocument{
						ID:        idStr,
						GuildID:   strconv.FormatInt(m.GuildID, 10),
						ChannelID: strconv.FormatInt(m.ChannelID, 10),
						AuthorID:  strconv.FormatInt(m.AuthorID, 10),
						Content:   content,
						Timestamp: m.CreatedAt.Unix(),
					}
					if err := r.meiliClient.IndexDocuments(ctx, r.cfg.IndexName, []MessageDocument{upsertDoc}); err != nil {
						slog.Error("reconciliation: failed to repair missing document", "message_id", idStr, "error", err)
					} else {
						report.MissingFixed++
					}
				}
			} else {
				report.MissingFixed++
			}
			continue
		}
		if err != nil {
			slog.Warn("reconciliation: error fetching document from search index", "message_id", idStr, "error", err)
			continue
		}

		// Check for content drift
		expectedContent := m.Content
		if len(expectedContent) > 2000 {
			expectedContent = expectedContent[:2000]
		}
		if doc.Content != expectedContent {
			slog.Warn("reconciliation: detected content drift in search index", "message_id", idStr)
			if r.cfg.AutoRepair {
				upsertDoc := MessageDocument{
					ID:        idStr,
					GuildID:   strconv.FormatInt(m.GuildID, 10),
					ChannelID: strconv.FormatInt(m.ChannelID, 10),
					AuthorID:  strconv.FormatInt(m.AuthorID, 10),
					Content:   expectedContent,
					Timestamp: m.CreatedAt.Unix(),
				}
				if err := r.meiliClient.IndexDocuments(ctx, r.cfg.IndexName, []MessageDocument{upsertDoc}); err != nil {
					slog.Error("reconciliation: failed to repair drifted document", "message_id", idStr, "error", err)
				} else {
					report.ContentDriftFixed++
				}
			} else {
				report.ContentDriftFixed++
			}
		}
	}

	// 3. Scan for undeleted tombstones (ghost documents in Meilisearch deleted from primary store)
	if err := r.purgeTombstones(ctx, guildID, report); err != nil {
		slog.Warn("reconciliation: tombstone scan error", "error", err)
	}

	report.Duration = time.Since(start)
	return report, nil
}

func (r *Reconciler) samplePrimaryMessages(ctx context.Context, guildID int64, limit int) ([]SampleMessage, error) {
	if r.db == nil {
		return nil, errors.New("reconciler: database connection required for primary sampling")
	}

	query := `
		SELECT m.id, m.channel_id, c.guild_id, m.author_id, m.content, m.created_at
		FROM messages m
		JOIN channels c ON c.id = m.channel_id
		WHERE ($1::bigint = 0 OR c.guild_id = $1::bigint)
		  AND c.guild_id IS NOT NULL
		ORDER BY m.id DESC
		LIMIT $2;
	`
	rows, err := r.db.QueryContext(ctx, query, guildID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []SampleMessage
	for rows.Next() {
		var sm SampleMessage
		var gid sql.NullInt64
		if err := rows.Scan(&sm.ID, &sm.ChannelID, &gid, &sm.AuthorID, &sm.Content, &sm.CreatedAt); err != nil {
			return nil, err
		}
		if gid.Valid {
			sm.GuildID = gid.Int64
		}
		msgs = append(msgs, sm)
	}
	return msgs, rows.Err()
}

func (r *Reconciler) purgeTombstones(ctx context.Context, guildID int64, report *ReconciliationReport) error {
	var filter string
	if guildID != 0 {
		filter = fmt.Sprintf("guild_id = '%d'", guildID)
	}

	res, err := r.meiliClient.Search(ctx, r.cfg.IndexName, SearchQuery{
		Query:                "",
		Filter:               filter,
		Limit:                r.cfg.SampleSize,
		AttributesToRetrieve: []string{"id", "channel_id"},
	})
	if err != nil {
		return err
	}

	for _, hit := range res.Hits {
		mid, err := strconv.ParseInt(hit.ID, 10, 64)
		if err != nil || mid == 0 {
			continue
		}
		cid, _ := strconv.ParseInt(hit.ChannelID, 10, 64)

		exists := false
		if r.msgStore != nil && cid != 0 {
			_, err := r.msgStore.Get(ctx, cid, mid)
			if err == nil {
				exists = true
			}
		} else if r.db != nil {
			var check int
			err := r.db.QueryRowContext(ctx, "SELECT 1 FROM messages WHERE id = $1", mid).Scan(&check)
			if err == nil {
				exists = true
			}
		}

		if !exists {
			slog.Warn("reconciliation: detected ghost document in search index", "message_id", hit.ID)
			if r.cfg.AutoRepair {
				if err := r.meiliClient.DeleteDocuments(ctx, r.cfg.IndexName, []string{hit.ID}); err != nil {
					slog.Error("reconciliation: failed to delete ghost document", "message_id", hit.ID, "error", err)
				} else {
					report.TombstonesPurged++
				}
			} else {
				report.TombstonesPurged++
			}
		}
	}
	return nil
}
