import { useCallback, useEffect, useState } from 'react'
import { apiFetch, clearSessionId, getJson } from './api'

const ALL_BOARDS = 'all'

const BOARD_LABELS: Record<string, string> = {
  all: 'Все доски',
  digital_streams_b2b: 'Digital',
  be_t2_team: 'Bercut',
}

function boardButtonLabel(code: string, fallback?: string): string {
  return BOARD_LABELS[code] ?? fallback ?? code
}

function boardNameLabel(name?: string | null, code?: string | null): string {
  if (code && BOARD_LABELS[code]) return BOARD_LABELS[code]
  if (name && BOARD_LABELS[name]) return BOARD_LABELS[name]
  if (name === 'Digital Streams B2b') return 'Digital'
  if (name === 'BE Analytics') return 'Bercut'
  return name || '—'
}

type Board = {
  code: string
  name: string
  displayName: string
}

type LinkedError = {
  id: string
  title: string
  url?: string | null
}

type QuarterOption = {
  key: string
  label: string
}

type ChangeRequest = {
  number: string
  title: string
  url?: string | null
  status?: string | null
  boardColumn?: string | null
  startDate?: string | null
  releaseDate?: string | null
  plannedDate?: string | null
  plannedLabel?: string | null
  planQuarter?: string | null
  plannedRelease?: string | null
  boardName?: string | null
  boardCode?: string | null
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
  availableStatuses: string[]
  availableQuarters: QuarterOption[]
}

function formatDate(value?: string | null): string {
  if (!value) return '—'
  const [year, month, day] = value.split('-')
  if (!year || !month || !day) return value
  return `${day}.${month}.${year}`
}

function formatPlannedDate(item: ChangeRequest): string {
  if (item.plannedLabel) return item.plannedLabel
  return formatDate(item.plannedDate)
}

type MetricFilter = '' | 'launching_soon' | 'launched' | 'errors'

type DashboardProps = {
  onLogout: () => void
}

const METRIC_LABELS: Record<MetricFilter, string> = {
  '': 'Все задачи',
  launching_soon: 'Скоро запуск',
  launched: 'Запущено',
  errors: 'С ошибками',
}

const SORT_OPTIONS = [
  { value: 'id_desc', label: 'Номер ЗНИ (убыв.)' },
  { value: 'id_asc', label: 'Номер ЗНИ (возр.)' },
  { value: 'release_date_desc', label: 'Целевая дата (убыв.)' },
  { value: 'release_date_asc', label: 'Целевая дата (возр.)' },
  { value: 'start_date_desc', label: 'Дата начала (убыв.)' },
  { value: 'planned_date_desc', label: 'План. дата (убыв.)' },
  { value: 'planned_date_asc', label: 'План. дата (возр.)' },
]

export default function Dashboard({ onLogout }: DashboardProps) {
  const [boards, setBoards] = useState<Board[]>([])
  const [boardCode, setBoardCode] = useState(ALL_BOARDS)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('id_desc')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [quarterFilter, setQuarterFilter] = useState('')
  const [metricFilter, setMetricFilter] = useState<MetricFilter>('')
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void getJson<Board[]>('/api/boards')
      .then((items) => setBoards(items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки досок'))
  }, [])

  useEffect(() => {
    setStatusFilter('')
    setQuarterFilter('')
    setMetricFilter('')
  }, [boardCode])

  const loadDashboard = useCallback(async () => {
    if (!boardCode) return
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ board: boardCode, sort })
    if (search.trim()) params.set('search', search.trim())
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    if (statusFilter) params.set('status', statusFilter)
    if (quarterFilter) params.set('quarter', quarterFilter)
    if (metricFilter) params.set('metric', metricFilter)
    try {
      const payload = await getJson<DashboardData>(`/api/dashboard?${params}`)
      setData(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [boardCode, search, sort, dateFrom, dateTo, statusFilter, quarterFilter, metricFilter])

  const toggleMetricFilter = (value: MetricFilter) => {
    setMetricFilter((current) => (current === value ? '' : value))
  }

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
  const boardLabel = boardButtonLabel(boardCode, selectedBoard?.displayName)

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-left">
          <div className="board-filter">
            <span className="board-filter-label">Система digital</span>
            <div className="board-filter-buttons" role="group" aria-label="Доска">
              {boards.map((board) => (
                <button
                  key={board.code}
                  type="button"
                  className={`board-filter-btn${boardCode === board.code ? ' board-filter-btn-active' : ''}`}
                  onClick={() => setBoardCode(board.code)}
                >
                  {boardButtonLabel(board.code, board.displayName)}
                </button>
              ))}
            </div>
          </div>

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

          <label className="select-wrap">
            <span>Статус доски</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Все статусы</option>
              {(data?.availableStatuses ?? []).map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="select-wrap">
            <span>План квартала</span>
            <select value={quarterFilter} onChange={(e) => setQuarterFilter(e.target.value)}>
              <option value="">Все кварталы</option>
              {(data?.availableQuarters ?? []).map((quarter) => (
                <option key={quarter.key} value={quarter.key}>
                  {quarter.label}
                </option>
              ))}
              <option value="TBD">TBD</option>
              <option value="__none__">Без квартала</option>
            </select>
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
        <button
          type="button"
          className={`metric-card metric-total${metricFilter === '' ? ' metric-card-active' : ''}`}
          onClick={() => toggleMetricFilter('')}
        >
          <span className="metric-label">Всего задач</span>
          <strong className="metric-value">{data?.metrics.totalTasks ?? '—'}</strong>
        </button>
        <button
          type="button"
          className={`metric-card metric-soon${metricFilter === 'launching_soon' ? ' metric-card-active' : ''}`}
          onClick={() => toggleMetricFilter('launching_soon')}
        >
          <span className="metric-label">Скоро запуск</span>
          <strong className="metric-value">{data?.metrics.launchingSoon ?? '—'}</strong>
        </button>
        <button
          type="button"
          className={`metric-card metric-launched${metricFilter === 'launched' ? ' metric-card-active' : ''}`}
          onClick={() => toggleMetricFilter('launched')}
        >
          <span className="metric-label">Запущено</span>
          <strong className="metric-value">{data?.metrics.launched ?? '—'}</strong>
        </button>
        <button
          type="button"
          className={`metric-card metric-errors${metricFilter === 'errors' ? ' metric-card-active' : ''}`}
          onClick={() => toggleMetricFilter('errors')}
        >
          <span className="metric-label">С ошибками</span>
          <strong className="metric-value">{data?.metrics.errorsCount ?? '—'}</strong>
        </button>
      </section>

      <section className="table-section">
        <p className="table-meta">
          Показано строк {data?.totalShown ?? 0}
          {metricFilter ? ` · фильтр: ${METRIC_LABELS[metricFilter]}` : ''}
          {boardLabel ? ` · ${boardLabel}` : ''}
          {loading ? ' · загрузка…' : ''}
        </p>
        <div className="table">
          <div className="table-scroll">
            <div className={`table-head${data?.allBoards ? ' table-head-all' : ''}`}>
              <div>Номер ЗНИ</div>
              {data?.allBoards && <div>Доска</div>}
              <div>ЗНИ</div>
              <div>Дата начала</div>
              <div>Целевая дата</div>
              <div>План. дата</div>
              <div>План квартала</div>
              <div>План. релиз</div>
              <div>Статус</div>
            </div>
            <div className="table-body">
            {data?.items.map((item) => (
              <div
                className={`table-row${data.allBoards ? ' table-row-all' : ''}`}
                key={`${item.boardName ?? ''}-${item.number}`}
              >
                <div className="cell-number">
                  {item.url ? (
                    <a className="zni-link" href={item.url} target="_blank" rel="noreferrer">
                      {item.number}
                    </a>
                  ) : (
                    item.number
                  )}
                </div>
                {data.allBoards && (
                  <div className="cell-board">{boardNameLabel(item.boardName, item.boardCode)}</div>
                )}
                <div className="cell-title">
                  <div>{item.title}</div>
                  {item.errors.length > 0 && (
                    <div className="cell-errors">
                      {item.errors.map((err) => (
                        <span key={err.id} className="error-tag">
                          {err.url ? (
                            <a className="zni-link" href={err.url} target="_blank" rel="noreferrer">
                              {err.id}
                            </a>
                          ) : (
                            err.id
                          )}
                          : {err.title}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="cell-date">{formatDate(item.startDate)}</div>
                <div className="cell-date">{formatDate(item.releaseDate)}</div>
                <div className="cell-date">{formatPlannedDate(item)}</div>
                <div className="cell-quarter">{item.planQuarter || '—'}</div>
                <div className="cell-release">{item.plannedRelease || '—'}</div>
                <div className="cell-status">
                  <span className="status-board">{item.boardColumn || item.status || '—'}</span>
                  {item.boardColumn && item.status && item.boardColumn !== item.status && (
                    <span className="status-workflow">{item.status}</span>
                  )}
                </div>
              </div>
            ))}
            {!loading && data?.items.length === 0 && (
              <div className="table-empty">Нет данных. Нажмите «Обновить из TFS» для загрузки.</div>
            )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
