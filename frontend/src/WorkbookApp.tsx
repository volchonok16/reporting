import { useEffect, useMemo, useState } from 'react'
import { apiFetch, clearSessionId } from './api'
import Dashboard from './Dashboard'
import DiagramBuilder from './DiagramBuilder'
import ProductStatusB2B from './ProductStatusB2B'
import Roadmap from './Roadmap'
import Departments from './org/Departments'
import EmployeeProfile from './org/EmployeeProfile'
import OrgPhoto from './org/OrgPhoto'
import ThemeToggle from './ThemeToggle'
import type { AppRole } from './App'
import { loadActiveSheet, saveActiveSheet, type SheetId } from './uiState'

type SheetTab = {
  id: SheetId
  label: string
}

const SHEETS: SheetTab[] = [
  { id: 'zni', label: 'ЗНИ' },
  { id: 'product-status-b2b', label: 'Статус продукта B2B' },
  { id: 'roadmap', label: 'Планы Digital' },
  { id: 'departments', label: 'Staffing' },
  { id: 'diagrams', label: 'Диаграммы' },
]

type WorkbookAppProps = {
  appRole: AppRole
  canSyncTfs: boolean
  canManageOrg: boolean
  orgEmployeeId: number | null
  orgEmployeePhotoUrl: string | null
  accountLabel: string | null
  onAuthRefresh: () => void
  onLogout: () => void
}

export default function WorkbookApp({
  appRole,
  canSyncTfs,
  canManageOrg,
  orgEmployeeId,
  orgEmployeePhotoUrl,
  accountLabel,
  onAuthRefresh,
  onLogout,
}: WorkbookAppProps) {
  const visibleSheets = useMemo(() => {
    let sheets =
      appRole === 'roadmap'
        ? SHEETS.filter((sheet) => sheet.id === 'roadmap' || sheet.id === 'departments')
        : SHEETS
    if (!canSyncTfs) {
      sheets = sheets.filter((sheet) => sheet.id !== 'roadmap')
    }
    return sheets
  }, [appRole, canSyncTfs])
  const visibleSheetIds = useMemo(() => new Set(visibleSheets.map((sheet) => sheet.id)), [visibleSheets])
  const [activeSheet, setActiveSheet] = useState<SheetId>(() => {
    const saved = loadActiveSheet()
    let candidate: SheetId
    if (appRole === 'roadmap') {
      candidate = saved === 'departments' ? 'departments' : 'roadmap'
    } else {
      candidate = saved
    }
    if (candidate === 'roadmap' && !canSyncTfs) {
      candidate = appRole === 'roadmap' ? 'departments' : 'zni'
    }
    return candidate
  })
  const [profileOpen, setProfileOpen] = useState(false)

  useEffect(() => {
    if (!visibleSheetIds.has(activeSheet)) {
      setActiveSheet(visibleSheets[0]?.id ?? 'zni')
    }
  }, [activeSheet, visibleSheetIds, visibleSheets])

  useEffect(() => {
    saveActiveSheet(activeSheet)
  }, [activeSheet])

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    clearSessionId()
    onLogout()
  }

  return (
    <div className="workbook">
      <header className="workbook-header">
        <nav className="workbook-tabs" aria-label="Вкладки книги">
          {visibleSheets.map((sheet) => (
            <button
              key={sheet.id}
              type="button"
              className={`workbook-tab${activeSheet === sheet.id ? ' workbook-tab-active' : ''}`}
              onClick={() => setActiveSheet(sheet.id)}
              aria-selected={activeSheet === sheet.id}
            >
              {sheet.label}
            </button>
          ))}
          <div className="workbook-header-tools">
            <ThemeToggle compact />
            <div className="workbook-header-account">
              <button
                type="button"
                className="workbook-tab workbook-profile-btn"
                onClick={() => setProfileOpen(true)}
                title="Личный кабинет"
              >
                <OrgPhoto
                  url={orgEmployeePhotoUrl}
                  name={accountLabel ?? 'Пользователь'}
                  className="workbook-header-avatar-img"
                  placeholderClassName="workbook-header-avatar"
                />
                <span className="workbook-profile-label">{accountLabel ?? 'Пользователь'}</span>
              </button>
              <button type="button" className="workbook-tab" onClick={() => void handleLogout()}>
                Выйти
              </button>
            </div>
          </div>
        </nav>
      </header>

      <div className="workbook-content">
        {activeSheet === 'zni' ? (
          <Dashboard canSyncTfs={canSyncTfs} />
        ) : activeSheet === 'roadmap' ? (
          <div className="app app-roadmap">
            <Roadmap
              canSyncTfs={canSyncTfs}
              canEditPriority={appRole === 'full'}
              canEditComment
              canEditBusinessValue={appRole === 'full'}
            />
          </div>
        ) : activeSheet === 'departments' ? (
          <div className="app">
            <Departments canManage={canManageOrg} orgEmployeeId={orgEmployeeId} />
          </div>
        ) : activeSheet === 'diagrams' ? (
          <DiagramBuilder />
        ) : (
          <div className="app">
            <ProductStatusB2B canManageOrg={canManageOrg} />
          </div>
        )}
      </div>

      {profileOpen ? (
        <EmployeeProfile
          onClose={() => {
            setProfileOpen(false)
            onAuthRefresh()
          }}
        />
      ) : null}
    </div>
  )
}
