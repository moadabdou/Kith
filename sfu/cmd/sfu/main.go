package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/moadabdou/Kith/sfu/internal/bus"
	"github.com/moadabdou/Kith/sfu/internal/peer"
	"github.com/moadabdou/Kith/sfu/internal/room"
	"github.com/moadabdou/Kith/sfu/internal/signaling"
	"github.com/pion/webrtc/v4"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvUint16(key string, fallback uint16) uint16 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseUint(v, 10, 16); err == nil {
			return uint16(n)
		}
	}
	return fallback
}

func main() {
	logLevelStr := strings.ToLower(getEnv("LOG_LEVEL", "info"))
	var logLevel slog.Level
	switch logLevelStr {
	case "debug":
		logLevel = slog.LevelDebug
	case "warn":
		logLevel = slog.LevelWarn
	case "error":
		logLevel = slog.LevelError
	default:
		logLevel = slog.LevelInfo
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: logLevel,
	}))
	slog.SetDefault(logger)

	port := getEnv("PORT", "5000")
	jwtSecret := getEnv("JWT_SECRET", "dev-jwt-secret-change-me")
	natsURL := getEnv("NATS_URL", "nats://127.0.0.1:4222")
	udpMin := getEnvUint16("UDP_PORT_MIN", 50000)
	udpMax := getEnvUint16("UDP_PORT_MAX", 50020)
	natIPsRaw := getEnv("NAT_1TO1_IPS", "")
	stunServer := getEnv("STUN_SERVER", "")

	var natIPs []string
	if natIPsRaw != "" {
		for _, ip := range strings.Split(natIPsRaw, ",") {
			trimmed := strings.TrimSpace(ip)
			if trimmed != "" {
				natIPs = append(natIPs, trimmed)
			}
		}
	}

	stunDisplay := stunServer
	if stunDisplay == "" {
		stunDisplay = "disabled (self-hosted)"
	}

	slog.Info("Starting Pion SFU service",
		"port", port,
		"nats_url", natsURL,
		"udp_range", fmt.Sprintf("%d-%d", udpMin, udpMax),
		"stun_server", stunDisplay,
		"nat_ips", natIPs,
	)

	// 1. Initialize Event Bus Publisher
	var pub bus.Publisher
	if natsURL != "" && natsURL != "none" {
		natsPub, err := bus.NewNatsPublisher(natsURL)
		if err != nil {
			slog.Warn("Failed to connect to NATS event bus; falling back to NoopPublisher", "err", err, "nats_url", natsURL)
			pub = &bus.NoopPublisher{}
		} else {
			slog.Info("Connected to NATS JetStream event bus", "nats_url", natsURL)
			pub = natsPub
			defer natsPub.Close()
		}
	} else {
		pub = &bus.NoopPublisher{}
	}

	// 2. Initialize WebRTC API
	peerCfg := peer.Config{
		UDPPortMin: udpMin,
		UDPPortMax: udpMax,
		NAT1To1IPs: natIPs,
	}

	api, err := peer.CreateAPI(peerCfg)
	if err != nil {
		slog.Error("Failed to initialize WebRTC API", "err", err)
		os.Exit(1)
	}

	rtcConfig := webrtc.Configuration{}
	if stunServer != "" && stunServer != "none" {
		rtcConfig.ICEServers = []webrtc.ICEServer{
			{URLs: []string{stunServer}},
		}
	}

	// 3. Initialize Room Manager & Signaling Server
	roomMgr := room.NewManager(pub)
	sigServer := signaling.NewServer(roomMgr, api, jwtSecret, rtcConfig)

	// 3. HTTP Server & Routes
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/ws", sigServer)

	httpServer := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	// 4. Graceful Shutdown
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		slog.Info("SFU HTTP and Signaling listening", "addr", ":"+port)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("SFU HTTP server failed", "err", err)
			os.Exit(1)
		}
	}()

	<-stop
	slog.Info("Shutting down SFU service...")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		slog.Error("HTTP server shutdown error", "err", err)
	}
	roomMgr.Close()
	slog.Info("SFU service stopped cleanly")
}
