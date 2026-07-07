# Production backup and restore

Этот runbook описывает, как делать backup и restore для production-стека из `docker-compose.production.yml` и `.env.production`.

## Что именно сохраняем

Primary state:

- PostgreSQL - пользователи, сессии, настройки, документы, chunks, миграции.

File/object state:

- `app_data` - `uploads`, local storage, служебные файлы в `/app/data`.
- `minio_data` - объекты MinIO и метаданные бакетов.
- `qdrant_data` - локальное хранилище Qdrant.
- `redis_data` - appendonly state Redis. Это вторичный state, но его тоже стоит забирать, если очередь уже используется в production.

Не включаем в backup:

- `tei_cache` - это cache, а не источник истины.
- образы Docker, `node_modules`, build-артефакты и временные файлы.

## Что важно до backup

1. Production stack должен быть уже поднят.
2. Backup делайте с тем же `COMPOSE_PROJECT_NAME`, с которым был поднят стек.
3. Если проект запускали без `-p`, обычно достаточно значения по умолчанию, то есть имени папки репозитория.
4. Если менялся `APP_SECRET`, старые зашифрованные значения в PostgreSQL и API keys восстановятся только при том же секрете.

## Backup

Команда по умолчанию:

```bash
./scripts/backup-production.sh
```

Полезные варианты:

```bash
BACKUP_DIR=./backups/production ./scripts/backup-production.sh
DRY_RUN=1 ./scripts/backup-production.sh
COMPOSE_PROJECT_NAME=my-prod ./scripts/backup-production.sh
```

Что создаёт скрипт:

```text
backups/production/production-YYYYMMDD-HHMMSS/
  manifest.txt
  postgres.sql.gz
  app_data.tar.gz
  minio_data.tar.gz
  qdrant_data.tar.gz
  redis_data.tar.gz
```

`manifest.txt` помогает быстро понять, откуда взят backup и каким compose-файлом он был сделан.

## Restore

Restore всегда требует явного подтверждения:

```bash
RESTORE_CONFIRM=YES ./scripts/restore-production.sh ./backups/production/production-YYYYMMDD-HHMMSS
```

Если нужно полностью заменить существующие данные в volumes, добавьте:

```bash
RESTORE_CONFIRM=YES RESTORE_WIPE=YES ./scripts/restore-production.sh ./backups/production/production-YYYYMMDD-HHMMSS
```

Dry-run:

```bash
RESTORE_CONFIRM=YES DRY_RUN=1 ./scripts/restore-production.sh ./backups/production/production-YYYYMMDD-HHMMSS
```

Что делает restore:

1. Останавливает production stack.
2. Восстанавливает `app_data`, `minio_data`, `qdrant_data`, `redis_data`.
3. Поднимает `postgres`.
4. Загружает PostgreSQL dump через `psql`.
5. Поднимает весь stack обратно.

## Минимальная проверка после restore

```bash
curl -fsS http://localhost:3000/api/health
curl -fsS http://localhost:3000/api/health/dependencies | jq
```

Потом проверьте вручную:

- логин/регистрация;
- список документов;
- наличие файлов в object storage;
- очередь worker, если `PROCESSING_MODE=queued`;
- ответ на `/api/ask`.

## Ограничения

- Restore не включает `tei_cache`, потому что это только cache.
- PostgreSQL backup здесь логический, а не физический. Это удобнее и безопаснее для обычного production runbook.
- Скрипты не угадывают чужой compose-project name. Если стек запускали с `docker compose -p`, укажите тот же `COMPOSE_PROJECT_NAME`.
- Если `APP_SECRET` менялся после backup, старые зашифрованные данные могут стать нечитаемыми.
