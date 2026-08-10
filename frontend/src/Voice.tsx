import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './api'
import { resolveTheme, THEME_CHANGE_EVENT, type Theme } from './theme'

/** Voice всегда same-origin: /voice/ → nginx frontend → voice-web. */
function resolveVoiceAppUrl(): string {
  if (typeof window === 'undefined') return '/voice/'
  return `${window.location.origin}/voice/`
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

function iframeLooksLikeReporting(frame: HTMLIFrameElement): boolean {
  try {
    const doc = frame.contentDocument
    if (!doc) return false
    return Boolean(doc.querySelector('.workbook-header, .workbook-tabs'))
  } catch {
    // cross-origin = скорее всего настоящий Voice на другом origin
    return false
  }
}

export default function Voice() {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
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

  const handleIframeLoad = () => {
    const frame = iframeRef.current
    if (!frame) return
    if (iframeLooksLikeReporting(frame)) {
      setIframeSrc(null)
      setError(
        'Voice не поднялся: /voice/ отдал reporting. Перезапустите voice-web ' +
          'или проверьте nginx frontend (прокси на voice-web).',
      )
    }
  }

  if (error) {
    return (
      <div className="voice-embed voice-embed-status">
        <p>Не удалось открыть Voice.</p>
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
        onLoad={handleIframeLoad}
      />
    </div>
  )
}
