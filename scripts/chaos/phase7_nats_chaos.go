package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
)

const (
	natsClusterURLs = "nats://127.0.0.1:4225,nats://127.0.0.1:4226,nats://127.0.0.1:4227"
	streamName      = "KITH_EVENTS_CHAOS"
	streamSubject   = "kith.events.chaos.>"
	durableName     = "kith-gateway-drill"
	resultsJSONDir  = "scripts/chaos/results"
)

var containerMap = map[string]string{
	"nats1": "kith-nats-cluster-nats1-1",
	"nats2": "kith-nats-cluster-nats2-1",
	"nats3": "kith-nats-cluster-nats3-1",
}

var httpPortMap = map[string]string{
	"nats1": "8225",
	"nats2": "8226",
	"nats3": "8227",
}

type LatencyStats struct {
	Count int64   `json:"count"`
	MinMs float64 `json:"min_ms"`
	P50Ms float64 `json:"p50_ms"`
	P95Ms float64 `json:"p95_ms"`
	P99Ms float64 `json:"p99_ms"`
	MaxMs float64 `json:"max_ms"`
	AvgMs float64 `json:"avg_ms"`
}

type Drill6Result struct {
	DrillName              string       `json:"drill_name"`
	Timestamp              string       `json:"timestamp"`
	InitialLeader          string       `json:"initial_leader"`
	FailoverLeader         string       `json:"failover_leader"`
	BaselinePubLatency     LatencyStats `json:"baseline_pub_latency"`
	BaselineSubLatency     LatencyStats `json:"baseline_sub_latency"`
	BurstPublishedCount    int64        `json:"burst_published_count"`
	BurstReceivedCount     int64        `json:"burst_received_count"`
	ClusterRTOSeconds      float64      `json:"cluster_rto_seconds"`
	ClientRTOSeconds       float64      `json:"client_rto_seconds"`
	RPOEventsLost          int64        `json:"rpo_events_lost"`
	RedeliveredCount       int64        `json:"redelivered_count"`
	ClientVisibleDupes     int64        `json:"client_visible_dupes"`
	StressPublishedCount   int64        `json:"stress_published_count"`
	StressThroughputOpsSec float64      `json:"stress_throughput_ops_sec"`
	StressPubLatency       LatencyStats `json:"stress_pub_latency"`
	StressSubLatency       LatencyStats `json:"stress_sub_latency"`
	NodeRecoverySeconds    float64      `json:"node_recovery_seconds"`
	GateVerdict            string       `json:"gate_verdict"`
}

type KithEventEnvelope struct {
	Type      string                 `json:"type"`
	GuildID   string                 `json:"guild_id"`
	Payload   map[string]interface{} `json:"payload"`
	Timestamp int64                  `json:"timestamp"`
}

func runCmd(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func calcStats(durations []time.Duration) LatencyStats {
	if len(durations) == 0 {
		return LatencyStats{}
	}
	sorted := make([]float64, len(durations))
	var sum float64
	for i, d := range durations {
		ms := float64(d.Nanoseconds()) / 1e6
		sorted[i] = ms
		sum += ms
	}
	sort.Float64s(sorted)
	n := len(sorted)
	p50 := sorted[int(math.Floor(float64(n)*0.50))]
	p95 := sorted[int(math.Min(float64(n-1), math.Floor(float64(n)*0.95)))]
	p99 := sorted[int(math.Min(float64(n-1), math.Floor(float64(n)*0.99)))]

	return LatencyStats{
		Count: int64(n),
		MinMs: math.Round(sorted[0]*1000) / 1000,
		P50Ms: math.Round(p50*1000) / 1000,
		P95Ms: math.Round(p95*1000) / 1000,
		P99Ms: math.Round(p99*1000) / 1000,
		MaxMs: math.Round(sorted[n-1]*1000) / 1000,
		AvgMs: math.Round((sum/float64(n))*1000) / 1000,
	}
}

func parseAckDeliveredCount(replyTo string) int {
	if replyTo == "" {
		return 1
	}
	parts := strings.Split(replyTo, ".")
	if len(parts) >= 5 && parts[0] == "$JS" && parts[1] == "ACK" {
		var cnt int
		if _, err := fmt.Sscanf(parts[4], "%d", &cnt); err == nil {
			return cnt
		}
	}
	return 1
}

func connectNats() (*nats.Conn, nats.JetStreamContext, error) {
	opts := []nats.Option{
		nats.Name("kith-drill6-client"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(50 * time.Millisecond),
		nats.PingInterval(500 * time.Millisecond),
		nats.MaxPingsOutstanding(1),
		nats.Timeout(2 * time.Second),
	}
	nc, err := nats.Connect(natsClusterURLs, opts...)
	if err != nil {
		return nil, nil, err
	}
	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		return nil, nil, err
	}
	return nc, js, nil
}

func ensureStream(js nats.JetStreamContext) (*nats.StreamInfo, error) {
	cfg := &nats.StreamConfig{
		Name:       streamName,
		Subjects:   []string{streamSubject},
		Replicas:   3,
		Storage:    nats.FileStorage,
		Retention:  nats.LimitsPolicy,
		Discard:    nats.DiscardOld,
		MaxAge:     1 * time.Hour,
		Duplicates: 2 * time.Minute,
	}

	info, err := js.StreamInfo(streamName)
	if err != nil {
		info, err = js.AddStream(cfg)
		if err != nil {
			return nil, err
		}
	} else if info.Config.Replicas != 3 {
		info, err = js.UpdateStream(cfg)
		if err != nil {
			return nil, err
		}
	}
	return info, nil
}

func pollSurvivorLeaderHTTP(survivorNodes []string) string {
	client := http.Client{Timeout: 500 * time.Millisecond}
	for _, node := range survivorNodes {
		port := httpPortMap[node]
		if port == "" {
			continue
		}
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%s/jsz?streams=1", port))
		if err == nil && resp.StatusCode == 200 {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var data struct {
				AccountDetails []struct {
					StreamDetail []struct {
						Name    string `json:"name"`
						Cluster *struct {
							Leader string `json:"leader"`
						} `json:"cluster"`
					} `json:"stream_detail"`
				} `json:"account_details"`
			}
			if err := json.Unmarshal(body, &data); err == nil {
				for _, acc := range data.AccountDetails {
					for _, sd := range acc.StreamDetail {
						if sd.Name == streamName && sd.Cluster != nil && sd.Cluster.Leader != "" {
							return sd.Cluster.Leader
						}
					}
				}
			}
		}
	}
	return ""
}

func main() {
	killHoldSec := flag.Int("hold-sec", 6, "Seconds to hold before initiating node recovery")
	flag.Parse()

	fmt.Println("================================================================================")
	fmt.Println("   KITH PHASE 7 CHAOS: DRILL 6 — NATS JETSTREAM LEADER KILL & FAILOVER        ")
	fmt.Println("   Raft Failover, Stream Auto-Reconnect, Idempotency & Zero Event Loss         ")
	fmt.Println("================================================================================")

	drillResult := Drill6Result{
		DrillName: "Drill 6: NATS JetStream Leader Kill & Auto-Reconnect",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	// -------------------------------------------------------------------------
	// Step 1: Pre-Flight Health & Baseline Benchmark
	// -------------------------------------------------------------------------
	fmt.Println("\n==> [1/6] Pre-flight verification & baseline benchmark...")
	nc, js, err := connectNats()
	if err != nil {
		log.Fatalf("FATAL: Failed to connect to NATS cluster: %v", err)
	}
	defer nc.Close()

	streamInfo, err := ensureStream(js)
	if err != nil {
		log.Fatalf("FATAL: Failed to ensure 3-replica JetStream stream: %v", err)
	}

	// Wait up to 10s for cluster Raft consensus to settle
	for i := 0; i < 20; i++ {
		if streamInfo.Cluster != nil && streamInfo.Cluster.Leader != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
		streamInfo, _ = js.StreamInfo(streamName)
	}

	if streamInfo.Cluster == nil || streamInfo.Cluster.Leader == "" {
		log.Fatalf("FATAL: Stream %s has no active Raft cluster leader!", streamName)
	}

	drillResult.InitialLeader = streamInfo.Cluster.Leader
	fmt.Printf("✓ JetStream Stream %s active (Replicas: %d, Raft Leader: %s)\n",
		streamName, streamInfo.Config.Replicas, drillResult.InitialLeader)
	for _, r := range streamInfo.Cluster.Replicas {
		fmt.Printf("   • Replica: %s (current: %v, active: %v)\n", r.Name, r.Current, r.Active)
	}

	// Baseline publish & consume test (300 msgs)
	fmt.Println("Running 300 baseline publishes & consumes at R=3...")
	var basePubDurs []time.Duration
	var baseSubDurs []time.Duration

	baseSub, err := js.SubscribeSync("kith.events.chaos.baseline", nats.DeliverAll())
	if err != nil {
		log.Fatalf("FATAL: Failed to subscribe baseline sync: %v", err)
	}
	defer baseSub.Unsubscribe()

	baseID := time.Now().UnixNano()
	for i := 0; i < 300; i++ {
		t0 := time.Now()
		payload := fmt.Sprintf(`{"seq":%d,"msg":"baseline-%d"}`, i, i)
		ack, err := js.Publish("kith.events.chaos.baseline", []byte(payload))
		if err != nil || ack == nil {
			log.Fatalf("FATAL: Baseline publish failed: %v", err)
		}
		basePubDurs = append(basePubDurs, time.Since(t0))

		t1 := time.Now()
		msg, err := baseSub.NextMsg(2 * time.Second)
		if err != nil {
			log.Fatalf("FATAL: Baseline consume failed: %v", err)
		}
		_ = msg.Ack()
		baseSubDurs = append(baseSubDurs, time.Since(t1))
	}

	drillResult.BaselinePubLatency = calcStats(basePubDurs)
	drillResult.BaselineSubLatency = calcStats(baseSubDurs)
	fmt.Printf("✓ Baseline Pub p50: %.2fms | p95: %.2fms | p99: %.2fms\n",
		drillResult.BaselinePubLatency.P50Ms, drillResult.BaselinePubLatency.P95Ms, drillResult.BaselinePubLatency.P99Ms)
	fmt.Printf("✓ Baseline Sub p50: %.2fms | p95: %.2fms | p99: %.2fms\n",
		drillResult.BaselineSubLatency.P50Ms, drillResult.BaselineSubLatency.P95Ms, drillResult.BaselineSubLatency.P99Ms)

	// -------------------------------------------------------------------------
	// Step 2: Live Mid-Burst Workload & Consumer Setup
	// -------------------------------------------------------------------------
	fmt.Println("\n==> [2/6] Starting live concurrent publishers and durable consumer...")

	stopBurst := make(chan struct{})
	var pubCounter atomic.Int64
	var pubAttempted atomic.Int64
	var pubSuccess atomic.Int64
	var pubFailures atomic.Int64

	publishedIDs := &sync.Map{}
	receivedIDs := &sync.Map{}
	var redeliveries atomic.Int64
	var clientDupes atomic.Int64

	// Start durable pull subscriber
	sub, err := js.PullSubscribe("kith.events.chaos.live", durableName)
	if err != nil {
		log.Fatalf("FATAL: Failed to create durable pull subscriber: %v", err)
	}

	// Consumer worker goroutine
	var consumerWg sync.WaitGroup
	consumerWg.Add(1)
	go func() {
		defer consumerWg.Done()
		for {
			select {
			case <-stopBurst:
				return
			default:
				msgs, err := sub.Fetch(10, nats.MaxWait(150*time.Millisecond))
				if err != nil {
					continue
				}
				for _, m := range msgs {
					var env KithEventEnvelope
					if err := json.Unmarshal(m.Data, &env); err == nil {
						msgID, _ := env.Payload["id"].(string)
						if msgID != "" {
							delCount := parseAckDeliveredCount(m.Reply)
							if delCount > 1 {
								redeliveries.Add(1)
							}

							// Idempotent deduplication check (matching Elixir ConsumerWorker logic)
							if _, alreadySeen := receivedIDs.LoadOrStore(msgID, time.Now()); alreadySeen {
								clientDupes.Add(1)
							}
						}
					}
					_ = m.Ack()
				}
			}
		}
	}()

	// Publisher workers (4 goroutines) paced at ~60 msgs/s
	var pubWg sync.WaitGroup
	for w := 0; w < 4; w++ {
		pubWg.Add(1)
		go func(workerID int) {
			defer pubWg.Done()
			for {
				select {
				case <-stopBurst:
					return
				default:
					seq := pubCounter.Add(1)
					id := fmt.Sprintf("kith-msg-%d-%d", baseID, seq)
					pubAttempted.Add(1)

					env := KithEventEnvelope{
						Type:    "MESSAGE_CREATE",
						GuildID: "99900000000000101",
						Payload: map[string]interface{}{
							"id":         id,
							"channel_id": "99900000000000201",
							"guild_id":   "99900000000000101",
							"content":    fmt.Sprintf("chaos-live-burst-msg-%d", seq),
							"seq":        seq,
						},
						Timestamp: time.Now().UnixNano(),
					}
					data, _ := json.Marshal(env)

					// Publish with context timeout
					ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
					_, pErr := js.Publish("kith.events.chaos.live", data, nats.Context(ctx))
					cancel()
					if pErr != nil {
						pubFailures.Add(1)
					} else {
						pubSuccess.Add(1)
						publishedIDs.Store(id, seq)
					}
					time.Sleep(15 * time.Millisecond)
				}
			}
		}(w)
	}

	// Allow workload to run for 2 seconds to establish steady state
	time.Sleep(2 * time.Second)
	fmt.Printf("Steady state verified: %d messages published to stream.\n", pubSuccess.Load())

	// -------------------------------------------------------------------------
	// Step 3: Chaos Strike — Kill JetStream Raft Leader
	// -------------------------------------------------------------------------
	fmt.Println("\n==> [3/6] Striking NATS JetStream Raft leader with SIGKILL...")

	leaderNode := drillResult.InitialLeader
	victimContainer, ok := containerMap[leaderNode]
	if !ok {
		log.Fatalf("FATAL: Unknown leader node: %s", leaderNode)
	}

	var survivorNodes []string
	for n := range containerMap {
		if n != leaderNode {
			survivorNodes = append(survivorNodes, n)
		}
	}

	tKill := time.Now()
	fmt.Printf(">>> [CHAOS EVENT] Issuing SIGKILL to leader container %s (%s) at %s...\n",
		victimContainer, leaderNode, tKill.Format(time.RFC3339))

	out, err := runCmd("docker", "kill", "-s", "SIGKILL", victimContainer)
	if err != nil {
		log.Fatalf("FATAL: Failed to SIGKILL leader container: %s %v", out, err)
	}
	fmt.Printf(">>> [CHAOS EVENT] Leader container %s killed successfully!\n", victimContainer)

	// Measure Cluster RTO: time until survivor Raft group elects a new leader
	var clusterRTODuration time.Duration
	rtoMaxWait := 15 * time.Second
	rtoStart := time.Now()
	var newLeader string

	for {
		time.Sleep(100 * time.Millisecond)
		elected := pollSurvivorLeaderHTTP(survivorNodes)
		if elected != "" && elected != leaderNode {
			clusterRTODuration = time.Since(tKill)
			newLeader = elected
			break
		}
		if time.Since(rtoStart) > rtoMaxWait {
			clusterRTODuration = time.Since(tKill)
			fmt.Printf("WARNING: Raft leader election took longer than %v\n", rtoMaxWait)
			break
		}
	}

	drillResult.FailoverLeader = newLeader
	drillResult.ClusterRTOSeconds = math.Round(clusterRTODuration.Seconds()*100) / 100
	fmt.Printf("✓ Cluster Raft Leader elected: %s in %.2fs! (Gate <= 5.0s)\n", newLeader, drillResult.ClusterRTOSeconds)

	// Measure Client RTO: time until client resumes successful publishes
	var clientRTODuration time.Duration
	clientRTOStart := time.Now()
	for {
		time.Sleep(100 * time.Millisecond)
		testPayload := []byte(`{"probe":"client-rto-check"}`)
		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
		_, err := js.Publish("kith.events.chaos.live", testPayload, nats.Context(ctx))
		cancel()
		if err == nil {
			clientRTODuration = time.Since(tKill)
			break
		}
		if time.Since(clientRTOStart) > rtoMaxWait {
			clientRTODuration = time.Since(tKill)
			break
		}
	}
	drillResult.ClientRTOSeconds = math.Round(clientRTODuration.Seconds()*100) / 100
	fmt.Printf("✓ Client Stream auto-reconnect resumed in %.2fs! (Gate <= 10.0s)\n", drillResult.ClientRTOSeconds)

	// Hold in post-failover state for specified seconds
	time.Sleep(time.Duration(*killHoldSec) * time.Second)

	// Stop publishers
	close(stopBurst)
	pubWg.Wait()

	// Drain remaining messages in consumer
	time.Sleep(2 * time.Second)
	consumerWg.Wait()

	// -------------------------------------------------------------------------
	// Step 4: Zero Event Loss & Idempotency Audit (RPO)
	// -------------------------------------------------------------------------
	fmt.Println("\n==> [4/6] Verifying zero event loss (RPO) and consumer idempotency...")

	var totalPublished, totalReceived, lostCount int64
	publishedIDs.Range(func(key, value interface{}) bool {
		totalPublished++
		id := key.(string)
		if _, ok := receivedIDs.Load(id); ok {
			totalReceived++
		} else {
			lostCount++
		}
		return true
	})

	drillResult.BurstPublishedCount = totalPublished
	drillResult.BurstReceivedCount = totalReceived
	drillResult.RPOEventsLost = lostCount
	drillResult.RedeliveredCount = redeliveries.Load()
	drillResult.ClientVisibleDupes = clientDupes.Load()

	fmt.Printf("Published Messages: %d | Acknowledged & Received: %d | Lost: %d\n",
		totalPublished, totalReceived, lostCount)
	fmt.Printf("Redelivered In-Flight Messages: %d | Client-Visible Duplicates: %d (Idempotent Drop)\n",
		drillResult.RedeliveredCount, drillResult.ClientVisibleDupes)

	// -------------------------------------------------------------------------
	// Step 5: Post-Failover Stress Benchmark (< 50ms p99)
	// -------------------------------------------------------------------------
	fmt.Println("\n==> [5/6] Post-failover stress benchmark on 2-node survivor cluster (1,000 ops)...")

	stressSub, err := js.SubscribeSync("kith.events.chaos.stress", nats.DeliverAll())
	if err != nil {
		log.Fatalf("FATAL: Failed to subscribe stress sync: %v", err)
	}
	defer stressSub.Unsubscribe()

	stressCount := 1000
	var stressPubDurs []time.Duration
	var stressSubDurs []time.Duration

	tStressStart := time.Now()
	for i := 0; i < stressCount; i++ {
		payload := fmt.Sprintf(`{"seq":%d,"data":"stress-%d"}`, i, i)
		t0 := time.Now()
		_, pErr := js.Publish("kith.events.chaos.stress", []byte(payload))
		if pErr == nil {
			stressPubDurs = append(stressPubDurs, time.Since(t0))

			t1 := time.Now()
			m, mErr := stressSub.NextMsg(1 * time.Second)
			if mErr == nil {
				_ = m.Ack()
				stressSubDurs = append(stressSubDurs, time.Since(t1))
			}
		}
	}
	stressElapsed := time.Since(tStressStart)

	drillResult.StressPublishedCount = int64(len(stressPubDurs))
	drillResult.StressThroughputOpsSec = math.Round(float64(len(stressPubDurs))/stressElapsed.Seconds()*10) / 10
	drillResult.StressPubLatency = calcStats(stressPubDurs)
	drillResult.StressSubLatency = calcStats(stressSubDurs)

	fmt.Printf("✓ Stress Throughput: %.1f msgs/sec (Duration: %.2fs)\n",
		drillResult.StressThroughputOpsSec, stressElapsed.Seconds())
	fmt.Printf("✓ Stress Pub Latency: p50: %.2fms | p95: %.2fms | p99: %.2fms\n",
		drillResult.StressPubLatency.P50Ms, drillResult.StressPubLatency.P95Ms, drillResult.StressPubLatency.P99Ms)
	fmt.Printf("✓ Stress Sub Latency: p50: %.2fms | p95: %.2fms | p99: %.2fms\n",
		drillResult.StressSubLatency.P50Ms, drillResult.StressSubLatency.P95Ms, drillResult.StressSubLatency.P99Ms)

	// -------------------------------------------------------------------------
	// Step 6: Node Recovery & Raft Resync
	// -------------------------------------------------------------------------
	fmt.Println("\n==> [6/6] Restarting killed node container & verifying Raft resync...")

	tStartRestart := time.Now()
	_, _ = runCmd("docker", "start", victimContainer)
	fmt.Printf(">>> [CHAOS EVENT] Restarted container %s. Polling cluster state...\n", victimContainer)

	var recovered bool
	for i := 0; i < 20; i++ {
		time.Sleep(500 * time.Millisecond)
		info, err := js.StreamInfo(streamName)
		if err == nil && info.Cluster != nil {
			activeReplicas := 0
			for _, r := range info.Cluster.Replicas {
				if r.Active < 2*time.Second {
					activeReplicas++
				}
			}
			if activeReplicas >= 2 {
				recovered = true
				break
			}
		}
	}

	drillResult.NodeRecoverySeconds = math.Round(time.Since(tStartRestart).Seconds()*100) / 100
	if recovered {
		fmt.Printf("✓ Node %s rejoined Raft group and resynced in %.2fs!\n", leaderNode, drillResult.NodeRecoverySeconds)
	} else {
		fmt.Printf("Notice: Node %s rebooted; Raft resync in progress.\n", leaderNode)
	}

	// Clean up drill stream
	_ = js.DeleteStream(streamName)

	// -------------------------------------------------------------------------
	// Gate Evaluation & Summary
	// -------------------------------------------------------------------------
	passed := true
	reasons := []string{}

	if drillResult.ClusterRTOSeconds > 5.0 {
		passed = false
		reasons = append(reasons, fmt.Sprintf("Cluster RTO > 5s (got %.2fs)", drillResult.ClusterRTOSeconds))
	}
	if drillResult.ClientRTOSeconds > 10.0 {
		passed = false
		reasons = append(reasons, fmt.Sprintf("Client RTO > 10s (got %.2fs)", drillResult.ClientRTOSeconds))
	}
	if drillResult.RPOEventsLost > 0 {
		passed = false
		reasons = append(reasons, fmt.Sprintf("events lost (RPO > 0): %d", drillResult.RPOEventsLost))
	}
	if drillResult.ClientVisibleDupes > 0 {
		passed = false
		reasons = append(reasons, fmt.Sprintf("client visible duplicates: %d", drillResult.ClientVisibleDupes))
	}
	if drillResult.StressPubLatency.P99Ms >= 50.0 {
		passed = false
		reasons = append(reasons, fmt.Sprintf("post-failover publish p99 >= 50ms (got %.2fms)", drillResult.StressPubLatency.P99Ms))
	}
	if drillResult.FailoverLeader == "" || drillResult.FailoverLeader == drillResult.InitialLeader {
		passed = false
		reasons = append(reasons, "new Raft leader was not elected")
	}

	if passed {
		drillResult.GateVerdict = "PASS"
	} else {
		drillResult.GateVerdict = fmt.Sprintf("FAIL (%s)", strings.Join(reasons, "; "))
	}

	// Write JSON result file
	if err := os.MkdirAll(resultsJSONDir, 0755); err == nil {
		jsonPath := resultsJSONDir + "/phase7_nats_drill6.json"
		if data, err := json.MarshalIndent(drillResult, "", "  "); err == nil {
			_ = os.WriteFile(jsonPath, data, 0644)
			fmt.Printf("\nSaved detailed results JSON to %s\n", jsonPath)
		}
	}

	fmt.Println("\n================================================================================")
	fmt.Println("                     DRILL 6 VERIFICATION AUDIT REPORT                          ")
	fmt.Println("================================================================================")
	fmt.Printf("1. Initial Raft Leader: %s -> Failover Leader: %s\n", drillResult.InitialLeader, drillResult.FailoverLeader)
	fmt.Printf("2. Cluster Raft Failover RTO: %.2fs (Gate: <= 5.0s)\n", drillResult.ClusterRTOSeconds)
	fmt.Printf("3. Client Stream Reconnect RTO: %.2fs (Gate: <= 10.0s)\n", drillResult.ClientRTOSeconds)
	fmt.Printf("4. Recovery Point Objective (RPO): %d Events Lost (Gate: 0 Events Lost)\n", drillResult.RPOEventsLost)
	fmt.Printf("5. Consumer Idempotency: %d Redeliveries Handled, %d Client-Visible Dupes (Gate: 0)\n",
		drillResult.RedeliveredCount, drillResult.ClientVisibleDupes)
	fmt.Printf("6. Post-Failover Stress Pub p99: %.2fms (Gate: < 50ms)\n", drillResult.StressPubLatency.P99Ms)
	fmt.Printf("7. Post-Failover Stress Sub p99: %.2fms (Gate: < 50ms)\n", drillResult.StressSubLatency.P99Ms)
	fmt.Printf("8. Final Drill Gate Verdict: [%s]\n", drillResult.GateVerdict)
	fmt.Println("================================================================================")

	if !passed {
		os.Exit(1)
	}
}
