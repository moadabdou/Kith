#!/usr/bin/env bash
# scripts/chaos/phase9_reaction_storm.sh — Phase 9 Chaos Drill 1 (Issue #116)
# Reaction storm + reply/delete race. Impaired phase is a 3x request burst
# (packet loss via tc netem is unavailable: no CAP_NET_ADMIN in this
# sandbox, and the Alpine API image ships no `tc`).
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 9 CHAOS: DRILL 1 — REACTION STORM + REPLY/DELETE RACE ║${NC}\n"
printf "${BOLD}${CYAN}║     500 sessions x 0.8 rps clean, 3x burst impaired, zero drift    ║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo ""

echo -e "${BOLD}==> [Step 1/3] Checking service health (API, Gateway, Scylla)...${NC}"
curl -sSf http://127.0.0.1:8080/healthz >/dev/null || { echo -e "${RED}API not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:4000/healthz >/dev/null || { echo -e "${RED}Gateway not healthy!${NC}"; exit 1; }
docker exec kith-scylla-1 cqlsh -e "SELECT now() FROM system.local;" >/dev/null || { echo -e "${RED}Scylla not healthy!${NC}"; exit 1; }
echo -e "${GREEN}✓ API, Gateway, and Scylla are operational.${NC}"

echo ""
echo -e "${BOLD}==> [Step 2/3] Running drill (clean storm + burst storm + live race)...${NC}"
USERS="${USERS:-500}" RPS="${RPS:-0.8}" DURATION_S="${DURATION_S:-60}" ROUNDS="${ROUNDS:-20}" \
  BURST_RPS_MULT="${BURST_RPS_MULT:-3}" \
  TAG="drill1" OUT="${SCRIPT_DIR}/results/phase9_reaction_storm.json" \
  node "${SCRIPT_DIR}/phase9_reaction_storm.js"
DRILL_EXIT=$?

if [ "${DRILL_EXIT}" -ne 0 ]; then
  echo -e "${RED}✗ Drill 1 FAILED with exit code ${DRILL_EXIT}${NC}"
  exit "${DRILL_EXIT}"
fi
echo ""
printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${GREEN}║     PHASE 9 DRILL 1 (REACTION STORM) COMPLETED — GATE: PASS         ║${NC}\n"
printf "${BOLD}${GREEN}╚═══════��══════════════════════════════════════════════════════════════╝${NC}\n"
