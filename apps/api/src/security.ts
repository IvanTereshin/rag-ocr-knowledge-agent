import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { EncryptedSecret } from './store.js'

const keySalt = 'rag-ocr-agent-settings-v1'
const localDevelopmentSecret = 'local-development-secret-change-me'

export function assertAppSecretIsSafe(): void {
  const secret = process.env.APP_SECRET?.trim()

  if (process.env.NODE_ENV !== 'production') {
    return
  }

  if (!secret) {
    throw new Error('APP_SECRET is required in production')
  }

  if (secret === localDevelopmentSecret || secret.startsWith('replace-with-')) {
    throw new Error('APP_SECRET must be changed before production startup')
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const passwordHash = scryptSync(password, salt, 64).toString('hex')
  return { passwordHash, passwordSalt: salt }
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function getEncryptionKey(): Buffer {
  const secret = process.env.APP_SECRET?.trim() || localDevelopmentSecret
  return scryptSync(secret, keySalt, 32)
}

export function encryptSecret(rawValue: string): EncryptedSecret {
  const trimmed = rawValue.trim()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    value: encrypted.toString('base64url'),
    last4: trimmed.slice(-4),
  }
}

export function decryptSecret(secret: EncryptedSecret): string {
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(secret.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(secret.value, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

export function maskSecret(secret?: EncryptedSecret) {
  if (!secret) {
    return { hasApiKey: false, apiKeyLast4: '' }
  }

  return {
    hasApiKey: true,
    apiKeyLast4: secret.last4,
  }
}
