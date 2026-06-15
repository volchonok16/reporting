const SESSION_KEY = 'reportingSessionId'

function resolveApiBase(): string {
  const fromEnv = (import.meta.env.VITE_API_URL as string | undefined)?.trim().replace(/\/$/, '') ?? ''
  if (typeof window === 'undefined') return fromEnv

  const { hostname, protocol } = window.location
  const isPallinkHost = hostname === 'pallink.fun' || hostname === 'www.pallink.fun'

  if (isPallinkHost) {
    return 'https://api.pallink.fun'
  }

  const envPointsToLocal =
    !fromEnv || fromEnv.includes('localhost') || fromEnv.includes('127.0.0.1')
  if ((hostname === 'localhost' || hostname === '127.0.0.1') && envPointsToLocal) {
    return `${protocol}//${hostname}:8000`
  }
  return fromEnv
}

const apiBase = resolveApiBase()

export function getSessionId(): string | null {
  return localStorage.getItem(SESSION_KEY)
}

export function setSessionId(sessionId: string) {
  localStorage.setItem(SESSION_KEY, sessionId)
}

export function clearSessionId() {
  localStorage.removeItem(SESSION_KEY)
}

export async function readApiError(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const data = JSON.parse(text) as { detail?: unknown }
    if (typeof data.detail === 'string') {
      return data.detail
    }
  } catch {
    /* not json */
  }
  return text || response.statusText
}

function formatFetchError(path: string, cause: unknown): Error {
  const target = apiBase ? `${apiBase}${path}` : path
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(`Не удалось подключиться к API (${target}). ${detail}`)
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const sessionId = getSessionId()
  if (sessionId) {
    headers.set('X-Session-Id', sessionId)
  }
  try {
    return await fetch(`${apiBase}${path}`, { ...init, headers })
  } catch (cause) {
    throw formatFetchError(path, cause)
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
  return (await response.json()) as T
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
  return (await response.json()) as T
}
