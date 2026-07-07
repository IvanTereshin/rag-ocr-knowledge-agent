# Production Roadmap

Цель: превратить portfolio RAG/OCR demo в production-ready продукт, который можно безопасно разворачивать для клиентов, масштабировать и поддерживать.

## Архитектурные Принципы

- Один продукт, два режима: `Облачный` для managed AI API и `Локальный` для self-hosted stack.
- API не должен выполнять тяжелую обработку документов синхронно.
- Все секреты хранятся только в env или зашифрованном server-side хранилище.
- Каждый ответ должен иметь проверяемые citations.
- Production окружение должно запускаться как stack: app, database, queue, object storage, vector store, reranker, worker.

## Этап 1: Production Foundation

Статус: частично готов.

Что уже есть:

- `docker-compose.production.yml` с `app`, `worker`, `postgres`, `redis`, `minio`, `qdrant`, `tei`.
- PostgreSQL persistence через `DATABASE_URL`.
- JSON store fallback для local dev.
- Базовый rate limit.
- Local TEI reranker на `BAAI/bge-reranker-base`.
- Fail-fast production checks для `APP_SECRET`.

Что ещё нужно закрыть:

- Перейти от одного `jsonb` state-row к нормальным таблицам.
- Добавить миграции.
- Добавить structured health checks для внешних сервисов.
- Добавить CI build/lint workflow.

Definition of Done:

- Production stack поднимается одной командой.
- Данные переживают restart контейнера.
- Build проходит в CI.
- Нет секретов в репозитории.

## Этап 2: Реальный RAG Pipeline

Цель: заменить локальный lexical fallback на полноценный retrieval pipeline.

Компоненты:

- embeddings provider: OpenAI-compatible API или локальный embedding service;
- vector store: Qdrant;
- rerank: Cohere, Voyage, Jina или Local TEI;
- answer generation: OpenAI Responses API или локальный LLM в Локальном режиме.

Текущий slice:

- embeddings берутся через OpenAI-compatible API;
- чанки пишутся в Qdrant через `upsert`;
- поиск идёт через Qdrant `search`;
- сверху результатов работает reranker;
- AnswerGenerator использует OpenAI Responses API поверх выбранных citations;
- если retrieval, rerank или answer generation недоступны, система деградирует в fallback-режим.

Это базовый production-срез RAG: сначала находится проверяемый контекст, потом LLM формирует ответ строго по citations.

Порядок внедрения:

1. Добавить модуль embeddings + Qdrant indexing/search.
2. При обработке документа сохранять chunks и vectors в Qdrant.
3. `/api/ask` должен искать кандидатов через Qdrant.
4. Reranker должен работать поверх Qdrant candidates.
5. AnswerGenerator должен формировать ответ через LLM с citations. Готово для OpenAI Responses API.
6. Lexical fallback оставить только как degraded mode.

Definition of Done:

- Вопрос по документу использует vector search.
- Ответ содержит citations с documentId, chunkIndex, score.
- При недоступном Qdrant API возвращает понятный warning.
- При недоступном OpenAI answer generation возвращает шаблонный ответ, а не 500.
- Есть smoke test `upload -> index -> ask`.

## Этап 3: Worker И Object Storage

Цель: убрать тяжелую обработку из HTTP request.

Компоненты:

- queue: Redis + BullMQ или аналог;
- worker service;
- object storage: S3/MinIO;
- document processing statuses.

Текущий slice:

- API умеет работать в `PROCESSING_MODE=queued`;
- upload сохраняет source через storage adapter и ставит job в Redis;
- отдельный `worker` service запускает `processDocument`;
- frontend polling обновляет статусы `queued` / `processing`;
- inline-flow сохранён как local/dev fallback через `PROCESSING_MODE=inline`.

Порядок внедрения:

1. API сохраняет файл в object storage и создаёт document record. Готово.
2. API ставит job в queue. Готово.
3. Worker скачивает файл, делает extraction/OCR/chunking. Готово.
4. Worker обновляет статус документа. Готово.
5. UI polling показывает реальные статусы. Готово.
6. Worker индексирует chunks в Qdrant через общий shared module. Готово.
7. Derived text/chunks artifacts нужно вынести из shared volume в object storage или нормальные таблицы.

Definition of Done:

- Upload request быстро возвращает `queued` или `uploaded`, без долгой OCR-обработки внутри HTTP.
- Worker можно перезапустить без потери job.
- Failed jobs имеют retry и readable error.
- Оригиналы файлов не раздаются публично.

## Этап 4: OCR И Document Parsing

Цель: поддержать реальные PDF/сканы/изображения/таблицы.

Порядок внедрения:

1. Разделить `DocumentParser` и `OcrProvider`.
2. Подключить Mistral OCR для Облачного режима.
3. Подключить локальный OCR provider для Локального режима.
4. Сохранять metadata: page, table, sheet, slide.
5. Передавать metadata в citations.

Definition of Done:

- PDF со сканом проходит OCR.
- DOCX/TXT/CSV продолжают работать.
- Citations показывают страницу/таблицу/лист, если metadata есть.

## Этап 5: Security Hardening

Это первый security hardening slice, а не весь production. Здесь только P0-минимум, который нужно закрыть раньше остальных production-задач.

Минимальный P0 security набор:

- CSRF protection для cookie auth.
- Явная Origin/CORS policy для frontend и state-changing routes.
- Upload validation на сервере: MIME, extension, real type, size limits.
- Per-route rate limits для login, upload, ask и rerank.
- Fail-fast для `APP_SECRET`, если секрет не задан в production.
- Safe-by-default cookie env hardening: `SameSite`, `Secure`, `HttpOnly`, `Path`, `Domain`.

Definition of Done:

- Login нельзя брутфорсить простым циклом.
- Upload принимает только разрешённые типы.
- API не стартует в production без `APP_SECRET`.
- Все state-changing routes защищены от CSRF и unexpected origin.
- Cookie flags задаются безопасно через env и не зависят от случайных дефолтов.

## Этап 6: Observability И Operations

Компоненты:

- structured logs;
- request id;
- latency metrics;
- health endpoints для dependencies;
- backup/restore procedure для Postgres, Qdrant, object storage;
- deployment runbook.

Definition of Done:

- Есть `/api/health` и `/api/health/dependencies`.
- Есть понятный runbook: deploy, rollback, backup, restore.
- Ошибки pipeline можно диагностировать по logs/job ids.

## Приоритет Следующих Задач

1. Добавить local LLM AnswerGenerator для Локального режима.
2. Нормализовать PostgreSQL schema и добавить миграции.
3. Вынести derived text/chunks artifacts из shared volume в object storage или нормальные таблицы.
4. Добавить structured health checks для Redis, MinIO, Qdrant, TEI и AI providers.
5. Добавить CI build/lint workflow.
6. Закрыть оставшиеся security hardening задачи и backup/restore runbook.

## Правило Для Агентов-Исполнителей

Каждый исполнитель получает отдельную зону ответственности и не меняет файлы других потоков без согласования. Архитектор проверяет сборку, объединяет изменения и принимает решение о следующем slice.
