import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch } from './api'
import { resolveTheme, THEME_CHANGE_EVENT, type Theme } from './theme'

const DEFAULT_CANVAS_PORT = 8080
const PROBE_PATH = '/apps/web/reporting-canvas.txt'
const PROBE_MARK = 'canvas-ok'

function isLocalHostname(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/**
 * Базовый URL Симметрики.
 * На localhost/127.0.0.1 hostname выравниваем с вкладкой reporting (иначе cookie SSO режется).
 * В staging/prod оставляем VITE_CANVAS_STUDIO_URL как есть.
 */
function resolveCanvasBaseUrl(): string {
  const fromEnv = (import.meta.env.VITE_CANVAS_STUDIO_URL as string | undefined)?.trim()
  if (typeof window !== 'undefined') {
    const host = window.location.hostname || 'localhost'
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
    if (fromEnv) {
      try {
        const url = new URL(fromEnv)
        const envIsLocal = isLocalHostname(url.hostname)
        const pageIsLocal = isLocalHostname(host)
        if (envIsLocal && pageIsLocal) {
          url.hostname = host
        } else if (envIsLocal && !pageIsLocal) {
          // Дефолт сборки localhost:8080 не должен уводить прод на ноутбук пользователя.
          url.protocol = protocol
          url.hostname = host
          if (!url.port) url.port = String(DEFAULT_CANVAS_PORT)
        }
        return url.origin
      } catch {
        /* fall through */
      }
    }
    return `${protocol}//${host}:${DEFAULT_CANVAS_PORT}`
  }
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  return `http://localhost:${DEFAULT_CANVAS_PORT}`
}

function currentTheme(): Theme {
  const fromDom = document.documentElement.dataset.theme
  if (fromDom === 'dark' || fromDom === 'light') return fromDom
  return resolveTheme()
}

/** Токен SSO в URL не кладём — только embed + theme; сессия через postMessage. */
function buildCanvasSrc(base: string, theme: Theme): string {
  const url = new URL(base.endsWith('/') ? base : `${base}/`)
  url.searchParams.set('embed', '1')
  url.searchParams.set('theme', theme)
  if (typeof window !== 'undefined') {
    const page = new URLSearchParams(window.location.search)
    for (const key of ['file', 'comment', 'node'] as const) {
      const value = page.get(key)?.trim()
      if (value) url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

async function assertCanvasUpstream(base: string): Promise<void> {
  const response = await fetch(`${base}${PROBE_PATH}?t=${Date.now()}`, {
    method: 'GET',
    cache: 'no-store',
    mode: 'cors',
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Симметрика HTTP ${response.status}. Проверьте контейнер reporting-canvas-studio (порт ${DEFAULT_CANVAS_PORT}).`,
    )
  }
  if (!text.includes(PROBE_MARK)) {
    throw new Error('Маркер reporting-canvas.txt не найден — поднят не тот сервис.')
  }
}

async function fetchCanvasSsoToken(): Promise<string> {
  const response = await apiFetch('/api/canvas-studio/sso-token', { method: 'POST' })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail || `HTTP ${response.status}`)
  }
  const data = (await response.json()) as { token?: string }
  if (!data.token) throw new Error('Сервер не вернул SSO-токен')
  return data.token
}

function postToCanvas(
  frame: Window | null | undefined,
  targetOrigin: string,
  message: { type: string; token?: string; theme?: Theme },
): void {
  if (!frame) return
  try {
    frame.postMessage(message, targetOrigin)
  } catch {
    /* ignore */
  }
}

export default function CanvasStudio() {
  const baseUrl = useMemo(() => resolveCanvasBaseUrl(), [])
  const canvasOrigin = useMemo(() => {
    try {
      return new URL(baseUrl).origin
    } catch {
      return baseUrl
    }
  }, [baseUrl])
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ssoInflight = useRef<Promise<string> | null>(null)

  const ensureSsoToken = async (): Promise<string> => {
    if (!ssoInflight.current) {
      ssoInflight.current = fetchCanvasSsoToken().finally(() => {
        ssoInflight.current = null
      })
    }
    return ssoInflight.current
  }

  useEffect(() => {
    let cancelled = false
    // Экран не ждёт ни маркер контейнера, ни токен. Токен уходит в onLoad и по canvas-auth-required.
    setIframeSrc(buildCanvasSrc(baseUrl, currentTheme()))
    setError(null)
    void assertCanvasUpstream(baseUrl).catch((err: unknown) => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : 'Не удалось открыть Симметрику')
    })
    return () => {
      cancelled = true
    }
  }, [baseUrl, canvasOrigin])

  useEffect(() => {
    const onThemeChange = (event: Event) => {
      const theme = (event as CustomEvent<Theme>).detail
      if (theme !== 'dark' && theme !== 'light') return
      postToCanvas(iframeRef.current?.contentWindow, canvasOrigin, {
        type: 'reporting-theme',
        theme,
      })
    }

    const onFrameMessage = (event: MessageEvent) => {
      if (event.origin !== canvasOrigin) return
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type !== 'canvas-auth-required') return
      void (async () => {
        try {
          const token = await ensureSsoToken()
          postToCanvas(iframeRef.current?.contentWindow, canvasOrigin, {
            type: 'reporting-sso',
            token,
          })
        } catch {
          /* не блокируем вкладку */
        }
      })()
    }

    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)
    window.addEventListener('message', onFrameMessage)
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
      window.removeEventListener('message', onFrameMessage)
    }
  }, [canvasOrigin])

  const handleIframeLoad = () => {
    const frame = iframeRef.current?.contentWindow
    postToCanvas(frame, canvasOrigin, { type: 'reporting-theme', theme: currentTheme() })
    void ensureSsoToken()
      .then((token) => {
        postToCanvas(frame, canvasOrigin, { type: 'reporting-sso', token })
      })
      .catch(() => undefined)
  }

  if (error) {
    return (
      <div className="voice-embed voice-embed-status">
        <p>Не удалось открыть Симметрику.</p>
        <p className="org-hint">{error}</p>
        <p className="org-hint">
          Запуск:{' '}
          <code>docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build canvas-studio</code>
        </p>
        <p className="org-hint">
          Прямой адрес:{' '}
          <a href={baseUrl} target="_blank" rel="noreferrer">
            {baseUrl}
          </a>
        </p>
      </div>
    )
  }

  if (!iframeSrc) {
    return (
      <div className="voice-embed voice-embed-status">
        <p>Открываем Симметрику…</p>
      </div>
    )
  }

  return (
    <div className="voice-embed">
      <iframe
        ref={iframeRef}
        className="voice-embed-frame"
        title="Симметрика"
        src={iframeSrc}
        allow="clipboard-read; clipboard-write"
        onLoad={handleIframeLoad}
      />
    </div>
  )
}
