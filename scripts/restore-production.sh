#!/usr/bin/env bash
set -euo pipefail

IFS=$'\n\t'

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$ROOT_DIR")}"
RESTORE_CONFIRM="${RESTORE_CONFIRM:-}"
RESTORE_WIPE="${RESTORE_WIPE:-0}"
DRY_RUN="${DRY_RUN:-0}"
BACKUP_PATH="${BACKUP_PATH:-}"

usage() {
  cat <<'EOF'
Usage:
  restore-production.sh [--dry-run] [--help] <backup-bundle-dir>

Required environment:
  RESTORE_CONFIRM=YES    Explicit confirmation for restore

Optional environment:
  RESTORE_WIPE=YES       Remove existing named volumes before restore
  COMPOSE_FILE           Path to docker-compose.production.yml
  ENV_FILE               Path to .env.production
  COMPOSE_PROJECT_NAME   Compose project name used for the stack
  DRY_RUN=1              Print actions without running them

Backup bundle should contain:
  - manifest.txt
  - postgres.sql.gz
  - app_data.tar.gz
  - minio_data.tar.gz
  - qdrant_data.tar.gz
  - redis_data.tar.gz
EOF
}

log() {
  printf '[restore-production] %s\n' "$*"
}

die() {
  printf '[restore-production] ERROR: %s\n' "$*" >&2
  exit 1
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
  if [[ -n "$container_id" ]]; then
    volume_name="$(
      docker inspect \
        --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Name}}{{end}}{{end}}" \
        "$container_id"
    )"
    if [[ -n "$volume_name" ]]; then
      printf '%s' "$volume_name"
      return 0
    fi
  fi

  printf '%s_%s' "$COMPOSE_PROJECT_NAME" "$fallback_key"
}

require_file() {
  local file="$1"
  [[ -f "$file" ]] || die "File not found: $file"
}

require_bundle_file() {
  local file="$1"
  [[ -f "$BACKUP_PATH/$file" ]] || die "Backup file not found: $BACKUP_PATH/$file"
}

confirm_restore() {
  [[ "$RESTORE_CONFIRM" == "YES" ]] || die "Set RESTORE_CONFIRM=YES to run restore."
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[restore-production][dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

volume_name() {
  printf '%s_%s' "$COMPOSE_PROJECT_NAME" "$1"
}

wait_for_postgres() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would wait for PostgreSQL to become ready"
    return 0
  fi

  local attempt
  for attempt in $(seq 1 60); do
    if compose exec -T postgres sh -lc 'pg_isready -U rag_ocr -d rag_ocr' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  die "PostgreSQL did not become ready in time."
}

capture_volume_names() {
  APP_VOLUME_NAME="$(service_volume_name app /app/data app_data)"
  MINIO_VOLUME_NAME="$(service_volume_name minio /data minio_data)"
  QDRANT_VOLUME_NAME="$(service_volume_name qdrant /qdrant/storage qdrant_data)"
  REDIS_VOLUME_NAME="$(service_volume_name redis /data redis_data)"
}

wipe_volume_if_requested() {
  local volume="$1"

  if [[ "$RESTORE_WIPE" != "YES" ]]; then
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would remove volume $volume"
    return 0
  fi

  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume rm "$volume" >/dev/null
  fi
}

ensure_volume_ready() {
  local volume="$1"

  if [[ "$RESTORE_WIPE" == "YES" ]]; then
    wipe_volume_if_requested "$volume"
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    log "Would refuse to overwrite existing data in volume $volume unless RESTORE_WIPE=YES is set"
    return 0
  fi

  if docker volume inspect "$volume" >/dev/null 2>&1; then
    local has_files
    has_files="$(docker run --rm -v "${volume}:/volume:ro" alpine:3.20 sh -lc 'find /volume -mindepth 1 -print -quit | grep -q . && echo yes || true')"
    if [[ -n "$has_files" ]]; then
      die "Volume $volume is not empty. Set RESTORE_WIPE=YES to replace its contents."
    fi
  fi
}

restore_volume() {
  local volume="$1"
  local archive="$2"

  log "Restoring $archive -> $volume"
  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi

  docker volume create "$volume" >/dev/null
  docker run --rm \
    -v "${volume}:/volume" \
    -v "${BACKUP_PATH}:/backup:ro" \
    alpine:3.20 \
    sh -lc "cd /volume && tar -xzf /backup/${archive}"
}

restore_postgres() {
  log "Restoring PostgreSQL dump"

  if [[ "$DRY_RUN" == "1" ]]; then
    return 0
  fi

  compose up -d postgres >/dev/null
  wait_for_postgres

  compose exec -T postgres sh -lc 'export PGPASSWORD="${POSTGRES_PASSWORD:-}"; dropdb -h 127.0.0.1 -U rag_ocr --if-exists rag_ocr && createdb -h 127.0.0.1 -U rag_ocr -O rag_ocr rag_ocr'
  gzip -dc "$BACKUP_PATH/postgres.sql.gz" \
    | compose exec -T postgres sh -lc 'PGPASSWORD="${POSTGRES_PASSWORD:-}" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -U rag_ocr -d rag_ocr'
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
        if [[ -z "$BACKUP_PATH" ]]; then
          BACKUP_PATH="$1"
          shift
        else
          die "Unknown argument: $1"
        fi
        ;;
    esac
  done

  confirm_restore
  require_file "$COMPOSE_FILE"
  require_file "$ENV_FILE"

  [[ -n "$BACKUP_PATH" ]] || die "Pass backup bundle directory as the first argument or set BACKUP_PATH."
  [[ -d "$BACKUP_PATH" ]] || die "Backup bundle directory not found: $BACKUP_PATH"

  require_bundle_file "manifest.txt"
  require_bundle_file "postgres.sql.gz"
  require_bundle_file "app_data.tar.gz"
  require_bundle_file "minio_data.tar.gz"
  require_bundle_file "qdrant_data.tar.gz"
  require_bundle_file "redis_data.tar.gz"

  compose config --services >/dev/null

  capture_volume_names

  log "Stopping production stack"
  run compose down --remove-orphans

  ensure_volume_ready "$APP_VOLUME_NAME"
  ensure_volume_ready "$MINIO_VOLUME_NAME"
  ensure_volume_ready "$QDRANT_VOLUME_NAME"
  ensure_volume_ready "$REDIS_VOLUME_NAME"

  restore_volume "$APP_VOLUME_NAME" "app_data.tar.gz"
  restore_volume "$MINIO_VOLUME_NAME" "minio_data.tar.gz"
  restore_volume "$QDRANT_VOLUME_NAME" "qdrant_data.tar.gz"
  restore_volume "$REDIS_VOLUME_NAME" "redis_data.tar.gz"

  restore_postgres

  log "Starting full stack"
  run compose up -d

  log "Restore finished. Check the health endpoints before opening traffic."
}

main "$@"
