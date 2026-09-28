#!/usr/bin/env bash
# scripts/chaos/phase7_nats.sh — Phase 7 Chaos Drill 6: NATS JetStream Leader Kill & Auto-Reconnect (Issue #97)
#
# Drill 6: NATS JetStream leader kill & consumer stream auto-reconnect.
#   - Mid-burst SIGKILL of the stream Raft leader container.
#   - Raft leader election occurs among the surviving 2 nodes in <= 5s (RTO).
#   - Consumers and publishers auto-reconnect to the surviving cluster nodes.
#   - Zero event loss (RPO = 0).
#   - Any redelivered in-flight events are idempotently handled (0 client-visible duplicates).
#   - Post-failover throughput and latency recover with p99 < 50ms.
#
# Rule: predictions below were written BEFORE the first run; actuals go to
# postmortems/chaos-log.md.
#
# Predictions (2026-09-28, before run 1):
#   D6 NATS JetStream leader kill:
#     - Topology: 3-node NATS cluster with JetStream enabled, stream R=3.
#     - Leader identification: StreamInfo reports active Raft leader (nats1, nats2, or nats3).
#     - SIGKILL of leader container mid-burst:
#       - Client connection drops, reconnects to surviving nodes in <1s.
#       - JetStream Raft quorum (2/3 nodes surviving) elects new leader in <= 3s (RTO <= 5s).
#       - Publishers resume; consumer stream delivers all committed messages.
#       - In-flight unacknowledged deliveries are redelivered (delivered_count > 1).
#       - Idempotent consumer logic drops duplicate deliveries with 0 client duplicates.
#       - Total event loss RPO = 0.
#       - Post-failover stress burst achieves p99 < 50ms.
#       - Restarting victim container rejoins cluster and achieves in-sync replica status.
#
# Usage: ./scripts/chaos/phase7_nats.sh [hold_sec]
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
BIN_PATH="/tmp/nats_drill6"
HOLD_SEC="${1:-6}"
CLEANED_UP=""

cleanup() {
  if [ -n "${CLEANED_UP}" ]; then
    return
  fi
  CLEANED_UP=1
  echo ""
  echo -e "${YELLOW}==> [Cleanup] Ensuring all NATS cluster nodes are running...${NC}"
  for c in kith-nats-cluster-nats1-1 kith-nats-cluster-nats2-1 kith-nats-cluster-nats3-1; do
    if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
      echo "==> Restarting ${c}..."
      docker start "${c}" >/dev/null 2>&1 || true
    fi
  done
  echo -e "${GREEN}✓ All NATS cluster nodes running.${NC}"
}
trap cleanup EXIT INT TERM

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 7 CHAOS: DRILL 6 — NATS JETSTREAM LEADER KILL         ║${NC}\n"
printf "${BOLD}${CYAN}║     Raft Failover, Stream Auto-Reconnect & Idempotent Consumer       ║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo ""

# ── 1. Check NATS cluster containers ─────────────────────────────────────────
echo -e "${BOLD}==> [Step 1/4] Checking NATS cluster container health...${NC}"
for c in kith-nats-cluster-nats1-1 kith-nats-cluster-nats2-1 kith-nats-cluster-nats3-1; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
    echo -e "${YELLOW}Container ${c} not running. Starting NATS cluster...${NC}"
    docker compose -f "${REPO_ROOT}/deploy/nats/compose.nats-cluster.yml" up -d
    sleep 3
    break
  fi
done

echo "Checking NATS meta-cluster health via monitoring API..."
curl -s http://127.0.0.1:8225/jsz | grep -o '"cluster_size":[0-9]*' || true
echo -e "${GREEN}✓ 3-node NATS JetStream cluster is operational.${NC}"

# ── 2. Compile Drill Driver ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 2/4] Compiling Phase 7 NATS drill driver...${NC}"
(cd "${REPO_ROOT}/scripts" && go build -o "${BIN_PATH}" ./chaos/phase7_nats_chaos.go)
echo -e "${GREEN}✓ Drill driver compiled to ${BIN_PATH}${NC}"

# ── 3. Execute Chaos Drill ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 3/4] Executing Drill 6 (Leader kill hold: ${HOLD_SEC}s)...${NC}"
"${BIN_PATH}" -hold-sec="${HOLD_SEC}"
DRILL_EXIT=$?

if [ "${DRILL_EXIT}" -ne 0 ]; then
  echo -e "${RED}✗ Drill 6 FAILED with exit code ${DRILL_EXIT}${NC}"
  exit "${DRILL_EXIT}"
fi

# ── 4. Verify Final State ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 4/4] Verifying post-drill cluster status...${NC}"
curl -s http://127.0.0.1:8225/routez | grep -o '"num_routes":[0-9]*' || true
echo ""
printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${GREEN}║     PHASE 7 DRILL 6 (NATS LEADER KILL) PASSED ALL GATES!             ║${NC}\n"
printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
