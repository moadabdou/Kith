package main

import (
	"database/sql"
	"fmt"
	"log"
	"math"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gocql/gocql"
	"github.com/moadabdou/Kith/api/internal/messages"
)

type partitionKey struct {
	channelID int64
	bucket    int32
}

type singlePartitionBatch struct {
	channelID int64
	bucket    int32
	messages  []pgMessage
}

// runPartitionBackfill implements the two-tier partition-affinity single-partition batching strategy.
// Tier 1 (Router): Groups PostgreSQL messages by (channel_id, bucket) and slices them into batches of up to partitionBatchSize.
// Tier 2 (Sub-Workers): Sub-workers execute single-partition CQL unlogged batches directly against partition owners without coordinator fan-out.
func runPartitionBackfill(pgDB *sql.DB, session *gocql.Session, pgBatchSize, partitionBatchSize, numWorkers, rateLimit int, resumeFile string, resetCursor bool) {
	cursor := int64(math.MaxInt64)

	// Check for resume cursor
	if !resetCursor {
		if data, err := os.ReadFile(resumeFile); err == nil {
			trimmed := strings.TrimSpace(string(data))
			if savedCursor, err := strconv.ParseInt(trimmed, 10, 64); err == nil && savedCursor > 0 {
				cursor = savedCursor
				fmt.Printf("✔ Resuming backfill from cursor %d (loaded from %s)\n", cursor, resumeFile)
			}
		}
	} else {
		_ = os.Remove(resumeFile)
		fmt.Println("✔ Reset cursor flag set: starting from beginning")
	}

	// Graceful shutdown handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	var stopRequested atomic.Bool
	go func() {
		<-sigChan
		fmt.Println("\n\n⚠ Signal received: finishing current batch and saving state...")
		stopRequested.Store(true)
	}()

	cqlInsert := `INSERT INTO messages (channel_id, bucket, message_id, author_id, content, type) VALUES (?, ?, ?, ?, ?, 0)`

	startTime := time.Now()
	var totalMigrated atomic.Int64
	var totalCQLBatches atomic.Int64
	var totalErrors atomic.Int64
	pgBatchCount := 0

	fmt.Printf("\n→ Starting partition-affinity backfill at cursor %d (Partition batch size: %d)...\n",
		cursor, partitionBatchSize)

	for {
		if stopRequested.Load() {
			fmt.Println("✔ Interrupted gracefully. Progress saved. Run again to resume.")
			return
		}

		batchStart := time.Now()

		// 1. Fetch batch from PostgreSQL
		rows, err := pgDB.Query(`
			SELECT id, channel_id, author_id, content
			FROM messages
			WHERE id < $1
			ORDER BY id DESC
			LIMIT $2
		`, cursor, pgBatchSize)
		if err != nil {
			log.Fatalf("error querying PostgreSQL: %v", err)
		}

		var batch []pgMessage
		for rows.Next() {
			var m pgMessage
			if err := rows.Scan(&m.id, &m.channelID, &m.authorID, &m.content); err != nil {
				rows.Close()
				log.Fatalf("error scanning PG row: %v", err)
			}
			batch = append(batch, m)
		}
		rows.Close()

		if len(batch) == 0 {
			fmt.Println("\n✔ Reached the beginning of historical messages in PostgreSQL.")
			_ = os.Remove(resumeFile) // clean up completed state
			break
		}

		pgBatchCount++
		minIDInBatch := batch[len(batch)-1].id

		// 2. Tier 1: Group messages into Partition Queues (ChannelID + 10-day Bucket affinity)
		partitionBuckets := make(map[partitionKey][]pgMessage)
		for _, m := range batch {
			bucket := messages.BucketForMessageID(m.id)
			key := partitionKey{channelID: m.channelID, bucket: bucket}
			partitionBuckets[key] = append(partitionBuckets[key], m)
		}

		// Slice into single-partition CQL batches (up to partitionBatchSize messages each)
		var cqlBatches []singlePartitionBatch
		for key, msgs := range partitionBuckets {
			for i := 0; i < len(msgs); i += partitionBatchSize {
				end := i + partitionBatchSize
				if end > len(msgs) {
					end = len(msgs)
				}
				cqlBatches = append(cqlBatches, singlePartitionBatch{
					channelID: key.channelID,
					bucket:    key.bucket,
					messages:  msgs[i:end],
				})
			}
		}

		// 3. Tier 2: Sub-worker pool executing atomic single-partition Unlogged Batches
		var wg sync.WaitGroup
		batchChan := make(chan singlePartitionBatch, len(cqlBatches))

		for w := 0; w < numWorkers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for pb := range batchChan {
					// Single-partition UNLOGGED batch: zero distributed batchlog overhead,
					// delivered directly to the single owning replica node!
					b := session.NewBatch(gocql.UnloggedBatch)
					for _, m := range pb.messages {
						b.Query(cqlInsert, pb.channelID, pb.bucket, m.id, m.authorID, m.content)
					}

					if err := session.ExecuteBatch(b); err != nil {
						totalErrors.Add(1)
						log.Printf("error executing single-partition batch (channel %d, bucket %d, size %d): %v",
							pb.channelID, pb.bucket, len(pb.messages), err)
					} else {
						totalMigrated.Add(int64(len(pb.messages)))
						totalCQLBatches.Add(1)
					}
				}
			}()
		}

		for _, pb := range cqlBatches {
			batchChan <- pb
		}
		close(batchChan)
		wg.Wait()

		// 4. Rate limiting / throttling
		batchDuration := time.Since(batchStart)
		if rateLimit > 0 {
			expectedDuration := time.Duration(len(batch)) * time.Second / time.Duration(rateLimit)
			if batchDuration < expectedDuration {
				time.Sleep(expectedDuration - batchDuration)
			}
		}

		// 5. Update cursor state checkpoint
		cursor = minIDInBatch
		if err := os.WriteFile(resumeFile, []byte(strconv.FormatInt(cursor, 10)), 0644); err != nil {
			log.Printf("warning: failed to write resume checkpoint file: %v", err)
		}

		// Telemetry progress log
		elapsed := time.Since(startTime).Seconds()
		rate := float64(totalMigrated.Load()) / elapsed
		batchRate := float64(totalCQLBatches.Load()) / elapsed
		fmt.Printf("   [PG-Batch %4d] Migrated %7d rows (%5d CQL batches) | %6.0f rows/s | %4.0f batch/s | Cursor: %d | Errors: %d\n",
			pgBatchCount, totalMigrated.Load(), totalCQLBatches.Load(), rate, batchRate, cursor, totalErrors.Load())
	}

	totalDur := time.Since(startTime)
	rate := float64(totalMigrated.Load()) / totalDur.Seconds()
	fmt.Println("-----------------------------------------------------------------")
	fmt.Printf("✔ PARTITION-BATCH BACKFILL FINISHED: %d rows (%d single-partition batches) in %.2fs (%.0f rows/sec)\n",
		totalMigrated.Load(), totalCQLBatches.Load(), totalDur.Seconds(), rate)
	fmt.Printf("✔ Total Errors: %d\n", totalErrors.Load())
	fmt.Println("=================================================================")
}
