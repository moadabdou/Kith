#!/usr/bin/env bash
# scripts/chaos/phase4_toctou.sh
# Phase 4 TOCTOU Mid-Session Role Revocation & Permission Chaos Drill (Issue #65)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

export API_URL="${API_URL:-http://127.0.0.1:8080/api}"
export GATEWAY_URL="${GATEWAY_URL:-ws://127.0.0.1:4000/ws}"
export GATEWAY_HEALTH="${GATEWAY_HEALTH:-http://127.0.0.1:4000/healthz}"

echo "============================================================"
echo " Starting Phase 4 TOCTOU & Permission Revocation Chaos Drill"
echo " API:     ${API_URL}"
echo " Gateway: ${GATEWAY_URL}"
echo "============================================================"

# Ensure node is available
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required to run phase4_toctou.js" >&2
  exit 1
fi

exec node "${SCRIPT_DIR}/phase4_toctou.js" "$@"
