import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { apiFetch, clearSessionId, getJson } from './api'
import { loadDashboardUiState, saveDashboardUiState } from './uiState'

const ALL_BOARDS = 'all'

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
  businessValue?: number | null
  ectResourceReservation?: boolean
  errors: LinkedError[]
}

type DashboardData = {
  board: Board | null
  allBoards: boolean
  metrics: {
    totalTasks: number
    inProgress: number
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
  return allBoards ? 9 : 8
}

type ColumnMenuOption = {
  value: string
  label: string
}

type ColumnHeaderProps = {
  label: string
  sortOptions?: ColumnMenuOption[]
  sort?: string
  onSortChange?: (value: string) => void
  filterOptions?: ColumnMenuOption[]
  filterValue?: string
  onFilterChange?: (value: string) => void
}

function ColumnHeader({
  label,
  sortOptions,
  sort,
  onSortChange,
  filterOptions,
  filterValue,
  onFilterChange,
}: ColumnHeaderProps) {
  const hasMenu = Boolean(sortOptions?.length || filterOptions?.length)
  const sortActive = Boolean(sortOptions?.some((option) => option.value === sort))
  const filterActive = Boolean(filterValue)
  const isActive = sortActive || filterActive

  return (
    <th className={isActive ? 'th-active' : undefined}>
      <div className="th-header">
        <span>{label}</span>
        {hasMenu ? (
          <div className="th-menu">
            <span className="th-menu-trigger" title={`${label}: сортировка и фильтр`} aria-label={`${label}: меню`}>
              ▾
            </span>
            <div className="th-menu-panel">
              {sortOptions?.length ? (
                <div className="th-menu-section">
                  <div className="th-menu-heading">Сортировка</div>
                  {sortOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`th-menu-item${sort === option.value ? ' is-selected' : ''}`}
                      onClick={() => onSortChange?.(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {filterOptions?.length ? (
                <div className="th-menu-section">
                  <div className="th-menu-heading">Фильтр</div>
                  {filterOptions.map((option) => (
                    <button
                      key={option.value || '__all__'}
                      type="button"
                      className={`th-menu-item${filterValue === option.value ? ' is-selected' : ''}`}
                      onClick={() => onFilterChange?.(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </th>
  )
}

type BusinessValueEditorProps = {
  item: ChangeRequest
  disabled: boolean
  saving: boolean
  onSave: (item: ChangeRequest, value: string) => void
}

function businessValueInputValue(item: ChangeRequest): string {
  return item.businessValue != null ? String(item.businessValue) : ''
}

function BusinessValueEditor({ item, disabled, saving, onSave }: BusinessValueEditorProps) {
  const [draft, setDraft] = useState(businessValueInputValue(item))

  useEffect(() => {
    setDraft(businessValueInputValue(item))
  }, [item.number, item.businessValue])

  const commit = () => {
    const current = businessValueInputValue(item)
    if (draft === current) return
    onSave(item, draft)
  }

  return (
    <input
      type="number"
      min={1}
      step={1}
      className="business-value-input"
      value={draft}
      disabled={disabled || saving}
      placeholder="—"
      title="Ценность для бизнеса (Microsoft.VSTS.Common.BusinessValue в TFS)"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function isClosedStatus(value?: string | null): boolean {
  if (!value?.trim()) return false
  return value.trim().toLowerCase() === 'closed'
}

function showClosedStatus(metricFilter: MetricFilter): boolean {
  return metricFilter === 'completed' || metricFilter === 'launched'
}

function visibleBoardStatus(item: ChangeRequest, metricFilter: MetricFilter): string | null {
  const column = item.boardColumn?.trim()
  if (!column) return null
  if (isClosedStatus(column) && !showClosedStatus(metricFilter)) return null
  return column
}

function visibleWorkflowStatus(item: ChangeRequest, metricFilter: MetricFilter): string | null {
  const status = item.status?.trim()
  if (!status) return null
  if (isClosedStatus(status) && !showClosedStatus(metricFilter)) return null
  return status
}

function rowHasExpandDetails(item: ChangeRequest, metricFilter: MetricFilter): boolean {
  return Boolean(
    item.customerName?.trim() || visibleBoardStatus(item, metricFilter) || visibleWorkflowStatus(item, metricFilter),
  )
}

type MetricFilter = '' | 'in_progress' | 'launching_soon' | 'launched' | 'completed' | 'errors'

type DashboardProps = {
  onLogout: () => void
}

const METRIC_LABELS: Record<MetricFilter, string> = {
  '': 'Все задачи',
  in_progress: 'В работе',
  launching_soon: 'Скоро запуск',
  launched: 'Запущено',
  completed: 'Завершенные',
  errors: 'Ошибки',
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

const QUARTER_FILTER_OPTIONS: ColumnMenuOption[] = [
  { value: '', label: 'Все кварталы' },
  { value: 'TBD', label: 'TBD' },
  { value: '__none__', label: 'Без квартала' },
]

const ECT_FILTER_OPTIONS: ColumnMenuOption[] = [
  { value: '', label: 'Все' },
  { value: 'yes', label: 'С бронью' },
  { value: 'no', label: 'Без брони' },
]

function isMetricFilter(value: string | undefined): value is MetricFilter {
  return (
    value === ''
    || value === 'in_progress'
    || value === 'launching_soon'
    || value === 'launched'
    || value === 'completed'
    || value === 'errors'
  )
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const savedUi = loadDashboardUiState()
  const defaultQuarter = currentQuarterIsoRange()
  const [boards, setBoards] = useState<Board[]>([])
  const [boardCode, setBoardCode] = useState(savedUi.boardCode ?? ALL_BOARDS)
  const [search, setSearch] = useState(savedUi.search ?? '')
  const [sort, setSort] = useState(savedUi.sort ?? 'planned_date_upcoming')
  const [dateFrom, setDateFrom] = useState(savedUi.dateFrom ?? defaultQuarter.from)
  const [dateTo, setDateTo] = useState(savedUi.dateTo ?? defaultQuarter.to)
  const [statusFilter, setStatusFilter] = useState(savedUi.statusFilter ?? '')
  const [quarterFilter, setQuarterFilter] = useState(savedUi.quarterFilter ?? '')
  const [ectReservationFilter, setEctReservationFilter] = useState(savedUi.ectReservationFilter ?? '')
  const [tagGroupFilter, setTagGroupFilter] = useState<string[]>(savedUi.tagGroupFilter ?? [])
  const [metricFilter, setMetricFilter] = useState<MetricFilter>(
    isMetricFilter(savedUi.metricFilter) ? savedUi.metricFilter : '',
  )
  const prevBoardCodeRef = useRef<string | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [savingBusinessValueId, setSavingBusinessValueId] = useState<string | null>(null)
  const [syncProgress, setSyncProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    void getJson<Board[]>('/api/boards')
      .then((items) => setBoards(items))
      .catch((err) => setError(err instanceof Error ? err.message : 'Ошибка загрузки досок'))
  }, [])

  useEffect(() => {
    if (prevBoardCodeRef.current !== null && prevBoardCodeRef.current !== boardCode) {
      setStatusFilter('')
      setQuarterFilter('')
      setEctReservationFilter('')
      setTagGroupFilter([])
      setMetricFilter('')
    }
    prevBoardCodeRef.current = boardCode
  }, [boardCode])

  useEffect(() => {
    saveDashboardUiState({
      boardCode,
      search,
      sort,
      dateFrom,
      dateTo,
      statusFilter,
      quarterFilter,
      ectReservationFilter,
      tagGroupFilter,
      metricFilter,
    })
  }, [
    boardCode,
    search,
    sort,
    dateFrom,
    dateTo,
    statusFilter,
    quarterFilter,
    ectReservationFilter,
    tagGroupFilter,
    metricFilter,
  ])

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
    if (ectReservationFilter) params.set('ect_reservation', ectReservationFilter)
    if (boardCode !== ALL_BOARDS) {
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
  }, [
    boardCode,
    search,
    sort,
    dateFrom,
    dateTo,
    statusFilter,
    quarterFilter,
    ectReservationFilter,
    tagGroupFilter,
    metricFilter,
  ])

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

  const quarterFilterOptions = (): ColumnMenuOption[] => {
    const quarters = (data?.availableQuarters ?? [])
      .filter((quarter) => quarter.key !== 'TBD')
      .map((quarter) => ({ value: quarter.key, label: quarter.label }))
    return [...QUARTER_FILTER_OPTIONS.slice(0, 1), ...quarters, ...QUARTER_FILTER_OPTIONS.slice(1)]
  }

  const saveBusinessValue = async (item: ChangeRequest, rawValue: string) => {
    const trimmed = rawValue.trim()
    const parsed = trimmed === '' ? null : Number.parseInt(trimmed, 10)
    if (trimmed !== '' && (!Number.isFinite(parsed) || parsed! < 1)) {
      setError('Ценность для бизнеса — целое число от 1')
      return
    }
    if (parsed === item.businessValue) return

    setSavingBusinessValueId(item.number)
    setError(null)
    try {
      const response = await apiFetch(`/api/tasks/${encodeURIComponent(item.number)}/business-value`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: parsed }),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || 'Не удалось сохранить ценность для бизнеса')
      }
      const updated = (await response.json()) as ChangeRequest
      setData((current) => {
        if (!current) return current
        return {
          ...current,
          items: current.items.map((row) =>
            row.number === updated.number ? { ...row, businessValue: updated.businessValue } : row,
          ),
        }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    } finally {
      setSavingBusinessValueId(null)
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

          {(data?.availableTagGroups?.length ?? 0) > 0 && (
            <div className="tag-group-filter">
              <span className="tag-group-filter-label">Область</span>
              <div className="tag-group-filter-dropdown">
                <div className="tag-group-filter-trigger">{tagGroupFilterLabel()}</div>
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
              </div>
            </div>
          )}

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
          className={`metric-card metric-in-progress${metricFilter === 'in_progress' ? ' metric-card-active' : ''}`}
          onClick={() => toggleMetricFilter('in_progress')}
        >
          <span className="metric-label">В работе</span>
          <strong className="metric-value">{data?.metrics.inProgress ?? '—'}</strong>
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
          <span className="metric-label">Ошибки</span>
          <strong className="metric-value">{data?.metrics.errorsCount ?? '—'}</strong>
        </button>
      </section>

      <section className="table-section">
        <p className="table-meta">
          Показано строк {data?.totalShown ?? 0}
          {metricFilter ? ` · фильтр: ${METRIC_LABELS[metricFilter]}` : ''}
          {tagGroupFilter.length ? ` · область: ${tagGroupFilterLabel()}` : ''}
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
                <col className="col-business-value" />
                <col className="col-date" />
                <col className="col-quarter" />
                <col className="col-reservation" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Подробнее" />
                  <ColumnHeader
                    label="Номер ЗНИ"
                    sort={sort}
                    onSortChange={setSort}
                    sortOptions={[
                      { value: 'id_desc', label: 'От большего к меньшему' },
                      { value: 'id_asc', label: 'От меньшего к большему' },
                    ]}
                  />
                  {data?.allBoards && <th>Доска</th>}
                  <ColumnHeader
                    label="ЗНИ"
                    sort={sort}
                    onSortChange={setSort}
                    sortOptions={[
                      { value: 'title_asc', label: 'А → Я' },
                      { value: 'title_desc', label: 'Я → А' },
                    ]}
                  />
                  <th>Цель и бизнес-смысл доработки</th>
                  <ColumnHeader
                    label="Ценность для бизнеса"
                    sort={sort}
                    onSortChange={setSort}
                    sortOptions={[
                      { value: 'business_value_asc', label: '1 → больше, пустые в конце' },
                      { value: 'business_value_desc', label: 'Пустые в начале, больше → меньше' },
                    ]}
                  />
                  <ColumnHeader
                    label="План. дата"
                    sort={sort}
                    onSortChange={setSort}
                    sortOptions={[
                      { value: 'planned_date_upcoming', label: 'Ближайшие' },
                      { value: 'planned_date_asc', label: 'По возрастанию' },
                      { value: 'planned_date_desc', label: 'По убыванию' },
                    ]}
                  />
                  <ColumnHeader
                    label="План квартала"
                    filterOptions={quarterFilterOptions()}
                    filterValue={quarterFilter}
                    onFilterChange={setQuarterFilter}
                  />
                  <ColumnHeader
                    label="Бронь ЕЦТ"
                    filterOptions={ECT_FILTER_OPTIONS}
                    filterValue={ectReservationFilter}
                    onFilterChange={setEctReservationFilter}
                  />
                </tr>
              </thead>
              <tbody>
                {data?.items.flatMap((item) => {
                  const key = itemRowKey(item)
                  const expanded = expandedKeys.has(key)
                  const hasDetails = rowHasExpandDetails(item, metricFilter)
                  const boardStatus = visibleBoardStatus(item, metricFilter)
                  const workflowStatus = visibleWorkflowStatus(item, metricFilter)
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
                      <td className="cell-business-value">
                        <BusinessValueEditor
                          item={item}
                          disabled={syncing || exporting}
                          saving={savingBusinessValueId === item.number}
                          onSave={saveBusinessValue}
                        />
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
                                <span className="status-board">
                                  {boardStatus || workflowStatus || '—'}
                                </span>
                                {boardStatus && workflowStatus && boardStatus !== workflowStatus && (
                                  <span className="status-workflow">{workflowStatus}</span>
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
