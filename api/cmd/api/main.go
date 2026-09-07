package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/auth"
	"github.com/moadabdou/Kith/api/internal/events"
	"github.com/moadabdou/Kith/api/internal/guilds"
	"github.com/moadabdou/Kith/api/internal/httpx"
	"github.com/moadabdou/Kith/api/internal/messages"
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

	jwt := auth.NewJWTManager([]byte(jwtSecret), accessTokenTTL)
	authSvc := auth.NewService(db, node, jwt, refreshTokenTTL)
	authHandler := &auth.Handler{Svc: authSvc}
	usersHandler := &users.Handler{DB: db}
	guildsHandler := &guilds.Handler{Svc: guilds.NewService(db, node)}
	// Phase 1: Redis Streams first behind events.Publisher (EVENTS_BUS=redis|noop).
	eventsBus := envOr("EVENTS_BUS", "noop")
	var publisher events.Publisher
	switch eventsBus {
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
	messagesHandler := &messages.Handler{Svc: messages.NewService(db, node, publisher)}

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

	// members
	mux.Handle("GET /api/guilds/{id}/members", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.ListMembers)))
	mux.Handle("PUT /api/guilds/{id}/members/{uid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.AddMember)))
	mux.Handle("DELETE /api/guilds/{id}/members/{uid}", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.RemoveMember)))

	// invites
	mux.Handle("POST /api/invites", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.CreateInvite)))
	mux.Handle("POST /api/invites/{code}/join", auth.RequireAuth(jwt, http.HandlerFunc(guildsHandler.JoinInvite)))

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

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           instrument(mux),
		ReadHeaderTimeout: 5 * time.Second,
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
