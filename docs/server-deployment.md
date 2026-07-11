# Server deployment

Этот deployment-файл предназначен для персонального demo-сервера с Traefik и wildcard-доменом `ivantereshin-test.store`.

Публичный URL по умолчанию:

```text
https://rag-ocr.ivantereshin-test.store
```

## Почему отдельный compose

`docker-compose.production.yml` удобен для прямого container-run и диагностики, но он может публиковать внутренние сервисы на host-порты. Для demo-сервера нужен другой профиль:

- наружу смотрит только `app`;
- Traefik выдаёт HTTPS;
- Postgres, Redis, Qdrant, MinIO и TEI остаются во внутренней сети;
- ClamAV включается отдельным profile `security`.

Файл: `docker-compose.server.yml`.

## Подготовка env

```bash
cp .env.server.example .env.server
```

Обязательно заменить:

- `APP_SECRET`
- `POSTGRES_PASSWORD`
- `S3_SECRET_ACCESS_KEY`

В server profile MinIO получает root password из `S3_SECRET_ACCESS_KEY`. Это сделано специально:
приложение подключается к MinIO как `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`, поэтому эти
секреты не должны расходиться.

Если нужен OCR для сканов:

```bash
MISTRAL_OCR_API_KEY=...
```

Если нужен antivirus scan:

```bash
UPLOAD_SCAN_ENABLED=true
```

и запускать compose с profile `security`.

## Запуск на сервере

```bash
export PATH="$HOME/.orbstack/bin:$PATH"
docker compose -f docker-compose.server.yml --env-file .env.server up -d --build
```

С antivirus scan:

```bash
export PATH="$HOME/.orbstack/bin:$PATH"
docker compose --profile security -f docker-compose.server.yml --env-file .env.server up -d --build
```

## Проверка

```bash
curl -fsS https://rag-ocr.ivantereshin-test.store/api/health
curl -fsS https://rag-ocr.ivantereshin-test.store/api/health/dependencies | jq
```

## Обновление

```bash
git pull
docker compose -f docker-compose.server.yml --env-file .env.server up -d --build
```

## Rollback

Если новый build не стартует:

```bash
docker compose -f docker-compose.server.yml --env-file .env.server logs --tail=200 app
docker compose -f docker-compose.server.yml --env-file .env.server down
```

Затем вернуть предыдущую git-версию и поднять stack снова.
