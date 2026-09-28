#!/usr/bin/env bash
# scripts/chaos/phase7_netem.sh — Phase 7 Chaos: Drill 9 (Issue #97)
# WAN Packet Loss & Jitter Injection via Linux tc netem
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
BENCH_BIN="/tmp/voice_bench"
DRILL_BIN="/tmp/netem_drill9"
SFU_CONTAINER="kith-sfu-1"
CLEANED_UP=""

cleanup() {
  if [ -n "${CLEANED_UP}" ]; then
    return
  fi
  CLEANED_UP=1
  echo ""
  echo -e "${YELLOW}==> [Cleanup] Ensuring any tc netem rules are removed from ${SFU_CONTAINER}...${NC}"
  docker exec -u 0 "${SFU_CONTAINER}" tc qdisc del dev eth0 root >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ tc netem rules cleared.${NC}"
}
trap cleanup EXIT INT TERM

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 7 CHAOS: DRILL 9 — TC NETEM WAN IMPAIRMENT            ║${NC}\n"
printf "${BOLD}${CYAN}║     Loss Resilience, RTCP Adaptation, Bounded Queues & Graceful Drift║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo ""

# ── 1. Check services health ─────────────────────────────────────────────────
echo -e "${BOLD}==> [Step 1/4] Checking service health (API, Gateway, SFU)...${NC}"
curl -sSf http://127.0.0.1:8080/healthz >/dev/null || { echo -e "${RED}API not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:4000/healthz >/dev/null || { echo -e "${RED}Gateway not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:5000/healthz >/dev/null || { echo -e "${RED}SFU not healthy!${NC}"; exit 1; }
echo -e "${GREEN}✓ API, Gateway, and SFU are operational.${NC}"

# ── 2. Compile voice_bench and drill driver ──────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 2/4] Compiling voice_bench and Drill 9 driver...${NC}"
(cd "${REPO_ROOT}/sfu" && go build -o "${BENCH_BIN}" ./cmd/voice_bench)
echo -e "${GREEN}✓ voice_bench compiled to ${BENCH_BIN}${NC}"

(cd "${REPO_ROOT}/scripts" && go build -o "${DRILL_BIN}" ./chaos/phase7_netem_chaos.go)
echo -e "${GREEN}✓ Drill 9 driver compiled to ${DRILL_BIN}${NC}"

# ── 3. Execute Chaos Drill ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 3/4] Executing Drill 9 WAN Impairment Suite...${NC}"
"${DRILL_BIN}" -bench-bin="${BENCH_BIN}" -sfu-container="${SFU_CONTAINER}"
DRILL_EXIT=$?

if [ "${DRILL_EXIT}" -ne 0 ]; then
  echo -e "${RED}✗ Drill 9 FAILED with exit code ${DRILL_EXIT}${NC}"
  exit "${DRILL_EXIT}"
fi

# ── 4. Verify Final State ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 4/4] Verifying network restoration...${NC}"
docker exec -u 0 "${SFU_CONTAINER}" tc qdisc show dev eth0
echo ""
printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${GREEN}║     PHASE 7 DRILL 9 (TC NETEM WAN IMPAIRMENT) COMPLETED!             ║${NC}\n"
printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
