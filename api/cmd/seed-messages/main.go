package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"strconv"
	"time"

	"github.com/gocql/gocql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/moadabdou/Kith/api/internal/messages"
	"github.com/moadabdou/Kith/api/internal/search"
	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

type MemberInfo struct {
	ID       int64
	Username string
}

func main() {
	var (
		guildIDStr  = flag.String("guild-id", "90871472406401024", "Guild ID to seed")
		dbURL       = flag.String("db-url", "", "PostgreSQL DATABASE_URL")
		scyllaHosts = flag.String("scylla-hosts", "127.0.0.1:9042", "ScyllaDB hosts")
		scyllaKey   = flag.String("scylla-keyspace", "kith", "ScyllaDB keyspace")
		meiliURL    = flag.String("meili-url", "http://localhost:7700", "Meilisearch URL")
		meiliKey    = flag.String("meili-key", "dev-master-key", "Meilisearch Key")
		numGeneral  = flag.Int("general-count", 200, "Number of messages in #general")
		numTesting  = flag.Int("testing-count", 30, "Number of messages in #testing")
	)
	flag.Parse()

	if *dbURL == "" {
		*dbURL = os.Getenv("DATABASE_URL")
		if *dbURL == "" {
			*dbURL = "postgres://discord:discord@127.0.0.1:5432/discord?sslmode=disable"
		}
	}

	gid, err := strconv.ParseInt(*guildIDStr, 10, 64)
	if err != nil {
		log.Fatalf("invalid guild id: %v", err)
	}

	// Connect to PostgreSQL
	db, err := sql.Open("pgx", *dbURL)
	if err != nil {
		log.Fatalf("failed to open pg: %v", err)
	}
	defer db.Close()

	// Connect to ScyllaDB
	cluster := gocql.NewCluster(*scyllaHosts)
	cluster.Keyspace = *scyllaKey
	cluster.Consistency = gocql.One
	cluster.Timeout = 5 * time.Second
	scyllaSession, err := cluster.CreateSession()
	if err != nil {
		log.Fatalf("failed to connect to ScyllaDB at %s: %v", *scyllaHosts, err)
	}
	defer scyllaSession.Close()
	fmt.Println("Connected to ScyllaDB successfully.")

	// Query channels for guild
	rows, err := db.Query("SELECT id, name FROM channels WHERE guild_id = $1", gid)
	if err != nil {
		log.Fatalf("failed to query channels: %v", err)
	}
	defer rows.Close()

	var generalID, testingID int64
	for rows.Next() {
		var cid int64
		var cname string
		if err := rows.Scan(&cid, &cname); err != nil {
			log.Fatalf("scan channel: %v", err)
		}
		if cname == "general" {
			generalID = cid
		} else if cname == "testing" {
			testingID = cid
		}
	}
	if generalID == 0 {
		log.Fatalf("channel general not found for guild %d", gid)
	}

	// Query members for guild
	mrows, err := db.Query(`
		SELECT u.id, u.username
		FROM users u
		JOIN members m ON m.user_id = u.id
		WHERE m.guild_id = $1
		ORDER BY u.id
	`, gid)
	if err != nil {
		log.Fatalf("failed to query members: %v", err)
	}
	defer mrows.Close()

	var members []MemberInfo
	for mrows.Next() {
		var m MemberInfo
		if err := mrows.Scan(&m.ID, &m.Username); err != nil {
			log.Fatalf("scan member: %v", err)
		}
		members = append(members, m)
	}
	if len(members) == 0 {
		log.Fatalf("no members found for guild %d", gid)
	}
	fmt.Printf("Found %d members in guild %d:\n", len(members), gid)
	for _, m := range members {
		fmt.Printf(" • %s (ID: %d)\n", m.Username, m.ID)
	}

	meiliClient := search.NewMeiliClient(*meiliURL, *meiliKey)

	// Conversational templates
	helloTemplates := []string{
		"hello everyone! Good morning team",
		"hello, has anyone checked the latest search release?",
		"hello world! testing the new chat features",
		"hey hello there, ready for standup?",
		"hello! I noticed a quick bug with the layout",
		"just wanted to say hello to everyone in the channel",
		"hello team, great progress on the infinite scroll!",
		"hello @moadabdou did you push the recent changes?",
		"hello @said can you review my pull request?",
		"hello @omar let me know if you need help testing",
		"hello @ahmed ping me when you are online",
		"hello @moh the database migration completed successfully",
		"hello @abdou the websocket gateway is reconnecting properly",
		"hello folks, checking if message pagination works smoothly",
		"hello again! Just verified the search results drawer",
		"hello there, let's test jump to message in general",
		"hello from the client team, animations look crisp",
		"hello! Don't forget our team sync at 3 PM",
		"quick hello before I start debugging this issue",
		"hello everyone, remember to pull the latest main branch",
	}

	generalTemplates := []string{
		"Working on the search UI redesign right now.",
		"The infinite scroll pagination is loading smoothly across 10-day buckets.",
		"We need to benchmark ScyllaDB partition latency under high load.",
		"Remember to run the chaos drills before releasing Phase 3.",
		"Just merged the fix for message ordering and snowflake sort.",
		"Anyone seeing any lag on the NATS JetStream consumer?",
		"The dark theme styling with glassmorphism looks really premium.",
		"Let's make sure the jump-to-message flash highlight is clearly visible.",
		"Deployed the latest container images to staging.",
		"Database connections are pooled properly with pgx.",
		"Can we add author filters to the search drawer?",
		"Testing message deletion and tombstone purging.",
		"The read-repair hydration in service.go is working as expected.",
		"Frontend build completed in 40 seconds.",
		"Checked Grafana dashboard, consumer lag is 0.",
		"Is anyone working on voice channels next?",
		"Added keyboard navigation with Ctrl+F shortcut.",
		"Good job on closing the previous issues!",
		"The search indexer handles 500 ops/sec without drops.",
		"Everything looks solid and ready for testing.",
	}

	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	type SeedMsg struct {
		ID        int64
		ChannelID int64
		AuthorID  int64
		Content   string
		CreatedAt time.Time
	}

	var allMsgs []SeedMsg

	// Generate messages for a channel
	generateForChannel := func(cid int64, count int) {
		now := time.Now()
		// Spread timestamps backwards over 20 days
		step := (20 * 24 * time.Hour) / time.Duration(count)

		for i := 0; i < count; i++ {
			// Older messages first: from (now - 20d) up to now
			t := now.Add(-time.Duration(count-i) * step).Add(time.Duration(r.Intn(300)) * time.Second)
			tMs := t.UnixMilli()

			// Snowflake ID encoding
			id := ((tMs - snowflake.Epoch) << 22) | (1 << 12) | int64(i&4095)

			author := members[r.Intn(len(members))]

			var content string
			// 40% chance of a "hello" message so search has tons of matches
			if r.Float32() < 0.40 {
				content = helloTemplates[r.Intn(len(helloTemplates))]
			} else {
				content = generalTemplates[r.Intn(len(generalTemplates))]
			}

			allMsgs = append(allMsgs, SeedMsg{
				ID:        id,
				ChannelID: cid,
				AuthorID:  author.ID,
				Content:   content,
				CreatedAt: t,
			})
		}
	}

	generateForChannel(generalID, *numGeneral)
	if testingID != 0 {
		generateForChannel(testingID, *numTesting)
	}

	fmt.Printf("Generated %d messages. Writing to ScyllaDB...\n", len(allMsgs))

	// Insert into ScyllaDB
	cqlInsert := `INSERT INTO messages (channel_id, bucket, message_id, author_id, content, type) VALUES (?, ?, ?, ?, ?, ?)`
	for _, m := range allMsgs {
		bucket := messages.BucketForMessageID(m.ID)
		if err := scyllaSession.Query(cqlInsert, m.ChannelID, bucket, m.ID, m.AuthorID, m.Content, 0).Exec(); err != nil {
			log.Fatalf("failed to insert message %d into ScyllaDB: %v", m.ID, err)
		}
	}
	fmt.Println("Inserted into ScyllaDB successfully.")


	// Index into Meilisearch
	fmt.Println("Indexing into Meilisearch...")
	ctx := context.Background()
	var meiliDocs []search.MessageDocument
	for _, m := range allMsgs {
		meiliDocs = append(meiliDocs, search.MessageDocument{
			ID:        strconv.FormatInt(m.ID, 10),
			GuildID:   strconv.FormatInt(gid, 10),
			ChannelID: strconv.FormatInt(m.ChannelID, 10),
			AuthorID:  strconv.FormatInt(m.AuthorID, 10),
			Content:   m.Content,
			Timestamp: m.CreatedAt.Unix(),
		})
	}

	const batchSize = 100
	for i := 0; i < len(meiliDocs); i += batchSize {
		end := i + batchSize
		if end > len(meiliDocs) {
			end = len(meiliDocs)
		}
		chunk := meiliDocs[i:end]
		if err := meiliClient.IndexDocuments(ctx, "messages", chunk); err != nil {
			log.Fatalf("failed to add documents to meilisearch: %v", err)
		}
		fmt.Printf("Indexed batch of %d documents into Meilisearch\n", len(chunk))
	}

	time.Sleep(1 * time.Second)
	fmt.Println("\nSeeding complete! Breakdown by member:")
	for _, m := range members {
		var cnt int
		for _, msg := range allMsgs {
			if msg.AuthorID == m.ID {
				cnt++
			}
		}
		fmt.Printf(" • %s: %d messages\n", m.Username, cnt)
	}
}
