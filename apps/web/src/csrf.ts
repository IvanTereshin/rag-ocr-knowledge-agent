type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Compatibility boundary for the original portfolio demo backend.
 * Only an exact same-origin 404 from the fixed `/api/auth/csrf` endpoint means
 * "legacy backend without CSRF support". Auth errors, server errors, malformed
 * payloads, and network failures remain hard failures.
 */
export async function requestCsrfToken(fetchImpl: FetchLike = fetch): Promise<string | null> {
  const response = await fetchImpl('/api/auth/csrf', {
    credentials: 'include',
  })

  if (response.status === 404) {
    return null
  }

  const payload = (await response.json().catch(() => ({}))) as {
    csrfToken?: unknown
    error?: unknown
  }

  if (!response.ok) {
    const message = typeof payload.error === 'string' ? payload.error : 'CSRF endpoint is unavailable'
    throw new Error(`Не удалось получить CSRF-токен: ${message}`)
  }

  if (typeof payload.csrfToken !== 'string' || payload.csrfToken.length === 0) {
    throw new Error('Не удалось получить CSRF-токен: сервер вернул пустой или некорректный ответ')
  }

  return payload.csrfToken
}
