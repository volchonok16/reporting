import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { apiFetch, clearSessionId, getJson } from './api'

const ALL_BOARDS = 'all'
const DIGITAL_BOARD = 'digital_streams_b2b'

const BOARD_LABELS: Record<string, string> = {
  all: 'Все доски',
  digital_streams_b2b: 'Digital',
  b2b_product_core: 'CORE',
  b2b_product_partners: 'КАТС',
  b2b_voice_products: 'Голосовые продукты',
  b2b_m2m_platform: 'М2М / IoT',
  b2b_sms_target: 'SMS',
  b2b_solar: 'Solar',
  b2b_umnico: 'Umnico',
  be_t2_team: 'Bercut',
  esb_analytics: 'ESB',
}

function boardButtonLabel(code: string, fallback?: string): string {
  return BOARD_LABELS[code] ?? fallback ?? code
}

function boardNameLabel(name?: string | null, code?: string | null): string {
  if (code && BOARD_LABELS[code]) return BOARD_LABELS[code]
  if (name && BOARD_LABELS[name]) return BOARD_LABELS[name]
  if (name === 'Digital Streams B2b') return 'Digital'
  if (name === 'BE Analytics') return 'Bercut'
  if (name === 'ESB Analytics') return 'ESB'
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

type TagFilterGroup = {
  key: string
  label: string
  tags: string[]
  subsectionPrefixes: string[]
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
  customerName?: string | null
  businessGoal?: string | null
  ectResourceReservation?: boolean
  errors: LinkedError[]
}

type DashboardData = {
  board: Board | null
  allBoards: boolean
  metrics: {
    totalTasks: number
    launchingSoon: number
    launched: number
    completed: number
    errorsCount: number
  }
  items: ChangeRequest[]
  totalShown: number
  availableStatuses: string[]
  availableQuarters: QuarterOption[]
  availableTagGroups: TagFilterGroup[]
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

function formatEctReservation(value?: boolean): string {
  return value ? 'ДА' : 'НЕТ'
}

function businessGoalParagraphs(text: string): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current.join('\n'))
        current = []
      }
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join('\n'))
  }
  return paragraphs.length > 0 ? paragraphs : [text]
}

function BusinessGoalText({ text, className }: { text: string; className?: string }) {
  const paragraphs = businessGoalParagraphs(text)
  return (
    <div className={className ?? 'zni-detail-text'}>
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="zni-detail-paragraph">
          {paragraph}
        </p>
      ))}
    </div>
  )
}

function customerNameParts(name?: string | null): string[] {
  if (!name?.trim()) return []
  return name.trim().split(/\s+/).slice(0, 3)
}

function itemRowKey(item: ChangeRequest): string {
  return `${item.boardCode ?? item.boardName ?? ''}-${item.number}`
}

function tableColumnCount(allBoards: boolean): number {
  return allBoards ? 8 : 7
}

function rowHasExpandDetails(item: ChangeRequest): boolean {
  return Boolean(item.customerName?.trim() || item.boardColumn?.trim() || item.status?.trim())
}

type MetricFilter = '' | 'launching_soon' | 'launched' | 'completed' | 'errors'

type DashboardProps = {
  onLogout: () => void
}

const METRIC_LABELS: Record<MetricFilter, string> = {
  '': 'Все задачи',
  launching_soon: 'Скоро запуск',
  launched: 'Запущено',
  completed: 'Завершенные',
  errors: 'С ошибками',
}

function currentQuarterIsoRange(): { from: string; to: string } {
  const now = new Date()
  const year = now.getFullYear()
  const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3
  const pad = (value: number) => String(value).padStart(2, '0')
  const lastDay = new Date(year, quarterStartMonth + 3, 0)
  return {
    from: `${year}-${pad(quarterStartMonth + 1)}-01`,
    to: `${year}-${pad(lastDay.getMonth() + 1)}-${pad(lastDay.getDate())}`,
  }
}

const SORT_OPTIONS = [
  { value: 'planned_date_upcoming', label: 'План. дата (ближайшие)' },
  { value: 'start_date_desc', label: 'Дата начала (убыв.)' },
]

export default function Dashboard({ onLogout }: DashboardProps) {
  const [boards, setBoards] = useState<Board[]>([])
  const [boardCode, setBoardCode] = useState(ALL_BOARDS)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('planned_date_upcoming')
  const [dateFrom, setDateFrom] = useState(() => currentQuarterIsoRange().from)
  const [dateTo, setDateTo] = useState(() => currentQuarterIsoRange().to)
  const [statusFilter, setStatusFilter] = useState('')
  const [quarterFilter, setQuarterFilter] = useState('')
  const [tagGroupFilter, setTagGroupFilter] = useState<string[]>([])
  const [metricFilter, setMetricFilter] = useState<MetricFilter>('')
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [syncProgress, setSyncProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    void getJson<Board[]>('/api/boards')
      .then((items) => setBoards(items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки досок'))
  }, [])

  useEffect(() => {
    setStatusFilter('')
    setQuarterFilter('')
    setTagGroupFilter([])
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
    if (boardCode === DIGITAL_BOARD) {
      for (const group of tagGroupFilter) {
        params.append('tag_group', group)
      }
    }
    if (metricFilter) params.set('metric', metricFilter)
    try {
      const payload = await getJson<DashboardData>(`/api/dashboard?${params}`)
      setData(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [boardCode, search, sort, dateFrom, dateTo, statusFilter, quarterFilter, tagGroupFilter, metricFilter])

  const toggleTagGroupFilter = (key: string) => {
    setTagGroupFilter((current) =>
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key],
    )
  }

  const tagGroupFilterLabel = (): string => {
    if (!tagGroupFilter.length) return 'Все области'
    const groups = data?.availableTagGroups ?? []
    return tagGroupFilter
      .map((key) => groups.find((group) => group.key === key)?.label ?? key)
      .join(', ')
  }

  const toggleMetricFilter = (value: MetricFilter) => {
    setMetricFilter((current) => (current === value ? '' : value))
  }

  const toggleExpanded = (key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const handleExpandKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleExpanded(key)
    }
  }

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const waitForSync = useCallback(async (targetBoard: string) => {
    const params = `?board=${encodeURIComponent(targetBoard)}`
    const response = await apiFetch(`/api/sync${params}`, { method: 'POST' })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || 'Ошибка синхронизации')
    }
    const sync = (await response.json()) as { id: number }
    for (;;) {
      const status = await getJson<{
        status: string
        errorMessage?: string | null
        progressMessage?: string | null
      }>(`/api/sync/${sync.id}`)
      if (status.progressMessage) {
        setSyncProgress(status.progressMessage)
      }
      if (status.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        continue
      }
      if (status.status === 'failed') {
        throw new Error(status.errorMessage || 'Синхронизация не удалась')
      }
      return
    }
  }, [])

  const boardsForSync = useCallback((): Board[] => {
    if (boardCode === ALL_BOARDS) {
      return boards.filter((board) => board.code !== ALL_BOARDS)
    }
    const selected = boards.find((board) => board.code === boardCode)
    return selected ? [selected] : []
  }, [boardCode, boards])

  const syncBoardList = useCallback(
    async (targetBoards: Board[]) => {
      if (targetBoards.length === 0) {
        throw new Error('Нет досок для синхронизации')
      }
      const failures: string[] = []
      for (let index = 0; index < targetBoards.length; index += 1) {
        const board = targetBoards[index]
        const label = boardButtonLabel(board.code, board.displayName)
        const prefix = targetBoards.length > 1 ? `${index + 1}/${targetBoards.length}: ` : ''
        setSyncProgress(`${prefix}Синхронизация ${label}…`)
        try {
          await waitForSync(board.code)
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Ошибка синхронизации'
          failures.push(`${label}: ${message}`)
        }
      }
      if (failures.length === targetBoards.length) {
        throw new Error(failures.join('; '))
      }
      if (failures.length > 0) {
        setSyncProgress(`Готово с ошибками: ${failures.join('; ')}`)
        return
      }
      if (targetBoards.length > 1) {
        setSyncProgress(`Готово: ${targetBoards.length} досок`)
      }
    },
    [waitForSync],
  )

  const downloadCsv = useCallback(async (targetBoard: string, filename: string) => {
    const params = `?board=${encodeURIComponent(targetBoard)}`
    const response = await apiFetch(`/api/export${params}`)
    if (!response.ok) {
      throw new Error('Не удалось выгрузить отчёт')
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
  }, [])

  const handleSync = async () => {
    setSyncing(true)
    setSyncProgress('Старт…')
    setError(null)
    try {
      const targetBoards = boardsForSync()
      await syncBoardList(targetBoards)
      if (targetBoards.length === 1) {
        setSyncProgress(null)
      }
      await loadDashboard()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации')
      setSyncProgress(null)
    } finally {
      setSyncing(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    setError(null)
    try {
      if (boardCode === ALL_BOARDS) {
        await syncBoardList(boardsForSync())
        setSyncProgress('Формирование CSV…')
        await downloadCsv(ALL_BOARDS, 'zni-report-all.csv')
        setSyncProgress(null)
        await loadDashboard()
        return
      }
      await downloadCsv(boardCode, 'zni-report.csv')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка выгрузки')
      setSyncProgress(null)
    } finally {
      setExporting(false)
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
      <section className="board-filter-bar">
        <div className="board-filter">
          <span className="board-filter-label">Доска</span>
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
      </section>

      <header className="toolbar">
        <div className="toolbar-left">
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

          {boardCode === DIGITAL_BOARD && (
            <div className="tag-group-filter">
              <span className="tag-group-filter-label">Область</span>
              <details className="tag-group-filter-details">
                <summary>{tagGroupFilterLabel()}</summary>
                <div className="tag-group-filter-menu" role="group" aria-label="Фильтр по области">
                  {(data?.availableTagGroups ?? []).map((group) => {
                    const active = tagGroupFilter.includes(group.key)
                    return (
                      <label key={group.key} className={`tag-group-filter-option${active ? ' is-active' : ''}`}>
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => toggleTagGroupFilter(group.key)}
                        />
                        <span className="tag-group-filter-option-label">{group.label}</span>
                      </label>
                    )
                  })}
                </div>
              </details>
            </div>
          )}

          <label className="select-wrap">
            <span>План квартала</span>
            <select value={quarterFilter} onChange={(e) => setQuarterFilter(e.target.value)}>
              <option value="">Все кварталы</option>
              {(data?.availableQuarters ?? [])
                .filter((quarter) => quarter.key !== 'TBD')
                .map((quarter) => (
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
          <button type="button" className="btn-secondary" onClick={handleSync} disabled={syncing || exporting}>
            {syncing ? 'Синхронизация…' : 'Обновить из TFS'}
          </button>
          <button type="button" className="btn-primary" onClick={handleExport} disabled={syncing || exporting}>
            {exporting ? 'Выгрузка…' : 'Выгрузить'}
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
          className={`metric-card metric-completed${metricFilter === 'completed' ? ' metric-card-active' : ''}`}
          onClick={() => toggleMetricFilter('completed')}
        >
          <span className="metric-label">Завершенные</span>
          <strong className="metric-value">{data?.metrics.completed ?? '—'}</strong>
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
          {boardCode === DIGITAL_BOARD && tagGroupFilter.length
            ? ` · область: ${tagGroupFilterLabel()}`
            : ''}
          {boardLabel ? ` · ${boardLabel}` : ''}
          {loading ? ' · загрузка…' : ''}
        </p>
        <div className="table">
          <div className="table-scroll">
            <table className={`zni-table${data?.allBoards ? ' zni-table-all' : ''}`}>
              <colgroup>
                <col className="col-expand" />
                <col className="col-id" />
                {data?.allBoards && <col className="col-board" />}
                <col className="col-title" />
                <col className="col-goal" />
                <col className="col-date" />
                <col className="col-quarter" />
                <col className="col-reservation" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Подробнее" />
                  <th>Номер ЗНИ</th>
                  {data?.allBoards && <th>Доска</th>}
                  <th>ЗНИ</th>
                  <th>Цель и бизнес-смысл доработки</th>
                  <th>План. дата</th>
                  <th>План квартала</th>
                  <th title="Бронь ресурса ЕЦТ">Бронь ЕЦТ</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.flatMap((item) => {
                  const key = itemRowKey(item)
                  const expanded = expandedKeys.has(key)
                  const hasDetails = rowHasExpandDetails(item)
                  const customerParts = customerNameParts(item.customerName)
                  const colCount = tableColumnCount(Boolean(data.allBoards))
                  const rows = [
                    <tr key={key} className={expanded ? 'zni-table-row-expanded' : undefined}>
                      <td className="cell-expand">
                        {hasDetails ? (
                          <button
                            type="button"
                            className="row-expand-btn"
                            aria-expanded={expanded}
                            aria-label={
                              expanded ? 'Скрыть заказчика и статус' : 'Показать заказчика и статус'
                            }
                            onClick={() => toggleExpanded(key)}
                            onKeyDown={(event) => handleExpandKeyDown(event, key)}
                          >
                            {expanded ? '▼' : '▶'}
                          </button>
                        ) : null}
                      </td>
                      <td className="cell-number">
                        {item.url ? (
                          <a className="zni-link" href={item.url} target="_blank" rel="noreferrer">
                            {item.number}
                          </a>
                        ) : (
                          item.number
                        )}
                      </td>
                      {data.allBoards && (
                        <td className="cell-board">{boardNameLabel(item.boardName, item.boardCode)}</td>
                      )}
                      <td className="cell-title" title={item.title}>
                        {item.title}
                      </td>
                      <td className="cell-business-goal">
                        {item.businessGoal?.trim() ? (
                          <BusinessGoalText text={item.businessGoal} className="cell-business-goal-text" />
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="cell-date">{formatPlannedDate(item)}</td>
                      <td className="cell-quarter">{item.planQuarter || '—'}</td>
                      <td
                        className={`cell-reservation${item.ectResourceReservation ? ' cell-reservation-yes' : ' cell-reservation-no'}`}
                      >
                        {formatEctReservation(item.ectResourceReservation)}
                      </td>
                    </tr>,
                  ]
                  if (expanded && hasDetails) {
                    rows.push(
                      <tr key={`${key}-details`} className="zni-table-detail-row">
                        <td colSpan={colCount}>
                          <div className="zni-detail-panel zni-detail-panel-compact">
                            <div className="zni-detail-field">
                              <div className="zni-detail-label">Заказчик</div>
                              <div className="zni-detail-value">
                                {customerParts.length > 0 ? (
                                  <span className="customer-name-stack">
                                    {customerParts.map((part, index) => (
                                      <span key={index} className="customer-name-line">{part}</span>
                                    ))}
                                  </span>
                                ) : (
                                  '—'
                                )}
                              </div>
                            </div>
                            <div className="zni-detail-field">
                              <div className="zni-detail-label">Статус</div>
                              <div className="zni-detail-value cell-status">
                                <span className="status-board">{item.boardColumn || item.status || '—'}</span>
                                {item.boardColumn && item.status && item.boardColumn !== item.status && (
                                  <span className="status-workflow">{item.status}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>,
                    )
                  }
                  return rows
                })}
              </tbody>
            </table>
            {!loading && data?.items.length === 0 && (
              <div className="table-empty">Нет данных. Нажмите «Обновить из TFS» для загрузки.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
