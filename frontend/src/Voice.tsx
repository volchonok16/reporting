import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './api'
import { resolveTheme, THEME_CHANGE_EVENT, type Theme } from './theme'

const VOICE_PROBE_PATH = '/voice/reporting-voice.txt'
const VOICE_PROBE_MARK = 'voice-ok'

/** Voice всегда same-origin: /voice/ → host nginx → frontend → voice-web. */
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

function looksLikeReportingHtml(text: string): boolean {
  const sample = text.slice(0, 4000).toLowerCase()
  return (
    sample.includes('workbook-header') ||
    sample.includes('workbook-tabs') ||
    sample.includes('id="root"') ||
    sample.includes('/assets/index-')
  )
}

async function assertVoiceUpstream(): Promise<void> {
  const response = await fetch(`${VOICE_PROBE_PATH}?t=${Date.now()}`, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Voice upstream HTTP ${response.status}. Проверьте контейнеры reporting-voice-web и reporting-frontend.`,
    )
  }
  if (!text.includes(VOICE_PROBE_MARK) || looksLikeReportingHtml(text)) {
    throw new Error(
      'Маршрут /voice/ отдал reporting SPA вместо voice-web. ' +
        'Нужен новый образ frontend (nginx-прокси) и running reporting-voice-web. ' +
        'Проверка: curl -sS http://127.0.0.1:5173/voice/reporting-voice.txt',
    )
  }
}

function iframeLooksLikeReporting(frame: HTMLIFrameElement): boolean {
  try {
    const doc = frame.contentDocument
    if (!doc) return false
    return Boolean(doc.querySelector('.workbook-header, .workbook-tabs'))
  } catch {
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
        await assertVoiceUpstream()
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
        'Voice iframe снова открыл reporting. Обновите frontend/voice-web образы и nginx.',
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
