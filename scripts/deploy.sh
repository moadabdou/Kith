#!/usr/bin/env bash
# ==============================================================================
# scripts/deploy.sh — Production Zero-Downtime Deployment & Health Check Pipeline
# Target: Oracle Cloud VM (ubuntu@51.170.129.228:5022)
# ==============================================================================
set -euo pipefail

# ANSI color formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

SSH_HOST="${SSH_HOST:-51.170.129.228}"
SSH_PORT="${SSH_PORT:-5022}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/oracle_vm}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/kith}"
DOMAIN="${DOMAIN:-kith.moadabdou.me}"

log_step() {
  printf "\n${BLUE}${BOLD}==> %s${NC}\n" "$1"
}

log_pass() {
  printf "    ${GREEN}✓ %s${NC}\n" "$1"
}

log_fail() {
  printf "    ${RED}✗ %s${NC}\n" "$1"
  exit 1
}

log_info() {
  printf "    ${YELLOW}ℹ %s${NC}\n" "$1"
}

# ------------------------------------------------------------------------------
# Remote Orchestration Mode (Runs when invoked from local developer machine)
# ------------------------------------------------------------------------------
if [[ "${1:-}" != "--local" ]]; then
  log_step "Initializing Kith Production Deployment"
  log_info "Target: ${SSH_USER}@${SSH_HOST}:${SSH_PORT} (${REMOTE_DIR})"

  if [[ ! -f "${SSH_KEY}" ]]; then
    log_fail "SSH key not found at ${SSH_KEY}"
  fi

  log_step "[1/4] Verifying SSH connectivity..."
  if ! ssh -i "${SSH_KEY}" -p "${SSH_PORT}" -o ConnectTimeout=5 -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" "echo 'SSH Connected'" >/dev/null 2>&1; then
    log_fail "Failed to connect to ${SSH_USER}@${SSH_HOST}:${SSH_PORT}"
  fi
  log_pass "SSH connection established successfully"

  log_step "[2/4] Syncing project repository to remote server..."
  rsync -avz \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='.env' \
    --exclude='backups' \
    --exclude='data' \
    --exclude='.gemini' \
    --exclude='target' \
    --exclude='dist' \
    --exclude='bin' \
    --exclude='_build' \
    --exclude='deps' \
    --exclude='deploy/caddy/caddy' \
    --exclude='api/api' \
    -e "ssh -i ${SSH_KEY} -p ${SSH_PORT} -o StrictHostKeyChecking=no" \
    ./ "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/"
  log_pass "Codebase synchronized to ${REMOTE_DIR}"

  log_step "[3/4] Triggering zero-downtime rolling deployment on remote host..."
  ssh -i "${SSH_KEY}" -p "${SSH_PORT}" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
    "cd ${REMOTE_DIR} && chmod +x scripts/*.sh && ./scripts/deploy.sh --local"

  log_step "[4/4] Validating external public endpoints from deployment client..."
  log_info "Testing public domain API: https://${DOMAIN}/api/healthz"
  if curl -s -k --resolve "${DOMAIN}:443:${SSH_HOST}" "https://${DOMAIN}/api/healthz" | grep -q "ok"; then
    log_pass "Public API endpoint healthy (https://${DOMAIN}/api/healthz)"
  else
    log_fail "Public API health check failed"
  fi

  log_info "Testing public Gateway WebSocket: wss://${DOMAIN}/ws"
  WS_STATUS="$(python3 -c "
import socket, ssl
try:
    s = socket.create_connection(('${SSH_HOST}', 443), timeout=5)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ss = ctx.wrap_socket(s, server_hostname='${DOMAIN}')
    ss.sendall(b'GET /ws HTTP/1.1\r\nHost: ${DOMAIN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
    resp = ss.recv(1024).decode('utf-8', errors='ignore')
    first_line = resp.split('\r\n')[0]
    print(first_line)
except Exception as e:
    print('ERROR:', e)
" 2>&1)"

  if [[ "${WS_STATUS}" =~ "101" ]]; then
    log_pass "Public Gateway WebSocket upgrade successful (${WS_STATUS})"
  else
    log_fail "Gateway WebSocket handshake failed: ${WS_STATUS}"
  fi

  echo ""
  printf "${GREEN}${BOLD}================================================================${NC}\n"
  printf "${GREEN}${BOLD}✓ DEPLOYMENT SUCCEEDED: Zero-downtime rolling update complete!   ${NC}\n"
  printf "${GREEN}${BOLD}================================================================${NC}\n"
  exit 0
fi

# ------------------------------------------------------------------------------
# Local Deployment Mode (Executes on the VM)
# ------------------------------------------------------------------------------
wait_healthy() {
  local service_name="$1"
  local url="$2"
  local max_wait="${3:-40}"
  local elapsed=0

  printf "    Waiting for %s to become healthy..." "${service_name}"
  while [[ $elapsed -lt $max_wait ]]; do
    if curl -s -f -m 2 "${url}" >/dev/null 2>&1; then
      printf " ${GREEN}healthy (${elapsed}s)${NC}\n"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    printf "."
  done
  printf " ${RED}FAILED after ${max_wait}s${NC}\n"
  return 1
}

COMPOSE="docker compose -f compose.prod.yml"

log_step "[Deploy Phase 1] Pre-flight checks"
command -v docker >/dev/null 2>&1 || log_fail "docker is required"
$COMPOSE config --quiet || log_fail "compose.prod.yml configuration invalid"
log_pass "Docker compose configuration valid"

log_step "[Deploy Phase 2] Running PostgreSQL database schema migrations"
$COMPOSE run --rm migrate
log_pass "Database migrations applied cleanly"

log_step "[Deploy Phase 3] Rolling Deploy Go API Cluster (api & api-2)"
# 1. Build new API images
log_info "Building Go API container image..."
$COMPOSE build api api-2

# 2. Ensure api-2 (port 8083) is active to handle traffic during api recreate
log_info "Bringing up api-2 (port 8083)..."
$COMPOSE up -d api-2
wait_healthy "api-2 (port 8083)" "http://127.0.0.1:8083/healthz" 30 || log_fail "api-2 failed to start"

# 3. Recreate primary api (port 8082) - Nginx fails over to api-2
log_info "Recreating primary api (port 8082)..."
$COMPOSE up -d --force-recreate api
wait_healthy "primary api (port 8082)" "http://127.0.0.1:8082/healthz" 30 || log_fail "primary api failed to restart"

# 4. Recreate api-2 (port 8083) with updated image - Nginx routes to primary api
log_info "Recreating backup api-2 (port 8083)..."
$COMPOSE up -d --force-recreate api-2
wait_healthy "backup api-2 (port 8083)" "http://127.0.0.1:8083/healthz" 30 || log_fail "backup api-2 failed to restart"
log_pass "Go API cluster rolling update complete (api & api-2 healthy)"

log_step "[Deploy Phase 4] Rolling Deploy Elixir Gateway Cluster (gateway & gateway-2)"
# 1. Build new Gateway images
log_info "Building Elixir Gateway container image..."
$COMPOSE build gateway gateway-2

# 2. Ensure gateway-2 (port 4001) is active
log_info "Bringing up gateway-2 (port 4001)..."
$COMPOSE up -d gateway-2
wait_healthy "gateway-2 (port 4001)" "http://127.0.0.1:4001/healthz" 45 || log_fail "gateway-2 failed to start"

# 3. Recreate primary gateway (port 4000) - Nginx fails over to gateway-2
log_info "Recreating primary gateway (port 4000)..."
$COMPOSE up -d --force-recreate gateway
wait_healthy "primary gateway (port 4000)" "http://127.0.0.1:4000/healthz" 45 || log_fail "primary gateway failed to restart"

# 4. Recreate gateway-2 (port 4001)
log_info "Recreating backup gateway-2 (port 4001)..."
$COMPOSE up -d --force-recreate gateway-2
wait_healthy "backup gateway-2 (port 4001)" "http://127.0.0.1:4001/healthz" 45 || log_fail "backup gateway-2 failed to restart"
log_pass "Elixir Gateway cluster rolling update complete (gateway & gateway-2 healthy)"

log_step "[Deploy Phase 5] Refreshing static frontend client bundle"
$COMPOSE up -d --build client
wait_healthy "frontend client (port 5173)" "http://127.0.0.1:5173/" 30 || log_fail "client failed to start"
log_pass "Frontend client bundle refreshed"

log_step "[Deploy Phase 6] Post-Deploy Smoke Health Checks"
log_info "Checking API health endpoints:"
curl -s -f http://127.0.0.1:8082/healthz >/dev/null && log_pass "api (port 8082) healthy"
curl -s -f http://127.0.0.1:8083/healthz >/dev/null && log_pass "api-2 (port 8083) healthy"

log_info "Checking Gateway health endpoints:"
curl -s -f http://127.0.0.1:4000/healthz >/dev/null && log_pass "gateway (port 4000) healthy"
curl -s -f http://127.0.0.1:4001/healthz >/dev/null && log_pass "gateway-2 (port 4001) healthy"

log_info "Checking Gateway WebSocket upgrade on local instances:"
for port in 4000 4001; do
  WS_RES="$(python3 -c "
import socket
s = socket.create_connection(('127.0.0.1', ${port}), timeout=3)
s.sendall(b'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
print(s.recv(1024).decode('utf-8', errors='ignore').split('\r\n')[0])
" 2>&1)"
  if [[ "${WS_RES}" =~ "101" ]]; then
    log_pass "gateway:${port} WebSocket upgrade verified"
  else
    log_fail "gateway:${port} WebSocket handshake failed (${WS_RES})"
  fi
done

log_info "Checking SFU WebRTC signaling health:"
curl -s -f http://127.0.0.1:5000/healthz >/dev/null && log_pass "sfu-1 (port 5000) healthy"
curl -s -f http://127.0.0.1:5001/healthz >/dev/null && log_pass "sfu-2 (port 5001) healthy"

log_pass "All post-deploy smoke health checks passed successfully!"
