export type UploadFileType = 'pdf' | 'docx' | 'txt' | 'md' | 'csv' | 'json' | 'log'

export interface UploadFileInput {
  filename: string
  mimetype?: string | null
  sizeBytes: number
  buffer?: Buffer | Uint8Array | null
  firstBytes?: Buffer | Uint8Array | null
}

export type UploadValidationResult =
  | {
      ok: true
      extension: UploadFileType
      fileType: UploadFileType
    }
  | {
      ok: false
      error: string
    }

const allowedExtensions = new Set<UploadFileType>(['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'log'])

const allowedMimeTypes: Record<UploadFileType, string[]> = {
  pdf: ['application/pdf', 'application/octet-stream'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/x-zip-compressed', 'multipart/x-zip', 'application/octet-stream'],
  txt: ['text/plain', 'application/txt', 'text/anytext'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  json: ['application/json', 'text/json', 'text/plain'],
  log: ['text/plain', 'text/x-log', 'application/octet-stream'],
}

function getExtension(filename: string): UploadFileType | null {
  const lastDotIndex = filename.lastIndexOf('.')
  if (lastDotIndex < 0 || lastDotIndex === filename.length - 1) {
    return null
  }

  const extension = filename.slice(lastDotIndex + 1).toLowerCase()
  return allowedExtensions.has(extension as UploadFileType) ? (extension as UploadFileType) : null
}

function toBytes(value?: Buffer | Uint8Array | null): Uint8Array | null {
  if (!value) {
    return null
  }

  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function getFirstBytes(input: UploadFileInput): Uint8Array | null {
  if (input.firstBytes) {
    return toBytes(input.firstBytes)
  }

  if (input.buffer) {
    const bytes = toBytes(input.buffer)
    return bytes ? bytes.subarray(0, 8) : null
  }

  return null
}

function matchesPrefix(bytes: Uint8Array | null, prefix: number[]): boolean {
  if (!bytes || bytes.length < prefix.length) {
    return false
  }

  return prefix.every((byte, index) => bytes[index] === byte)
}

function detectMagicFileType(bytes: Uint8Array | null): UploadFileType | null {
  if (!bytes) {
    return null
  }

  if (matchesPrefix(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return 'pdf'
  }

  if (matchesPrefix(bytes, [0x50, 0x4b])) {
    return 'docx'
  }

  return null
}

function isAllowedMimeType(extension: UploadFileType, mimetype?: string | null): boolean {
  if (!mimetype) {
    return true
  }

  const normalizedMimeType = mimetype.trim().toLowerCase()
  return allowedMimeTypes[extension].includes(normalizedMimeType)
}

export function validateUploadFile(input: UploadFileInput, maxBytes: number): UploadValidationResult {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { ok: false, error: 'Invalid maxBytes limit' }
  }

  if (!input.filename || !input.filename.trim()) {
    return { ok: false, error: 'Filename is required' }
  }

  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
    return { ok: false, error: 'Invalid file size' }
  }

  if (input.sizeBytes > maxBytes) {
    return { ok: false, error: `File exceeds the maximum allowed size of ${maxBytes} bytes` }
  }

  const extension = getExtension(input.filename)
  if (!extension) {
    return { ok: false, error: 'File extension is not allowed' }
  }

  if (!isAllowedMimeType(extension, input.mimetype)) {
    return { ok: false, error: 'File MIME type is not allowed for this extension' }
  }

  const firstBytes = getFirstBytes(input)
  const detectedFileType = detectMagicFileType(firstBytes)

  if (extension === 'pdf' && detectedFileType !== 'pdf') {
    return { ok: false, error: 'PDF magic bytes are invalid' }
  }

  if (extension === 'docx' && detectedFileType !== 'docx') {
    return { ok: false, error: 'DOCX magic bytes are invalid' }
  }

  if (detectedFileType && detectedFileType !== extension) {
    return { ok: false, error: 'File signature does not match the file extension' }
  }

  return {
    ok: true,
    extension,
    fileType: extension,
  }
}
