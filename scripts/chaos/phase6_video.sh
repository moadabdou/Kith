#!/usr/bin/env bash
# scripts/chaos/phase6_video.sh
# Phase 6 Video Chaos & Benchmark Suite (Issue #83)
# Validates simulcast layer switching, PLI rate limiting under join/leave
# storms, screen-share stability, mid-call SFU SIGKILL video recovery, and
# captures SFU resource snapshots for the postmortem.
#
# Drill binaries: extended voice_bench driver (sfu/cmd/voice_bench,
# -drill=pli_storm|layer_throttle|screen_detail|video_failover|resource).
# Real 3-layer VP8 simulcast publishers; per-subscriber RTCP loss injection
# steers the layer selector deterministically (global tc cannot degrade one
# viewer while sparing others).
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BIN_PATH="/tmp/video_bench"
SFU_CONTAINER="${SFU_CONTAINER:-kith-sfu-1}"
API_BASE="${API_BASE:-http://127.0.0.1:8080/api}"
GATEWAY_WS="${GATEWAY_WS:-ws://127.0.0.1:4000/ws}"
SFU_WS="${SFU_WS:-ws://127.0.0.1:5000/ws}"
SFU_METRICS="${SFU_METRICS:-http://127.0.0.1:5000/metrics}"
FAILOVER_LOG="/tmp/phase6_failover_drill.log"
KILL_TS_FILE="/tmp/phase6_kill_ts"
SNAPSHOT_FILE="${SNAPSHOT_FILE:-/tmp/phase6_resources.tsv}"
CLEANED_UP=""

snapshot() {
  "${BIN_PATH}" -drill=resource -label="$1" -snapshot="${SNAPSHOT_FILE}" \
    -container="${SFU_CONTAINER}" \
    -api="${API_BASE}" -gateway="${GATEWAY_WS}" -sfu="${SFU_WS}" -sfu-metrics="${SFU_METRICS}"
}

cleanup() {
  if [ -n "${CLEANED_UP}" ]; then
    return
  fi
  CLEANED_UP=1
  echo ""
  echo -e "${YELLOW}==> [Cleanup] Restoring SFU container and removing artifacts...${NC}"
  if [ -n "${BENCH_PID:-}" ] && kill -0 "${BENCH_PID}" 2>/dev/null; then
    kill "${BENCH_PID}" 2>/dev/null || true
  fi
  docker exec -u 0 "${SFU_CONTAINER}" tc qdisc del dev eth0 root 2>/dev/null || true
  if ! docker ps --format '{{.Names}}' | grep -q "^${SFU_CONTAINER}$"; then
    echo "==> Restarting ${SFU_CONTAINER}..."
    docker start "${SFU_CONTAINER}" >/dev/null 2>&1 || true
  fi
  rm -f "${FAILOVER_LOG}" "${KILL_TS_FILE}"
}
trap cleanup EXIT INT TERM

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 6 VIDEO CHAOS & BENCHMARKS (Issue #83)                ║${NC}\n"
printf "${BOLD}${CYAN}║     Simulcast Switching, PLI Storm, Screen Detail, SFU Kill          ║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo ""

# ── 1. Compile Video Bench Driver ────────────────────────────────────────────
echo -e "${BOLD}==> [Step 1/7] Compiling video benchmark driver...${NC}"
(cd "${REPO_ROOT}/sfu" && go build -o "${BIN_PATH}" ./cmd/voice_bench)
echo -e "${GREEN}✓ Driver compiled to ${BIN_PATH}${NC}"

# ── 2. Health Check All Services ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 2/7] Checking service health...${NC}"
curl -sSf http://127.0.0.1:8080/healthz >/dev/null || { echo -e "${RED}API not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:4000/healthz >/dev/null || { echo -e "${RED}Gateway not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:5000/healthz >/dev/null || { echo -e "${RED}SFU not healthy!${NC}"; exit 1; }
echo -e "${GREEN}✓ API, Gateway, and SFU are healthy and ready.${NC}"

# ── Resource snapshot header ─────────────────────────────────────────────────
if [ ! -f "${SNAPSHOT_FILE}" ]; then
  printf 'timestamp\tlabel\tgoroutines\theap_alloc_B\theap_sys_B\tstack_inuse_B\trss_B\tcpu_seconds\trooms\tpeers\tqueue_depth\tforwarded\tdropped\tnack_total\tdocker(cpu|mem|mempct|netio|blockio)\n' > "${SNAPSHOT_FILE}"
fi

echo ""
echo -e "${BOLD}==> [Baseline] Capturing pre-drill resource snapshot...${NC}"
snapshot "baseline"

# ── 3. Drill 1: PLI Storm ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 3/7] Drill 1: PLI Storm (10 rapid joiners vs 500ms limiter)...${NC}"
snapshot "pre_pli_storm"
"${BIN_PATH}" -drill=pli_storm \
  -api="${API_BASE}" -gateway="${GATEWAY_WS}" -sfu="${SFU_WS}" -sfu-metrics="${SFU_METRICS}"
snapshot "post_pli_storm"

# ── 4. Drill 2: Throttled Simulcast Switching ────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 4/7] Drill 2: Throttled Switching (clean/degraded/severe -> f/h/q)...${NC}"
snapshot "pre_layer_throttle"
"${BIN_PATH}" -drill=layer_throttle \
  -api="${API_BASE}" -gateway="${GATEWAY_WS}" -sfu="${SFU_WS}" -sfu-metrics="${SFU_METRICS}"
snapshot "post_layer_throttle"

# ── 5. Drill 3: Screen Share Detail ──────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 5/7] Drill 3: Screen Share Detail (single-layer f, PLI round-trip)...${NC}"
snapshot "pre_screen_detail"
"${BIN_PATH}" -drill=screen_detail \
  -api="${API_BASE}" -gateway="${GATEWAY_WS}" -sfu="${SFU_WS}" -sfu-metrics="${SFU_METRICS}"
snapshot "post_screen_detail"

# ── 6. Drill 4: Mid-Call SFU SIGKILL -> First Keyframe < 2s ──────────────────
echo ""
echo -e "${BOLD}==> [Step 6/7] Drill 4: Mid-Call SFU SIGKILL & Video Recovery...${NC}"
snapshot "pre_video_failover"
rm -f "${FAILOVER_LOG}" "${KILL_TS_FILE}"
"${BIN_PATH}" -drill=video_failover -killfile="${KILL_TS_FILE}" \
  -api="${API_BASE}" -gateway="${GATEWAY_WS}" -sfu="${SFU_WS}" -sfu-metrics="${SFU_METRICS}" > "${FAILOVER_LOG}" 2>&1 &
BENCH_PID=$!

echo "Waiting for call establishment ([READY_FOR_KILL])..."
MAX_WAIT=40
WAITED=0
while [ "${WAITED}" -lt "${MAX_WAIT}" ]; do
  if grep -q "\[READY_FOR_KILL\]" "${FAILOVER_LOG}" 2>/dev/null; then
    break
  fi
  sleep 0.5
  WAITED=$((WAITED + 1))
done

if ! grep -q "\[READY_FOR_KILL\]" "${FAILOVER_LOG}" 2>/dev/null; then
  echo -e "${RED}Failover drill did not signal readiness in time:${NC}"
  cat "${FAILOVER_LOG}"
  exit 1
fi

echo -e "${YELLOW}==> Issuing SIGKILL to ${SFU_CONTAINER}...${NC}"
docker kill -s SIGKILL "${SFU_CONTAINER}" >/dev/null
date +%s%N > "${KILL_TS_FILE}"

echo -e "${GREEN}==> Restarting ${SFU_CONTAINER} immediately...${NC}"
docker start "${SFU_CONTAINER}" >/dev/null

wait "${BENCH_PID}"
BENCH_PID=""
cat "${FAILOVER_LOG}"
snapshot "post_video_failover"

# ── 7. Final Report ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 7/7] Final resource snapshot + report...${NC}"
snapshot "final"
echo ""
printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${GREEN}║     PHASE 6 VIDEO CHAOS SUITE PASSED ALL AUDITS & INVARIANTS!        ║${NC}\n"
printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo -e "1. ${GREEN}✓ PLI Storm:${NC} join/leave burst coalesced by the 500ms limiter."
echo -e "2. ${GREEN}✓ Simulcast Switching:${NC} clean/degraded/severe viewers stabilized on f/h/q."
echo -e "3. ${GREEN}✓ Screen Detail:${NC} single-layer f screen stable, PLI round-trip works."
echo -e "4. ${GREEN}✓ Video Failover:${NC} call survived SIGKILL, first keyframe < 2s."
echo -e "5. ${BLUE}Resource snapshots:${NC} ${SNAPSHOT_FILE}"
echo ""
