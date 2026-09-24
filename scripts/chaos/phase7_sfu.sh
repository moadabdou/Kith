#!/usr/bin/env bash
# scripts/chaos/phase7_sfu.sh — Phase 7d SFU pool failover drills (Issue #87)
# Drill 1 (pool kill): mid-call SIGKILL of the PLACED sfu, NO restart.
#   Members must co-locate on the peer SFU with first keyframe <= 2s.
# Drill 2 (steady-state control, same run): healthy re-requests stay put,
#   zero spurious nulls (the rumor path doesn't stampede).
#
# Rule: predictions below were written BEFORE the first run; actuals go to
# postmortems/chaos-log.md.
#
# Predictions (2026-09-24, before run 1):
#  D1 pool kill: drill room hashes onto one SFU (all 3 members co-located
#     pre-kill). SIGKILL -> WS drop observed in <1s. First Op 4 re-request
#     confirm-probes the corpse (RST-instant fail) and answers the survivor
#     immediately — OR the poller flips (<=2 cycles at 5s) and the Step 4
#     null-then-reallocate push lands. Either path: all 3 members report the
#     SAME survivor endpoint, none report the dead one, first post-kill
#     keyframe <= 2s after the kill timestamp. Victim stays DOWN (no
#     restart): proves the pool, not the process, recovered the call.
#  D2 control: after recovery, 2x re-Op 4 per member all repeat the survivor
#     endpoint; 3s quiet window shows zero nulls. Placement is stable when
#     nothing is dead.
#
# Usage: ./scripts/chaos/phase7_sfu.sh
# Env: API_BASE, GATEWAY_WS, KILL_TS_FILE (default /tmp/phase7_sfu_kill_ts)
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
BIN_PATH="/tmp/pool_bench"
API_BASE="${API_BASE:-http://127.0.0.1:8080/api}"
GATEWAY_WS="${GATEWAY_WS:-ws://127.0.0.1:4000/ws}"
KILL_TS_FILE="${KILL_TS_FILE:-/tmp/phase7_sfu_kill_ts}"
DRILL_LOG="/tmp/phase7_sfu_drill.log"
CLEANED_UP=""

cleanup() {
  if [ -n "${CLEANED_UP}" ]; then
    return
  fi
  CLEANED_UP=1
  echo ""
  echo -e "${YELLOW}==> [Cleanup] Restoring victim SFU (if down) and removing artifacts...${NC}"
  # Whatever we killed, bring back so the stack is left whole.
  for c in $(docker ps -a --format '{{.Names}}' | grep -E 'sfu' || true); do
    if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
      echo "==> Restarting ${c}..."
      docker start "${c}" >/dev/null 2>&1 || true
    fi
  done
  rm -f "${KILL_TS_FILE}"
}
trap cleanup EXIT INT TERM

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 7d SFU POOL FAILOVER (Issue #87)                      ║${NC}\n"
printf "${BOLD}${CYAN}║     Pool kill (no restart) + steady-state control                    ║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo ""

# ── 1. Compile pool bench driver ──────────────────────────────────────────
echo -e "${BOLD}==> [Step 1/5] Compiling pool bench driver...${NC}"
(cd "${REPO_ROOT}/sfu" && go build -o "${BIN_PATH}" ./cmd/voice_bench)
echo -e "${GREEN}✓ Driver compiled to ${BIN_PATH}${NC}"

# ── 2. Health check: both SFUs + gateway must be up ───────────────────────
echo ""
echo -e "${BOLD}==> [Step 2/5] Checking service health...${NC}"
curl -sSf http://127.0.0.1:8080/healthz >/dev/null || { echo -e "${RED}API not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:4000/healthz >/dev/null || { echo -e "${RED}Gateway not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:5000/healthz >/dev/null || { echo -e "${RED}SFU-1 (:5000) not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:5001/healthz >/dev/null || { echo -e "${RED}SFU-2 (:5001) not healthy!${NC}"; exit 1; }
echo -e "${GREEN}✓ API, Gateway, SFU-1, SFU-2 healthy. Pool gate must show both live:${NC}"
curl -s http://127.0.0.1:4000/metrics | grep -E "^gateway_sfu_flips_total" || true

# Record pre-drill metrics for the postmortem.
METRICS_BEFORE="/tmp/phase7_sfu_metrics_before.txt"
curl -s http://127.0.0.1:4000/metrics | grep -E "sfu_flips|sfu_failovers|voice_intent|voice_placement" > "${METRICS_BEFORE}" || true

# ── 3. Run pool_failover drill (blocks at READY_FOR_KILL) ─────────────────
echo ""
echo -e "${BOLD}==> [Step 3/5] Starting pool_failover drill (video, 1 pub + 2 subs)...${NC}"
rm -f "${DRILL_LOG}" "${KILL_TS_FILE}"
"${BIN_PATH}" -drill=pool_failover -killfile="${KILL_TS_FILE}" \
  -api="${API_BASE}" -gateway="${GATEWAY_WS}" > "${DRILL_LOG}" 2>&1 &
BENCH_PID=$!

echo "Waiting for call establishment ([READY_FOR_KILL])..."
MAX_WAIT=60
WAITED=0
while [ "${WAITED}" -lt "${MAX_WAIT}" ]; do
  if grep -q "\[READY_FOR_KILL\]" "${DRILL_LOG}" 2>/dev/null; then
    break
  fi
  # Fail fast if the driver already died (setup error, not a drill failure).
  if ! kill -0 "${BENCH_PID}" 2>/dev/null; then
    echo -e "${RED}Driver exited before READY_FOR_KILL:${NC}"
    cat "${DRILL_LOG}"
    exit 1
  fi
  sleep 0.5
  WAITED=$((WAITED + 1))
done

if ! grep -q "\[READY_FOR_KILL\]" "${DRILL_LOG}" 2>/dev/null; then
  echo -e "${RED}Drill did not signal readiness in time:${NC}"
  cat "${DRILL_LOG}"
  exit 1
fi

# Which SFU was the room placed on? The drill prints [PLACED_ON <endpoint>].
PLACED_ON="$(grep -o '\[PLACED_ON [^]]*\]' "${DRILL_LOG}" | head -n 1 | sed 's/\[PLACED_ON //;s/\]//')"
echo -e "${BLUE}Room placed on: ${PLACED_ON}${NC}"

# Map endpoint port -> victim container (never the peer, never restart it).
if [[ "${PLACED_ON}" == *":5001"* ]]; then
  VICTIM="$(docker ps --format '{{.Names}}' | grep -E 'sfu' | grep -E 'sfu-2|sfu2' | head -n 1)"
else
  VICTIM="$(docker ps --format '{{.Names}}' | grep -E 'sfu' | grep -v -E 'sfu-2|sfu2' | head -n 1)"
fi
if [ -z "${VICTIM}" ]; then
  echo -e "${RED}Could not map placed endpoint ${PLACED_ON} to a container!${NC}"
  docker ps --format '{{.Names}}' | grep -E 'sfu' || true
  exit 1
fi
echo -e "${YELLOW}==> Issuing SIGKILL to ${VICTIM} (NO restart — the pool must absorb it)...${NC}"
docker kill -s SIGKILL "${VICTIM}" >/dev/null
date +%s%N > "${KILL_TS_FILE}"

# ── 4. Wait for the drill verdict ──────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 4/5] Waiting for drill verdict (failover + control)...${NC}"
wait "${BENCH_PID}"
BENCH_PID=""
DRILL_EXIT=$?
cat "${DRILL_LOG}"

if [ "${DRILL_EXIT}" -ne 0 ]; then
  echo -e "${RED}✗ pool_failover drill FAILED (exit ${DRILL_EXIT})${NC}"
  exit "${DRILL_EXIT}"
fi

# ── 5. Post-drill metrics + report ─────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 5/5] Post-drill metrics + report...${NC}"
echo -e "${BLUE}--- gateway metrics delta (before -> after) ---${NC}"
echo "BEFORE:"
cat "${METRICS_BEFORE}"
echo "AFTER:"
curl -s http://127.0.0.1:4000/metrics | grep -E "sfu_flips|sfu_failovers|voice_intent|voice_placement" || true

echo ""
printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${GREEN}║     PHASE 7d POOL FAILOVER SUITE PASSED!                             ║${NC}\n"
printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo -e "1. ${GREEN}✓ Pool kill:${NC} victim ${VICTIM} stayed down; call co-located on peer, keyframe ≤ 2s."
echo -e "2. ${GREEN}✓ Control:${NC} healthy re-requests stable, zero spurious nulls."
echo -e "3. ${BLUE}Drill log:${NC} ${DRILL_LOG}"
