package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"time"

	"github.com/moadabdou/Kith/api/pkg/snowflake"
)

const (
	benchmarkFile    = "/tmp/kith_benchmark_meta.json"
	pageSize         = 100
	bucketDurationMs = int64(10 * 24 * time.Hour / time.Millisecond)
)

func bucketForMessageID(id int64) int32 {
	offset := id >> (snowflake.NodeBits + snowflake.SeqBits)
	return int32(offset / bucketDurationMs)
}

type BenchmarkMeta struct {
	GuildID       int64         `json:"guild_id"`
	ChannelID     int64         `json:"channel_id"`
	AuthorID      int64         `json:"author_id"`
	Email         string        `json:"email"`
	Password      string        `json:"password"`
	TotalMessages int           `json:"total_messages"`
	BucketCounts  map[int32]int `json:"bucket_counts"`
}

type LoginResponse struct {
	Token string `json:"token"`
	User  struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	} `json:"user"`
}

type APIMessage struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	Content   string `json:"content"`
	Author    struct {
		ID       string `json:"id"`
		Username string `json:"username"`
	} `json:"author"`
	Timestamp string `json:"timestamp"`
}

func main() {
	apiBase := os.Getenv("API_URL")
	if apiBase == "" {
		apiBase = "http://127.0.0.1:8080"
	}

	fmt.Println("=================================================================")
	fmt.Println("   KITH: 100K MULTI-BUCKET CROSS-PAGINATION VERIFIER (PHASE 3)  ")
	fmt.Println("=================================================================")

	// 1. Read benchmark metadata
	var meta BenchmarkMeta
	metaData, err := os.ReadFile(benchmarkFile)
	if err != nil {
		log.Fatalf("failed to read %s: %v. Please run seed_multi_bucket_messages.go first", benchmarkFile, err)
	}
	if err := json.Unmarshal(metaData, &meta); err != nil {
		log.Fatalf("failed to parse %s: %v", benchmarkFile, err)
	}

	fmt.Printf("• Target API:        %s\n", apiBase)
	fmt.Printf("• Guild ID:          %d\n", meta.GuildID)
	fmt.Printf("• Channel ID:        %d\n", meta.ChannelID)
	fmt.Printf("• Expected Messages: %d\n", meta.TotalMessages)
	fmt.Print("• Expected Buckets:  ")
	for b, count := range meta.BucketCounts {
		fmt.Printf("[Bucket %d: %d msgs] ", b, count)
	}
	fmt.Println()

	client := &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90 * time.Second,
		},
	}

	// 2. Authenticate
	fmt.Print("\n→ [1/3] Authenticating as bench user... ")
	loginBody, _ := json.Marshal(map[string]string{
		"login":    meta.Email,
		"password": meta.Password,
	})

	resp, err := client.Post(apiBase+"/api/auth/login", "application/json", bytes.NewReader(loginBody))
	if err != nil {
		log.Fatalf("login request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		log.Fatalf("login returned status %d: %s", resp.StatusCode, string(b))
	}

	var loginRes LoginResponse
	if err := json.NewDecoder(resp.Body).Decode(&loginRes); err != nil {
		log.Fatalf("failed to decode login response: %v", err)
	}
	fmt.Printf("DONE (Token received, User: %s)\n", loginRes.User.Username)

	// 3. Paginate backward through entire message history
	fmt.Printf("→ [2/3] Traversing entire message history via GET /api/guilds/%d/channels/%d/messages?limit=%d...\n",
		meta.GuildID, meta.ChannelID, pageSize)

	seenIDs := make(map[int64]int) // id -> index
	var allIDs []int64
	observedBuckets := make(map[int32]int)
	var boundaryCrossings []string

	var cursor string
	page := 0
	var lastID int64 = 0
	var lastBucket int32 = -1
	orderViolations := 0
	duplicates := 0

	var latencies []time.Duration
	startTime := time.Now()

	endpoint := fmt.Sprintf("%s/api/guilds/%d/channels/%d/messages", apiBase, meta.GuildID, meta.ChannelID)

	for {
		reqURL := fmt.Sprintf("%s?limit=%d", endpoint, pageSize)
		if cursor != "" {
			reqURL = fmt.Sprintf("%s&before=%s", reqURL, url.QueryEscape(cursor))
		}

		req, err := http.NewRequest("GET", reqURL, nil)
		if err != nil {
			log.Fatalf("failed to create request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+loginRes.Token)

		t0 := time.Now()
		res, err := client.Do(req)
		dur := time.Since(t0)
		latencies = append(latencies, dur)

		if err != nil {
			log.Fatalf("page %d request failed: %v", page+1, err)
		}

		if res.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(res.Body)
			res.Body.Close()
			log.Fatalf("page %d returned HTTP %d: %s", page+1, res.StatusCode, string(body))
		}

		nextCursorHeader := res.Header.Get("X-Next-Cursor")

		var batch []APIMessage
		if err := json.NewDecoder(res.Body).Decode(&batch); err != nil {
			res.Body.Close()
			log.Fatalf("failed to decode page %d JSON: %v", page+1, err)
		}
		res.Body.Close()

		if len(batch) == 0 {
			// Clean termination
			fmt.Printf("   🏁 Page %4d: Received 0 messages — reached channel creation boundary cleanly.\n", page+1)
			break
		}

		page++

		for _, m := range batch {
			id, err := strconv.ParseInt(m.ID, 10, 64)
			if err != nil {
				log.Fatalf("invalid message snowflake ID %q: %v", m.ID, err)
			}

			// Duplicate check
			if prevIdx, exists := seenIDs[id]; exists {
				duplicates++
				log.Printf("   ⚠ DUPLICATE DETECTED: message %d seen at index %d and %d", id, prevIdx, len(allIDs))
			} else {
				seenIDs[id] = len(allIDs)
			}
			allIDs = append(allIDs, id)

			// Monotonic descending check
			if lastID > 0 && id >= lastID {
				orderViolations++
				log.Printf("   ⚠ ORDER VIOLATION: message %d is >= previous message %d", id, lastID)
			}
			lastID = id

			// Bucket verification & boundary crossing detection
			bucket := bucketForMessageID(id)
			observedBuckets[bucket]++

			if lastBucket != -1 && bucket != lastBucket {
				crossingMsg := fmt.Sprintf("Page %4d (Msg #%6d): Crossed boundary Bucket %d ➔ Bucket %d",
					page, len(allIDs), lastBucket, bucket)
				boundaryCrossings = append(boundaryCrossings, crossingMsg)
				fmt.Printf("   ⚡ %s\n", crossingMsg)
			}
			lastBucket = bucket
		}

		// Progress reporting every 100 pages (10k messages)
		if page%100 == 0 || len(allIDs) == meta.TotalMessages {
			elapsed := time.Since(startTime).Seconds()
			rate := float64(len(allIDs)) / elapsed
			fmt.Printf("   [%5.1fs] Paginating: page %4d | %6d msgs retrieved | %6.0f msg/s | current bucket: %d\n",
				elapsed, page, len(allIDs), rate, lastBucket)
		}

		// Advance cursor: prefer X-Next-Cursor, fallback to last ID
		if nextCursorHeader != "" {
			cursor = nextCursorHeader
		} else {
			cursor = batch[len(batch)-1].ID
		}
	}

	totalDuration := time.Since(startTime)

	// 4. Verification & Statistical Analysis
	fmt.Println("\n→ [3/3] Analyzing benchmark results & verifying assertions...")
	fmt.Println("-----------------------------------------------------------------")
	fmt.Printf("• Total Execution Time:    %.2fs\n", totalDuration.Seconds())
	fmt.Printf("• Total Pages Requested:   %d\n", page)
	fmt.Printf("• Total Messages Fetched:  %d\n", len(allIDs))
	fmt.Printf("• Expected Total Messages: %d\n", meta.TotalMessages)
	fmt.Printf("• Duplicate Count:         %d\n", duplicates)
	fmt.Printf("• Order Violations:        %d\n", orderViolations)
	fmt.Printf("• Boundary Crossings:      %d\n", len(boundaryCrossings))
	for _, c := range boundaryCrossings {
		fmt.Printf("    • %s\n", c)
	}

	fmt.Println("\n• Message Distribution per Bucket:")
	for b, count := range observedBuckets {
		expected := meta.BucketCounts[b]
		match := "✔"
		if count != expected {
			match = "❌ MISMATCH"
		}
		fmt.Printf("    • Bucket %2d: %6d messages (expected %6d) %s\n", b, count, expected, match)
	}

	// Latency percentiles
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	n := len(latencies)
	p50 := latencies[n*50/100]
	p90 := latencies[n*90/100]
	p95 := latencies[n*95/100]
	p99 := latencies[n*99/100]
	minLat := latencies[0]
	maxLat := latencies[n-1]
	var totalLat time.Duration
	for _, l := range latencies {
		totalLat += l
	}
	avgLat := totalLat / time.Duration(n)

	fmt.Println("\n• API Request Latency (REST pagination):")
	fmt.Printf("    • Min:  %v\n", minLat)
	fmt.Printf("    • Avg:  %v\n", avgLat)
	fmt.Printf("    • p50:  %v\n", p50)
	fmt.Printf("    • p90:  %v\n", p90)
	fmt.Printf("    • p95:  %v\n", p95)
	fmt.Printf("    • p99:  %v\n", p99)
	fmt.Printf("    • Max:  %v\n", maxLat)

	reqPerSec := float64(page) / totalDuration.Seconds()
	msgPerSec := float64(len(allIDs)) / totalDuration.Seconds()
	fmt.Println("\n• Throughput:")
	fmt.Printf("    • Requests/sec: %.1f req/s\n", reqPerSec)
	fmt.Printf("    • Messages/sec: %.1f msg/s\n", msgPerSec)

	// Assertion checks
	failed := false
	if len(allIDs) != meta.TotalMessages {
		fmt.Printf("\n❌ FAILED: Expected %d messages, received %d\n", meta.TotalMessages, len(allIDs))
		failed = true
	}
	if duplicates > 0 {
		fmt.Printf("\n❌ FAILED: Found %d duplicate messages\n", duplicates)
		failed = true
	}
	if orderViolations > 0 {
		fmt.Printf("\n❌ FAILED: Found %d monotonic ordering violations\n", orderViolations)
		failed = true
	}
	if len(boundaryCrossings) < 2 {
		fmt.Printf("\n❌ FAILED: Expected at least 2 bucket boundary crossings, found %d\n", len(boundaryCrossings))
		failed = true
	}
	for b, count := range meta.BucketCounts {
		if observedBuckets[b] != count {
			fmt.Printf("\n❌ FAILED: Bucket %d count mismatch (got %d, expected %d)\n", b, observedBuckets[b], count)
			failed = true
		}
	}

	if failed {
		os.Exit(1)
	}

	fmt.Println("\n=================================================================")
	fmt.Println("  ✔ SUCCESS: ALL 100,000 MESSAGES VERIFIED ACROSS 3 BUCKETS!    ")
	fmt.Println("  ✔ 0 DUPLICATES | STRICT MONOTONIC DESCENDING ORDER | CLEAN EXIT")
	fmt.Println("=================================================================")
}
