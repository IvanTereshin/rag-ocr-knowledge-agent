import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import postgres from 'postgres'

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
  csrfTokenHash?: string
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

export interface AppStore {
  read(): Promise<StoreData>
  write(nextData: StoreData): Promise<void>
  close(): Promise<void>
}

function normalizeStoreData(parsed: Partial<StoreData>): StoreData {
  return {
    ...emptyStore,
    ...parsed,
    users: parsed.users ?? [],
    sessions: parsed.sessions ?? [],
    settingsByUserId: parsed.settingsByUserId ?? {},
    proxyByUserId: parsed.proxyByUserId ?? {},
    documentsByUserId: parsed.documentsByUserId ?? {},
    chunksByDocumentId: parsed.chunksByDocumentId ?? {},
  }
}

export class JsonStore implements AppStore {
  private data: StoreData | null = null

  constructor(private readonly filePath: string) {}

  async read(): Promise<StoreData> {
    if (this.data) {
      return this.data
    }

    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true })
      this.data = structuredClone(emptyStore)
      await this.write(this.data)
      return this.data
    }

    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreData
    this.data = normalizeStoreData(parsed)
    return this.data
  }

  async write(nextData: StoreData): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    writeFileSync(tempPath, JSON.stringify(nextData, null, 2))
    renameSync(tempPath, this.filePath)
    this.data = nextData
  }

  async close(): Promise<void> {}
}

export class PostgresStore implements AppStore {
  private readonly sql: postgres.Sql
  private initialized = false

  constructor(databaseUrl: string) {
    const maxConnections = Number(process.env.POSTGRES_MAX_CONNECTIONS ?? 5)
    this.sql = postgres(databaseUrl, {
      max: Number.isFinite(maxConnections) && maxConnections > 0 ? maxConnections : 5,
      idle_timeout: 20,
      connect_timeout: 10,
    })
  }

  async read(): Promise<StoreData> {
    await this.ensureReady()
    const rows = await this.sql<{ data: StoreData }[]>`
      SELECT data
      FROM rag_ocr_app_state
      WHERE id = 1
    `

    return normalizeStoreData(rows[0]?.data ?? emptyStore)
  }

  async write(nextData: StoreData): Promise<void> {
    await this.ensureReady()
    await this.sql`
      INSERT INTO rag_ocr_app_state (id, data, updated_at)
      VALUES (1, ${this.sql.json(nextData)}, now())
      ON CONFLICT (id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.sql`
      CREATE TABLE IF NOT EXISTS rag_ocr_app_state (
        id integer PRIMARY KEY CHECK (id = 1),
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `

    await this.sql`
      INSERT INTO rag_ocr_app_state (id, data)
      VALUES (1, ${this.sql.json(emptyStore)})
      ON CONFLICT (id) DO NOTHING
    `

    this.initialized = true
  }
}

export function createStoreFromEnv(): AppStore {
  if (process.env.DATABASE_URL) {
    return new PostgresStore(process.env.DATABASE_URL)
  }

  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
  return new JsonStore(join(dataDir, 'store.json'))
}
