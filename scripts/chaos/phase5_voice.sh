#!/usr/bin/env bash
# scripts/chaos/phase5_voice.sh
# Phase 5 Voice Chaos & Benchmark Suite (Issue #75)
# Validates audio latency targets, network loss/delay resilience (tc netem),
# mid-call SFU SIGKILL failover, and media-plane independence.
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
BIN_PATH="/tmp/voice_bench"
SFU_CONTAINER="kith-sfu-1"
FAILOVER_LOG="/tmp/failover_drill.log"

cleanup() {
  echo ""
  echo -e "${YELLOW}==> [Cleanup] Ensuring netem rules removed and SFU running...${NC}"
  docker exec -u 0 "${SFU_CONTAINER}" tc qdisc del dev eth0 root 2>/dev/null || true
  if ! docker ps --format '{{.Names}}' | grep -q "^${SFU_CONTAINER}$"; then
    echo "==> Restarting ${SFU_CONTAINER}..."
    docker start "${SFU_CONTAINER}" >/dev/null 2>&1 || true
  fi
  rm -f "${FAILOVER_LOG}"
}
trap cleanup EXIT INT TERM

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 5 VOICE CHAOS & BENCHMARKS (Issue #75)                ║${NC}\n"
printf "${BOLD}${CYAN}║     Mouth-to-Ear Latency, tc netem, Mid-Call Kill & Partition        ║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo ""

# ── 1. Compile Voice Bench Driver ──────────────────────────────────────────────
echo -e "${BOLD}==> [Step 1/5] Compiling voice benchmark driver...${NC}"
(cd "${REPO_ROOT}/sfu" && go build -o "${BIN_PATH}" ./cmd/voice_bench)
echo -e "${GREEN}✓ Driver compiled to ${BIN_PATH}${NC}"

# ── 2. Health Check All Services ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 2/5] Checking service health...${NC}"
curl -sSf http://127.0.0.1:8080/healthz >/dev/null || { echo -e "${RED}API not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:4000/healthz >/dev/null || { echo -e "${RED}Gateway not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:5000/healthz >/dev/null || { echo -e "${RED}SFU not healthy!${NC}"; exit 1; }
echo -e "${GREEN}✓ API, Gateway, and SFU are healthy and ready.${NC}"

# ── 3. Drill 1: Latency Clap Test ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 3/5] Running Mouth-to-Ear Latency Benchmark (Clap Test)...${NC}"
"${BIN_PATH}" -drill=clap -samples=100

# ── 4. Drill 2: Network Impairment (tc netem) ─────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 4/5] Running Network Impairment Drills (tc netem)...${NC}"

# Profile A: Mild (5% loss, 40ms delay, 10ms jitter)
echo -e "\n${CYAN}--- Profile A: Mild Impairment (loss 5%, delay 40ms 10ms) ---${NC}"
docker exec -u 0 "${SFU_CONTAINER}" tc qdisc add dev eth0 root netem loss 5% delay 40ms 10ms
"${BIN_PATH}" -drill=impairment -duration=4s
docker exec -u 0 "${SFU_CONTAINER}" tc qdisc del dev eth0 root

# Profile B: Severe (20% loss, 80ms delay, 25ms jitter)
echo -e "\n${CYAN}--- Profile B: Severe Impairment (loss 20%, delay 80ms 25ms) ---${NC}"
docker exec -u 0 "${SFU_CONTAINER}" tc qdisc add dev eth0 root netem loss 20% delay 80ms 25ms
"${BIN_PATH}" -drill=impairment -duration=4s
docker exec -u 0 "${SFU_CONTAINER}" tc qdisc del dev eth0 root

# ── 5. Drill 3: Mid-Call Hard SFU SIGKILL & Failover ──────────────────────────
echo ""
echo -e "${BOLD}==> [Step 5/5] Running Mid-Call SFU Termination (SIGKILL) & Failover...${NC}"
rm -f "${FAILOVER_LOG}"
"${BIN_PATH}" -drill=failover > "${FAILOVER_LOG}" 2>&1 &
BENCH_PID=$!

echo "Waiting for call establishment ([READY_FOR_KILL])..."
MAX_WAIT=20
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

echo "Waiting 1.2s to simulate outage window..."
sleep 1.2

echo -e "${GREEN}==> Restarting ${SFU_CONTAINER}...${NC}"
docker start "${SFU_CONTAINER}" >/dev/null

wait "${BENCH_PID}"
cat "${FAILOVER_LOG}"

# ── 6. Drill 4: Control Plane Partition ───────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Bonus Invariant] Running Media Plane Independence Drill...${NC}"
"${BIN_PATH}" -drill=partition

# ── Final Report ──────────────────────────────────────────────────────────────
echo ""
printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${GREEN}║     PHASE 5 VOICE CHAOS SUITE PASSED ALL AUDITS & INVARIANTS!        ║${NC}\n"
printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo -e "1. ${GREEN}✓ Mouth-to-Ear Latency:${NC} p95 latency empirically verified < 150ms."
echo -e "2. ${GREEN}✓ Network Impairment:${NC} Maintained audio routing under 5% and 20% loss with active RTCP feedback."
echo -e "3. ${GREEN}✓ Failover Convergence:${NC} 3-way call survived hard SIGKILL and fully reconnected under 3s."
echo -e "4. ${GREEN}✓ Media Independence:${NC} Audio media plane survived control plane severance without frame loss."
echo ""
