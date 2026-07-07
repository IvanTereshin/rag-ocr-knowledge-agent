import fastify from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import type { FastifyRequest } from 'fastify'
import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  createSessionToken,
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashSessionToken,
  maskSecret,
  normalizeEmail,
  verifyPassword,
} from './security.js'
import { answerQuestion, createPipelineSteps, processDocument, readDocumentText, selectAnswerCandidates } from './pipeline.js'
import type { RankedChunk } from './pipeline.js'
import { createStoreFromEnv } from './store.js'
import type {
  DocumentChunkRecord,
  DocumentRecord,
  ProxySettingsRecord,
  ServiceProvider,
  ServiceSettingsRecord,
  ServiceValidationRecord,
  StoreData,
  UserRecord,
} from './store.js'

const cookieName = 'rag_ocr_session'
const sessionTtlMs = 1000 * 60 * 60 * 24 * 7
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
const uploadRoot = join(dataDir, 'uploads')
const textRoot = join(dataDir, 'extracted-text')
const maxUploadBytes = 25 * 1024 * 1024
const validationTimeoutMs = 8000
const maxRerankCandidates = 12
const rerankResultLimit = 3
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 180)
const rateLimitWindow = process.env.RATE_LIMIT_WINDOW ?? '1 minute'
const store = createStoreFromEnv()
const proxyAgents = new Map<string, ProxyAgent>()
const rerankerProviders = ['cohere', 'voyage', 'jina', 'tei'] as const
type RerankerProvider = (typeof rerankerProviders)[number]
type AskEngine = 'local-retrieval' | `${RerankerProvider}-rerank`

type AuthBody = {
  name?: string
  email?: string
  password?: string
}

type ServiceSettingsBody = {
  services?: Array<{
    provider?: ServiceProvider
    enabled?: boolean
    label?: string
    baseUrl?: string
    model?: string
    apiKey?: string
    clearApiKey?: boolean
  }>
  proxy?: {
    proxyUrl?: string
    clearProxy?: boolean
  }
}

type AskBody = {
  question?: string
  mode?: AgentMode
}

type AgentMode = 'cloud' | 'local'

type RerankerServiceSettings = ServiceSettingsRecord & {
  provider: RerankerProvider
}

const defaultServices: ServiceSettingsRecord[] = [
  {
    provider: 'openai',
    enabled: true,
    label: 'OpenAI Responses API',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    validation: { status: 'unchecked', message: 'Not checked yet' },
  },
  {
    provider: 'mistral',
    enabled: true,
    label: 'Mistral OCR',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-ocr-latest',
    validation: { status: 'unchecked', message: 'Not checked yet' },
  },
  {
    provider: 'cohere',
    enabled: false,
    label: 'Cohere Rerank',
    baseUrl: 'https://api.cohere.com/v2',
    model: 'rerank-v3.5',
    validation: { status: 'unchecked', message: 'Not checked yet' },
  },
  {
    provider: 'voyage',
    enabled: false,
    label: 'Voyage AI Rerank',
    baseUrl: 'https://api.voyageai.com/v1',
    model: 'rerank-2.5',
    validation: { status: 'unchecked', message: 'Not checked yet' },
  },
  {
    provider: 'jina',
    enabled: false,
    label: 'Jina AI Reranker',
    baseUrl: 'https://api.jina.ai/v1',
    model: 'jina-reranker-v3',
    validation: { status: 'unchecked', message: 'Not checked yet' },
  },
  {
    provider: 'tei',
    enabled: false,
    label: 'Local TEI Reranker',
    baseUrl: 'http://host.docker.internal:8080',
    model: 'BAAI/bge-reranker-base',
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

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  }
}

function publicService(service: ServiceSettingsRecord) {
  return {
    provider: service.provider,
    enabled: service.enabled,
    label: service.label,
    baseUrl: service.baseUrl,
    model: service.model,
    updatedAt: service.updatedAt,
    validation: service.validation ?? uncheckedValidation(),
    ...maskSecret(service.secret),
  }
}

function publicProxySettings(proxy: ProxySettingsRecord) {
  const maskedProxy = maskSecret(proxy.secret)

  return {
    hasProxy: maskedProxy.hasApiKey,
    proxyLast4: maskedProxy.apiKeyLast4,
    updatedAt: proxy.updatedAt,
  }
}

function publicDocument(document: DocumentRecord) {
  return {
    id: document.id,
    name: document.originalName,
    fileType: document.fileType,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    status: document.status,
    textPreview: document.textPreview ?? '',
    chunkCount: document.chunkCount ?? 0,
    pipeline: document.pipeline ?? createPipelineSteps(),
    error: document.error ?? '',
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}

function publicCitation(chunk: DocumentChunkRecord & { score: number }) {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    documentName: chunk.documentName,
    chunkIndex: chunk.index,
    text: chunk.text,
    score: chunk.score,
  }
}

function uncheckedValidation(message = 'Not checked yet'): ServiceValidationRecord {
  return { status: 'unchecked', message }
}

function serviceValidation(
  status: ServiceValidationRecord['status'],
  message: string,
): ServiceValidationRecord {
  return {
    status,
    message,
    checkedAt: new Date().toISOString(),
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function joinUrl(baseUrl: string, path: string) {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl.trim())
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBaseUrl}${normalizedPath}`
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

type ProxyFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

async function fetchWithTimeout(url: string, init: ProxyFetchInit = {}, proxyUrl?: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), validationTimeoutMs)
  const requestInit = {
    ...init,
    signal: controller.signal,
    ...(proxyUrl ? { dispatcher: proxyAgentFor(proxyUrl) } : {}),
  } as Parameters<typeof undiciFetch>[1]

  try {
    return await undiciFetch(url, requestInit)
  } finally {
    clearTimeout(timeout)
  }
}

async function readResponseText(response: Response) {
  return response.text().catch(() => '')
}

async function providerStatusMessage(response: Response) {
  const details = await readProviderError(response)
  const suffix = details ? `: ${details}` : ''

  if (response.status === 401 || response.status === 498) {
    return `Key was rejected by provider: HTTP ${response.status}${suffix}`
  }

  if (response.status === 403) {
    return `Provider refused access: HTTP ${response.status}${suffix}`
  }

  return `Provider returned HTTP ${response.status}${suffix}`
}

async function readProviderError(response: Response) {
  const text = await response.text().catch(() => '')
  if (!text) {
    return ''
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(text) as unknown
      return compactProviderMessage(providerMessageFromPayload(parsed))
    } catch {
      return compactProviderMessage(text)
    }
  }

  return compactProviderMessage(text.replace(/<[^>]*>/g, ' '))
}

function providerMessageFromPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload
  }

  if (Array.isArray(payload)) {
    return payload.map(providerMessageFromPayload).filter(Boolean).join('; ')
  }

  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const record = payload as Record<string, unknown>
  const direct = record.message ?? record.error_description ?? record.detail
  if (direct) {
    return providerMessageFromPayload(direct)
  }

  const error = record.error
  if (error) {
    return providerMessageFromPayload(error)
  }

  const errors = record.errors
  if (errors) {
    return providerMessageFromPayload(errors)
  }

  return ''
}

function compactProviderMessage(message: string) {
  return message.replace(/\s+/g, ' ').trim().slice(0, 220)
}

function cohereRerankUrl(baseUrl: string) {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl.trim())
  const parsed = new URL(normalizedBaseUrl)
  const normalizedPath = trimTrailingSlash(parsed.pathname)

  if (normalizedPath.endsWith('/rerank')) {
    return normalizedBaseUrl
  }

  if (/\/v\d+$/.test(normalizedPath)) {
    return joinUrl(normalizedBaseUrl, '/rerank')
  }

  return joinUrl(normalizedBaseUrl, '/v2/rerank')
}

function versionedRerankUrl(baseUrl: string, defaultVersion: '/v1' | '/v2') {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl.trim())
  const parsed = new URL(normalizedBaseUrl)
  const normalizedPath = trimTrailingSlash(parsed.pathname)

  if (normalizedPath.endsWith('/rerank')) {
    return normalizedBaseUrl
  }

  if (/\/v\d+$/.test(normalizedPath)) {
    return joinUrl(normalizedBaseUrl, '/rerank')
  }

  return joinUrl(normalizedBaseUrl, `${defaultVersion}/rerank`)
}

function teiRerankUrl(baseUrl: string) {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl.trim())
  const parsed = new URL(normalizedBaseUrl)
  const normalizedPath = trimTrailingSlash(parsed.pathname)

  if (normalizedPath.endsWith('/rerank')) {
    return normalizedBaseUrl
  }

  return joinUrl(normalizedBaseUrl, '/rerank')
}

function isRerankerProvider(provider: ServiceProvider): provider is RerankerProvider {
  return rerankerProviders.includes(provider as RerankerProvider)
}

function serviceRequiresApiKey(provider: ServiceProvider) {
  return provider !== 'tei'
}

async function validateModelProvider(service: ServiceSettingsRecord, apiKey: string, proxyUrl?: string) {
  const response = await fetchWithTimeout(joinUrl(service.baseUrl, '/models'), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  }, proxyUrl)

  if (response.ok) {
    return serviceValidation('valid', proxyUrl ? 'Connection checked through /models via proxy' : 'Connection checked through /models')
  }

  return serviceValidation('invalid', await providerStatusMessage(response))
}

async function validateQdrant(service: ServiceSettingsRecord, apiKey: string) {
  const response = await fetchWithTimeout(trimTrailingSlash(service.baseUrl), {
    method: 'GET',
    headers: {
      'api-key': apiKey,
    },
  })

  if (!response.ok) {
    return serviceValidation('invalid', await providerStatusMessage(response))
  }

  const responseText = await readResponseText(response)
  if (!responseText.toLowerCase().includes('qdrant')) {
    return serviceValidation('invalid', 'Endpoint responded, but it does not look like Qdrant')
  }

  return serviceValidation('valid', 'Qdrant endpoint accepted the key')
}

type RerankRequest = {
  url: string
  init: ProxyFetchInit
}

type RerankResponse = {
  results?: Array<{
    index?: number
    relevance_score?: number
    score?: number
  }>
  data?: Array<{
    index?: number
    relevance_score?: number
    score?: number
  }>
}

function jsonHeaders(apiKey?: string) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  return headers
}

function buildRerankRequest(
  service: ServiceSettingsRecord,
  apiKey: string | undefined,
  question: string,
  documents: string[],
  limit: number,
): RerankRequest {
  switch (service.provider) {
    case 'cohere':
      return {
        url: cohereRerankUrl(service.baseUrl),
        init: {
          method: 'POST',
          headers: {
            ...jsonHeaders(apiKey),
            'X-Client-Name': 'rag-ocr-agent',
          },
          body: JSON.stringify({
            model: service.model || 'rerank-v3.5',
            query: question,
            documents,
            top_n: limit,
          }),
        },
      }
    case 'voyage':
      return {
        url: versionedRerankUrl(service.baseUrl, '/v1'),
        init: {
          method: 'POST',
          headers: jsonHeaders(apiKey),
          body: JSON.stringify({
            model: service.model || 'rerank-2.5',
            query: question,
            documents,
            top_k: limit,
          }),
        },
      }
    case 'jina':
      return {
        url: versionedRerankUrl(service.baseUrl, '/v1'),
        init: {
          method: 'POST',
          headers: jsonHeaders(apiKey),
          body: JSON.stringify({
            model: service.model || 'jina-reranker-v3',
            query: question,
            documents,
            top_n: limit,
          }),
        },
      }
    case 'tei':
      return {
        url: teiRerankUrl(service.baseUrl),
        init: {
          method: 'POST',
          headers: jsonHeaders(apiKey),
          body: JSON.stringify({
            query: question,
            texts: documents,
            raw_scores: false,
          }),
        },
      }
    default:
      throw new Error('Service is not a reranker')
  }
}

async function validateRerankerProvider(
  service: ServiceSettingsRecord,
  apiKey: string | undefined,
  proxyUrl?: string,
) {
  const request = buildRerankRequest(
    service,
    apiKey,
    'health check',
    ['health check document', 'unrelated document'],
    1,
  )
  const response = await fetchWithTimeout(request.url, request.init, proxyUrl)

  if (!response.ok) {
    return serviceValidation('invalid', await providerStatusMessage(response))
  }

  return serviceValidation(
    'valid',
    proxyUrl ? `${service.label} checked via proxy` : `${service.label} checked`,
  )
}

async function rerankWithProvider(
  service: ServiceSettingsRecord,
  apiKey: string | undefined,
  proxyUrl: string | undefined,
  question: string,
  candidates: RankedChunk[],
): Promise<RankedChunk[]> {
  if (!candidates.length) {
    return []
  }

  const request = buildRerankRequest(
    service,
    apiKey,
    question,
    candidates.map((chunk) => chunk.text),
    Math.min(rerankResultLimit, candidates.length),
  )
  const response = await fetchWithTimeout(request.url, request.init, proxyUrl)

  if (!response.ok) {
    throw new Error(await providerStatusMessage(response))
  }

  const payload = (await response.json().catch(() => null)) as RerankResponse | RerankResponse['results'] | null
  const reranked = extractRerankResults(payload).flatMap((result) => {
    const candidate = candidates[result.index]
    if (!candidate) {
      return []
    }

    return [{
      ...candidate,
      score: result.score ?? candidate.score,
    }]
  })

  return reranked.length ? reranked : candidates.slice(0, rerankResultLimit)
}

function extractRerankResults(payload: RerankResponse | RerankResponse['results'] | null) {
  const rawResults = Array.isArray(payload)
    ? payload
    : payload?.results ?? payload?.data ?? []

  return rawResults.flatMap((result) => {
    if (!result || typeof result !== 'object' || typeof result.index !== 'number') {
      return []
    }

    const score = typeof result.relevance_score === 'number'
      ? result.relevance_score
      : typeof result.score === 'number'
        ? result.score
        : undefined

    return [{ index: result.index, score }]
  })
}

function getServiceSecret(service: ServiceSettingsRecord) {
  if (!service.secret) {
    return undefined
  }

  return decryptSecret(service.secret)
}

function getRerankerServiceForMode(data: StoreData, userId: string, mode: AgentMode): RerankerServiceSettings | undefined {
  const services = getServices(data, userId)

  if (mode === 'local') {
    return services.find((service): service is RerankerServiceSettings => service.provider === 'tei')
  }

  const cloudProviders: RerankerProvider[] = ['cohere', 'voyage', 'jina']
  const cloudServices = cloudProviders.flatMap((provider) => {
    const service = services.find((item): item is RerankerServiceSettings => item.provider === provider)
    return service ? [service] : []
  })

  return cloudServices.find((service) => service.enabled) ?? cloudServices.find((service) => service.secret)
}

function normalizeAgentMode(mode: unknown): AgentMode {
  return mode === 'local' ? 'local' : 'cloud'
}

function hasCyrillic(value: string) {
  return /\p{Script=Cyrillic}/u.test(value)
}

function buildRerankCandidates(question: string, chunks: DocumentChunkRecord[]) {
  const localCandidates = selectAnswerCandidates(question, chunks, maxRerankCandidates)
  if (localCandidates.length) {
    return localCandidates
  }

  return chunks.slice(0, maxRerankCandidates).map((chunk) => ({ ...chunk, score: 0 }))
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

async function validateService(
  service: ServiceSettingsRecord,
  sharedProxy: { url?: string; error?: string },
): Promise<ServiceValidationRecord> {
  if (!service.enabled) {
    return serviceValidation('skipped', 'Service disabled')
  }

  if (!service.secret && serviceRequiresApiKey(service.provider)) {
    return serviceValidation('skipped', 'API key is not set')
  }

  let apiKey: string | undefined
  if (service.secret) {
    try {
      apiKey = decryptSecret(service.secret)
    } catch {
      return serviceValidation('invalid', 'Stored key could not be decrypted')
    }
  }

  if (proxyAppliesTo(service.provider) && sharedProxy.error) {
    return serviceValidation('invalid', sharedProxy.error)
  }
  const proxyUrl = proxyAppliesTo(service.provider) ? sharedProxy.url : undefined

  try {
    new URL(service.baseUrl)
  } catch {
    return serviceValidation('invalid', 'Base URL is invalid')
  }

  try {
    switch (service.provider) {
      case 'openai':
        return await validateModelProvider(service, apiKey ?? '', proxyUrl)
      case 'mistral':
        return await validateModelProvider(service, apiKey ?? '')
      case 'cohere':
      case 'voyage':
      case 'jina':
      case 'tei':
        return await validateRerankerProvider(service, apiKey, proxyUrl)
      case 'qdrant':
        return await validateQdrant(service, apiKey ?? '')
    }

    return serviceValidation('invalid', 'Unknown service provider')
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return serviceValidation('invalid', 'Connection timed out')
    }

    if (service.provider === 'tei') {
      return serviceValidation('invalid', 'Local TEI is not reachable at the configured Base URL')
    }

    return serviceValidation('invalid', 'Could not reach service')
  }
}

async function validateServices(services: ServiceSettingsRecord[], proxy: ProxySettingsRecord) {
  const sharedProxy = getSharedProxyUrl(proxy)

  return Promise.all(
    services.map(async (service) => ({
      ...service,
      validation: await validateService(service, sharedProxy),
    })),
  )
}

function safeOriginalName(filename: string) {
  const safeName = basename(filename || 'document')
    .replace(/[^\w.\-()[\] ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()

  return safeName || 'document'
}

function getFileType(filename: string) {
  const extension = extname(filename).replace('.', '').toUpperCase()
  return extension || 'FILE'
}

async function pruneExpiredSessions(data: StoreData) {
  const now = Date.now()
  const sessions = data.sessions.filter((session) => Date.parse(session.expiresAt) > now)
  if (sessions.length !== data.sessions.length) {
    await store.write({ ...data, sessions })
  }
}

function getServices(data: StoreData, userId: string): ServiceSettingsRecord[] {
  const existing = data.settingsByUserId[userId]
  if (existing?.length) {
    const byProvider = new Map(existing.map((service) => [service.provider, service]))
    return defaultServices.map((fallback) => ({ ...fallback, ...byProvider.get(fallback.provider) }))
  }

  return defaultServices
}

function normalizeRerankerSelection(services: ServiceSettingsRecord[]) {
  const activeProvider = rerankerProviders.find((provider) =>
    services.some((service) => service.provider === provider && service.enabled),
  )

  if (!activeProvider) {
    return services
  }

  return services.map((service) =>
    isRerankerProvider(service.provider)
      ? {
          ...service,
          enabled: service.provider === activeProvider,
        }
      : service,
  )
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

function proxyAppliesTo(provider: ServiceProvider) {
  return provider === 'openai' || provider === 'cohere' || provider === 'voyage' || provider === 'jina'
}

function getAuthBody(body: unknown): AuthBody {
  if (!body || typeof body !== 'object') {
    return {}
  }

  return body as AuthBody
}

function getSettingsBody(body: unknown): ServiceSettingsBody {
  if (!body || typeof body !== 'object') {
    return {}
  }

  return body as ServiceSettingsBody
}

function getAskBody(body: unknown): AskBody {
  if (!body || typeof body !== 'object') {
    return {}
  }

  return body as AskBody
}

async function main() {
  const app = fastify({ logger: true })
  app.addHook('onClose', async () => {
    await store.close()
  })

  await app.register(cookie)
  await app.register(rateLimit, {
    max: Number.isFinite(rateLimitMax) && rateLimitMax > 0 ? rateLimitMax : 180,
    timeWindow: rateLimitWindow,
  })
  await app.register(multipart, {
    limits: {
      fileSize: maxUploadBytes,
      files: 8,
    },
  })

  app.get('/api/health', async () => ({
    ok: true,
    service: 'rag-ocr-agent',
  }))

  async function currentUser(request: FastifyRequest) {
    const token = request.cookies[cookieName]
    if (!token) {
      return null
    }

    const data = await store.read()
    await pruneExpiredSessions(data)
    const tokenHash = hashSessionToken(token)
    const session = data.sessions.find((item) => item.tokenHash === tokenHash)
    if (!session) {
      return null
    }

    return data.users.find((user) => user.id === session.userId) ?? null
  }

  app.get('/api/auth/me', async (request, reply) => {
    const user = await currentUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    return { user: publicUser(user) }
  })

  app.post('/api/auth/register', async (request, reply) => {
    const body = getAuthBody(request.body)
    const email = normalizeEmail(body.email ?? '')
    const name = (body.name ?? '').trim()
    const password = body.password ?? ''

    if (!name || !email || password.length < 8) {
      return reply.code(400).send({ error: 'Name, valid email, and password with 8+ chars are required' })
    }

    const data = await store.read()
    if (data.users.some((user) => user.email === email)) {
      return reply.code(409).send({ error: 'User already exists' })
    }

    const passwordData = hashPassword(password)
    const user: UserRecord = {
      id: randomUUID(),
      name,
      email,
      ...passwordData,
      createdAt: new Date().toISOString(),
    }

    const sessionToken = createSessionToken()
    const session = {
      tokenHash: hashSessionToken(sessionToken),
      userId: user.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
    }

    await store.write({
      ...data,
      users: [...data.users, user],
      sessions: [...data.sessions, session],
      settingsByUserId: {
        ...data.settingsByUserId,
        [user.id]: defaultServices,
      },
    })

    return reply
      .setCookie(cookieName, sessionToken, sessionCookieOptions())
      .code(201)
      .send({ user: publicUser(user) })
  })

  app.post('/api/auth/login', async (request, reply) => {
    const body = getAuthBody(request.body)
    const email = normalizeEmail(body.email ?? '')
    const password = body.password ?? ''
    const data = await store.read()
    const user = data.users.find((item) => item.email === email)

    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      return reply.code(401).send({ error: 'Invalid email or password' })
    }

    const sessionToken = createSessionToken()
    const session = {
      tokenHash: hashSessionToken(sessionToken),
      userId: user.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + sessionTtlMs).toISOString(),
    }

    await store.write({
      ...data,
      sessions: [...data.sessions, session],
    })

    return reply.setCookie(cookieName, sessionToken, sessionCookieOptions()).send({ user: publicUser(user) })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[cookieName]
    if (token) {
      const data = await store.read()
      const tokenHash = hashSessionToken(token)
      await store.write({
        ...data,
        sessions: data.sessions.filter((session) => session.tokenHash !== tokenHash),
      })
    }

    return reply.clearCookie(cookieName, { path: '/' }).send({ ok: true })
  })

  app.get('/api/settings/services', async (request, reply) => {
    const user = await currentUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    const data = await store.read()
    return {
      services: getServices(data, user.id).map(publicService),
      proxy: publicProxySettings(getProxySettings(data, user.id)),
    }
  })

  app.put('/api/settings/services', async (request, reply) => {
    const user = await currentUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    const body = getSettingsBody(request.body)
    const incoming = body.services ?? []
    const data = await store.read()
    const current = getServices(data, user.id)
    const currentByProvider = new Map(current.map((service) => [service.provider, service]))
    const currentProxy = getProxySettings(data, user.id)
    const now = new Date().toISOString()
    const nextProxy: ProxySettingsRecord = body.proxy?.clearProxy
      ? {}
      : body.proxy?.proxyUrl?.trim()
        ? { secret: encryptSecret(body.proxy.proxyUrl), updatedAt: now }
        : currentProxy

    const nextServices = normalizeRerankerSelection(defaultServices.map((fallback) => {
      const previous = currentByProvider.get(fallback.provider) ?? fallback
      const update = incoming.find((item) => item.provider === fallback.provider)
      if (!update) {
        return { ...previous, proxySecret: undefined }
      }

      return {
        ...previous,
        enabled: typeof update.enabled === 'boolean' ? update.enabled : previous.enabled,
        label: update.label?.trim() || previous.label,
        baseUrl: update.baseUrl?.trim() || previous.baseUrl,
        model: update.model?.trim() || previous.model,
        secret: update.clearApiKey
          ? undefined
          : update.apiKey?.trim()
            ? encryptSecret(update.apiKey)
            : previous.secret,
        proxySecret: undefined,
        updatedAt: now,
      }
    }))
    const validatedServices = await validateServices(nextServices, nextProxy)

    await store.write({
      ...data,
      settingsByUserId: {
        ...data.settingsByUserId,
        [user.id]: validatedServices,
      },
      proxyByUserId: {
        ...data.proxyByUserId,
        [user.id]: nextProxy,
      },
    })

    return {
      services: validatedServices.map(publicService),
      proxy: publicProxySettings(nextProxy),
    }
  })

  app.get('/api/documents', async (request, reply) => {
    const user = await currentUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    const data = await store.read()
    const documents = data.documentsByUserId[user.id] ?? []

    return { documents: documents.map(publicDocument) }
  })

  app.post('/api/documents', async (request, reply) => {
    const user = await currentUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    const { files } = await request.saveRequestFiles()
    if (!files.length) {
      return reply.code(400).send({ error: 'At least one file is required' })
    }

    const data = await store.read()
    const uploadDir = join(uploadRoot, user.id)
    mkdirSync(uploadDir, { recursive: true })

    const now = new Date().toISOString()
    const uploadedDocuments: DocumentRecord[] = files.map((file, index) => {
      const originalName = safeOriginalName(file.filename)
      const extension = extname(originalName)
      const storedName = `${Date.now()}-${index}-${randomUUID()}${extension}`
      const storagePath = join(uploadDir, storedName)
      const fileBuffer = readFileSync(file.filepath)

      writeFileSync(storagePath, fileBuffer)

      return {
        id: randomUUID(),
        userId: user.id,
        fileName: storedName,
        originalName,
        fileType: getFileType(originalName),
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: fileBuffer.byteLength,
        status: 'processing',
        storagePath,
        chunkCount: 0,
        pipeline: createPipelineSteps(),
        createdAt: now,
        updatedAt: now,
      }
    })

    const processedResults = await Promise.all(
      uploadedDocuments.map((document) => processDocument(document, textRoot)),
    )
    const processedDocuments = processedResults.map((result) => result.document)
    const nextChunksByDocumentId = { ...data.chunksByDocumentId }
    processedResults.forEach((result) => {
      nextChunksByDocumentId[result.document.id] = result.chunks
    })

    const currentDocuments = data.documentsByUserId[user.id] ?? []
    await store.write({
      ...data,
      documentsByUserId: {
        ...data.documentsByUserId,
        [user.id]: [...processedDocuments, ...currentDocuments],
      },
      chunksByDocumentId: nextChunksByDocumentId,
    })

    return reply.code(201).send({ documents: processedDocuments.map(publicDocument) })
  })

  app.post('/api/documents/:documentId/process', async (request, reply) => {
    const user = await currentUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    const { documentId } = request.params as { documentId?: string }
    const data = await store.read()
    const documents = data.documentsByUserId[user.id] ?? []
    const document = documents.find((item) => item.id === documentId)
    if (!document) {
      return reply.code(404).send({ error: 'Document not found' })
    }

    const processingDocument: DocumentRecord = {
      ...document,
      status: 'processing',
      pipeline: createPipelineSteps(),
      error: undefined,
      updatedAt: new Date().toISOString(),
    }
    const result = await processDocument(processingDocument, textRoot)

    await store.write({
      ...data,
      documentsByUserId: {
        ...data.documentsByUserId,
        [user.id]: documents.map((item) => (item.id === result.document.id ? result.document : item)),
      },
      chunksByDocumentId: {
        ...data.chunksByDocumentId,
        [result.document.id]: result.chunks,
      },
    })

    return { document: publicDocument(result.document) }
  })

  app.get('/api/documents/:documentId/text', async (request, reply) => {
    const user = await currentUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    const { documentId } = request.params as { documentId?: string }
    const data = await store.read()
    const document = (data.documentsByUserId[user.id] ?? []).find((item) => item.id === documentId)
    if (!document) {
      return reply.code(404).send({ error: 'Document not found' })
    }

    if (document.status !== 'ready') {
      return reply.code(409).send({ error: 'Document is not ready yet' })
    }

    return { text: readDocumentText(document), document: publicDocument(document) }
  })

  app.post('/api/ask', async (request, reply) => {
    const user = await currentUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    const body = getAskBody(request.body)
    const question = body.question?.trim() ?? ''
    const mode = normalizeAgentMode(body.mode)
    const ruQuestion = hasCyrillic(question)
    if (question.length < 3) {
      return reply.code(400).send({ error: 'Question is required' })
    }

    const data = await store.read()
    const chunks = Object.values(data.chunksByDocumentId)
      .flat()
      .filter((chunk) => chunk.userId === user.id)
    let rankedChunks = selectAnswerCandidates(question, chunks, rerankResultLimit)
    let engine: AskEngine = 'local-retrieval'
    let warning: string | undefined
    const rerankerService = getRerankerServiceForMode(data, user.id, mode)

    if (rerankerService && chunks.length) {
      try {
        const apiKey = getServiceSecret(rerankerService)
        const sharedProxy = getSharedProxyUrl(getProxySettings(data, user.id))

        if (!rerankerService.enabled && mode === 'local') {
          warning = ruQuestion
            ? 'Выбран локальный режим, но Local TEI выключен в настройках.'
            : 'Local mode is selected, but Local TEI is disabled in settings.'
        } else if (!apiKey && serviceRequiresApiKey(rerankerService.provider)) {
          warning = ruQuestion
            ? `${rerankerService.label} включён, но API key не добавлен.`
            : `${rerankerService.label} is enabled, but API key is missing.`
        } else if (proxyAppliesTo(rerankerService.provider) && sharedProxy.error) {
          warning = sharedProxy.error
        } else {
          rankedChunks = await rerankWithProvider(
            rerankerService,
            apiKey,
            proxyAppliesTo(rerankerService.provider) ? sharedProxy.url : undefined,
            question,
            buildRerankCandidates(question, chunks),
          )
          engine = `${rerankerService.provider}-rerank`
        }
      } catch (error) {
        warning = mode === 'local' && rerankerService.provider === 'tei'
          ? ruQuestion
            ? 'Local TEI не отвечает. Запустите TEI по Base URL из настроек или переключитесь на Облачный режим.'
            : 'Local TEI is not responding. Start TEI at the configured Base URL or switch to Cloud mode.'
          : error instanceof Error
            ? error.message
            : `${rerankerService.label} failed`
        app.log.warn({ provider: rerankerService.provider, warning }, 'Reranker fallback to local retrieval')
      }
    } else if (chunks.length && mode === 'cloud') {
      warning = ruQuestion
        ? 'Выбран облачный режим, но облачный reranker не настроен.'
        : 'Cloud mode is selected, but no cloud reranker is configured.'
    } else if (chunks.length && mode === 'local') {
      warning = ruQuestion
        ? 'Выбран локальный режим, но Local TEI не настроен.'
        : 'Local mode is selected, but Local TEI is not configured.'
    }

    const result = answerQuestion(question, chunks, rankedChunks)

    return {
      answer: result.answer,
      citations: result.citations.map(publicCitation),
      engine,
      mode,
      warning,
    }
  })

  const webDist = resolve(process.env.WEB_DIST_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'))
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
    })

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' })
      }

      return reply.sendFile('index.html')
    })
  }

  const port = Number(process.env.PORT ?? 3000)
  await app.listen({ host: '0.0.0.0', port })
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(sessionTtlMs / 1000),
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
