# Production evals

Production RAG нельзя принимать только по ручному чату. Нужен небольшой набор проверок, который показывает, что retrieval находит правильные источники, а citations не потеряли metadata.

## Быстрый eval

После сборки:

```bash
npm run build
npm run test:eval:retrieval
```

Скрипт `scripts/eval-retrieval.mjs` не запускает API-сервер. Он напрямую использует compiled pipeline:

```text
temporary document
  -> processDocument
  -> chunks with source metadata
  -> selectAnswerCandidates
  -> JSON report
```

Проверяется:

- найден ли ожидаемый документ;
- найден ли ожидаемый фрагмент текста;
- есть ли citation metadata (`source.fileName`, строки/страница/слайд/лист, если формат это даёт).

## Production gate

Минимальный gate перед деплоем:

```text
retrievalHitRate >= 0.90
failed == 0 for smoke fixtures
all answers in smoke tests include citations
```

Для клиентского production добавьте отдельный закрытый eval-pack:

- 20-30 вопросов;
- ожидаемый документ;
- ожидаемая страница/слайд/лист;
- ожидаемая короткая фраза;
- флаг, можно ли отвечать без источника.

## Что добавить дальше

- Golden dataset в `docs/evals/`.
- Проверку answer faithfulness через LLM-judge.
- Сравнение `cloud` и `local` режимов по latency/cost/hit-rate.
- Отчёт в CI artifact.
