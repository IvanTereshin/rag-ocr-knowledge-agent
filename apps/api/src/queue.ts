import { randomUUID } from 'node:crypto'
import type { DocumentProcessingJob, DocumentProcessingJobPayload, DocumentProcessingJobStatus } from './job-types.js'

export interface JobQueue {
  enqueue(payload: DocumentProcessingJobPayload): Promise<DocumentProcessingJob>
  reserve(): Promise<DocumentProcessingJob | null>
  complete(jobId: string): Promise<void>
  fail(jobId: string, error: string): Promise<void>
  list(): Promise<DocumentProcessingJob[]>
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

    return job
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
    return this.jobs.map((job) => ({
      id: job.id,
      payload: { ...job.payload },
      status: { ...job.status },
    }))
  }
}

export class ImmediateJobQueue implements JobQueue {
  private readonly jobs: DocumentProcessingJob[] = []

  async enqueue(payload: DocumentProcessingJobPayload): Promise<DocumentProcessingJob> {
    const job = createJob(payload, 'queued')

    this.jobs.push({
      id: job.id,
      payload: { ...job.payload },
      status: {
        ...job.status,
        state: 'completed',
        updatedAt: new Date().toISOString(),
      },
    })

    return {
      ...job,
      id: job.id,
      status: {
        ...job.status,
        state: 'completed',
        updatedAt: new Date().toISOString(),
      },
    }
  }

  async reserve(): Promise<DocumentProcessingJob | null> {
    return null
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
    return this.jobs.map((job) => ({
      id: job.id,
      payload: { ...job.payload },
      status: { ...job.status },
    }))
  }
}
