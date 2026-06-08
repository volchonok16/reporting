import { useEffect, useState } from 'react'
import { apiFetch, getSessionId } from './api'
import Login from './Login'
import WorkbookApp from './WorkbookApp'

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)

  useEffect(() => {
    const sessionId = getSessionId()
    if (!sessionId) {
      setAuthenticated(false)
      return
    }
    void apiFetch('/api/auth/status')
      .then((response) => response.json())
      .then((data: { authenticated?: boolean }) => setAuthenticated(Boolean(data.authenticated)))
      .catch(() => setAuthenticated(false))
  }, [])

  if (authenticated === null) {
    return <div className="loading">Загрузка…</div>
  }

  if (!authenticated) {
    return <Login onSuccess={() => setAuthenticated(true)} />
  }

  return <WorkbookApp onLogout={() => setAuthenticated(false)} />
}
