import { useCallback, useEffect, useState } from 'react'
import { apiFetch, clearSessionId, getJson } from './api'

const ALL_BOARDS = 'all'

type Board = {
  code: string
  name: string
  displayName: string
}

type LinkedError = {
  id: string
  title: string
}

type ChangeRequest = {
  number: string
  title: string
  status?: string | null
  boardName?: string | null
  errors: LinkedError[]
}

type DashboardData = {
  board: Board | null
  allBoards: boolean
  metrics: {
    totalTasks: number
    launchingSoon: number
    launched: number
    errorsCount: number
  }
  items: ChangeRequest[]
  totalShown: number
}

type DashboardProps = {
  onLogout: () => void
}

const SORT_OPTIONS = [
  { value: 'id_desc', label: 'Номер ЗНИ (убыв.)' },
  { value: 'id_asc', label: 'Номер ЗНИ (возр.)' },
  { value: 'release_date_desc', label: 'Целевая дата (убыв.)' },
  { value: 'release_date_asc', label: 'Целевая дата (возр.)' },
  { value: 'start_date_desc', label: 'Дата начала (убыв.)' },
]

export default function Dashboard({ onLogout }: DashboardProps) {
  const [boards, setBoards] = useState<Board[]>([])
  const [boardCode, setBoardCode] = useState(ALL_BOARDS)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('id_desc')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getJson<Board[]>('/api/boards')
      .then((items) => {
        setBoards(items)
        if (items.length > 0) {
          setBoardCode(items[0].code)
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки досок'))
  }, [])

  const loadDashboard = useCallback(async () => {
    if (!boardCode) return
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ board: boardCode, sort })
    if (search.trim()) params.set('search', search.trim())
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    try {
      const payload = await getJson<DashboardData>(`/api/dashboard?${params}`)
      setData(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [boardCode, search, sort, dateFrom, dateTo])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const handleSync = async () => {
    setSyncing(true)
    setSyncProgress('Старт…')
    setError(null)
    try {
      const params = boardCode ? `?board=${encodeURIComponent(boardCode)}` : ''
      const response = await apiFetch(`/api/sync${params}`, { method: 'POST' })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || 'Ошибка синхронизации')
      }
      const sync = (await response.json()) as { id: number }
      const poll = async () => {
        const status = await getJson<{
          status: string
          errorMessage?: string | null
          progressMessage?: string | null
        }>(`/api/sync/${sync.id}`)
        if (status.progressMessage) {
          setSyncProgress(status.progressMessage)
        }
        if (status.status === 'running') {
          setTimeout(poll, 1500)
          return
        }
        if (status.status === 'failed') {
          throw new Error(status.errorMessage || 'Синхронизация не удалась')
        }
        setSyncProgress(null)
        await loadDashboard()
        setSyncing(false)
      }
      void poll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации')
      setSyncProgress(null)
      setSyncing(false)
    }
  }

  const handleExport = async () => {
    try {
      const params = boardCode ? `?board=${encodeURIComponent(boardCode)}` : ''
      const response = await apiFetch(`/api/export${params}`)
      if (!response.ok) {
        throw new Error('Не удалось выгрузить отчёт')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'zni-report.csv'
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка выгрузки')
    }
  }

  const handleLogout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    clearSessionId()
    onLogout()
  }

  const selectedBoard = boards.find((b) => b.code === boardCode)
  const boardLabel =
    data?.allBoards || boardCode === ALL_BOARDS
      ? 'Все доски'
      : selectedBoard?.displayName ?? ''

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-left">
          <label className="select-wrap">
            <span>Система digital</span>
            <select value={boardCode} onChange={(e) => setBoardCode(e.target.value)}>
              {boards.map((board) => (
                <option key={board.code} value={board.code}>
                  {board.displayName}
                </option>
              ))}
            </select>
          </label>

          <label className="search-wrap">
            <input
              type="search"
              placeholder="Поиск"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <label className="select-wrap">
            <span>Сортировка</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="date-wrap">
            <span>Дата начала</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>

          <label className="date-wrap">
            <span>Дата конца</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
        </div>

        <div className="toolbar-right">
          <button type="button" className="btn-secondary" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Синхронизация…' : 'Обновить из TFS'}
          </button>
          <button type="button" className="btn-primary" onClick={handleExport}>
            Выгрузить
          </button>
          <button type="button" className="btn-ghost" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      {syncProgress && <p className="banner-info">{syncProgress}</p>}
      {error && <p className="banner-error">{error}</p>}

      <section className="metrics">
        <article className="metric-card metric-total">
          <span className="metric-label">Всего задач</span>
          <strong className="metric-value">{data?.metrics.totalTasks ?? '—'}</strong>
        </article>
        <article className="metric-card metric-soon">
          <span className="metric-label">Скоро запуск</span>
          <strong className="metric-value">{data?.metrics.launchingSoon ?? '—'}</strong>
        </article>
        <article className="metric-card metric-launched">
          <span className="metric-label">Запущено</span>
          <strong className="metric-value">{data?.metrics.launched ?? '—'}</strong>
        </article>
        <article className="metric-card metric-errors">
          <span className="metric-label">Ошибок</span>
          <strong className="metric-value">{data?.metrics.errorsCount ?? '—'}</strong>
        </article>
      </section>

      <section className="table-section">
        <p className="table-meta">
          Показано строк {data?.totalShown ?? 0}
          {boardLabel ? ` · ${boardLabel}` : ''}
          {loading ? ' · загрузка…' : ''}
        </p>
        <div className="table">
          <div className={`table-head${data?.allBoards ? ' table-head-all' : ''}`}>
            <div>Номер ЗНИ</div>
            {data?.allBoards && <div>Доска</div>}
            <div>ЗНИ</div>
          </div>
          <div className="table-body">
            {data?.items.map((item) => (
              <div
                className={`table-row${data.allBoards ? ' table-row-all' : ''}`}
                key={`${item.boardName ?? ''}-${item.number}`}
              >
                <div className="cell-number">{item.number}</div>
                {data.allBoards && <div className="cell-board">{item.boardName}</div>}
                <div className="cell-title">
                  <div>{item.title}</div>
                  {item.errors.length > 0 && (
                    <div className="cell-errors">
                      {item.errors.map((err) => (
                        <span key={err.id} className="error-tag">
                          {err.id}: {err.title}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {!loading && data?.items.length === 0 && (
              <div className="table-empty">Нет данных. Нажмите «Обновить из TFS» для загрузки.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
