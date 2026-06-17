import { useEffect, useState } from 'react'
import { apiFetch, clearSessionId } from './api'
import Dashboard from './Dashboard'
import ProductStatusB2B from './ProductStatusB2B'
import Roadmap from './Roadmap'
import type { AppRole } from './App'
import { loadActiveSheet, saveActiveSheet, type SheetId } from './uiState'

type SheetTab = {
  id: SheetId
  label: string
}

const SHEETS: SheetTab[] = [
  { id: 'zni', label: 'ЗНИ' },
  { id: 'product-status-b2b', label: 'Статус продукта B2B' },
  { id: 'roadmap', label: 'Roadmap' },
]

type WorkbookAppProps = {
  appRole: AppRole
  canSyncTfs: boolean
  onLogout: () => void
}

export default function WorkbookApp({ appRole, canSyncTfs, onLogout }: WorkbookAppProps) {
  const visibleSheets = appRole === 'roadmap' ? SHEETS.filter((sheet) => sheet.id === 'roadmap') : SHEETS
  const [activeSheet, setActiveSheet] = useState<SheetId>(() =>
    appRole === 'roadmap' ? 'roadmap' : loadActiveSheet(),
  )

  useEffect(() => {
    if (appRole === 'roadmap') {
      setActiveSheet('roadmap')
    }
  }, [appRole])

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
        </nav>
      </header>

      <div className="workbook-content">
        {activeSheet === 'zni' ? (
          <Dashboard onLogout={() => void handleLogout()} />
        ) : activeSheet === 'roadmap' ? (
          <div className="app">
            <header className="workbook-page-toolbar">
              <button type="button" className="btn-ghost" onClick={() => void handleLogout()}>
                Выйти
              </button>
            </header>
            <Roadmap canSyncTfs={canSyncTfs} />
          </div>
        ) : (
          <div className="app">
            <header className="workbook-page-toolbar">
              <button type="button" className="btn-ghost" onClick={() => void handleLogout()}>
                Выйти
              </button>
            </header>
            <ProductStatusB2B />
          </div>
        )}
      </div>
    </div>
  )
}
