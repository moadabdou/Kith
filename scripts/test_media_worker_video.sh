#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:8080/api}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "=== 1. Setting up Test User and Channel ==="
RAND_ID="$(date +%s)_$((RANDOM % 10000))"
USER_JSON="$(curl -sS -X POST "${API_BASE}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"vidtest_${RAND_ID}\", \"email\": \"vidtest_${RAND_ID}@example.com\", \"password\": \"TestPass123!\"}")"

LOGIN_JSON="$(curl -sS -X POST "${API_BASE}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"login\": \"vidtest_${RAND_ID}\", \"password\": \"TestPass123!\"}")"
TOKEN="$(echo "${LOGIN_JSON}" | jq -r '.token')"
echo "Registered and logged in, JWT acquired."

GUILD_JSON="$(curl -sS -X POST "${API_BASE}/guilds" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"name\": \"Video Guild ${RAND_ID}\"}")"
GUILD_ID="$(echo "${GUILD_JSON}" | jq -r '.id')"
CHANNEL_JSON="$(curl -sS -X POST "${API_BASE}/guilds/${GUILD_ID}/channels" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"name": "test-video-channel", "type": 0}')"
CHANNEL_ID="$(echo "${CHANNEL_JSON}" | jq -r '.id')"
echo "Test channel ID: ${CHANNEL_ID}"

echo "=== 2. Generating Sample 2-Second MP4 Video ==="
TEST_VIDEO="${TMP_DIR}/test_sample.mp4"
chmod 777 "${TMP_DIR}"
docker run --rm --user root --entrypoint ffmpeg -v "${TMP_DIR}:/out" kith-media-worker:latest \
  -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 \
  -f lavfi -i sine=frequency=1000:duration=2 \
  -c:v libx264 -c:a aac -pix_fmt yuv420p /out/test_sample.mp4 >/dev/null 2>&1

echo "Generated video size: $(wc -c < "${TEST_VIDEO}") bytes"

echo "=== 3. Uploading MP4 Video via API ==="
UPLOAD_RESP="$(curl -sS -X POST "${API_BASE}/channels/${CHANNEL_ID}/attachments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "file=@${TEST_VIDEO};type=video/mp4;filename=sample.mp4")"

ATTACHMENT_ID="$(echo "${UPLOAD_RESP}" | jq -r '.id')"
echo "Uploaded attachment ID: ${ATTACHMENT_ID}"

echo "=== 4. Waiting for Media Worker to Process Video ==="
PROCESSED=false
for i in {1..20}; do
  sleep 1
  STATUS_RESP="$(curl -sS -X GET "${API_BASE}/channels/${CHANNEL_ID}/attachments/${ATTACHMENT_ID}" \
    -H "Authorization: Bearer ${TOKEN}")"
  STATUS="$(echo "${STATUS_RESP}" | jq -r '.status')"
  echo "Poll $i: status=${STATUS}"
  if [ "${STATUS}" = "ready" ]; then
    PROCESSED=true
    break
  elif [ "${STATUS}" = "failed" ]; then
    echo "Processing failed: ${STATUS_RESP}"
    exit 1
  fi
done

if [ "${PROCESSED}" != "true" ]; then
  echo "Timeout waiting for video processing"
  exit 1
fi

echo "=== 5. Verifying Probed Metadata & Poster Frame ==="
echo "${STATUS_RESP}" | jq '.'
DURATION="$(echo "${STATUS_RESP}" | jq -r '.duration_secs')"
WIDTH="$(echo "${STATUS_RESP}" | jq -r '.width')"
HEIGHT="$(echo "${STATUS_RESP}" | jq -r '.height')"
POSTER_URL="$(echo "${STATUS_RESP}" | jq -r '.thumbnails.poster.url')"

echo "Probed Duration: ${DURATION}s (expected ~2.0s)"
echo "Dimensions: ${WIDTH}x${HEIGHT} (expected 320x240)"
echo "Poster URL: ${POSTER_URL}"

if [ "${WIDTH}" -ne 320 ] || [ "${HEIGHT}" -ne 240 ]; then
  echo "FAIL: Unexpected dimensions ${WIDTH}x${HEIGHT}"
  exit 1
fi

if [ -z "${POSTER_URL}" ] || [ "${POSTER_URL}" = "null" ]; then
  echo "FAIL: Missing poster thumbnail"
  exit 1
fi

if [ "${DURATION}" != "2" ] && [ "${DURATION}" != "2.0" ]; then
  echo "FAIL: Unexpected duration ${DURATION}"
  exit 1
fi

echo "=== 6. Testing Corrupt Video Handling ==="
CORRUPT_FILE="${TMP_DIR}/corrupt.mp4"
# Prepend valid MP4 ftyp header so Go detects video/mp4, followed by corrupt stream bytes
head -c 32 "${TEST_VIDEO}" > "${CORRUPT_FILE}"
head -c 1000 /dev/urandom >> "${CORRUPT_FILE}"

CORRUPT_RESP="$(curl -sS -X POST "${API_BASE}/channels/${CHANNEL_ID}/attachments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "file=@${CORRUPT_FILE};type=video/mp4;filename=corrupt.mp4")"
CORRUPT_ID="$(echo "${CORRUPT_RESP}" | jq -r '.id')"
echo "Uploaded corrupt attachment ID: ${CORRUPT_ID}"

CORRUPT_HANDLED=false
for i in {1..15}; do
  sleep 1
  STATUS_RESP="$(curl -sS -X GET "${API_BASE}/channels/${CHANNEL_ID}/attachments/${CORRUPT_ID}" \
    -H "Authorization: Bearer ${TOKEN}")"
  STATUS="$(echo "${STATUS_RESP}" | jq -r '.status')"
  echo "Poll corrupt $i: status=${STATUS}"
  if [ "${STATUS}" = "failed" ]; then
    echo "SUCCESS: Corrupt video correctly marked as 'failed' without worker crash"
    CORRUPT_HANDLED=true
    break
  fi
done

if [ "${CORRUPT_HANDLED}" != "true" ]; then
  echo "FAIL: Corrupt video was not marked as failed"
  exit 1
fi

echo "=== 7. Testing Non-Video/Non-Image Passthrough (Bypass FFmpeg) ==="
TEXT_FILE="${TMP_DIR}/notes.txt"
echo "hello discord media notes" > "${TEXT_FILE}"
TEXT_RESP="$(curl -sS -X POST "${API_BASE}/channels/${CHANNEL_ID}/attachments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "file=@${TEXT_FILE};type=text/plain;filename=notes.txt")"
TEXT_ID="$(echo "${TEXT_RESP}" | jq -r '.id')"

for i in {1..10}; do
  sleep 1
  STATUS_RESP="$(curl -sS -X GET "${API_BASE}/channels/${CHANNEL_ID}/attachments/${TEXT_ID}" \
    -H "Authorization: Bearer ${TOKEN}")"
  STATUS="$(echo "${STATUS_RESP}" | jq -r '.status')"
  if [ "${STATUS}" = "ready" ]; then
    echo "SUCCESS: Non-video/non-image upload bypassed FFmpeg and marked ready"
    break
  fi
done

echo "=== ALL ISSUE #100 VERIFICATION TESTS PASSED ==="
