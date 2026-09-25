#!/usr/bin/env bash
# Split-driver WS army runner (Issue #88 Step 3).
# Runs N driver processes in parallel, each owning a share of the target,
# then aggregates rung JSONs. Needed because a single Node process bends at
# ~13k held sockets (event-loop lag), before the gateway does.
#
# Usage: ./ws_split_army.sh <drivers> <per_driver_target> <tag> [extra env...]
# Example: ./ws_split_army.sh 2 15000 split30k
# Env passed through: WS_URLS, METRICS_URLS, RATE, BATCH, HOLD_S,
# TOKEN_<i> (per-driver JWT, required — one per driver), TOKEN (fallback
# shared by all drivers when per-driver tokens are absent).
set -euo pipefail

DRIVERS="${1:?drivers}"
PER_TARGET="${2:?per_driver_target}"
TAG="${3:?tag}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${TOKEN_1:-}" ] && [ -z "${TOKEN:-}" ]; then
  echo "TOKEN_1..N or TOKEN env required" >&2
  exit 1
fi

# Per-driver guild sharding: GUILD_IDS (comma-separated) gives each driver
# its own guild so subscribes fan out across guild actors instead of one.
# Falls back to shared GUILD_ID when unset (single-hot-guild mode, Step 4).
pids=()
for i in $(seq 1 "$DRIVERS"); do
  DTAG="${TAG}_d${i}"
  if [ -n "${GUILD_IDS:-}" ]; then
    # shellcheck disable=SC2206
    _GIDS=(${GUILD_IDS//,/ })
    DGID="${_GIDS[$(( (i - 1) % ${#_GIDS[@]} ))]}"
  else
    DGID="${GUILD_ID:-99900000000000000}"
  fi
  # Per-driver token: TOKEN_<i> wins; shared TOKEN is the fallback.
  # Indirect expansion resolves the right variable per driver.
  _TVAR="TOKEN_$i"
  DTOK="${!_TVAR:-${TOKEN:-}}"
  if [ -z "$DTOK" ]; then
    echo "driver $i: no token (set TOKEN_$i or TOKEN)" >&2
    exit 1
  fi
  echo "driver $i guild $DGID token_src=$([ -n "${!_TVAR:-}" ] && echo "TOKEN_$i" || echo TOKEN)"
  RUNG_TARGETS="$PER_TARGET" TAG="$DTAG" GUILD_ID="$DGID" DRIVER_IDX="$i" \
    TOKEN="$DTOK" \
    OUT="$SCRIPT_DIR/results/ws_idle_${DTAG}.json" \
    node "$SCRIPT_DIR/ws_idle_army.js" > "/tmp/ws_split_${DTAG}.log" 2>&1 &
  pids+=($!)
  echo "driver $i pid ${pids[-1]} (tag $DTAG)"
done

fail=0
for pid in "${pids[@]}"; do
  wait "$pid" || fail=1
done

json_args=()
for i in $(seq 1 "$DRIVERS"); do
  json_args+=("$SCRIPT_DIR/results/ws_idle_${TAG}_d${i}.json")
done
python3 - "${json_args[@]}" "$TAG" <<'EOF'
import json, sys
paths = [p for p in sys.argv[1:-1]]
tag = sys.argv[-1]
tot_held = tot_fail = 0
ok = True
per = []
for p in paths:
    try:
        d = json.load(open(p))
    except Exception as e:
        print(f"missing {p}: {e}")
        ok = False
        continue
    tot_held += d.get('final_held', 0)
    tot_fail += d.get('final_failed', 0)
    per.append({k: d.get(k) for k in ('final_held', 'final_failed')})
print(json.dumps({"tag": tag, "drivers": len(paths), "total_held": tot_held,
                  "total_failed": tot_fail, "per_driver": per, "ok": ok}, indent=1))
EOF

exit "$fail"
