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
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/internal/guilds"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/internal/messages"
	"github.com/moadabdou/Kith/api/internal/search"
	"github.com/moadabdou/Kith/api/internal/users"
	"github.com/moadabdou/Kith/api/pkg/ratelimit"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
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
	db.SetMaxOpenConns(50)
	db.SetMaxIdleConns(50)
	db.SetConnMaxLifetime(5 * time.Minute)

	jwt := auth.NewJWTManager([]byte(jwtSecret), accessTokenTTL)
	authSvc := auth.NewService(db, node, jwt, refreshTokenTTL)
	authHandler := &auth.Handler{Svc: authSvc}
	usersHandler := &users.Handler{DB: db}
	// Phase 1: NATS JetStream (default) and Redis Streams behind events.Publisher (EVENTS_BUS=nats|redis|noop).
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
	case "redis":
		redisURL := envOr("REDIS_URL", "redis://127.0.0.1:6379")
		redisPub, err := events.NewRedisPublisher(redisURL)
		if err != nil {
			slog.Error("failed to initialize redis publisher", "url", redisURL, "error", err)
			os.Exit(1)
		}
		defer redisPub.Close()
		publisher = redisPub
		slog.Info("events bus initialized", "bus", "redis", "url", redisURL)
	case "noop":
		publisher = events.NoopPublisher{}
		slog.Info("events bus initialized", "bus", "noop")
	default:
		slog.Error("invalid EVENTS_BUS configuration", "bus", eventsBus)
		os.Exit(1)
	}
	guildsHandler := &guilds.Handler{Svc: guilds.NewService(db, node, publisher)}

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

	var msgStore messages.Store
	switch mode {
	case messages.ModeScyllaOnly:
		scyllaStore, scyllaSession := initScylla()
		defer scyllaSession.Close()
		msgStore = scyllaStore
		slog.Info("message store initialized", "mode", "scylla_only", "store", "scylla")
	case messages.ModeDualWritePGPrimary, messages.ModeDualWriteScyllaPrimary:
		pgStore := messages.NewPostgresStore(db)
		scyllaStore, scyllaSession := initScylla()
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

	messagesHandler := &messages.Handler{Svc: messages.NewService(db, msgStore, node, publisher)}

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
	mux.Handle("GET /api/users/@me", auth.RequireAuth(jwt, http.HandlerFunc(usersHandler.Me)))
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
	// (plan/02 §5). In-memory now; Redis swap stays behind the same
	// middleware interface in Phase 1.
	msgLimiter := ratelimit.NewLimiter(5, 5*time.Second)
	mux.Handle("POST /api/guilds/{id}/channels/{cid}/messages",
		auth.RequireAuth(jwt, msgLimiter.Middleware(
			func(r *http.Request) string {
				// Inside RequireAuth: user id is on the context.
				uid, _ := auth.UserIDFrom(r.Context())
				return strconv.FormatInt(uid, 10) + ":" + r.PathValue("cid")
			},
			"post-messages",
			http.HandlerFunc(messagesHandler.Send))))
	mux.Handle("GET /api/guilds/{id}/channels/{cid}/messages",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.List)))
	mux.Handle("PATCH /api/channels/{cid}/messages/{mid}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.Edit)))
	mux.Handle("DELETE /api/channels/{cid}/messages/{mid}",
		auth.RequireAuth(jwt, http.HandlerFunc(messagesHandler.Delete)))

	// search — Search Rung 1: PostgreSQL pg_trgm full-text search (plan/04 §2, §4).
	// Hard rate limit: 1 req/s per user to prevent search worker starvation.
	searchLimiter := ratelimit.NewLimiter(1, time.Second)
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
