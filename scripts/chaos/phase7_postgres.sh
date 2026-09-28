#!/usr/bin/env bash
# scripts/chaos/phase7_postgres.sh — Phase 7 Chaos: Drill 8 (Issue #97)
# PostgreSQL Connection Pool Exhaustion, Gateway Tier Isolation & Instant Recovery
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
BIN_PATH="/tmp/postgres_drill8"
HOLD_SEC="${1:-5}"
STRESS_OPS="${2:-500}"
CLEANED_UP=""

cleanup() {
  if [ -n "${CLEANED_UP}" ]; then
    return
  fi
  CLEANED_UP=1
  echo ""
  echo -e "${YELLOW}==> [Cleanup] Ensuring any lingering chaos hogger connections are terminated...${NC}"
  docker exec kith-postgres-1 psql -U discord -d discord -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'drill8_hogger';" >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ Postgres connections cleared.${NC}"
}
trap cleanup EXIT INT TERM

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 7 CHAOS: DRILL 8 — POSTGRESQL POOL EXHAUSTION         ║${NC}\n"
printf "${BOLD}${CYAN}║     Connection Starvation, Tier Isolation & Instant Recovery         ║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
echo ""

# ── 1. Check services health ─────────────────────────────────────────────────
echo -e "${BOLD}==> [Step 1/4] Checking service health (PostgreSQL, API, Gateway)...${NC}"
curl -sSf http://127.0.0.1:8080/healthz >/dev/null || { echo -e "${RED}API not healthy!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:8080/readyz >/dev/null || { echo -e "${RED}API /readyz not ready!${NC}"; exit 1; }
curl -sSf http://127.0.0.1:4000/healthz >/dev/null || { echo -e "${RED}Gateway not healthy!${NC}"; exit 1; }
docker exec kith-postgres-1 pg_isready -U discord -d discord >/dev/null || { echo -e "${RED}PostgreSQL not ready!${NC}"; exit 1; }
echo -e "${GREEN}✓ PostgreSQL, API, and Gateway are healthy and operational.${NC}"

# ── 2. Compile Drill Driver ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 2/4] Compiling Phase 7 PostgreSQL drill driver...${NC}"
(cd "${REPO_ROOT}/scripts" && go build -o "${BIN_PATH}" ./chaos/phase7_postgres_chaos.go)
echo -e "${GREEN}✓ Drill driver compiled to ${BIN_PATH}${NC}"

# ── 3. Execute Chaos Drill ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 3/4] Executing Drill 8 (Starvation hold: ${HOLD_SEC}s, Stress: ${STRESS_OPS} ops)...${NC}"
"${BIN_PATH}" -hold-sec="${HOLD_SEC}" -stress-ops="${STRESS_OPS}"
DRILL_EXIT=$?

if [ "${DRILL_EXIT}" -ne 0 ]; then
  echo -e "${RED}✗ Drill 8 FAILED with exit code ${DRILL_EXIT}${NC}"
  exit "${DRILL_EXIT}"
fi

# ── 4. Verify Final State ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}==> [Step 4/4] Verifying post-drill database and service health...${NC}"
docker exec kith-postgres-1 psql -U discord -d discord -c \
  "SELECT count(*) as active_connections, state FROM pg_stat_activity GROUP BY state;"
echo ""
printf "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${GREEN}║     PHASE 7 DRILL 8 (POSTGRESQL POOL EXHAUSTION) COMPLETED!          ║${NC}\n"
printf "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════════════╝${NC}\n"
