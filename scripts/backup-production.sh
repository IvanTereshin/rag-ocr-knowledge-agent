#!/usr/bin/env bash
set -euo pipefail

IFS=$'\n\t'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$ROOT_DIR")}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups/production}"
BACKUP_NAME="${BACKUP_NAME:-production-$(date +%Y%m%d-%H%M%S)}"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
DRY_RUN="${DRY_RUN:-0}"

usage() {
  cat <<'EOF'
Usage:
  backup-production.sh [--dry-run] [--help]

Environment:
  COMPOSE_FILE           Path to docker-compose.production.yml
  ENV_FILE               Path to .env.production
  COMPOSE_PROJECT_NAME    Compose project name used for the stack
  BACKUP_DIR             Directory for backup bundles
  BACKUP_NAME            Backup bundle name
  DRY_RUN=1              Print actions without running them

Output:
  Creates a backup bundle directory with:
    - manifest.txt
    - postgres.sql.gz
    - app_data.tar.gz
    - minio_data.tar.gz
    - qdrant_data.tar.gz
    - redis_data.tar.gz
EOF
}

log() {
  printf '[backup-production] %s\n' "$*"
}

die() {
  printf '[backup-production] ERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[backup-production][dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

compose() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" "$@"
}

service_volume_name() {
  local service="$1"
  local destination="$2"
  local fallback_key="$3"
  local container_id
  local volume_name

  container_id="$(compose ps -q "$service")"
  if [[ -z "$container_id" ]]; then
    printf '%s_%s' "$COMPOSE_PROJECT_NAME" "$fallback_key"
    return 0
  fi

  volume_name="$(
    docker inspect \
      --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Name}}{{end}}{{end}}" \
      "$container_id"
  )"

  if [[ -n "$volume_name" ]]; then
    printf '%s' "$volume_name"
    return 0
  fi

  printf '%s_%s' "$COMPOSE_PROJECT_NAME" "$fallback_key"
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || die "File not found: $file"
}

backup_volume() {
  local volume_name="$1"
  local archive_name="$2"

  log "Backing up volume ${volume_name} -> ${archive_name}"
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi

  docker volume inspect "$volume_name" >/dev/null 2>&1 || die "Docker volume not found: $volume_name"

  docker run --rm \
    -v "${volume_name}:/volume:ro" \
    -v "${BACKUP_PATH}:/backup" \
    alpine:3.20 \
    sh -lc "cd /volume && tar -czf /backup/${archive_name} ."
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done

  require_file "$COMPOSE_FILE"
  require_file "$ENV_FILE"

  compose config --services >/dev/null

  if [[ "$DRY_RUN" == "1" ]]; then
    log "Dry run only. Nothing will be written."
    log "Would write bundle to $BACKUP_PATH"
    log "Would export PostgreSQL dump from service postgres"
    log "Would archive volumes: app_data, minio_data, qdrant_data, redis_data"
    exit 0
  fi

  local postgres_container
  postgres_container="$(compose ps -q postgres)"
  [[ -n "$postgres_container" ]] || die "Postgres container is not running. Start the production stack first."
  docker inspect --format '{{.State.Running}}' "$postgres_container" | grep -qx true || die "Postgres container is not running. Start the production stack first."

  run mkdir -p "$BACKUP_PATH"

  log "Writing bundle to $BACKUP_PATH"

  if [[ "$DRY_RUN" != "1" ]]; then
    cat > "$BACKUP_PATH/manifest.txt" <<EOF
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose_file=$COMPOSE_FILE
env_file=$ENV_FILE
compose_project_name=$COMPOSE_PROJECT_NAME
source_host=$(hostname)
EOF
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would export PostgreSQL dump to postgres.sql.gz"
  else
    local tmp_postgres_dump="$BACKUP_PATH/postgres.sql.gz.partial"
    compose exec -T postgres sh -lc 'PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump -h 127.0.0.1 -U rag_ocr -d rag_ocr --clean --if-exists --no-owner --no-privileges' \
      | gzip -9 > "$tmp_postgres_dump"
    mv "$tmp_postgres_dump" "$BACKUP_PATH/postgres.sql.gz"
  fi

  backup_volume "$(service_volume_name app /app/data app_data)" "app_data.tar.gz"
  backup_volume "$(service_volume_name minio /data minio_data)" "minio_data.tar.gz"
  backup_volume "$(service_volume_name qdrant /qdrant/storage qdrant_data)" "qdrant_data.tar.gz"
  backup_volume "$(service_volume_name redis /data redis_data)" "redis_data.tar.gz"

  log "Backup finished: $BACKUP_PATH"
}

main "$@"
