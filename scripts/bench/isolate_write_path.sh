#!/usr/bin/env bash
# scripts/bench/isolate_write_path.sh — Tier isolation for write-path
# capacity tests (Issue #92).
#
# The box is shared: Meilisearch (and the search indexer where present)
# burn CPU and push the box into swap, turning nanosecond ETS/PG reads
# into disk I/O during write benchmarks. This script parks the
# non-essential tiers before a run and restores them after, recording
# loadavg + swap baselines on both transitions so contaminated runs are
# visible instead of silent.
#
# Usage: isolate_write_path.sh isolate|restore|status
set -euo pipefail

STATE_FILE="/tmp/kith_bench_isolation.state"

services_to_park() {
  # Search indexer lives inside the API via MEILISEARCH_URL; Meilisearch
  # itself is the standalone tier. Add future background tiers here.
  echo "meilisearch"
}

cmd_status() {
  echo "--- services ---"
  docker compose ps 2>/dev/null | head -n 12 || true
  echo "--- load ---"
  cat /proc/loadavg
  echo "--- swap (KB) ---"
  grep -E "Swap(Total|Free)" /proc/meminfo
}

cmd_isolate() {
  echo "Recording pre-isolation state..."
  cmd_status > "$STATE_FILE" 2>&1 || true
  for svc in $(services_to_park); do
    if docker compose ps "$svc" 2>/dev/null | grep -q "Up\|running"; then
      echo "Parking $svc..."
      docker compose stop "$svc"
    else
      echo "$svc already stopped (or absent), skipping."
    fi
  done
  sleep 3
  echo "Post-isolation baseline:"
  cat /proc/loadavg
  grep -E "Swap(Total|Free)" /proc/meminfo
  echo "Isolated. Restore with: $0 restore"
}

cmd_restore() {
  for svc in $(services_to_park); do
    echo "Restoring $svc..."
    docker compose up -d "$svc" || echo "WARNING: failed to restore $svc"
  done
  echo "Restored. Pre-isolation state was:"
  cat "$STATE_FILE" 2>/dev/null || echo "(no state recorded)"
}

case "${1:-status}" in
  isolate) cmd_isolate ;;
  restore) cmd_restore ;;
  status) cmd_status ;;
  *) echo "Usage: $0 isolate|restore|status" >&2; exit 1 ;;
esac
