# Production operations

Этот runbook покрывает базовую диагностику production stack.

## Health endpoints

Быстрая проверка API:

```bash
curl -fsS http://localhost:3000/api/health
```

Подробная проверка зависимостей:

```bash
curl -fsS http://localhost:3000/api/health/dependencies | jq
```

`/api/health/dependencies` возвращает:

- `ok` - все обязательные зависимости доступны;
- `checks[].status` - `ok`, `degraded` или `skipped`;
- `checks[].required` - влияет ли зависимость на общий `ok`;
- `checks[].latencyMs` - сколько заняла проверка;
- `checks[].message` - короткое сообщение без секретов.

## Что проверяется

- `store` - JSON store или PostgreSQL через `store.read()`.
- `redis` - `PING` плюс чтение job queue summary.
- `object-storage` - короткий put/get/delete round-trip.
- `qdrant` - HTTP GET по `QDRANT_BASE_URL`.
- `tei` - HTTP GET по `TEI_BASE_URL/health`.

Redis и object storage обязательны в `PROCESSING_MODE=queued`. Qdrant и TEI считаются optional: если они выключены или не настроены, API должен продолжать работать через fallback.

## ENV

```bash
HEALTH_CHECK_TIMEOUT_MS=2000
QDRANT_BASE_URL=http://qdrant:6333
QDRANT_API_KEY=
TEI_BASE_URL=http://tei:80
```

Не используйте в health-ответах `DATABASE_URL`, `REDIS_URL`, S3 keys, API keys или proxy URL. Endpoint должен показывать статус, но не конфигурационные секреты.

## Быстрая диагностика

Если `/api/health` работает, а `/api/health/dependencies` возвращает `ok: false`, смотрите конкретный `checks[]`.

- `store degraded` - проверьте PostgreSQL или права на `DATA_DIR`.
- `redis degraded` - проверьте `REDIS_URL` и контейнер `redis`.
- `object-storage degraded` - проверьте MinIO/S3 credentials и bucket.
- `qdrant degraded` - vector search уйдёт в local retrieval fallback.
- `tei degraded` - local rerank уйдёт в local retrieval fallback.
