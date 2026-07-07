# Production worker + storage plan

Этот документ описывает следующий production-slice для документационного потока.  
Цель: вынести обработку файлов из HTTP-запроса в фоновый worker и убрать зависимость от локального диска приложения, не ломая текущий runtime API в этом шаге.

## 1. Что есть сейчас

По коду сейчас поток такой:

```text
POST /api/documents
  -> Fastify принимает multipart
  -> файл пишется в DATA_DIR/uploads/<userId>/
  -> сразу вызывается processDocument(...)
  -> текст пишется в DATA_DIR/extracted-text/<userId>/<documentId>.txt
  -> chunks кладутся в jsonb store в PostgreSQL
  -> ответ возвращается только после завершения обработки
```

Где это живет:

- `apps/api/src/server.ts`
  - upload endpoint: `POST /api/documents`
  - manual reprocess: `POST /api/documents/:documentId/process`
  - text read endpoint: `GET /api/documents/:documentId/text`
- `apps/api/src/pipeline.ts`
  - `processDocument(...)`
  - OCR/text extraction, chunking, index creation
- `apps/api/src/store.ts`
  - `DocumentRecord`, `DocumentChunkRecord`
  - PostgreSQL `rag_ocr_app_state` через `DATABASE_URL`

Сейчас это удобно для MVP, но для production есть 3 проблемы:

1. HTTP-запрос долго держит соединение, пока идет OCR и chunking.
2. Файл и derived-артефакты лежат на диске одного контейнера.
3. При рестарте/масштабировании приложения обработка и storage становятся хрупкими.

## 2. Целевой поток

Нужен такой путь:

```text
API upload
  -> object storage
  -> queue
  -> worker
  -> OCR / parse / chunk / index
  -> PostgreSQL metadata + chunks
  -> API reads status and results
```

### Базовая идея

- API принимает файл и сразу отдает `queued` или `uploaded`.
- Сам файл сохраняется в S3-compatible storage, лучше MinIO для self-host.
- API кладет job в очередь.
- Worker забирает job, делает OCR и chunking, сохраняет derived data и обновляет документ.
- API только читает статус и результат, но не выполняет тяжелую обработку.

## 3. Почему Redis + BullMQ

Для этого проекта самый практичный вариант - `Redis + BullMQ`.

Почему:

- нативно подходит для Node.js;
- просто связать с Fastify worker;
- есть retry, backoff, concurrency, delayed jobs;
- удобно разделить `upload` и `process` без большой перестройки кода;
- потом легко добавить отдельный worker контейнер.

Альтернатива вроде RabbitMQ тоже рабочая, но для текущего стека она тяжелее по интеграции без явной пользы.

## 4. Storage layout в S3 / MinIO

Рекомендуемый layout - один bucket или два bucket'а, но с одинаковой логикой ключей.

### Вариант A: один bucket

Bucket: `rag-ocr`

```text
users/{userId}/documents/{documentId}/source/{originalFileName}
users/{userId}/documents/{documentId}/derived/text.txt
users/{userId}/documents/{documentId}/derived/ocr.json
users/{userId}/documents/{documentId}/derived/chunks.json
users/{userId}/documents/{documentId}/derived/meta.json
users/{userId}/documents/{documentId}/logs/worker.log
```

### Вариант B: два bucket'а

- `rag-ocr-source`
- `rag-ocr-derived`

Плюс тот же путь внутри bucket'ов.

### Что хранить

- `source` - оригинальный файл, который загрузил пользователь.
- `text.txt` - нормализованный извлеченный текст.
- `ocr.json` - результат OCR/парсинга, если нужен для диагностики.
- `chunks.json` - список чанков и их metadata.
- `meta.json` - служебные поля: версия пайплайна, engine, время обработки, ошибки.

### Что лучше не хранить в object storage

- секреты;
- session data;
- runtime settings;
- все, что уже нормально живет в PostgreSQL.

## 5. Статусы документа

Текущие статусы в коде уже есть:

```ts
'uploaded' | 'queued' | 'processing' | 'ready' | 'failed'
```

Я бы закрепил такую семантику:

- `uploaded` - файл принят API, но job еще не создан или еще не подтвержден.
- `queued` - job успешно поставлен в очередь, worker еще не начал работу.
- `processing` - worker уже обрабатывает документ.
- `ready` - текст, chunks и индекс готовы.
- `failed` - обработка завершилась с ошибкой после всех retry.

### Retry behavior

Важно не смешивать retry внутри очереди и финальный статус документа.

- Пока job retry'ится, документ остается в `queued` или `processing`.
- Количество попыток задается на уровне queue job.
- После последнего неудачного retry документ переводится в `failed`.
- В `error` кладется короткое понятное сообщение для UI.

### Что делать с исходником при ошибке

Не удалять сразу.

Полезно сохранить:

- оригинальный файл;
- последний error;
- worker trace id / job id;
- номер попытки;
- timestamps.

Так проще чинить проблемные документы без повторной загрузки.

## 6. Как должен работать worker

Worker должен делать только тяжелую часть пайплайна:

1. скачать source файл из object storage;
2. определить тип файла;
3. запустить OCR или text extraction;
4. сохранить нормализованный текст;
5. сделать chunking;
6. подготовить chunks для поиска;
7. сохранить результат;
8. обновить статус документа в PostgreSQL.

### Хорошая практика

- Worker должен быть идемпотентным.
- Если job пришел второй раз, он не должен плодить дубликаты chunks.
- Перед записью новых chunks лучше удалять старые по `documentId`.
- Версию pipeline стоит сохранять отдельно, чтобы понимать, чем был обработан документ.

## 7. Какие ENV понадобятся

Ниже не код, а список переменных, которые стоит заранее заложить в `.env.example` и `.env.production.example`, когда дойдем до implementation slice.

### Queue / worker

```bash
REDIS_URL=redis://redis:6379
WORKER_CONCURRENCY=2
WORKER_JOB_ATTEMPTS=5
WORKER_JOB_BACKOFF_MS=5000
```

### Object storage

```bash
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=rag_ocr
S3_SECRET_ACCESS_KEY=change-me
S3_BUCKET_SOURCE=rag-ocr-source
S3_BUCKET_DERIVED=rag-ocr-derived
S3_FORCE_PATH_STYLE=true
```

### Полезные служебные

```bash
WORKER_LOG_LEVEL=info
DOCUMENT_PIPELINE_VERSION=1
```

## 8. Что менять потом по файлам

Этот список нужен как карта для следующего implementation slice.

### Core backend

- `apps/api/src/server.ts`
  - убрать синхронную обработку из `POST /api/documents`
  - вместо `processDocument(...)` только сохранять файл и ставить job
  - обновлять статус `queued`
  - оставить публичный контракт ответа максимально близким к текущему

- `apps/api/src/pipeline.ts`
  - оставить общую логику extraction/chunking
  - позже вынести в shared worker-friendly модуль, если понадобится

- `apps/api/src/store.ts`
  - расширить `DocumentRecord` служебными полями для queue/job tracking
  - не ломать текущий jsonb формат без причины

### New worker code

- новый worker entrypoint, например `apps/worker/src/index.ts`
- новый queue helper, например `apps/api/src/queue.ts` или общий модуль
- новый storage adapter, например `apps/api/src/object-storage.ts`

### Frontend

- `apps/web/src/api.ts`
- `apps/web/src/App.tsx`

Там потом, скорее всего, понадобится только:

- polling статусов;
- более честный UI для `queued` / `processing`;
- кнопка retry/reprocess.

## 9. Какие API endpoints потом менять

### Сразу после перехода на queue

- `POST /api/documents`
  - больше не делает OCR внутри запроса
  - только upload + enqueue

- `POST /api/documents/:documentId/process`
  - станет повторным запуском job, а не прямым вызовом пайплайна

### Позже, если будет нужно

- `GET /api/documents`
  - может начать возвращать job metadata: `attempts`, `lastErrorAt`, `jobId`

- `GET /api/documents/:documentId/text`
  - может читать `text.txt` из object storage, а не только из локального пути

- `POST /api/ask`
  - обычно менять не нужно сразу, но он должен фильтровать только `ready` документы

## 10. Рекомендуемые этапы внедрения

### Этап 1. Документ и договоренности

Результат:

- есть этот design doc;
- понятны storage keys;
- понятны статусы и retry rule;
- понятны будущие файлы и endpoints.

### Этап 2. Redis + MinIO как отдельные сервисы

Результат:

- в compose появляются `redis` и `minio`;
- `app` пока работает как раньше;
- можно проверить connectivity и credentials.

### Этап 3. Worker без включения в основной поток

Результат:

- worker умеет брать job и запускать существующий `processDocument`;
- API пока еще может оставить старый путь как fallback;
- можно проверить только новый path на тестовом документе.

### Этап 4. Перенос upload в object storage

Результат:

- source больше не лежит на локальном диске app;
- `storagePath` заменяется на object key или storage descriptor;
- текст и chunks тоже сохраняются через worker pipeline.

### Этап 5. Полный switch

Результат:

- API не делает тяжелую обработку;
- app можно масштабировать отдельно от worker;
- storage и queue становятся production-ready.

## 11. Минимальный критерий готовности

Этот slice можно считать удачным, если:

- upload не держит request до конца OCR;
- source file сохраняется вне контейнера app;
- worker может пережить рестарт без потери очереди;
- failed document получает понятный `error`;
- retry не создает дубликаты chunks;
- текущий runtime API еще не сломан.

## 12. Что важно не сделать сейчас

- Не переписывать весь pipeline сразу.
- Не трогать `package.json`, `server.ts` и `store.ts` в этом шаге.
- Не смешивать queue design с полной сменой vector store.
- Не добавлять лишние runtime изменения, пока не готов worker slice.

