package messages

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gocql/gocql"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

var _ Store = (*ScyllaStore)(nil)

// Prepared statement CQL constants (plan/03 §5, §8).
const (
	cqlInsertMessage          = `INSERT INTO messages (channel_id, bucket, message_id, author_id, content, type) VALUES (?, ?, ?, ?, ?, ?)`
	cqlListMessagesWithCursor = `SELECT message_id, author_id, content, edits, type FROM messages WHERE channel_id = ? AND bucket = ? AND message_id < ? LIMIT ?`
	cqlListLatestMessages     = `SELECT message_id, author_id, content, edits, type FROM messages WHERE channel_id = ? AND bucket = ? LIMIT ?`
	cqlGetMessage             = `SELECT author_id, content, edits, type FROM messages WHERE channel_id = ? AND bucket = ? AND message_id = ?`
	cqlEditMessage            = `UPDATE messages SET content = ?, edits = edits + [?] WHERE channel_id = ? AND bucket = ? AND message_id = ?`
	cqlDeleteMessage          = `DELETE FROM messages WHERE channel_id = ? AND bucket = ? AND message_id = ?`
)

// AuthorHydrator abstracts hydrating display metadata (username, discriminator)
// for author IDs from PostgreSQL or cache without relational SQL joins on Scylla reads.
type AuthorHydrator interface {
	HydrateAuthor(ctx context.Context, msg *Message) error
	HydrateBatch(ctx context.Context, msgs []Message) error
}

// PostgresAuthorHydrator resolves author metadata from the PostgreSQL users table.
//
// NOTE on caching: An in-memory cache without cross-process/cross-node invalidation
// introduces permanent stale user profile data if users update username/discriminator.
// Safe production caching requires an invalidation bus (e.g. USER_UPDATE event stream).
type PostgresAuthorHydrator struct {
	db *sql.DB
}

// NewPostgresAuthorHydrator returns an AuthorHydrator querying the PostgreSQL users table.
func NewPostgresAuthorHydrator(db *sql.DB) *PostgresAuthorHydrator {
	return &PostgresAuthorHydrator{db: db}
}

// HydrateAuthor hydrates a single message author from PostgreSQL.
func (h *PostgresAuthorHydrator) HydrateAuthor(ctx context.Context, msg *Message) error {
	if msg == nil || h.db == nil {
		return nil
	}
	authorID, err := strconv.ParseInt(msg.Author.ID, 10, 64)
	if err != nil {
		return err
	}
	return h.db.QueryRowContext(ctx, `
		SELECT username, to_char(discriminator, 'FM0000')
		FROM users WHERE id = $1`, authorID,
	).Scan(&msg.Author.Username, &msg.Author.Discriminator)
}

// HydrateBatch hydrates author details for a slice of messages in a single PostgreSQL query.
func (h *PostgresAuthorHydrator) HydrateBatch(ctx context.Context, msgs []Message) error {
	if len(msgs) == 0 || h.db == nil {
		return nil
	}
	idSet := make(map[int64]struct{})
	for i := range msgs {
		if uid, err := strconv.ParseInt(msgs[i].Author.ID, 10, 64); err == nil {
			idSet[uid] = struct{}{}
		}
	}
	if len(idSet) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}

	rows, err := h.db.QueryContext(ctx, `
		SELECT id, username, to_char(discriminator, 'FM0000')
		FROM users WHERE id = ANY($1)`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()

	userMap := make(map[string]AuthorRef)
	for rows.Next() {
		var uid int64
		var ref AuthorRef
		if err := rows.Scan(&uid, &ref.Username, &ref.Discriminator); err != nil {
			return err
		}
		ref.ID = strconv.FormatInt(uid, 10)
		userMap[ref.ID] = ref
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for i := range msgs {
		if ref, ok := userMap[msgs[i].Author.ID]; ok {
			msgs[i].Author.Username = ref.Username
			msgs[i].Author.Discriminator = ref.Discriminator
		}
	}
	return nil
}

// ScyllaConfig holds ScyllaDB cluster connection parameters.
type ScyllaConfig struct {
	Hosts       []string
	Keyspace    string
	Consistency gocql.Consistency
	Timeout     time.Duration
}

// ParseConsistency converts a string representation to a gocql.Consistency level.
func ParseConsistency(c string) gocql.Consistency {
	switch strings.ToUpper(strings.TrimSpace(c)) {
	case "ANY":
		return gocql.Any
	case "ONE":
		return gocql.One
	case "TWO":
		return gocql.Two
	case "THREE":
		return gocql.Three
	case "QUORUM":
		return gocql.Quorum
	case "ALL":
		return gocql.All
	case "LOCAL_QUORUM":
		return gocql.LocalQuorum
	case "EACH_QUORUM":
		return gocql.EachQuorum
	case "LOCAL_ONE":
		return gocql.LocalOne
	default:
		return gocql.LocalQuorum
	}
}

// NewScyllaSession creates and initializes a gocql.Session with connection pooling and retry policy.
func NewScyllaSession(cfg ScyllaConfig) (*gocql.Session, error) {
	if len(cfg.Hosts) == 0 {
		cfg.Hosts = []string{"127.0.0.1:9042"}
	}
	if cfg.Keyspace == "" {
		cfg.Keyspace = "kith"
	}
	if cfg.Consistency == 0 {
		cfg.Consistency = gocql.LocalQuorum
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 5 * time.Second
	}

	cluster := gocql.NewCluster(cfg.Hosts...)
	cluster.Keyspace = cfg.Keyspace
	cluster.Consistency = cfg.Consistency
	cluster.Timeout = cfg.Timeout
	cluster.ConnectTimeout = cfg.Timeout
	cluster.RetryPolicy = &gocql.ExponentialBackoffRetryPolicy{
		NumRetries: 3,
		Min:        100 * time.Millisecond,
		Max:        1 * time.Second,
	}

	return cluster.CreateSession()
}

// ScyllaStore implements messages.Store using ScyllaDB (plan/03 §3, §5, §8).
type ScyllaStore struct {
	session  *gocql.Session
	hydrator AuthorHydrator
}

// NewScyllaStore constructs a ScyllaDB-backed message store.
func NewScyllaStore(session *gocql.Session, hydrator AuthorHydrator) *ScyllaStore {
	return &ScyllaStore{
		session:  session,
		hydrator: hydrator,
	}
}

// Close closes the underlying gocql session.
func (s *ScyllaStore) Close() {
	if s.session != nil {
		s.session.Close()
	}
}

// Insert writes a message row to ScyllaDB with LOCAL_QUORUM and no LWT overhead.
func (s *ScyllaStore) Insert(ctx context.Context, msg *Message) error {
	messageID, err := strconv.ParseInt(msg.ID, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid message id: %w", err)
	}
	channelID, err := strconv.ParseInt(msg.ChannelID, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid channel id: %w", err)
	}
	authorID, err := strconv.ParseInt(msg.Author.ID, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid author id: %w", err)
	}
	bucket := BucketForMessageID(messageID)

	if err := s.session.Query(cqlInsertMessage, channelID, bucket, messageID, authorID, msg.Content, 0).WithContext(ctx).Exec(); err != nil {
		return err
	}

	msg.CreatedAt = snowflake.Time(messageID)

	if s.hydrator != nil {
		_ = s.hydrator.HydrateAuthor(ctx, msg)
	}
	return nil
}

// Get fetches a single message by channel and message ID from ScyllaDB.
func (s *ScyllaStore) Get(ctx context.Context, channelID, messageID int64) (*Message, error) {
	bucket := BucketForMessageID(messageID)
	var authorID int64
	var content string
	var edits []string
	var msgType int16

	iter := s.session.Query(cqlGetMessage, channelID, bucket, messageID).WithContext(ctx)
	if err := iter.Scan(&authorID, &content, &edits, &msgType); err != nil {
		if errors.Is(err, gocql.ErrNotFound) {
			return nil, ErrUnknownMessage
		}
		return nil, err
	}

	createdAt := snowflake.Time(messageID)
	msg := &Message{
		ID:        snowflake.String(messageID),
		ChannelID: strconv.FormatInt(channelID, 10),
		Author:    AuthorRef{ID: strconv.FormatInt(authorID, 10)},
		Content:   content,
		CreatedAt: createdAt,
	}

	if len(edits) > 0 {
		editTime := createdAt.Add(time.Minute)
		msg.EditedAt = &editTime
	}

	if s.hydrator != nil {
		_ = s.hydrator.HydrateAuthor(ctx, msg)
	}

	return msg, nil
}

// List queries messages across partition buckets ordered by message_id DESC (plan/03 §4–5).
// When a bucket slice returns fewer than limit rows, it seamlessly hops to bucket - 1
// until the requested batch size is satisfied or the channel creation epoch is reached.
func (s *ScyllaStore) List(ctx context.Context, channelID int64, before Cursor, limit int) ([]Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	var startBucket int32
	var currentBeforeID int64

	if before.MessageID > 0 {
		startBucket = before.Bucket
		if startBucket == 0 {
			startBucket = BucketForMessageID(before.MessageID)
		}
		currentBeforeID = before.MessageID
	} else {
		nowOffset := time.Now().UnixMilli() - snowflake.Epoch
		if nowOffset < 0 {
			nowOffset = 0
		}
		startBucket = int32(nowOffset / BucketDurationMs)
		currentBeforeID = 0
	}

	channelCreationBucket := BucketForMessageID(channelID)
	if channelCreationBucket > startBucket {
		channelCreationBucket = 0
	}

	msgs := []Message{}
	currentBucket := startBucket

	for len(msgs) < limit && currentBucket >= channelCreationBucket {
		remaining := limit - len(msgs)

		var query *gocql.Query
		if currentBeforeID > 0 {
			query = s.session.Query(cqlListMessagesWithCursor, channelID, currentBucket, currentBeforeID, remaining).WithContext(ctx)
		} else {
			query = s.session.Query(cqlListLatestMessages, channelID, currentBucket, remaining).WithContext(ctx)
		}

		scanner := query.Iter().Scanner()
		for scanner.Next() {
			var mid, authorID int64
			var content string
			var edits []string
			var msgType int16

			if err := scanner.Scan(&mid, &authorID, &content, &edits, &msgType); err != nil {
				return nil, err
			}

			createdAt := snowflake.Time(mid)
			m := Message{
				ID:        snowflake.String(mid),
				ChannelID: strconv.FormatInt(channelID, 10),
				Author:    AuthorRef{ID: strconv.FormatInt(authorID, 10)},
				Content:   content,
				CreatedAt: createdAt,
			}
			if len(edits) > 0 {
				editTime := createdAt.Add(time.Minute)
				m.EditedAt = &editTime
			}
			msgs = append(msgs, m)
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}

		if len(msgs) >= limit {
			break
		}

		// Step to the previous bucket; in the older bucket, start from its newest messages
		currentBucket--
		currentBeforeID = 0
	}

	if s.hydrator != nil && len(msgs) > 0 {
		_ = s.hydrator.HydrateBatch(ctx, msgs)
	}

	return msgs, nil
}

// Edit appends previous content to edits list and updates message content in ScyllaDB.
func (s *ScyllaStore) Edit(ctx context.Context, channelID, messageID int64, content string) (*Message, error) {
	bucket := BucketForMessageID(messageID)

	existing, err := s.Get(ctx, channelID, messageID)
	if err != nil {
		return nil, err
	}

	if err := s.session.Query(cqlEditMessage, content, existing.Content, channelID, bucket, messageID).WithContext(ctx).Exec(); err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	existing.Content = content
	existing.EditedAt = &now
	return existing, nil
}

// Delete removes a message from ScyllaDB within the 15-minute author window.
func (s *ScyllaStore) Delete(ctx context.Context, channelID, messageID, authorID int64) error {
	bucket := BucketForMessageID(messageID)

	existing, err := s.Get(ctx, channelID, messageID)
	if err != nil {
		return err
	}
	if existing.Author.ID != strconv.FormatInt(authorID, 10) {
		return ErrNotAuthor
	}
	if time.Since(existing.CreatedAt) > EditWindow {
		return ErrEditWindowOver
	}

	return s.session.Query(cqlDeleteMessage, channelID, bucket, messageID).WithContext(ctx).Exec()
}
