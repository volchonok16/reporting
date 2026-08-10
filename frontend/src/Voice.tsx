import { useEffect, useState } from 'react'
import { apiFetch } from './api'

const VOICE_APP_URL =
  (import.meta.env.VITE_VOICE_APP_URL as string | undefined)?.trim() || 'http://localhost:3100'

export default function Voice() {
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
        const url = new URL(VOICE_APP_URL)
        url.searchParams.set('reportingSso', data.token)
        url.searchParams.set('embed', '1')
        setIframeSrc(url.toString())
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
        className="voice-embed-frame"
        title="Voice"
        src={iframeSrc}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  )
}
