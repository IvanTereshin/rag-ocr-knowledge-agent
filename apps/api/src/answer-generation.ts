import { fetch as undiciFetch, ProxyAgent } from 'undici'
import type { RankedChunk } from './pipeline.js'
import type { ServiceSettingsRecord } from './store.js'

const defaultRequestTimeoutMs = 15_000
const maxContextChars = parsePositiveInteger(process.env.ANSWER_MAX_CONTEXT_CHARS, 7_000)
const maxOutputTokens = parsePositiveInteger(process.env.ANSWER_MAX_OUTPUT_TOKENS, 700)
const proxyAgents = new Map<string, ProxyAgent>()

type JsonRecord = Record<string, unknown>

type GenerateOpenAIAnswerOptions = {
  service: ServiceSettingsRecord
  apiKey?: string
  proxyUrl?: string
  question: string
  citations: RankedChunk[]
  language: 'ru' | 'en'
}

type OpenAIResponsesPayload = {
  output_text?: unknown
  output?: Array<{
    content?: Array<{
      text?: unknown
      type?: unknown
    }>
  }>
}

type ChatCompletionsPayload = {
  choices?: Array<{
    message?: {
      content?: unknown
    }
  }>
}

export type GeneratedAnswer = {
  answer: string
  provider: 'openai-responses' | 'local-openai-compatible'
}

export async function generateOpenAIAnswer(options: GenerateOpenAIAnswerOptions): Promise<GeneratedAnswer> {
  const response = await fetchWithOptionalProxy(options.proxyUrl)(responsesUrl(options.service.baseUrl), {
    method: 'POST',
    headers: jsonHeaders(options.apiKey),
    body: JSON.stringify({
      model: options.service.model || process.env.ANSWER_MODEL || 'gpt-4.1',
      input: [
        {
          role: 'system',
          content: systemPrompt(options.language),
        },
        {
          role: 'user',
          content: userPrompt(options.question, options.citations, options.language),
        },
      ],
      max_output_tokens: maxOutputTokens,
    }),
  }, parsePositiveInteger(process.env.RAG_REQUEST_TIMEOUT_MS, defaultRequestTimeoutMs))

  const payload = (await readJsonResponse(response)) as OpenAIResponsesPayload
  if (!response.ok) {
    throw new Error(providerErrorMessage('OpenAI Responses API', response, payload))
  }

  const answer = extractResponseText(payload)
  if (!answer) {
    throw new Error('OpenAI Responses API returned an empty answer')
  }

  return {
    answer,
    provider: 'openai-responses',
  }
}

export async function generateOpenAICompatibleChatAnswer(options: GenerateOpenAIAnswerOptions): Promise<GeneratedAnswer> {
  const response = await fetchWithOptionalProxy(options.proxyUrl)(chatCompletionsUrl(options.service.baseUrl), {
    method: 'POST',
    headers: jsonHeaders(options.apiKey),
    body: JSON.stringify({
      model: options.service.model,
      messages: [
        {
          role: 'system',
          content: systemPrompt(options.language),
        },
        {
          role: 'user',
          content: userPrompt(options.question, options.citations, options.language),
        },
      ],
      temperature: 0.2,
      max_tokens: maxOutputTokens,
    }),
  }, parsePositiveInteger(process.env.RAG_REQUEST_TIMEOUT_MS, defaultRequestTimeoutMs))

  const payload = (await readJsonResponse(response)) as ChatCompletionsPayload
  if (!response.ok) {
    throw new Error(providerErrorMessage(options.service.label, response, payload))
  }

  const answer = extractChatCompletionText(payload)
  if (!answer) {
    throw new Error(`${options.service.label} returned an empty answer`)
  }

  return {
    answer,
    provider: 'local-openai-compatible',
  }
}

function systemPrompt(language: 'ru' | 'en') {
  return language === 'ru'
    ? [
        'Ты отвечаешь на вопросы по документам.',
        'Используй только переданные фрагменты контекста.',
        'Не выдумывай факты. Если данных недостаточно, скажи об этом прямо.',
        'Отвечай кратко и по делу.',
        'Когда опираешься на фрагмент, указывай номер источника в формате [1].',
      ].join(' ')
    : [
        'You answer questions using document context.',
        'Use only the provided context chunks.',
        'Do not invent facts. If the context is insufficient, say that clearly.',
        'Keep the answer concise and practical.',
        'When using a chunk, cite it with source numbers like [1].',
      ].join(' ')
}

function userPrompt(question: string, citations: RankedChunk[], language: 'ru' | 'en') {
  const context = citations
    .map((chunk, index) => {
      const text = chunk.text.trim()
      return [
        `[${index + 1}] ${chunk.documentName}, chunk ${chunk.index + 1}`,
        text,
      ].join('\n')
    })
    .join('\n\n')
    .slice(0, maxContextChars)

  return language === 'ru'
    ? `Вопрос: ${question}\n\nКонтекст:\n${context}\n\nОтветь на русском языке.`
    : `Question: ${question}\n\nContext:\n${context}\n\nAnswer in English.`
}

function fetchWithOptionalProxy(
  proxyUrl: string | undefined,
): (url: string, init: RequestInit, timeoutMs?: number) => Promise<Response> {
  return async (url: string, init: RequestInit, timeoutMs = defaultRequestTimeoutMs) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await undiciFetch(url, {
        ...init,
        signal: controller.signal,
        ...(proxyUrl ? { dispatcher: proxyAgentFor(proxyUrl) } : {}),
      } as Parameters<typeof undiciFetch>[1]) as Response
    } finally {
      clearTimeout(timer)
    }
  }
}

function proxyAgentFor(proxyUrl: string) {
  const existingAgent = proxyAgents.get(proxyUrl)
  if (existingAgent) {
    return existingAgent
  }

  const nextAgent = new ProxyAgent(proxyUrl)
  proxyAgents.set(proxyUrl, nextAgent)
  return nextAgent
}

function responsesUrl(baseUrl: string) {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl.trim())
  const parsed = new URL(normalizedBaseUrl)
  const normalizedPath = trimTrailingSlash(parsed.pathname)

  if (normalizedPath.endsWith('/responses')) {
    return normalizedBaseUrl
  }

  if (/\/v\d+$/.test(normalizedPath)) {
    return joinUrl(normalizedBaseUrl, '/responses')
  }

  return joinUrl(normalizedBaseUrl, '/v1/responses')
}

function chatCompletionsUrl(baseUrl: string) {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl.trim())
  const parsed = new URL(normalizedBaseUrl)
  const normalizedPath = trimTrailingSlash(parsed.pathname)

  if (normalizedPath.endsWith('/chat/completions')) {
    return normalizedBaseUrl
  }

  if (/\/v\d+$/.test(normalizedPath)) {
    return joinUrl(normalizedBaseUrl, '/chat/completions')
  }

  return joinUrl(normalizedBaseUrl, '/v1/chat/completions')
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

function extractResponseText(payload: OpenAIResponsesPayload) {
  if (typeof payload.output_text === 'string') {
    return payload.output_text.trim()
  }

  const output = Array.isArray(payload.output) ? payload.output : []
  return output
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((content) => typeof content.text === 'string' ? content.text : '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function extractChatCompletionText(payload: ChatCompletionsPayload) {
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const content = choices[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

function jsonHeaders(apiKey?: string) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

function providerErrorMessage(providerName: string, response: Response, payload: unknown): string {
  const details = extractErrorMessage(payload)
  const suffix = details ? `: ${details}` : ''
  return `${providerName} returned HTTP ${response.status}${suffix}`
}

function extractErrorMessage(payload: unknown): string {
  if (typeof payload === 'string') {
    return compactMessage(payload)
  }

  if (Array.isArray(payload)) {
    return compactMessage(payload.map(extractErrorMessage).filter(Boolean).join('; '))
  }

  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const record = payload as JsonRecord
  const direct = record.message ?? record.error_description ?? record.detail
  if (direct) {
    return extractErrorMessage(direct)
  }

  const error = record.error
  if (error) {
    return extractErrorMessage(error)
  }

  const errors = record.errors
  if (errors) {
    return extractErrorMessage(errors)
  }

  return ''
}

function compactMessage(message: string) {
  return message.replace(/\s+/g, ' ').trim().slice(0, 220)
}

function joinUrl(baseUrl: string, path: string) {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBaseUrl}${normalizedPath}`
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
