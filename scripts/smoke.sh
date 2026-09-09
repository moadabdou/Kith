#!/usr/bin/env bash
# scripts/smoke.sh — End-to-end smoke test for Kith Phase 0 Gate
# Register → Login → Create Guild → Create Channel → Send Message → Read Back
set -euo pipefail

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

API_BASE="${API_BASE:-http://localhost:80/api}"

step=0
total_steps=7

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

# Require curl and jq
command -v curl >/dev/null 2>&1 || { echo "Error: curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq is required" >&2; exit 1; }

echo ""
printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║                KITH PHASE 0 SMOKE TEST                       ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"
log_info "Target API: ${API_BASE}"

# Generate random unique credentials
RAND_ID="$(date +%s)_$((RANDOM % 10000))"
TEST_USER="smoke_${RAND_ID}"
TEST_EMAIL="smoke_${RAND_ID}@example.com"
TEST_PASS="SmokePass_${RAND_ID}!"
GUILD_NAME="smoke-guild-${RAND_ID}"
CHANNEL_NAME="smoke-channel"
MSG_TEXT="Hello from Phase 0 smoke test! [${RAND_ID}]"

# ── 1. Register ──────────────────────────────────────────────
log_step "Registering user (${TEST_USER})..."
REGISTER_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${API_BASE}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"${TEST_USER}\", \"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASS}\"}")"

REG_STATUS="$(echo "${REGISTER_RESP}" | tail -n1)"
REG_BODY="$(echo "${REGISTER_RESP}" | sed '$d')"

if [ "${REG_STATUS}" -ne 201 ]; then
  log_fail "Registration failed (HTTP ${REG_STATUS}): ${REG_BODY}"
fi

USER_ID="$(echo "${REG_BODY}" | jq -r '.id // empty')"
if [ -z "${USER_ID}" ]; then
  log_fail "Registration succeeded but user ID is missing from response: ${REG_BODY}"
fi
log_pass "Registered successfully (ID: ${USER_ID})"

# ── 2. Login ─────────────────────────────────────────────────
log_step "Logging in..."
LOGIN_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${API_BASE}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"login\": \"${TEST_USER}\", \"password\": \"${TEST_PASS}\"}")"

LOGIN_STATUS="$(echo "${LOGIN_RESP}" | tail -n1)"
LOGIN_BODY="$(echo "${LOGIN_RESP}" | sed '$d')"

if [ "${LOGIN_STATUS}" -ne 200 ]; then
  log_fail "Login failed (HTTP ${LOGIN_STATUS}): ${LOGIN_BODY}"
fi

TOKEN="$(echo "${LOGIN_BODY}" | jq -r '.token // empty')"
if [ -z "${TOKEN}" ]; then
  log_fail "Login succeeded but token is missing from response: ${LOGIN_BODY}"
fi
log_pass "JWT acquired"

# ── 3. Create Guild ──────────────────────────────────────────
log_step "Creating guild (${GUILD_NAME})..."
GUILD_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${API_BASE}/guilds" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"name\": \"${GUILD_NAME}\"}")"

GUILD_STATUS="$(echo "${GUILD_RESP}" | tail -n1)"
GUILD_BODY="$(echo "${GUILD_RESP}" | sed '$d')"

if [ "${GUILD_STATUS}" -ne 201 ]; then
  log_fail "Guild creation failed (HTTP ${GUILD_STATUS}): ${GUILD_BODY}"
fi

GUILD_ID="$(echo "${GUILD_BODY}" | jq -r '.id // empty')"
if [ -z "${GUILD_ID}" ]; then
  log_fail "Guild created but id is missing from response: ${GUILD_BODY}"
fi
log_pass "Guild created (ID: ${GUILD_ID})"

# ── 4. Create Channel ────────────────────────────────────────
log_step "Creating channel (#${CHANNEL_NAME})..."
CHANNEL_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${API_BASE}/guilds/${GUILD_ID}/channels" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"name\": \"${CHANNEL_NAME}\", \"type\": 0}")"

CHANNEL_STATUS="$(echo "${CHANNEL_RESP}" | tail -n1)"
CHANNEL_BODY="$(echo "${CHANNEL_RESP}" | sed '$d')"

if [ "${CHANNEL_STATUS}" -ne 201 ]; then
  log_fail "Channel creation failed (HTTP ${CHANNEL_STATUS}): ${CHANNEL_BODY}"
fi

CHANNEL_ID="$(echo "${CHANNEL_BODY}" | jq -r '.id // empty')"
if [ -z "${CHANNEL_ID}" ]; then
  log_fail "Channel created but id is missing from response: ${CHANNEL_BODY}"
fi
log_pass "Channel created (ID: ${CHANNEL_ID})"

# ── 5. Send Message ──────────────────────────────────────────
log_step "Sending message..."
SEND_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${API_BASE}/guilds/${GUILD_ID}/channels/${CHANNEL_ID}/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"content\": \"${MSG_TEXT}\"}")"

SEND_STATUS="$(echo "${SEND_RESP}" | tail -n1)"
SEND_BODY="$(echo "${SEND_RESP}" | sed '$d')"

if [ "${SEND_STATUS}" -ne 201 ]; then
  log_fail "Sending message failed (HTTP ${SEND_STATUS}): ${SEND_BODY}"
fi

MSG_ID="$(echo "${SEND_BODY}" | jq -r '.id // empty')"
if [ -z "${MSG_ID}" ]; then
  log_fail "Message sent but id is missing from response: ${SEND_BODY}"
fi
log_pass "Message sent (ID: ${MSG_ID})"

# ── 6. Read Back Messages ────────────────────────────────────
log_step "Reading back messages from channel..."
READ_RESP="$(curl -sS -w "\n%{http_code}" -X GET "${API_BASE}/guilds/${GUILD_ID}/channels/${CHANNEL_ID}/messages?limit=10" \
  -H "Authorization: Bearer ${TOKEN}")"

READ_STATUS="$(echo "${READ_RESP}" | tail -n1)"
READ_BODY="$(echo "${READ_RESP}" | sed '$d')"

if [ "${READ_STATUS}" -ne 200 ]; then
  log_fail "Reading messages failed (HTTP ${READ_STATUS}): ${READ_BODY}"
fi

FOUND_MSG="$(echo "${READ_BODY}" | jq -r --arg id "${MSG_ID}" '.[] | select(.id == $id) | .content // empty')"

if [ -z "${FOUND_MSG}" ]; then
  log_fail "Sent message ID ${MSG_ID} not found in channel messages response: ${READ_BODY}"
fi

if [ "${FOUND_MSG}" != "${MSG_TEXT}" ]; then
  log_fail "Message content mismatch! Expected '${MSG_TEXT}', got '${FOUND_MSG}'"
fi
log_pass "Verified message content matches exactly"

# ── 7. Roles & Hoist Verification (Phase 2 #29) ──────────────
log_step "Verifying roles and hoist flags..."
ADMIN_ROLE_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${API_BASE}/guilds/${GUILD_ID}/roles" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"name": "Admin", "color": 15158332, "hoist": true, "position": 2, "permissions": "8", "mentionable": true}')"

ADMIN_STATUS="$(echo "${ADMIN_ROLE_RESP}" | tail -n1)"
ADMIN_BODY="$(echo "${ADMIN_ROLE_RESP}" | sed '$d')"
if [ "${ADMIN_STATUS}" -ne 201 ]; then
  log_fail "Admin role creation failed (HTTP ${ADMIN_STATUS}): ${ADMIN_BODY}"
fi

ADMIN_HOIST="$(echo "${ADMIN_BODY}" | jq -r '.hoist')"
ADMIN_ROLE_ID="$(echo "${ADMIN_BODY}" | jq -r '.id')"
if [ "${ADMIN_HOIST}" != "true" ]; then
  log_fail "Admin role expected hoist=true, got: ${ADMIN_HOIST}"
fi
log_pass "Created hoisted role Admin (ID: ${ADMIN_ROLE_ID}, hoist=true)"

MEMBER_ROLE_RESP="$(curl -sS -w "\n%{http_code}" -X POST "${API_BASE}/guilds/${GUILD_ID}/roles" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"name": "Member", "hoist": false, "position": 1}')"

MEMBER_STATUS="$(echo "${MEMBER_ROLE_RESP}" | tail -n1)"
MEMBER_BODY="$(echo "${MEMBER_ROLE_RESP}" | sed '$d')"
if [ "${MEMBER_STATUS}" -ne 201 ]; then
  log_fail "Member role creation failed (HTTP ${MEMBER_STATUS}): ${MEMBER_BODY}"
fi

MEMBER_HOIST="$(echo "${MEMBER_BODY}" | jq -r '.hoist')"
MEMBER_ROLE_ID="$(echo "${MEMBER_BODY}" | jq -r '.id')"
if [ "${MEMBER_HOIST}" != "false" ]; then
  log_fail "Member role expected hoist=false, got: ${MEMBER_HOIST}"
fi
log_pass "Created unhoisted role Member (ID: ${MEMBER_ROLE_ID}, hoist=false)"

# Query roles list
ROLES_RESP="$(curl -sS -w "\n%{http_code}" -X GET "${API_BASE}/guilds/${GUILD_ID}/roles" \
  -H "Authorization: Bearer ${TOKEN}")"

ROLES_STATUS="$(echo "${ROLES_RESP}" | tail -n1)"
ROLES_BODY="$(echo "${ROLES_RESP}" | sed '$d')"
if [ "${ROLES_STATUS}" -ne 200 ]; then
  log_fail "Listing roles failed (HTTP ${ROLES_STATUS}): ${ROLES_BODY}"
fi

FOUND_ADMIN_HOIST="$(echo "${ROLES_BODY}" | jq -r --arg id "${ADMIN_ROLE_ID}" '.[] | select(.id == $id) | .hoist')"
FOUND_MEMBER_HOIST="$(echo "${ROLES_BODY}" | jq -r --arg id "${MEMBER_ROLE_ID}" '.[] | select(.id == $id) | .hoist')"
if [ "${FOUND_ADMIN_HOIST}" != "true" ] || [ "${FOUND_MEMBER_HOIST}" != "false" ]; then
  log_fail "Roles query hoist values mismatch: Admin hoist=${FOUND_ADMIN_HOIST} (want true), Member hoist=${FOUND_MEMBER_HOIST} (want false)"
fi
log_pass "Verified roles query returns hoist: true/false in JSON response"

# Patch role to hoist=true
PATCH_RESP="$(curl -sS -w "\n%{http_code}" -X PATCH "${API_BASE}/guilds/${GUILD_ID}/roles/${MEMBER_ROLE_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"name": "Moderator", "hoist": true}')"

PATCH_STATUS="$(echo "${PATCH_RESP}" | tail -n1)"
PATCH_BODY="$(echo "${PATCH_RESP}" | sed '$d')"
if [ "${PATCH_STATUS}" -ne 200 ]; then
  log_fail "Patching role failed (HTTP ${PATCH_STATUS}): ${PATCH_BODY}"
fi

PATCHED_HOIST="$(echo "${PATCH_BODY}" | jq -r '.hoist')"
if [ "${PATCHED_HOIST}" != "true" ]; then
  log_fail "Patched role expected hoist=true, got: ${PATCHED_HOIST}"
fi
log_pass "Patched Member role to Moderator with hoist=true"

# ── Summary ──────────────────────────────────────────────────
echo ""
printf "${GREEN}${BOLD}══════════════════════════════════════════════════════════════${NC}\n"
printf "${GREEN}${BOLD} ✔ Phase 0 + Phase 2 Smoke Test PASSED end-to-end!             ${NC}\n"
printf "   User:     %-30s (ID: %s)\n" "${TEST_USER}" "${USER_ID}"
printf "   Guild:    %-30s (ID: %s)\n" "${GUILD_NAME}" "${GUILD_ID}"
printf "   Channel:  %-30s (ID: %s)\n" "#${CHANNEL_NAME}" "${CHANNEL_ID}"
printf "   Message:  %-30s (ID: %s)\n" "${MSG_TEXT:0:30}..." "${MSG_ID}"
printf "   Roles:    Admin (hoist=true), Moderator (hoist=true)\n"
printf "${GREEN}${BOLD}══════════════════════════════════════════════════════════════${NC}\n"
echo ""
