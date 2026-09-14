package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/search"
)

func main() {
	guildID := flag.Int64("guild-id", 0, "Target guild ID (0 for all guilds)")
	sampleSize := flag.Int("sample-size", 100, "Number of primary messages to sample")
	autoRepair := flag.Bool("auto-repair", true, "Automatically repair detected missing/drifted records")
	dbURL := flag.String("db", os.Getenv("DATABASE_URL"), "PostgreSQL connection string")
	meiliURL := flag.String("meili-url", os.Getenv("MEILISEARCH_URL"), "Meilisearch base URL")
	meiliKey := flag.String("meili-key", os.Getenv("MEILISEARCH_KEY"), "Meilisearch master key")
	flag.Parse()

	if *dbURL == "" {
		slog.Error("DATABASE_URL must be provided via flag or environment")
		os.Exit(1)
	}
	if *meiliURL == "" {
		slog.Error("MEILISEARCH_URL must be provided via flag or environment")
		os.Exit(1)
	}

	db, err := sql.Open("pgx", *dbURL)
	if err != nil {
		slog.Error("failed to connect to postgres", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	client := search.NewMeiliClient(*meiliURL, *meiliKey)
	reconciler := search.NewReconciler(search.ReconcilerConfig{
		IndexName:  search.DefaultIndexName,
		SampleSize: *sampleSize,
		AutoRepair: *autoRepair,
	}, db, nil, client)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	fmt.Println("Starting Scylla/Postgres to Meilisearch search reconciliation...")
	report, err := reconciler.Run(ctx, *guildID)
	if err != nil {
		slog.Error("reconciliation failed", "error", err)
		os.Exit(1)
	}

	fmt.Printf("\n=== Reconciliation Report ===\n")
	fmt.Printf("• Scanned Count:       %d\n", report.ScannedCount)
	fmt.Printf("• Missing Fixed:       %d\n", report.MissingFixed)
	fmt.Printf("• Content Drift Fixed: %d\n", report.ContentDriftFixed)
	fmt.Printf("• Tombstones Purged:   %d\n", report.TombstonesPurged)
	fmt.Printf("• Duration:            %v\n", report.Duration)
	fmt.Println("=============================")
}
