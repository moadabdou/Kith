package main

import (
	"database/sql"
	"flag"
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
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/messages"
)

type pgMessage struct {
	id        int64
	channelID int64
	authorID  int64
	content   string
}

func main() {
	var (
		batchSize          = flag.Int("batch-size", 1000, "Number of rows to fetch per PostgreSQL cursor batch")
		workers            = flag.Int("workers", 16, "Number of concurrent insertion workers for ScyllaDB")
		rateLimit          = flag.Int("rate-limit", 5000, "Max messages/sec written to ScyllaDB (0 for unlimited)")
		resumeFile         = flag.String("resume-file", "/tmp/kith_backfill_cursor.state", "Path to cursor state file for resuming interrupted backfills")
		resetCursor        = flag.Bool("reset-cursor", false, "Start backfill from newest message, ignoring existing resume file")
		verifyOnly         = flag.Bool("verify-only", false, "Skip backfill and run parity verification between PostgreSQL and ScyllaDB")
		verifySamples      = flag.Int("verify-samples", 10000, "Number of messages to sample for parity verification (0 for all)")
		strategy           = flag.String("strategy", "simple", "Backfill strategy: 'simple' (individual concurrent writes) or 'partition-batch' (partition-affinity single-partition batching)")
		partitionBatchSize = flag.Int("partition-batch-size", 50, "Max messages per single-partition CQL batch in partition-batch strategy")
		dbURL              = flag.String("db-url", "", "PostgreSQL DATABASE_URL")
		scyllaHosts        = flag.String("scylla-hosts", "", "ScyllaDB hosts (comma separated)")
		scyllaKey          = flag.String("scylla-keyspace", "", "ScyllaDB keyspace")
	)
	flag.Parse()

	if *dbURL == "" {
		*dbURL = os.Getenv("DATABASE_URL")
		if *dbURL == "" {
			*dbURL = "postgres://discord:discord@127.0.0.1:5432/discord?sslmode=disable"
		}
	}
	if *scyllaHosts == "" {
		*scyllaHosts = os.Getenv("SCYLLA_HOSTS")
		if *scyllaHosts == "" {
			*scyllaHosts = "127.0.0.1:9042"
		}
	}
	if *scyllaKey == "" {
		*scyllaKey = os.Getenv("SCYLLA_KEYSPACE")
		if *scyllaKey == "" {
			*scyllaKey = "kith"
		}
	}

	fmt.Println("=================================================================")
	if *verifyOnly {
		fmt.Println("     KITH: POSTGRESQL ➔ SCYLLADB PARITY VERIFICATION ENGINE      ")
	} else {
		fmt.Println("     KITH: POSTGRESQL ➔ SCYLLADB HISTORICAL BACKFILL WORKER      ")
	}
	fmt.Println("=================================================================")
	fmt.Printf("• PostgreSQL:     %s\n", sanitizeURL(*dbURL))
	fmt.Printf("• ScyllaDB Hosts: %s (Keyspace: %s)\n", *scyllaHosts, *scyllaKey)
	if !*verifyOnly {
		fmt.Printf("• Strategy:       %s\n", *strategy)
		if *strategy == "partition-batch" || *strategy == "partition_batch" {
			fmt.Printf("• Partition Batch:%d msgs/batch\n", *partitionBatchSize)
		}
		fmt.Printf("• Batch Size:     %d rows\n", *batchSize)
		fmt.Printf("• Workers:        %d goroutines\n", *workers)
		if *rateLimit > 0 {
			fmt.Printf("• Rate Limit:     %d msg/sec\n", *rateLimit)
		} else {
			fmt.Println("• Rate Limit:     unlimited")
		}
		fmt.Printf("• Resume File:    %s\n", *resumeFile)
	} else {
		fmt.Printf("• Verify Samples: %d rows (0 = all)\n", *verifySamples)
	}
	fmt.Println("-----------------------------------------------------------------")

	// 1. Connect to PostgreSQL
	fmt.Print("→ Connecting to PostgreSQL... ")
	pgDB, err := sql.Open("pgx", *dbURL)
	if err != nil {
		log.Fatalf("failed to connect to PostgreSQL: %v", err)
	}
	defer pgDB.Close()
	if err := pgDB.Ping(); err != nil {
		log.Fatalf("failed to ping PostgreSQL: %v", err)
	}
	fmt.Println("DONE")

	// 2. Connect to ScyllaDB
	fmt.Print("→ Connecting to ScyllaDB... ")
	cluster := gocql.NewCluster(strings.Split(*scyllaHosts, ",")...)
	cluster.Keyspace = *scyllaKey
	cluster.Consistency = gocql.One
	cluster.Timeout = 5 * time.Second
	cluster.NumConns = *workers
	scyllaSession, err := cluster.CreateSession()
	if err != nil {
		log.Fatalf("failed to connect to ScyllaDB: %v", err)
	}
	defer scyllaSession.Close()
	fmt.Println("DONE")

	if *verifyOnly {
		runParityVerification(pgDB, scyllaSession, *verifySamples, *workers)
		return
	}

	if *strategy == "partition-batch" || *strategy == "partition_batch" {
		runPartitionBackfill(pgDB, scyllaSession, *batchSize, *partitionBatchSize, *workers, *rateLimit, *resumeFile, *resetCursor)
		return
	}

	runBackfill(pgDB, scyllaSession, *batchSize, *workers, *rateLimit, *resumeFile, *resetCursor)
}

func runBackfill(pgDB *sql.DB, session *gocql.Session, batchSize, numWorkers, rateLimit int, resumeFile string, resetCursor bool) {
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
	var totalErrors atomic.Int64
	batchCount := 0

	fmt.Printf("\n→ Starting migration at cursor %d...\n", cursor)

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
		`, cursor, batchSize)
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

		batchCount++
		minIDInBatch := batch[len(batch)-1].id

		// 2. Concurrently insert into ScyllaDB via worker pool
		var wg sync.WaitGroup
		msgChan := make(chan pgMessage, len(batch))

		for w := 0; w < numWorkers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for m := range msgChan {
					bucket := messages.BucketForMessageID(m.id)
					if err := session.Query(cqlInsert, m.channelID, bucket, m.id, m.authorID, m.content).Exec(); err != nil {
						totalErrors.Add(1)
						log.Printf("error inserting message %d into Scylla: %v", m.id, err)
					} else {
						totalMigrated.Add(1)
					}
				}
			}()
		}

		for _, m := range batch {
			msgChan <- m
		}
		close(msgChan)
		wg.Wait()

		// 3. Throttling / rate limiter
		batchDuration := time.Since(batchStart)
		if rateLimit > 0 {
			expectedDuration := time.Duration(len(batch)) * time.Second / time.Duration(rateLimit)
			if batchDuration < expectedDuration {
				time.Sleep(expectedDuration - batchDuration)
			}
		}

		// 4. Update cursor state checkpoint
		cursor = minIDInBatch
		if err := os.WriteFile(resumeFile, []byte(strconv.FormatInt(cursor, 10)), 0644); err != nil {
			log.Printf("warning: failed to write resume checkpoint file: %v", err)
		}

		// Telemetry progress log
		elapsed := time.Since(startTime).Seconds()
		rate := float64(totalMigrated.Load()) / elapsed
		fmt.Printf("   [Batch %4d] Migrated %7d rows | Rate: %6.0f rows/s | Cursor: %d | Errors: %d\n",
			batchCount, totalMigrated.Load(), rate, cursor, totalErrors.Load())
	}

	totalDur := time.Since(startTime)
	rate := float64(totalMigrated.Load()) / totalDur.Seconds()
	fmt.Println("-----------------------------------------------------------------")
	fmt.Printf("✔ BACKFILL FINISHED: %d rows migrated in %.2fs (%.0f rows/sec)\n",
		totalMigrated.Load(), totalDur.Seconds(), rate)
	fmt.Printf("✔ Total Errors: %d\n", totalErrors.Load())
	fmt.Println("=================================================================")
}

func runParityVerification(pgDB *sql.DB, session *gocql.Session, sampleCount, numWorkers int) {
	fmt.Println("\n→ Fetching sample rows from PostgreSQL...")

	query := `SELECT id, channel_id, author_id, content FROM messages ORDER BY id DESC`
	if sampleCount > 0 {
		query += fmt.Sprintf(" LIMIT %d", sampleCount)
	}

	rows, err := pgDB.Query(query)
	if err != nil {
		log.Fatalf("error querying PostgreSQL for verification: %v", err)
	}
	defer rows.Close()

	var toVerify []pgMessage
	for rows.Next() {
		var m pgMessage
		if err := rows.Scan(&m.id, &m.channelID, &m.authorID, &m.content); err != nil {
			log.Fatalf("error scanning PG row: %v", err)
		}
		toVerify = append(toVerify, m)
	}

	totalRows := len(toVerify)
	fmt.Printf("✔ Retrieved %d rows from PostgreSQL to verify against ScyllaDB.\n", totalRows)
	fmt.Printf("→ Running concurrent parity verification using %d workers...\n", numWorkers)

	cqlSelect := `SELECT author_id, content FROM messages WHERE channel_id = ? AND bucket = ? AND message_id = ?`

	var matched atomic.Int64
	var missing atomic.Int64
	var mismatched atomic.Int64

	start := time.Now()
	msgChan := make(chan pgMessage, 1000)
	var wg sync.WaitGroup

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for m := range msgChan {
				bucket := messages.BucketForMessageID(m.id)
				var scyllaAuthorID int64
				var scyllaContent string

				err := session.Query(cqlSelect, m.channelID, bucket, m.id).Scan(&scyllaAuthorID, &scyllaContent)
				if err != nil {
					if err == gocql.ErrNotFound {
						missing.Add(1)
						log.Printf("   ❌ MISSING: Message %d (channel %d) not found in ScyllaDB", m.id, m.channelID)
					} else {
						mismatched.Add(1)
						log.Printf("   ❌ ERROR: Failed to query ScyllaDB for msg %d: %v", m.id, err)
					}
					continue
				}

				if scyllaAuthorID != m.authorID || scyllaContent != m.content {
					mismatched.Add(1)
					log.Printf("   ❌ MISMATCH: Msg %d - PG(author=%d, content=%q) vs Scylla(author=%d, content=%q)",
						m.id, m.authorID, m.content, scyllaAuthorID, scyllaContent)
					continue
				}

				matched.Add(1)
			}
		}()
	}

	for _, m := range toVerify {
		msgChan <- m
	}
	close(msgChan)
	wg.Wait()

	duration := time.Since(start)
	rate := float64(totalRows) / duration.Seconds()

	fmt.Println("\n-----------------------------------------------------------------")
	fmt.Println("PARITY VERIFICATION RESULTS:")
	fmt.Printf("• Total Rows Sampled: %d\n", totalRows)
	fmt.Printf("• Exact Matches:      %d\n", matched.Load())
	fmt.Printf("• Missing in Scylla:  %d\n", missing.Load())
	fmt.Printf("• Content Mismatches: %d\n", mismatched.Load())
	fmt.Printf("• Verification Time:  %.2fs (%.0f rows/sec)\n", duration.Seconds(), rate)
	fmt.Println("-----------------------------------------------------------------")

	if missing.Load() > 0 || mismatched.Load() > 0 {
		fmt.Printf("❌ FAILED: Found %d missing and %d mismatched rows between PG and ScyllaDB\n",
			missing.Load(), mismatched.Load())
		os.Exit(1)
	}

	fmt.Println("✔ SUCCESS: 100% PARITY CONFIRMED! 0 MISMATCHES DETECTED.")
	fmt.Println("=================================================================")
}

func sanitizeURL(raw string) string {
	parts := strings.Split(raw, "@")
	if len(parts) == 2 {
		return "postgres://***:***@" + parts[1]
	}
	return raw
}
