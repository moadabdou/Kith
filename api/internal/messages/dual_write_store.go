package messages

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// DualWriteMode defines the active dual-write migration strategy (plan/03 §7, §10).
type DualWriteMode string

const (
	// ModePostgresOnly: Legacy mode. Reads and writes route exclusively to PostgreSQL.
	ModePostgresOnly DualWriteMode = "postgres_only"

	// ModeDualWritePGPrimary: Phase 1 migration. Primary writes to PG, resilient secondary write to Scylla.
	// Reads from PG; asynchronously shadow-reads Scylla and emits diff metrics.
	ModeDualWritePGPrimary DualWriteMode = "dual_write_pg_primary"

	// ModeDualWriteScyllaPrimary: Phase 2 migration (flag flipped). Primary writes to Scylla, resilient
	// secondary write to PG. Reads from Scylla; asynchronously shadow-reads PG and emits diff metrics.
	ModeDualWriteScyllaPrimary DualWriteMode = "dual_write_scylla_primary"

	// ModeScyllaOnly: Cutover target. Reads and writes route exclusively to ScyllaDB.
	ModeScyllaOnly DualWriteMode = "scylla_only"
)

// ParseDualWriteMode parses an environment string into a DualWriteMode.
func ParseDualWriteMode(raw string) DualWriteMode {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "dual_write_pg_primary":
		return ModeDualWritePGPrimary
	case "dual_write_scylla_primary":
		return ModeDualWriteScyllaPrimary
	case "scylla_only", "scylla":
		return ModeScyllaOnly
	default:
		return ModePostgresOnly
	}
}

var (
	SecondaryWriteFailuresTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "messages_secondary_write_failures_total",
			Help: "Total secondary message store write failures in dual-write mode.",
		},
		[]string{"operation", "store"},
	)

	ShadowDiffMismatchesTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "messages_shadow_diff_mismatches_total",
			Help: "Total shadow-read diff discrepancies detected between primary and secondary message stores.",
		},
		[]string{"operation", "diff_type"},
	)
)

func init() {
	_ = prometheus.Register(SecondaryWriteFailuresTotal)
	_ = prometheus.Register(ShadowDiffMismatchesTotal)

	// Pre-initialize label combinations so Prometheus scrape exposes them immediately at 0
	SecondaryWriteFailuresTotal.WithLabelValues("insert", "scylla")
	SecondaryWriteFailuresTotal.WithLabelValues("edit", "scylla")
	SecondaryWriteFailuresTotal.WithLabelValues("delete", "scylla")
	SecondaryWriteFailuresTotal.WithLabelValues("insert", "postgres")
	SecondaryWriteFailuresTotal.WithLabelValues("edit", "postgres")
	SecondaryWriteFailuresTotal.WithLabelValues("delete", "postgres")

	ShadowDiffMismatchesTotal.WithLabelValues("get", "existence")
	ShadowDiffMismatchesTotal.WithLabelValues("get", "field_mismatch")
	ShadowDiffMismatchesTotal.WithLabelValues("list", "count_mismatch")
	ShadowDiffMismatchesTotal.WithLabelValues("list", "item_mismatch")
	ShadowDiffMismatchesTotal.WithLabelValues("list", "error_mismatch")
}

// DualWriteStore wraps a primary and secondary Store to support zero-downtime migration,
// resilient secondary writes, and background shadow-read diff verification (Issue #48).
type DualWriteStore struct {
	mode          DualWriteMode
	primary       Store
	secondary     Store
	primaryName   string
	secondaryName string
	shadowTimeout time.Duration
	asyncRunner   func(fn func())
}

// NewDualWriteStore constructs a DualWriteStore configured for the specified mode.
func NewDualWriteStore(mode DualWriteMode, pgStore, scyllaStore Store) *DualWriteStore {
	var primary, secondary Store
	var primaryName, secondaryName string

	switch mode {
	case ModeDualWritePGPrimary:
		primary = pgStore
		secondary = scyllaStore
		primaryName = "postgres"
		secondaryName = "scylla"
	case ModeDualWriteScyllaPrimary:
		primary = scyllaStore
		secondary = pgStore
		primaryName = "scylla"
		secondaryName = "postgres"
	case ModeScyllaOnly:
		primary = scyllaStore
		secondary = nil
		primaryName = "scylla"
		secondaryName = "none"
	default: // ModePostgresOnly
		primary = pgStore
		secondary = nil
		primaryName = "postgres"
		secondaryName = "none"
	}

	return &DualWriteStore{
		mode:          mode,
		primary:       primary,
		secondary:     secondary,
		primaryName:   primaryName,
		secondaryName: secondaryName,
		shadowTimeout: 3 * time.Second,
	}
}

// Mode returns the active DualWriteMode.
func (d *DualWriteStore) Mode() DualWriteMode {
	return d.mode
}

// PrimaryName returns the name of the primary store.
func (d *DualWriteStore) PrimaryName() string {
	return d.primaryName
}

// SecondaryName returns the name of the secondary store.
func (d *DualWriteStore) SecondaryName() string {
	return d.secondaryName
}

// SetAsyncRunner configures a custom runner for asynchronous shadow operations (useful in tests).
func (d *DualWriteStore) SetAsyncRunner(runner func(fn func())) {
	d.asyncRunner = runner
}

func (d *DualWriteStore) runAsync(fn func()) {
	if d.asyncRunner != nil {
		d.asyncRunner(fn)
		return
	}
	go fn()
}

// Insert writes first to primary. On success, it executes a resilient secondary write.
// Secondary write failure is non-fatal: it logs a warning and increments metrics without failing the request.
func (d *DualWriteStore) Insert(ctx context.Context, msg *Message) error {
	if err := d.primary.Insert(ctx, msg); err != nil {
		return err
	}

	if d.secondary != nil {
		if err := d.secondary.Insert(ctx, msg); err != nil {
			slog.WarnContext(ctx, "secondary store insert failed",
				"store", d.secondaryName,
				"channel_id", msg.ChannelID,
				"message_id", msg.ID,
				"error", err,
			)
			SecondaryWriteFailuresTotal.WithLabelValues("insert", d.secondaryName).Inc()
		}
	}

	return nil
}

// Edit updates content in primary store first, followed by resilient secondary store update.
func (d *DualWriteStore) Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error) {
	msg, err := d.primary.Edit(ctx, channelID, messageID, content)
	if err != nil {
		return nil, err
	}

	if d.secondary != nil {
		if _, secErr := d.secondary.Edit(ctx, channelID, messageID, content); secErr != nil {
			slog.WarnContext(ctx, "secondary store edit failed",
				"store", d.secondaryName,
				"channel_id", channelID,
				"message_id", messageID,
				"error", secErr,
			)
			SecondaryWriteFailuresTotal.WithLabelValues("edit", d.secondaryName).Inc()
		}
	}

	return msg, nil
}

// Delete removes the message from primary store first, followed by resilient secondary delete.
func (d *DualWriteStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	if err := d.primary.Delete(ctx, channelID, messageID, authorID); err != nil {
		return err
	}

	if d.secondary != nil {
		if err := d.secondary.Delete(ctx, channelID, messageID, authorID); err != nil {
			slog.WarnContext(ctx, "secondary store delete failed",
				"store", d.secondaryName,
				"channel_id", channelID,
				"message_id", messageID,
				"error", err,
			)
			SecondaryWriteFailuresTotal.WithLabelValues("delete", d.secondaryName).Inc()
		}
	}

	return nil
}

// Get queries primary store and returns immediately.
// If secondary is active, it asynchronously shadow-reads secondary and compares the results.
func (d *DualWriteStore) Get(ctx context.Context, channelID, messageID int64) (*Message, error) {
	primaryMsg, primaryErr := d.primary.Get(ctx, channelID, messageID)

	if d.secondary != nil {
		d.runAsync(func() {
			shadowCtx, cancel := context.WithTimeout(context.Background(), d.shadowTimeout)
			defer cancel()

			secMsg, secErr := d.secondary.Get(shadowCtx, channelID, messageID)
			d.diffGet(channelID, messageID, primaryMsg, primaryErr, secMsg, secErr)
		})
	}

	return primaryMsg, primaryErr
}

// List queries primary store and returns immediately.
// If secondary is active, it asynchronously shadow-reads secondary and compares the results.
func (d *DualWriteStore) List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error) {
	primaryMsgs, primaryErr := d.primary.List(ctx, channelID, before, limit)

	if d.secondary != nil {
		d.runAsync(func() {
			shadowCtx, cancel := context.WithTimeout(context.Background(), d.shadowTimeout)
			defer cancel()

			secMsgs, secErr := d.secondary.List(shadowCtx, channelID, before, limit)
			d.diffList(channelID, before, limit, primaryMsgs, primaryErr, secMsgs, secErr)
		})
	}

	return primaryMsgs, primaryErr
}

func (d *DualWriteStore) diffGet(channelID, messageID int64, pMsg *Message, pErr error, sMsg *Message, sErr error) {
	// 1. Error parity check
	pNotFound := errors.Is(pErr, ErrUnknownMessage)
	sNotFound := errors.Is(sErr, ErrUnknownMessage)

	if (pErr != nil && sErr == nil) || (pErr == nil && sErr != nil) || (pNotFound != sNotFound) {
		slog.Warn("shadow diff on Get: existence mismatch",
			"channel_id", channelID,
			"message_id", messageID,
			"primary_err", pErr,
			"secondary_err", sErr,
		)
		ShadowDiffMismatchesTotal.WithLabelValues("get", "existence").Inc()
		return
	}

	if pErr != nil && sErr != nil {
		// Both returned an error (e.g. not found); parity satisfied
		return
	}

	// 2. Field parity check
	if pMsg == nil || sMsg == nil {
		ShadowDiffMismatchesTotal.WithLabelValues("get", "existence").Inc()
		return
	}

	if !messagesEqual(*pMsg, *sMsg) {
		slog.Warn("shadow diff on Get: field mismatch",
			"channel_id", channelID,
			"message_id", messageID,
			"primary", pMsg,
			"secondary", sMsg,
		)
		ShadowDiffMismatchesTotal.WithLabelValues("get", "field_mismatch").Inc()
	}
}

func (d *DualWriteStore) diffList(channelID int64, before Cursor, limit int, pMsgs []Message, pErr error, sMsgs []Message, sErr error) {
	if (pErr != nil && sErr == nil) || (pErr == nil && sErr != nil) {
		slog.Warn("shadow diff on List: error mismatch",
			"channel_id", channelID,
			"before", before,
			"limit", limit,
			"primary_err", pErr,
			"secondary_err", sErr,
		)
		ShadowDiffMismatchesTotal.WithLabelValues("list", "error_mismatch").Inc()
		return
	}

	if pErr != nil && sErr != nil {
		return
	}

	if len(pMsgs) != len(sMsgs) {
		slog.Warn("shadow diff on List: count mismatch",
			"channel_id", channelID,
			"before", before,
			"limit", limit,
			"primary_count", len(pMsgs),
			"secondary_count", len(sMsgs),
		)
		ShadowDiffMismatchesTotal.WithLabelValues("list", "count_mismatch").Inc()
		return
	}

	for i := range pMsgs {
		if !messagesEqual(pMsgs[i], sMsgs[i]) {
			slog.Warn("shadow diff on List: item mismatch",
				"channel_id", channelID,
				"index", i,
				"primary_id", pMsgs[i].ID,
				"secondary_id", sMsgs[i].ID,
			)
			ShadowDiffMismatchesTotal.WithLabelValues("list", "item_mismatch").Inc()
			return
		}
	}
}

func messagesEqual(a, b Message) bool {
	if a.ID != b.ID || a.ChannelID != b.ChannelID || a.Content != b.Content {
		return false
	}
	if a.Author.ID != b.Author.ID {
		return false
	}
	// Verify timestamp equivalence normalized to millisecond precision
	// (Postgres timestamptz microsecond vs Snowflake epoch millisecond)
	if a.CreatedAt.UnixMilli() != b.CreatedAt.UnixMilli() {
		return false
	}
	if (a.EditedAt == nil) != (b.EditedAt == nil) {
		return false
	}
	if a.EditedAt != nil && b.EditedAt != nil {
		if a.EditedAt.UnixMilli() != b.EditedAt.UnixMilli() {
			return false
		}
	}
	return true
}
