#!/usr/bin/env bash
# scripts/chaos/phase7_scylla.sh — Phase 7 Chaos Drill 5: ScyllaDB Network Partition (Issue #97)
#
# Drill 5: ScyllaDB node network partition under live read/write load.
#   - Writes at LOCAL_QUORUM must continue without interruption (2/3 majority intact).
#   - Writes at ALL must fail during the partition (strict quorum boundary).
#   - Partitioned node catches up post-healing via anti-entropy repair (zero silent loss).
#   - System recovers to 100% throughput and < 50ms p99 latency.
#
# Rule: predictions below were written BEFORE the first run; actuals go to
# postmortems/chaos-log.md.
#
# Predictions (2026-09-27, before run 1):
#   D5 Scylla network partition:
#     - Topology: 3-node Scylla cluster (RF=3) in datacenter1.
#     - Mid-burst network partition on scylla2 (docker network disconnect):
#       - Writes at LOCAL_QUORUM (W=2): 100% success (0 errors), as {scylla1, scylla3} satisfies 2/3 quorum.
#       - Writes at ALL (W=3): 100% fail during partition window.
#       - Reads at LOCAL_QUORUM: 100% linearizable (0 missing/phantom reads).
#     - Healing (docker network connect):
#       - RTO <= 15s (gossip rediscovers scylla2 as UN).
#       - Pre-repair direct read on scylla2 confirms missed partition-window mutations.
#       - nodetool repair -pr kith messages synchronizes missed mutations with RPO = 0.
#       - Cryptographic row-by-row audit across all 3 nodes confirms 100% parity and 0 corruptions.
#       - Post-healing stress burst recovers to 100% throughput with write/read p99 < 50ms.
#
# Usage: ./scripts/chaos/phase7_scylla.sh [partition_sec]
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
BIN_PATH="/tmp/scylla_drill5"
PARTITION_SEC="${1:-10}"
NET_NAME="kith-scylla-cluster_default"
VICTIM_CONTAINER="kith-scylla-cluster-scylla2-1"
VICTIM_IP="172.21.0.3"
CLEANED_UP=""

cleanup() {
  if [ -n "${CLEANED_UP}" ]; then
    return
  fi
  CLEANED_UP=1
  echo ""
  echo -e "${YELLOW}==> [Cleanup] Ensuring all Scylla nodes are reconnected...${NC}"
  # Reconnect victim container if disconnected
  if ! docker inspect -f '{{json .NetworkSettings.Networks}}' "${VICTIM_CONTAINER}" 2>/dev/null | grep -q "${NET_NAME}"; then
    echo "==> Reconnecting ${VICTIM_CONTAINER} to ${NET_NAME}..."
    docker network connect --ip "${VICTIM_IP}" "${NET_NAME}" "${VICTIM_CONTAINER}" >/dev/null 2>&1 || true
  fi
  echo -e "${GREEN}✓ Cluster network restored.${NC}"
}
trap cleanup EXIT INT TERM

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 7 CHAOS: DRILL 5 — SCYLLADB NETWORK PARTITION         ║${NC}\n"
printf "${BOLD}${CYAN}║     Live Load, Quorum Invariants, Anti-Entropy Catch-Up & SLO Gate   ║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo ""

# ── 1. Check Scylla cluster containers ───────────────────────────────────────
echo -e "${BOLD}==> [Step 1/4] Checking Scylla cluster container health...${NC}"
for c in kith-scylla-cluster-scylla1-1 kith-scylla-cluster-scylla2-1 kith-scylla-cluster-scylla3-1; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${c}$"; then
    echo -e "${RED}Container ${c} is not running! Starting cluster...${NC}"
    docker compose -f "${REPO_ROOT}/deploy/scylla/compose.scylla-cluster.yml" up -d
    sleep 5
    break
  fi
done

echo "Checking nodetool status on scylla1..."
docker exec kith-scylla-cluster-scylla1-1 nodetool status
echo -e "${GREEN}✓ All 3 Scylla cluster nodes are online.${NC}"

# ── 2. Compile Drill Driver ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 2/4] Compiling Phase 7 Scylla drill driver...${NC}"
(cd "${REPO_ROOT}/scripts" && go build -o "${BIN_PATH}" ./chaos/phase7_scylla_chaos.go)
echo -e "${GREEN}✓ Drill driver compiled to ${BIN_PATH}${NC}"

# ── 3. Execute Chaos Drill ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 3/4] Executing Drill 5 (Partition hold: ${PARTITION_SEC}s)...${NC}"
"${BIN_PATH}" -partition-sec="${PARTITION_SEC}"
DRILL_EXIT=$?

if [ "${DRILL_EXIT}" -ne 0 ]; then
  echo -e "${RED}✗ Drill 5 FAILED with exit code ${DRILL_EXIT}${NC}"
  exit "${DRILL_EXIT}"
fi

# ── 4. Verify Final State ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 4/4] Verifying post-drill cluster status...${NC}"
docker exec kith-scylla-cluster-scylla1-1 nodetool status
echo ""
printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${GREEN}║     PHASE 7 DRILL 5 (SCYLLADB PARTITION) PASSED ALL GATES!           ║${NC}\n"
printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
