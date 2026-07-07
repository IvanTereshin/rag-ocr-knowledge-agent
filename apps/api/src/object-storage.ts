import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { Client } from 'minio'

export type ObjectStorageObject = {
  key: string
  path: string
  sizeBytes: number
  contentType?: string
}

export interface ObjectStorageAdapter {
  put(key: string, data: Uint8Array, contentType?: string): Promise<ObjectStorageObject>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  close?(): Promise<void>
}

export class NoopObjectStorage implements ObjectStorageAdapter {
  async put(key: string, data: Uint8Array, contentType?: string): Promise<ObjectStorageObject> {
    return {
      key,
      path: '',
      sizeBytes: data.byteLength,
      contentType,
    }
  }

  async get(_key: string): Promise<Uint8Array | null> {
    return null
  }

  async delete(): Promise<void> {}
}

export class LocalDiskObjectStorage implements ObjectStorageAdapter {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
  }

  async put(key: string, data: Uint8Array, contentType?: string): Promise<ObjectStorageObject> {
    const filePath = this.resolvePath(key)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, data)
    return {
      key,
      path: filePath,
      sizeBytes: data.byteLength,
      contentType,
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const filePath = this.resolvePath(key)
    try {
      return readFileSync(filePath)
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key)
    try {
      rmSync(filePath)
    } catch {}
  }

  private resolvePath(key: string): string {
    if (!key.trim()) {
      throw new Error('Object storage key is required')
    }

    const filePath = resolve(this.rootDir, key)
    const relativePath = relative(this.rootDir, filePath)
    if (relativePath.startsWith('..') || relativePath === '') {
      throw new Error('Object storage key escapes the storage root')
    }

    return filePath
  }
}

export type MinioObjectStorageOptions = {
  endpoint: string
  region: string
  accessKey: string
  secretKey: string
  bucketName: string
}

export class MinioObjectStorage implements ObjectStorageAdapter {
  private readonly client: Client
  private bucketReady = false

  constructor(private readonly options: MinioObjectStorageOptions) {
    const endpoint = new URL(options.endpoint)
    this.client = new Client({
      endPoint: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
      useSSL: endpoint.protocol === 'https:',
      accessKey: options.accessKey,
      secretKey: options.secretKey,
      region: options.region,
    })
  }

  async put(key: string, data: Uint8Array, contentType?: string): Promise<ObjectStorageObject> {
    await this.ensureBucket()
    await this.client.putObject(
      this.options.bucketName,
      key,
      Buffer.from(data),
      data.byteLength,
      contentType ? { 'Content-Type': contentType } : undefined,
    )

    return {
      key,
      path: `${this.options.bucketName}/${key}`,
      sizeBytes: data.byteLength,
      contentType,
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.ensureBucket()

    try {
      const stream = await this.client.getObject(this.options.bucketName, key)
      return streamToBytes(stream)
    } catch (error) {
      if (isNotFoundError(error)) {
        return null
      }

      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.ensureBucket()
    await this.client.removeObject(this.options.bucketName, key)
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) {
      return
    }

    const exists = await this.client.bucketExists(this.options.bucketName)
    if (!exists) {
      await this.client.makeBucket(this.options.bucketName, this.options.region)
    }

    this.bucketReady = true
  }
}

export function createSourceObjectStorageFromEnv(dataDir: string): ObjectStorageAdapter {
  const endpoint = process.env.S3_ENDPOINT?.trim()
  const accessKey = process.env.S3_ACCESS_KEY_ID?.trim()
  const secretKey = process.env.S3_SECRET_ACCESS_KEY?.trim()
  const bucketName = process.env.S3_BUCKET_SOURCE?.trim()

  if (!endpoint || !accessKey || !secretKey || !bucketName) {
    return new LocalDiskObjectStorage(resolve(dataDir, 'object-storage-source'))
  }

  return new MinioObjectStorage({
    endpoint,
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    accessKey,
    secretKey,
    bucketName,
  })
}

async function streamToBytes(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

function isNotFoundError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false
  }

  const record = error as { code?: unknown }
  return record.code === 'NoSuchKey' || record.code === 'NotFound'
}
