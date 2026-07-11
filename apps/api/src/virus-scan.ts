import { connect } from 'node:net'

export type VirusScanResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

export type VirusScanConfig = {
  enabled: boolean
  host: string
  port: number
  timeoutMs: number
}

export function createVirusScanConfigFromEnv(): VirusScanConfig {
  return {
    enabled: parseBooleanEnv(process.env.UPLOAD_SCAN_ENABLED, false),
    host: process.env.CLAMAV_HOST?.trim() || 'clamav',
    port: parsePositiveInteger(process.env.CLAMAV_PORT, 3310),
    timeoutMs: parsePositiveInteger(process.env.UPLOAD_SCAN_TIMEOUT_MS, 30_000),
  }
}

export async function scanUploadBuffer(buffer: Buffer, config: VirusScanConfig): Promise<VirusScanResult> {
  if (!config.enabled) {
    return { ok: true, message: 'Upload scan disabled' }
  }

  if (!buffer.length) {
    return { ok: true, message: 'Empty file accepted' }
  }

  return scanWithClamdInstream(buffer, config)
}

async function scanWithClamdInstream(buffer: Buffer, config: VirusScanConfig): Promise<VirusScanResult> {
  return await new Promise((resolve) => {
    const socket = connect({ host: config.host, port: config.port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ ok: false, message: 'Upload scanner timed out' })
    }, config.timeoutMs)
    let response = ''
    let settled = false

    function settle(result: VirusScanResult) {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    socket.once('connect', () => {
      socket.write('zINSTREAM\0')
      for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
        const chunk = buffer.subarray(offset, offset + 64 * 1024)
        const size = Buffer.allocUnsafe(4)
        size.writeUInt32BE(chunk.length, 0)
        socket.write(size)
        socket.write(chunk)
      }
      socket.write(Buffer.alloc(4))
    })

    socket.on('data', (chunk) => {
      response += chunk.toString('utf8')
    })

    socket.once('end', () => {
      const normalized = response.replace(/\0/g, '').trim()
      if (!normalized) {
        settle({ ok: false, message: 'Upload scanner returned an empty response' })
        return
      }

      if (/\bOK\b/i.test(normalized)) {
        settle({ ok: true, message: normalized })
        return
      }

      settle({ ok: false, message: normalized })
    })

    socket.once('error', (error) => {
      settle({ ok: false, message: `Upload scanner error: ${error.message}` })
    })
  })
}

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
