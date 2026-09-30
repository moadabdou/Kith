package main

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"runtime"
	"runtime/debug"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gocql/gocql"
)

type LatencyTracker struct {
	mu      sync.Mutex
	samples []time.Duration
}

func (lt *LatencyTracker) Record(d time.Duration) {
	lt.mu.Lock()
	lt.samples = append(lt.samples, d)
	lt.mu.Unlock()
}

func (lt *LatencyTracker) Reset() []time.Duration {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	res := lt.samples
	lt.samples = make([]time.Duration, 0, len(res))
	return res
}

func calcPercentiles(durations []time.Duration) (p50, p90, p99, p999, max time.Duration) {
	if len(durations) == 0 {
		return 0, 0, 0, 0, 0
	}
	sort.Slice(durations, func(i, j int) bool {
		return durations[i] < durations[j]
	})
	n := len(durations)
	p50 = durations[n*50/100]
	p90 = durations[n*90/100]
	p99 = durations[n*99/100]
	p999 = durations[n*999/1000]
	max = durations[n-1]
	return
}

func main() {
	scyllaHost := flag.String("scylla", "127.0.0.1:9042", "ScyllaDB host:port")
	keyspace := flag.String("keyspace", "kith", "ScyllaDB keyspace")
	targetRPS := flag.Int("rps", 5000, "Target sustained ACKs per second")
	duration := flag.Duration("duration", 20*time.Second, "Benchmark duration")
	concurrency := flag.Int("concurrency", 64, "Number of concurrent worker goroutines")
	totalRows := flag.Int64("rows", 10_000_000, "Simulated key space size (10M rows)")
	apiURL := flag.String("api-url", "", "If set, benchmark via HTTP POST /api/channels/{id}/messages/{mid}/ack")
	apiToken := flag.String("api-token", "", "JWT Bearer token if benchmarking via HTTP")
	flag.Parse()

	fmt.Printf("=== ScyllaDB Read States 5,000 acks/sec GC Benchmark ===\n")
	fmt.Printf("Target: %d acks/sec | Duration: %s | Keyspace: %d rows | Concurrency: %d\n",
		*targetRPS, duration.String(), *totalRows, *concurrency)

	var session *gocql.Session
	var httpClient *http.Client

	if *apiURL != "" {
		fmt.Printf("Mode: HTTP REST (%s)\n", *apiURL)
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.MaxIdleConns = 1000
		t.MaxIdleConnsPerHost = 1000
		t.MaxConnsPerHost = 1000
		httpClient = &http.Client{Transport: t, Timeout: 3 * time.Second}
	} else {
		fmt.Printf("Mode: ScyllaDB Direct Point Upsert (%s/%s)\n", *scyllaHost, *keyspace)
		cluster := gocql.NewCluster(*scyllaHost)
		cluster.Keyspace = *keyspace
		cluster.Consistency = gocql.One
		cluster.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(gocql.RoundRobinHostPolicy())
		cluster.NumConns = 8
		cluster.Timeout = 2 * time.Second

		var err error
		session, err = cluster.CreateSession()
		if err != nil {
			log.Fatalf("failed to connect to scylladb: %v", err)
		}
		defer session.Close()
	}

	var totalOps atomic.Int64
	var errOps atomic.Int64
	var tracker LatencyTracker
	var overallTracker LatencyTracker

	ctx, cancel := context.WithTimeout(context.Background(), *duration)
	defer cancel()

	// Rate limiter: generate burst tokens at target rate
	burstSize := *targetRPS / 50 // 50 ticks per sec
	if burstSize < 1 {
		burstSize = 1
	}
	tickInterval := time.Second / 50
	workChan := make(chan struct{}, *targetRPS*2)

	go func() {
		ticker := time.NewTicker(tickInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				close(workChan)
				return
			case <-ticker.C:
				for i := 0; i < burstSize; i++ {
					select {
					case workChan <- struct{}{}:
					default:
					}
				}
			}
		}
	}()

	// Query prepared statement for LWT-free point upsert
	cqlQuery := `INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count) VALUES (?, ?, ?, ?)`

	// Worker pool
	var wg sync.WaitGroup
	for w := 0; w < *concurrency; w++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(time.Now().UnixNano() + int64(workerID*1000)))

			for range workChan {
				// Pick pseudo-random user and channel in 10M key space
				// e.g., 100,000 users across 100 channels = 10,000,000 rows
				userID := 1_000_000_000 + rng.Int63n(100_000)
				channelID := 2_000_000_000 + rng.Int63n(100)
				msgID := 10_000_000_000_000_000 + rng.Int63n(1_000_000_000)
				mentionCount := rng.Intn(3)

				t0 := time.Now()
				var err error

				if httpClient != nil {
					url := fmt.Sprintf("%s/api/channels/%d/messages/%d/ack", *apiURL, channelID, msgID)
					body := bytes.NewReader([]byte(`{"manual":false,"mention_count":0}`))
					req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
					req.Header.Set("Content-Type", "application/json")
					if *apiToken != "" {
						req.Header.Set("Authorization", "Bearer "+*apiToken)
					}
					resp, reqErr := httpClient.Do(req)
					if reqErr != nil {
						err = reqErr
					} else {
						resp.Body.Close()
						if resp.StatusCode >= 300 {
							err = fmt.Errorf("status %d", resp.StatusCode)
						}
					}
				} else {
					err = session.Query(cqlQuery, userID, channelID, msgID, mentionCount).WithContext(ctx).Exec()
				}

				lat := time.Since(t0)
				if err != nil {
					if errOps.Add(1) == 1 {
						log.Printf("first query error: %v", err)
					}
				} else {
					totalOps.Add(1)
					tracker.Record(lat)
					overallTracker.Record(lat)
				}
			}
		}(w)
	}

	// Reporter & GC Monitor loop: sample every 1s
	fmt.Printf("\n%-8s | %-10s | %-8s | %-8s | %-8s | %-8s | %-10s | %-12s | %-10s\n",
		"Elapsed", "Throughput", "p50", "p90", "p99", "p99.9", "HeapAlloc", "GC Pauses", "Last Pause")
	fmt.Println("-------------------------------------------------------------------------------------------------------------")

	startTime := time.Now()
	reportTicker := time.NewTicker(1 * time.Second)
	defer reportTicker.Stop()

	var lastOps int64
	var lastGCStats debug.GCStats
	debug.ReadGCStats(&lastGCStats)

	var allP50, allP99, allP999 []time.Duration
	var maxObservedP99 time.Duration

	for {
		select {
		case <-ctx.Done():
			goto Done
		case <-reportTicker.C:
			elapsed := time.Since(startTime).Round(time.Second)
			curOps := totalOps.Load()
			intervalOps := curOps - lastOps
			lastOps = curOps

			// Latency percentiles for this 1s slice
			samples := tracker.Reset()
			p50, p90, p99, p999, _ := calcPercentiles(samples)
			allP50 = append(allP50, p50)
			allP99 = append(allP99, p99)
			allP999 = append(allP999, p999)
			if p99 > maxObservedP99 {
				maxObservedP99 = p99
			}

			// Memory and GC statistics
			var memStats runtime.MemStats
			runtime.ReadMemStats(&memStats)

			var gcStats debug.GCStats
			debug.ReadGCStats(&gcStats)
			gcCountDiff := gcStats.NumGC - lastGCStats.NumGC
			lastPause := time.Duration(0)
			if len(gcStats.Pause) > 0 {
				lastPause = gcStats.Pause[0]
			}
			lastGCStats = gcStats

			fmt.Printf("%-8s | %6d rps | %-8s | %-8s | %-8s | %-8s | %8.1f MB | +%2d GCs (%s) | %-10s\n",
				elapsed.String(),
				intervalOps,
				p50.Round(time.Microsecond).String(),
				p90.Round(time.Microsecond).String(),
				p99.Round(time.Microsecond).String(),
				p999.Round(time.Microsecond).String(),
				float64(memStats.Alloc)/(1024*1024),
				gcCountDiff,
				gcStats.PauseTotal.Round(time.Millisecond).String(),
				lastPause.Round(time.Microsecond).String(),
			)
		}
	}

Done:
	wg.Wait()
	totalSec := time.Since(startTime).Seconds()
	overallRPS := float64(totalOps.Load()) / totalSec
	overallP50, overallP90, overallP99, overallP999, overallMax := calcPercentiles(overallTracker.Reset())

	fmt.Println("-------------------------------------------------------------------------------------------------------------")
	fmt.Printf("Benchmark Complete!\n")
	fmt.Printf("Total ACKs: %d in %.2fs (Average: %.1f acks/sec)\n", totalOps.Load(), totalSec, overallRPS)
	fmt.Printf("Errors: %d\n", errOps.Load())
	fmt.Printf("Latency Profile:\n")
	fmt.Printf("  p50:   %s\n", overallP50.Round(time.Microsecond))
	fmt.Printf("  p90:   %s\n", overallP90.Round(time.Microsecond))
	fmt.Printf("  p99:   %s (Peak slice p99: %s)\n", overallP99.Round(time.Microsecond), maxObservedP99.Round(time.Microsecond))
	fmt.Printf("  p99.9: %s\n", overallP999.Round(time.Microsecond))
	fmt.Printf("  Max:   %s\n", overallMax.Round(time.Microsecond))

	var finalGC debug.GCStats
	debug.ReadGCStats(&finalGC)
	fmt.Printf("Garbage Collection Totals:\n")
	fmt.Printf("  Total GC Cycles: %d\n", finalGC.NumGC)
	fmt.Printf("  Total GC Pause Time: %s\n", finalGC.PauseTotal)
	if len(finalGC.Pause) > 0 {
		fmt.Printf("  Max GC Pause Duration: %s\n", finalGC.Pause[0])
	}
}
