import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { File } from 'node:buffer'

const rootDir = process.cwd()
const apiDistPath = join(rootDir, 'apps/api/dist/server.js')
const smokePhrase = `LOCAL_SMOKE_PHRASE_${randomUUID().slice(0, 8)}`
const smokeQuestion = 'What unique phrase is in the uploaded document?'

const logs = {
  fakeLlm: [],
  api: [],
}

class CookieJar {
  constructor() {
    this.cookie = ''
  }

  capture(response) {
    const setCookie = response.headers.get('set-cookie')
    if (!setCookie) {
      return
    }
    this.cookie = setCookie.split(';')[0] ?? ''
  }

  headers() {
    return this.cookie ? { Cookie: this.cookie } : {}
  }
}

let fakeLlmServer
let fakeLlmPort
let apiProcess
let apiPort
let dataDir

process.once('SIGINT', handleInterrupt)
process.once('SIGTERM', handleInterrupt)

await main().catch(async (error) => {
  console.error('\nSmoke test failed.')
  console.error(error instanceof Error ? error.stack || error.message : error)
  printLogs()
  process.exitCode = 1
}).finally(async () => {
  await cleanup()
})

async function main() {
  await assertBuilt()
  dataDir = await mkdtemp(join(tmpdir(), 'rag-ocr-smoke-'))

  fakeLlmServer = createFakeLlmServer()
  fakeLlmPort = await listenOnFreePort(fakeLlmServer)

  apiPort = await reservePort()
  apiProcess = spawn(process.execPath, [apiDistPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      APP_SECRET: `smoke-secret-${randomUUID()}`,
      DATA_DIR: dataDir,
      PORT: String(apiPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipeProcessLogs(apiProcess, logs.api, '[api]')

  await waitForUrl(`http://127.0.0.1:${apiPort}/api/health`, 30_000, 'API did not start')

  const cookieJar = new CookieJar()
  const baseUrl = `http://127.0.0.1:${apiPort}`

  console.log('[1/5] register user')
  await fetchJson(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: 'Smoke Tester',
      email: `smoke-${Date.now()}@example.com`,
      password: 'smoke-test-password',
    }),
  }, cookieJar)

  console.log('[2/5] load csrf token')
  const csrfPayload = await fetchJson(`${baseUrl}/api/auth/csrf`, {
    method: 'GET',
    headers: cookieJar.headers(),
  }, cookieJar)
  assert(typeof csrfPayload.csrfToken === 'string' && csrfPayload.csrfToken.length > 0, 'CSRF token was not returned')
  const csrfHeaderName = typeof csrfPayload.headerName === 'string' && csrfPayload.headerName.length > 0
    ? csrfPayload.headerName
    : 'x-csrf-token'

  console.log('[3/5] save local-llm settings')
  const settingsPayload = await fetchJson(`${baseUrl}/api/settings/services`, {
    method: 'PUT',
    headers: jsonHeaders({
      ...cookieJar.headers(),
      [csrfHeaderName]: csrfPayload.csrfToken,
    }),
    body: JSON.stringify({
      services: [
        {
          provider: 'local-llm',
          enabled: true,
          label: 'Smoke Local LLM',
          baseUrl: `http://127.0.0.1:${fakeLlmPort}/v1`,
          model: 'smoke-local-model',
        },
      ],
    }),
  }, cookieJar)

  const localLlmService = Array.isArray(settingsPayload.services)
    ? settingsPayload.services.find((service) => service.provider === 'local-llm')
    : null
  assert(localLlmService?.validation?.status === 'valid', `local-llm validation failed: ${JSON.stringify(localLlmService?.validation)}`)

  console.log('[4/5] upload text file')
  const uploadText = [
    'This document is used for the local smoke test.',
    `Unique phrase: ${smokePhrase}`,
    'The answer should come from the local LLM path.',
  ].join('\n')
  const uploadPayload = new FormData()
  uploadPayload.append('files', new File([uploadText], 'smoke.txt', { type: 'text/plain' }))

  const uploadResult = await fetchJson(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: {
      ...cookieJar.headers(),
      [csrfHeaderName]: csrfPayload.csrfToken,
    },
    body: uploadPayload,
  }, cookieJar)

  assert(Array.isArray(uploadResult.documents) && uploadResult.documents.length === 1, 'Upload did not return one document')
  assert(uploadResult.documents[0].status === 'ready', `Document is not ready: ${JSON.stringify(uploadResult.documents[0])}`)

  console.log('[5/5] ask in local mode')
  const askPayload = await fetchJson(`${baseUrl}/api/ask`, {
    method: 'POST',
    headers: jsonHeaders({
      ...cookieJar.headers(),
      [csrfHeaderName]: csrfPayload.csrfToken,
    }),
    body: JSON.stringify({
      question: smokeQuestion,
      mode: 'local',
    }),
  }, cookieJar)

  assert(askPayload.mode === 'local', `Expected local mode, got ${askPayload.mode}`)
  assert(askPayload.answerEngine === 'local-openai-compatible', `Unexpected answer engine: ${askPayload.answerEngine}`)
  assert(typeof askPayload.answer === 'string' && askPayload.answer.includes(smokePhrase), `Answer does not include smoke phrase: ${askPayload.answer}`)
  assert(Array.isArray(askPayload.citations) && askPayload.citations.length > 0, 'No citations returned')

  console.log(`Smoke test passed: local RAG + local LLM are working. Phrase: ${smokePhrase}`)
}

async function assertBuilt() {
  if (!existsSync(apiDistPath)) {
    throw new Error('apps/api/dist/server.js not found. Run `npm run build` first.')
  }
}

async function fetchJson(url, init, cookieJar) {
  const response = await fetch(url, {
    ...init,
    headers: init.headers,
  })
  cookieJar.capture(response)

  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }

  if (!response.ok) {
    throw new Error(`Request failed ${init.method ?? 'GET'} ${url}: HTTP ${response.status} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`)
  }

  return payload
}

function jsonHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...extra,
  }
}

function createFakeLlmServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        writeJson(res, 200, {
          object: 'list',
          data: [{ id: 'smoke-local-model', object: 'model' }],
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJsonBody(req)
        const payloadText = JSON.stringify(body)
        logs.fakeLlm.push(`[chat] ${payloadText}`)
        if (!payloadText.includes(smokePhrase)) {
          writeJson(res, 500, { error: { message: `Smoke phrase was not forwarded to local LLM: ${smokePhrase}` } })
          return
        }

        writeJson(res, 200, {
          id: `chatcmpl-${randomUUID()}`,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `Smoke answer confirmed: ${smokePhrase}`,
              },
              finish_reason: 'stop',
            },
          ],
        })
        return
      }

      writeJson(res, 404, { error: 'Not found' })
    } catch (error) {
      writeJson(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  })
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

async function listenOnFreePort(server) {
  return await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine listen port'))
        return
      }
      resolve(address.port)
    })
  })
}

async function reservePort() {
  const server = createServer()
  const port = await listenOnFreePort(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForUrl(url, timeoutMs, errorMessage) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await sleep(250)
  }

  throw new Error(`${errorMessage}${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ''}`)
}

function pipeProcessLogs(child, target, prefix) {
  const push = (chunk) => {
    const text = chunk.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line) {
        continue
      }
      target.push(`${prefix} ${line}`)
      if (target.length > 250) {
        target.shift()
      }
    }
  }

  child.stdout?.on('data', push)
  child.stderr?.on('data', push)
}

function printLogs() {
  if (logs.fakeLlm.length) {
    console.error('\nFake LLM logs:')
    for (const line of logs.fakeLlm.slice(-40)) {
      console.error(line)
    }
  }

  if (logs.api.length) {
    console.error('\nAPI logs:')
    for (const line of logs.api.slice(-80)) {
      console.error(line)
    }
  }
}

async function cleanup() {
  if (apiProcess) {
    await terminateProcess(apiProcess)
  }

  if (fakeLlmServer) {
    await new Promise((resolve) => fakeLlmServer.close(resolve))
  }

  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true })
  }
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
}

async function terminateProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const exited = waitForExit(child)
  child.kill('SIGTERM')

  try {
    await Promise.race([
      exited,
      sleep(5_000).then(() => {
        throw new Error('Process did not exit after SIGTERM')
      }),
    ])
  } catch {
    child.kill('SIGKILL')
    await exited.catch(() => {})
  }
}

async function handleInterrupt(signal) {
  process.exitCode = signal === 'SIGINT' ? 130 : 143
  printLogs()
  await cleanup()
  process.exit(process.exitCode ?? 1)
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
