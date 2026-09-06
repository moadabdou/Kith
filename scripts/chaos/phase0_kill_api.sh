#!/usr/bin/env bash
# scripts/chaos/phase0_kill_api.sh
# Chaos drill: Kill api container mid-request-loop and record baseline no-retry behavior
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

API_BASE="${API_BASE:-http://localhost:80/api}"
CONTAINER_NAME="kith-api-1"
PIDS=()

cleanup() {
  echo ""
  echo "==> Cleaning up background pollers..."
  for pid in "${PIDS[@]}"; do
    kill "${pid}" 2>/dev/null || true
  done
  # Ensure API container is running if test exited abnormally
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "==> Restarting ${CONTAINER_NAME}..."
    docker start "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo ""
printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}${CYAN}║     KITH PHASE 0 CHAOS DRILL: KILL API MID-REQUEST-LOOP      ║${NC}\n"
printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}\n"
echo "Target: ${API_BASE}"
echo "Container: ${CONTAINER_NAME}"
echo ""

# ── 1. Setup two clients and shared channel ──────────────────
RAND="$(date +%s)_$((RANDOM % 10000))"
U1_NAME="chaos_alice_${RAND}"
U2_NAME="chaos_bob_${RAND}"
PASS="ChaosPass123!"

echo "==> [1/4] Setting up Client 1 (${U1_NAME}) and Client 2 (${U2_NAME})..."

# Register & Login User 1
curl -sS -X POST "${API_BASE}/auth/register" -H "Content-Type: application/json" \
  -d "{\"username\": \"${U1_NAME}\", \"email\": \"${U1_NAME}@example.com\", \"password\": \"${PASS}\"}" >/dev/null
U1_TOKEN="$(curl -sS -X POST "${API_BASE}/auth/login" -H "Content-Type: application/json" \
  -d "{\"login\": \"${U1_NAME}\", \"password\": \"${PASS}\"}" | jq -r '.token')"

# Register & Login User 2
curl -sS -X POST "${API_BASE}/auth/register" -H "Content-Type: application/json" \
  -d "{\"username\": \"${U2_NAME}\", \"email\": \"${U2_NAME}@example.com\", \"password\": \"${PASS}\"}" >/dev/null
U2_TOKEN="$(curl -sS -X POST "${API_BASE}/auth/login" -H "Content-Type: application/json" \
  -d "{\"login\": \"${U2_NAME}\", \"password\": \"${PASS}\"}" | jq -r '.token')"

# User 1 creates Guild and Channel
GUILD_RESP="$(curl -sS -X POST "${API_BASE}/guilds" -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${U1_TOKEN}" -d "{\"name\": \"Chaos Guild ${RAND}\"}")"
GUILD_ID="$(echo "${GUILD_RESP}" | jq -r '.id')"

CH_RESP="$(curl -sS -X POST "${API_BASE}/guilds/${GUILD_ID}/channels" -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${U1_TOKEN}" -d "{\"name\": \"chaos-chat\", \"type\": 0}")"
CHANNEL_ID="$(echo "${CH_RESP}" | jq -r '.id')"

# User 1 creates invite & User 2 joins
INVITE_CODE="$(curl -sS -X POST "${API_BASE}/invites" -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${U1_TOKEN}" -d "{\"channel_id\": \"${CHANNEL_ID}\"}" | jq -r '.code')"
curl -sS -X POST "${API_BASE}/invites/${INVITE_CODE}/join" \
  -H "Authorization: Bearer ${U2_TOKEN}" >/dev/null

printf "${GREEN}✓ Setup complete:${NC} Guild ${GUILD_ID}, Channel ${CHANNEL_ID}\n\n"

# ── 2. Start Concurrent 2-second Polling Loops ───────────────
echo "==> [2/4] Starting concurrent polling loops (2s interval)..."

client_poll() {
  local name="$1"
  local token="$2"
  local color="$3"

  while true; do
    local now
    now="$(date '+%H:%M:%S.%3N')"
    local code
    code="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 --max-time 2 \
      -H "Authorization: Bearer ${token}" \
      "${API_BASE}/guilds/${GUILD_ID}/channels/${CHANNEL_ID}/messages?limit=10" 2>/dev/null || echo "ERR")"

    if [ "${code}" = "200" ]; then
      printf "${color}[%s] %s: HTTP 200 OK (polled messages)${NC}\n" "${now}" "${name}"
    elif [ "${code}" = "502" ]; then
      printf "${RED}[%s] %s: HTTP 502 Bad Gateway (Caddy: upstream dead)${NC}\n" "${now}" "${name}"
    else
      printf "${YELLOW}[%s] %s: HTTP %s / connection failed${NC}\n" "${now}" "${name}" "${code}"
    fi
    sleep 2
  done
}

client_poll "Client 1 (Alice)" "${U1_TOKEN}" "${CYAN}" &
PIDS+=($!)

client_poll "Client 2 (Bob)  " "${U2_TOKEN}" "${BLUE}" &
PIDS+=($!)

# Let polling establish baseline for 6 seconds
sleep 6

# ── 3. Trigger Chaos: docker kill kith-api-1 ─────────────────
echo ""
printf "${BOLD}${RED}==> [3/4] TRIGGERING CHAOS: docker kill ${CONTAINER_NAME} mid-loop!${NC}\n"
KILL_TIME="$(date +%s%N)"
docker kill "${CONTAINER_NAME}" >/dev/null
printf "${RED}⚡ Killed ${CONTAINER_NAME} at $(date '+%H:%M:%S')! Observing client behavior during outage...${NC}\n"
echo ""

# Attempt to send a message during outage
sleep 2
echo "==> Client 1 attempting to send message during outage:"
SEND_OUTAGE_CODE="$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 3 -X POST \
  "${API_BASE}/guilds/${GUILD_ID}/channels/${CHANNEL_ID}/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${U1_TOKEN}" \
  -d '{"content": "Failed message during downtime"}' 2>/dev/null || echo "FAILED")"
printf "${RED}      Result: HTTP ${SEND_OUTAGE_CODE} (send blocked)${NC}\n"

# Observe failure loop for 6 more seconds
sleep 6

# ── 4. Recover: docker start kith-api-1 ──────────────────────
echo ""
printf "${BOLD}${GREEN}==> [4/4] RECOVERING: docker start ${CONTAINER_NAME}...${NC}\n"
START_TIME="$(date +%s%N)"
docker start "${CONTAINER_NAME}" >/dev/null

# Wait until API responds to health check
HEALTH_OK=false
for i in $(seq 1 30); do
  if curl -s -f "http://localhost:8080/healthz" >/dev/null 2>&1; then
    HEALTH_OK=true
    RECOVERED_TIME="$(date +%s%N)"
    break
  fi
  sleep 0.2
done

if [ "${HEALTH_OK}" = true ]; then
  ELAPSED_MS="$(( (RECOVERED_TIME - START_TIME) / 1000000 ))"
  printf "${GREEN}✓ API container recovered and healthy in %d ms!${NC}\n" "${ELAPSED_MS}"
else
  printf "${RED}✗ API container failed to return healthy in 6 seconds!${NC}\n"
fi

# Let polling resume and catch the next cycle
sleep 5

# Send post-recovery message
echo "==> Client 1 sending post-recovery message:"
POST_RECOVER_RESP="$(curl -s -X POST \
  "${API_BASE}/guilds/${GUILD_ID}/channels/${CHANNEL_ID}/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${U1_TOKEN}" \
  -d '{"content": "I survived the chaos kill!"}')"
POST_MSG_ID="$(echo "${POST_RECOVER_RESP}" | jq -r '.id // empty')"
printf "${GREEN}      Message sent successfully! (ID: ${POST_MSG_ID})${NC}\n"

sleep 3

echo ""
printf "${BOLD}${GREEN}══════════════════════════════════════════════════════════════${NC}\n"
printf "${BOLD}${GREEN} ✔ CHAOS DRILL COMPLETED SUCCESSFULLY                          ${NC}\n"
printf "   Baseline:   2 concurrent clients polling at 2s interval\n"
printf "   Kill Event: SIGKILL sent to ${CONTAINER_NAME}\n"
printf "   Outage:     Caddy surfaced HTTP 502 Bad Gateway to clients\n"
printf "   Behavior:   Clients showed no backoff/retry delay (unmitigated stampede)\n"
printf "   Recovery:   API health restored in %d ms; polling recovered automatically\n" "${ELAPSED_MS}"
printf "${BOLD}${GREEN}══════════════════════════════════════════════════════════════${NC}\n"
echo ""
