#!/usr/bin/env bash
set -euo pipefail

API_BASE="http://localhost:80/api"
GO_BASE="http://localhost:8080"

echo "=== Preparing Go Read States Benchmark ==="

RAND_ID="$(date +%s)_$((RANDOM % 10000))"
USER="go_bench_${RAND_ID}"
PASS="BenchPass_${RAND_ID}!"

# 1. Register & Login
curl -s -X POST "${API_BASE}/auth/register" -H "Content-Type: application/json" \
  -d "{\"username\": \"${USER}\", \"email\": \"${USER}@test.com\", \"password\": \"${PASS}\"}" > /dev/null

TOKEN=$(curl -s -X POST "${API_BASE}/auth/login" -H "Content-Type: application/json" \
  -d "{\"login\": \"${USER}\", \"password\": \"${PASS}\"}" | jq -r '.token')

# 2. Create Guild & Channel
GUILD_ID=$(curl -s -X POST "${API_BASE}/guilds" -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" -d "{\"name\": \"GoBenchGuild\"}" | jq -r '.id')

CHANNEL_ID=$(curl -s -X POST "${API_BASE}/guilds/${GUILD_ID}/channels" -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" -d "{\"name\": \"go-bench-channel\", \"type\": 0}" | jq -r '.id')

echo "Seeded User Token and Channel ID: ${CHANNEL_ID}"

# 3. Check memory RSS of Go container before benchmark
PRE_MEM=$(docker stats --no-stream --format "{{.MemUsage}}" kith-api-1)
echo "Go Container Initial Memory: ${PRE_MEM}"

# 4. Run 30s sustained 5,000 ACKs/sec benchmark against Go service
echo "Running 5,000 ACKs/sec load against Go API on port 8080..."
cd scripts
go run bench/bench_read_states.go \
  -api-url "${GO_BASE}" \
  -api-token "${TOKEN}" \
  -channel-id "${CHANNEL_ID}" \
  -rps 5000 \
  -duration 30s \
  -concurrency 64

# 5. Check memory RSS of Go container after benchmark
POST_MEM=$(docker stats --no-stream --format "{{.MemUsage}}" kith-api-1)
echo "Go Container Final Memory: ${POST_MEM}"
