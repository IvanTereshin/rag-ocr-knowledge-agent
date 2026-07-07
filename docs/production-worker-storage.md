# Production worker + storage

Этот документ описывает текущий worker/storage runtime. Он уже не является только планом: API умеет ставить документы в очередь, а отдельный worker обрабатывает jobs.

## Текущий статус

В production-режиме используется такой поток:

```text
POST /api/documents
  -> Fastify принимает multipart
  -> source сохраняется в object storage adapter
  -> document получает статус queued
  -> job попадает в Redis queue
  -> worker запускает OCR / parsing / chunking
  -> worker сохраняет chunks и статус ready / failed
  -> frontend polling обновляет список документов
```

Переключатель режима:

```bash
PROCESSING_MODE=queued
```

Если нужен старый dev-путь без Redis и worker:

```bash
PROCESSING_MODE=inline
```

## Компоненты

- `apps/api/src/server.ts` - upload endpoint, manual reprocess endpoint, enqueue jobs.
- `apps/api/src/worker.ts` - отдельный worker process для обработки документов.
- `apps/api/src/queue.ts` - Redis-backed queue и in-memory/inline fallback.
- `apps/api/src/object-storage.ts` - local storage adapter и S3-compatible MinIO adapter.
- `apps/api/src/pipeline.ts` - extraction, OCR fallback, chunking.
- `apps/web/src/App.tsx` - polling статусов `queued` / `processing`.

## Очередь

Production queue работает через Redis:

```bash
REDIS_URL=redis://redis:6379
WORKER_CONCURRENCY=2
WORKER_JOB_ATTEMPTS=5
WORKER_JOB_BACKOFF_MS=5000
```

Важно: при `PROCESSING_MODE=queued` API fail-fast стартует только с `REDIS_URL`. Это защищает production от тихого запуска без очереди.

## Object storage

Source-файлы пишутся через общий adapter. Для production можно использовать MinIO или другой S3-compatible сервис:

```bash
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=rag_ocr
S3_SECRET_ACCESS_KEY=change-me
S3_BUCKET_SOURCE=rag-ocr-source
S3_BUCKET_DERIVED=rag-ocr-derived
S3_FORCE_PATH_STYLE=true
```

Если S3-настройки не заданы, adapter использует локальную папку внутри `DATA_DIR`. Это удобно для local dev, но для настоящего production лучше MinIO/S3.

Рекомендуемый layout ключей:

```text
users/{userId}/documents/{documentId}/source/{originalFileName}
users/{userId}/documents/{documentId}/derived/text.txt
users/{userId}/documents/{documentId}/derived/chunks.json
```

## Статусы документа

- `queued` - job создан, worker ещё не начал обработку.
- `processing` - worker уже работает с документом.
- `ready` - текст и chunks сохранены.
- `failed` - обработка завершилась ошибкой после попыток.

Worker обновляет `jobId`, `queuedAt`, `processingStartedAt`, `processedAt`, `pipelineVersion` и `error`. Старые chunks заменяются по `documentId`, поэтому повторная обработка не должна плодить дубликаты.

## Запуск

Локально для проверки queued-flow:

```bash
redis-server --port 6380 --save '' --appendonly no
DATA_DIR=/tmp/rag-data PROCESSING_MODE=queued REDIS_URL=redis://127.0.0.1:6380 npm --prefix apps/api start
DATA_DIR=/tmp/rag-data REDIS_URL=redis://127.0.0.1:6380 npm --prefix apps/api run worker
```

Production stack:

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

## Известные ограничения

- JSON store остаётся fallback для разработки; production должен использовать `DATABASE_URL`.
- Для масштабирования API и worker нужен общий Postgres и общий object storage.
- Vector indexing выполняется и в API inline-flow, и в worker queued-flow. Если vector store недоступен, pipeline сохраняет chunks и работает через degraded retrieval.
- Derived artifacts пока в основном живут в `DATA_DIR`; следующий шаг - переносить text/chunks metadata в object storage или нормальные таблицы.

## Минимальная проверка

Перед деплоем проверьте:

```bash
npm run build
docker compose --env-file .env.production -f docker-compose.production.yml config
```

Smoke-flow:

1. зарегистрироваться;
2. загрузить `.txt`, `.pdf` или `.docx`;
3. увидеть статус `queued`, затем `processing`, затем `ready`;
4. задать вопрос по документу;
5. проверить, что ответ содержит sources.
