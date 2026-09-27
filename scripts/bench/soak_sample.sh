#!/usr/bin/env bash
# scripts/bench/soak_sample.sh — Telemetry sampler for soak runs (Issue #94).
# Every INTERVAL_S (default 10): BEAM memory/process/sessions/actors/lag
# counters from gateway /metrics, gateway FD count, host load + swap.
# Appends one JSON object per line to OUTFILE.
set -euo pipefail

INTERVAL_S="${INTERVAL_S:-10}"
OUTFILE="${OUTFILE:-/tmp/soak_telemetry.jsonl}"
GW_METRICS="${GW_METRICS:-http://127.0.0.1:4000/metrics}"
GW_CONTAINER="${GW_CONTAINER:-kith-gateway-1}"

metric() { # metric <name> <metrics_text> -> value or null (tolerates {labels})
  local val
  val=$(printf '%s' "$2" | grep -E "^$1(\{| )" | awk '{print $2}' | head -n 1)
  printf '%s' "${val:-null}"
}

gw_beam_pid() {
  docker exec "$GW_CONTAINER" sh -c 'for d in /proc/[0-9]*; do if grep -qa "beam.smp" "$d/cmdline" 2>/dev/null; then basename "$d"; break; fi; done' 2>/dev/null
}

echo "sampling every ${INTERVAL_S}s -> ${OUTFILE} (Ctrl-C to stop)"
while true; do
  ts=$(date +%s)
  m=$(curl -s -m 5 "$GW_METRICS" || true)
  beam_pid=$(gw_beam_pid || true)
  if [ -n "${beam_pid:-}" ]; then
    fds=$(docker exec "$GW_CONTAINER" sh -c "ls /proc/$beam_pid/fd 2>/dev/null | wc -l" 2>/dev/null | tr -d ' ' || echo null)
  else
    fds=null
  fi
  load=$(awk '{print $1}' /proc/loadavg)
  swap_used_kb=$(awk '/SwapTotal/{t=$2} /SwapFree/{f=$2} END{print t-f}' /proc/meminfo)
  printf '{"t":%s,"erlang_mem":%s,"procs":%s,"sessions":%s,"actors":%s,"lag":%s,"redeliveries":%s,"gw_fds":%s,"load1":%s,"swap_used_kb":%s}\n' \
    "$ts" \
    "$(metric gateway_erlang_memory_bytes "$m")" \
    "$(metric gateway_erlang_processes "$m")" \
    "$(metric gateway_sessions_active "$m")" \
    "$(metric gateway_guild_actors_active "$m")" \
    "$(metric gateway_consumer_lag "$m")" \
    "$(metric gateway_event_redeliveries_total "$m")" \
    "${fds:-null}" \
    "$load" "$swap_used_kb" >> "$OUTFILE"
  sleep "$INTERVAL_S"
done
