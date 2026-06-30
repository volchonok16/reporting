import { useCallback, useEffect, useState } from 'react'
import { apiFetch, getSessionId } from './api'
import Login from './Login'
import WorkbookApp from './WorkbookApp'

export type AppRole = 'full' | 'roadmap'

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [appRole, setAppRole] = useState<AppRole>('full')
  const [canSyncTfs, setCanSyncTfs] = useState(false)
  const [canManageOrg, setCanManageOrg] = useState(false)
  const [orgEmployeeId, setOrgEmployeeId] = useState<number | null>(null)

  const loadAuthStatus = useCallback(async () => {
    const sessionId = getSessionId()
    if (!sessionId) {
      setAuthenticated(false)
      return
    }
    try {
      const response = await apiFetch('/api/auth/status')
      const data = (await response.json()) as {
        authenticated?: boolean
        appRole?: AppRole
        canSyncTfs?: boolean
        canManageOrg?: boolean
        orgUserId?: number | null
        orgEmployeeId?: number | null
      }
      setAuthenticated(Boolean(data.authenticated))
      setAppRole(data.appRole === 'roadmap' ? 'roadmap' : 'full')
      setCanSyncTfs(Boolean(data.canSyncTfs))
      setCanManageOrg(Boolean(data.canManageOrg))
      setOrgEmployeeId(typeof data.orgEmployeeId === 'number' ? data.orgEmployeeId : null)
    } catch {
      setAuthenticated(false)
    }
  }, [])

  useEffect(() => {
    void loadAuthStatus()
  }, [loadAuthStatus])

  if (authenticated === null) {
    return <div className="loading">Загрузка…</div>
  }

  if (!authenticated) {
    return <Login onSuccess={() => void loadAuthStatus()} />
  }

  return (
    <WorkbookApp
      appRole={appRole}
      canSyncTfs={canSyncTfs}
      canManageOrg={canManageOrg}
      orgEmployeeId={orgEmployeeId}
      onLogout={() => setAuthenticated(false)}
    />
  )
}
