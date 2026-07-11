import assert from 'node:assert/strict'
import test from 'node:test'
import { requestCsrfToken } from '../src/csrf.ts'

const response = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

test('modern backend returns a token', async () => {
  const token = await requestCsrfToken(async (url, init) => {
    assert.equal(url, '/api/auth/csrf')
    assert.equal(init.credentials, 'include')
    return response(200, { csrfToken: 'modern-token' })
  })

  assert.equal(token, 'modern-token')
})

test('legacy fallback is allowed only for the fixed endpoint 404', async () => {
  const token = await requestCsrfToken(async (url) => {
    assert.equal(url, '/api/auth/csrf')
    return response(404, { error: 'Not found' })
  })

  assert.equal(token, null)
})

for (const status of [401, 403, 500, 503]) {
  test(`HTTP ${status} remains a hard failure`, async () => {
    await assert.rejects(
      requestCsrfToken(async () => response(status, { error: `failure-${status}` })),
      new RegExp(`failure-${status}`),
    )
  })
}

test('network and malformed success responses remain hard failures', async () => {
  await assert.rejects(requestCsrfToken(async () => { throw new Error('network down') }), /network down/)
  await assert.rejects(requestCsrfToken(async () => response(200, {})), /пустой или некорректный/)
})
