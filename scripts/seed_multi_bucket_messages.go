package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"crypto/rand"
	"encoding/base64"

	"github.com/gocql/gocql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
	"golang.org/x/crypto/argon2"
)

const (
	oneDayMs         = int64(24 * time.Hour / time.Millisecond)
	bucketDurationMs = 10 * oneDayMs
	totalMessages    = 100000
	numWorkers       = 32
	benchmarkFile    = "/tmp/kith_benchmark_meta.json"
)

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, 3, 64*1024, 4, 32)
	return fmt.Sprintf("$argon2id$v=19$m=65536,t=3,p=4$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

func bucketForMessageID(id int64) int32 {
	offset := id >> (snowflake.NodeBits + snowflake.SeqBits)
	return int32(offset / bucketDurationMs)
}

type BenchmarkMeta struct {
	GuildID       int64 `json:"guild_id"`
	ChannelID     int64 `json:"channel_id"`
	AuthorID      int64 `json:"author_id"`
	Email         string `json:"email"`
	Password      string `json:"password"`
	TotalMessages int    `json:"total_messages"`
	BucketCounts  map[int32]int `json:"bucket_counts"`
}

func main() {
	pgURL := os.Getenv("DATABASE_URL")
	if pgURL == "" {
		pgURL = "postgres://discord:discord@127.0.0.1:5432/discord?sslmode=disable"
	}

	scyllaHost := os.Getenv("SCYLLA_HOSTS")
	if scyllaHost == "" {
		scyllaHost = "127.0.0.1:9042"
	}

	fmt.Println("=================================================================")
	fmt.Println("       KITH: 100,000 MESSAGE MULTI-BUCKET SEEDER (PHASE 3)      ")
	fmt.Println("=================================================================")

	// 1. Initialize PostgreSQL connection for user/guild/channel setup
	fmt.Print("→ [1/4] Connecting to PostgreSQL & seeding test channel... ")
	pgDB, err := sql.Open("pgx", pgURL)
	if err != nil {
		log.Fatalf("failed to connect to PostgreSQL: %v", err)
	}
	defer pgDB.Close()

	authorID := int64(99800000000000001)
	guildID := int64(99800000000000002)

	nowOffset := time.Now().UnixMilli() - snowflake.Epoch
	if nowOffset < 0 {
		nowOffset = 0
	}
	curBucket := int32(nowOffset / bucketDurationMs)
	if curBucket < 2 {
		curBucket = 2
	}
	b1 := curBucket - 2
	b2 := curBucket - 1
	b3 := curBucket

	// Channel creation time: start of Bucket b1
	channelCreationMs := int64(b1) * 10 * oneDayMs
	channelID := (channelCreationMs << (snowflake.NodeBits + snowflake.SeqBits)) | (1 << snowflake.SeqBits) | 1

	pwdHash, err := hashPassword("Password123!")
	if err != nil {
		log.Fatalf("failed to hash password: %v", err)
	}

	// Idempotent upsert of user, guild, member, and channel
	_, err = pgDB.Exec(`
		INSERT INTO users (id, username, discriminator, email, password_hash)
		VALUES ($1, 'bench_pagination', 1, 'bench_pagination@kith.test', $2)
		ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
	`, authorID, pwdHash)
	if err != nil {
		log.Fatalf("failed to insert user: %v", err)
	}

	_, err = pgDB.Exec(`
		INSERT INTO guilds (id, name, owner_id)
		VALUES ($1, 'Multi-Bucket Bench Guild', $2)
		ON CONFLICT (id) DO NOTHING;
	`, guildID, authorID)
	if err != nil {
		log.Fatalf("failed to insert guild: %v", err)
	}

	_, err = pgDB.Exec(`
		INSERT INTO members (guild_id, user_id)
		VALUES ($1, $2)
		ON CONFLICT (guild_id, user_id) DO NOTHING;
	`, guildID, authorID)
	if err != nil {
		log.Fatalf("failed to insert member: %v", err)
	}

	_, err = pgDB.Exec(`
		INSERT INTO channels (id, guild_id, type, name)
		VALUES ($1, $2, 0, 'bench-multi-bucket')
		ON CONFLICT (id) DO NOTHING;
	`, channelID, guildID)
	if err != nil {
		log.Fatalf("failed to insert channel: %v", err)
	}
	fmt.Printf("DONE (Guild: %d, Channel: %d, ChannelBucket: %d, TargetBuckets: [%d, %d, %d])\n",
		guildID, channelID, bucketForMessageID(channelID), b1, b2, b3)

	// 2. Initialize ScyllaDB Session
	fmt.Printf("→ [2/4] Connecting to ScyllaDB at %s... ", scyllaHost)
	cluster := gocql.NewCluster(scyllaHost)
	cluster.Keyspace = "kith"
	cluster.Consistency = gocql.One // fast bulk write locally
	cluster.Timeout = 5 * time.Second
	cluster.NumConns = numWorkers

	session, err := cluster.CreateSession()
	if err != nil {
		log.Fatalf("failed to connect to ScyllaDB: %v", err)
	}
	defer session.Close()
	fmt.Println("DONE")

	// 3. Generate 100,000 messages spanning 3 buckets
	fmt.Println("→ [3/4] Generating 100,000 snowflake IDs spanning 3 buckets...")
	type seedMsg struct {
		id     int64
		bucket int32
	}

	msgs := make([]seedMsg, totalMessages)
	bucketCounts := make(map[int32]int)

	// Bucket b1: 33,333 messages
	// Bucket b2: 33,333 messages
	// Bucket b3: 33,334 messages
	subCounts := []struct {
		startDay int64
		spanDays int64
		count    int
	}{
		{startDay: int64(b1)*10 + 1, spanDays: 8, count: 33333},
		{startDay: int64(b2)*10 + 1, spanDays: 8, count: 33333},
		{startDay: int64(b3)*10 + 1, spanDays: 8, count: 33334},
	}

	idx := 0
	for _, sc := range subCounts {
		stepMs := (sc.spanDays * oneDayMs) / int64(sc.count)
		for i := 0; i < sc.count; i++ {
			msOffset := (sc.startDay * oneDayMs) + int64(i)*stepMs
			seq := int64(i % 4096)
			id := (msOffset << (snowflake.NodeBits + snowflake.SeqBits)) | (1 << snowflake.SeqBits) | seq
			bucket := bucketForMessageID(id)
			msgs[idx] = seedMsg{id: id, bucket: bucket}
			bucketCounts[bucket]++
			idx++
		}
	}

	for bkt, count := range bucketCounts {
		fmt.Printf("   • Bucket %d: %d messages\n", bkt, count)
	}

	// 4. Concurrently insert into ScyllaDB
	fmt.Printf("→ [4/4] Bulk inserting 100,000 messages using %d concurrent workers...\n", numWorkers)
	stmt := `INSERT INTO messages (channel_id, bucket, message_id, author_id, content, type) VALUES (?, ?, ?, ?, ?, ?)`

	start := time.Now()
	var inserted atomic.Int64
	var wg sync.WaitGroup
	msgChan := make(chan seedMsg, 1000)

	for w := 0; w < numWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for m := range msgChan {
				content := fmt.Sprintf("Bench message %d in bucket %d", m.id, m.bucket)
				if err := session.Query(stmt, channelID, m.bucket, m.id, authorID, content, 0).Exec(); err != nil {
					log.Printf("insert error for msg %d: %v", m.id, err)
				}
				inserted.Add(1)
			}
		}()
	}

	// Reporter goroutine
	doneReport := make(chan struct{})
	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-doneReport:
				return
			case <-ticker.C:
				n := inserted.Load()
				elapsed := time.Since(start).Seconds()
				rate := float64(n) / elapsed
				fmt.Printf("   [%5.1fs] Inserted %6d / %d (%6.0f msg/sec)\n", elapsed, n, totalMessages, rate)
			}
		}
	}()

	for _, m := range msgs {
		msgChan <- m
	}
	close(msgChan)
	wg.Wait()
	close(doneReport)

	duration := time.Since(start)
	rate := float64(totalMessages) / duration.Seconds()
	fmt.Printf("\n✔ Successfully seeded %d messages in %.2fs (%.0f msg/sec)\n", totalMessages, duration.Seconds(), rate)

	// Save metadata
	meta := BenchmarkMeta{
		GuildID:       guildID,
		ChannelID:     channelID,
		AuthorID:      authorID,
		Email:         "bench_pagination@kith.test",
		Password:      "Password123!",
		TotalMessages: totalMessages,
		BucketCounts:  bucketCounts,
	}

	data, _ := json.MarshalIndent(meta, "", "  ")
	_ = os.WriteFile(benchmarkFile, data, 0644)
	fmt.Printf("✔ Benchmark metadata written to %s\n\n", benchmarkFile)
}
