package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gocql/gocql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/emojis"
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/internal/gifs"
	"github.com/moadabdou/Kith/api/internal/guilds"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/internal/mail"
	"github.com/moadabdou/Kith/api/internal/media"
	"github.com/moadabdou/Kith/api/internal/messages"
	"github.com/moadabdou/Kith/api/internal/readstates"
	"github.com/moadabdou/Kith/api/internal/search"
	"github.com/moadabdou/Kith/api/internal/users"
	"github.com/moadabdou/Kith/api/pkg/ratelimit"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

var httpRequestsTotal = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "api_http_requests_total",
		Help: "Total HTTP requests handled, labeled by method, path and status code.",
	},
	[]string{"method", "path", "code"},
)

var httpRequestDuration = prometheus.NewHistogramVec(
	prometheus.HistogramOpts{
		Name:    "api_http_request_duration_seconds",
		Help:    "HTTP request latency in seconds, labeled by method and path.",
		Buckets: prometheus.DefBuckets,
	},
	[]string{"method", "path"},
)

const (
	accessTokenTTL  = 15 * time.Minute
	refreshTokenTTL = 30 * 24 * time.Hour
)

// routeLimiter is implemented by *ratelimit.Limiter (process-local) and
// *ratelimit.RedisLimiter (shared across replicas).
type routeLimiter interface {
	Middleware(key func(r *http.Request) string, bucketName string, next http.Handler) http.Handler
}

// sharedLimiter builds a Redis-backed limiter so rate budgets hold
// globally across API replicas. When REDIS_URL is empty or Redis is
// unreachable it falls back to the in-memory limiter (fail-open:
// shaping, not security).
func sharedLimiter(limit int, window time.Duration) routeLimiter {
	if redisURL := envOr("REDIS_URL", ""); redisURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if client, err := ratelimit.Dial(ctx, redisURL); err == nil {
			slog.Info("rate limiter initialized", "backend", "redis", "limit", limit, "window", window.String())
			return ratelimit.NewRedisLimiter(client, limit, window)
		} else {
			slog.Warn("rate limiter falling back to in-memory", "error", err)
		}
	}
	return ratelimit.NewLimiter(limit, window)
}

func main() {
	initLogger(envOr("LOG_LEVEL", "info"))
	prometheus.MustRegister(httpRequestsTotal, httpRequestDuration)

	port := envOr("PORT", "8080")
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		slog.Error("DATABASE_URL is required")
		os.Exit(1)
	}
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		slog.Error("JWT_SECRET is required")
		os.Exit(1)
	}

	nodeID, err := strconv.ParseInt(envOr("SNOWFLAKE_NODE_ID", "1"), 10, 64)
	if err != nil {
		slog.Error("invalid SNOWFLAKE_NODE_ID", "error", err)
		os.Exit(1)
	}
	node, err := snowflake.NewNode(nodeID)
	if err != nil {
		slog.Error("invalid SNOWFLAKE_NODE_ID", "node_id", nodeID, "error", err)
		os.Exit(1)
	}

	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}

	var redisClient redis.UniversalClient
	if redisURL := envOr("REDIS_URL", ""); redisURL != "" {
		dialCtx, dialCancel := context.WithTimeout(context.Background(), 3*time.Second)
		if rc, err := ratelimit.Dial(dialCtx, redisURL); err == nil {
			redisClient = rc
			slog.Info("redis universal client connected")
		} else {
			slog.Warn("failed to connect to redis", "error", err)
		}
		dialCancel()
	}
	db.SetMaxOpenConns(dbPoolConfig.maxOpen)
	db.SetMaxIdleConns(dbPoolConfig.maxIdle)
	db.SetConnMaxLifetime(dbPoolConfig.maxLifetime)
	slog.Info("database pool configured",
		"max_open", dbPoolConfig.maxOpen,
		"max_idle", dbPoolConfig.maxIdle,
		"max_lifetime", dbPoolConfig.maxLifetime.String())

	jwt := auth.NewJWTManager([]byte(jwtSecret), accessTokenTTL)
	authSvc := auth.NewService(db, node, jwt, refreshTokenTTL)
	mailer := mail.NewMailerFromEnv()
	clientURL := envOr("CLIENT_URL", envOr("APP_URL", "http://localhost:5173"))
	authSvc.SetMailer(mailer, clientURL)
	authHandler := &auth.Handler{Svc: authSvc}

	// Phase 7b: NATS JetStream is the only events bus (EVENTS_BUS=nats|noop).
	// Redis remains in the stack solely as the rate-limit store (Issue #85).
	eventsBus := envOr("EVENTS_BUS", "nats")
	var publisher events.Publisher
	var natsPub *events.NatsPublisher
	switch eventsBus {
	case "nats":
		natsURL := envOr("NATS_URL", "nats://127.0.0.1:4222")
		var err error
		natsPub, err = events.NewNatsPublisher(natsURL)
		if err != nil {
			slog.Error("failed to initialize nats publisher", "url", natsURL, "error", err)
			os.Exit(1)
		}
		defer natsPub.Close()
		publisher = natsPub
		slog.Info("events bus initialized", "bus", "nats", "url", natsURL)
	case "noop":
		publisher = events.NoopPublisher{}
		slog.Info("events bus initialized", "bus", "noop")
	default:
		slog.Error("invalid EVENTS_BUS configuration", "bus", eventsBus)
		os.Exit(1)
	}
	guildsHandler := &guilds.Handler{Svc: guilds.NewService(db, node, publisher)}
	usersHandler := &users.Handler{DB: db, Pub: publisher}

	initScylla := func() (*messages.ScyllaStore, *gocql.Session) {
		scyllaHosts := strings.Split(envOr("SCYLLA_HOSTS", "scylla:9042"), ",")
		scyllaKeyspace := envOr("SCYLLA_KEYSPACE", "kith")
		scyllaConsistency := messages.ParseConsistency(envOr("SCYLLA_CONSISTENCY", "LOCAL_QUORUM"))
		scyllaSession, err := messages.NewScyllaSession(messages.ScyllaConfig{
			Hosts:       scyllaHosts,
			Keyspace:    scyllaKeyspace,
			Consistency: scyllaConsistency,
		})
		if err != nil {
			slog.Error("failed to connect to scylladb", "hosts", scyllaHosts, "error", err)
			os.Exit(1)
		}
		hydrator := messages.NewPostgresAuthorHydrator(db)
		return messages.NewScyllaStore(scyllaSession, hydrator), scyllaSession
	}

	storeModeRaw := os.Getenv("MESSAGES_STORE_MODE")
	if storeModeRaw == "" {
		storeModeRaw = envOr("MESSAGE_STORE", "postgres")
	}
	mode := messages.ParseDualWriteMode(storeModeRaw)

	var scyllaSession *gocql.Session
	var msgStore messages.Store
	switch mode {
	case messages.ModeScyllaOnly:
		var scyllaStore *messages.ScyllaStore
		scyllaStore, scyllaSession = initScylla()
		defer scyllaSession.Close()
		msgStore = scyllaStore
		slog.Info("message store initialized", "mode", "scylla_only", "store", "scylla")
	case messages.ModeDualWritePGPrimary, messages.ModeDualWriteScyllaPrimary:
		pgStore := messages.NewPostgresStore(db)
		var scyllaStore *messages.ScyllaStore
		scyllaStore, scyllaSession = initScylla()
		defer scyllaSession.Close()
		dualStore := messages.NewDualWriteStore(mode, pgStore, scyllaStore)
		msgStore = dualStore
		slog.Info("message store initialized",
			"mode", string(mode),
			"primary", dualStore.PrimaryName(),
			"secondary", dualStore.SecondaryName(),
		)
	default:
		msgStore = messages.NewPostgresStore(db)
		slog.Info("message store initialized", "mode", "postgres_only", "store", "postgres")
	}

	// Read States Store (Phase 8, Issue #103)
	var readStatesStore readstates.Store
	if scyllaSession != nil {
		readStatesStore = readstates.NewScyllaStore(scyllaSession)
		slog.Info("read states store initialized", "store", "scylla")
	} else if scyllaHosts := os.Getenv("SCYLLA_HOSTS"); scyllaHosts != "" {
		session, err := messages.NewScyllaSession(messages.ScyllaConfig{
			Hosts:       strings.Split(scyllaHosts, ","),
			Keyspace:    envOr("SCYLLA_KEYSPACE", "kith"),
			Consistency: messages.ParseConsistency(envOr("SCYLLA_CONSISTENCY", "LOCAL_QUORUM")),
		})
		if err == nil {
			defer session.Close()
			readStatesStore = readstates.NewScyllaStore(session)
			slog.Info("read states store initialized", "store", "scylla")
		} else {
			slog.Warn("failed to connect to scylladb for read states, falling back to memory", "error", err)
			readStatesStore = readstates.NewMemoryStore()
		}
	} else {
		readStatesStore = readstates.NewMemoryStore()
		slog.Info("read states store initialized", "store", "memory")
	}
	readStatesSvc := readstates.NewService(db, readStatesStore, publisher)
	readStatesHandler := readstates.NewHandler(readStatesSvc)

	// Media Storage & Pipeline (Phase 8, Issue #98)
	s3Endpoint := envOr("S3_ENDPOINT", "minio:9000")
	s3AccessKey := envOr("S3_ACCESS_KEY", "kithadmin")
	s3SecretKey := envOr("S3_SECRET_KEY", "kithpassword123")
	s3UseSSL := envOr("S3_USE_SSL", "false") == "true"
	s3PublicURL := envOr("S3_PUBLIC_URL", "http://localhost")
	s3BucketAttachments := envOr("S3_BUCKET_ATTACHMENTS", "attachments")
	maxUploadSizeBytes, _ := strconv.ParseInt(envOr("MAX_UPLOAD_BYTES", envOr("MAX_UPLOAD_SIZE_BYTES", "26214400")), 10, 64) // 25 MB

	mediaStorage, err := media.NewMinIOStorage(media.StorageConfig{
		Endpoint:       s3Endpoint,
		AccessKey:      s3AccessKey,
		SecretKey:      s3SecretKey,
		UseSSL:         s3UseSSL,
		PublicURL:      s3PublicURL,
		PublicEndpoint: envOr("S3_PUBLIC_ENDPOINT", "localhost:9000"),
	})
	if err != nil {
		slog.Error("failed to initialize minio storage", "endpoint", s3Endpoint, "error", err)
		os.Exit(1)
	}

	mediaStore := media.NewPostgresStore(db, mediaStorage.PublicURL)

	var mediaPub media.EventPublisher = media.NoopEventPublisher{}
	if natsPub != nil {
		if mp, err := media.NewNatsEventPublisher(natsPub.JetStream()); err == nil {
			mediaPub = mp
			slog.Info("media jetstream event publisher initialized", "stream", media.MediaStreamName)
		} else {
			slog.Warn("failed to initialize media jetstream publisher, falling back to noop", "error", err)
		}
	}

	mediaSigner := media.NewURLSigner([]byte(jwtSecret), 24*time.Hour)
	mediaService := media.NewService(db, mediaStore, mediaStorage, node, mediaPub, s3BucketAttachments, maxUploadSizeBytes)
	mediaService.SetSigner(mediaSigner)

	// Abandoned Upload Garbage Collection background ticker (Phase 8, Issue #102)
	gcIntervalStr := envOr("MEDIA_GC_INTERVAL", "1h")
	if gcInterval, err := time.ParseDuration(gcIntervalStr); err == nil && gcInterval > 0 {
		go func() {
			ticker := time.NewTicker(gcInterval)
			defer ticker.Stop()
			for range ticker.C {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				_, _, _ = mediaService.PruneAbandonedUploads(ctx, 24*time.Hour, false)
				cancel()
			}
		}()
	}
	mediaHandler := media.NewHandler(mediaService)

	var reactionsStore messages.ReactionsStore
	if scyllaSession != nil {
		reactionsStore = messages.NewScyllaReactionsStore(scyllaSession)
		slog.Info("reactions store initialized", "store", "scylla")
	} else if scyllaHosts := os.Getenv("SCYLLA_HOSTS"); scyllaHosts != "" {
		session, err := messages.NewScyllaSession(messages.ScyllaConfig{
			Hosts:       strings.Split(scyllaHosts, ","),
			Keyspace:    envOr("SCYLLA_KEYSPACE", "kith"),
			Consistency: messages.ParseConsistency(envOr("SCYLLA_CONSISTENCY", "LOCAL_QUORUM")),
		})
		if err == nil {
			defer session.Close()
			reactionsStore = messages.NewScyllaReactionsStore(session)
			slog.Info("reactions store initialized", "store", "scylla")
		} else {
			slog.Warn("failed to connect to scylladb for reactions, falling back to memory", "error", err)
			reactionsStore = messages.NewMemoryReactionsStore()
		}
	} else {
		reactionsStore = messages.NewMemoryReactionsStore()
		slog.Info("reactions store initialized", "store", "memory")
	}

	messagesSvc := messages.NewService(db, msgStore, node, publisher, mediaService)
	messagesSvc.SetSigner(mediaSigner)
	messagesSvc.SetReactionsStore(reactionsStore)
	messagesHandler := messages.NewHandler(
		messagesSvc,
		envInt("API_MSG_MAX_INFLIGHT", messages.DefaultMaxInflight),
	)
	slog.Info("message write path configured",
		"max_inflight", messagesHandler.Inflight.Cap())

	// Guild Custom Emojis & Stickers (Phase 9, Issue #118)
	emojisStore := emojis.NewPostgresStore(db, mediaStorage.PublicURL)
	emojisSvc := emojis.NewService(db, emojisStore, node, mediaStorage, publisher)
	emojisHandler := emojis.NewHandler(emojisSvc)
	messagesSvc.SetEmojiValidator(emojisSvc)
	slog.Info("guild emojis & stickers service initialized")

	// GIF Picker Proxy & Caching (Phase 9, Issue #119)
	klipyAPIKey := envOr("KLIPY_API_KEY", "")
	outboundProxyURL := envOr("OUTBOUND_PROXY_URL", envOr("HTTPS_PROXY", envOr("HTTP_PROXY", "")))
	gifsSvc := gifs.NewService(klipyAPIKey, outboundProxyURL, redisClient, nil)
	gifsHandler := gifs.NewHandler(gifsSvc)
	slog.Info("gifs service initialized", "has_klipy_key", klipyAPIKey != "", "has_proxy", outboundProxyURL != "")

	// Search Rung 2: Meilisearch query engine with ScyllaDB hydration & reconciliation scanner (plan/04 §3–4)
	meiliURL := envOr("MEILISEARCH_URL", "")
	meiliKey := envOr("MEILISEARCH_KEY", "")
	var meiliClient *search.MeiliClient
	if meiliURL != "" {
		meiliClient = search.NewMeiliClient(meiliURL, meiliKey)
	}

	searchOpts := []search.ServiceOption{
		search.WithMessageStore(msgStore),
	}
	if meiliClient != nil {
		searchOpts = append(searchOpts, search.WithSearchClient(meiliClient))
	}
	searchSvc := search.NewService(db, searchOpts...)

	var reconciler *search.Reconciler
	if meiliClient != nil {
		reconciler = search.NewReconciler(search.ReconcilerConfig{
			IndexName:  search.DefaultIndexName,
			SampleSize: 100,
			AutoRepair: true,
		}, db, msgStore, meiliClient)
	}
	searchHandler := search.NewHandler(searchSvc, reconciler)

	// Search indexer: Asynchronous NATS JetStream consumer -> Meilisearch (plan/04 §3, Issue #54)
	searchIndexerEnabled := envOr("SEARCH_INDEXER_ENABLED", "true") == "true"
	if natsPub != nil && meiliClient != nil && searchIndexerEnabled {
		indexer := search.NewIndexer(search.IndexerConfig{
			StreamName:   events.DefaultStreamName,
			ConsumerName: search.DefaultConsumerName,
			IndexName:    search.DefaultIndexName,
			BatchSize:    search.DefaultBatchSize,
			FlushWindow:  search.DefaultFlushWindow,
			Subject:      events.DefaultStreamSubject,
		}, meiliClient, natsPub.Conn(), natsPub.JetStream())

		if err := indexer.Start(context.Background()); err != nil {
			slog.Error("failed to start search indexer", "error", err)
		} else {
			defer indexer.Stop()
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /readyz", readyHandler(db))
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.HandleFunc("GET /api/ping", handlePing)
	mux.HandleFunc("POST /api/auth/register", authHandler.Register)
	mux.HandleFunc("POST /api/auth/login", authHandler.Login)
	mux.HandleFunc("POST /api/auth/refresh", authHandler.Refresh)
	mux.HandleFunc("POST /api/auth/logout", authHandler.Logout)
	mux.HandleFunc("POST /api/auth/verify-email", authHandler.VerifyEmail)
	mux.HandleFunc("POST /api/auth/verify/resend", authHandler.ResendVerification)
	mux.Handle("GET /api/users/@me", auth.RequireAuth(jwt, http.HandlerFunc(usersHandler.Me)))
	mux.Handle("PATCH /api/users/@me", auth.RequireAuth(jwt, http.HandlerFunc(usersHandler.Update)))
	mux.Handle("GET /api/users/@me/guilds", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.MyGuilds)))

	// guilds
	mux.Handle("POST /api/guilds", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.CreateGuild)))
	mux.Handle("GET /api/guilds/{id}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.GetGuild)))
	mux.Handle("PATCH /api/guilds/{id}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.UpdateGuild)))

	// channels
	mux.Handle("GET /api/guilds/{id}/channels", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.ListChannels)))
	mux.Handle("POST /api/guilds/{id}/channels", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.CreateChannel)))
	mux.Handle("PATCH /api/guilds/{id}/channels/{cid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.UpdateChannel)))
	mux.Handle("DELETE /api/guilds/{id}/channels/{cid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.DeleteChannel)))
	mux.Handle("PATCH /api/channels/{id}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.UpdateChannel)))
	mux.Handle("DELETE /api/channels/{id}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.DeleteChannel)))
	mux.Handle("GET /api/channels/{id}/permissions", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.ListChannelOverwrites)))
	mux.Handle("PUT /api/channels/{id}/permissions/{target_id}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.SetChannelOverwrite)))
	mux.Handle("DELETE /api/channels/{id}/permissions/{target_id}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.DeleteChannelOverwrite)))

	// members
	mux.Handle("GET /api/guilds/{id}/members", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.ListMembers)))
	mux.Handle("PUT /api/guilds/{id}/members/{uid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.AddMember)))
	mux.Handle("DELETE /api/guilds/{id}/members/{uid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.RemoveMember)))
	mux.Handle("PUT /api/guilds/{id}/members/{uid}/roles/{rid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.AssignMemberRole)))
	mux.Handle("DELETE /api/guilds/{id}/members/{uid}/roles/{rid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.UnassignMemberRole)))

	// invites
	mux.Handle("POST /api/invites", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.CreateInvite)))
	mux.Handle("POST /api/invites/{code}/join", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.JoinInvite)))

	// roles
	mux.Handle("GET /api/guilds/{id}/roles", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.ListRoles)))
	mux.Handle("POST /api/guilds/{id}/roles", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.CreateRole)))
	mux.Handle("PATCH /api/guilds/{id}/roles/{rid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.UpdateRole)))
	mux.Handle("DELETE /api/guilds/{id}/roles/{rid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.DeleteRole)))
	mux.Handle("GET /api/guilds/{id}/permissions/me", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.GetMyPermissions)))

	// messages — the hot path.
	// POST /messages rate limit: 5/5s per (user, channel), Discord's model
	// (plan/02 §5). Redis-backed so the budget holds globally across
	// replicas (Phase 7b, Issue #85); falls back to in-memory when Redis
	// is unreachable.
	msgLimiter := sharedLimiter(5, 5*time.Second)
	postMessageKey := func(r *http.Request) string {
		uid, _ := auth.UserIDFrom(r.Context())
		cid := r.PathValue("cid")
		if cid == "" {
			cid = r.PathValue("id")
		}
		return strconv.FormatInt(uid, 10) + ":" + cid
	}
	mux.Handle("POST /api/guilds/{id}/channels/{cid}/messages",
		auth.RequireAuth(jwt, msgLimiter.Middleware(postMessageKey, "post-messages", http.HandlerFunc(messagesHandler.Send))))
	mux.Handle("POST /api/channels/{cid}/messages",
		auth.RequireAuth(jwt, msgLimiter.Middleware(postMessageKey, "post-messages", http.HandlerFunc(messagesHandler.Send))))
	mux.Handle("GET /api/guilds/{id}/channels/{cid}/messages",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.List)))
	mux.Handle("GET /api/guilds/{id}/channels/latest",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.ChannelsLatest)))
	mux.Handle("GET /guilds/{id}/channels/latest",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.ChannelsLatest)))
	mux.Handle("GET /api/channels/{cid}/messages",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.List)))
	mux.Handle("PATCH /api/channels/{cid}/messages/{mid}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.Edit)))
	mux.Handle("DELETE /api/channels/{cid}/messages/{mid}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.Delete)))

	// pins (Phase 9, Issue #115)
	mux.Handle("PUT /api/channels/{cid}/pins/{mid}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.Pin)))
	mux.Handle("PUT /api/guilds/{id}/channels/{cid}/pins/{mid}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.Pin)))
	mux.Handle("DELETE /api/channels/{cid}/pins/{mid}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.Unpin)))
	mux.Handle("DELETE /api/guilds/{id}/channels/{cid}/pins/{mid}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.Unpin)))
	mux.Handle("GET /api/channels/{cid}/pins",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.ListPins)))
	mux.Handle("GET /api/guilds/{id}/channels/{cid}/pins",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.ListPins)))

	// reactions (Phase 9, Issue #108)
	rxLimiter := sharedLimiter(5, 5*time.Second)
	rxKey := func(r *http.Request) string {
		uid, _ := auth.UserIDFrom(r.Context())
		return strconv.FormatInt(uid, 10)
	}
	mux.Handle("PUT /api/channels/{cid}/messages/{mid}/reactions/{emoji}/@me",
		auth.RequireAuth(jwt, rxLimiter.Middleware(rxKey, "reactions", http.HandlerFunc(messagesHandler.AddReaction))))
	mux.Handle("PUT /api/guilds/{id}/channels/{cid}/messages/{mid}/reactions/{emoji}/@me",
		auth.RequireAuth(jwt, rxLimiter.Middleware(rxKey, "reactions", http.HandlerFunc(messagesHandler.AddReaction))))
	mux.Handle("DELETE /api/channels/{cid}/messages/{mid}/reactions/{emoji}/@me",
		auth.RequireAuth(jwt, rxLimiter.Middleware(rxKey, "reactions", http.HandlerFunc(messagesHandler.RemoveOwnReaction))))
	mux.Handle("DELETE /api/guilds/{id}/channels/{cid}/messages/{mid}/reactions/{emoji}/@me",
		auth.RequireAuth(jwt, rxLimiter.Middleware(rxKey, "reactions", http.HandlerFunc(messagesHandler.RemoveOwnReaction))))
	mux.Handle("DELETE /api/channels/{cid}/messages/{mid}/reactions/{emoji}/{uid}",
		auth.RequireAuth(jwt, rxLimiter.Middleware(rxKey, "reactions", http.HandlerFunc(messagesHandler.RemoveUserReaction))))
	mux.Handle("DELETE /api/guilds/{id}/channels/{cid}/messages/{mid}/reactions/{emoji}/{uid}",
		auth.RequireAuth(jwt, rxLimiter.Middleware(rxKey, "reactions", http.HandlerFunc(messagesHandler.RemoveUserReaction))))
	mux.Handle("GET /api/channels/{cid}/messages/{mid}/reactions/{emoji}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.ListReactors)))
	mux.Handle("GET /api/guilds/{id}/channels/{cid}/messages/{mid}/reactions/{emoji}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.ListReactors)))

	// read states (Phase 8, Issue #103)
	mux.Handle("POST /api/channels/{id}/messages/{mid}/ack",
		auth.RequireAuth(jwt, http.HandlerFunc(readStatesHandler.Ack)))
	mux.Handle("POST /channels/{id}/messages/{mid}/ack",
		auth.RequireAuth(jwt, http.HandlerFunc(readStatesHandler.Ack)))
	mux.Handle("GET /api/users/@me/read-states",
		auth.RequireAuth(jwt, http.HandlerFunc(readStatesHandler.GetUserReadStates)))
	mux.Handle("GET /users/@me/read-states",
		auth.RequireAuth(jwt, http.HandlerFunc(readStatesHandler.GetUserReadStates)))
	mux.Handle("GET /api/channels/{id}/read-state",
		auth.RequireAuth(jwt, http.HandlerFunc(readStatesHandler.GetChannelReadState)))
	mux.Handle("GET /channels/{id}/read-state",
		auth.RequireAuth(jwt, http.HandlerFunc(readStatesHandler.GetChannelReadState)))

	// media attachments (Phase 8, Issue #98)
	mux.Handle("POST /api/channels/{cid}/attachments",
		auth.RequireAuth(jwt, http.HandlerFunc(mediaHandler.Upload)))
	mux.Handle("POST /api/channels/{cid}/attachments/presign",
		auth.RequireAuth(jwt, http.HandlerFunc(mediaHandler.Presign)))
	mux.Handle("GET /api/channels/{cid}/attachments/{id}",
		auth.RequireAuth(jwt, http.HandlerFunc(mediaHandler.Get)))
	mux.HandleFunc("GET /attachments/{cid}/{aid}/{filename}", mediaHandler.ServeAttachment)
	mux.HandleFunc("GET /attachments/attachments/{cid}/{aid}/{filename}", mediaHandler.ServeAttachment)
	mux.HandleFunc("GET /api/media/attachments/{cid}/{aid}/{filename}", mediaHandler.ServeAttachment)

	// search — Search Rung 1: PostgreSQL pg_trgm full-text search (plan/04 §2, §4).
	// Hard rate limit: 1 req/s per user to prevent search worker starvation.
	// Shared across replicas like the message limiter.
	searchLimiter := sharedLimiter(1, time.Second)
	mux.Handle("GET /api/guilds/{id}/messages/search",
		auth.RequireAuth(jwt, searchLimiter.Middleware(
			func(r *http.Request) string {
				uid, _ := auth.UserIDFrom(r.Context())
				return strconv.FormatInt(uid, 10)
			},
			"search-messages",
			http.HandlerFunc(searchHandler.Search))))
	mux.Handle("POST /api/guilds/{id}/messages/search/reconcile",
		auth.RequireAuth(jwt, http.HandlerFunc(searchHandler.Reconcile)))

	// guild custom emojis & stickers (Phase 9, Issue #118)
	mux.Handle("GET /api/guilds/{id}/emojis",
		auth.RequireAuth(jwt, http.HandlerFunc(emojisHandler.ListEmojis)))
	mux.Handle("POST /api/guilds/{id}/emojis",
		auth.RequireAuth(jwt, http.HandlerFunc(emojisHandler.CreateEmoji)))
	mux.Handle("DELETE /api/guilds/{id}/emojis/{emoji_id}",
		auth.RequireAuth(jwt, http.HandlerFunc(emojisHandler.DeleteEmoji)))

	mux.Handle("GET /api/guilds/{id}/stickers",
		auth.RequireAuth(jwt, http.HandlerFunc(emojisHandler.ListStickers)))
	mux.Handle("POST /api/guilds/{id}/stickers",
		auth.RequireAuth(jwt, http.HandlerFunc(emojisHandler.CreateSticker)))
	mux.Handle("DELETE /api/guilds/{id}/stickers/{sticker_id}",
		auth.RequireAuth(jwt, http.HandlerFunc(emojisHandler.DeleteSticker)))

	// GIF Picker Endpoints (Phase 9, Issue #119)
	mux.Handle("GET /api/gifs/trending",
		auth.RequireAuth(jwt, http.HandlerFunc(gifsHandler.Trending)))
	mux.Handle("GET /api/gifs/search",
		auth.RequireAuth(jwt, http.HandlerFunc(gifsHandler.Search)))
	mux.Handle("GET /api/gifs/categories",
		auth.RequireAuth(jwt, http.HandlerFunc(gifsHandler.Categories)))
	mux.HandleFunc("GET /api/gifs/fallback/{name}", gifsHandler.FallbackAsset)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           instrument(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Isolated pprof debug server on dedicated internal port (plan/architecture: keep business port 8080 separate)
	pprofPort := envOr("PPROF_PORT", "6060")
	var pprofSrv *http.Server
	if pprofPort != "" && pprofPort != "none" {
		pprofMux := http.NewServeMux()
		pprofMux.HandleFunc("GET /debug/pprof/", pprof.Index)
		pprofMux.HandleFunc("GET /debug/pprof/cmdline", pprof.Cmdline)
		pprofMux.HandleFunc("GET /debug/pprof/profile", pprof.Profile)
		pprofMux.HandleFunc("GET /debug/pprof/symbol", pprof.Symbol)
		pprofMux.HandleFunc("GET /debug/pprof/trace", pprof.Trace)
		pprofSrv = &http.Server{
			Addr:              ":" + pprofPort,
			Handler:           pprofMux,
			ReadHeaderTimeout: 5 * time.Second,
		}
		go func() {
			slog.Info("isolated pprof debug server listening", "port", pprofPort)
			if err := pprofSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Warn("pprof debug server exited", "error", err)
			}
		}()
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("api listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if pprofSrv != nil {
		_ = pprofSrv.Shutdown(shutdownCtx)
	}
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown failed", "error", err)
	}
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func readyHandler(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			httpx.JSON(w, http.StatusServiceUnavailable, map[string]string{"status": "database unreachable"})
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ready"})
	}
}

func handlePing(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]string{"service": "api", "status": "ok"})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		duration := time.Since(start).Seconds()
		httpRequestsTotal.WithLabelValues(r.Method, r.URL.Path, strconv.Itoa(sw.status)).Inc()
		httpRequestDuration.WithLabelValues(r.Method, r.URL.Path).Observe(duration)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// dbPool holds the postgres pool sizing (Issue #92: sized against the
// shared 200-conn budget — 2 API replicas x 25 + 2 gateways x 25 +
// admin headroom — and verified by dbPoolConfigFromEnv unit tests).
type dbPool struct {
	maxOpen     int
	maxIdle     int
	maxLifetime time.Duration
}

// dbPoolConfig is resolved once at startup from the environment so
// capacity runs can probe pool sensitivity without rebuilding.
var dbPoolConfig = dbPoolConfigFromEnv()

func dbPoolConfigFromEnv() dbPool {
	return dbPool{
		maxOpen:     envInt("PG_POOL_MAX_OPEN_CONNS", 25),
		maxIdle:     envInt("PG_POOL_MAX_IDLE_CONNS", 25),
		maxLifetime: time.Duration(envInt("PG_POOL_MAX_LIFETIME_SEC", 300)) * time.Second,
	}
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func initLogger(level string) {
	var l slog.Level
	switch level {
	case "debug":
		l = slog.LevelDebug
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l})))
}
