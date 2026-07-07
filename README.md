# RAG OCR Knowledge Agent

AI-агент для ответов по базе знаний компании. База знаний создается из файлов разных форматов: `PDF`, `PPTX`, `DOC/DOCX`, `TXT`, `CSV`, `XLS/XLSX`, а также из сканов и изображений через OCR.

Главная идея проекта: реализовать **два RAG/OCR-режима в одном продукте** и дать возможность переключаться между ними.

## Режимы

### 1. Облачный (`portfolio-top`)

Топовый стек для портфолио и демонстрации production-подхода.

```text
Docling / Unstructured
Mistral OCR 4
Qdrant
Cohere Rerank или BGE Reranker
OpenAI Responses API
```

Плюсы:

- сильный OCR;
- хорошая работа с таблицами и layout;
- гибридный поиск;
- reranking;
- красивые ответы с источниками.

Минусы:

- нужны внешние API;
- есть стоимость запросов;
- нужен аккуратный учет лимитов.

### 2. Локальный (`local-self-host`)

Локальный self-host стек без зависимости от внешних AI API.

```text
Docling
PaddleOCR или Tesseract
Qdrant local или pgvector
BAAI/bge-m3 embeddings
BAAI/bge-reranker-base
Ollama или vLLM
```

Плюсы:

- можно запускать локально;
- лучше для приватных документов;
- нет зависимости от внешних провайдеров.

Минусы:

- качество зависит от железа;
- сложнее деплой;
- ответы могут быть слабее, чем у cloud LLM.

## Переключение режимов

Режим выбирается через переменную окружения:

```bash
RAG_PROFILE=portfolio-top
```

или:

```bash
RAG_PROFILE=local-self-host
```

Внутри кода это должно быть не два разных приложения, а один интерфейс с разными адаптерами:

- `DocumentParser`
- `OcrProvider`
- `EmbeddingProvider`
- `VectorStore`
- `Reranker`
- `AnswerGenerator`

## Главные возможности MVP

- Загрузка документов разных форматов.
- OCR для сканов и изображений.
- Разбор PDF, DOCX, PPTX, XLSX, TXT.
- Индексация документов в базу знаний.
- Вопросы по документам.
- Ответы с источниками: файл, страница, слайд, лист Excel, таблица.
- Переключение между облачным и локальным режимом.
- Панель сравнения качества ответов между двумя режимами.

## Файлы

- `IMPLEMENTATION_PLAN.md` - подробный план разработки.
- `ARCHITECTURE.md` - архитектура двух режимов и переключения.
- `ASSET_PROMPTS.md` - промпты для генерации картинок и мокапов.
- `.gitignore` - базовый ignore для будущей разработки.

## Текущая демо-версия

Текущая реализация - full-stack демо для портфолио и показа клиентам. Frontend остаётся на моковых документах, но регистрация, вход, сессии и настройки API уже работают через backend.

```bash
npm --prefix apps/web install
npm --prefix apps/api install
npm run build
```

Что уже заложено:

- обычный web-интерфейс на React + Vite + TypeScript;
- backend на Fastify;
- регистрация и вход по HTTP-only cookie;
- серверное хранение пользователей, сессий и настроек в `DATA_DIR`;
- шифрование API-ключей через `APP_SECRET`;
- страница настроек для OpenAI, Mistral OCR, Qdrant и выбора reranker: Cohere, Voyage AI, Jina AI или Local TEI;
- переключение языка `RU / EN`;
- моковые документы, статусы OCR/RAG pipeline и ответы с источниками;
- активный режим `Облачный` (`portfolio-top`);
- блок `Локальный` (`local-self-host`) как второй этап.

Для production-контейнера нужен стабильный секрет:

```bash
APP_SECRET=replace-with-random-64-char-secret
```

Если поменять `APP_SECRET`, старые сохранённые API-ключи нельзя будет расшифровать.
