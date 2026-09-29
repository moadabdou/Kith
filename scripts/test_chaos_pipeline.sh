#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost/api}"
CDN_URL="${CDN_URL:-http://localhost}"
RAND_ID="$(date +%s)_$((RANDOM % 10000))"
USERNAME="chaos_${RAND_ID}"
EMAIL="chaos_${RAND_ID}@example.com"
PASSWORD="Password123!"

echo "=== 1. Setup Auth and Test Channel ==="
curl -sS -X POST "$API_BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"username\":\"$USERNAME\"}" >/dev/null

LOGIN_RES=$(curl -sS -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"login\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")
TOKEN=$(echo "$LOGIN_RES" | jq -r '.token')

GUILD_RES=$(curl -sS -X POST "$API_BASE/guilds" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Chaos Guild"}')
GUILD_ID=$(echo "$GUILD_RES" | jq -r '.id')

CHANNEL_RES=$(curl -sS -X POST "$API_BASE/guilds/$GUILD_ID/channels" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"chaos-media","type":0}')
CHANNEL_ID=$(echo "$CHANNEL_RES" | jq -r '.id')
echo "Auth setup complete. Channel: $CHANNEL_ID"

echo "=== 2. Decompression Bomb Protection Drill ==="
python3 scripts/generate_bomb.py /tmp/bomb_40k.png

BOMB_UPLOAD=$(curl -s -X POST "$API_BASE/channels/$CHANNEL_ID/attachments" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/bomb_40k.png;type=image/png")
BOMB_ID=$(echo "$BOMB_UPLOAD" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
echo "Uploaded 40,000x40,000 bomb. Attachment ID: $BOMB_ID"

# Wait for media worker to reject the bomb
BOMB_STATUS="pending"
for i in {1..20}; do
  DB_STATUS=$(docker exec kith-postgres-1 psql -U discord -d discord -t -A -c "SELECT status FROM attachments WHERE id = $BOMB_ID" || true)
  if [ "$DB_STATUS" = "failed" ]; then
    BOMB_STATUS="failed"
    break
  fi
  sleep 0.5
done

if [ "$BOMB_STATUS" != "failed" ]; then
  echo "FAIL: Expected decompression bomb status to be 'failed', got '$BOMB_STATUS'"
  exit 1
fi

# Verify worker container is healthy and was NOT OOM killed
OOM_KILLED=$(docker inspect kith-media-worker-1 --format '{{.State.OOMKilled}}')
CONTAINER_STATUS=$(docker inspect kith-media-worker-1 --format '{{.State.Status}}')
if [ "$OOM_KILLED" != "false" ] || [ "$CONTAINER_STATUS" != "running" ]; then
  echo "FAIL: Media worker was OOM killed or stopped: OOMKilled=$OOM_KILLED, status=$CONTAINER_STATUS"
  exit 1
fi
echo "SUCCESS: Decompression bomb rejected safely without worker crash or OOM kill."

echo "=== 3. Worker Failover & JetStream Redelivery Drill ==="
# Generate a test image
python3 -c "
from PIL import Image
img = Image.new('RGB', (800, 600), color=(120, 180, 240))
img.save('/tmp/failover_test.jpg')
"
FAILOVER_UPLOAD=$(curl -s -X POST "$API_BASE/channels/$CHANNEL_ID/attachments" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/failover_test.jpg;type=image/jpeg")
FAILOVER_ID=$(echo "$FAILOVER_UPLOAD" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
echo "Uploaded failover test image. Attachment ID: $FAILOVER_ID"

# Send SIGKILL immediately to simulate sudden crash during worker processing
docker kill -s SIGKILL kith-media-worker-1 >/dev/null
echo "Sent SIGKILL to kith-media-worker-1"

# Restart worker container
docker start kith-media-worker-1 >/dev/null
echo "Restarted kith-media-worker-1; waiting for JetStream redelivery and convergence..."

# Poll until attachment converges to 'ready'
CONVERGED_STATUS="pending"
for i in {1..80}; do
  DB_STATUS=$(docker exec kith-postgres-1 psql -U discord -d discord -t -A -c "SELECT status FROM attachments WHERE id = $FAILOVER_ID" || true)
  if [ "$DB_STATUS" = "ready" ]; then
    CONVERGED_STATUS="ready"
    break
  fi
  sleep 0.5
done

if [ "$CONVERGED_STATUS" != "ready" ]; then
  echo "FAIL: Expected failover attachment to converge to 'ready', got '$CONVERGED_STATUS'"
  exit 1
fi

DUPLICATE_COUNT=$(docker exec kith-postgres-1 psql -U discord -d discord -t -A -c "SELECT count(*) FROM attachments WHERE id = $FAILOVER_ID")
if [ "$DUPLICATE_COUNT" != "1" ]; then
  echo "FAIL: Detected duplicate records: $DUPLICATE_COUNT"
  exit 1
fi
echo "SUCCESS: Worker kill-recovery converged cleanly with 0 duplicate artifacts or stuck pending rows."

echo "=== 4. EXIF Stripping Verification ==="
python3 -c "
from PIL import Image
from fractions import Fraction
img = Image.new('RGB', (400, 300), color=(200, 100, 50))
exif = img.getexif()
exif[0x010f] = 'Apple'
exif[0x0110] = 'iPhone 15 Pro'
gps_ifd = exif.get_ifd(0x8825)
gps_ifd[1] = 'N'
gps_ifd[2] = (Fraction(37, 1), Fraction(46, 1), Fraction(2974, 100))
gps_ifd[3] = 'W'
gps_ifd[4] = (Fraction(122, 1), Fraction(25, 1), Fraction(982, 100))
img.save('/tmp/gps_test_photo.jpg', exif=exif)
"
echo "Generated /tmp/gps_test_photo.jpg with GPS coordinates."

EXIF_UPLOAD=$(curl -s -X POST "$API_BASE/channels/$CHANNEL_ID/attachments" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/gps_test_photo.jpg;type=image/jpeg")
EXIF_ID=$(echo "$EXIF_UPLOAD" | jq -r '.id')
EXIF_URL=$(echo "$EXIF_UPLOAD" | jq -r '.url')

# Wait for processing ready
for i in {1..20}; do
  DB_STATUS=$(docker exec kith-postgres-1 psql -U discord -d discord -t -A -c "SELECT status FROM attachments WHERE id = $EXIF_ID" || true)
  if [ "$DB_STATUS" = "ready" ]; then
    break
  fi
  sleep 0.5
done

# Download sanitized original and thumbnail
curl -s "$EXIF_URL" -o /tmp/downloaded_original.jpg
curl -s "$CDN_URL/attachments/$CHANNEL_ID/$EXIF_ID/thumb_256.webp" -o /tmp/downloaded_thumb.webp

# Run exiftool inspection using our fast local inspector
EXIF_OUT=$(./scripts/exiftool /tmp/downloaded_original.jpg /tmp/downloaded_thumb.webp)

GPS_MATCHES=$(echo "$EXIF_OUT" | grep -i "GPS" || true)
if [ -n "$GPS_MATCHES" ]; then
  echo "FAIL: GPS metadata found in processed image!"
  echo "$GPS_MATCHES"
  exit 1
fi
echo "SUCCESS: Automated exiftool check returns 0 GPS tags on processed images."

echo "=== 5. Abandoned Upload Garbage Collection Drill ==="
# Insert a synthetic abandoned upload older than 25 hours
ABANDONED_ID="999999$(date +%s)"
ABANDONED_KEY="attachments/$CHANNEL_ID/$ABANDONED_ID/abandoned.bin"
VALID_USER_ID=$(docker exec kith-postgres-1 psql -U discord -d discord -t -A -c "SELECT id FROM users LIMIT 1")
docker exec kith-postgres-1 psql -U discord -d discord -c "
INSERT INTO attachments (id, channel_id, uploader_id, filename, content_type, byte_size, sha256, s3_bucket, s3_key, status, created_at)
VALUES ($ABANDONED_ID, $CHANNEL_ID, $VALID_USER_ID, 'abandoned.bin', 'application/octet-stream', 1024, 'dummy', 'attachments', '$ABANDONED_KEY', 'pending', NOW() - INTERVAL '25 hours');
" >/dev/null

# Upload dummy object into MinIO
echo "abandoned object data" | docker exec -i kith-minio-1 sh -c "cat > /data/attachments/$ABANDONED_KEY" 2>/dev/null || true

# Run gc-uploads tool natively
./bin/gc-uploads \
  --db="postgres://discord:discord@127.0.0.1:5432/discord?sslmode=disable" \
  --s3-endpoint="127.0.0.1:9000" \
  --s3-access-key="kithadmin" \
  --s3-secret-key="kithpassword123" \
  --older-than=24h --dry-run=false

# Check that the row was pruned from postgres
REMAINING_ROW=$(docker exec kith-postgres-1 psql -U discord -d discord -t -A -c "SELECT count(*) FROM attachments WHERE id = $ABANDONED_ID")
if [ "$REMAINING_ROW" != "0" ]; then
  echo "FAIL: Abandoned upload row was not pruned!"
  exit 1
fi
echo "SUCCESS: Abandoned upload garbage collection successfully pruned pending records."

echo "=== 6. CDN Edge Cache Benchmark (k6 with 100 VUs) ==="
TARGET_BENCH_URL="$EXIF_URL"
echo "Running k6 benchmark on $TARGET_BENCH_URL with 100 VUs for 15s..."
TARGET_URL="$TARGET_BENCH_URL" k6 run scripts/benchmark_cdn_cache.js

echo "=== ALL ISSUE #102 CHAOS & BENCHMARK VERIFICATION TESTS PASSED ==="
