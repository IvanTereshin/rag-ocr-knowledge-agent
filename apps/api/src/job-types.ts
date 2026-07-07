export type DocumentProcessingJobPayload = {
  documentId: string
  userId: string
  sourceKey: string
  sourcePath: string
  attempts: number
  pipelineVersion: string
}

export type DocumentProcessingJobState = 'queued' | 'running' | 'completed' | 'failed'

export type DocumentProcessingJobStatus = {
  jobId: string
  documentId: string
  userId: string
  sourceKey: string
  sourcePath: string
  pipelineVersion: string
  attempts: number
  state: DocumentProcessingJobState
  updatedAt: string
  error?: string
}

export type DocumentProcessingJob = {
  id: string
  payload: DocumentProcessingJobPayload
  status: DocumentProcessingJobStatus
}
