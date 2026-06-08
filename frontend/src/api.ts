const SESSION_KEY = 'reportingSessionId'

function resolveApiBase(): string {
  const fromEnv = (import.meta.env.VITE_API_URL as string | undefined)?.trim().replace(/\/$/, '') ?? ''
  if (typeof window === 'undefined') return fromEnv

  const { hostname, protocol } = window.location
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

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const sessionId = getSessionId()
  if (sessionId) {
    headers.set('X-Session-Id', sessionId)
  }
  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  return response
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path)
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
  return (await response.json()) as T
}
