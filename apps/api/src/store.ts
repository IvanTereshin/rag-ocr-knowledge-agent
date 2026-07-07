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
  storageKey?: string
  textPath?: string
  textContent?: string
  textPreview?: string
  chunkCount?: number
  jobId?: string
  queuedAt?: string
  processingStartedAt?: string
  processedAt?: string
  pipelineVersion?: string
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

type UserRow = {
  id: string
  name: string
  email: string
  password_hash: string
  password_salt: string
  created_at: string
}

type SessionRow = {
  token_hash: string
  user_id: string
  csrf_token_hash: string | null
  expires_at: string
  created_at: string
}

type ServiceSettingsRow = {
  user_id: string
  provider: string
  enabled: boolean
  label: string
  base_url: string
  model: string
  secret: unknown
  proxy_secret: unknown
  validation: unknown
  updated_at: string | null
}

type ProxySettingsRow = {
  user_id: string
  secret: unknown
  updated_at: string | null
}

type DocumentRow = {
  id: string
  user_id: string
  file_name: string
  original_name: string
  file_type: string
  mime_type: string
  size_bytes: number
  status: string
  storage_path: string
  storage_key: string | null
  text_path: string | null
  text_content: string | null
  text_preview: string | null
  chunk_count: number | null
  job_id: string | null
  queued_at: string | null
  processing_started_at: string | null
  processed_at: string | null
  pipeline_version: string | null
  pipeline: unknown
  error: string | null
  created_at: string
  updated_at: string
}

type DocumentChunkRow = {
  id: string
  user_id: string
  document_id: string
  document_name: string
  chunk_index: number
  text: string
  token_estimate: number
  created_at: string
}

function optionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined
}

function optionalNumber(value: number | null | undefined): number | undefined {
  return value ?? undefined
}

function optionalJson<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : value as T
}

function jsonOrNull(sql: postgres.Sql | postgres.TransactionSql, value: unknown) {
  return value === undefined ? null : sql.json(value as postgres.JSONValue)
}

export class JsonStore implements AppStore {
  private data: StoreData | null = null

  constructor(private readonly filePath: string) {}

  async read(): Promise<StoreData> {
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

    const [
      users,
      sessions,
      serviceSettings,
      proxySettings,
      documents,
      chunks,
    ] = await Promise.all([
      this.sql<UserRow[]>`
        SELECT id, name, email, password_hash, password_salt, created_at
        FROM rag_ocr_users
        ORDER BY created_at ASC, id ASC
      `,
      this.sql<SessionRow[]>`
        SELECT token_hash, user_id, csrf_token_hash, expires_at, created_at
        FROM rag_ocr_sessions
        ORDER BY created_at ASC, token_hash ASC
      `,
      this.sql<ServiceSettingsRow[]>`
        SELECT user_id, provider, enabled, label, base_url, model, secret, proxy_secret, validation, updated_at
        FROM rag_ocr_service_settings
        ORDER BY user_id ASC, provider ASC
      `,
      this.sql<ProxySettingsRow[]>`
        SELECT user_id, secret, updated_at
        FROM rag_ocr_proxy_settings
        ORDER BY user_id ASC
      `,
      this.sql<DocumentRow[]>`
        SELECT id, user_id, file_name, original_name, file_type, mime_type, size_bytes, status, storage_path,
          storage_key, text_path, text_content, text_preview, chunk_count, job_id, queued_at, processing_started_at,
          processed_at, pipeline_version, pipeline, error, created_at, updated_at
        FROM rag_ocr_documents
        ORDER BY user_id ASC, position ASC, created_at DESC
      `,
      this.sql<DocumentChunkRow[]>`
        SELECT id, user_id, document_id, document_name, chunk_index, text, token_estimate, created_at
        FROM rag_ocr_document_chunks
        ORDER BY document_id ASC, chunk_index ASC
      `,
    ])

    return normalizeStoreData({
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        passwordHash: user.password_hash,
        passwordSalt: user.password_salt,
        createdAt: user.created_at,
      })),
      sessions: sessions.map((session) => ({
        tokenHash: session.token_hash,
        userId: session.user_id,
        csrfTokenHash: optionalString(session.csrf_token_hash),
        expiresAt: session.expires_at,
        createdAt: session.created_at,
      })),
      settingsByUserId: serviceSettings.reduce<Record<string, ServiceSettingsRecord[]>>((settingsByUserId, service) => {
        settingsByUserId[service.user_id] = [
          ...(settingsByUserId[service.user_id] ?? []),
          {
            provider: service.provider as ServiceProvider,
            enabled: service.enabled,
            label: service.label,
            baseUrl: service.base_url,
            model: service.model,
            secret: optionalJson<EncryptedSecret>(service.secret),
            proxySecret: optionalJson<EncryptedSecret>(service.proxy_secret),
            validation: optionalJson<ServiceValidationRecord>(service.validation),
            updatedAt: optionalString(service.updated_at),
          },
        ]

        return settingsByUserId
      }, {}),
      proxyByUserId: proxySettings.reduce<Record<string, ProxySettingsRecord>>((proxyByUserId, proxy) => {
        proxyByUserId[proxy.user_id] = {
          secret: optionalJson<EncryptedSecret>(proxy.secret),
          updatedAt: optionalString(proxy.updated_at),
        }
        return proxyByUserId
      }, {}),
      documentsByUserId: documents.reduce<Record<string, DocumentRecord[]>>((documentsByUserId, document) => {
        documentsByUserId[document.user_id] = [
          ...(documentsByUserId[document.user_id] ?? []),
          {
            id: document.id,
            userId: document.user_id,
            fileName: document.file_name,
            originalName: document.original_name,
            fileType: document.file_type,
            mimeType: document.mime_type,
            sizeBytes: document.size_bytes,
            status: document.status as DocumentRecord['status'],
            storagePath: document.storage_path,
            storageKey: optionalString(document.storage_key),
            textPath: optionalString(document.text_path),
            textContent: optionalString(document.text_content),
            textPreview: optionalString(document.text_preview),
            chunkCount: optionalNumber(document.chunk_count),
            jobId: optionalString(document.job_id),
            queuedAt: optionalString(document.queued_at),
            processingStartedAt: optionalString(document.processing_started_at),
            processedAt: optionalString(document.processed_at),
            pipelineVersion: optionalString(document.pipeline_version),
            pipeline: optionalJson<PipelineStepRecord[]>(document.pipeline),
            error: optionalString(document.error),
            createdAt: document.created_at,
            updatedAt: document.updated_at,
          },
        ]

        return documentsByUserId
      }, {}),
      chunksByDocumentId: chunks.reduce<Record<string, DocumentChunkRecord[]>>((chunksByDocumentId, chunk) => {
        chunksByDocumentId[chunk.document_id] = [
          ...(chunksByDocumentId[chunk.document_id] ?? []),
          {
            id: chunk.id,
            userId: chunk.user_id,
            documentId: chunk.document_id,
            documentName: chunk.document_name,
            index: chunk.chunk_index,
            text: chunk.text,
            tokenEstimate: chunk.token_estimate,
            createdAt: chunk.created_at,
          },
        ]

        return chunksByDocumentId
      }, {}),
    })
  }

  async write(nextData: StoreData): Promise<void> {
    await this.ensureReady()
    await this.writeNormalized(nextData)
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }

  private async ensureReady(): Promise<void> {
    if (this.initialized) {
      return
    }

    await this.createNormalizedTables()
    await this.migrateLegacyState()
    this.initialized = true
  }

  private async createNormalizedTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS rag_ocr_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS rag_ocr_users (
        id text PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        password_salt text NOT NULL,
        created_at text NOT NULL
      )
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS rag_ocr_sessions (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
        csrf_token_hash text,
        expires_at text NOT NULL,
        created_at text NOT NULL
      )
    `

    await this.sql`
      CREATE INDEX IF NOT EXISTS rag_ocr_sessions_user_id_idx
      ON rag_ocr_sessions(user_id)
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS rag_ocr_service_settings (
        user_id text NOT NULL REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
        provider text NOT NULL,
        enabled boolean NOT NULL,
        label text NOT NULL,
        base_url text NOT NULL,
        model text NOT NULL,
        secret jsonb,
        proxy_secret jsonb,
        validation jsonb,
        updated_at text,
        PRIMARY KEY (user_id, provider)
      )
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS rag_ocr_proxy_settings (
        user_id text PRIMARY KEY REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
        secret jsonb,
        updated_at text
      )
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS rag_ocr_documents (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
        position integer NOT NULL DEFAULT 0,
        file_name text NOT NULL,
        original_name text NOT NULL,
        file_type text NOT NULL,
        mime_type text NOT NULL,
        size_bytes integer NOT NULL,
        status text NOT NULL,
        storage_path text NOT NULL,
        storage_key text,
        text_path text,
        text_content text,
        text_preview text,
        chunk_count integer,
        job_id text,
        queued_at text,
        processing_started_at text,
        processed_at text,
        pipeline_version text,
        pipeline jsonb,
        error text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      )
    `

    await this.sql`
      ALTER TABLE rag_ocr_documents
      ADD COLUMN IF NOT EXISTS text_content text
    `

    await this.sql`
      CREATE INDEX IF NOT EXISTS rag_ocr_documents_user_id_position_idx
      ON rag_ocr_documents(user_id, position)
    `

    await this.sql`
      CREATE TABLE IF NOT EXISTS rag_ocr_document_chunks (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES rag_ocr_users(id) ON DELETE CASCADE,
        document_id text NOT NULL REFERENCES rag_ocr_documents(id) ON DELETE CASCADE,
        document_name text NOT NULL,
        chunk_index integer NOT NULL,
        text text NOT NULL,
        token_estimate integer NOT NULL,
        created_at text NOT NULL
      )
    `

    await this.sql`
      CREATE INDEX IF NOT EXISTS rag_ocr_document_chunks_document_id_idx
      ON rag_ocr_document_chunks(document_id, chunk_index)
    `

    await this.sql`
      CREATE INDEX IF NOT EXISTS rag_ocr_document_chunks_user_id_idx
      ON rag_ocr_document_chunks(user_id)
    `
  }

  private async migrateLegacyState(): Promise<void> {
    const migrationVersion = 'normalized-store-v1'
    const migrationRows = await this.sql<{ version: string }[]>`
      SELECT version
      FROM rag_ocr_schema_migrations
      WHERE version = ${migrationVersion}
    `
    if (migrationRows.length) {
      return
    }

    const legacyTableRows = await this.sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.rag_ocr_app_state') IS NOT NULL AS exists
    `
    const legacyTableExists = legacyTableRows[0]?.exists ?? false
    if (!legacyTableExists) {
      await this.markMigrationApplied(migrationVersion)
      return
    }

    const normalizedRows = await this.sql<{ count: string }[]>`
      SELECT (
        (SELECT count(*) FROM rag_ocr_users) +
        (SELECT count(*) FROM rag_ocr_documents) +
        (SELECT count(*) FROM rag_ocr_document_chunks)
      )::text AS count
    `
    if (Number(normalizedRows[0]?.count ?? 0) > 0) {
      await this.markMigrationApplied(migrationVersion)
      return
    }

    const legacyRows = await this.sql<{ data: StoreData }[]>`
      SELECT data
      FROM rag_ocr_app_state
      WHERE id = 1
    `
    const legacyData = normalizeStoreData(legacyRows[0]?.data ?? emptyStore)
    await this.writeNormalized(legacyData)
    await this.markMigrationApplied(migrationVersion)
  }

  private async markMigrationApplied(version: string): Promise<void> {
    await this.sql`
      INSERT INTO rag_ocr_schema_migrations (version)
      VALUES (${version})
      ON CONFLICT (version) DO NOTHING
    `
  }

  private async writeNormalized(nextData: StoreData): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`DELETE FROM rag_ocr_document_chunks`
      await sql`DELETE FROM rag_ocr_documents`
      await sql`DELETE FROM rag_ocr_service_settings`
      await sql`DELETE FROM rag_ocr_proxy_settings`
      await sql`DELETE FROM rag_ocr_sessions`
      await sql`DELETE FROM rag_ocr_users`

      for (const user of nextData.users) {
        await sql`
          INSERT INTO rag_ocr_users (id, name, email, password_hash, password_salt, created_at)
          VALUES (${user.id}, ${user.name}, ${user.email}, ${user.passwordHash}, ${user.passwordSalt}, ${user.createdAt})
        `
      }

      for (const session of nextData.sessions) {
        await sql`
          INSERT INTO rag_ocr_sessions (token_hash, user_id, csrf_token_hash, expires_at, created_at)
          VALUES (${session.tokenHash}, ${session.userId}, ${session.csrfTokenHash ?? null}, ${session.expiresAt}, ${session.createdAt})
        `
      }

      for (const [userId, services] of Object.entries(nextData.settingsByUserId)) {
        for (const service of services) {
          await sql`
            INSERT INTO rag_ocr_service_settings (
              user_id, provider, enabled, label, base_url, model, secret, proxy_secret, validation, updated_at
            )
            VALUES (
              ${userId}, ${service.provider}, ${service.enabled}, ${service.label}, ${service.baseUrl},
              ${service.model}, ${jsonOrNull(sql, service.secret)}, ${jsonOrNull(sql, service.proxySecret)},
              ${jsonOrNull(sql, service.validation)}, ${service.updatedAt ?? null}
            )
          `
        }
      }

      for (const [userId, proxy] of Object.entries(nextData.proxyByUserId)) {
        await sql`
          INSERT INTO rag_ocr_proxy_settings (user_id, secret, updated_at)
          VALUES (${userId}, ${jsonOrNull(sql, proxy.secret)}, ${proxy.updatedAt ?? null})
        `
      }

      for (const [userId, documents] of Object.entries(nextData.documentsByUserId)) {
        for (const [position, document] of documents.entries()) {
          await sql`
            INSERT INTO rag_ocr_documents (
              id, user_id, position, file_name, original_name, file_type, mime_type, size_bytes, status,
              storage_path, storage_key, text_path, text_content, text_preview, chunk_count, job_id, queued_at,
              processing_started_at, processed_at, pipeline_version, pipeline, error, created_at, updated_at
            )
            VALUES (
              ${document.id}, ${userId}, ${position}, ${document.fileName}, ${document.originalName},
              ${document.fileType}, ${document.mimeType}, ${document.sizeBytes}, ${document.status},
              ${document.storagePath}, ${document.storageKey ?? null}, ${document.textPath ?? null},
              ${document.textContent ?? null}, ${document.textPreview ?? null}, ${document.chunkCount ?? null}, ${document.jobId ?? null},
              ${document.queuedAt ?? null}, ${document.processingStartedAt ?? null},
              ${document.processedAt ?? null}, ${document.pipelineVersion ?? null},
              ${jsonOrNull(sql, document.pipeline)}, ${document.error ?? null},
              ${document.createdAt}, ${document.updatedAt}
            )
          `
        }
      }

      for (const chunks of Object.values(nextData.chunksByDocumentId)) {
        for (const chunk of chunks) {
          await sql`
            INSERT INTO rag_ocr_document_chunks (
              id, user_id, document_id, document_name, chunk_index, text, token_estimate, created_at
            )
            VALUES (
              ${chunk.id}, ${chunk.userId}, ${chunk.documentId}, ${chunk.documentName},
              ${chunk.index}, ${chunk.text}, ${chunk.tokenEstimate}, ${chunk.createdAt}
            )
          `
        }
      }
    })
  }

}

export function createStoreFromEnv(): AppStore {
  if (process.env.DATABASE_URL) {
    return new PostgresStore(process.env.DATABASE_URL)
  }

  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
  return new JsonStore(join(dataDir, 'store.json'))
}
