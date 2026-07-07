import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertAppSecretIsSafe } from './security.js'
import { createPipelineSteps, processDocument } from './pipeline.js'
import { createSourceObjectStorageFromEnv } from './object-storage.js'
import { createDocumentProcessingWorker } from './queue.js'
import { createStoreFromEnv } from './store.js'
import { indexPipelineResultInVectorStore } from './vector-indexing.js'
import type { DocumentProcessingJobPayload } from './job-types.js'
import type { DocumentRecord, StoreData } from './store.js'

const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
const textRoot = join(dataDir, 'extracted-text')
const pipelineVersion = process.env.DOCUMENT_PIPELINE_VERSION?.trim() || '1'
const redisUrl = process.env.REDIS_URL?.trim()
const workerConcurrency = parsePositiveInteger(process.env.WORKER_CONCURRENCY, 2)
const workerJobAttempts = parsePositiveInteger(process.env.WORKER_JOB_ATTEMPTS, 5)
const workerJobBackoffMs = parsePositiveInteger(process.env.WORKER_JOB_BACKOFF_MS, 5000)

const store = createStoreFromEnv()
const sourceStorage = createSourceObjectStorageFromEnv(dataDir)

async function processJob(payload: DocumentProcessingJobPayload, jobId: string) {
  const data = await store.read()
  const document = findDocument(data, payload.userId, payload.documentId)

  if (!document) {
    throw new Error(`Document ${payload.documentId} was not found`)
  }

  const processingDocument: DocumentRecord = {
    ...document,
    status: 'processing',
    jobId,
    pipeline: createPipelineSteps(),
    error: undefined,
    processingStartedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await updateDocument(payload.userId, payload.documentId, () => processingDocument)

  try {
    await restoreSourceFromObjectStorage(payload, processingDocument)
    const processedResult = await processDocument(processingDocument, textRoot)
    const settingsData = await store.read()
    const result = await indexPipelineResultInVectorStore(settingsData, payload.userId, processedResult)
    const completedDocument: DocumentRecord = {
      ...result.document,
      jobId,
      storageKey: document.storageKey ?? payload.sourceKey,
      pipelineVersion,
      processedAt: result.document.status === 'ready' ? new Date().toISOString() : document.processedAt,
    }

    const freshData = await store.read()
    const documents = freshData.documentsByUserId[payload.userId] ?? []
    await store.write({
      ...freshData,
      documentsByUserId: {
        ...freshData.documentsByUserId,
        [payload.userId]: documents.map((item) =>
          item.id === payload.documentId ? completedDocument : item,
        ),
      },
      chunksByDocumentId: {
        ...freshData.chunksByDocumentId,
        [payload.documentId]: result.chunks,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document worker failed'
    await updateDocument(payload.userId, payload.documentId, (current) => ({
      ...current,
      status: 'failed',
      error: message,
      updatedAt: new Date().toISOString(),
    }))
    throw error
  }
}

async function restoreSourceFromObjectStorage(
  payload: DocumentProcessingJobPayload,
  document: DocumentRecord,
) {
  if (!payload.sourceKey) {
    return
  }

  const bytes = await sourceStorage.get(payload.sourceKey)
  if (!bytes) {
    return
  }

  mkdirSync(dirname(document.storagePath), { recursive: true })
  writeFileSync(document.storagePath, bytes)
}

function findDocument(data: StoreData, userId: string, documentId: string) {
  return (data.documentsByUserId[userId] ?? []).find((document) => document.id === documentId)
}

async function updateDocument(
  userId: string,
  documentId: string,
  update: (document: DocumentRecord) => DocumentRecord,
) {
  const data = await store.read()
  const documents = data.documentsByUserId[userId] ?? []
  await store.write({
    ...data,
    documentsByUserId: {
      ...data.documentsByUserId,
      [userId]: documents.map((document) =>
        document.id === documentId ? update(document) : document,
      ),
    },
  })
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function main() {
  assertAppSecretIsSafe()

  if (!redisUrl) {
    throw new Error('REDIS_URL is required to start the document worker')
  }

  const worker = createDocumentProcessingWorker({
    redisUrl,
    concurrency: workerConcurrency,
    attempts: workerJobAttempts,
    backoffMs: workerJobBackoffMs,
    processor: processJob,
  })

  const shutdown = async () => {
    await worker.close()
    await sourceStorage.close?.()
    await store.close()
  }

  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0))
  })
  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0))
  })

  console.log(`Document worker started with concurrency=${workerConcurrency}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
