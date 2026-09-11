#!/usr/bin/env bash
# scripts/seed_large_guild.sh — Populate a 10,000-member guild with hoisted roles (#40)
# Idempotent bulk seed using PostgreSQL generate_series for maximum speed.
set -euo pipefail

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

GUILD_ID="${GUILD_ID:-99900000000000000}"
MEMBER_COUNT="${MEMBER_COUNT:-10000}"
OWNER_ID="${OWNER_ID:-99900000000000001}"
START_USER_ID="${START_USER_ID:-99900000000000002}"

echo ""
printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║          KITH: SEED 10,000-MEMBER GUILD FOR BENCHMARK        ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "Target Guild ID: ${BLUE}%s${NC}\n" "$GUILD_ID"
printf "Member Count:    ${BLUE}%s${NC}\n" "$MEMBER_COUNT"
echo ""

# Execution function: uses psql or docker compose exec
exec_sql() {
  local sql="$1"
  if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$sql"
  elif command -v docker >/dev/null 2>&1; then
    docker compose exec -T postgres psql -U discord -d discord -v ON_ERROR_STOP=1 -c "$sql"
  else
    echo -e "${RED}Error: neither psql (with DATABASE_URL) nor docker compose is available.${NC}" >&2
    exit 1
  fi
}

printf "${YELLOW}→ [1/5] Creating owner and guild...${NC}\n"
exec_sql "
-- Owner user
INSERT INTO users (id, username, discriminator, email, password_hash)
VALUES (${OWNER_ID}, 'bench_owner', 1, 'bench_owner@kith.test', 'placeholder-bench-owner')
ON CONFLICT (id) DO NOTHING;

-- Guild
INSERT INTO guilds (id, name, owner_id)
VALUES (${GUILD_ID}, 'Bench 10k Guild', ${OWNER_ID})
ON CONFLICT (id) DO NOTHING;

-- Owner member record
INSERT INTO members (guild_id, user_id, joined_at, nickname)
VALUES (${GUILD_ID}, ${OWNER_ID}, now() - interval '30 days', 'The Owner')
ON CONFLICT (guild_id, user_id) DO NOTHING;
"

printf "${YELLOW}→ [2/5] Creating hoisted roles...${NC}\n"
exec_sql "
-- Roles: @everyone, Admin, Moderator, VIP, Regular
INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable)
VALUES
  (${GUILD_ID}, ${GUILD_ID}, '@everyone', 0, false, 0, 0, false),
  (${GUILD_ID} + 1, ${GUILD_ID}, 'Admin', 15158332, true, 4, 8, true),
  (${GUILD_ID} + 2, ${GUILD_ID}, 'Moderator', 3447003, true, 3, 0, true),
  (${GUILD_ID} + 3, ${GUILD_ID}, 'VIP', 10181046, true, 2, 0, true),
  (${GUILD_ID} + 4, ${GUILD_ID}, 'Regular', 1752220, true, 1, 0, true)
ON CONFLICT (id) DO NOTHING;
"

printf "${YELLOW}→ [3/5] Bulk-generating ${MEMBER_COUNT} users...${NC}\n"
exec_sql "
INSERT INTO users (id, username, discriminator, email, password_hash)
SELECT
  ${START_USER_ID} + i - 1 AS id,
  'bench_user_' || i AS username,
  ((i % 9999) + 1)::smallint AS discriminator,
  ('bench_user_' || i || '@largeguild.test')::citext AS email,
  'placeholder' AS password_hash
FROM generate_series(1, ${MEMBER_COUNT}) AS i
ON CONFLICT (id) DO NOTHING;
"

printf "${YELLOW}→ [4/5] Bulk-adding ${MEMBER_COUNT} members with staggered joined_at timestamps...${NC}\n"
exec_sql "
INSERT INTO members (guild_id, user_id, joined_at, nickname)
SELECT
  ${GUILD_ID} AS guild_id,
  ${START_USER_ID} + i - 1 AS user_id,
  -- Staggered joined_at so ordering by (joined_at, user_id) is realistic and indexed
  now() - (((${MEMBER_COUNT} - i) * 60) || ' seconds')::interval AS joined_at,
  CASE WHEN i % 20 = 0 THEN 'Nick_' || i ELSE NULL END AS nickname
FROM generate_series(1, ${MEMBER_COUNT}) AS i
ON CONFLICT (guild_id, user_id) DO NOTHING;
"

printf "${YELLOW}→ [5/5] Assigning realistic hoisted roles across the member base...${NC}\n"
exec_sql "
-- Distribution:
-- Top 50 members: Admin
-- Next 200 members: Moderator
-- Next 1,000 members: VIP
-- Next 4,000 members: Regular
-- Remainder: roleless (@everyone only)
INSERT INTO member_roles (guild_id, user_id, role_id)
SELECT
  ${GUILD_ID} AS guild_id,
  ${START_USER_ID} + i - 1 AS user_id,
  CASE
    WHEN i <= 50 THEN ${GUILD_ID} + 1   -- Admin
    WHEN i <= 250 THEN ${GUILD_ID} + 2  -- Moderator
    WHEN i <= 1250 THEN ${GUILD_ID} + 3 -- VIP
    ELSE ${GUILD_ID} + 4               -- Regular
  END AS role_id
FROM generate_series(1, 5250) AS i
ON CONFLICT (guild_id, user_id, role_id) DO NOTHING;
"

echo ""
printf "${GREEN}${BOLD}✓ Verification Query:${NC}\n"
exec_sql "
SELECT
  g.id AS guild_id,
  g.name,
  count(m.user_id) AS total_members,
  count(mr.role_id) AS total_role_assignments
FROM guilds g
LEFT JOIN members m ON m.guild_id = g.id
LEFT JOIN member_roles mr ON mr.guild_id = g.id AND mr.user_id = m.user_id
WHERE g.id = ${GUILD_ID}
GROUP BY g.id, g.name;
"

printf "${GREEN}${BOLD}✓ 10,000-member guild seeded successfully!${NC}\n\n"
