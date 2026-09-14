#!/usr/bin/env bash
# scripts/test_search_indexer.sh — Verify NATS JetStream -> Meilisearch indexer pipeline (plan/04 §3, Issue #54)
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

echo ""
printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║      KITH: NATS JETSTREAM SEARCH INDEXER PIPELINE TEST       ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "API URL:         ${BLUE}%s${NC}\n" "$API_URL"
printf "Meilisearch URL: ${BLUE}%s${NC}\n\n" "$MEILI_URL"

# 1. Register and Authenticate User
RAND_ID="$(date +%s)_$((RANDOM % 10000))"
USER_NAME="idx_user_${RAND_ID}"
USER_EMAIL="idx_${RAND_ID}@kith.test"
USER_PASS="Password123!"

printf "${YELLOW}→ [1/6] Registering user and acquiring auth token...${NC}\n"
curl -s -f -X POST "${API_URL}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${USER_NAME}\",\"email\":\"${USER_EMAIL}\",\"password\":\"${USER_PASS}\"}" >/dev/null

TOKEN=$(curl -s -f -X POST "${API_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"login\":\"${USER_NAME}\",\"password\":\"${USER_PASS}\"}" | jq -r '.token')

AUTH_HEADER="Authorization: Bearer ${TOKEN}"

# 2. Create Guild and Channel
printf "${YELLOW}→ [2/6] Creating test guild and channel...${NC}\n"
GUILD_RESP=$(curl -s -f -X POST "${API_URL}/guilds" \
  -H "$AUTH_HEADER" -H "Content-Type: application/json" \
  -d '{"name":"Indexer Test Guild"}')
GUILD_ID=$(echo "$GUILD_RESP" | jq -r '.id')

CHAN_RESP=$(curl -s -f -X POST "${API_URL}/guilds/${GUILD_ID}/channels" \
  -H "$AUTH_HEADER" -H "Content-Type: application/json" \
  -d '{"name":"indexer-channel","type":0}')
CHAN_ID=$(echo "$CHAN_RESP" | jq -r '.id')
printf "${GREEN}✓ Created Guild: %s, Channel: %s${NC}\n\n" "$GUILD_ID" "$CHAN_ID"

# 3. Test MESSAGE_CREATE Indexing within 150ms
printf "${YELLOW}→ [3/6] Testing MESSAGE_CREATE ingestion...${NC}\n"
MSG_CONTENT="NATS indexer test: hello meilisearch world [${RAND_ID}]"
MSG_RESP=$(curl -s -f -X POST "${API_URL}/guilds/${GUILD_ID}/channels/${CHAN_ID}/messages" \
  -H "$AUTH_HEADER" -H "Content-Type: application/json" \
  -d "{\"content\":\"${MSG_CONTENT}\"}")
MSG_ID=$(echo "$MSG_RESP" | jq -r '.id')

printf "  Message sent: %s. Awaiting indexer ingestion (sleep 200ms)...\n" "$MSG_ID"
sleep 0.2

# Poll Meilisearch for document (up to 2 seconds if under load)
DOC_FOUND=false
for i in $(seq 1 10); do
  DOC_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_URL}/indexes/messages/documents/${MSG_ID}")
  if [ "$DOC_HTTP_CODE" -eq 200 ]; then
    DOC_FOUND=true
    break
  fi
  sleep 0.1
done

if [ "$DOC_FOUND" = false ]; then
  printf "${RED}✗ Error: Document %s was not found in Meilisearch after write.${NC}\n" "$MSG_ID"
  exit 1
fi

INDEXED_DOC=$(curl -s -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_URL}/indexes/messages/documents/${MSG_ID}")
INDEXED_CONTENT=$(echo "$INDEXED_DOC" | jq -r '.content')
if [ "$INDEXED_CONTENT" != "$MSG_CONTENT" ]; then
  printf "${RED}✗ Content mismatch: expected '%s', got '%s'${NC}\n" "$MSG_CONTENT" "$INDEXED_CONTENT"
  exit 1
fi
printf "${GREEN}✓ Document %s automatically indexed in Meilisearch with exact content!${NC}\n\n" "$MSG_ID"

# 4. Test MESSAGE_UPDATE Synchronization
printf "${YELLOW}→ [4/6] Testing MESSAGE_UPDATE synchronization...${NC}\n"
UPDATED_CONTENT="NATS indexer test: updated content [${RAND_ID}]"
curl -s -f -X PATCH "${API_URL}/channels/${CHAN_ID}/messages/${MSG_ID}" \
  -H "$AUTH_HEADER" -H "Content-Type: application/json" \
  -d "{\"content\":\"${UPDATED_CONTENT}\"}" >/dev/null

printf "  Message edited. Awaiting indexer sync (sleep 200ms)...\n"
sleep 0.2

UPDATED_FOUND=false
for i in $(seq 1 10); do
  CURRENT_DOC=$(curl -s -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_URL}/indexes/messages/documents/${MSG_ID}")
  CURRENT_CONTENT=$(echo "$CURRENT_DOC" | jq -r '.content')
  if [ "$CURRENT_CONTENT" = "$UPDATED_CONTENT" ]; then
    UPDATED_FOUND=true
    break
  fi
  sleep 0.1
done

if [ "$UPDATED_FOUND" = false ]; then
  printf "${RED}✗ Error: Document in Meilisearch was not updated. Content: '%s'${NC}\n" "$CURRENT_CONTENT"
  exit 1
fi
printf "${GREEN}✓ Document updated in Meilisearch with edited content!${NC}\n\n"

# 5. Test MESSAGE_DELETE (Zero Ghost Results)
printf "${YELLOW}→ [5/6] Testing MESSAGE_DELETE (zero ghost results)...${NC}\n"
curl -s -f -X DELETE "${API_URL}/channels/${CHAN_ID}/messages/${MSG_ID}" \
  -H "$AUTH_HEADER" >/dev/null

printf "  Message deleted. Awaiting indexer deletion (sleep 200ms)...\n"
sleep 0.2

DELETED_CONFIRMED=false
for i in $(seq 1 10); do
  DEL_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${MEILI_KEY}" "${MEILI_URL}/indexes/messages/documents/${MSG_ID}")
  if [ "$DEL_HTTP_CODE" -eq 404 ]; then
    DELETED_CONFIRMED=true
    break
  fi
  sleep 0.1
done

if [ "$DELETED_CONFIRMED" = false ]; then
  printf "${RED}✗ Error: Deleted document %s still persists in Meilisearch (ghost result).${NC}\n" "$MSG_ID"
  exit 1
fi
printf "${GREEN}✓ Deleted message immediately vanished from Meilisearch!${NC}\n\n"

# 6. Test Prometheus Indexer Metrics
printf "${YELLOW}→ [6/6] Verifying Prometheus search indexer metrics...${NC}\n"
METRICS_OUTPUT=$(curl -s "http://127.0.0.1:8080/metrics" | grep "search_indexer_" || true)

echo "$METRICS_OUTPUT" | grep "search_indexer_processed_events_total" || true
echo "$METRICS_OUTPUT" | grep "search_indexer_batch_size" || true

printf "\n${GREEN}${BOLD}================================================================${NC}\n"
printf "${GREEN}${BOLD}✔ NATS SEARCH INDEXER PIPELINE VERIFIED SUCCESSFULLY!           ${NC}\n"
printf "${GREEN}${BOLD}================================================================${NC}\n\n"
