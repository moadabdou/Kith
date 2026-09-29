package main

import (
	"context"
	"database/sql"
	"flag"
	"log/slog"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/media"
)

func main() {
	dbURL := flag.String("db", os.Getenv("DATABASE_URL"), "PostgreSQL connection string")
	s3Endpoint := flag.String("s3-endpoint", os.Getenv("S3_ENDPOINT"), "MinIO / S3 endpoint (e.g. 127.0.0.1:9000)")
	s3AccessKey := flag.String("s3-access-key", os.Getenv("S3_ACCESS_KEY"), "MinIO access key")
	s3SecretKey := flag.String("s3-secret-key", os.Getenv("S3_SECRET_KEY"), "MinIO secret key")
	s3Bucket := flag.String("s3-bucket", os.Getenv("S3_BUCKET_ATTACHMENTS"), "S3 bucket for attachments")
	olderThanStr := flag.String("older-than", "24h", "Prune uncommitted pending attachments older than this duration (e.g. 24h, 1h, 10m)")
	dryRun := flag.Bool("dry-run", false, "Preview pruned attachments without deleting from S3 or database")
	flag.Parse()

	if *dbURL == "" {
		slog.Error("DATABASE_URL must be provided via flag or environment")
		os.Exit(1)
	}

	olderThan, err := time.ParseDuration(*olderThanStr)
	if err != nil {
		slog.Error("invalid --older-than duration", "val", *olderThanStr, "error", err)
		os.Exit(1)
	}

	db, err := sql.Open("pgx", *dbURL)
	if err != nil {
		slog.Error("failed to connect to postgres", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if *s3Bucket == "" {
		*s3Bucket = "attachments"
	}

	var storage media.Storage
	if *s3Endpoint != "" {
		st, err := media.NewMinIOStorage(media.StorageConfig{
			Endpoint:  *s3Endpoint,
			AccessKey: *s3AccessKey,
			SecretKey: *s3SecretKey,
			UseSSL:    false,
			PublicURL: "http://localhost:9000",
		})
		if err != nil {
			slog.Warn("could not connect to MinIO for object pruning; proceeding with DB pruning only", "error", err)
		} else {
			storage = st
		}
	}

	svc := media.NewService(db, nil, storage, nil, nil, *s3Bucket, 0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	slog.Info("starting abandoned upload garbage collection", "older_than", olderThan.String(), "dry_run", *dryRun)
	prunedCount, freedBytes, err := svc.PruneAbandonedUploads(ctx, olderThan, *dryRun)
	if err != nil {
		slog.Error("abandoned upload garbage collection failed", "error", err)
		os.Exit(1)
	}

	slog.Info("abandoned upload garbage collection complete", "pruned_count", prunedCount, "freed_bytes", freedBytes)
}
