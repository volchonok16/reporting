import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './api'
import { resolveTheme, THEME_CHANGE_EVENT, type Theme } from './theme'

function isLocalHostUrl(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(value)
}

function isBrowserOnLocalHost(): boolean {
  if (typeof window === 'undefined') return false
  return /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname)
}

/** Reporting оказался внутри iframe — значит /voice/ отдал SPA, а не voice-web. */
function isNestedReportingFrame(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

function resolveVoiceAppUrl(): string {
  const fromEnv = (import.meta.env.VITE_VOICE_APP_URL as string | undefined)?.trim()
  // В docker-dev оставляем localhost:3100; на сервере localhost из .env игнорируем.
  if (fromEnv) {
    if (!isLocalHostUrl(fromEnv) || isBrowserOnLocalHost()) {
      return fromEnv.replace(/\/$/, '') + '/'
    }
  }
  if (typeof window !== 'undefined') {
    if (isBrowserOnLocalHost()) {
      return `${window.location.protocol}//${window.location.hostname}:3100/`
    }
    // Same-origin через nginx: /voice/ → voice-web :3100
    return `${window.location.origin}/voice/`
  }
  return 'http://localhost:3100/'
}

function currentTheme(): Theme {
  const fromDom = document.documentElement.dataset.theme
  if (fromDom === 'dark' || fromDom === 'light') return fromDom
  return resolveTheme()
}

function buildVoiceSrc(token: string, theme: Theme): string {
  const url = new URL(resolveVoiceAppUrl())
  url.searchParams.set('reportingSso', token)
  url.searchParams.set('embed', '1')
  url.searchParams.set('theme', theme)
  return url.toString()
}

export default function Voice() {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isNestedReportingFrame()) {
      setError(
        'Voice недоступен: /voice/ открыл reporting вместо voice-web. ' +
          'Проверьте, что контейнер reporting-voice-web запущен и nginx проксирует /voice/.',
      )
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await apiFetch('/api/voice/sso-token', { method: 'POST' })
        if (!response.ok) {
          const detail = await response.text()
          throw new Error(detail || `HTTP ${response.status}`)
        }
        const data = (await response.json()) as { token?: string }
        if (!data.token) throw new Error('Сервер не вернул SSO-токен')
        if (cancelled) return
        setIframeSrc(buildVoiceSrc(data.token, currentTheme()))
        setError(null)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Не удалось открыть Voice')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onThemeChange = (event: Event) => {
      const theme = (event as CustomEvent<Theme>).detail
      if (theme !== 'dark' && theme !== 'light') return
      const frame = iframeRef.current?.contentWindow
      if (!frame) return
      frame.postMessage({ type: 'reporting-theme', theme }, '*')
    }
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange)
  }, [])

  if (error) {
    return (
      <div className="voice-embed voice-embed-status">
        <p>Не удалось войти в Voice через reporting.</p>
        <p className="org-hint">{error}</p>
      </div>
    )
  }

  if (!iframeSrc) {
    return (
      <div className="voice-embed voice-embed-status">
        <p>Открываем Voice…</p>
      </div>
    )
  }

  return (
    <div className="voice-embed">
      <iframe
        ref={iframeRef}
        className="voice-embed-frame"
        title="Voice"
        src={iframeSrc}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  )
}
