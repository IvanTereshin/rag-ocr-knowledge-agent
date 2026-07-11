import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import readXlsxFile from 'read-excel-file/node'
import type {
  DocumentChunkLayout,
  DocumentChunkRecord,
  DocumentChunkSource,
  DocumentRecord,
  PipelineStepId,
  PipelineStepRecord,
} from './store.js'

const maxChunkChars = 1200
const chunkOverlapChars = 180
const maxPreviewChars = 520
const mistralOcrBaseUrl = process.env.MISTRAL_OCR_BASE_URL?.trim() || process.env.MISTRAL_BASE_URL?.trim() || 'https://api.mistral.ai/v1'
const mistralOcrModel = process.env.MISTRAL_OCR_MODEL?.trim() || 'mistral-ocr-latest'
const mistralOcrApiKey = process.env.MISTRAL_OCR_API_KEY?.trim() || process.env.MISTRAL_API_KEY?.trim()
const ocrRequestTimeoutMs = parsePositiveInteger(process.env.OCR_REQUEST_TIMEOUT_MS, 60_000)

export type PipelineResult = {
  document: DocumentRecord
  chunks: DocumentChunkRecord[]
}

export type RankedChunk = DocumentChunkRecord & {
  score: number
}

export type AskResult = {
  answer: string
  citations: RankedChunk[]
}

type ExtractedBlock = {
  text: string
  source: DocumentChunkSource
  layout?: DocumentChunkLayout
}

export function createPipelineSteps(): PipelineStepRecord[] {
  return [
    { id: 'extract', status: 'pending' },
    { id: 'chunk', status: 'pending' },
    { id: 'index', status: 'pending' },
  ]
}

export async function processDocument(document: DocumentRecord, _textRoot: string): Promise<PipelineResult> {
  const startedAt = new Date().toISOString()
  let steps = startStep(createPipelineSteps(), 'extract', startedAt)

  try {
    const extractedBlocks = normalizeBlocks(await extractBlocks(document))
    const extractedText = normalizeText(extractedBlocks.map((block) => block.text).join('\n\n'))
    if (!extractedText) {
      throw new Error('Text was not found. For scans and images, connect OCR service in settings.')
    }

    steps = completeStep(steps, 'extract', `Extracted ${extractedText.length} characters from ${extractedBlocks.length} blocks`)
    steps = startStep(steps, 'chunk')

    const chunkInputs = chunkBlocks(extractedBlocks)
    if (!chunkInputs.length) {
      throw new Error('The document is too small or empty after text cleanup.')
    }

    steps = completeStep(steps, 'chunk', `Created ${chunkInputs.length} chunks`)
    steps = startStep(steps, 'index')

    const chunks = chunkInputs.map((chunk, index): DocumentChunkRecord => ({
      id: randomUUID(),
      userId: document.userId,
      documentId: document.id,
      documentName: document.originalName,
      index,
      text: chunk.text,
      tokenEstimate: estimateTokens(chunk.text),
      source: chunk.source,
      layout: chunk.layout,
      createdAt: new Date().toISOString(),
    }))

    steps = completeStep(steps, 'index', `Indexed ${chunks.length} chunks`)

    return {
      document: {
        ...document,
        status: 'ready',
        textContent: extractedText,
        textPath: document.textPath,
        textPreview: truncateText(extractedText, maxPreviewChars),
        chunkCount: chunks.length,
        pipeline: steps,
        error: undefined,
        updatedAt: new Date().toISOString(),
      },
      chunks,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Document processing failed'
    const failedStep = steps.find((step) => step.status === 'running')?.id ?? 'extract'
    steps = failStep(steps, failedStep, message)

    return {
      document: {
        ...document,
        status: 'failed',
        chunkCount: 0,
        pipeline: steps,
        error: message,
        updatedAt: new Date().toISOString(),
      },
      chunks: [],
    }
  }
}

export function answerQuestion(question: string, chunks: DocumentChunkRecord[], rankedChunks?: RankedChunk[]): AskResult {
  const topChunks = (rankedChunks ?? rankChunks(question, chunks)).slice(0, 3)
  const ru = hasCyrillic(question)

  if (!chunks.length) {
    return {
      answer: ru
        ? 'Пока нет обработанных документов. Загрузите файл и дождитесь статуса "Готово".'
        : 'There are no processed documents yet. Upload a file and wait for the "Ready" status.',
      citations: [],
    }
  }

  if (!topChunks.length) {
    return {
      answer: ru
        ? 'Я не нашёл релевантных фрагментов в обработанных документах. Попробуйте переформулировать вопрос.'
        : 'I could not find relevant chunks in the processed documents. Try rephrasing the question.',
      citations: [],
    }
  }

  const snippets = topChunks.map((chunk, index) => `${index + 1}. ${bestSnippet(chunk.text, question)}`).join('\n')
  return {
    answer: ru
      ? `Нашёл ${topChunks.length} релевантных фрагмента в документах:\n${snippets}`
      : `Found ${topChunks.length} relevant document chunks:\n${snippets}`,
    citations: topChunks,
  }
}

export function selectAnswerCandidates(question: string, chunks: DocumentChunkRecord[], limit: number): RankedChunk[] {
  return rankChunks(question, chunks).slice(0, limit)
}

export function readDocumentText(document: DocumentRecord): string {
  if (document.textContent) {
    return document.textContent
  }

  if (!document.textPath) {
    return ''
  }

  return readFileSync(document.textPath, 'utf8')
}

async function extractBlocks(document: DocumentRecord): Promise<ExtractedBlock[]> {
  const fileType = document.fileType.toUpperCase()
  const sourceBase = {
    fileName: document.originalName,
    fileType,
  }

  if (['TXT', 'MD', 'JSON', 'LOG'].includes(fileType) || document.mimeType.startsWith('text/')) {
    return [{
      text: readFileSync(document.storagePath, 'utf8'),
      source: sourceBase,
      layout: { blockType: fileType.toLowerCase() },
    }]
  }

  if (fileType === 'CSV' || fileType === 'TSV') {
    return extractDelimitedBlocks(document, fileType === 'TSV' ? '\t' : ',')
  }

  if (fileType === 'PDF') {
    return extractPdfBlocks(document)
  }

  if (fileType === 'DOCX') {
    const result = await mammoth.extractRawText({ path: document.storagePath })
    return [{
      text: result.value,
      source: sourceBase,
      layout: { blockType: 'document' },
    }]
  }

  if (fileType === 'PPTX') {
    return extractPptxBlocks(document)
  }

  if (fileType === 'XLSX') {
    return extractXlsxBlocks(document)
  }

  if (['PNG', 'JPG', 'JPEG', 'WEBP'].includes(fileType)) {
    return extractMistralOcrBlocks(document)
  }

  if (['DOC', 'PPT', 'XLS'].includes(fileType)) {
    if (mistralOcrApiKey && fileType !== 'XLS') {
      return extractMistralOcrBlocks(document)
    }

    throw new Error(`${fileType} is a legacy Microsoft Office format. Convert it to DOCX/PPTX/XLSX or add a LibreOffice conversion worker.`)
  }

  throw new Error(`${fileType} extraction is not supported yet.`)
}

async function extractPdfBlocks(document: DocumentRecord): Promise<ExtractedBlock[]> {
  const buffer = readFileSync(document.storagePath)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const info = await parser.getInfo({ parsePageInfo: true } as never).catch(() => null) as { total?: number } | null
    const totalPages = info?.total
    const pageCount = Number.isInteger(totalPages) && totalPages ? totalPages : 0
    const sourceBase = { fileName: document.originalName, fileType: document.fileType.toUpperCase() }

    if (pageCount > 0 && pageCount <= 200) {
      const blocks: ExtractedBlock[] = []
      for (let page = 1; page <= pageCount; page += 1) {
        const result = await parser.getText({ partial: [page] } as never) as { text?: string }
        const text = normalizeText(result.text ?? '')
        if (text) {
          blocks.push({
            text,
            source: { ...sourceBase, page },
            layout: { blockType: 'page' },
          })
        }
      }

      if (blocks.length) {
        return blocks
      }
    }

    const result = await parser.getText() as { text?: string }
    const fallbackText = normalizeText(result.text ?? '')
    if (!fallbackText && mistralOcrApiKey) {
      return extractMistralOcrBlocks(document)
    }

    return [{
      text: fallbackText,
      source: sourceBase,
      layout: { blockType: 'document' },
    }]
  } finally {
    await parser.destroy()
  }
}

async function extractPptxBlocks(document: DocumentRecord): Promise<ExtractedBlock[]> {
  const buffer = readFileSync(document.storagePath)
  const zip = await JSZip.loadAsync(buffer)
  const slideFiles = Object.values(zip.files)
    .filter((file) => /^ppt\/slides\/slide\d+\.xml$/.test(file.name))
    .sort((left, right) => slideNumberFromPath(left.name) - slideNumberFromPath(right.name))

  const blocks: ExtractedBlock[] = []
  for (const slideFile of slideFiles) {
    const xml = await slideFile.async('text')
    const text = extractTextRunsFromXml(xml)
    if (text) {
      const slide = slideNumberFromPath(slideFile.name)
      blocks.push({
        text,
        source: {
          fileName: document.originalName,
          fileType: document.fileType.toUpperCase(),
          slide,
        },
        layout: { blockType: 'slide' },
      })
    }
  }

  return blocks
}

type MistralOcrResponse = {
  pages?: Array<{
    index?: number
    markdown?: string
    blocks?: Array<{
      type?: string
      text?: string
      markdown?: string
      bbox?: unknown
      bounding_box?: unknown
      confidence?: number
    }>
    confidence?: number
  }>
}

async function extractMistralOcrBlocks(document: DocumentRecord): Promise<ExtractedBlock[]> {
  if (!mistralOcrApiKey) {
    throw new Error(`${document.fileType} needs OCR, but MISTRAL_OCR_API_KEY or MISTRAL_API_KEY is not configured.`)
  }

  const buffer = readFileSync(document.storagePath)
  const dataUrl = `data:${document.mimeType || mimeTypeFromFileType(document.fileType)};base64,${buffer.toString('base64')}`
  const isImage = ['PNG', 'JPG', 'JPEG', 'WEBP'].includes(document.fileType.toUpperCase())
  const documentPayload = isImage
    ? { type: 'image_url', image_url: dataUrl }
    : { type: 'document_url', document_url: dataUrl }

  const response = await fetchWithTimeout(joinUrl(mistralOcrBaseUrl, '/ocr'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mistralOcrApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: mistralOcrModel,
      document: documentPayload,
      include_blocks: true,
      table_format: 'markdown',
      confidence_scores_granularity: 'page',
    }),
  }, ocrRequestTimeoutMs)

  const payload = await readJsonResponse(response) as MistralOcrResponse | Record<string, unknown> | null
  if (!response.ok) {
    throw new Error(`Mistral OCR failed: ${providerErrorMessage(response, payload)}`)
  }

  const pages = Array.isArray((payload as MistralOcrResponse | null)?.pages)
    ? (payload as MistralOcrResponse).pages ?? []
    : []
  const sourceBase = {
    fileName: document.originalName,
    fileType: document.fileType.toUpperCase(),
  }

  return pages.flatMap((page, pageIndex): ExtractedBlock[] => {
    const pageNumber = typeof page.index === 'number' && page.index > 0 ? page.index : pageIndex + 1
    const blocks = Array.isArray(page.blocks) ? page.blocks : []
    const extractedBlocks = blocks.flatMap((block): ExtractedBlock[] => {
      const text = normalizeText(block.markdown ?? block.text ?? '')
      if (!text) {
        return []
      }

      return [{
        text,
        source: { ...sourceBase, page: pageNumber },
        layout: {
          blockType: block.type ?? 'ocr-block',
          confidence: typeof block.confidence === 'number' ? block.confidence : page.confidence,
          bbox: parseBBox(block.bbox ?? block.bounding_box),
        },
      }]
    })

    if (extractedBlocks.length) {
      return extractedBlocks
    }

    const text = normalizeText(page.markdown ?? '')
    return text
      ? [{
          text,
          source: { ...sourceBase, page: pageNumber },
          layout: {
            blockType: 'ocr-page',
            confidence: page.confidence,
          },
        }]
      : []
  })
}

async function extractXlsxBlocks(document: DocumentRecord): Promise<ExtractedBlock[]> {
  const sheets = await readXlsxFile(document.storagePath)
  const blocks: ExtractedBlock[] = []

  for (const sheet of sheets) {
    const sheetName = sheet.sheet || 'Sheet'
    const rows = sheet.data
    const nonEmptyRows = rows
      .map((row, rowIndex) => ({
        rowIndex: rowIndex + 1,
        cells: row.map(formatCellValue),
      }))
      .filter((row) => row.cells.some(Boolean))

    for (let start = 0; start < nonEmptyRows.length; start += 25) {
      const group = nonEmptyRows.slice(start, start + 25)
      const rowStart = group[0]?.rowIndex
      const rowEnd = group.at(-1)?.rowIndex
      const text = group
        .map((row) => `Row ${row.rowIndex}: ${row.cells.join(' | ')}`)
        .join('\n')

      if (text && rowStart && rowEnd) {
        blocks.push({
          text,
          source: {
            fileName: document.originalName,
            fileType: document.fileType.toUpperCase(),
            sheet: sheetName,
            rowRange: `${rowStart}-${rowEnd}`,
          },
          layout: { blockType: 'sheet-rows' },
        })
      }
    }
  }

  return blocks
}

function extractDelimitedBlocks(document: DocumentRecord, delimiter: ',' | '\t'): ExtractedBlock[] {
  const text = readFileSync(document.storagePath, 'utf8')
  const rows = text.split('\n').map((row, index) => ({
    rowIndex: index + 1,
    text: row.trim(),
  })).filter((row) => row.text)
  const blocks: ExtractedBlock[] = []

  for (let start = 0; start < rows.length; start += 50) {
    const group = rows.slice(start, start + 50)
    const rowStart = group[0]?.rowIndex
    const rowEnd = group.at(-1)?.rowIndex
    const blockText = group.map((row) => row.text.split(delimiter).map((cell) => cell.trim()).join(' | ')).join('\n')

    if (rowStart && rowEnd && blockText) {
      blocks.push({
        text: blockText,
        source: {
          fileName: document.originalName,
          fileType: document.fileType.toUpperCase(),
          rowRange: `${rowStart}-${rowEnd}`,
        },
        layout: { blockType: delimiter === '\t' ? 'tsv-rows' : 'csv-rows' },
      })
    }
  }

  return blocks
}

function chunkBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  return blocks.flatMap((block) => splitBlock(block))
}

function splitBlock(block: ExtractedBlock): ExtractedBlock[] {
  const paragraphs = block.text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)

  const chunks: ExtractedBlock[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph
    if (next.length <= maxChunkChars) {
      current = next
      continue
    }

    if (current) {
      chunks.push({ ...block, text: current })
    }

    if (paragraph.length <= maxChunkChars) {
      current = paragraph
      continue
    }

    for (let start = 0; start < paragraph.length; start += maxChunkChars - chunkOverlapChars) {
      const text = paragraph.slice(start, start + maxChunkChars).trim()
      if (text) {
        chunks.push({ ...block, text })
      }
    }
    current = ''
  }

  if (current) {
    chunks.push({ ...block, text: current })
  }

  return chunks.filter((chunk) => chunk.text)
}

function normalizeBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  return blocks
    .map((block) => ({ ...block, text: normalizeText(block.text) }))
    .filter((block) => block.text)
}

function slideNumberFromPath(path: string) {
  const match = /slide(\d+)\.xml$/.exec(path)
  return match ? Number(match[1]) : 0
}

function extractTextRunsFromXml(xml: string) {
  const runs = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXmlEntities(match[1] ?? '').trim())
    .filter(Boolean)

  return normalizeText(runs.join('\n'))
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10)
  }

  return String(value).replace(/\s+/g, ' ').trim()
}

function parseBBox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) {
    return undefined
  }

  const numbers = value.map((item) => Number(item))
  return numbers.every((item) => Number.isFinite(item))
    ? numbers as [number, number, number, number]
    : undefined
}

function mimeTypeFromFileType(fileType: string) {
  switch (fileType.toUpperCase()) {
    case 'PDF':
      return 'application/pdf'
    case 'PNG':
      return 'image/png'
    case 'JPG':
    case 'JPEG':
      return 'image/jpeg'
    case 'WEBP':
      return 'image/webp'
    case 'DOC':
      return 'application/msword'
    case 'PPT':
      return 'application/vnd.ms-powerpoint'
    default:
      return 'application/octet-stream'
  }
}

function joinUrl(baseUrl: string, path: string) {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function providerErrorMessage(response: Response, payload: unknown) {
  const detail = providerMessageFromPayload(payload)
  return `HTTP ${response.status}${detail ? `: ${detail}` : ''}`
}

function providerMessageFromPayload(payload: unknown): string {
  if (!payload) {
    return ''
  }

  if (typeof payload === 'string') {
    return payload.replace(/\s+/g, ' ').trim().slice(0, 240)
  }

  if (Array.isArray(payload)) {
    return payload.map(providerMessageFromPayload).filter(Boolean).join('; ')
  }

  if (typeof payload !== 'object') {
    return ''
  }

  const record = payload as Record<string, unknown>
  return providerMessageFromPayload(record.message ?? record.error_description ?? record.detail ?? record.error ?? '')
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function rankChunks(question: string, chunks: DocumentChunkRecord[]): RankedChunk[] {
  const queryTokens = expandQueryTokens(tokenize(question))
  if (!queryTokens.length) {
    return []
  }

  const chunkTokenSets = chunks.map((chunk) => new Set(tokenize(chunk.text)))
  const documentFrequency = new Map<string, number>()
  chunkTokenSets.forEach((tokens) => {
    queryTokens.forEach((token) => {
      if (tokens.has(token)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
      }
    })
  })
  const minimumMatches = queryTokens.length <= 2 ? 1 : 2
  const minimumCoverage = queryTokens.length <= 2 ? 0.5 : 0.22
  const normalizedQuestion = normalizeForSearch(question)

  return chunks
    .flatMap((chunk, index) => {
      const chunkTokenSet = chunkTokenSets[index] ?? new Set<string>()
      const matchedTokens = queryTokens.filter((token) => chunkTokenSet.has(token))
      const coverage = matchedTokens.length / queryTokens.length
      const weightedOverlap = matchedTokens.reduce((total, token) => {
        const frequency = documentFrequency.get(token) ?? 0
        return total + Math.log(1 + chunks.length / (1 + frequency))
      }, 0)
      const normalizedChunkText = normalizeForSearch(chunk.text)
      const exactQuestionBonus = normalizedQuestion.length > 12 && normalizedChunkText.includes(normalizedQuestion) ? 2 : 0
      const score = weightedOverlap + coverage * 2 + exactQuestionBonus

      if (matchedTokens.length < minimumMatches || coverage < minimumCoverage) {
        return []
      }

      return [{
        ...chunk,
        score,
      }]
    })
    .toSorted((left, right) => right.score - left.score)
}

function tokenize(value: string): string[] {
  return normalizeForSearch(value)
    .match(/[\p{L}\p{N}]{3,}/gu)
    ?.filter((token) => !stopWords.has(token)) ?? []
}

function expandQueryTokens(tokens: string[]): string[] {
  const expanded = tokens.flatMap((token) => [token, ...(querySynonyms[token] ?? [])])
  return [...new Set(expanded)]
}

function normalizeForSearch(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function bestSnippet(text: string, question: string): string {
  const tokens = tokenize(question)
  const sentences = text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean)
  const bestSentence = sentences
    .map((sentence) => ({
      sentence,
      score: tokens.reduce((total, token) => total + (normalizeForSearch(sentence).includes(token) ? 1 : 0), 0),
    }))
    .toSorted((left, right) => right.score - left.score)[0]?.sentence

  return truncateText(bestSentence || text, 320)
}

function normalizeText(text: string): string {
  return text
    .replace(/\0/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 1).trim()}…`
}

function startStep(steps: PipelineStepRecord[], stepId: PipelineStepId, startedAt = new Date().toISOString()) {
  return steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          status: 'running' as const,
          startedAt,
          message: undefined,
        }
      : step,
  )
}

function completeStep(steps: PipelineStepRecord[], stepId: PipelineStepId, message: string) {
  return steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          status: 'complete' as const,
          completedAt: new Date().toISOString(),
          message,
        }
      : step,
  )
}

function failStep(steps: PipelineStepRecord[], stepId: PipelineStepId, message: string) {
  return steps.map((step) =>
    step.id === stepId
      ? {
          ...step,
          status: 'failed' as const,
          completedAt: new Date().toISOString(),
          message,
        }
      : step,
  )
}

function hasCyrillic(value: string): boolean {
  return /\p{Script=Cyrillic}/u.test(value)
}

const stopWords = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'about',
  'what',
  'when',
  'where',
  'which',
  'why',
  'how',
  'should',
  'happen',
  'was',
  'were',
  'did',
  'does',
  'this',
  'that',
  'these',
  'those',
  'document',
  'documents',
  'question',
  'answer',
  'please',
  'tell',
  'show',
  'найди',
  'покажи',
  'расскажи',
  'ответь',
  'вопрос',
  'документ',
  'документы',
  'какие',
  'какой',
  'какая',
  'какое',
  'когда',
  'почему',
  'зачем',
  'сколько',
  'что',
  'как',
  'или',
  'для',
  'это',
  'этот',
  'эта',
  'эти',
  'того',
  'тоже',
  'его',
  'она',
  'они',
  'где',
  'при',
  'над',
  'под',
  'про',
  'без',
  'вам',
  'нам',
  'мне',
  'тебе',
  'если',
  'там',
  'тут',
])

const querySynonyms: Record<string, string[]> = {
  oversized: ['large', 'larger', 'size', 'limit', 'exceeds'],
  overlimit: ['large', 'larger', 'size', 'limit', 'exceeds'],
  upload: ['uploads', 'file', 'files'],
  uploads: ['upload', 'file', 'files'],
  files: ['file', 'uploads'],
  rejected: ['reject', 'blocked', 'denied'],
  reject: ['rejected', 'blocked', 'denied'],
  encrypted: ['encrypt', 'cipher', 'secret'],
  stored: ['saved', 'stored', 'kept'],
  хранится: ['сохранен', 'сохранены', 'зашифрован', 'зашифрованы'],
  зашифрован: ['зашифрованы', 'шифрование', 'секрет'],
  большой: ['размер', 'лимит', 'превышает'],
  большие: ['размер', 'лимит', 'превышают'],
  загрузки: ['upload', 'uploads', 'файлы', 'файл'],
}
