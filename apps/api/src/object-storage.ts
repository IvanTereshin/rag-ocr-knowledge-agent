import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

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
