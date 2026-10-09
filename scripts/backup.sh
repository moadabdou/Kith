#!/usr/bin/env bash
# ==============================================================================
# scripts/backup.sh — Nightly Database Backup for PostgreSQL and ScyllaDB
# Kith Production Deployment (Oracle Cloud VM)
# ==============================================================================
set -euo pipefail

SSH_HOST="${SSH_HOST:-51.170.129.228}"
SSH_PORT="${SSH_PORT:-5022}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/oracle_vm}"
REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/kith}"

# If invoked from developer machine without --local and not running as ubuntu on VM
if [[ "${1:-}" != "--local" ]] && [[ ! -d "/home/ubuntu/kith" ]]; then
  printf "==> Triggering remote database backup on %s@%s:%s...\n" "${SSH_USER}" "${SSH_HOST}" "${SSH_PORT}"
  ssh -i "${SSH_KEY}" -p "${SSH_PORT}" -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" \
    "cd ${REMOTE_DIR} && ./scripts/backup.sh --local"
  exit 0
fi

BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/kith/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-kith-postgres-1}"
POSTGRES_USER="${POSTGRES_USER:-kith_prod}"
POSTGRES_DB="${POSTGRES_DB:-kith_prod}"

SCYLLA_CONTAINER="${SCYLLA_CONTAINER:-kith-scylla-1}"
SCYLLA_KEYSPACE="${SCYLLA_KEYSPACE:-kith}"

mkdir -p "${BACKUP_DIR}"

log() {
  printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1"
}

log "=========================================================="
log "Starting Kith Automated Database Backup"
log "Backup destination: ${BACKUP_DIR}"
log "=========================================================="

# ------------------------------------------------------------------------------
# 1. PostgreSQL Backup (Compressed pg_dump)
# ------------------------------------------------------------------------------
PG_BACKUP_FILE="${BACKUP_DIR}/postgres_${POSTGRES_DB}_${TIMESTAMP}.sql.gz"
log "Backing up PostgreSQL (${POSTGRES_DB}) from container '${POSTGRES_CONTAINER}'..."

if ! docker exec "${POSTGRES_CONTAINER}" pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
  log "ERROR: PostgreSQL is not ready in container '${POSTGRES_CONTAINER}'."
  exit 1
fi

docker exec "${POSTGRES_CONTAINER}" pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" | gzip > "${PG_BACKUP_FILE}"

if gzip -t "${PG_BACKUP_FILE}"; then
  PG_SIZE="$(ls -lh "${PG_BACKUP_FILE}" | awk '{print $5}')"
  log "SUCCESS: PostgreSQL dump verified (${PG_SIZE}): ${PG_BACKUP_FILE}"
else
  log "ERROR: PostgreSQL backup archive corrupted: ${PG_BACKUP_FILE}"
  exit 1
fi

# ------------------------------------------------------------------------------
# 2. ScyllaDB Backup (Schema CQL + SSTable Snapshot)
# ------------------------------------------------------------------------------
SCYLLA_SCHEMA_FILE="${BACKUP_DIR}/scylla_schema_${SCYLLA_KEYSPACE}_${TIMESTAMP}.cql"
SCYLLA_SNAP_FILE="${BACKUP_DIR}/scylla_snapshot_${SCYLLA_KEYSPACE}_${TIMESTAMP}.tar.gz"
SNAPSHOT_TAG="backup_${TIMESTAMP}"

log "Backing up ScyllaDB keyspace '${SCYLLA_KEYSPACE}' from container '${SCYLLA_CONTAINER}'..."

# Dump schema
docker exec "${SCYLLA_CONTAINER}" cqlsh -e "DESCRIBE KEYSPACE ${SCYLLA_KEYSPACE};" > "${SCYLLA_SCHEMA_FILE}"
SCHEMA_SIZE="$(ls -lh "${SCYLLA_SCHEMA_FILE}" | awk '{print $5}')"
log "SUCCESS: ScyllaDB schema exported (${SCHEMA_SIZE}): ${SCYLLA_SCHEMA_FILE}"

# Take snapshot
docker exec "${SCYLLA_CONTAINER}" nodetool snapshot -t "${SNAPSHOT_TAG}" "${SCYLLA_KEYSPACE}" >/dev/null

# Archive snapshot directory
docker exec "${SCYLLA_CONTAINER}" sh -c \
  "find /var/lib/scylla/data/${SCYLLA_KEYSPACE} -type d -name '${SNAPSHOT_TAG}' | tar -czf - -T -" \
  > "${SCYLLA_SNAP_FILE}"

# Clear snapshot from container storage
docker exec "${SCYLLA_CONTAINER}" nodetool clearsnapshot -t "${SNAPSHOT_TAG}" "${SCYLLA_KEYSPACE}" >/dev/null 2>&1 || true

if tar -tzf "${SCYLLA_SNAP_FILE}" >/dev/null 2>&1; then
  SCYLLA_SIZE="$(ls -lh "${SCYLLA_SNAP_FILE}" | awk '{print $5}')"
  log "SUCCESS: ScyllaDB snapshot verified (${SCYLLA_SIZE}): ${SCYLLA_SNAP_FILE}"
else
  log "ERROR: ScyllaDB snapshot archive corrupted: ${SCYLLA_SNAP_FILE}"
  exit 1
fi

# ------------------------------------------------------------------------------
# 3. Retention Cleanup (Purge older than RETENTION_DAYS)
# ------------------------------------------------------------------------------
log "Applying retention policy: pruning backups older than ${RETENTION_DAYS} days..."
PURGED_COUNT="$(find "${BACKUP_DIR}" -type f \( -name "*.sql.gz" -o -name "*.tar.gz" -o -name "*.cql" \) -mtime "+${RETENTION_DAYS}" | wc -l)"
find "${BACKUP_DIR}" -type f \( -name "*.sql.gz" -o -name "*.tar.gz" -o -name "*.cql" \) -mtime "+${RETENTION_DAYS}" -delete
log "Retention policy applied (purged ${PURGED_COUNT} old archives)."

log "=========================================================="
log "Backup run completed successfully at $(date '+%Y-%m-%d %H:%M:%S')"
log "Archives created:"
log "  - ${PG_BACKUP_FILE} (${PG_SIZE})"
log "  - ${SCYLLA_SCHEMA_FILE} (${SCHEMA_SIZE})"
log "  - ${SCYLLA_SNAP_FILE} (${SCYLLA_SIZE})"
log "=========================================================="
