import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { apiFetch, getJson, patchJson } from './api'
import type { ChangeRequest, RoadmapPriority } from './zniTypes'
import { columnBarClass } from './roadmap/kanbanColumns'
import {
  RoadmapPriorityPicker,
  roadmapPriorityBarClass,
  ROADMAP_PRIORITY_OPTIONS,
} from './roadmap/RoadmapPriorityPicker'
import {
  currentQuarter,
  formatRuDate,
  quarterRange,
  yearOptions,
} from './roadmap/quarterUtils'
import { barVisual, parseDateInput, timelinePercent } from './roadmap/schedulingUtils'
import {
  loadRoadmapUiState,
  saveRoadmapUiState,
} from './uiState'
import './roadmap.css'

const DIGITAL_BOARD = 'digital_streams_b2b'
const dayMs = 24 * 60 * 60 * 1000

type RoadmapProps = {
  canSyncTfs?: boolean
  canEditPriority?: boolean
  canEditComment?: boolean
}

type DashboardPayload = {
  items: ChangeRequest[]
  totalShown: number
}

function startOfLocalDay(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function monthTicks(from: Date, to: Date): { label: string; left: number }[] {
  const ticks: { label: string; left: number }[] = []
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1)
  if (cursor < from) cursor.setMonth(cursor.getMonth() + 1)

  while (cursor <= to) {
    ticks.push({
      label: new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(cursor),
      left: timelinePercent(cursor, from, to),
    })
    cursor.setMonth(cursor.getMonth() + 1)
  }

  return ticks
}

function dayTicks(from: Date, to: Date): { label: string; left: number; isFirstOfMonth: boolean }[] {
  const ticks: { label: string; left: number; isFirstOfMonth: boolean }[] = []
  const cursor = startOfLocalDay(from)
  const end = startOfLocalDay(to)
  const totalDays = Math.max(Math.round((end.getTime() - cursor.getTime()) / dayMs) + 1, 1)
  const step = totalDays > 75 ? 3 : totalDays > 45 ? 2 : 1

  while (cursor <= end) {
    ticks.push({
      label: String(cursor.getDate()),
      left: timelinePercent(cursor, from, to),
      isFirstOfMonth: cursor.getDate() === 1,
    })
    cursor.setDate(cursor.getDate() + step)
  }

  return ticks
}

export default function Roadmap({
  canSyncTfs = false,
  canEditPriority = true,
  canEditComment = true,
}: RoadmapProps) {
  const saved = useMemo(() => loadRoadmapUiState(), [])
  const [year, setYear] = useState(saved.year ?? new Date().getFullYear())
  const [quarter, setQuarter] = useState(saved.quarter ?? currentQuarter())
  const [items, setItems] = useState<ChangeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingPriority, setSavingPriority] = useState<string | null>(null)
  const [priorityError, setPriorityError] = useState<string | null>(null)
  const [savingComment, setSavingComment] = useState<string | null>(null)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState<string | null>(null)

  const { from, to } = useMemo(() => quarterRange(year, quarter), [year, quarter])
  const fromDate = useMemo(() => parseDateInput(from), [from])
  const toDate = useMemo(() => parseDateInput(to, true), [to])

  useEffect(() => {
    saveRoadmapUiState({ year, quarter })
  }, [year, quarter])

  const loadItems = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        board: DIGITAL_BOARD,
        date_from: from,
        date_to: to,
        sort: 'start_date',
      })
      const payload = await getJson<DashboardPayload>(`/api/dashboard?${params}`)
      const visible = payload.items.filter(
        (item) => item.rowType !== 'error' && Boolean(item.startDate),
      )
      setItems(visible)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить roadmap')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    void loadItems()
  }, [loadItems])

  const waitForSync = useCallback(async () => {
    const params = `?board=${encodeURIComponent(DIGITAL_BOARD)}`
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

  const handleSyncFromTfs = async () => {
    setSyncing(true)
    setSyncProgress('Старт…')
    setError(null)
    try {
      await waitForSync()
      setSyncProgress(null)
      await loadItems()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации')
      setSyncProgress(null)
    } finally {
      setSyncing(false)
    }
  }

  const updateRoadmapPriority = useCallback(
    async (item: ChangeRequest, priority: RoadmapPriority | null) => {
      if (item.roadmapPriority === priority) return
      setSavingPriority(item.number)
      setPriorityError(null)
      try {
        const updated = await patchJson<ChangeRequest>(
          `/api/tasks/${encodeURIComponent(item.number)}/roadmap-priority`,
          { priority },
        )
        setItems((current) =>
          current.map((row) =>
            row.number === updated.number
              ? { ...row, roadmapPriority: updated.roadmapPriority ?? null }
              : row,
          ),
        )
      } catch (err) {
        setPriorityError(err instanceof Error ? err.message : 'Не удалось сохранить приоритет')
      } finally {
        setSavingPriority(null)
      }
    },
    [],
  )

  const saveRoadmapComment = useCallback(
    async (item: ChangeRequest, comment: string) => {
      const normalized = comment.trim()
      const current = (item.roadmapComment ?? '').trim()
      if (normalized === current) {
        setCommentDrafts((drafts) => {
          if (!(item.number in drafts)) return drafts
          const next = { ...drafts }
          delete next[item.number]
          return next
        })
        return
      }

      setSavingComment(item.number)
      setCommentError(null)
      try {
        const updated = await patchJson<ChangeRequest>(
          `/api/tasks/${encodeURIComponent(item.number)}/roadmap-comment`,
          { comment: normalized || null },
        )
        setItems((currentItems) =>
          currentItems.map((row) =>
            row.number === updated.number
              ? { ...row, roadmapComment: updated.roadmapComment ?? null }
              : row,
          ),
        )
        setCommentDrafts((drafts) => {
          if (!(item.number in drafts)) return drafts
          const next = { ...drafts }
          delete next[item.number]
          return next
        })
      } catch (err) {
        setCommentError(err instanceof Error ? err.message : 'Не удалось сохранить комментарий')
      } finally {
        setSavingComment(null)
      }
    },
    [],
  )

  const months = useMemo(() => monthTicks(fromDate, toDate), [fromDate, toDate])
  const days = useMemo(() => dayTicks(fromDate, toDate), [fromDate, toDate])
  const todayLeft = timelinePercent(new Date(), fromDate, toDate)
  const isTodayVisible = todayLeft > 0 && todayLeft < 100
  const years = useMemo(() => yearOptions(), [])

  return (
    <div className="roadmap-page">
      <div className="roadmap-toolbar">
        <div className="roadmap-toolbar-title">
          <h1>Roadmap</h1>
          <p>Digital · планирование по Start Date</p>
        </div>

        <div className="roadmap-period">
          <select
            className="roadmap-year-select"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            aria-label="Год"
          >
            {years.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>

          <div className="roadmap-quarter-switch" role="group" aria-label="Квартал">
            {[1, 2, 3, 4].map((value) => (
              <button
                key={value}
                type="button"
                className={`roadmap-quarter-btn${quarter === value ? ' roadmap-quarter-btn-active' : ''}`}
                onClick={() => setQuarter(value)}
                aria-pressed={quarter === value}
              >
                Q{value}
              </button>
            ))}
          </div>

          <span className="roadmap-period-range">
            {formatRuDate(from)} — {formatRuDate(to)}
          </span>

          {canSyncTfs ? (
            <button
              type="button"
              className="btn-secondary roadmap-sync-btn"
              onClick={() => void handleSyncFromTfs()}
              disabled={syncing || loading}
            >
              {syncing ? 'Обновление…' : 'Обновить из TFS'}
            </button>
          ) : null}
        </div>

        <div className="roadmap-priority-legend" aria-label="Легенда приоритетов">
          {ROADMAP_PRIORITY_OPTIONS.map((option) => (
            <span key={option.value} className={`roadmap-priority-legend-item is-${option.value}`}>
              <span className="roadmap-priority-dot" aria-hidden="true" />
              {option.label}
            </span>
          ))}
        </div>
      </div>

      {syncProgress ? <div className="roadmap-sync-progress">{syncProgress}</div> : null}

      {priorityError ? <div className="roadmap-error">{priorityError}</div> : null}
      {commentError ? <div className="roadmap-error">{commentError}</div> : null}
      {error ? <div className="roadmap-error">{error}</div> : null}

      <div className="roadmap-workspace">
        <div className="roadmap-sheet">
          {isTodayVisible ? (
            <div className="roadmap-today-layer" aria-hidden>
              <div
                className="roadmap-today-line"
                style={{ '--today-left': `${todayLeft}%` } as CSSProperties}
              />
            </div>
          ) : null}

          <div className="roadmap-head-row">
            <div className="roadmap-col-task roadmap-sheet-toolbar">
              <div>
                <h2>ЗНИ Digital</h2>
                <p>Start Date в пределах квартала</p>
              </div>
              <span className="roadmap-count">{loading ? '…' : `${items.length} ЗНИ`}</span>
            </div>
            <div className="roadmap-col-timeline roadmap-timeline-head">
              <div className="roadmap-timeline-ruler">
                <div className="roadmap-timeline-months">
                  {months.map((tick) => (
                    <span
                      key={tick.label}
                      className="roadmap-timeline-month"
                      style={{ left: `${tick.left}%` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
                <div className="roadmap-timeline-days">
                  {days.map((tick, index) => (
                    <span
                      key={`${tick.label}-${index}`}
                      className={`roadmap-timeline-day${tick.isFirstOfMonth ? ' is-month-start' : ''}`}
                      style={{ left: `${tick.left}%` }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {!loading && items.length === 0 ? (
            <div className="roadmap-empty">Нет ЗНИ с Start Date в выбранном квартале</div>
          ) : null}

          {items.map((item) => {
            const startDate = item.startDate!
            const visual = barVisual(startDate, to, fromDate, toDate)
            const column = item.boardColumn?.trim() || item.status?.trim() || '—'
            const statusClass = columnBarClass(column)
            const priorityClass = roadmapPriorityBarClass(item.roadmapPriority)
            const barClassName = ['roadmap-bar', statusClass, priorityClass].filter(Boolean).join(' ')
            const commentValue = commentDrafts[item.number] ?? item.roadmapComment ?? ''
            const commentSaving = savingComment === item.number

            return (
              <div key={item.number} className="roadmap-data-row">
                <div className="roadmap-col-task">
                  <div className="roadmap-task-row">
                    <div className="roadmap-task-top">
                      {item.url ? (
                        <a
                          className="roadmap-task-id"
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          #{item.number}
                        </a>
                      ) : (
                        <span className="roadmap-task-id">#{item.number}</span>
                      )}
                    </div>
                    <p className="roadmap-task-title">{item.title}</p>
                    <div className="roadmap-task-meta">
                      <span className="roadmap-task-column">{column}</span>
                      <span>Старт {formatRuDate(startDate)}</span>
                    </div>
                    <RoadmapPriorityPicker
                      value={item.roadmapPriority}
                      saving={savingPriority === item.number}
                      disabled={!canEditPriority}
                      onChange={(priority) => void updateRoadmapPriority(item, priority)}
                    />
                  </div>
                </div>
                <div className="roadmap-col-timeline">
                  <div className="roadmap-zoom-track">
                    <div className="roadmap-row-track">
                      <div
                        className={barClassName}
                        style={{
                          left: `${visual.leftPct}%`,
                          width: `${visual.widthPct}%`,
                        }}
                        title={`#${item.number} ${item.title}\nСтарт ${formatRuDate(startDate)} → конец квартала ${formatRuDate(to)}`}
                      >
                        <div className="roadmap-bar-text">
                          <span className="roadmap-bar-status">{column}</span>
                          <span className="roadmap-bar-label">
                            <b>#{item.number}</b> {item.title}
                          </span>
                        </div>
                        {canEditComment ? (
                          <textarea
                            className="roadmap-bar-comment"
                            value={commentValue}
                            placeholder="Комментарий"
                            rows={2}
                            maxLength={500}
                            disabled={commentSaving}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => {
                              const nextValue = event.target.value
                              setCommentDrafts((drafts) => ({
                                ...drafts,
                                [item.number]: nextValue,
                              }))
                            }}
                            onBlur={() => void saveRoadmapComment(item, commentValue)}
                          />
                        ) : commentValue ? (
                          <p className="roadmap-bar-comment-readonly">{commentValue}</p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
