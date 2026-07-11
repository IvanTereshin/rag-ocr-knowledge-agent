import assert from 'node:assert/strict'
import test from 'node:test'
import { hashSessionToken, verifySessionTokenHash } from '../dist/security.js'

test('session token hashes use constant-time verification after strict hash validation', () => {
  const token = 'session-bound-csrf-token'
  const expectedHash = hashSessionToken(token)

  assert.equal(verifySessionTokenHash(token, expectedHash), true)
  assert.equal(verifySessionTokenHash('different-token', expectedHash), false)
  assert.equal(verifySessionTokenHash(token, ''), false)
  assert.equal(verifySessionTokenHash(token, 'ab'.repeat(31)), false)
  assert.equal(verifySessionTokenHash(token, 'ab'.repeat(33)), false)
  assert.equal(verifySessionTokenHash(token, 'zz'.repeat(32)), false)
})
