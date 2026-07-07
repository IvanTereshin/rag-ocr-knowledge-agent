import type { DocumentChunkRecord } from './store.js'

const defaultRequestTimeoutMs = 10_000

type JsonRecord = Record<string, unknown>
type HeadersRecord = Record<string, string>
type FetchFunction = (url: string, init: RequestInit) => Promise<Response>

type RequestInitLike = Omit<RequestInit, 'body' | 'headers'> & {
  body?: string
  headers?: HeadersRecord
}

type OpenAIEmbeddingResponse = {
  data?: Array<{
    index?: number
    embedding?: unknown
  }>
  usage?: {
    prompt_tokens?: number
    total_tokens?: number
  }
}

type QdrantCollectionResponse = {
  result?: {
    config?: {
      params?: {
        vectors?: unknown
      }
    }
  }
}

type QdrantSearchResponse = {
  result?: Array<{
    id?: string | number
    score?: number
    payload?: unknown
    vector?: unknown
  }>
}

export type EmbeddingProviderConfig = {
  baseUrl: string
  model: string
  apiKey?: string
  headers?: HeadersRecord
  timeoutMs?: number
  dimensions?: number
  user?: string
  fetch?: FetchFunction
}

export type QdrantClientConfig = {
  baseUrl: string
  apiKey?: string
  headers?: HeadersRecord
  timeoutMs?: number
  fetch?: FetchFunction
}

export type QdrantPointPayload = DocumentChunkRecord

export type RankedDocumentChunkRecord = DocumentChunkRecord & {
  score: number
}

export type EmbeddingProvider = {
  embedText(input: string): Promise<number[]>
  embedTexts(inputs: string[]): Promise<number[][]>
}

export type QdrantClient = {
  ensureCollection(collectionName: string, vectorSize: number): Promise<void>
  upsertDocumentChunks(
    collectionName: string,
    chunks: readonly DocumentChunkRecord[],
    vectors: readonly number[][],
  ): Promise<void>
  searchSimilarChunks(
    collectionName: string,
    vector: readonly number[],
    limit: number,
    userId: string,
  ): Promise<RankedDocumentChunkRecord[]>
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  return {
    embedText(input: string) {
      return embedText(config, input)
    },
    embedTexts(inputs: string[]) {
      return embedTexts(config, inputs)
    },
  }
}

export function createQdrantClient(config: QdrantClientConfig): QdrantClient {
  return {
    ensureCollection(collectionName: string, vectorSize: number) {
      return ensureCollection(config, collectionName, vectorSize)
    },
    upsertDocumentChunks(
      collectionName: string,
      chunks: readonly DocumentChunkRecord[],
      vectors: readonly number[][],
    ) {
      return upsertDocumentChunks(config, collectionName, chunks, vectors)
    },
    searchSimilarChunks(
      collectionName: string,
      vector: readonly number[],
      limit: number,
      userId: string,
    ) {
      return searchSimilarChunks(config, collectionName, vector, limit, userId)
    },
  }
}

export async function embedText(config: EmbeddingProviderConfig, input: string): Promise<number[]> {
  const vectors = await embedTexts(config, [input])
  const vector = vectors[0]

  if (!vector) {
    throw new Error('Embedding provider did not return a vector')
  }

  return vector
}

export async function embedTexts(config: EmbeddingProviderConfig, inputs: string[]): Promise<number[][]> {
  if (!inputs.length) {
    return []
  }

  return requestEmbeddings(config, inputs)
}

export async function ensureCollection(
  config: QdrantClientConfig,
  collectionName: string,
  vectorSize: number,
): Promise<void> {
  const normalizedCollectionName = normalizeCollectionName(collectionName)
  if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
    throw new Error('Vector size must be a positive integer')
  }

  const response = await requestJson(qdrantCollectionUrl(config.baseUrl, normalizedCollectionName), {
    method: 'GET',
    headers: qdrantHeaders(config.apiKey, config.headers),
  }, config.timeoutMs, config.fetch)

  if (response.ok) {
    const payload = (await readJsonResponse(response)) as QdrantCollectionResponse
    const existingVectorSize = readCollectionVectorSize(payload)

    if (existingVectorSize === null) {
      throw new Error(`Qdrant collection "${normalizedCollectionName}" exists, but vector size could not be read`)
    }

    if (existingVectorSize !== vectorSize) {
      throw new Error(
        `Qdrant collection "${normalizedCollectionName}" already exists with vector size ${existingVectorSize}, expected ${vectorSize}`,
      )
    }

    return
  }

  if (response.status !== 404) {
    const payload = await readJsonResponse(response)
    throw new Error(providerErrorMessage('Qdrant', response, payload))
  }

  const createResponse = await requestJson(qdrantCollectionUrl(config.baseUrl, normalizedCollectionName), {
    method: 'PUT',
    headers: qdrantHeaders(config.apiKey, config.headers),
    body: JSON.stringify({
      vectors: {
        size: vectorSize,
        distance: 'Cosine',
      },
    }),
  }, config.timeoutMs, config.fetch)

  if (!createResponse.ok) {
    const payload = await readJsonResponse(createResponse)
    throw new Error(providerErrorMessage('Qdrant', createResponse, payload))
  }
}

export async function upsertDocumentChunks(
  config: QdrantClientConfig,
  collectionName: string,
  chunks: readonly DocumentChunkRecord[],
  vectors: readonly number[][],
): Promise<void> {
  const normalizedCollectionName = normalizeCollectionName(collectionName)

  if (chunks.length !== vectors.length) {
    throw new Error(`Chunk count (${chunks.length}) must match vector count (${vectors.length})`)
  }

  if (!chunks.length) {
    return
  }

  const vectorSize = vectors[0]?.length ?? 0
  if (!vectorSize) {
    throw new Error('Vectors must not be empty')
  }

  await ensureCollection(config, normalizedCollectionName, vectorSize)

  const points = chunks.map((chunk, index) => ({
    id: chunk.id,
    vector: vectors[index] ?? [],
    payload: chunk as QdrantPointPayload,
  }))

  const response = await requestJson(qdrantPointsUrl(config.baseUrl, normalizedCollectionName), {
    method: 'PUT',
    headers: qdrantHeaders(config.apiKey, config.headers),
    body: JSON.stringify({
      points,
    }),
  }, config.timeoutMs, config.fetch)

  if (!response.ok) {
    const payload = await readJsonResponse(response)
    throw new Error(providerErrorMessage('Qdrant', response, payload))
  }
}

export async function searchSimilarChunks(
  config: QdrantClientConfig,
  collectionName: string,
  vector: readonly number[],
  limit: number,
  userId: string,
): Promise<RankedDocumentChunkRecord[]> {
  const normalizedCollectionName = normalizeCollectionName(collectionName)

  if (!vector.length) {
    return []
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Search limit must be a positive integer')
  }

  const response = await requestJson(qdrantSearchUrl(config.baseUrl, normalizedCollectionName), {
    method: 'POST',
    headers: qdrantHeaders(config.apiKey, config.headers),
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      with_vector: false,
      filter: userId
        ? {
            must: [
              {
                key: 'userId',
                match: { value: userId },
              },
            ],
          }
        : undefined,
    }),
  }, config.timeoutMs, config.fetch)

  const payload = (await readJsonResponse(response)) as QdrantSearchResponse
  if (!response.ok) {
    throw new Error(providerErrorMessage('Qdrant', response, payload))
  }

  const rows = Array.isArray(payload.result) ? payload.result : []
  return rows.flatMap((row): RankedDocumentChunkRecord[] => {
    const chunk = row.payload && isDocumentChunkPayload(row.payload) ? row.payload : null
    if (!chunk) {
      return []
    }

    return [
      {
        ...chunk,
        score: typeof row.score === 'number' ? row.score : 0,
      },
    ]
  })
}

async function requestEmbeddings(config: EmbeddingProviderConfig, inputs: string[]): Promise<number[][]> {
  if (!inputs.length) {
    return []
  }

  const response = await requestJson(openAiEmbeddingsUrl(config.baseUrl), {
    method: 'POST',
    headers: jsonHeaders(config.apiKey, config.headers),
    body: JSON.stringify({
      model: config.model,
      input: inputs.length === 1 ? inputs[0] : inputs,
      ...(config.dimensions ? { dimensions: config.dimensions } : {}),
      ...(config.user ? { user: config.user } : {}),
    }),
  }, config.timeoutMs, config.fetch)

  const payload = (await readJsonResponse(response)) as OpenAIEmbeddingResponse
  if (!response.ok) {
    throw new Error(providerErrorMessage('Embedding provider', response, payload))
  }

  return parseEmbeddingVectors(payload)
}

async function requestJson(
  url: string,
  init: RequestInitLike,
  timeoutMs = defaultRequestTimeoutMs,
  fetchFunction: FetchFunction = fetch,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const requestInit: RequestInit = {
    ...init,
    signal: controller.signal,
  }

  try {
    return await fetchFunction(url, requestInit)
  } finally {
    clearTimeout(timer)
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function parseEmbeddingVectors(payload: OpenAIEmbeddingResponse): number[][] {
  const rows = Array.isArray(payload.data) ? payload.data : []
  if (!rows.length) {
    throw new Error('Embedding provider returned no vectors')
  }

  return rows
    .slice()
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((row) => parseVector(row.embedding))
}

function parseVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error('Embedding provider returned an invalid vector')
  }

  const vector = value.map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new Error('Embedding provider returned an invalid vector value')
    }

    return item
  })

  if (!vector.length) {
    throw new Error('Embedding provider returned an empty vector')
  }

  return vector
}

function readCollectionVectorSize(payload: QdrantCollectionResponse): number | null {
  const vectors = payload.result?.config?.params?.vectors
  if (!vectors || typeof vectors !== 'object') {
    return null
  }

  const typedVectors = vectors as JsonRecord
  if (typeof typedVectors.size === 'number') {
    return typedVectors.size
  }

  for (const value of Object.values(typedVectors)) {
    if (value && typeof value === 'object') {
      const nested = value as JsonRecord
      if (typeof nested.size === 'number') {
        return nested.size
      }
    }
  }

  return null
}

function isDocumentChunkPayload(value: unknown): value is DocumentChunkRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as JsonRecord
  return (
    typeof record.id === 'string' &&
    typeof record.userId === 'string' &&
    typeof record.documentId === 'string' &&
    typeof record.documentName === 'string' &&
    typeof record.index === 'number' &&
    typeof record.text === 'string' &&
    typeof record.tokenEstimate === 'number' &&
    typeof record.createdAt === 'string'
  )
}

function normalizeCollectionName(collectionName: string): string {
  const normalized = collectionName.trim()
  if (!normalized) {
    throw new Error('Collection name is required')
  }

  return normalized
}

function openAiEmbeddingsUrl(baseUrl: string): string {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl.trim())
  const parsed = new URL(normalizedBaseUrl)
  const normalizedPath = trimTrailingSlash(parsed.pathname)

  if (normalizedPath.endsWith('/embeddings')) {
    return normalizedBaseUrl
  }

  if (/\/v\d+$/.test(normalizedPath)) {
    return joinUrl(normalizedBaseUrl, '/embeddings')
  }

  return joinUrl(normalizedBaseUrl, '/v1/embeddings')
}

function qdrantCollectionUrl(baseUrl: string, collectionName: string): string {
  return joinUrl(trimTrailingSlash(baseUrl.trim()), `/collections/${encodeURIComponent(collectionName)}`)
}

function qdrantPointsUrl(baseUrl: string, collectionName: string): string {
  return joinUrl(qdrantCollectionUrl(baseUrl, collectionName), '/points?wait=true')
}

function qdrantSearchUrl(baseUrl: string, collectionName: string): string {
  return joinUrl(qdrantCollectionUrl(baseUrl, collectionName), '/points/search')
}

function jsonHeaders(apiKey?: string, extraHeaders?: HeadersRecord): HeadersRecord {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}`, 'api-key': apiKey } : {}),
    ...extraHeaders,
  }
}

function qdrantHeaders(apiKey?: string, extraHeaders?: HeadersRecord): HeadersRecord {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { 'api-key': apiKey } : {}),
    ...extraHeaders,
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBaseUrl}${normalizedPath}`
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function providerErrorMessage(providerName: string, response: Response, payload: unknown): string {
  const details = extractErrorMessage(payload)
  const suffix = details ? `: ${details}` : ''
  return `${providerName} returned HTTP ${response.status}${suffix}`
}

function extractErrorMessage(payload: unknown): string {
  if (typeof payload === 'string') {
    return compactMessage(payload)
  }

  if (Array.isArray(payload)) {
    return compactMessage(payload.map(extractErrorMessage).filter(Boolean).join('; '))
  }

  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const record = payload as JsonRecord
  const direct = record.message ?? record.error_description ?? record.detail
  if (direct) {
    return extractErrorMessage(direct)
  }

  const error = record.error
  if (error) {
    return extractErrorMessage(error)
  }

  const errors = record.errors
  if (errors) {
    return extractErrorMessage(errors)
  }

  return ''
}

function compactMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, 220)
}
