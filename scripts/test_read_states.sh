#!/usr/bin/env bash
# scripts/test_read_states.sh — E2E test for ScyllaDB read states & gateway routing
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

API_BASE="${API_BASE:-http://localhost:80/api}"

step=0
total_steps=8

log_step() {
  step=$((step + 1))
  printf "${BLUE}${BOLD}[%d/%d] %s${NC}\n" "$step" "$total_steps" "$1"
}

log_pass() {
  printf "      ${GREEN}✓ %s${NC}\n" "$1"
}

log_fail() {
  printf "      ${RED}✗ %s${NC}\n" "$1"
  exit 1
}

log_info() {
  printf "      ${YELLOW}ℹ %s${NC}\n" "$1"
}

command -v curl >/dev/null 2>&1 || { echo "curl required"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq required"; exit 1; }

echo ""
printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║          SCYLLADB READ STATES INTEGRATION TEST               ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"

RAND_ID="$(date +%s)_$((RANDOM % 10000))"
USER_A="ack_user_a_${RAND_ID}"
USER_B="ack_user_b_${RAND_ID}"
PASS="TestPass_${RAND_ID}!"

# ── 1. Register and Login User A and User B ─────────────────
log_step "Registering User A and User B..."
RESP_A=$(curl -s -X POST "${API_BASE}/auth/register" -H "Content-Type: application/json" \
  -d "{\"username\": \"${USER_A}\", \"email\": \"${USER_A}@test.com\", \"password\": \"${PASS}\"}")
USER_A_ID=$(echo "$RESP_A" | jq -r '.id // empty')
[ -n "$USER_A_ID" ] || log_fail "User A registration failed: $RESP_A"

RESP_B=$(curl -s -X POST "${API_BASE}/auth/register" -H "Content-Type: application/json" \
  -d "{\"username\": \"${USER_B}\", \"email\": \"${USER_B}@test.com\", \"password\": \"${PASS}\"}")
USER_B_ID=$(echo "$RESP_B" | jq -r '.id // empty')
[ -n "$USER_B_ID" ] || log_fail "User B registration failed: $RESP_B"

LOGIN_A=$(curl -s -X POST "${API_BASE}/auth/login" -H "Content-Type: application/json" \
  -d "{\"login\": \"${USER_A}\", \"password\": \"${PASS}\"}")
TOKEN_A=$(echo "$LOGIN_A" | jq -r '.token // empty')
[ -n "$TOKEN_A" ] || log_fail "User A login failed: $LOGIN_A"

LOGIN_B=$(curl -s -X POST "${API_BASE}/auth/login" -H "Content-Type: application/json" \
  -d "{\"login\": \"${USER_B}\", \"password\": \"${PASS}\"}")
TOKEN_B=$(echo "$LOGIN_B" | jq -r '.token // empty')
[ -n "$TOKEN_B" ] || log_fail "User B login failed: $LOGIN_B"

log_pass "Registered and logged in User A (id: ${USER_A_ID}) and User B (id: ${USER_B_ID})"

# ── 2. User A creates guild and channel ─────────────────────
log_step "User A creates guild and channel..."
GUILD_RESP=$(curl -s -X POST "${API_BASE}/guilds" -H "Authorization: Bearer ${TOKEN_A}" \
  -H "Content-Type: application/json" -d "{\"name\": \"AckGuild-${RAND_ID}\"}")
GUILD_ID=$(echo "$GUILD_RESP" | jq -r '.id // empty')
[ -n "$GUILD_ID" ] || log_fail "Guild creation failed: $GUILD_RESP"

CHAN_RESP=$(curl -s -X POST "${API_BASE}/guilds/${GUILD_ID}/channels" -H "Authorization: Bearer ${TOKEN_A}" \
  -H "Content-Type: application/json" -d "{\"name\": \"ack-testing\", \"type\": 0}")
CHANNEL_ID=$(echo "$CHAN_RESP" | jq -r '.id // empty')
[ -n "$CHANNEL_ID" ] || log_fail "Channel creation failed: $CHAN_RESP"
log_pass "Created Guild (${GUILD_ID}) and Channel (${CHANNEL_ID})"

# ── 3. User B joins the guild via invite ─────────────────────
log_step "User B joins the guild via invite..."
INVITE_RESP=$(curl -s -X POST "${API_BASE}/invites" -H "Authorization: Bearer ${TOKEN_A}" \
  -H "Content-Type: application/json" -d "{\"channel_id\": \"${CHANNEL_ID}\", \"max_age\": 3600, \"max_uses\": 1}")
INVITE_CODE=$(echo "$INVITE_RESP" | jq -r '.code // empty')
[ -n "$INVITE_CODE" ] || log_fail "Invite creation failed: $INVITE_RESP"

JOIN_RESP=$(curl -s -X POST "${API_BASE}/invites/${INVITE_CODE}/join" -H "Authorization: Bearer ${TOKEN_B}")
JOIN_GUILD_ID=$(echo "$JOIN_RESP" | jq -r '.id // empty')
[ "$JOIN_GUILD_ID" = "$GUILD_ID" ] || log_fail "User B join failed: $JOIN_RESP"
log_pass "User B joined Guild ${GUILD_ID}"

# ── 4. User B sends message ─────────────────────────────────
log_step "User B sends a message..."
MSG_RESP=$(curl -s -X POST "${API_BASE}/channels/${CHANNEL_ID}/messages" -H "Authorization: Bearer ${TOKEN_B}" \
  -H "Content-Type: application/json" -d "{\"content\": \"Message for ack test ${RAND_ID}\"}")
MSG_ID=$(echo "$MSG_RESP" | jq -r '.id // empty')
[ -n "$MSG_ID" ] || log_fail "Message send failed: $MSG_RESP"
log_pass "User B sent Message ID ${MSG_ID}"

# ── 5. User A ACKs the message ──────────────────────────────
log_step "User A sends POST /channels/${CHANNEL_ID}/messages/${MSG_ID}/ack..."
ACK_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${API_BASE}/channels/${CHANNEL_ID}/messages/${MSG_ID}/ack" \
  -H "Authorization: Bearer ${TOKEN_A}" \
  -H "Content-Type: application/json" \
  -d "{\"manual\": false, \"mention_count\": 0}")
[ "$ACK_CODE" = "204" ] || log_fail "Expected 204 No Content for ack, got: $ACK_CODE"
log_pass "ACK endpoint returned 204 No Content"

# ── 6. Query ScyllaDB point upsert directly ─────────────────
log_step "Verifying LWT-free point upsert in ScyllaDB kith.read_states..."
SCYLLA_OUT=$(docker compose exec scylla cqlsh -e \
  "SELECT user_id, channel_id, last_read_message_id, mention_count FROM kith.read_states WHERE user_id = ${USER_A_ID} AND channel_id = ${CHANNEL_ID};" 2>&1)
echo "$SCYLLA_OUT"
echo "$SCYLLA_OUT" | grep -q "${MSG_ID}" || log_fail "ScyllaDB row missing expected last_read_message_id: ${MSG_ID}"
log_pass "ScyllaDB contains row: user_id=${USER_A_ID}, channel_id=${CHANNEL_ID}, last_read_message_id=${MSG_ID}"

# ── 7. REST read-state endpoints ────────────────────────────
log_step "Checking GET /api/channels/{id}/read-state and GET /api/users/@me/read-states..."
STATE_RESP=$(curl -s -X GET "${API_BASE}/channels/${CHANNEL_ID}/read-state" -H "Authorization: Bearer ${TOKEN_A}")
STATE_MSG_ID=$(echo "$STATE_RESP" | jq -r '.last_read_message_id // empty')
[ "$STATE_MSG_ID" = "$MSG_ID" ] || log_fail "GET channel read-state returned wrong last_read_message_id: $STATE_RESP"
log_pass "Channel read state confirmed: last_read_message_id=${STATE_MSG_ID}"

ALL_STATES=$(curl -s -X GET "${API_BASE}/users/@me/read-states" -H "Authorization: Bearer ${TOKEN_A}")
HAS_CHANNEL=$(echo "$ALL_STATES" | jq --arg cid "$CHANNEL_ID" 'map(select(.channel_id == $cid)) | length')
[ "$HAS_CHANNEL" -ge 1 ] || log_fail "GET users/@me/read-states missing channel: $ALL_STATES"
log_pass "User read states list contains channel ${CHANNEL_ID}"

# ── 8. Gateway virtual routing isolation test ───────────────
log_step "Verifying Gateway WebSocket MESSAGE_ACK routing isolation (self-targeted, no leak to peer)..."
(cd scripts && go run bench/verify_gateway_ack.go \
  -api "${API_BASE}" \
  -token-a "${TOKEN_A}" \
  -token-b "${TOKEN_B}" \
  -channel "${CHANNEL_ID}" \
  -user-a "${USER_A_ID}" \
  -user-b "${USER_B_ID}" \
  -msg-id "${MSG_ID}")

log_pass "Gateway MESSAGE_ACK routing verified: User A received ack event, User B received 0 ack events!"

printf "\n${GREEN}${BOLD}ALL READ STATES TESTS PASSED!${NC}\n\n"
