import { requestCsrfToken } from './csrf'

export type User = {
  id: string
  name: string
  email: string
  createdAt: string
}

export type ServiceProvider = 'openai' | 'mistral' | 'cohere' | 'voyage' | 'jina' | 'tei' | 'local-llm' | 'qdrant'
export type AgentMode = 'cloud' | 'local'

export type ServiceValidation = {
  status: 'unchecked' | 'valid' | 'invalid' | 'skipped'
  checkedAt?: string
  message: string
}

export type ServiceSettings = {
  provider: ServiceProvider
  enabled: boolean
  label: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKeyLast4: string
  validation: ServiceValidation
  updatedAt?: string
}

export type EditableServiceSettings = ServiceSettings & {
  apiKey: string
  clearApiKey?: boolean
}

export type ProxySettings = {
  hasProxy: boolean
  proxyLast4: string
  updatedAt?: string
}

export type EditableProxySettings = ProxySettings & {
  proxyUrl: string
  clearProxy?: boolean
}

export type UserDocument = {
  id: string
  name: string
  fileType: string
  mimeType: string
  sizeBytes: number
  status: 'uploaded' | 'queued' | 'processing' | 'ready' | 'failed'
  textPreview: string
  chunkCount: number
  pipeline: Array<{
    id: 'extract' | 'chunk' | 'index'
    status: 'pending' | 'running' | 'complete' | 'failed'
    startedAt?: string
    completedAt?: string
    message?: string
  }>
  error: string
  createdAt: string
  updatedAt: string
}

export type AskResponse = {
  answer: string
  engine: 'local-retrieval' | 'qdrant-vector' | 'cohere-rerank' | 'voyage-rerank' | 'jina-rerank' | 'tei-rerank'
  mode: AgentMode
  answerEngine?: 'template-fallback' | 'openai-responses' | 'local-openai-compatible'
  warning?: string
  citations: Array<{
    id: string
    documentId: string
    documentName: string
    chunkIndex: number
    text: string
    score: number
    source?: {
      fileName: string
      fileType: string
      page?: number
      slide?: number
      sheet?: string
      table?: string
      rowRange?: string
    }
    layout?: {
      blockType?: string
      confidence?: number
      bbox?: [number, number, number, number]
    }
  }>
}

type AuthPayload = {
  name?: string
  email: string
  password: string
}

const CSRF_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])
const CSRF_EXEMPT_PATHS = new Set(['/api/auth/register', '/api/auth/login'])

let cachedCsrfToken: string | null = null
let csrfTokenPromise: Promise<string | null> | null = null
let csrfEndpointAvailable: boolean | null = null

function resetCsrfState(): void {
  cachedCsrfToken = null
  csrfTokenPromise = null
  csrfEndpointAvailable = null
}

function isStateChangingMethod(method?: string): boolean {
  return typeof method === 'string' && CSRF_METHODS.has(method.toUpperCase())
}

async function fetchCsrfToken(): Promise<string | null> {
  const token = await requestCsrfToken()
  csrfEndpointAvailable = token === null ? false : true
  return token
}

async function getCsrfToken(): Promise<string | null> {
  if (csrfEndpointAvailable === false) {
    return null
  }

  if (cachedCsrfToken) {
    return cachedCsrfToken
  }

  if (!csrfTokenPromise) {
    csrfTokenPromise = fetchCsrfToken()
      .then((token) => {
        cachedCsrfToken = token
        return token
      })
      .finally(() => {
        csrfTokenPromise = null
      })
  }

  return csrfTokenPromise
}

async function withCsrfHeader(headers: Headers, method: string | undefined, url: string): Promise<Headers> {
  if (!isStateChangingMethod(method) || CSRF_EXEMPT_PATHS.has(url)) {
    return headers
  }

  const csrfToken = await getCsrfToken()
  if (csrfToken) {
    headers.set('x-csrf-token', csrfToken)
  }
  return headers
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  await withCsrfHeader(headers, options.method, url)

  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers,
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : 'Request failed'
    throw new Error(message)
  }

  return payload as T
}

async function uploadFiles(files: File[] | FileList): Promise<{ documents: UserDocument[] }> {
  const formData = new FormData()
  Array.from(files).forEach((file) => {
    formData.append('files', file)
  })

  const headers = await withCsrfHeader(new Headers(), 'POST', '/api/documents')

  const response = await fetch('/api/documents', {
    method: 'POST',
    credentials: 'include',
    body: formData,
    headers,
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : 'Upload failed'
    throw new Error(message)
  }

  return payload as { documents: UserDocument[] }
}

export const api = {
  me: () => requestJson<{ user: User }>('/api/auth/me'),
  register: async (payload: AuthPayload) => {
    const result = await requestJson<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    resetCsrfState()
    return result
  },
  login: async (payload: AuthPayload) => {
    const result = await requestJson<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    resetCsrfState()
    return result
  },
  logout: async () => {
    const result = await requestJson<{ ok: true }>('/api/auth/logout', {
      method: 'POST',
    })
    resetCsrfState()
    return result
  },
  getServices: () => requestJson<{ services: ServiceSettings[]; proxy: ProxySettings }>('/api/settings/services'),
  saveServices: (services: EditableServiceSettings[], proxy: EditableProxySettings) =>
    requestJson<{ services: ServiceSettings[]; proxy: ProxySettings }>('/api/settings/services', {
      method: 'PUT',
      body: JSON.stringify({
        services: services.map((service) => ({
          provider: service.provider,
          enabled: service.enabled,
          label: service.label,
          baseUrl: service.baseUrl,
          model: service.model,
          apiKey: service.apiKey,
          clearApiKey: service.clearApiKey,
        })),
        proxy: {
          proxyUrl: proxy.proxyUrl,
          clearProxy: proxy.clearProxy,
        },
      }),
    }),
  getDocuments: () => requestJson<{ documents: UserDocument[] }>('/api/documents'),
  uploadDocuments: uploadFiles,
  processDocument: (documentId: string) =>
    requestJson<{ document: UserDocument }>(`/api/documents/${documentId}/process`, {
      method: 'POST',
    }),
  ask: (question: string, mode: AgentMode) =>
    requestJson<AskResponse>('/api/ask', {
      method: 'POST',
      body: JSON.stringify({ question, mode }),
    }),
}
