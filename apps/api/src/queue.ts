import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from 'redis'
import type { RedisClientType } from 'redis'
import type { DocumentProcessingJob, DocumentProcessingJobPayload, DocumentProcessingJobStatus } from './job-types.js'

export const documentProcessingQueueName = 'document-processing'
const redisQueueKey = `queue:${documentProcessingQueueName}:waiting`
const redisActiveKey = `queue:${documentProcessingQueueName}:active`
const redisCompletedKey = `queue:${documentProcessingQueueName}:completed`
const redisFailedKey = `queue:${documentProcessingQueueName}:failed`

type QueuedDocumentProcessingJob = DocumentProcessingJob & {
  attemptsMade: number
}

export interface JobQueue {
  enqueue(payload: DocumentProcessingJobPayload): Promise<DocumentProcessingJob>
  reserve(): Promise<DocumentProcessingJob | null>
  complete(jobId: string): Promise<void>
  fail(jobId: string, error: string): Promise<void>
  list(): Promise<DocumentProcessingJob[]>
  close(): Promise<void>
}

export type JobWorker = {
  close(): Promise<void>
}

function createJob(payload: DocumentProcessingJobPayload, state: DocumentProcessingJobStatus['state']): DocumentProcessingJob {
  const jobId = randomUUID()

  return {
    id: jobId,
    payload,
    status: createStatus(jobId, payload, state),
  }
}

function createStatus(
  jobId: string,
  payload: DocumentProcessingJobPayload,
  state: DocumentProcessingJobStatus['state'],
): DocumentProcessingJobStatus {
  return {
    jobId,
    documentId: payload.documentId,
    userId: payload.userId,
    sourceKey: payload.sourceKey,
    sourcePath: payload.sourcePath,
    pipelineVersion: payload.pipelineVersion,
    attempts: payload.attempts,
    state,
    updatedAt: new Date().toISOString(),
  }
}

export class InMemoryJobQueue implements JobQueue {
  private readonly jobs: DocumentProcessingJob[] = []

  async enqueue(payload: DocumentProcessingJobPayload): Promise<DocumentProcessingJob> {
    const job = createJob(payload, 'queued')
    this.jobs.push(job)
    return job
  }

  async reserve(): Promise<DocumentProcessingJob | null> {
    const job = this.jobs.find((current) => current.status.state === 'queued')
    if (!job) {
      return null
    }

    job.status = {
      ...job.status,
      state: 'running',
      updatedAt: new Date().toISOString(),
    }

    return cloneJob(job)
  }

  async complete(jobId: string): Promise<void> {
    const job = this.jobs.find((current) => current.id === jobId)
    if (!job) {
      return
    }

    job.status = {
      ...job.status,
      state: 'completed',
      updatedAt: new Date().toISOString(),
    }
  }

  async fail(jobId: string, error: string): Promise<void> {
    const job = this.jobs.find((current) => current.id === jobId)
    if (!job) {
      return
    }

    job.status = {
      ...job.status,
      state: 'failed',
      error,
      updatedAt: new Date().toISOString(),
    }
  }

  async list(): Promise<DocumentProcessingJob[]> {
    return this.jobs.map(cloneJob)
  }

  async close(): Promise<void> {}
}

export class ImmediateJobQueue implements JobQueue {
  private readonly jobs: DocumentProcessingJob[] = []

  async enqueue(payload: DocumentProcessingJobPayload): Promise<DocumentProcessingJob> {
    const job = createJob(payload, 'completed')
    this.jobs.push(job)
    return cloneJob(job)
  }

  async reserve(): Promise<DocumentProcessingJob | null> {
    return null
  }

  async complete(jobId: string): Promise<void> {
    const job = this.jobs.find((current) => current.id === jobId)
    if (job) {
      job.status = { ...job.status, state: 'completed', updatedAt: new Date().toISOString() }
    }
  }

  async fail(jobId: string, error: string): Promise<void> {
    const job = this.jobs.find((current) => current.id === jobId)
    if (job) {
      job.status = { ...job.status, state: 'failed', error, updatedAt: new Date().toISOString() }
    }
  }

  async list(): Promise<DocumentProcessingJob[]> {
    return this.jobs.map(cloneJob)
  }

  async close(): Promise<void> {}
}

export type RedisJobQueueOptions = {
  redisUrl: string
  attempts: number
}

export class RedisJobQueue implements JobQueue {
  private readonly client: RedisClientType
  private readonly ready: Promise<RedisClientType>

  constructor(private readonly options: RedisJobQueueOptions) {
    this.client = createClient({ url: options.redisUrl }) as RedisClientType
    this.ready = this.client.connect().then(() => this.client)
  }

  async enqueue(payload: DocumentProcessingJobPayload): Promise<DocumentProcessingJob> {
    const job = createJob({ ...payload, attempts: this.options.attempts }, 'queued')
    const queuedJob: QueuedDocumentProcessingJob = {
      ...job,
      attemptsMade: 0,
    }
    const client = await this.ready
    await client.lPush(redisQueueKey, JSON.stringify(queuedJob))
    return cloneJob(job)
  }

  async reserve(): Promise<DocumentProcessingJob | null> {
    const client = await this.ready
    const item = await client.rPop(redisQueueKey)
    if (!item) {
      return null
    }

    const job = parseQueuedJob(item)
    job.status = { ...job.status, state: 'running', updatedAt: new Date().toISOString() }
    await client.hSet(redisActiveKey, job.id, JSON.stringify(job))
    return cloneJob(job)
  }

  async complete(jobId: string): Promise<void> {
    const client = await this.ready
    const active = await client.hGet(redisActiveKey, jobId)
    await client.hDel(redisActiveKey, jobId)
    if (active) {
      const job = parseQueuedJob(active)
      job.status = { ...job.status, state: 'completed', updatedAt: new Date().toISOString() }
      await client.hSet(redisCompletedKey, jobId, JSON.stringify(job))
    }
  }

  async fail(jobId: string, error: string): Promise<void> {
    const client = await this.ready
    const active = await client.hGet(redisActiveKey, jobId)
    await client.hDel(redisActiveKey, jobId)
    if (active) {
      const job = parseQueuedJob(active)
      job.status = { ...job.status, state: 'failed', error, updatedAt: new Date().toISOString() }
      await client.hSet(redisFailedKey, jobId, JSON.stringify(job))
    }
  }

  async list(): Promise<DocumentProcessingJob[]> {
    const client = await this.ready
    const waiting = await client.lRange(redisQueueKey, 0, 100)
    const active = Object.values(await client.hGetAll(redisActiveKey))
    const completed = Object.values(await client.hGetAll(redisCompletedKey))
    const failed = Object.values(await client.hGetAll(redisFailedKey))

    return [...waiting, ...active, ...completed, ...failed].map((item) => cloneJob(parseQueuedJob(item)))
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit()
    }
  }
}

export type CreateDocumentWorkerOptions = {
  redisUrl: string
  concurrency: number
  attempts: number
  backoffMs: number
  processor: (payload: DocumentProcessingJobPayload, jobId: string) => Promise<void>
}

export function createDocumentProcessingWorker(options: CreateDocumentWorkerOptions): JobWorker {
  const client = createClient({ url: options.redisUrl }) as RedisClientType
  let closing = false
  const ready = client.connect().then(() => client)
  const workers = Array.from({ length: Math.max(1, options.concurrency) }, (_, index) => workerLoop(index))

  async function workerLoop(_index: number) {
    const connection = await ready

    while (!closing) {
      const result = await connection.brPop(redisQueueKey, 5)
      if (!result) {
        continue
      }

      const job = parseQueuedJob(result.element)
      job.status = { ...job.status, state: 'running', updatedAt: new Date().toISOString() }
      await connection.hSet(redisActiveKey, job.id, JSON.stringify(job))

      try {
        await options.processor(job.payload, job.id)
        await connection.hDel(redisActiveKey, job.id)
        job.status = { ...job.status, state: 'completed', updatedAt: new Date().toISOString() }
        await connection.hSet(redisCompletedKey, job.id, JSON.stringify(job))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Document processing job failed'
        await connection.hDel(redisActiveKey, job.id)
        job.attemptsMade += 1

        if (job.attemptsMade < options.attempts) {
          job.status = { ...job.status, state: 'queued', error: message, updatedAt: new Date().toISOString() }
          await delay(options.backoffMs)
          if (!closing) {
            await connection.lPush(redisQueueKey, JSON.stringify(job))
          }
        } else {
          job.status = { ...job.status, state: 'failed', error: message, updatedAt: new Date().toISOString() }
          await connection.hSet(redisFailedKey, job.id, JSON.stringify(job))
        }
      }
    }
  }

  return {
    async close() {
      closing = true
      await Promise.race([
        Promise.allSettled(workers),
        delay(1000),
      ])
      if (client.isOpen) {
        await client.quit()
      }
    },
  }
}

export function createJobQueueFromEnv(): JobQueue {
  const redisUrl = process.env.REDIS_URL?.trim()
  if (!redisUrl) {
    return new ImmediateJobQueue()
  }

  return new RedisJobQueue({
    redisUrl,
    attempts: parsePositiveInteger(process.env.WORKER_JOB_ATTEMPTS, 5),
  })
}

function parseQueuedJob(rawValue: string): QueuedDocumentProcessingJob {
  const parsed = JSON.parse(rawValue) as QueuedDocumentProcessingJob
  return {
    ...parsed,
    attemptsMade: parsed.attemptsMade ?? 0,
  }
}

function cloneJob(job: DocumentProcessingJob): DocumentProcessingJob {
  return {
    id: job.id,
    payload: { ...job.payload },
    status: { ...job.status },
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
