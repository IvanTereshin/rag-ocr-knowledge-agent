# Repository Guidelines

## Project Structure & Module Organization

This is a small monorepo for a portfolio RAG/OCR knowledge agent.

- `apps/web` - React + Vite frontend, UI state, uploads, settings, and question flows.
- `apps/api` - Fastify API, auth, settings storage, document parsing, reranker calls, and static web serving.
- `docs/design` - portfolio visual assets.
- `infra` - deployment-related configuration.
- Root docs (`README.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`) explain the product, architecture, and roadmap.

Do not commit generated data: `uploads/`, `storage/`, `data/`, model caches, local vector DB files, `node_modules/`, `dist/`, `.env`, or `.playwright-mcp/`.

## Build, Test, and Development Commands

Run commands from the repository root:

```bash
npm run dev        # start the Vite frontend locally
npm run build      # build web and api
npm run build:web  # build only apps/web
npm run build:api  # build only apps/api
npm run lint       # run frontend linting
```

Install dependencies inside `apps/web` and `apps/api` with `npm ci` before building if dependencies are missing.

## Coding Style & Naming Conventions

Use TypeScript, 2-space indentation, and explicit types for shared API payloads. Keep provider-specific code behind small helpers such as reranker URL builders, validation functions, and pipeline utilities.

Use clear names for domain concepts: `DocumentRecord`, `DocumentChunkRecord`, `ServiceSettingsRecord`, `RerankerProvider`, and `AgentMode`. Keep UI copy bilingual where the existing screen already supports Russian and English.

## Testing Guidelines

There is no full test suite yet. Before publishing or deploying changes, run:

```bash
npm run build
```

For API behavior, use smoke tests that cover registration, settings save/validation, document upload, and `/api/ask`. Add future tests as `*.test.ts` near the code they cover.

## Commit & Pull Request Guidelines

This repository starts with a clean public history. Use concise Conventional Commits, for example:

```bash
feat: add local tei reranker
docs: update deployment notes
```

Pull requests should include a short summary, changed areas, validation steps, and screenshots for UI changes. Link roadmap items from `IMPLEMENTATION_PLAN.md` when relevant.

## Security & Configuration Tips

Keep secrets only in local `.env` files or encrypted app storage. `.env.example` must contain placeholders only. The Облачный mode may send content to external APIs; the Локальный mode should prefer local services such as TEI.
