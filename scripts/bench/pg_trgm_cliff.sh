#!/usr/bin/env bash
# scripts/bench/pg_trgm_cliff.sh — Measure PostgreSQL pg_trgm GIN index cliff (plan/04 §2)
set -euo pipefail

# ANSI Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

GUILD_ID="99700000000000000"
CHANNEL_ID="99700000000000201"
USER_ID="99700000000000001"
START_MSG_ID="99700000000000000"

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${BENCH_DIR}/results"
mkdir -p "$RESULTS_DIR"
LOG_FILE="${RESULTS_DIR}/pg_trgm_cliff.log"

exec_sql() {
  local sql="$1"
  docker compose exec -T postgres psql -U discord -d discord -v ON_ERROR_STOP=1 -c "$sql"
}

query_val() {
  local sql="$1"
  docker compose exec -T postgres psql -U discord -d discord -t -A -c "$sql" | tr -d '\r'
}

echo ""
printf "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║      KITH: POSTGRESQL pg_trgm GIN INDEX CLIFF BENCHMARK      ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}\n"
printf "Log File: ${BLUE}%s${NC}\n\n" "$LOG_FILE"

# 1. Ensure test guild, channel, and user exist
printf "${YELLOW}→ [1/4] Preparing benchmark guild and channel...${NC}\n"
exec_sql "
INSERT INTO users (id, username, discriminator, email, password_hash)
VALUES (${USER_ID}, 'trgm_bench_user', 1, 'trgm@kith.test', 'placeholder')
ON CONFLICT (id) DO NOTHING;

INSERT INTO guilds (id, name, owner_id)
VALUES (${GUILD_ID}, 'Trigram Bench Guild', ${USER_ID})
ON CONFLICT (id) DO NOTHING;

INSERT INTO members (guild_id, user_id)
VALUES (${GUILD_ID}, ${USER_ID})
ON CONFLICT (guild_id, user_id) DO NOTHING;

INSERT INTO channels (id, guild_id, type, name, position)
VALUES (${CHANNEL_ID}, ${GUILD_ID}, 0, 'trgm-bench-chan', 0)
ON CONFLICT (id) DO NOTHING;

-- Clean existing benchmark messages in this channel
DELETE FROM messages WHERE channel_id = ${CHANNEL_ID};
"

# 2. Benchmark Runner Function
run_benchmark_tier() {
  local target_total="$1"
  local current_count
  current_count=$(query_val "SELECT count(*) FROM messages WHERE channel_id = ${CHANNEL_ID};")
  local needed=$((target_total - current_count))

  if [ "$needed" -gt 0 ]; then
    printf "${YELLOW}→ Inserting %s messages to reach %s total...${NC}\n" "$needed" "$target_total"
    local t_start
    t_start=$(date +%s%N)

    exec_sql "
    INSERT INTO messages (id, channel_id, author_id, content, created_at)
    SELECT
      ${START_MSG_ID} + ${current_count} + i,
      ${CHANNEL_ID},
      ${USER_ID},
      (ARRAY[
        'general chat discussion about kubernetes deployment and pod restarts',
        'hey team anyone playing the new multiplayer game tonight?',
        'critical incident report: database lock contention observed during peak traffic',
        'can you review my pull request for the real-time gateway websocket service?',
        'check out this funny meme about distributed consensus algorithms and raft',
        'what is the difference between local quorum and consistency one in cassandra?',
        'random conversation snippet with hi and ok for short trigram analysis',
        'routine daily standup meeting notes: completed search indexing task today',
        'performance tuning: memory allocations and pprof traces look great',
        'reconciliation scan detected zero data drift between stores'
      ])[1 + ((i + ${current_count}) % 10)],
      now() - ((${target_total} - i) || ' seconds')::interval
    FROM generate_series(1, ${needed}) AS i;
    "

    local t_end
    t_end=$(date +%s%N)
    local duration_ms=$(( (t_end - t_start) / 1000000 ))
    local rate=$(( needed * 1000 / (duration_ms > 0 ? duration_ms : 1) ))
    printf "${GREEN}✓ Inserted %s rows in %sms (~%s rows/sec)${NC}\n" "$needed" "$duration_ms" "$rate"
    echo "[Insert Tier: ${target_total}] Inserted ${needed} rows in ${duration_ms}ms (${rate} rows/sec)" >> "$LOG_FILE"
  fi

  # Run ANALYZE to update table statistics
  exec_sql "ANALYZE messages;" >/dev/null 2>&1

  # Measure disk sizes
  local table_size
  local index_size
  local total_size
  table_size=$(query_val "SELECT pg_size_pretty(pg_relation_size('messages'));")
  index_size=$(query_val "SELECT pg_size_pretty(pg_relation_size('messages_content_trgm_idx'));")
  total_size=$(query_val "SELECT pg_size_pretty(pg_total_relation_size('messages'));")
  local ratio
  ratio=$(query_val "SELECT round((pg_relation_size('messages_content_trgm_idx')::numeric / NULLIF(pg_relation_size('messages'), 0)::numeric), 2);")

  printf "  ${BOLD}Storage Stats (${target_total} rows):${NC}\n"
  printf "    Heap Table Size:    ${CYAN}%s${NC}\n" "$table_size"
  printf "    Trigram GIN Index:  ${CYAN}%s${NC} (Index/Heap Ratio: ${BOLD}%sx${NC})\n" "$index_size" "$ratio"
  printf "    Total Size:         ${CYAN}%s${NC}\n" "$total_size"

  echo "=== Tier: ${target_total} rows ===" >> "$LOG_FILE"
  echo "Table Size: ${table_size} | GIN Index Size: ${index_size} (Ratio: ${ratio}x) | Total: ${total_size}" >> "$LOG_FILE"

  # Measure query execution times
  echo "--- EXPLAIN ANALYZE: Selective Query ('kubernetes') ---" >> "$LOG_FILE"
  local q1_plan
  q1_plan=$(docker compose exec -T postgres psql -U discord -d discord -c "
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT m.id, m.content
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    WHERE c.guild_id = ${GUILD_ID} AND m.content ILIKE '%kubernetes%'
    ORDER BY m.id DESC
    LIMIT 25;
  ")
  echo "$q1_plan" >> "$LOG_FILE"
  local q1_time
  q1_time=$(echo "$q1_plan" | grep -i "Execution Time:" | awk '{print $3, $4}')

  echo "--- EXPLAIN ANALYZE: Common Term ('discussion') ---" >> "$LOG_FILE"
  local q2_plan
  q2_plan=$(docker compose exec -T postgres psql -U discord -d discord -c "
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT m.id, m.content
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    WHERE c.guild_id = ${GUILD_ID} AND m.content ILIKE '%discussion%'
    ORDER BY m.id DESC
    LIMIT 25;
  ")
  echo "$q2_plan" >> "$LOG_FILE"
  local q2_time
  q2_time=$(echo "$q2_plan" | grep -i "Execution Time:" | awk '{print $3, $4}')

  echo "--- EXPLAIN ANALYZE: Short 2-Char Term ('hi') ---" >> "$LOG_FILE"
  local q3_plan
  q3_plan=$(docker compose exec -T postgres psql -U discord -d discord -c "
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT m.id, m.content
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    WHERE c.guild_id = ${GUILD_ID} AND m.content ILIKE '%hi%'
    ORDER BY m.id DESC
    LIMIT 25;
  ")
  echo "$q3_plan" >> "$LOG_FILE"
  local q3_time
  q3_time=$(echo "$q3_plan" | grep -i "Execution Time:" | awk '{print $3, $4}')

  printf "  ${BOLD}Query Latencies:${NC}\n"
  printf "    Selective ('kubernetes'): ${GREEN}%s${NC}\n" "$q1_time"
  printf "    Common    ('discussion'): ${YELLOW}%s${NC}\n" "$q2_time"
  printf "    Short     ('hi'):         ${RED}%s${NC}\n\n" "$q3_time"
}

# 3. Execute tiers: 100k, 500k, 1M
printf "${YELLOW}→ [2/4] Benchmarking Tier 1: 100,000 messages...${NC}\n"
run_benchmark_tier 100000

printf "${YELLOW}→ [3/4] Benchmarking Tier 2: 500,000 messages...${NC}\n"
run_benchmark_tier 500000

printf "${YELLOW}→ [4/4] Benchmarking Tier 3: 1,000,000 messages...${NC}\n"
run_benchmark_tier 1000000

printf "${GREEN}${BOLD}================================================================${NC}\n"
printf "${GREEN}${BOLD}✔ pg_trgm GIN INDEX CLIFF BENCHMARK COMPLETED SUCCESSFULLY!     ${NC}\n"
printf "${GREEN}${BOLD}================================================================${NC}\n"
printf "Full EXPLAIN ANALYZE traces saved to: ${BLUE}%s${NC}\n\n" "$LOG_FILE"
