const CACHE_PREFIX = 'reporting:product-status:'
const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000

type CachedProductStatusPayload = {
  title: string
  sourceUrl?: string | null
  presentationReferenceUrl?: string | null
  sheets: Array<{
    gid: string
    name: string
    columns: string[]
    rows: Record<string, string>[]
    totalShown: number
  }>
}

type CacheEntry = {
  cachedAt: number
  payload: CachedProductStatusPayload
}

function cacheKey(
  apiBase: string,
  options?: { gid?: string | null; metaOnly?: boolean },
): string {
  if (options?.metaOnly) {
    return `${CACHE_PREFIX}${apiBase}:meta`
  }
  if (options?.gid) {
    return `${CACHE_PREFIX}${apiBase}:gid:${options.gid}`
  }
  return `${CACHE_PREFIX}${apiBase}:all`
}

function readEntry(key: string): CacheEntry | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry
    if (!entry?.payload || typeof entry.cachedAt !== 'number') {
      sessionStorage.removeItem(key)
      return null
    }
    if (Date.now() - entry.cachedAt > CLIENT_CACHE_TTL_MS) {
      sessionStorage.removeItem(key)
      return null
    }
    return entry
  } catch {
    sessionStorage.removeItem(key)
    return null
  }
}

export function readProductStatusCache(
  apiBase: string,
  options?: { gid?: string | null; metaOnly?: boolean },
): CachedProductStatusPayload | null {
  return readEntry(cacheKey(apiBase, options))?.payload ?? null
}

export function writeProductStatusCache(
  apiBase: string,
  payload: CachedProductStatusPayload,
  options?: { gid?: string | null; metaOnly?: boolean },
): void {
  try {
    const entry: CacheEntry = { cachedAt: Date.now(), payload }
    sessionStorage.setItem(cacheKey(apiBase, options), JSON.stringify(entry))
  } catch {
    // sessionStorage may be full or unavailable — ignore
  }
}

export function clearProductStatusCache(apiBase: string): void {
  const prefix = `${CACHE_PREFIX}${apiBase}:`
  const keysToRemove: string[] = []
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const key = sessionStorage.key(index)
    if (key?.startsWith(prefix)) {
      keysToRemove.push(key)
    }
  }
  for (const key of keysToRemove) {
    sessionStorage.removeItem(key)
  }
}
