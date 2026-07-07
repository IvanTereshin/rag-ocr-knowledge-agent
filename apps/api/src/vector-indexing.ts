import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { createPipelineSteps } from './pipeline.js'
import type { PipelineResult, RankedChunk } from './pipeline.js'
import { createEmbeddingProvider, createQdrantClient } from './rag.js'
import { decryptSecret } from './security.js'
import { validateOutboundServiceUrl } from './outbound-url.js'
import type { DocumentRecord, ProxySettingsRecord, ServiceProvider, ServiceSettingsRecord, StoreData } from './store.js'

const embeddingModel = process.env.EMBEDDING_MODEL?.trim() || 'text-embedding-3-small'
const qdrantCollectionName = process.env.QDRANT_COLLECTION?.trim() || 'rag_ocr_chunks'
const ragRequestTimeoutMs = parsePositiveInteger(process.env.RAG_REQUEST_TIMEOUT_MS, 15_000)
const proxyAgents = new Map<string, ProxyAgent>()

type VectorRuntime = {
  ready: true
  embeddingProvider: ReturnType<typeof createEmbeddingProvider>
  qdrantClient: ReturnType<typeof createQdrantClient>
} | {
  ready: false
  warning: string
}

const defaultVectorServices: ServiceSettingsRecord[] = [
  {
    provider: 'openai',
    enabled: true,
    label: 'OpenAI Responses API',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    validation: { status: 'unchecked', message: 'Not checked yet' },
  },
  {
    provider: 'qdrant',
    enabled: true,
    label: 'Qdrant Vector Store',
    baseUrl: 'http://localhost:6333',
    model: 'hybrid-search',
    validation: { status: 'unchecked', message: 'Not checked yet' },
  },
]

export async function indexPipelineResultInVectorStore(
  data: StoreData,
  userId: string,
  result: PipelineResult,
): Promise<PipelineResult> {
  if (result.document.status !== 'ready' || !result.chunks.length) {
    return result
  }

  const runtime = createVectorRuntime(data, userId)
  if (!runtime.ready) {
    return {
      ...result,
      document: withIndexPipelineMessage(
        result.document,
        `Indexed ${result.chunks.length} chunks locally. Vector index skipped: ${runtime.warning}`,
      ),
    }
  }

  try {
    const vectors = await embedTextsInBatches(runtime.embeddingProvider, result.chunks.map((chunk) => chunk.text))
    await runtime.qdrantClient.upsertDocumentChunks(qdrantCollectionName, result.chunks, vectors)

    return {
      ...result,
      document: withIndexPipelineMessage(
        result.document,
        `Indexed ${result.chunks.length} chunks locally and in Qdrant`,
      ),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Vector index failed'
    return {
      ...result,
      document: withIndexPipelineMessage(
        result.document,
        `Indexed ${result.chunks.length} chunks locally. Vector index failed: ${message}`,
      ),
    }
  }
}

export async function searchVectorCandidatesInVectorStore(
  data: StoreData,
  userId: string,
  question: string,
  limit: number,
): Promise<RankedChunk[]> {
  const runtime = createVectorRuntime(data, userId)
  if (!runtime.ready) {
    throw new Error(runtime.warning)
  }

  const queryVector = await runtime.embeddingProvider.embedText(question)
  return runtime.qdrantClient.searchSimilarChunks(
    qdrantCollectionName,
    queryVector,
    limit,
    userId,
  )
}

function createVectorRuntime(data: StoreData, userId: string): VectorRuntime {
  const openaiService = getServiceForProvider(data, userId, 'openai')
  const qdrantService = getServiceForProvider(data, userId, 'qdrant')

  if (!openaiService?.enabled) {
    return { ready: false, warning: 'OpenAI embeddings service is disabled' }
  }

  if (!qdrantService?.enabled) {
    return { ready: false, warning: 'Qdrant vector store is disabled' }
  }

  let openaiApiKey: string | undefined
  let qdrantApiKey: string | undefined
  try {
    openaiApiKey = getServiceSecret(openaiService)
    qdrantApiKey = getServiceSecret(qdrantService)
  } catch {
    return { ready: false, warning: 'Stored vector service key could not be decrypted' }
  }

  if (!openaiApiKey) {
    return { ready: false, warning: 'OpenAI API key is missing for embeddings' }
  }

  try {
    new URL(openaiService.baseUrl)
    new URL(qdrantService.baseUrl)
  } catch {
    return { ready: false, warning: 'Vector service Base URL is invalid' }
  }

  const openaiOutboundError = validateOutboundServiceUrl(openaiService.provider, openaiService.baseUrl)
  if (openaiOutboundError) {
    return { ready: false, warning: openaiOutboundError }
  }

  const qdrantOutboundError = validateOutboundServiceUrl(qdrantService.provider, qdrantService.baseUrl)
  if (qdrantOutboundError) {
    return { ready: false, warning: qdrantOutboundError }
  }

  const sharedProxy = getSharedProxyUrl(getProxySettings(data, userId))
  if (sharedProxy.error) {
    return { ready: false, warning: sharedProxy.error }
  }

  return {
    ready: true,
    embeddingProvider: createEmbeddingProvider({
      baseUrl: openaiService.baseUrl,
      model: embeddingModel,
      apiKey: openaiApiKey,
      timeoutMs: ragRequestTimeoutMs,
      fetch: fetchWithOptionalProxy(sharedProxy.url),
    }),
    qdrantClient: createQdrantClient({
      baseUrl: qdrantService.baseUrl,
      apiKey: qdrantApiKey,
      timeoutMs: ragRequestTimeoutMs,
    }),
  }
}

async function embedTextsInBatches(
  embeddingProvider: ReturnType<typeof createEmbeddingProvider>,
  texts: string[],
) {
  const batchSize = 16
  const vectors: number[][] = []

  for (let index = 0; index < texts.length; index += batchSize) {
    vectors.push(...await embeddingProvider.embedTexts(texts.slice(index, index + batchSize)))
  }

  return vectors
}

function getServiceForProvider(data: StoreData, userId: string, provider: ServiceProvider) {
  const existing = data.settingsByUserId[userId] ?? []
  const fallback = defaultVectorServices.find((service) => service.provider === provider)
  const service = existing.find((item) => item.provider === provider)

  return fallback ? { ...fallback, ...service } : service
}

function getServiceSecret(service: ServiceSettingsRecord) {
  if (!service.secret) {
    return undefined
  }

  return decryptSecret(service.secret)
}

function getProxySettings(data: StoreData, userId: string): ProxySettingsRecord {
  const existing = data.proxyByUserId[userId]
  if (existing) {
    return existing
  }

  const legacyProxySecret = data.settingsByUserId[userId]?.find((service) => service.proxySecret)?.proxySecret
  if (legacyProxySecret) {
    return { secret: legacyProxySecret }
  }

  return {}
}

function getSharedProxyUrl(proxy: ProxySettingsRecord) {
  if (!proxy.secret) {
    return { url: undefined }
  }

  let proxyUrl: string
  try {
    proxyUrl = decryptSecret(proxy.secret)
  } catch {
    return { error: 'Stored proxy URL could not be decrypted' }
  }

  try {
    new URL(proxyUrl)
  } catch {
    return { error: 'Proxy URL is invalid' }
  }

  return { url: proxyUrl }
}

function fetchWithOptionalProxy(proxyUrl?: string) {
  return (url: string, init: RequestInit) =>
    undiciFetch(url, {
      ...init,
      ...(proxyUrl ? { dispatcher: proxyAgentFor(proxyUrl) } : {}),
    } as Parameters<typeof undiciFetch>[1]) as Promise<Response>
}

function proxyAgentFor(proxyUrl: string) {
  const existingAgent = proxyAgents.get(proxyUrl)
  if (existingAgent) {
    return existingAgent
  }

  const nextAgent = new ProxyAgent(proxyUrl)
  proxyAgents.set(proxyUrl, nextAgent)
  return nextAgent
}

function withIndexPipelineMessage(document: DocumentRecord, message: string): DocumentRecord {
  const pipeline = document.pipeline?.length ? document.pipeline : createPipelineSteps()

  return {
    ...document,
    pipeline: pipeline.map((step) =>
      step.id === 'index'
        ? { ...step, message }
        : step,
    ),
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
