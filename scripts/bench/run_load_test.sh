#!/usr/bin/env bash
# scripts/bench/run_load_test.sh — Phase 3 Gate: 1k msg/s ScyllaDB Write Load Test
set -euo pipefail

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
CYAN='\033[0;36m'
NC='\033[0m'

TARGET_RATE="${TARGET_RATE:-1000}"
RAMP_UP="${RAMP_UP:-10s}"
DURATION="${DURATION:-60s}"
API_BASE="${API_BASE:-http://127.0.0.1:8080}"
PPROF_BASE="${PPROF_BASE:-http://127.0.0.1:6060}"
BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${BENCH_DIR}/results"
mkdir -p "$RESULTS_DIR"

echo ""
printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║     KITH: SCYLLADB MESSAGE WRITE PATH LOAD BENCHMARK (k6)    ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "Target Write Rate:    ${BLUE}%s msg/s${NC}\n" "$TARGET_RATE"
printf "Ramp-up Duration:     ${BLUE}%s${NC}\n" "$RAMP_UP"
printf "Sustained Duration:   ${BLUE}%s${NC}\n" "$DURATION"
printf "API Endpoint:         ${BLUE}%s${NC}\n" "$API_BASE"
printf "Results Directory:    ${BLUE}%s${NC}\n" "$RESULTS_DIR"
echo ""

# 1. Setup channels and verify environment
printf "${YELLOW}→ [1/5] Verifying environment & seeding benchmark channels...${NC}\n"
"${BENCH_DIR}/setup_bench.sh"

# Ensure API is in scylla_only mode
STORE_MODE=$(docker exec kith-api-1 env | grep -E '^MESSAGES_STORE_MODE=' | cut -d= -f2 || true)
printf "API Message Store Mode: ${CYAN}%s${NC}\n" "${STORE_MODE:-unknown}"
if [ "${STORE_MODE}" != "scylla_only" ]; then
  printf "${YELLOW}→ Switching API to MESSAGES_STORE_MODE=scylla_only...${NC}\n"
  MESSAGES_STORE_MODE=scylla_only docker compose up -d api
  sleep 3
fi

# 2. Capture baseline Scylla and API metrics
printf "${YELLOW}→ [2/5] Capturing baseline metrics...${NC}\n"
docker compose exec -T scylla nodetool cfstats kith messages > "${RESULTS_DIR}/scylla_cfstats_before.txt" 2>&1 || true
curl -s "${API_BASE}/metrics" > "${RESULTS_DIR}/api_metrics_before.txt" 2>&1 || true

# 3. Launch live profiler and docker stats in background
printf "${YELLOW}→ [3/5] Starting background telemetry (pprof & docker stats)...${NC}\n"
(
  # Wait for ramp-up into sustained plateau
  sleep 15
  printf "${CYAN}[Telemetry] Capturing 30-second Go CPU profile from isolated port 6060...${NC}\n"
  curl -s "${PPROF_BASE}/debug/pprof/profile?seconds=30" > "${RESULTS_DIR}/api_cpu.pprof" 2>/dev/null || true
  curl -s "${PPROF_BASE}/debug/pprof/heap" > "${RESULTS_DIR}/api_heap.pprof" 2>/dev/null || true
  docker stats --no-stream > "${RESULTS_DIR}/docker_stats_under_load.txt" 2>/dev/null || true
  printf "${CYAN}[Telemetry] Live CPU & memory profiles captured.${NC}\n"
) &
TELEMETRY_PID=$!

# 4. Run k6 load benchmark
printf "${YELLOW}→ [4/5] Executing k6 sustained load benchmark (1,000 msg/s for 60s)...${NC}\n"
set +e
docker run --rm --network host \
  -v "${BENCH_DIR}:/bench" \
  grafana/k6:latest run \
  -e TARGET_RATE="${TARGET_RATE}" \
  -e RAMP_UP="${RAMP_UP}" \
  -e DURATION="${DURATION}" \
  -e API_BASE="${API_BASE}" \
  --summary-export="/bench/results/k6_summary.json" \
  /bench/messages_write_load.js | tee "${RESULTS_DIR}/k6_output.log"
K6_EXIT_CODE=$?
set -e

wait "$TELEMETRY_PID" 2>/dev/null || true

# 5. Capture post-run metrics
printf "${YELLOW}→ [5/5] Capturing post-run Scylla and API metrics...${NC}\n"
docker compose exec -T scylla nodetool cfstats kith messages > "${RESULTS_DIR}/scylla_cfstats_after.txt" 2>&1 || true
docker compose exec -T scylla nodetool tablehistograms kith messages > "${RESULTS_DIR}/scylla_histograms_after.txt" 2>&1 || true
curl -s "${API_BASE}/metrics" > "${RESULTS_DIR}/api_metrics_after.txt" 2>&1 || true

echo ""
if [ "$K6_EXIT_CODE" -eq 0 ]; then
  printf "${GREEN}${BOLD}================================================================${NC}\n"
  printf "${GREEN}${BOLD}✔ PHASE 3 GATE VERIFIED: 1,000 MSG/S SUSTAINED WITH p99 < 10ms! ${NC}\n"
  printf "${GREEN}${BOLD}================================================================${NC}\n"
else
  printf "${RED}${BOLD}================================================================${NC}\n"
  printf "${RED}${BOLD}✖ BENCHMARK FAILED OR THRESHOLDS CROSSED (Exit code: %s)${NC}\n" "$K6_EXIT_CODE"
  printf "${RED}${BOLD}================================================================${NC}\n"
fi

printf "Artifacts saved to: ${BLUE}%s${NC}\n\n" "$RESULTS_DIR"
exit "$K6_EXIT_CODE"
