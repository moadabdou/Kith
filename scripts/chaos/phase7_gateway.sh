#!/usr/bin/env bash
# scripts/chaos/phase7_gateway.sh — Phase 7c gateway clustering drills (Issue #86)
# Drills: 1) kill actor-holding node, 2) SIGSTOP split-brain + lease,
#         3) api-1/api-2 interleave + shuffled RESUME, 4) resync timing.
# Rule: predictions below were written BEFORE the first run; actuals go to
# postmortems/chaos-log.md.
#
# Predictions (2026-09-24, before run 1):
#  D1 kill: Horde restarts the bench-guild actor on the survivor in <=20s
#     (container reboot dominates). Survivor-node clients keep their sockets
#     and re-subscribe (small gap = posts during the actor-less window are
#     dropped: consumer casts to nil). Dead-node clients go silent until
#     re-IDENTIFY. Zero duplicate deliveries anywhere (dedup + single actor).
#  D2 SIGSTOP 30s: net_ticktime 10s declares the node down in ~10-20s; the
#     frozen holder cannot renew its 10s lease, so the survivor's restarted
#     actor claims it and serves WHILE the old node is still stopped.
#     Early-window posts may gap (cast at frozen actor). Zero dups.
#     lease_acquisitions +1 on survivor. SIGCONT heals silently.
#  D3 interleave: 20 concurrent posts alternating api-1/api-2 all delivered
#     exactly once; shuffled RESUME (behind by 2) replays monotonic frames.
#  D4 timing: kill -> actor-back and kill -> fresh-cohort-whole measured here;
#     gate proposed in docs/gateway-clustering.md from measured numbers.
#
# Usage: ./scripts/chaos/phase7_gateway.sh [1|2|3|4|all]
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
DRIVER="${BENCH_DIR}/phase7_gateway.js"
GUILD_ID="${GUILD_ID:-99900000000000000}"
CHANNEL_ID="${CHANNEL_ID:-99900000000000101}"
API_BASE="${API_BASE:-http://127.0.0.1:8080}"
JWT_SECRET="${JWT_SECRET:-dev-jwt-secret-change-me}"
RESULTS_DIR="${BENCH_DIR}/results"
mkdir -p "${RESULTS_DIR}"

BTOK=$(python3 -c "
import json,hmac,hashlib,base64,time
def b(x): return base64.urlsafe_b64encode(x).rstrip(b'=').decode()
now=int(time.time()); sec=b'${JWT_SECRET}'
h=b(json.dumps({'alg':'HS256','typ':'JWT'}).encode())
p=b(json.dumps({'sub':'99900000000000002','iat':now,'exp':now+604800}).encode())
sig=b(hmac.new(sec,(h+'.'+p).encode(),hashlib.sha256).digest())
print(h+'.'+p+'.'+sig)")
# Drill posts rotate across Admin users/channels so the shared 5/5s rate
# limiter (Phase 7b) never throttles the drill itself. Maps 1:1 onto the
# k6 bench users, who all hold Admin on the bench guild.
declare -A TOKS
for u in $(seq 0 7); do
  BUID=$((99900000000000002 + u))
  TOKS[$u]=$(python3 -c "
import json,hmac,hashlib,base64,time
def b(x): return base64.urlsafe_b64encode(x).rstrip(b'=').decode()
now=int(time.time()); sec=b'${JWT_SECRET}'
h=b(json.dumps({'alg':'HS256','typ':'JWT'}).encode())
p=b(json.dumps({'sub':'${BUID}','iat':now,'exp':now+604800}).encode())
sig=b(hmac.new(sec,(h+'.'+p).encode(),hashlib.sha256).digest())
print(h+'.'+p+'.'+sig)")
done
POST_N=0
POST_N=0
post_msg() { # $1 = content, $2 = api base, [$3 = user idx 0-7, $4 = channel suffix 101-103]
  # NOTE: backgrounded calls run in subshells whose POST_N copies never
  # propagate back — pass explicit U/CH for concurrent batches.
  if [ $# -ge 4 ]; then U=$(($3 % 8)); CH=$4; else POST_N=$((POST_N + 1)); U=$((POST_N % 8)); CH=$((101 + POST_N % 3)); fi
  __SUB=$(echo "${TOKS[$U]}" | cut -d. -f2 | python3 -c "import sys,base64,json; s=sys.stdin.read().strip(); s+='='*(-len(s)%4); print(json.loads(base64.urlsafe_b64decode(s))['sub'])")
  echo "DEBUG post $1 U=${U} sub=${__SUB} ch=99900000000000${CH} base=$2" >&2
  RESP=$(curl -s -w "\n%{http_code}" -X POST "$2/api/guilds/${GUILD_ID}/channels/99900000000000${CH}/messages" \
    -H "Authorization: Bearer ${TOKS[$U]}" -H 'Content-Type: application/json' -d "{\"content\":\"$1\"}")
  CODE=$(echo "${RESP}" | tail -1)
  if [ "${CODE}" != "201" ]; then
    echo "POST FAILED: $1 (user+${U} ch${CH}) -> ${CODE} $(echo "${RESP}" | head -1 | cut -c1-160)" >&2
  fi
}

metric() { # $1 = port, $2 = metric name -> value or 0
  # Never fails: observability reads must not abort drills (set -o pipefail
  # would otherwise propagate a transient curl refusal, e.g. mid-restart).
  curl -s "http://127.0.0.1:$1/metrics" 2>/dev/null | awk -v m="$2" '$1==m {print $2}' | head -1 || true
}

actor_holder() { # prints "gw1" or "gw2": node holding >0 guild actors
  a1=$(metric 4000 gateway_guild_actors_active); a2=$(metric 4001 gateway_guild_actors_active)
  a1=${a1:-0}; a2=${a2:-0}
  if [ "${a2}" -gt "${a1}" ]; then echo "gw2"; else echo "gw1"; fi
}

wait_actor_back() { # $1 = port of survivor, $2 = timeout s -> seconds elapsed or 99
  local start=$(date +%s)
  for _ in $(seq 1 "$2"); do
    n=$(metric "$1" gateway_guild_actors_active); n=${n:-0}
    if [ "${n}" -ge 1 ]; then echo $(( $(date +%s) - start )); return 0; fi
    sleep 1
  done
  echo 99
}

# Bench-specific actor-back: seconds from T_KILL_ISO until the SURVIVOR logs
# a fresh start of THIS guild's actor. The generic counter above is vacuous
# (the survivor always holds other guilds' actors).
bench_actor_back() { # $1 = survivor container, $2 = T_KILL_ISO, $3 = timeout s
  # NOTE: compare truncated to whole seconds. Full RFC3339Nano lexicographic
  # compare fails for same-second restarts ('.' < 'Z'), which once masked
  # sub-second recoveries as 99s timeouts.
  local kill_sec="${2:0:19}"
  for _ in $(seq 1 "$3"); do
    LATEST=$(docker logs --timestamps "$1" 2>/dev/null | grep "Actor \[${GUILD_ID}\] started" | tail -1 | cut -d' ' -f1 | cut -c1-19)
    if [ -n "${LATEST}" ] && [[ "${LATEST}" > "${kill_sec}" || "${LATEST}" == "${kill_sec}" ]]; then
      echo $(( $(date +%s) - $(date -d "$2" +%s) )); return 0
    fi
    sleep 1
  done
  echo 99
}

victim_restart_watch() { # $1 = victim container, $2 = timeout s -> status line
  for _ in $(seq 1 "$2"); do
    ST=$(docker ps --filter "name=$1" --format '{{.Status}}')
    if [ -n "${ST}" ]; then echo "RESTARTED: ${ST}"; return 0; fi
    sleep 1
  done
  echo "NOT_RESTARTED within $2s (restart policy did not fire)"
}

drill1_kill() {
  echo "=== D1: kill actor-holding node ==="
  HOLDER=$(actor_holder); echo "holder: ${HOLDER}"
  if [ "${HOLDER}" = "gw2" ]; then VICTIM=kith-gateway-2-1; SURVIVOR_CONTAINER=kith-gateway-1; SPORT=4000; VPORT=4001;
  else VICTIM=kith-gateway-1; SURVIVOR_CONTAINER=kith-gateway-2-1; SPORT=4001; VPORT=4000; fi

  WS_URLS='ws://127.0.0.1:4000/ws,ws://127.0.0.1:4001/ws' CLIENTS=4 TOKEN="${BTOK}" \
    RUN_SECONDS=200 TAG=d1 node "${DRIVER}" > "${RESULTS_DIR}/phase7_d1.json" 2>"${RESULTS_DIR}/phase7_d1.log" &
  DRV=$!
  sleep 6  # clients READY
  for i in 1 2 3; do post_msg "d1-pre-$i" "${API_BASE}" >/dev/null; sleep 1; done
  T_KILL=$(date +%s); T_KILL_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "killing ${VICTIM} at ${T_KILL} (${T_KILL_ISO})"
  docker kill "${VICTIM}" >/dev/null
  sleep 3
  for i in 1 2 3; do post_msg "d1-during-$i" "${API_BASE}" >/dev/null; sleep 1; done
  BACK_IN=$(wait_actor_back "${SPORT}" 60)
  BENCH_BACK_IN=$(bench_actor_back "${SURVIVOR_CONTAINER}" "${T_KILL_ISO}" 60)
  echo "actor (any) back on survivor in ${BACK_IN}s; bench actor back in ${BENCH_BACK_IN}s"
  echo "victim container: $(victim_restart_watch "${VICTIM}" 60)"
  sleep 3
  for i in 1 2 3; do post_msg "d1-post-$i" "${API_BASE}" >/dev/null; sleep 1; done
  wait "${DRV}"
  echo "--- D1 client summary ---"
  python3 -c "
import json
s = json.load(open('${RESULTS_DIR}/phase7_d1.json'))
tk = ${T_KILL} * 1000
for c in s['clients']:
    after = [f['t'] - tk for f in c.get('frames', []) if f.get('t', 0) > tk]
    first_after = min(after) if after else None
    print(c['url'], 'recv', c['received'], 'uniq', c['unique_ids'], 'dups', len(c['dup_ids']),
          'first_frame_after_kill_ms=', first_after)
"
  echo "T_KILL=${T_KILL} BACK_IN=${BACK_IN}s BENCH_BACK_IN=${BENCH_BACK_IN}s"
}

drill2_sigstop() {
  echo "=== D2: SIGSTOP split-brain + lease (30s) ==="
  HOLDER=$(actor_holder); echo "holder: ${HOLDER}"
  if [ "${HOLDER}" = "gw2" ]; then VICTIM=kith-gateway-2-1; SPORT=4000; else VICTIM=kith-gateway-1; SPORT=4001; fi
  ACQ_BEFORE=$(metric "${SPORT}" gateway_guild_lease_acquisitions_total); ACQ_BEFORE=${ACQ_BEFORE:-0}

  WS_URLS='ws://127.0.0.1:4000/ws,ws://127.0.0.1:4001/ws' CLIENTS=4 TOKEN="${BTOK}" \
    RUN_SECONDS=70 TAG=d2 node "${DRIVER}" > "${RESULTS_DIR}/phase7_d2.json" 2>"${RESULTS_DIR}/phase7_d2.log" &
  DRV=$!
  sleep 6
  for i in 1 2; do post_msg "d2-pre-$i" "${API_BASE}" >/dev/null; sleep 1; done
  echo "SIGSTOP ${VICTIM} for 30s"
  docker kill --signal SIGSTOP "${VICTIM}" >/dev/null
  sleep 5
  for i in 1 2 3 4; do post_msg "d2-stop-$i" "${API_BASE}" >/dev/null; sleep 4; done
  sleep 9
  docker kill --signal SIGCONT "${VICTIM}" >/dev/null
  echo "SIGCONT sent; settling 10s"
  sleep 10
  for i in 1 2; do post_msg "d2-post-$i" "${API_BASE}" >/dev/null; sleep 1; done
  wait "${DRV}"
  ACQ_AFTER=$(metric "${SPORT}" gateway_guild_lease_acquisitions_total); ACQ_AFTER=${ACQ_AFTER:-0}
  echo "--- D2 client summary (dups must be 0) ---"
  python3 -c "
import json
s = json.load(open('${RESULTS_DIR}/phase7_d2.json'))
tot_dups = 0
for c in s['clients']:
    print(c['url'], 'recv', c['received'], 'uniq', c['unique_ids'], 'dups', len(c['dup_ids']))
    tot_dups += len(c['dup_ids'])
print('TOTAL_DUPS=', tot_dups)
"
  echo "lease_acquisitions on survivor: ${ACQ_BEFORE} -> ${ACQ_AFTER}"
}

drill3_interleave() {
  echo "=== D3: api-1/api-2 interleave + shuffled RESUME ==="
  # Resume client collects live traffic, disconnects through a missed
  # window, then replays behind by 2: replay must be monotonic, dup-free,
  # and cover the missed posts.
  WS_URLS='ws://127.0.0.1:4000/ws' CLIENTS=1 TOKEN="${BTOK}" MODE=resume \
    RESUME_BEHIND=2 TAG=d3 node "${DRIVER}" > "${RESULTS_DIR}/phase7_d3.json" 2>"${RESULTS_DIR}/phase7_d3.log" &
  DRV=$!
  # Post only once the resume client is READY (else traffic lands before
  # IDENTIFY and the collect window is vacuous).
  for _ in $(seq 1 20); do
    grep -q "clients READY\|identified session" "${RESULTS_DIR}/phase7_d3.log" 2>/dev/null && break
    sleep 0.5
  done
  PIDS=""
  for i in $(seq 1 5); do
    post_msg "d3-live-$i" "http://127.0.0.1:8080" "$i" "10$((i % 3 + 1))" &
    PIDS="$PIDS $!"
    post_msg "d3-live-$i" "http://127.0.0.1:8081" "$((i + 3))" "10$((i % 3 + 1))" &
    PIDS="$PIDS $!"
  done
  wait $PIDS; PIDS=""
  sleep 2  # driver closes, misses the next window
  for i in $(seq 1 3); do
    post_msg "d3-missed-$i" "http://127.0.0.1:8080" >/dev/null
    sleep 1
  done
  wait "${DRV}"
  echo "--- D3 resume summary ---"
  cat "${RESULTS_DIR}/phase7_d3.json"
}

drill4_timing() {
  echo "=== D4: resync timing (fresh cohort after kill) ==="
  HOLDER=$(actor_holder); echo "holder: ${HOLDER}"
  # NOTE: killed victims do NOT restart here (observed: unless-stopped did
  # not fire after docker kill), so the fresh cohort targets the SURVIVOR
  # only — this measures failover resync, not rejoin.
  if [ "${HOLDER}" = "gw2" ]; then VICTIM=kith-gateway-2-1; SPORT=4000; SURVIVOR_CONTAINER=kith-gateway-1; COHORT_WS='ws://127.0.0.1:4000/ws'; else VICTIM=kith-gateway-1; SPORT=4001; SURVIVOR_CONTAINER=kith-gateway-2-1; COHORT_WS='ws://127.0.0.1:4001/ws'; fi
  T_KILL=$(date +%s)
  docker kill "${VICTIM}" >/dev/null
  echo "killed ${VICTIM} at ${T_KILL}; starting fresh cohort immediately (it creates the actor itself by subscribing)"
  WS_URLS="${COHORT_WS}" CLIENTS=4 TOKEN="${BTOK}" \
    RUN_SECONDS=25 TAG=d4 node "${DRIVER}" > "${RESULTS_DIR}/phase7_d4.json" 2>"${RESULTS_DIR}/phase7_d4.log" &
  DRV=$!
  # READY-gated posts (D3 pattern): traffic must exist when clients can hear
  # it, not at a fixed offset.
  for _ in $(seq 1 20); do
    grep -q "clients READY" "${RESULTS_DIR}/phase7_d4.log" 2>/dev/null && break
    sleep 0.5
  done
  for i in 1 2 3; do post_msg "d4-$i" "${API_BASE}" >/dev/null; sleep 1; done
  wait "${DRV}"
  python3 -c "
import json
s = json.load(open('${RESULTS_DIR}/phase7_d4.json'))
ok = all(c['received'] >= 3 and len(c['dup_ids']) == 0 for c in s['clients'])
for c in s['clients']:
    print(c['url'], 'recv', c['received'], 'dups', len(c['dup_ids']))
print('COHORT_WHOLE=', ok)
"
  echo "T_KILL=${T_KILL} T_NOW=$(date +%s)"
}

case "${1:-all}" in
  1) drill1_kill ;;
  2) drill2_sigstop ;;
  3) drill3_interleave ;;
  4) drill4_timing ;;
  all) drill1_kill; drill2_sigstop; drill3_interleave; drill4_timing ;;
esac
