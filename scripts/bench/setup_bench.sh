#!/usr/bin/env bash
set -euo pipefail

# ANSI colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

GUILD_ID="${GUILD_ID:-99900000000000000}"
CHANNEL_COUNT="${CHANNEL_COUNT:-50}"
START_CHANNEL_ID="${START_CHANNEL_ID:-99900000000000101}"
START_USER_ID="${START_USER_ID:-99900000000000002}"
USER_COUNT="${USER_COUNT:-1000}"
JWT_SECRET="${JWT_SECRET:-dev-jwt-secret-change-me}"
OUT_FILE="$(cd "$(dirname "$0")" && pwd)/bench_config.json"

printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║          KITH: SEED BENCHMARK CHANNELS & CONFIG              ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "Target Guild ID:    ${BLUE}%s${NC}\n" "$GUILD_ID"
printf "Channels to Seed:   ${BLUE}%s${NC}\n" "$CHANNEL_COUNT"
printf "Virtual User Count: ${BLUE}%s${NC}\n" "$USER_COUNT"
echo ""

# Helper to execute SQL against Postgres
exec_sql() {
  local sql="$1"
  if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$sql"
  elif command -v docker >/dev/null 2>&1; then
    docker compose exec -T postgres psql -U discord -d discord -v ON_ERROR_STOP=1 -c "$sql"
  else
    echo "Error: neither psql nor docker compose available" >&2
    exit 1
  fi
}

# 1. Ensure the 10k guild exists
MEMBER_CHECK=$(docker compose exec -T postgres psql -U discord -d discord -t -A -c "SELECT count(*) FROM members WHERE guild_id = ${GUILD_ID};" || echo "0")
if [ "${MEMBER_CHECK:-0}" -lt 1000 ]; then
  printf "${YELLOW}→ Benchmark guild has insufficient members (${MEMBER_CHECK}). Running scripts/seed_large_guild.sh...${NC}\n"
  "$(dirname "$0")/../seed_large_guild.sh"
else
  printf "${GREEN}✓ Verified Benchmark Guild (${GUILD_ID}) with ${MEMBER_CHECK} members.${NC}\n"
fi

# 2. Seed 50 channels
printf "${YELLOW}→ [1/2] Seeding ${CHANNEL_COUNT} channels into guild ${GUILD_ID}...${NC}\n"
exec_sql "
INSERT INTO channels (id, guild_id, type, name, position)
SELECT
  ${START_CHANNEL_ID} + i - 1 AS id,
  ${GUILD_ID} AS guild_id,
  0 AS type,
  'bench-chan-' || i AS name,
  i AS position
FROM generate_series(1, ${CHANNEL_COUNT}) AS i
ON CONFLICT (id) DO UPDATE
SET guild_id = EXCLUDED.guild_id, name = EXCLUDED.name;
"

# 3. Collect channel IDs and generate JSON config
printf "${YELLOW}→ [2/2] Generating ${OUT_FILE}...${NC}\n"

CHANNELS_JSON=$(docker compose exec -T postgres psql -U discord -d discord -t -A -c "
SELECT json_agg(id::text ORDER BY id)
FROM channels
WHERE guild_id = ${GUILD_ID} AND id >= ${START_CHANNEL_ID} AND id < ${START_CHANNEL_ID} + ${CHANNEL_COUNT};
")

cat > "$OUT_FILE" <<EOF
{
  "guild_id": "${GUILD_ID}",
  "channel_ids": ${CHANNELS_JSON},
  "start_user_id": "${START_USER_ID}",
  "user_count": ${USER_COUNT},
  "jwt_secret": "${JWT_SECRET}"
}
EOF

printf "${GREEN}${BOLD}✓ Benchmark channels seeded & ${OUT_FILE} generated!${NC}\n\n"
