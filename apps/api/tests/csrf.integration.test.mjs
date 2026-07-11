import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'

async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  const { port } = address
  server.close()
  await once(server, 'close')
  return port
}

async function waitUntilReady(origin, process) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    assert.equal(process.exitCode, null, 'API exited before it became ready')
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('API did not become ready in time')
}

function sessionCookie(response) {
  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie ?? '', /^rag_ocr_session=/)
  assert.match(setCookie ?? '', /HttpOnly/i)
  assert.match(setCookie ?? '', /Secure/i)
  assert.match(setCookie ?? '', /SameSite=Lax/i)
  return setCookie.split(';', 1)[0]
}

async function register(origin, suffix) {
  const response = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      name: `CSRF user ${suffix}`,
      email: `csrf-${suffix}@example.test`,
      password: 'correct-horse-battery-staple',
    }),
  })
  assert.equal(response.status, 201)
  return sessionCookie(response)
}

async function issueToken(origin, cookie, requestOrigin = origin) {
  const response = await fetch(`${origin}/api/auth/csrf`, {
    headers: { cookie, origin: requestOrigin },
  })
  const body = await response.json()
  return { response, body }
}

async function logout(origin, cookie, csrfToken) {
  return fetch(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: {
      cookie,
      origin,
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
  })
}

test('CSRF endpoint binds rotating tokens to an authenticated same-origin session', async (t) => {
  const port = await reservePort()
  const origin = `http://127.0.0.1:${port}`
  const dataDir = await mkdtemp(join(tmpdir(), 'rag-ocr-csrf-'))
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_SECRET: 'csrf-integration-test-secret-with-more-than-32-characters',
      NODE_ENV: 'production',
      SESSION_COOKIE_SECURE: 'true',
      SESSION_COOKIE_SAMESITE: 'lax',
      APP_LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  t.after(async () => {
    child.kill('SIGTERM')
    if (child.exitCode === null) await once(child, 'exit')
    await rm(dataDir, { recursive: true, force: true })
  })

  await waitUntilReady(origin, child)

  await t.test('requires an authenticated session', async () => {
    const { response } = await issueToken(origin, 'rag_ocr_session=missing')
    assert.equal(response.status, 401)
  })

  const sessionA = await register(origin, 'a')
  const sessionB = await register(origin, 'b')

  await t.test('rejects a cross-origin token request even when it has a valid cookie', async () => {
    const { response } = await issueToken(origin, sessionA, 'https://attacker.example')
    assert.equal(response.status, 403)
  })

  await t.test('treats a scheme change as cross-origin', async () => {
    const { response } = await issueToken(origin, sessionA, origin.replace('http:', 'https:'))
    assert.equal(response.status, 403)
  })

  const first = await issueToken(origin, sessionA)
  assert.equal(first.response.status, 200)
  assert.equal(first.body.headerName, 'x-csrf-token')
  assert.equal(typeof first.body.csrfToken, 'string')
  assert(first.body.csrfToken.length >= 32)

  await t.test('rejects a missing or invalid token on a state-changing route', async () => {
    assert.equal((await logout(origin, sessionA)).status, 403)
    assert.equal((await logout(origin, sessionA, 'invalid-token')).status, 403)
  })

  await t.test('does not accept session A token with session B cookie', async () => {
    assert.equal((await logout(origin, sessionB, first.body.csrfToken)).status, 403)
  })

  const rotated = await issueToken(origin, sessionA)
  assert.equal(rotated.response.status, 200)
  assert.notEqual(rotated.body.csrfToken, first.body.csrfToken)

  await t.test('invalidates the previous token after rotation', async () => {
    assert.equal((await logout(origin, sessionA, first.body.csrfToken)).status, 403)
  })

  await t.test('accepts the current token for its own session', async () => {
    const response = await logout(origin, sessionA, rotated.body.csrfToken)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
  })
})
