#!/usr/bin/env bash
# T1 split run: subscribers + poster in separate processes (Issue #88 Step 4).
# Usage: ./run_fanout_t1.sh [TAG]
# Env: SUB_TOKEN, WS_URLS, METRICS_URLS, GUILD_ID, CHANNEL_ID, API_BASE,
#   SUBS, RATE, DURATION_S, WRITERS, JWT_SECRET.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TAG="${1:-t1split}"
export TAG
READY="/tmp/fanout_${TAG}.ready"
MANIFEST="$SCRIPT_DIR/results/ws_fanout_${TAG}.posted.json"
rm -f "$READY" "$MANIFEST"

export READY_FILE="$READY" MANIFEST="$MANIFEST" OUT="$SCRIPT_DIR/results/ws_fanout_${TAG}.json"

echo "=== subscribers (SUBS_ONLY) ==="
SUBS_ONLY=1 node "$SCRIPT_DIR/ws_fanout.js" > "/tmp/fanout_${TAG}_subs.log" 2>&1 &
SUBS_PID=$!

echo "=== poster ==="
node "$SCRIPT_DIR/ws_poster.js" > "/tmp/fanout_${TAG}_poster.log" 2>&1 &
POSTER_PID=$!

wait "$SUBS_PID"; SUBS_EXIT=$?
wait "$POSTER_PID" || true
echo "subs exit: $SUBS_EXIT"
echo "=== summary ==="
python3 -c "
import json
d = json.load(open('$SCRIPT_DIR/results/ws_fanout_${TAG}.json'))
print('posted:', d['posted'], '429s:', d['post429'], 'errors:', d['postErr'])
print('deliveries:', d['total_deliveries'], '/', d['expected_deliveries'], 'rate:', d['delivery_rate'])
print('per-client recv min/max:', d['per_client_recv'], 'dups:', d['total_dups'], 'worst missed:', d['worst_client_missed'])
print('latency(client, diagnostic):', d['client_latency_ms'])
print('server_fanout_p99(gate):', d.get('server_fanout_p99'))
print('post_latency:', d.get('post_latency_ms'))
print('evloop_lag:', d.get('evloop_lag_ms'))
print('gate:', d['gate'])
"
exit "$SUBS_EXIT"
