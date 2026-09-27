#!/usr/bin/env bash
# scripts/chaos/run_soak_30m.sh — Orchestrator for 30-minute mixed soak test (Issue #94).
# Usage: ./run_soak_30m.sh [TAG] [DURATION_S]
# Default: TAG=soak30m, DURATION_S=1800 (30 min)
# Profile: 400 active subscribers (proven 20k/s sweet spot) + typers + presence churn.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS="$SCRIPT_DIR/results"
mkdir -p "$RESULTS" /tmp/opencode

TAG="${1:-soak30m}"
DURATION_S="${2:-1800}"
RATE="${RATE:-50}"
SUBS="${SUBS:-400}"
SHARDS=2
GUILD_ID="${GUILD_ID:-99900000000000000}"
CHANNEL_ID="${CHANNEL_ID:-99900000000000101}"
API_BASE="${API_BASE:-http://127.0.0.1:8080}"
JWT_SECRET="${JWT_SECRET:-dev-jwt-secret-change-me}"

READY="/tmp/fanout_${TAG}.ready"
MANIFEST="$RESULTS/ws_fanout_${TAG}.posted.json"
TELEMETRY="$RESULTS/${TAG}_telemetry.jsonl"
PRESENCE_LOG="$RESULTS/${TAG}_presence.jsonl"

rm -f "$READY" "$MANIFEST" "$TELEMETRY" "$PRESENCE_LOG"* "$RESULTS"/ws_fanout_${TAG}_s*.json

echo "=== Issue #94: 30-Minute Soak Test Orchestrator ==="
echo "Tag: $TAG | Duration: ${DURATION_S}s ($((DURATION_S / 60)) min) | Rate: $RATE msg/s | Subs: $SUBS"

# 1. Mint JWT token for subscribers and presence watcher
SUB_TOKEN=$(node -e '
const crypto = require("crypto");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const h = b64({ alg: "HS256", typ: "JWT" });
const p = b64({ sub: "99900000000000001", iat: now, exp: now + 604800 });
const sig = crypto.createHmac("sha256", process.argv[1]).update(`${h}.${p}`).digest("base64url");
console.log(`${h}.${p}.${sig}`);
' "$JWT_SECRET")

# 2. Start Telemetry Sampler (10s cadence)
echo "=== [1/5] Starting Telemetry Sampler (10s cadence) ==="
INTERVAL_S=10 OUTFILE="$TELEMETRY" "$REPO_ROOT/scripts/bench/soak_sample.sh" > "/tmp/opencode/${TAG}_sampler.log" 2>&1 &
SAMPLER_PID=$!

cleanup() {
  echo "Cleaning up background companion processes..."
  if [ -n "${POSTER_PID:-}" ]; then kill "$POSTER_PID" 2>/dev/null || true; fi
  if [ -n "${SAMPLER_PID:-}" ]; then kill "$SAMPLER_PID" 2>/dev/null || true; fi
  if [ -n "${TYPERS_PID:-}" ]; then kill "$TYPERS_PID" 2>/dev/null || true; fi
  if [ -n "${PRESENCE_PID:-}" ]; then kill "$PRESENCE_PID" 2>/dev/null || true; fi
  for pid in "${SUB_PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

# 3. Launch Subscriber Shards in count-mode (SOAK_COUNT=1)
echo "=== [2/5] Launching $SUBS Subscribers ($SHARDS shards) in SOAK_COUNT mode ==="
SUB_PIDS=()
for i in $(seq 0 $((SHARDS - 1))); do
  WS_URLS="ws://127.0.0.1:4000/ws" \
  METRICS_URLS="http://127.0.0.1:4000/metrics" \
  SUB_TOKEN="$SUB_TOKEN" \
  GUILD_ID="$GUILD_ID" \
  CHANNEL_ID="$CHANNEL_ID" \
  SUBS="$SUBS" \
  SUB_SHARD="$i/$SHARDS" \
  SUBS_ONLY=1 \
  DURATION_S="$DURATION_S" \
  SETTLE_S=15 \
  TAG="$TAG" \
  SOAK_COUNT=1 \
  BIRTH_BATCH=100 \
  OUT="$RESULTS/ws_fanout_${TAG}_s$i.json" \
  READY_FILE="$READY" \
  MANIFEST="$MANIFEST" \
  node "$SCRIPT_DIR/ws_fanout.js" > "/tmp/opencode/${TAG}_sub_$i.log" 2>&1 &
  SUB_PIDS+=($!)
done

echo "Waiting for all subscribers to report READY..."
while [ ! -f "$READY" ]; do
  sleep 2
done
echo "All subscribers READY!"

# 4. Start Background Companions (Typers & Presence Flipper)
echo "=== [3/5] Starting Typers & Presence Churn ==="
TYPERS=5 DURATION_S="$DURATION_S" TYPER_PERIOD_S=12 node "$SCRIPT_DIR/soak_typers.js" > "/tmp/opencode/${TAG}_typers.log" 2>&1 &
TYPERS_PID=$!

WATCH_TOKEN="$SUB_TOKEN" FLIPPERS=3 DURATION_S="$DURATION_S" FLIP_EVERY_S=45 PRESENCE_LOG="$PRESENCE_LOG" node "$SCRIPT_DIR/soak_presence.js" > "/tmp/opencode/${TAG}_presence.log" 2>&1 &
PRESENCE_PID=$!

# 5. Run Poster with Real-Time Watchdog & Circuit Breakers
echo "=== [4/5] Launching Poster ($RATE msg/s for ${DURATION_S}s) with Watchdog ==="
API_BASE="$API_BASE" \
GUILD_ID="$GUILD_ID" \
CHANNEL_ID="$CHANNEL_ID" \
RATE="$RATE" \
DURATION_S="$DURATION_S" \
WRITERS=120 \
WRITER_BASE="99900000000000002" \
JWT_SECRET="$JWT_SECRET" \
TAG="$TAG" \
READY_FILE="$READY" \
MANIFEST="$MANIFEST" \
ID_PREFIX="tsoak" \
node "$SCRIPT_DIR/ws_poster.js" > "/tmp/opencode/${TAG}_poster.log" 2>&1 &
POSTER_PID=$!

CHECK_INTERVAL_S=10
CONSECUTIVE_LAG_TRIPS=0
MAX_LAG_TRIPS=3
START_SEC=$(date +%s)
LAST_HEARTBEAT=$START_SEC

echo "=== Live Watchdog Active (Polling metrics every ${CHECK_INTERVAL_S}s) ==="

while kill -0 "$POSTER_PID" 2>/dev/null; do
  sleep "$CHECK_INTERVAL_S"
  NOW_SEC=$(date +%s)
  ELAPSED=$((NOW_SEC - START_SEC))

  # 1. Gateway liveness check
  METRICS=$(curl -s --max-time 3 http://127.0.0.1:4000/metrics || true)
  if [ -z "$METRICS" ]; then
    echo "!! [CIRCUIT BREAKER] Gateway is not responding to /metrics at T+${ELAPSED}s !!"
    kill "$POSTER_PID" 2>/dev/null || true
    exit 1
  fi

  # 2. Extract metrics
  LAG=$(echo "$METRICS" | awk '/^gateway_consumer_lag /{print $2; exit}')
  DROPS=$(echo "$METRICS" | awk '/^gateway_slow_consumer_drops_total /{print $2; exit}')
  PROCS=$(echo "$METRICS" | awk '/^gateway_erlang_processes /{print $2; exit}')
  SESSIONS=$(echo "$METRICS" | awk '/^gateway_sessions_active /{print $2; exit}')
  MEM_MB=$(echo "$METRICS" | awk '/^gateway_erlang_memory_bytes /{printf "%.1f", $2/1048576; exit}')

  LAG="${LAG:-0}"
  DROPS="${DROPS:-0}"
  PROCS="${PROCS:-0}"
  SESSIONS="${SESSIONS:-0}"
  MEM_MB="${MEM_MB:-0}"

  # 3. Check subscriber shard health
  for pid in "${SUB_PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "!! [CIRCUIT BREAKER] Subscriber shard process $pid exited prematurely at T+${ELAPSED}s !!"
      kill "$POSTER_PID" 2>/dev/null || true
      exit 1
    fi
  done

  # 4. Check circuit breaker trips:
  # Trips condition A: Slow consumer drops > 0
  if awk "BEGIN {exit !($DROPS > 0)}"; then
    echo "!! [CIRCUIT BREAKER] Detected slow consumer drops ($DROPS) at T+${ELAPSED}s! Aborting run early."
    kill "$POSTER_PID" 2>/dev/null || true
    exit 1
  fi

  # Trips condition B: Consumer lag > 100 sustained for 3 checks
  if awk "BEGIN {exit !($LAG > 100)}"; then
    CONSECUTIVE_LAG_TRIPS=$((CONSECUTIVE_LAG_TRIPS + 1))
    echo "WARNING: Consumer lag is $LAG (trip $CONSECUTIVE_LAG_TRIPS/$MAX_LAG_TRIPS at T+${ELAPSED}s)"
    if [ "$CONSECUTIVE_LAG_TRIPS" -ge "$MAX_LAG_TRIPS" ]; then
      echo "!! [CIRCUIT BREAKER] Consumer lag sustained above 100 for ${MAX_LAG_TRIPS} checks at T+${ELAPSED}s! Aborting run early."
      kill "$POSTER_PID" 2>/dev/null || true
      exit 1
    fi
  else
    CONSECUTIVE_LAG_TRIPS=0
  fi

  # 5. Heartbeat report every 30 seconds
  if [ $((NOW_SEC - LAST_HEARTBEAT)) -ge 30 ]; then
    LAST_HEARTBEAT=$NOW_SEC
    REMAINING=$((DURATION_S > ELAPSED ? DURATION_S - ELAPSED : 0))
    echo "[Soak Watchdog T+${ELAPSED}s / ${DURATION_S}s (rem: ${REMAINING}s)] Mem: ${MEM_MB}MB | Procs: ${PROCS} | Subs: ${SESSIONS} | Lag: ${LAG} | Drops: ${DROPS}"
  fi
done

echo "Poster completed. Waiting for poster process exit code..."
wait "$POSTER_PID" || true

echo "Waiting for subscribers to flush interval summaries..."
for pid in "${SUB_PIDS[@]}"; do
  wait "$pid" || true
done
wait "$TYPERS_PID" 2>/dev/null || true
wait "$PRESENCE_PID" 2>/dev/null || true
kill "$SAMPLER_PID" 2>/dev/null || true

# 6. Evaluation & Summary
echo "=== [5/5] Soak Test Verification & Slope Analysis ==="
python3 -c "
import json, glob

tot_recv = tot_exp = worst = dups = closed = done = 0
for f in sorted(glob.glob('$RESULTS/ws_fanout_${TAG}_s*.json')):
    try:
        d = json.load(open(f))
    except Exception as e:
        print(f, 'unreadable:', e)
        continue
    lat = d.get('client_latency_ms', {})
    if lat.get('n', 0) > 0:
        done += 1
    tot_recv += d.get('total_deliveries', 0)
    tot_exp += d.get('expected_deliveries', 0)
    worst = max(worst, d.get('worst_client_missed', 0))
    dups += d.get('total_dups', 0)
    closed += d.get('closed_subs', 0)
    print(f.split('/')[-1], 'server_p99=', (d.get('server_fanout_p99') or {}).get('p99_s'), 'client_p50=', lat.get('p50'), 'client_p99=', lat.get('p99'))

delivery_rate = round(tot_recv / tot_exp, 5) if tot_exp else None
print('-----------------------------------------')
print('SHARDS DONE:     ', done)
print('DELIVERY RATE:   ', delivery_rate)
print('WORST CLIENT MISS:', worst)
print('TOTAL DUPS:      ', dups)
print('CLOSED SUBS:     ', closed)
print('-----------------------------------------')
"

echo "Gateway Internal Metrics:"
curl -s http://127.0.0.1:4000/metrics | grep -E "^gateway_(slow_consumer_drops_total|permission_filtered_total|event_redeliveries_total|consumer_lag)" || true

echo "=== Telemetry Slope Analysis (Warmup 300s) ==="
python3 "$REPO_ROOT/scripts/bench/soak_slopes.py" "$TELEMETRY" 300 --mem-tol=1.0 || true
