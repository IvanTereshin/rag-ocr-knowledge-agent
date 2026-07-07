# Архитектура: два RAG/OCR-режима

## 1. Общая схема

```text
User uploads files
        |
        v
File Storage
        |
        v
Document Ingestion Pipeline
        |
        +--> File type detection
        +--> Parser selection
        +--> OCR if needed
        +--> Layout/table extraction
        +--> Chunking
        +--> Embeddings
        +--> Vector index
        |
        v
Question Answering Pipeline
        |
        +--> Query normalization
        +--> Hybrid search
        +--> Reranking
        +--> Context packing
        +--> Answer generation
        +--> Citations
```

## 2. Важный принцип

Приложение должно иметь один общий бизнес-код, а разные технологии подключаются через адаптеры.

Плохо:

```text
if portfolio mode:
  run one codebase
else:
  run another codebase
```

Хорошо:

```text
parser = providerFactory.createDocumentParser(profile)
ocr = providerFactory.createOcrProvider(profile)
embedder = providerFactory.createEmbeddingProvider(profile)
store = providerFactory.createVectorStore(profile)
reranker = providerFactory.createReranker(profile)
generator = providerFactory.createAnswerGenerator(profile)
```

Так проще тестировать, сравнивать качество и развивать проект.

## 3. Профиль Облачный (`portfolio-top`)

### Назначение

Показать максимально сильную версию для портфолио: качественный OCR, гибридный поиск, reranker и ответы с источниками.

### Компоненты

| Слой | Технология |
|---|---|
| Document parsing | Docling или Unstructured |
| OCR | Mistral OCR 4 |
| Vector DB | Qdrant |
| Embeddings | OpenAI embeddings или Voyage/Cohere embeddings |
| Keyword/sparse search | Qdrant sparse vectors или отдельный BM25 |
| Reranker | Cohere, Voyage AI, Jina AI или BGE Reranker |
| Answer generator | OpenAI Responses API |

### Поток индексации

```text
Upload
→ Detect type
→ Parse native structure
→ If scanned or low text density: OCR
→ Convert to normalized Markdown + JSON blocks
→ Create layout-aware chunks
→ Generate embeddings
→ Save chunks to Qdrant
```

### Поток ответа

```text
Question
→ Rewrite/search query
→ Dense vector search
→ Sparse/keyword search
→ Merge results
→ Rerank top 30
→ Build context from top 5-8 chunks
→ Generate answer
→ Return answer with citations
```

## 4. Профиль `local-self-host`

### Назначение

Дать полностью локальный вариант для приватных документов и демонстрации self-host подхода.

### Компоненты

| Слой | Технология |
|---|---|
| Document parsing | Docling |
| OCR | PaddleOCR, fallback Tesseract |
| Vector DB | Qdrant local или pgvector |
| Embeddings | `BAAI/bge-m3` или `intfloat/multilingual-e5-large` |
| Reranker | `BAAI/bge-reranker-base` |
| Answer generator | Ollama или vLLM |

### Рекомендуемые локальные модели

Для embeddings:

- `BAAI/bge-m3` - хороший multilingual-вариант.
- `intfloat/multilingual-e5-large` - понятный базовый вариант.

Для reranking:

- `BAAI/bge-reranker-base`.

Для генерации:

- `qwen2.5:14b` через Ollama, если нужен баланс качества и скорости.
- `llama3.1:8b` для слабого железа.
- `qwen2.5:32b` или похожая модель, если есть сильная GPU.

## 5. Общий формат чанка

Каждый кусок текста должен хранить не только текст, но и метаданные.

```json
{
  "chunk_id": "doc_123_page_5_block_2",
  "document_id": "doc_123",
  "text": "Фрагмент текста...",
  "source": {
    "file_name": "policy.pdf",
    "file_type": "pdf",
    "page": 5,
    "slide": null,
    "sheet": null,
    "table": null,
    "row_range": null
  },
  "layout": {
    "block_type": "paragraph",
    "bbox": [120, 300, 820, 410]
  },
  "tokens": 420
}
```

## 6. Типы документов

| Формат | Как обрабатывать |
|---|---|
| PDF text | Парсить текст и layout |
| PDF scan | OCR + layout blocks |
| DOC/DOCX | Читать структуру документа |
| PPT/PPTX | Слайды как отдельные блоки |
| TXT/MD | Чистый текст |
| CSV | Таблица, строки и заголовки |
| XLS/XLSX | Листы, таблицы, строки, формулы как metadata |
| Images | OCR |

## 7. Метрики качества

Нужно сравнивать два режима не на ощущениях, а по простым метрикам.

- Retrieval hit rate: нашел ли нужный документ.
- Citation accuracy: правильная ли ссылка на источник.
- Answer faithfulness: не придумал ли ответ.
- Latency: время ответа.
- Cost: стоимость ответа.
- Local resources: RAM/CPU/GPU usage для self-host.

## 8. UI-переключатель

В интерфейсе должен быть переключатель:

```text
Mode: Облачный | Локальный
```

Дополнительно полезен экран сравнения:

```text
Question
        |
        +--> Облачный answer
        +--> Локальный answer
        |
        v
Compare citations, latency, confidence
```

Это сильная портфолио-фича: видно не только приложение, но и инженерное сравнение двух подходов.
