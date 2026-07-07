import { isIP } from 'node:net'
import type { ServiceProvider } from './store.js'

const localServiceProviders = new Set<ServiceProvider>(['tei', 'local-llm', 'qdrant'])

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function privateOutboundAllowed() {
  return parseBooleanEnv(process.env.ALLOW_PRIVATE_OUTBOUND_URLS, process.env.NODE_ENV !== 'production')
}

export function validateOutboundServiceUrl(provider: ServiceProvider, rawUrl: string): string | undefined {
  const parsed = parseUrl(rawUrl, 'Base URL')
  if (typeof parsed === 'string') {
    return parsed
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return 'Base URL must use http or https'
  }

  const isLocalService = localServiceProviders.has(provider)
  if (!isLocalService && process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:' && !privateOutboundAllowed()) {
    return 'Cloud provider Base URL must use HTTPS in production'
  }

  return validateHost(parsed, {
    label: 'Base URL',
    allowPrivate: isLocalService || privateOutboundAllowed(),
  })
}

export function validateOutboundProxyUrl(rawUrl: string): string | undefined {
  const parsed = parseUrl(rawUrl, 'Proxy URL')
  if (typeof parsed === 'string') {
    return parsed
  }

  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
    return 'Proxy URL must use http, https, socks, socks4, or socks5'
  }

  return validateHost(parsed, {
    label: 'Proxy URL',
    allowPrivate: privateOutboundAllowed(),
  })
}

function parseUrl(rawUrl: string, label: string): URL | string {
  try {
    return new URL(rawUrl)
  } catch {
    return `${label} is invalid`
  }
}

function validateHost(parsed: URL, options: { label: string; allowPrivate: boolean }): string | undefined {
  if (options.allowPrivate) {
    return undefined
  }

  const hostname = parsed.hostname.toLowerCase()
  if (isLocalHostname(hostname)) {
    return `${options.label} cannot point to localhost in production`
  }

  if (isPrivateIp(hostname)) {
    return `${options.label} cannot point to a private or reserved IP in production`
  }

  if (isSingleLabelHostname(hostname)) {
    return `${options.label} cannot use an internal single-label hostname in production`
  }

  return undefined
}

function isLocalHostname(hostname: string) {
  return hostname === 'localhost' || hostname.endsWith('.localhost')
}

function isSingleLabelHostname(hostname: string) {
  return !hostname.includes('.') && isIP(hostname) === 0
}

function isPrivateIp(hostname: string) {
  const ipVersion = isIP(hostname)
  if (ipVersion === 4) {
    return isPrivateIpv4(hostname)
  }

  if (ipVersion === 6) {
    return isPrivateIpv6(hostname)
  }

  return false
}

function isPrivateIpv4(hostname: string) {
  const octets = hostname.split('.').map((part) => Number(part))
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }

  const [first, second] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168 ||
    first === 100 && second >= 64 && second <= 127 ||
    first === 198 && (second === 18 || second === 19) ||
    first >= 224
  )
}

function isPrivateIpv6(hostname: string) {
  const normalized = hostname.toLowerCase()
  const mappedIpv4 = ipv4FromMappedIpv6(normalized)
  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4)
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8')
  )
}

function ipv4FromMappedIpv6(hostname: string) {
  if (!hostname.startsWith('::ffff:')) {
    return undefined
  }

  const suffix = hostname.slice('::ffff:'.length)
  if (suffix.includes('.')) {
    return suffix
  }

  const parts = suffix.split(':')
  if (parts.length !== 2) {
    return undefined
  }

  const high = Number.parseInt(parts[0], 16)
  const low = Number.parseInt(parts[1], 16)
  if (![high, low].every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) {
    return undefined
  }

  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join('.')
}
