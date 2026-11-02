import { useEffect, useMemo, useRef, useState } from 'react'
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

/** SSO-токен в URL не кладём — только embed + theme; сессия через postMessage. */
function buildVoiceSrc(theme: Theme): string {
  const url = new URL(resolveVoiceAppUrl())
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
  const okMark = text.includes(VOICE_PROBE_MARK)
  if (!okMark || looksLikeReportingHtml(text)) {
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

async function fetchReportingSsoToken(): Promise<string> {
  const response = await apiFetch('/api/voice/sso-token', { method: 'POST' })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail || `HTTP ${response.status}`)
  }
  const data = (await response.json()) as { token?: string }
  if (!data.token) throw new Error('Сервер не вернул SSO-токен')
  return data.token
}

function postToVoice(
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

export default function Voice() {
  const voiceOrigin = useMemo(() => window.location.origin, [])
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeSrc, setIframeSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ssoInflight = useRef<Promise<string> | null>(null)

  const ensureSsoToken = async (): Promise<string> => {
    if (!ssoInflight.current) {
      ssoInflight.current = fetchReportingSsoToken().finally(() => {
        ssoInflight.current = null
      })
    }
    return ssoInflight.current
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [, token] = await Promise.all([
          assertVoiceUpstream(),
          ensureSsoToken().catch(() => ''),
        ])
        if (cancelled) return
        setIframeSrc(buildVoiceSrc(currentTheme()))
        setError(null)
        const send = (sso: string) => {
          postToVoice(iframeRef.current?.contentWindow, voiceOrigin, {
            type: 'reporting-sso',
            token: sso,
          })
        }
        if (token) {
          window.setTimeout(() => {
            if (!cancelled) send(token)
          }, 0)
        } else {
          void ensureSsoToken()
            .then((lateToken) => {
              if (!cancelled) send(lateToken)
            })
            .catch(() => undefined)
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Не удалось открыть Voice')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [voiceOrigin])

  useEffect(() => {
    const onThemeChange = (event: Event) => {
      const theme = (event as CustomEvent<Theme>).detail
      if (theme !== 'dark' && theme !== 'light') return
      postToVoice(iframeRef.current?.contentWindow, voiceOrigin, {
        type: 'reporting-theme',
        theme,
      })
    }

    const onFrameMessage = (event: MessageEvent) => {
      if (event.origin !== voiceOrigin) return
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type !== 'voice-auth-required') return
      void (async () => {
        try {
          const token = await ensureSsoToken()
          postToVoice(iframeRef.current?.contentWindow, voiceOrigin, {
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
  }, [voiceOrigin])

  const handleIframeLoad = () => {
    const frame = iframeRef.current
    if (!frame) return
    if (iframeLooksLikeReporting(frame)) {
      setIframeSrc(null)
      setError('Voice iframe снова открыл reporting. Обновите frontend/voice-web образы и nginx.')
      return
    }
    postToVoice(frame.contentWindow, voiceOrigin, {
      type: 'reporting-theme',
      theme: currentTheme(),
    })
    void ensureSsoToken()
      .then((token) => {
        postToVoice(frame.contentWindow, voiceOrigin, { type: 'reporting-sso', token })
      })
      .catch(() => undefined)
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
