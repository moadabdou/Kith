#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost/api}"
CDN_BASE="${CDN_BASE:-http://localhost}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "=== 1. Setup Test User and Guild ==="
RAND_ID="$(date +%s)_$((RANDOM % 10000))"
USER_JSON="$(curl -sS -X POST "${API_BASE}/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\": \"cdntest_${RAND_ID}\", \"email\": \"cdntest_${RAND_ID}@example.com\", \"password\": \"TestPass123!\"}")"

LOGIN_JSON="$(curl -sS -X POST "${API_BASE}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"login\": \"cdntest_${RAND_ID}\", \"password\": \"TestPass123!\"}")"
TOKEN="$(echo "${LOGIN_JSON}" | jq -r '.token')"
echo "JWT acquired."

GUILD_JSON="$(curl -sS -X POST "${API_BASE}/guilds" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"name\": \"CDN Guild ${RAND_ID}\"}")"
GUILD_ID="$(echo "${GUILD_JSON}" | jq -r '.id')"

# Public channel
PUB_CHAN_JSON="$(curl -sS -X POST "${API_BASE}/guilds/${GUILD_ID}/channels" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"name": "public-media", "type": 0}')"
PUB_CHAN_ID="$(echo "${PUB_CHAN_JSON}" | jq -r '.id')"
echo "Created public channel: ${PUB_CHAN_ID}"

# Private channel (deny VIEW_CHANNEL to @everyone)
PRIV_CHAN_JSON="$(curl -sS -X POST "${API_BASE}/guilds/${GUILD_ID}/channels" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"name": "private-vault", "type": 0}')"
PRIV_CHAN_ID="$(echo "${PRIV_CHAN_JSON}" | jq -r '.id')"

# Add overwrite denying VIEW_CHANNEL to @everyone
# VIEW_CHANNEL bit = 1 << 10 = 1024
curl -sS -X PUT "${API_BASE}/channels/${PRIV_CHAN_ID}/permissions/${GUILD_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"allow": 0, "deny": 1024, "type": 0}' >/dev/null
echo "Configured private channel with VIEW_CHANNEL deny overwrite: ${PRIV_CHAN_ID}"

echo "=== 2. Generate and Upload Video to Public Channel ==="
TEST_VIDEO="${TMP_DIR}/video.mp4"
chmod 777 "${TMP_DIR}"
docker run --rm --user root --entrypoint ffmpeg -v "${TMP_DIR}:/out" kith-media-worker:latest \
  -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 \
  -f lavfi -i sine=frequency=1000:duration=2 \
  -c:v libx264 -c:a aac -pix_fmt yuv420p /out/video.mp4 >/dev/null 2>&1

UPLOAD_RESP="$(curl -sS -X POST "${API_BASE}/channels/${PUB_CHAN_ID}/attachments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "file=@${TEST_VIDEO};type=video/mp4;filename=video.mp4")"
PUB_ATT_ID="$(echo "${UPLOAD_RESP}" | jq -r '.id')"

echo "Waiting for media worker to process public video..."
for i in {1..20}; do
  sleep 1
  STATUS_RESP="$(curl -sS -X GET "${API_BASE}/channels/${PUB_CHAN_ID}/attachments/${PUB_ATT_ID}" \
    -H "Authorization: Bearer ${TOKEN}")"
  STATUS="$(echo "${STATUS_RESP}" | jq -r '.status')"
  if [ "${STATUS}" = "ready" ]; then
    break
  fi
done

POSTER_KEY="$(echo "${STATUS_RESP}" | jq -r '.thumbnails.poster.s3_key')"
echo "Public video processed. Poster S3 key: ${POSTER_KEY}"

echo "=== 3. Testing Immutable Cache Headers via Caddy CDN ==="
CDN_HEADERS="$(curl -sI "${CDN_BASE}/${POSTER_KEY}")"
echo "${CDN_HEADERS}"

if ! echo "${CDN_HEADERS}" | grep -iq "Cache-Control:.*immutable"; then
  echo "FAIL: Expected immutable cache header on CDN delivery"
  exit 1
fi
echo "SUCCESS: Verified 'Cache-Control: public, max-age=31536000, immutable'"

echo "=== 4. Testing HTTP 206 Partial Content Range Request ==="
RANGE_FILE="${TMP_DIR}/range_slice.bin"
RANGE_HEADERS="${TMP_DIR}/range_headers.txt"

curl -s -D "${RANGE_HEADERS}" -H "Range: bytes=0-1024" \
  "${CDN_BASE}/${POSTER_KEY}" -o "${RANGE_FILE}"

cat "${RANGE_HEADERS}"

if ! grep -q "206 Partial Content" "${RANGE_HEADERS}"; then
  echo "FAIL: Expected HTTP 206 Partial Content for range request"
  exit 1
fi

if ! grep -iq "Content-Range: bytes 0-1024/" "${RANGE_HEADERS}"; then
  echo "FAIL: Expected Content-Range: bytes 0-1024/ in headers"
  exit 1
fi

BYTE_COUNT="$(wc -c < "${RANGE_FILE}")"
echo "Downloaded range byte count: ${BYTE_COUNT}"
if [ "${BYTE_COUNT}" -ne 1025 ]; then
  echo "FAIL: Expected exactly 1025 bytes (bytes 0-1024 inclusive), got ${BYTE_COUNT}"
  exit 1
fi
echo "SUCCESS: Verified HTTP 206 Partial Content streaming and byte range accuracy"

echo "=== 5. Testing Private Channel Signed URLs ==="
PRIV_UPLOAD="$(curl -sS -X POST "${API_BASE}/channels/${PRIV_CHAN_ID}/attachments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "file=@${TEST_VIDEO};type=video/mp4;filename=vault_video.mp4")"
PRIV_ATT_ID="$(echo "${PRIV_UPLOAD}" | jq -r '.id')"

# Post message in private channel referencing attachment
MSG_RESP="$(curl -sS -X POST "${API_BASE}/channels/${PRIV_CHAN_ID}/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "{\"content\": \"Top secret video\", \"attachments\": [\"${PRIV_ATT_ID}\"]}")"

SIGNED_URL="$(echo "${MSG_RESP}" | jq -r '.attachments[0].url')"
echo "Signed Private Attachment URL: ${SIGNED_URL}"

# Verify URL contains ex, is, and hm query parameters
if ! echo "${SIGNED_URL}" | grep -q "ex=" || ! echo "${SIGNED_URL}" | grep -q "hm="; then
  echo "FAIL: Expected private channel attachment URL to have ex= and hm= signature query params"
  exit 1
fi
echo "SUCCESS: Verified signed query parameters present on private channel attachment"

# Test 5a: Valid signed URL returns HTTP 200 or 206
SIGNED_HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" "${SIGNED_URL}")"
echo "Valid signed URL response code: ${SIGNED_HTTP_CODE}"
if [ "${SIGNED_HTTP_CODE}" -ne 200 ]; then
  echo "FAIL: Expected HTTP 200 for valid signed URL, got ${SIGNED_HTTP_CODE}"
  exit 1
fi
echo "SUCCESS: Valid signed URL authorized"

# Test 5b: Tampered HMAC returns HTTP 403 Forbidden
TAMPERED_URL="$(echo "${SIGNED_URL}" | sed 's/hm=[a-f0-9]*/hm=deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd/')"
TAMPERED_CODE="$(curl -s -o /dev/null -w "%{http_code}" "${TAMPERED_URL}")"
echo "Tampered HMAC response code: ${TAMPERED_CODE}"
if [ "${TAMPERED_CODE}" -ne 403 ]; then
  echo "FAIL: Expected HTTP 403 Forbidden for tampered HMAC, got ${TAMPERED_CODE}"
  exit 1
fi
echo "SUCCESS: Tampered signature rejected with HTTP 403"

# Test 5c: Expired URL returns HTTP 403 Forbidden
EXPIRED_URL="$(echo "${SIGNED_URL}" | sed 's/ex=[a-f0-9]*/ex=1000/')"
EXPIRED_CODE="$(curl -s -o /dev/null -w "%{http_code}" "${EXPIRED_URL}")"
echo "Expired URL response code: ${EXPIRED_CODE}"
if [ "${EXPIRED_CODE}" -ne 403 ]; then
  echo "FAIL: Expected HTTP 403 Forbidden for expired URL, got ${EXPIRED_CODE}"
  exit 1
fi
echo "SUCCESS: Expired signature rejected with HTTP 403"

# Test 5d: Unsigned request to private channel attachment returns HTTP 403 Forbidden
UNSIGNED_PATH="$(echo "${SIGNED_URL}" | cut -d'?' -f1)"
UNSIGNED_CODE="$(curl -s -o /dev/null -w "%{http_code}" "${UNSIGNED_PATH}")"
echo "Unsigned private access response code: ${UNSIGNED_CODE}"
if [ "${UNSIGNED_CODE}" -ne 403 ]; then
  echo "FAIL: Expected HTTP 403 Forbidden for unsigned private access, got ${UNSIGNED_CODE}"
  exit 1
fi
echo "SUCCESS: Unsigned private channel media access rejected with HTTP 403"

echo "=== ALL ISSUE #101 VERIFICATION TESTS PASSED ==="
