import { useCallback, useEffect, useState } from 'react'
import { apiFetch, getSessionId } from './api'
import AppToaster from './AppToaster'
import Login from './Login'
import WorkbookApp from './WorkbookApp'

export type AppRole = 'full' | 'roadmap'

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [appRole, setAppRole] = useState<AppRole>('full')
  const [canSyncTfs, setCanSyncTfs] = useState(false)
  const [canManageOrg, setCanManageOrg] = useState(false)
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [voiceOnly, setVoiceOnly] = useState(false)
  const [planningAccess, setPlanningAccess] = useState(false)
  const [otherUser, setOtherUser] = useState(false)
  const [pageAccessRestricted, setPageAccessRestricted] = useState(false)
  const [allowedPageKeys, setAllowedPageKeys] = useState<string[]>([])
  const [orgEmployeeId, setOrgEmployeeId] = useState<number | null>(null)
  const [orgUserId, setOrgUserId] = useState<number | null>(null)
  const [orgEmployeeName, setOrgEmployeeName] = useState<string | null>(null)
  const [orgEmployeePhotoUrl, setOrgEmployeePhotoUrl] = useState<string | null>(null)
  const [username, setUsername] = useState<string | null>(null)

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
        isSuperAdmin?: boolean
        voiceOnly?: boolean
        planningAccess?: boolean
        otherUser?: boolean
        pageAccessRestricted?: boolean
        allowedPageKeys?: string[]
        orgUserId?: number | null
        orgEmployeeId?: number | null
        orgEmployeeName?: string | null
        orgEmployeePhotoUrl?: string | null
        username?: string | null
      }
      setAuthenticated(Boolean(data.authenticated))
      setAppRole(data.appRole === 'roadmap' ? 'roadmap' : 'full')
      setCanSyncTfs(Boolean(data.canSyncTfs))
      setCanManageOrg(Boolean(data.canManageOrg))
      setIsSuperAdmin(Boolean(data.isSuperAdmin))
      setVoiceOnly(Boolean(data.voiceOnly))
      setPlanningAccess(Boolean(data.planningAccess))
      setOtherUser(Boolean(data.otherUser))
      setPageAccessRestricted(Boolean(data.pageAccessRestricted))
      setAllowedPageKeys(Array.isArray(data.allowedPageKeys) ? data.allowedPageKeys : [])
      setOrgEmployeeId(typeof data.orgEmployeeId === 'number' ? data.orgEmployeeId : null)
      setOrgUserId(typeof data.orgUserId === 'number' ? data.orgUserId : null)
      setOrgEmployeeName(typeof data.orgEmployeeName === 'string' ? data.orgEmployeeName : null)
      setOrgEmployeePhotoUrl(
        typeof data.orgEmployeePhotoUrl === 'string' ? data.orgEmployeePhotoUrl : null,
      )
      setUsername(typeof data.username === 'string' ? data.username : null)
    } catch {
      setAuthenticated(false)
    }
  }, [])

  useEffect(() => {
    void loadAuthStatus()
  }, [loadAuthStatus])

  useEffect(() => {
    if (!authenticated) return
    const onFocus = () => {
      void loadAuthStatus()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [authenticated, loadAuthStatus])

  if (authenticated === null) {
    return (
      <>
        <AppToaster />
        <div className="loading">Загрузка…</div>
      </>
    )
  }

  if (!authenticated) {
    return (
      <>
        <AppToaster />
        <Login onSuccess={() => void loadAuthStatus()} />
      </>
    )
  }

  return (
    <>
      <AppToaster />
      <WorkbookApp
      appRole={appRole}
      canSyncTfs={canSyncTfs}
      canManageOrg={canManageOrg}
      isSuperAdmin={isSuperAdmin}
      voiceOnly={voiceOnly}
      planningAccess={planningAccess}
      otherUser={otherUser}
      pageAccessRestricted={pageAccessRestricted}
      allowedPageKeys={allowedPageKeys}
      orgUserId={orgUserId}
      orgEmployeeId={orgEmployeeId}
      orgEmployeePhotoUrl={orgEmployeePhotoUrl}
      accountLabel={orgEmployeeName ?? username}
      onAuthRefresh={() => void loadAuthStatus()}
      onLogout={() => setAuthenticated(false)}
    />
    </>
  )
}
