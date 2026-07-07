import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import type { DocumentChunkRecord, DocumentRecord, PipelineStepId, PipelineStepRecord } from './store.js'

const maxChunkChars = 1200
const chunkOverlapChars = 180
const maxPreviewChars = 520

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

export function createPipelineSteps(): PipelineStepRecord[] {
  return [
    { id: 'extract', status: 'pending' },
    { id: 'chunk', status: 'pending' },
    { id: 'index', status: 'pending' },
  ]
}

export async function processDocument(document: DocumentRecord, textRoot: string): Promise<PipelineResult> {
  const startedAt = new Date().toISOString()
  let steps = startStep(createPipelineSteps(), 'extract', startedAt)

  try {
    const extractedText = normalizeText(await extractText(document))
    if (!extractedText) {
      throw new Error('Text was not found. For scans and images, connect OCR service in settings.')
    }

    mkdirSync(join(textRoot, document.userId), { recursive: true })
    const textPath = join(textRoot, document.userId, `${document.id}.txt`)
    writeFileSync(textPath, extractedText)

    steps = completeStep(steps, 'extract', `Extracted ${extractedText.length} characters`)
    steps = startStep(steps, 'chunk')

    const chunkTexts = chunkText(extractedText)
    if (!chunkTexts.length) {
      throw new Error('The document is too small or empty after text cleanup.')
    }

    steps = completeStep(steps, 'chunk', `Created ${chunkTexts.length} chunks`)
    steps = startStep(steps, 'index')

    const chunks = chunkTexts.map((text, index): DocumentChunkRecord => ({
      id: randomUUID(),
      userId: document.userId,
      documentId: document.id,
      documentName: document.originalName,
      index,
      text,
      tokenEstimate: estimateTokens(text),
      createdAt: new Date().toISOString(),
    }))

    steps = completeStep(steps, 'index', `Indexed ${chunks.length} chunks`)

    return {
      document: {
        ...document,
        status: 'ready',
        textPath,
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
  if (!document.textPath) {
    return ''
  }

  return readFileSync(document.textPath, 'utf8')
}

async function extractText(document: DocumentRecord): Promise<string> {
  const fileType = document.fileType.toUpperCase()

  if (['TXT', 'MD', 'CSV', 'JSON', 'LOG'].includes(fileType) || document.mimeType.startsWith('text/')) {
    return readFileSync(document.storagePath, 'utf8')
  }

  if (fileType === 'PDF') {
    const buffer = readFileSync(document.storagePath)
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return result.text
    } finally {
      await parser.destroy()
    }
  }

  if (fileType === 'DOCX') {
    const result = await mammoth.extractRawText({ path: document.storagePath })
    return result.value
  }

  throw new Error(`${fileType} extraction is not supported yet. Use PDF, DOCX, TXT, MD, or CSV.`)
}

function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph
    if (next.length <= maxChunkChars) {
      current = next
      continue
    }

    if (current) {
      chunks.push(current)
    }

    if (paragraph.length <= maxChunkChars) {
      current = paragraph
      continue
    }

    for (let start = 0; start < paragraph.length; start += maxChunkChars - chunkOverlapChars) {
      chunks.push(paragraph.slice(start, start + maxChunkChars).trim())
    }
    current = ''
  }

  if (current) {
    chunks.push(current)
  }

  return chunks.filter(Boolean)
}

function rankChunks(question: string, chunks: DocumentChunkRecord[]): RankedChunk[] {
  const queryTokens = [...new Set(tokenize(question))]
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
