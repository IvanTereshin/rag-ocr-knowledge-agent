# Production Security Checklist

Этот чеклист связывает текущие production-риски с конкретными файлами. Его задача - дать понятный порядок работ перед реальным запуском для клиентов.

Важно: это первый security hardening slice, а не весь production. Здесь собраны только самые критичные вещи, которые нужно закрыть в P0 перед следующим шагом.

## P0

### 1. Добавить CSRF-защиту для cookie auth

Риск: авторизация работает через HTTP-only cookie, а write endpoints сейчас доверяют cookie без дополнительной проверки.

Где внедрять:

- `apps/api/src/server.ts`
- `apps/web/src/api.ts`

Что сделать:

- Требовать CSRF token или строгую same-origin проверку на `POST`, `PUT`, `DELETE`.
- Согласовать `SameSite` cookie с моделью деплоя.
- Если frontend и API будут на разных origin, не полагаться только на cookie.

### 2. Явно задать Origin/CORS policy

Риск: при раздельном frontend и API можно случайно открыть лишние origin и ослабить защиту state-changing routes.

Где внедрять:

- `apps/api/src/server.ts`
- `apps/web/src/api.ts`

Что сделать:

- Завести allowlist доверенных frontend origin.
- Отклонять неожиданные `Origin` и `Referer` на state-changing routes.
- По возможности оставить same-origin deployment дефолтом.

### 3. Проверять загружаемые файлы на сервере

Риск: UI фильтрует типы файлов, но API должен сам отбрасывать опасные или неподдерживаемые файлы.

Где внедрять:

- `apps/api/src/server.ts`
- `apps/api/src/pipeline.ts`

Что сделать:

- Добавить allowlist по MIME type и extension.
- Отклонять неподдерживаемые файлы до записи в storage.
- Проверять реальный тип файла, а не только имя или заголовок от браузера.
- Вынести лимиты размера и количества файлов в env.

### 4. Разделить rate limits по маршрутам

Риск: одного общего лимита мало для login, upload, settings и ask endpoints.

Где внедрять:

- `apps/api/src/server.ts`

Что сделать:

- Поставить более строгие лимиты на auth и upload.
- Отдельно ограничить дорогие `ask` и rerank вызовы.
- Читать значения из env.

### 5. Убрать слабый fallback для `APP_SECRET` в production

Риск: `APP_SECRET` используется для сессий и шифрования API-ключей. В production нельзя запускаться с дефолтным секретом.

Где внедрять:

- `apps/api/src/security.ts`
- `.env.example`
- `.env.production.example`

Что сделать:

- Требовать настоящий секрет в production.
- Завершать запуск с ошибкой, если `APP_SECRET` отсутствует вне local dev.
- Требовать минимум 32 символа; рекомендуемый формат - случайная строка 64+ символа.
- Описать правила rotation и backup, потому что при смене секрета старые ключи не расшифруются.

### 6. Жестко настроить cookie через env

Риск: cookie и session flags должны быть безопасными по умолчанию и не зависеть от случайной локальной конфигурации.

Где внедрять:

- `apps/api/src/server.ts`
- `.env.example`
- `.env.production.example`

Что сделать:

- Описать через env `SameSite`, `Secure`, `HttpOnly`, `Path` и `Domain`, если они нужны для деплоя.
- Держать безопасные значения по умолчанию.
- Пояснить влияние reverse proxy на `secure` cookies.

## P1

### 7. Защитить исходящие URL от SSRF

Статус: базовая защита внедрена через `apps/api/src/outbound-url.ts`.

Риск: пользовательские `baseUrl` и proxy URL могут указывать на внутренние сервисы.

Где внедрять:

- `apps/api/src/server.ts`
- `apps/api/src/pipeline.ts`

Что сделать:

- Проверять outbound URL перед сохранением.
- Блокировать private, loopback и single-label hostnames для cloud/proxy в production.
- Оставить поддержку Local TEI и Qdrant, но сделать это осознанным исключением.
- Если нужен нестандартный private endpoint, явно включать `ALLOW_PRIVATE_OUTBOUND_URLS=true`.
- Дополнить это firewall/egress rules на уровне сервера, потому что app-level проверка не заменяет сетевую политику.

### 8. Почистить production logs

Риск: обычные request logs могут случайно раскрыть cookie, ключи, имена файлов или служебные детали.

Где внедрять:

- `apps/api/src/server.ts`

Что сделать:

- Использовать structured logs с redaction.
- Не логировать secrets, cookies, содержимое файлов и provider keys.
- Добавить request id, чтобы искать ошибки без лишних персональных данных.

### 9. Добавить scan step перед обработкой файлов

Риск: загруженные документы сейчас сразу пишутся и парсятся.

Где внедрять:

- `apps/api/src/server.ts`
- `apps/api/src/pipeline.ts`
- `infra/*` или отдельный scanner helper

Что сделать:

- Добавить quarantine или scan step до text extraction.
- Подключить локальный ClamAV или похожий сервис.
- Блокировать обработку, если scan провален.

## P2

### 10. Добавить security headers

Статус: базовый слой внедрён в `apps/api/src/server.ts`.

Риск: без явной browser security policy браузер разрешает больше возможностей, чем нужно приложению.

Где внедрять:

- `apps/api/src/server.ts`

Что сделать:

- Поддерживать `Content-Security-Policy`, `frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`.
- Проверить совместимость с Vite frontend и static assets.
- Для нестандартного деплоя переопределять `CONTENT_SECURITY_POLICY` через env.

### 11. Сделать session и cookie поведение настраиваемым

Риск: hardcoded cookie/session правила могут не подойти под каждый production deployment.

Где внедрять:

- `apps/api/src/server.ts`
- `.env.example`
- `.env.production.example`

Что сделать:

- Управлять cookie flags через env.
- Описать влияние reverse proxy на `secure` cookies.
- Чистить expired sessions по расписанию, а не только во время запросов.

### 12. Описать storage и backup правила

Риск: uploads, extracted text и state могут расти незаметно и потеряться без backup.

Где внедрять:

- `README.md`
- `docs/*`
- `infra/*`

Что сделать:

- Описать data retention и backup paths.
- Исключить uploads, extracted text и store files из публичных артефактов.
- Зафиксировать, какие volumes должны быть persistent в production.
