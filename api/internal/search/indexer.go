package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

const (
	DefaultConsumerName = "kith-search-indexer"
	DefaultStreamName   = "KITH_EVENTS"
	DefaultIndexName    = "messages"
	DefaultBatchSize    = 100
	DefaultFlushWindow  = 100 * time.Millisecond
)

// DocIndexer abstracts Meilisearch document operations for testing.
type DocIndexer interface {
	IndexDocuments(ctx context.Context, index string, docs []MessageDocument) error
	DeleteDocuments(ctx context.Context, index string, ids []string) error
}

// IndexerConfig holds configuration for the search indexer.
type IndexerConfig struct {
	StreamName    string
	ConsumerName  string
	IndexName     string
	BatchSize     int
	FlushWindow   time.Duration
	NatsURL       string
	Subject       string
}

// Indexer consumes NATS JetStream message events and flushes them to Meilisearch in micro-batches.
type Indexer struct {
	cfg     IndexerConfig
	client  DocIndexer
	nc      *nats.Conn
	js      nats.JetStreamContext
	sub     *nats.Subscription
	msgChan chan *nats.Msg
	done    chan struct{}
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// rawEvent is the wire envelope received from NATS.
type rawEvent struct {
	Type    string          `json:"type"`
	Version int             `json:"version"`
	GuildID string          `json:"guild_id,omitempty"`
	Payload json.RawMessage `json:"payload"`
}

type messagePayload struct {
	ID        string          `json:"id"`
	ChannelID string          `json:"channel_id"`
	GuildID   string          `json:"guild_id"`
	Author    authorPayload   `json:"author"`
	Content   string          `json:"content"`
	Timestamp json.RawMessage `json:"timestamp"`
}

type authorPayload struct {
	ID string `json:"id"`
}

type deletePayload struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	GuildID   string `json:"guild_id"`
}

// NewIndexer creates an indexer instance.
func NewIndexer(cfg IndexerConfig, client DocIndexer, nc *nats.Conn, js nats.JetStreamContext) *Indexer {
	if cfg.StreamName == "" {
		cfg.StreamName = DefaultStreamName
	}
	if cfg.ConsumerName == "" {
		cfg.ConsumerName = DefaultConsumerName
	}
	if cfg.IndexName == "" {
		cfg.IndexName = DefaultIndexName
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = DefaultBatchSize
	}
	if cfg.FlushWindow <= 0 {
		cfg.FlushWindow = DefaultFlushWindow
	}
	if cfg.Subject == "" {
		cfg.Subject = "kith.events.>"
	}

	RegisterMetrics()

	return &Indexer{
		cfg:     cfg,
		client:  client,
		nc:      nc,
		js:      js,
		msgChan: make(chan *nats.Msg, 1024),
		done:    make(chan struct{}),
	}
}

// Start launches the indexer consumer and batching loop.
func (idx *Indexer) Start(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	idx.cancel = cancel

	// Ensure stream exists before subscribing
	if idx.js != nil {
		_, err := idx.js.StreamInfo(idx.cfg.StreamName)
		if err != nil && errors.Is(err, nats.ErrStreamNotFound) {
			_, err = idx.js.AddStream(&nats.StreamConfig{
				Name:       idx.cfg.StreamName,
				Subjects:   []string{idx.cfg.Subject},
				Storage:    nats.FileStorage,
				Retention:  nats.LimitsPolicy,
				Discard:    nats.DiscardOld,
				MaxAge:     24 * time.Hour,
				Duplicates: 2 * time.Minute,
			})
			if err != nil {
				cancel()
				return fmt.Errorf("search indexer: ensure stream %s: %w", idx.cfg.StreamName, err)
			}
		}

		sub, err := idx.js.Subscribe(
			idx.cfg.Subject,
			func(m *nats.Msg) {
				select {
				case idx.msgChan <- m:
				case <-ctx.Done():
					if m.Sub != nil {
						_ = m.Nak()
					}
				}
			},
			nats.Durable(idx.cfg.ConsumerName),
			nats.DeliverAll(),
			nats.ManualAck(),
			nats.AckWait(30*time.Second),
		)
		if err != nil {
			cancel()
			return fmt.Errorf("search indexer: subscribe to %s: %w", idx.cfg.Subject, err)
		}
		idx.sub = sub
	}

	idx.wg.Add(1)
	go idx.runBatcher(ctx)

	slog.Info("search indexer started", "stream", idx.cfg.StreamName, "consumer", idx.cfg.ConsumerName, "index", idx.cfg.IndexName)
	return nil
}

// Stop stops the indexer, draining pending messages and closing subscriptions.
func (idx *Indexer) Stop() {
	if idx.cancel != nil {
		idx.cancel()
	}
	if idx.sub != nil {
		_ = idx.sub.Unsubscribe()
	}
	idx.wg.Wait()
	slog.Info("search indexer stopped")
}

type pendingBatch struct {
	upserts map[string]MessageDocument
	deletes map[string]struct{}
	msgs    []*nats.Msg
}

func newPendingBatch() *pendingBatch {
	return &pendingBatch{
		upserts: make(map[string]MessageDocument),
		deletes: make(map[string]struct{}),
		msgs:    make([]*nats.Msg, 0),
	}
}

func (b *pendingBatch) size() int {
	return len(b.upserts) + len(b.deletes)
}

func (idx *Indexer) runBatcher(ctx context.Context) {
	defer idx.wg.Done()

	ticker := time.NewTicker(idx.cfg.FlushWindow)
	defer ticker.Stop()

	batch := newPendingBatch()

	flush := func() {
		if batch.size() == 0 && len(batch.msgs) == 0 {
			return
		}
		idx.flushBatch(ctx, batch)
		batch = newPendingBatch()
	}

	for {
		select {
		case <-ctx.Done():
			// Process any remaining buffered events on shutdown
			for len(idx.msgChan) > 0 {
				m := <-idx.msgChan
				idx.processMsg(m, batch)
			}
			flush()
			return

		case m := <-idx.msgChan:
			idx.processMsg(m, batch)
			if batch.size() >= idx.cfg.BatchSize {
				flush()
			}

		case <-ticker.C:
			if batch.size() > 0 || len(batch.msgs) > 0 {
				flush()
			}
		}
	}
}

func (idx *Indexer) processMsg(m *nats.Msg, batch *pendingBatch) {
	batch.msgs = append(batch.msgs, m)

	var ev rawEvent
	if err := json.Unmarshal(m.Data, &ev); err != nil {
		slog.Warn("search indexer: failed to unmarshal event envelope", "error", err)
		return
	}

	switch ev.Type {
	case "MESSAGE_CREATE", "MESSAGE_UPDATE":
		var p messagePayload
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			slog.Warn("search indexer: failed to unmarshal message payload", "type", ev.Type, "error", err)
			return
		}
		if p.ID == "" {
			return
		}

		trimmed := strings.TrimSpace(p.Content)
		if trimmed == "" {
			// If an update cleared content, purge it from the search index
			if ev.Type == "MESSAGE_UPDATE" {
				delete(batch.upserts, p.ID)
				batch.deletes[p.ID] = struct{}{}
				ProcessedEventsTotal.WithLabelValues("delete").Inc()
			}
			return
		}

		// Enforce bounded content length (max 2000 chars)
		content := p.Content
		if len(content) > 2000 {
			content = content[:2000]
		}

		guildID := p.GuildID
		if guildID == "" {
			guildID = ev.GuildID
		}

		doc := MessageDocument{
			ID:        p.ID,
			GuildID:   guildID,
			ChannelID: p.ChannelID,
			AuthorID:  p.Author.ID,
			Content:   content,
			Timestamp: parseTimestamp(p.Timestamp),
		}

		// Idempotent upsert: if previously deleted in same batch, upsert supersedes
		delete(batch.deletes, p.ID)
		batch.upserts[p.ID] = doc

		if ev.Type == "MESSAGE_CREATE" {
			ProcessedEventsTotal.WithLabelValues("create").Inc()
		} else {
			ProcessedEventsTotal.WithLabelValues("update").Inc()
		}

	case "MESSAGE_DELETE":
		var p deletePayload
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			slog.Warn("search indexer: failed to unmarshal delete payload", "error", err)
			return
		}
		if p.ID == "" {
			return
		}

		// Delete supersedes any earlier upsert for same ID in this batch
		delete(batch.upserts, p.ID)
		batch.deletes[p.ID] = struct{}{}
		ProcessedEventsTotal.WithLabelValues("delete").Inc()
	}
}

func (idx *Indexer) flushBatch(ctx context.Context, batch *pendingBatch) {
	totalItems := batch.size()
	BatchSize.Observe(float64(totalItems))

	start := time.Now()
	defer func() {
		FlushDuration.Observe(time.Since(start).Seconds())
	}()

	flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var flushErr error

	// 1. Flush upserts
	if len(batch.upserts) > 0 {
		docs := make([]MessageDocument, 0, len(batch.upserts))
		for _, doc := range batch.upserts {
			docs = append(docs, doc)
		}
		if err := idx.client.IndexDocuments(flushCtx, idx.cfg.IndexName, docs); err != nil {
			flushErr = fmt.Errorf("upsert %d docs: %w", len(docs), err)
		}
	}

	// 2. Flush deletes
	if flushErr == nil && len(batch.deletes) > 0 {
		ids := make([]string, 0, len(batch.deletes))
		for id := range batch.deletes {
			ids = append(ids, id)
		}
		if err := idx.client.DeleteDocuments(flushCtx, idx.cfg.IndexName, ids); err != nil {
			flushErr = fmt.Errorf("delete %d docs: %w", len(ids), err)
		}
	}

	// 3. Ack or Nak NATS messages
	if flushErr != nil {
		slog.Error("search indexer: batch flush failed, naking messages for redelivery", "error", flushErr, "messages", len(batch.msgs))
		for _, m := range batch.msgs {
			if m.Sub != nil {
				_ = m.Nak()
			}
		}
		return
	}

	for _, m := range batch.msgs {
		if m.Sub != nil {
			if err := m.Ack(); err != nil {
				slog.Warn("search indexer: failed to ack message", "error", err)
			}
		}
	}
}

func parseTimestamp(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return time.Now().UTC().Unix()
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil && str != "" {
		if t, err := time.Parse(time.RFC3339Nano, str); err == nil {
			return t.Unix()
		}
		if t, err := time.Parse(time.RFC3339, str); err == nil {
			return t.Unix()
		}
		if n, err := strconv.ParseInt(str, 10, 64); err == nil {
			return n
		}
	}
	var num int64
	if err := json.Unmarshal(raw, &num); err == nil && num > 0 {
		return num
	}
	return time.Now().UTC().Unix()
}
