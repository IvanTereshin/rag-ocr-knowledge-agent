export type UploadFileType =
  | 'pdf'
  | 'doc'
  | 'docx'
  | 'ppt'
  | 'pptx'
  | 'xls'
  | 'xlsx'
  | 'txt'
  | 'md'
  | 'csv'
  | 'tsv'
  | 'json'
  | 'log'
  | 'png'
  | 'jpg'
  | 'jpeg'
  | 'webp'

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

type MagicFileFamily = 'pdf' | 'zip' | 'compound-office' | 'png' | 'jpeg' | 'webp'

const allowedExtensions = new Set<UploadFileType>([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'log',
  'png',
  'jpg',
  'jpeg',
  'webp',
])

const allowedMimeTypes: Record<UploadFileType, string[]> = {
  pdf: ['application/pdf', 'application/octet-stream'],
  doc: ['application/msword', 'application/vnd.ms-word', 'application/octet-stream'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/x-zip-compressed', 'multipart/x-zip', 'application/octet-stream'],
  ppt: ['application/vnd.ms-powerpoint', 'application/mspowerpoint', 'application/powerpoint', 'application/octet-stream'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/x-zip-compressed', 'multipart/x-zip', 'application/octet-stream'],
  xls: ['application/vnd.ms-excel', 'application/msexcel', 'application/octet-stream'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/x-zip-compressed', 'multipart/x-zip', 'application/octet-stream'],
  txt: ['text/plain', 'application/txt', 'text/anytext'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  tsv: ['text/tab-separated-values', 'text/plain'],
  json: ['application/json', 'text/json', 'text/plain'],
  log: ['text/plain', 'text/x-log', 'application/octet-stream'],
  png: ['image/png', 'application/octet-stream'],
  jpg: ['image/jpeg', 'image/jpg', 'application/octet-stream'],
  jpeg: ['image/jpeg', 'image/jpg', 'application/octet-stream'],
  webp: ['image/webp', 'application/octet-stream'],
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
    return bytes ? bytes.subarray(0, 16) : null
  }

  return null
}

function matchesPrefix(bytes: Uint8Array | null, prefix: number[]): boolean {
  if (!bytes || bytes.length < prefix.length) {
    return false
  }

  return prefix.every((byte, index) => bytes[index] === byte)
}

function detectMagicFileFamily(bytes: Uint8Array | null): MagicFileFamily | null {
  if (!bytes) {
    return null
  }

  if (matchesPrefix(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return 'pdf'
  }

  if (matchesPrefix(bytes, [0x50, 0x4b])) {
    return 'zip'
  }

  if (matchesPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return 'compound-office'
  }

  if (matchesPrefix(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return 'png'
  }

  if (matchesPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return 'jpeg'
  }

  if (
    bytes.length >= 12 &&
    matchesPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp'
  }

  return null
}

function expectedMagicFamilies(extension: UploadFileType): MagicFileFamily[] {
  switch (extension) {
    case 'pdf':
      return ['pdf']
    case 'docx':
    case 'pptx':
    case 'xlsx':
      return ['zip']
    case 'doc':
    case 'ppt':
    case 'xls':
      return ['compound-office']
    case 'png':
      return ['png']
    case 'jpg':
    case 'jpeg':
      return ['jpeg']
    case 'webp':
      return ['webp']
    default:
      return []
  }
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
  const detectedFamily = detectMagicFileFamily(firstBytes)
  const expectedFamilies = expectedMagicFamilies(extension)

  if (expectedFamilies.length && !expectedFamilies.includes(detectedFamily as MagicFileFamily)) {
    return { ok: false, error: 'File signature does not match the file extension' }
  }

  if (!expectedFamilies.length && detectedFamily) {
    return { ok: false, error: 'Binary file signature is not allowed for this text-based extension' }
  }

  return {
    ok: true,
    extension,
    fileType: extension,
  }
}
