const SESSION_KEY = 'reportingSessionId'

function resolveApiBase(): string {
  const fromEnv = (import.meta.env.VITE_API_URL as string | undefined)?.trim().replace(/\/$/, '') ?? ''
  if (typeof window === 'undefined') return fromEnv

  const { hostname, protocol } = window.location
  const isPallinkHost = hostname === 'pallink.fun' || hostname === 'www.pallink.fun'

  if (isPallinkHost) {
    // nginx на pallink.fun проксирует /api/ → backend; same-origin без CORS
    return `${protocol}//${hostname}`
  }

  const envPointsToLocal =
    !fromEnv || fromEnv.includes('localhost') || fromEnv.includes('127.0.0.1')
  if ((hostname === 'localhost' || hostname === '127.0.0.1') && envPointsToLocal) {
    return `${protocol}//${hostname}:8000`
  }
  return fromEnv
}

const apiBase = resolveApiBase()

/** Публичный URL фото сотрудника (через API, не через localhost MinIO). */
export function resolvePhotoUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return trimmed
  }

  const rewriteMinioPath = (path: string) => `${apiBase}/api/org/photos/${path.replace(/^\/+/, '')}`

  if (/^https?:\/\//i.test(trimmed)) {
    const localMinio = trimmed.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|minio)(?::\d+)?\/([^/]+)\/(.+)$/i)
    if (localMinio) {
      return rewriteMinioPath(localMinio[2])
    }
    return trimmed
  }

  if (trimmed.startsWith('/api/')) {
    return `${apiBase}${trimmed}`
  }

  return rewriteMinioPath(trimmed)
}

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

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
  return (await response.json()) as T
}

export async function putJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
  return (await response.json()) as T
}

export async function deleteJson(path: string): Promise<void> {
  const response = await apiFetch(path, { method: 'DELETE' })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
}

export async function postForm<T>(path: string, formData: FormData): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    body: formData,
  })
  if (!response.ok) {
    throw new Error(await readApiError(response))
  }
  return (await response.json()) as T
}
