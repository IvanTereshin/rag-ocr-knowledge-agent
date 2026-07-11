import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { createClient } from 'redis'
import type { JobQueue } from './queue.js'
import type { ObjectStorageAdapter } from './object-storage.js'
import type { AppStore } from './store.js'

type DependencyStatus = 'ok' | 'degraded' | 'skipped'

type DependencyCheck = {
  name: string
  status: DependencyStatus
  required: boolean
  latencyMs: number
  message: string
}

export type DependencyHealthResult = {
  ok: boolean
  service: 'rag-ocr-agent'
  checkedAt: string
  checks: DependencyCheck[]
}

type DependencyHealthOptions = {
  store: AppStore
  jobQueue: JobQueue
  sourceStorage: ObjectStorageAdapter
  processingMode: 'queued' | 'inline'
}

const healthTimeoutMs = parsePositiveInteger(process.env.HEALTH_CHECK_TIMEOUT_MS, 2_000)

export async function checkDependencies(options: DependencyHealthOptions): Promise<DependencyHealthResult> {
  const checks = await Promise.all([
    checkStore(options.store),
    checkQueue(options.jobQueue, options.processingMode),
    checkObjectStorage(options.sourceStorage, options.processingMode),
    checkClamAv(),
    checkHttpDependency({
      name: 'qdrant',
      baseUrl: process.env.QDRANT_BASE_URL,
      apiKey: process.env.QDRANT_API_KEY,
      required: false,
    }),
    checkHttpDependency({
      name: 'tei',
      baseUrl: process.env.TEI_BASE_URL,
      healthPath: '/health',
      required: false,
    }),
  ])

  return {
    ok: checks.every((check) => !check.required || check.status === 'ok'),
    service: 'rag-ocr-agent',
    checkedAt: new Date().toISOString(),
    checks,
  }
}

function checkClamAv() {
  const enabled = parseBooleanEnv(process.env.UPLOAD_SCAN_ENABLED, false)
  if (!enabled) {
    return skippedCheck('clamav', false, 'Upload scan is disabled')
  }

  const host = process.env.CLAMAV_HOST?.trim() || 'clamav'
  const port = parsePositiveInteger(process.env.CLAMAV_PORT, 3310)

  return runCheck('clamav', true, async () => {
    const response = await pingClamd(host, port)
    if (!/\bPONG\b/i.test(response)) {
      throw new Error(`Unexpected ClamAV response: ${response || 'empty response'}`)
    }

    return 'Reachable'
  })
}

function checkStore(store: AppStore) {
  return runCheck('store', true, async () => {
    await store.read()
    return 'Readable'
  })
}

function checkQueue(jobQueue: JobQueue, processingMode: 'queued' | 'inline') {
  const redisUrl = process.env.REDIS_URL?.trim()
  if (!redisUrl) {
    return skippedCheck('redis', processingMode === 'queued', 'REDIS_URL is not configured')
  }

  return runCheck('redis', processingMode === 'queued', async () => {
    const client = createClient({ url: redisUrl })
    client.on('error', () => {})
    await client.connect()
    try {
      await client.ping()
    } finally {
      await client.quit()
    }

    const jobs = await jobQueue.list()
    return `Reachable; trackedJobs=${jobs.length}`
  })
}

function checkObjectStorage(sourceStorage: ObjectStorageAdapter, processingMode: 'queued' | 'inline') {
  return runCheck('object-storage', processingMode === 'queued', async () => {
    const key = `health/${randomUUID()}.txt`
    const expected = Buffer.from('ok')

    await sourceStorage.put(key, expected, 'text/plain')
    const stored = await sourceStorage.get(key)
    await sourceStorage.delete(key)

    if (!stored || Buffer.compare(Buffer.from(stored), expected) !== 0) {
      throw new Error('Health object round-trip failed')
    }

    return process.env.S3_ENDPOINT?.trim()
      ? 'S3-compatible storage round-trip succeeded'
      : 'Local object storage round-trip succeeded'
  })
}

async function checkHttpDependency(options: {
  name: string
  baseUrl?: string
  healthPath?: string
  apiKey?: string
  required: boolean
}) {
  const baseUrl = options.baseUrl?.trim()
  if (!baseUrl) {
    return skippedCheck(options.name, options.required, `${options.name.toUpperCase()} base URL is not configured`)
  }

  return runCheck(options.name, options.required, async () => {
    const url = joinUrl(baseUrl, options.healthPath ?? '/')
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        ...(options.apiKey ? { 'api-key': options.apiKey } : {}),
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return 'Reachable'
  })
}

async function runCheck(
  name: string,
  required: boolean,
  run: () => Promise<string>,
): Promise<DependencyCheck> {
  const startedAt = Date.now()

  try {
    const message = await withTimeout(run(), healthTimeoutMs)
    return {
      name,
      status: 'ok',
      required,
      latencyMs: Date.now() - startedAt,
      message,
    }
  } catch (error) {
    return {
      name,
      status: 'degraded',
      required,
      latencyMs: Date.now() - startedAt,
      message: compactMessage(error instanceof Error ? error.message : `${name} health check failed`),
    }
  }
}

function skippedCheck(name: string, required: boolean, message: string): DependencyCheck {
  return {
    name,
    status: 'skipped',
    required,
    latencyMs: 0,
    message,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`Health check timed out after ${timeoutMs}ms`))
        }, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), healthTimeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

function joinUrl(baseUrl: string, path: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBaseUrl}${normalizedPath}`
}

function compactMessage(message: string) {
  return message.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

async function pingClamd(host: string, port: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    let response = ''

    socket.once('connect', () => {
      socket.write('zPING\0')
    })

    socket.on('data', (chunk) => {
      response += chunk.toString('utf8')
    })

    socket.once('end', () => {
      resolve(response.replace(/\0/g, '').trim())
    })

    socket.once('error', reject)
  })
}
