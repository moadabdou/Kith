package media

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

type AbandonedAttachment struct {
	ID         int64
	ChannelID  int64
	S3Bucket   string
	S3Key      string
	ByteSize   int64
	Thumbnails json.RawMessage
}

// PruneAbandonedUploads scans for uncommitted uploads in 'pending' status older than `olderThan`,
// deletes their MinIO objects, and removes their rows from postgres.
func (s *Service) PruneAbandonedUploads(ctx context.Context, olderThan time.Duration, dryRun bool) (int, int64, error) {
	if s.db == nil {
		return 0, 0, nil
	}

	cutoff := time.Now().Add(-olderThan)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, channel_id, s3_bucket, s3_key, byte_size, COALESCE(thumbnails, '{}'::jsonb)
		FROM attachments
		WHERE status = 'pending' 
		  AND message_id IS NULL 
		  AND created_at < $1
		ORDER BY created_at ASC
	`, cutoff)
	if err != nil {
		return 0, 0, fmt.Errorf("media gc: query pending attachments failed: %w", err)
	}
	defer rows.Close()

	var abandoned []AbandonedAttachment
	for rows.Next() {
		var a AbandonedAttachment
		if err := rows.Scan(&a.ID, &a.ChannelID, &a.S3Bucket, &a.S3Key, &a.ByteSize, &a.Thumbnails); err != nil {
			return 0, 0, fmt.Errorf("media gc: scan attachment row failed: %w", err)
		}
		abandoned = append(abandoned, a)
	}
	if err := rows.Err(); err != nil {
		return 0, 0, fmt.Errorf("media gc: row iteration error: %w", err)
	}

	if dryRun {
		var totalBytes int64
		for _, a := range abandoned {
			totalBytes += a.ByteSize
		}
		slog.Info("media gc dry run complete", "abandoned_count", len(abandoned), "total_bytes", totalBytes)
		return len(abandoned), totalBytes, nil
	}

	prunedCount := 0
	var freedBytes int64

	for _, a := range abandoned {
		// 1. Remove raw file from MinIO
		bucket := a.S3Bucket
		if bucket == "" {
			bucket = s.bucket
		}
		if a.S3Key != "" && s.storage != nil {
			if err := s.storage.RemoveObject(ctx, bucket, a.S3Key); err != nil {
				slog.Warn("media gc: failed to remove S3 raw object", "key", a.S3Key, "error", err)
			}
		}

		// 2. Remove thumbnails if any exist
		if len(a.Thumbnails) > 0 && string(a.Thumbnails) != "{}" && s.storage != nil {
			var thumbMap map[string]struct {
				S3Key string `json:"s3_key"`
			}
			if err := json.Unmarshal(a.Thumbnails, &thumbMap); err == nil {
				for _, thumb := range thumbMap {
					if thumb.S3Key != "" {
						_ = s.storage.RemoveObject(ctx, bucket, thumb.S3Key)
					}
				}
			}
		}

		// 3. Delete database row
		res, err := s.db.ExecContext(ctx, `DELETE FROM attachments WHERE id = $1 AND status = 'pending'`, a.ID)
		if err != nil {
			slog.Error("media gc: failed to delete attachment row", "id", a.ID, "error", err)
			continue
		}
		affected, _ := res.RowsAffected()
		if affected > 0 {
			prunedCount++
			freedBytes += a.ByteSize
		}
	}

	slog.Info("media gc finished", "pruned_count", prunedCount, "freed_bytes", freedBytes)
	return prunedCount, freedBytes, nil
}
