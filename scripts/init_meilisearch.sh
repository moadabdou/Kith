#!/usr/bin/env bash
# scripts/init_meilisearch.sh — Initialize Meilisearch messages index schema (plan/04 §2 Rung 2)
set -euo pipefail

# ANSI Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

MEILI_HOST="${MEILI_HOST:-http://127.0.0.1:7700}"
MEILI_MASTER_KEY="${MEILI_MASTER_KEY:-dev-master-key}"
INDEX_UID="messages"
PRIMARY_KEY="id"

echo ""
printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║          KITH: MEILISEARCH INDEX SCHEMA INITIALIZER          ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "Target Meilisearch: ${BLUE}%s${NC}\n" "$MEILI_HOST"
printf "Target Index:       ${BLUE}%s${NC} (Primary Key: %s)\n\n" "$INDEX_UID" "$PRIMARY_KEY"

# 1. Wait for Meilisearch /health
printf "${YELLOW}→ [1/4] Waiting for Meilisearch service at %s...${NC}\n" "$MEILI_HOST"
max_retries=30
count=0
until curl -s -f "${MEILI_HOST}/health" >/dev/null 2>&1; do
  count=$((count + 1))
  if [ "$count" -ge "$max_retries" ]; then
    printf "${RED}✗ Error: Meilisearch did not become healthy within %s attempts.${NC}\n" "$max_retries"
    exit 1
  fi
  sleep 1
done
printf "${GREEN}✓ Meilisearch is healthy!${NC}\n\n"

# 2. Ensure index exists with primary key 'id'
printf "${YELLOW}→ [2/4] Ensuring index '%s' exists with primaryKey '%s'...${NC}\n" "$INDEX_UID" "$PRIMARY_KEY"
index_check_code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${MEILI_MASTER_KEY}" "${MEILI_HOST}/indexes/${INDEX_UID}")

if [ "$index_check_code" -eq 200 ]; then
  printf "${GREEN}✓ Index '%s' already exists.${NC}\n" "$INDEX_UID"
else
  create_resp=$(curl -s -X POST "${MEILI_HOST}/indexes" \
    -H "Authorization: Bearer ${MEILI_MASTER_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"uid\":\"${INDEX_UID}\",\"primaryKey\":\"${PRIMARY_KEY}\"}")
  
  task_uid=$(echo "$create_resp" | grep -o '"taskUid":[0-9]*' | cut -d':' -f2 || true)
  if [ -z "$task_uid" ] && command -v jq >/dev/null 2>&1; then
    task_uid=$(echo "$create_resp" | jq -r '.taskUid // empty')
  fi

  if [ -n "$task_uid" ]; then
    printf "  Awaiting creation task UID: %s...\n" "$task_uid"
    until [ "$(curl -s -H "Authorization: Bearer ${MEILI_MASTER_KEY}" "${MEILI_HOST}/tasks/${task_uid}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)" != "enqueued" ] && \
          [ "$(curl -s -H "Authorization: Bearer ${MEILI_MASTER_KEY}" "${MEILI_HOST}/tasks/${task_uid}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)" != "processing" ]; do
      sleep 0.2
    done
  fi
  printf "${GREEN}✓ Created index '%s'.${NC}\n" "$INDEX_UID"
fi
echo ""

# 3. Configure settings
printf "${YELLOW}→ [3/4] Configuring schema settings for '%s'...${NC}\n" "$INDEX_UID"
printf "  • Filterable Attributes: guild_id, channel_id, author_id, timestamp\n"
printf "  • Searchable Attributes: content\n"
printf "  • Sortable Attributes:   timestamp\n"

settings_payload='{
  "filterableAttributes": ["guild_id", "channel_id", "author_id", "timestamp"],
  "searchableAttributes": ["content"],
  "sortableAttributes": ["timestamp"]
}'

settings_resp=$(curl -s -X PATCH "${MEILI_HOST}/indexes/${INDEX_UID}/settings" \
  -H "Authorization: Bearer ${MEILI_MASTER_KEY}" \
  -H "Content-Type: application/json" \
  -d "$settings_payload")

settings_task=$(echo "$settings_resp" | grep -o '"taskUid":[0-9]*' | cut -d':' -f2 || true)
if [ -z "$settings_task" ] && command -v jq >/dev/null 2>&1; then
  settings_task=$(echo "$settings_resp" | jq -r '.taskUid // empty')
fi

if [ -n "$settings_task" ]; then
  printf "  Awaiting settings task UID: %s...\n" "$settings_task"
  while true; do
    task_info=$(curl -s -H "Authorization: Bearer ${MEILI_MASTER_KEY}" "${MEILI_HOST}/tasks/${settings_task}")
    status=$(echo "$task_info" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    if [ "$status" = "succeeded" ]; then
      printf "${GREEN}✓ Settings applied successfully (task succeeded).${NC}\n"
      break
    elif [ "$status" = "failed" ]; then
      printf "${RED}✗ Settings task failed: %s${NC}\n" "$task_info"
      exit 1
    fi
    sleep 0.2
  done
else
  printf "${GREEN}✓ Settings updated.${NC}\n"
fi
echo ""

# 4. Verify Active Index Settings
printf "${YELLOW}→ [4/4] Verifying active settings for '%s'...${NC}\n" "$INDEX_UID"
active_settings=$(curl -s -H "Authorization: Bearer ${MEILI_MASTER_KEY}" "${MEILI_HOST}/indexes/${INDEX_UID}/settings")

if command -v jq >/dev/null 2>&1; then
  echo "$active_settings" | jq '{filterableAttributes, searchableAttributes, sortableAttributes}'
else
  echo "$active_settings"
fi

printf "\n${GREEN}${BOLD}================================================================${NC}\n"
printf "${GREEN}${BOLD}✔ MEILISEARCH INDEX '%s' READY FOR INGESTION AND SEARCH!      ${NC}\n" "$INDEX_UID"
printf "${GREEN}${BOLD}================================================================${NC}\n\n"
