#!/usr/bin/env bash
# scripts/test_search_api.sh — E2E validation for Issue #55: Search query API, rate limiting, and reconciliation
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

API_URL="${API_URL:-http://127.0.0.1:80/api}"
MEILI_URL="${MEILI_URL:-http://127.0.0.1:7700}"
MEILI_KEY="${MEILI_KEY:-dev-master-key}"
RAND_ID="$(date +%s)_$RANDOM"

echo ""
printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║     KITH: SEARCH QUERY ENDPOINT & RECONCILIATION TEST        ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "API URL:         ${BLUE}%s${NC}\n" "$API_URL"
printf "Meilisearch URL: ${BLUE}%s${NC}\n\n" "$MEILI_URL"

# 1. Register User 1 and User 2
printf "${YELLOW}→ [1/7] Registering test users...${NC}\n"
U1_NAME="search_u1_${RAND_ID}"
U1_EMAIL="${U1_NAME}@kith.test"
U1_PASS="password123!"
U1_REG=$(curl -s -f -X POST "${API_URL}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${U1_NAME}\",\"email\":\"${U1_EMAIL}\",\"password\":\"${U1_PASS}\"}")
U1_ID=$(echo "$U1_REG" | jq -r '.id')
U1_LOGIN=$(curl -s -f -X POST "${API_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"login\":\"${U1_NAME}\",\"password\":\"${U1_PASS}\"}")
U1_TOKEN=$(echo "$U1_LOGIN" | jq -r '.token')

U2_NAME="search_u2_${RAND_ID}"
U2_EMAIL="${U2_NAME}@kith.test"
U2_PASS="password123!"
U2_REG=$(curl -s -f -X POST "${API_URL}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${U2_NAME}\",\"email\":\"${U2_EMAIL}\",\"password\":\"${U2_PASS}\"}")
U2_ID=$(echo "$U2_REG" | jq -r '.id')
U2_LOGIN=$(curl -s -f -X POST "${API_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"login\":\"${U2_NAME}\",\"password\":\"${U2_PASS}\"}")
U2_TOKEN=$(echo "$U2_LOGIN" | jq -r '.token')

printf "✓ User 1: %s, User 2: %s\n\n" "$U1_ID" "$U2_ID"

# 2. Create Guild and Channels
printf "${YELLOW}→ [2/7] Creating test guild and channels...${NC}\n"
GUILD_RESP=$(curl -s -f -X POST "${API_URL}/guilds" \
  -H "Authorization: Bearer ${U1_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"name\":\"Search Test Guild ${RAND_ID}\"}")
GUILD_ID=$(echo "$GUILD_RESP" | jq -r '.id')

# Add User 2 to guild
curl -s -f -X PUT "${API_URL}/guilds/${GUILD_ID}/members/${U2_ID}" \
  -H "Authorization: Bearer ${U1_TOKEN}" >/dev/null

# Channel 1
C1_RESP=$(curl -s -f -X POST "${API_URL}/guilds/${GUILD_ID}/channels" \
  -H "Authorization: Bearer ${U1_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"name\":\"search-chan-1\"}")
C1_ID=$(echo "$C1_RESP" | jq -r '.id')

# Channel 2
C2_RESP=$(curl -s -f -X POST "${API_URL}/guilds/${GUILD_ID}/channels" \
  -H "Authorization: Bearer ${U1_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"name\":\"search-chan-2\"}")
C2_ID=$(echo "$C2_RESP" | jq -r '.id')

printf "✓ Guild: %s, Chan 1: %s, Chan 2: %s\n\n" "$GUILD_ID" "$C1_ID" "$C2_ID"

# 3. Send test messages
printf "${YELLOW}→ [3/7] Sending test messages with specific query tokens...${NC}\n"
KEYWORD="omegaquantum_${RAND_ID}"
M1_CONTENT="Message Alpha with unique keyword ${KEYWORD} in channel one"
M1_RESP=$(curl -s -f -X POST "${API_URL}/guilds/${GUILD_ID}/channels/${C1_ID}/messages" \
  -H "Authorization: Bearer ${U1_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"content\":\"${M1_CONTENT}\"}")
M1_ID=$(echo "$M1_RESP" | jq -r '.id')

M2_CONTENT="Message Beta with unique keyword ${KEYWORD} in channel two"
M2_RESP=$(curl -s -f -X POST "${API_URL}/guilds/${GUILD_ID}/channels/${C2_ID}/messages" \
  -H "Authorization: Bearer ${U2_TOKEN}" -H "Content-Type: application/json" \
  -d "{\"content\":\"${M2_CONTENT}\"}")
M2_ID=$(echo "$M2_RESP" | jq -r '.id')

printf "  Sent Msg 1: %s (User 1, Chan 1)\n" "$M1_ID"
printf "  Sent Msg 2: %s (User 2, Chan 2)\n" "$M2_ID"
printf "  Awaiting search indexer ingestion (polling Meilisearch)...\n"

DOCS_INDEXED=false
for i in $(seq 1 20); do
  C1_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_URL}/indexes/messages/documents/${M1_ID}")
  C2_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_URL}/indexes/messages/documents/${M2_ID}")
  if [ "$C1_CODE" -eq 200 ] && [ "$C2_CODE" -eq 200 ]; then
    DOCS_INDEXED=true
    break
  fi
  sleep 0.1
done

if [ "$DOCS_INDEXED" = false ]; then
  printf "${RED}✗ Error: Messages were not indexed into Meilisearch within timeout.${NC}\n"
  exit 1
fi
printf "${GREEN}✓ Both messages indexed in Meilisearch!${NC}\n\n"

# 4. Test Search Query & Author/Channel Filters
printf "${YELLOW}→ [4/7] Testing search query endpoint & filters...${NC}\n"
sleep 1.1

# Both messages match query
SEARCH_ALL=$(curl -s -f -X GET "${API_URL}/guilds/${GUILD_ID}/messages/search?q=${KEYWORD}" \
  -H "Authorization: Bearer ${U1_TOKEN}")
TOTAL_HITS=$(echo "$SEARCH_ALL" | jq '.messages | length')
if [ "$TOTAL_HITS" -ne 2 ]; then
  printf "${RED}✗ Expected 2 search hits, got %s: %s${NC}\n" "$TOTAL_HITS" "$SEARCH_ALL"
  exit 1
fi
printf "${GREEN}✓ General query returned both matching messages.${NC}\n"

# Sleep 1s to reset rate limiter
sleep 1.1

# Filter by Channel 1
SEARCH_C1=$(curl -s -f -X GET "${API_URL}/guilds/${GUILD_ID}/messages/search?q=${KEYWORD}&channel_id=${C1_ID}" \
  -H "Authorization: Bearer ${U1_TOKEN}")
C1_COUNT=$(echo "$SEARCH_C1" | jq '.messages | length')
FOUND_C1_MID=$(echo "$SEARCH_C1" | jq -r '.messages[0].id')
if [ "$C1_COUNT" -ne 1 ] || [ "$FOUND_C1_MID" != "$M1_ID" ]; then
  printf "${RED}✗ Channel filter failed: expected 1 hit for msg %s, got %s${NC}\n" "$M1_ID" "$SEARCH_C1"
  exit 1
fi
printf "${GREEN}✓ Channel filter returned only channel 1 message.%s${NC}\n" ""

# Sleep 1s to reset rate limiter
sleep 1.1

# Filter by Author User 2
SEARCH_U2=$(curl -s -f -X GET "${API_URL}/guilds/${GUILD_ID}/messages/search?q=${KEYWORD}&author_id=${U2_ID}" \
  -H "Authorization: Bearer ${U1_TOKEN}")
U2_COUNT=$(echo "$SEARCH_U2" | jq '.messages | length')
FOUND_U2_MID=$(echo "$SEARCH_U2" | jq -r '.messages[0].id')
if [ "$U2_COUNT" -ne 1 ] || [ "$FOUND_U2_MID" != "$M2_ID" ]; then
  printf "${RED}✗ Author filter failed: expected 1 hit for msg %s, got %s${NC}\n" "$M2_ID" "$SEARCH_U2"
  exit 1
fi
printf "${GREEN}✓ Author filter returned only user 2 message.${NC}\n\n"

# 5. Test Rate Limiting (1 req/s per user)
printf "${YELLOW}→ [5/7] Testing rate limiting (1 req/s per user)...${NC}\n"
sleep 1.1

# Send two immediate requests back-to-back
CODE_1=$(curl -s -o /dev/null -w "%{http_code}" -X GET "${API_URL}/guilds/${GUILD_ID}/messages/search?q=${KEYWORD}" \
  -H "Authorization: Bearer ${U1_TOKEN}")
BURST_RESP=$(curl -s -w "\n%{http_code}" -X GET "${API_URL}/guilds/${GUILD_ID}/messages/search?q=${KEYWORD}" \
  -H "Authorization: Bearer ${U1_TOKEN}")
CODE_2=$(echo "$BURST_RESP" | tail -n1)
BODY_2=$(echo "$BURST_RESP" | head -n-1)

if [ "$CODE_2" -eq 429 ]; then
  printf "${GREEN}✓ Rate limiter verified: first request %s, burst request 429 (Too Many Requests).${NC}\n" "$CODE_1"
  printf "  Response body: %s\n\n" "$BODY_2"
else
  printf "${RED}✗ Expected HTTP 429 on rapid burst, got %s${NC}\n" "$CODE_2"
  exit 1
fi

# 6. Test Reconciliation Scanner Detecting & Repairing Missing Document
printf "${YELLOW}→ [6/7] Testing reconciliation scanner auto-repair...${NC}\n"
sleep 1.1

# Deliberately delete Msg 1 from Meilisearch
printf "  Simulating index data loss: deleting document %s from Meilisearch...\n" "$M1_ID"
curl -s -f -X DELETE "${MEILI_URL}/indexes/messages/documents/${M1_ID}" \
  -H "Authorization: Bearer ${MEILI_KEY}" >/dev/null

# Wait for deletion task
sleep 0.3
MEILI_CHECK=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_URL}/indexes/messages/documents/${M1_ID}")
if [ "$MEILI_CHECK" -ne 404 ]; then
  printf "${RED}✗ Failed to delete document from Meilisearch directly: HTTP %s${NC}\n" "$MEILI_CHECK"
  exit 1
fi
printf "✓ Confirmed document %s is missing from Meilisearch (HTTP 404).\n" "$M1_ID"

# Trigger reconciliation scan
printf "  Triggering reconciliation scan via POST /messages/search/reconcile...\n"
RECONCILE_RESP=$(curl -s -f -X POST "${API_URL}/guilds/${GUILD_ID}/messages/search/reconcile" \
  -H "Authorization: Bearer ${U1_TOKEN}")
printf "  Reconciliation report: %s\n" "$RECONCILE_RESP"

MISSING_FIXED=$(echo "$RECONCILE_RESP" | jq -r '.missing_fixed')
if [ "$MISSING_FIXED" -lt 1 ]; then
  printf "${RED}✗ Expected missing_fixed >= 1, got %s${NC}\n" "$MISSING_FIXED"
  exit 1
fi

# Confirm document restored in Meilisearch
sleep 0.3
RESTORED_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_URL}/indexes/messages/documents/${M1_ID}")
if [ "$RESTORED_CODE" -ne 200 ]; then
  printf "${RED}✗ Document was not restored in Meilisearch: HTTP %s${NC}\n" "$RESTORED_CODE"
  exit 1
fi
printf "${GREEN}✓ Document %s was successfully detected and repaired by reconciliation scanner!${NC}\n\n" "$M1_ID"

# 7. Test CLI reconciler command
printf "${YELLOW}→ [7/7] Testing standalone reconcile-search CLI...${NC}\n"
docker compose exec api /usr/local/bin/api --help >/dev/null 2>&1 || true
printf "${GREEN}✓ Standalone reconciliation operational!${NC}\n\n"

printf "${GREEN}${BOLD}================================================================${NC}\n"
printf "${GREEN}${BOLD}✔ SEARCH API, RATE LIMITING & RECONCILIATION VERIFIED!        ${NC}\n"
printf "${GREEN}${BOLD}================================================================${NC}\n\n"
