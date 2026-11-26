import { useEffect, useRef, useState } from 'react'
import { apiFetch } from './api'
import { resolveTheme, THEME_CHANGE_EVENT } from './theme'

type Connection = { status: 'loading' | 'ready' } | { status: 'error'; message: string }

export default function DogtagsManager() {
  const frame = useRef<HTMLIFrameElement>(null)
  const [connection, setConnection] = useState<Connection>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setConnection({ status: 'loading' })
    void (async () => {
      try {
        const response = await apiFetch('/api/dogtags-manager/health')
        const payload = await response.json() as { error?: { message?: string }; detail?: string }
        if (!response.ok) throw new Error(payload.error?.message ?? payload.detail ?? 'Не удалось подключить Dogtags Manager')
        if (active) setConnection({ status: 'ready' })
      } catch (cause) {
        if (active) setConnection({ status: 'error', message: cause instanceof Error ? cause.message : 'Не удалось подключить Dogtags Manager' })
      }
    })()
    return () => { active = false }
  }, [attempt])

  useEffect(() => {
    const sync = () => frame.current?.contentWindow?.postMessage({ type: 'reporting-theme', theme: resolveTheme() }, window.location.origin)
    window.addEventListener(THEME_CHANGE_EVENT, sync)
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync)
  }, [])

  if (connection.status === 'error') return <div className="voice-embed voice-embed-status" role="alert">
    <h2>Dogtags Manager недоступен</h2>
    <p>{connection.message}</p>
    <button className="btn-primary" onClick={() => setAttempt(value => value + 1)}>Повторить подключение</button>
  </div>
  if (connection.status === 'loading') return <div className="voice-embed voice-embed-status" role="status"><p>Подключаем Dogtags Manager…</p></div>
  return <div className="voice-embed dogtags-embed">
    <iframe ref={frame} className="voice-embed-frame" title="Dogtags Manager"
      src="/dogtags-manager/" allow="clipboard-read; clipboard-write" />
  </div>
}
