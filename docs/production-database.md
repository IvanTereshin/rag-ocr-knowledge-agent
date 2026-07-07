# Production database

Production API использует PostgreSQL, если задан `DATABASE_URL`. Local dev без `DATABASE_URL` продолжает работать через `DATA_DIR/store.json`.

## Tables

`PostgresStore` хранит прежний `StoreData` контракт, но раскладывает его по таблицам:

- `rag_ocr_users` - пользователи и password hash/salt.
- `rag_ocr_sessions` - HTTP-only cookie sessions и CSRF token hash.
- `rag_ocr_service_settings` - настройки OpenAI, Mistral, rerankers, Qdrant.
- `rag_ocr_proxy_settings` - общий proxy URL в зашифрованном виде.
- `rag_ocr_documents` - metadata документов, статусы pipeline, source path, extracted text и preview.
- `rag_ocr_document_chunks` - chunks для retrieval fallback и citations.
- `rag_ocr_schema_migrations` - применённые миграции.

Секреты остаются зашифрованными через `APP_SECRET`; база не должна хранить raw API keys.

## Schema migrations

DDL хранится в `apps/api/migrations/*.sql` и применяется при старте `PostgresStore` в алфавитном порядке. Runner сначала создаёт bootstrap-таблицу `rag_ocr_schema_migrations`, затем выполняет новые SQL-файлы и записывает имя файла без `.sql` как version.

Для контейнера Dockerfile копирует `apps/api/migrations` рядом с `dist`. Если нужен нестандартный путь, задайте `POSTGRES_MIGRATIONS_DIR`.

## Legacy migration

Старые инсталляции могли хранить всё состояние в одной строке:

```text
rag_ocr_app_state(id = 1, data jsonb)
```

При первом запуске новая версия:

1. создаёт нормализованные таблицы;
2. если `rag_ocr_app_state` существует и все новые state-таблицы пустые, переносит данные;
3. записывает migration marker `normalized-store-v1`;
4. оставляет legacy table как read-only источник истории, не использует её для новых writes.

## Store contract

Для остального backend код не изменился:

```ts
read(): Promise<StoreData>
write(nextData: StoreData): Promise<void>
```

`write()` по-прежнему означает полную замену состояния. В PostgreSQL это делается транзакционно: сначала очищаются дочерние таблицы, затем заново вставляется весь снимок.

Новые документы хранят extracted text в `DocumentRecord.textContent`, который мапится в `rag_ocr_documents.text_content`. `textPath` остаётся legacy fallback для старых документов, которые были обработаны до переноса текста в store.

## Smoke checks

Минимум после изменения схемы:

```bash
npm --prefix apps/api run build
npm run build
```

Runtime check с `DATABASE_URL`:

1. register;
2. `/api/auth/csrf`;
3. upload `.txt`;
4. `/api/ask`;
5. проверить counts в `rag_ocr_users`, `rag_ocr_documents`, `rag_ocr_document_chunks`.

Legacy check: создать `rag_ocr_app_state`, запустить API/Store, убедиться, что user/document появились в нормализованных таблицах и повторный старт не создаёт дубликаты.
