export type User = {
  id: string
  name: string
  email: string
  createdAt: string
}

export type ServiceProvider = 'openai' | 'mistral' | 'cohere' | 'voyage' | 'jina' | 'tei' | 'qdrant'
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
  engine: 'local-retrieval' | 'cohere-rerank' | 'voyage-rerank' | 'jina-rerank' | 'tei-rerank'
  mode: AgentMode
  warning?: string
  citations: Array<{
    id: string
    documentId: string
    documentName: string
    chunkIndex: number
    text: string
    score: number
  }>
}

type AuthPayload = {
  name?: string
  email: string
  password: string
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

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

  const response = await fetch('/api/documents', {
    method: 'POST',
    credentials: 'include',
    body: formData,
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
  register: (payload: AuthPayload) =>
    requestJson<{ user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  login: (payload: AuthPayload) =>
    requestJson<{ user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  logout: () =>
    requestJson<{ ok: true }>('/api/auth/logout', {
      method: 'POST',
    }),
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
