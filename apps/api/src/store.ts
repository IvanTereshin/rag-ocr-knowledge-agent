import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type UserRecord = {
  id: string
  name: string
  email: string
  passwordHash: string
  passwordSalt: string
  createdAt: string
}

export type SessionRecord = {
  tokenHash: string
  userId: string
  expiresAt: string
  createdAt: string
}

export type EncryptedSecret = {
  iv: string
  tag: string
  value: string
  last4: string
}

export type ServiceProvider = 'openai' | 'mistral' | 'cohere' | 'voyage' | 'jina' | 'tei' | 'qdrant'

export type ServiceValidationRecord = {
  status: 'unchecked' | 'valid' | 'invalid' | 'skipped'
  checkedAt?: string
  message: string
}

export type ServiceSettingsRecord = {
  provider: ServiceProvider
  enabled: boolean
  label: string
  baseUrl: string
  model: string
  secret?: EncryptedSecret
  proxySecret?: EncryptedSecret
  validation?: ServiceValidationRecord
  updatedAt?: string
}

export type ProxySettingsRecord = {
  secret?: EncryptedSecret
  updatedAt?: string
}

export type PipelineStepId = 'extract' | 'chunk' | 'index'

export type PipelineStepRecord = {
  id: PipelineStepId
  status: 'pending' | 'running' | 'complete' | 'failed'
  startedAt?: string
  completedAt?: string
  message?: string
}

export type DocumentRecord = {
  id: string
  userId: string
  fileName: string
  originalName: string
  fileType: string
  mimeType: string
  sizeBytes: number
  status: 'uploaded' | 'queued' | 'processing' | 'ready' | 'failed'
  storagePath: string
  textPath?: string
  textPreview?: string
  chunkCount?: number
  pipeline?: PipelineStepRecord[]
  error?: string
  createdAt: string
  updatedAt: string
}

export type DocumentChunkRecord = {
  id: string
  userId: string
  documentId: string
  documentName: string
  index: number
  text: string
  tokenEstimate: number
  createdAt: string
}

export type StoreData = {
  users: UserRecord[]
  sessions: SessionRecord[]
  settingsByUserId: Record<string, ServiceSettingsRecord[]>
  proxyByUserId: Record<string, ProxySettingsRecord>
  documentsByUserId: Record<string, DocumentRecord[]>
  chunksByDocumentId: Record<string, DocumentChunkRecord[]>
}

const emptyStore: StoreData = {
  users: [],
  sessions: [],
  settingsByUserId: {},
  proxyByUserId: {},
  documentsByUserId: {},
  chunksByDocumentId: {},
}

export class JsonStore {
  private data: StoreData | null = null

  constructor(private readonly filePath: string) {}

  read(): StoreData {
    if (this.data) {
      return this.data
    }

    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true })
      this.data = structuredClone(emptyStore)
      this.write(this.data)
      return this.data
    }

    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreData
    this.data = {
      ...emptyStore,
      ...parsed,
      settingsByUserId: parsed.settingsByUserId ?? {},
      proxyByUserId: parsed.proxyByUserId ?? {},
      documentsByUserId: parsed.documentsByUserId ?? {},
      chunksByDocumentId: parsed.chunksByDocumentId ?? {},
    }
    return this.data
  }

  write(nextData: StoreData): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(nextData, null, 2))
    renameSync(tempPath, this.filePath)
    this.data = nextData
  }
}

export function createStoreFromEnv(): JsonStore {
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
  return new JsonStore(join(dataDir, 'store.json'))
}
