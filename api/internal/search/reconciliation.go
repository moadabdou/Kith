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

// Package search provides full-text search indexing, querying, and reconciliation.
//
// =====================================================================================
// ARCHITECTURAL SPECIFICATION: SEARCH RECONCILIATION AT SCALE (DISCORD MODEL)
// =====================================================================================
//
// 1. SYSTEM MODEL: DERIVED INVERTED INDEX VS. SOURCE OF TRUTH
//    In high-throughput messaging architectures (e.g. Discord, Slack), the full-text
//    search cluster (Meilisearch, Elasticsearch, Lucene) is NEVER the authoritative
//    source of truth. It is a secondary, derived, eventually-consistent inverted index.
//    The authoritative source of truth resides in distributed primary storage
//    (ScyllaDB / Cassandra / PostgreSQL), partitioned by channel_id and sorted by
//    Snowflake ID timestamp buckets.
//
// 2. THE TRILLION-MESSAGE PROBLEM: WHY FULL-TABLE SCANS ARE AN ANTI-PATTERN
//    At scale (hundreds of billions to trillions of messages across millions of guilds):
//    - Linear Scans Are Mathematically Infeasible:
//      Crawling trillions of records with N+1 existence queries across a distributed
//      database and a search cluster would require months of continuous execution,
//      exhaust petabytes of network bandwidth, and cost hundreds of thousands of dollars
//      in wasted I/O.
//    - Storage Degradation:
//      In wide-column distributed engines like ScyllaDB or Cassandra, performing full
//      range scans triggers severe partition read amplification and tombstone warnings,
//      crippling latency on active chat hot-paths.
//    - Memory Leak Anti-Pattern (Indexer In-Memory Stores):
//      Attempting to reconcile or track out-of-order mutations using unbounded in-memory
//      maps (e.g. tracking recent deletes or mutation logs in API/indexer process RAM)
//      inevitably causes OOM crashes, fails across process restarts, and diverges across
//      distributed horizontal replicas.
//
// 3. MULTI-TIER PRODUCTION RECONCILIATION PATTERN (DISCORD MODEL)
//    Production architectures maintain eventual consistency through four complementary tiers:
//
//    TIER 1: Inline Read-Repair During Hydration (Primary Defense — Implemented in service.go)
//      - Search indexes operate in "Index-Only" mode (indexing search tokens and Snowflake IDs).
//      - When a user performs a search, the search engine returns matching document IDs.
//      - The API hydrates full message entities directly from primary storage (ScyllaDB).
//      - If primary storage returns RowNotFound (indicating a delete mutation was dropped or
//        delayed during an outage), the hydration path drops the hit from the response and
//        dispatches an asynchronous background DeleteDocuments eviction to the search cluster.
//      - Benefit: High-traffic guilds continuously self-heal on active read traffic with ZERO
//        background database scanning overhead.
//
//    TIER 2: Stream Buffer & Consumer Lag Auditing (Telemetry Defense — Implemented in indexer.go)
//      - Mutations flow through durable streaming logs (NATS JetStream / Apache Kafka).
//      - During downstream search outages (e.g. 60-second engine freeze), the indexer uses
//        m.InProgress() heartbeat extensions to prevent message re-delivery churn and avoid
//        thundering-herd tombstone resurrects.
//      - In-batch deduplication ensures updates supersede creates and deletes purge upserts
//        before flushing downstream.
//      - Operational health is verified via telemetry (search_indexer_nats_consumer_lag and
//        search_indexer_nats_pending_ack) rather than database sweeps.
//
//    TIER 3: Scoped Partition & Bucket Re-indexing (Disaster Recovery)
//      - When an index partition or single guild suffers severe data loss, reindexing is
//        strictly bounded by (guild_id, channel_id, snowflake_bucket_range).
//      - Full-cluster scans are architecturally forbidden; repairs operate as targeted,
//        rate-limited jobs against single channel token ranges.
//
//    TIER 4: Hierarchical Merkle Trees / Content Hash Diffing (Offline Verification)
//      - At massive scale, batch verification jobs avoid comparing raw rows.
//      - Both primary storage and index maintain hierarchical Merkle tree hashes across key
//        ranges. Reconcilers only traverse and synchronize partitions where the root hashes differ.
//
// 4. SCOPED ROLE OF THIS RECONCILER IN KITH (PHASE 3)
//    The Reconciler defined in this file serves as an on-demand administrative verification
//    and disaster recovery harness (accessible via CLI cmd/reconcile-search and admin API
//    POST /api/guilds/{id}/messages/search/reconcile).
//    - It operates with bounded sample windows (SampleSize, typically 100-1000 messages).
//    - It is designed to validate chaos drills (e.g. validating zero-loss after a 60-second
//      Meilisearch freeze) and perform spot checks for an isolated guild.
//    - It is explicitly NOT a 24/7 background database crawler.
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
func (r *Reconciler) Run(ctx context.Context, guildID int64, sampleSize ...int) (*ReconciliationReport, error) {
	start := time.Now()
	report := &ReconciliationReport{}

	if r.meiliClient == nil {
		return nil, errors.New("reconciler: meilisearch client not configured")
	}

	limit := r.cfg.SampleSize
	if len(sampleSize) > 0 && sampleSize[0] > 0 {
		limit = sampleSize[0]
	}

	// 1. Sample primary storage messages
	sampleMsgs, err := r.samplePrimaryMessages(ctx, guildID, limit)
	if err != nil {
		return nil, fmt.Errorf("reconciler: sample primary messages: %w", err)
	}

	report.ScannedCount = len(sampleMsgs)

	// 2. Check each primary message against Meilisearch
	batchDocs := make([]MessageDocument, 0, 100)
	flushDocs := func() {
		if len(batchDocs) == 0 {
			return
		}
		if err := r.meiliClient.IndexDocuments(ctx, r.cfg.IndexName, batchDocs); err != nil {
			slog.Error("reconciliation: failed to repair batch documents", "count", len(batchDocs), "error", err)
		}
		batchDocs = batchDocs[:0]
	}

	for _, m := range sampleMsgs {
		idStr := strconv.FormatInt(m.ID, 10)
		doc, err := r.meiliClient.GetDocument(ctx, r.cfg.IndexName, idStr)
		if errors.Is(err, ErrDocumentNotFound) {
			// Missing document: re-index into Meilisearch
			slog.Warn("reconciliation: detected missing document in search index", "message_id", idStr)
			report.MissingFixed++
			if r.cfg.AutoRepair {
				trimmed := strings.TrimSpace(m.Content)
				if trimmed != "" {
					content := m.Content
					if len(content) > 2000 {
						content = content[:2000]
					}
					batchDocs = append(batchDocs, MessageDocument{
						ID:        idStr,
						GuildID:   strconv.FormatInt(m.GuildID, 10),
						ChannelID: strconv.FormatInt(m.ChannelID, 10),
						AuthorID:  strconv.FormatInt(m.AuthorID, 10),
						Content:   content,
						Timestamp: m.CreatedAt.Unix(),
					})
					if len(batchDocs) >= 100 {
						flushDocs()
					}
				}
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
			report.ContentDriftFixed++
			if r.cfg.AutoRepair {
				batchDocs = append(batchDocs, MessageDocument{
					ID:        idStr,
					GuildID:   strconv.FormatInt(m.GuildID, 10),
					ChannelID: strconv.FormatInt(m.ChannelID, 10),
					AuthorID:  strconv.FormatInt(m.AuthorID, 10),
					Content:   expectedContent,
					Timestamp: m.CreatedAt.Unix(),
				})
				if len(batchDocs) >= 100 {
					flushDocs()
				}
			}
		}
	}
	if r.cfg.AutoRepair {
		flushDocs()
	}

	// 3. Scan for undeleted tombstones (ghost documents in Meilisearch deleted from primary store)
	if err := r.purgeTombstones(ctx, guildID, limit, report); err != nil {
		slog.Warn("reconciliation: tombstone scan error", "error", err)
	}

	report.Duration = time.Since(start)
	return report, nil
}

func (r *Reconciler) samplePrimaryMessages(ctx context.Context, guildID int64, limit int) ([]SampleMessage, error) {
	if r.db == nil {
		return nil, errors.New("reconciler: database connection required for channel metadata")
	}
	if r.msgStore == nil {
		return nil, errors.New("reconciler: message store required for primary sampling")
	}

	rows, err := r.db.QueryContext(ctx, `
		SELECT c.id, c.guild_id FROM channels c
		WHERE ($1::bigint = 0 OR c.guild_id = $1::bigint)
		  AND c.guild_id IS NOT NULL
		ORDER BY c.id ASC;
	`, guildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type chanRef struct {
		id      int64
		guildID int64
	}
	var channels []chanRef
	for rows.Next() {
		var cr chanRef
		if err := rows.Scan(&cr.id, &cr.guildID); err != nil {
			return nil, err
		}
		channels = append(channels, cr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var msgs []SampleMessage
	for _, ch := range channels {
		if len(msgs) >= limit {
			break
		}
		var cursor messages.Cursor
		for {
			if len(msgs) >= limit {
				break
			}
			toFetch := limit - len(msgs)
			if toFetch > 100 {
				toFetch = 100
			}
			cMsgs, err := r.msgStore.List(ctx, ch.id, cursor, toFetch)
			if err != nil {
				slog.Warn("reconciliation: failed to list messages from channel", "channel_id", ch.id, "error", err)
				break
			}
			if len(cMsgs) == 0 {
				break
			}
			for _, m := range cMsgs {
				mid, _ := strconv.ParseInt(m.ID, 10, 64)
				aid, _ := strconv.ParseInt(m.Author.ID, 10, 64)
				msgs = append(msgs, SampleMessage{
					ID:        mid,
					ChannelID: ch.id,
					GuildID:   ch.guildID,
					AuthorID:  aid,
					Content:   m.Content,
					CreatedAt: m.CreatedAt,
				})
				if len(msgs) >= limit {
					break
				}
			}
			if len(cMsgs) < toFetch {
				break
			}
			lastID, _ := strconv.ParseInt(cMsgs[len(cMsgs)-1].ID, 10, 64)
			cursor = messages.CursorFromMessageID(lastID)
		}
	}
	return msgs, nil
}

func (r *Reconciler) purgeTombstones(ctx context.Context, guildID int64, limit int, report *ReconciliationReport) error {
	var filter string
	if guildID != 0 {
		filter = fmt.Sprintf("guild_id = '%d'", guildID)
	}

	res, err := r.meiliClient.Search(ctx, r.cfg.IndexName, SearchQuery{
		Query:                "",
		Filter:               filter,
		Limit:                limit,
		AttributesToRetrieve: []string{"id", "channel_id"},
	})
	if err != nil {
		return err
	}

	batchDeletes := make([]string, 0, 100)
	flushDeletes := func() {
		if len(batchDeletes) == 0 {
			return
		}
		if err := r.meiliClient.DeleteDocuments(ctx, r.cfg.IndexName, batchDeletes); err != nil {
			slog.Error("reconciliation: failed to delete batch ghost documents", "count", len(batchDeletes), "error", err)
		}
		batchDeletes = batchDeletes[:0]
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
		}

		if !exists {
			slog.Warn("reconciliation: detected ghost document in search index", "message_id", hit.ID)
			report.TombstonesPurged++
			if r.cfg.AutoRepair {
				batchDeletes = append(batchDeletes, hit.ID)
				if len(batchDeletes) >= 100 {
					flushDeletes()
				}
			}
		}
	}
	if r.cfg.AutoRepair {
		flushDeletes()
	}
	return nil
}
