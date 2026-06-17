import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { getJson } from './api'
import type { ChangeRequest } from './zniTypes'
import { columnBarClass } from './roadmap/kanbanColumns'
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

export default function Roadmap() {
  const saved = useMemo(() => loadRoadmapUiState(), [])
  const [year, setYear] = useState(saved.year ?? new Date().getFullYear())
  const [quarter, setQuarter] = useState(saved.quarter ?? currentQuarter())
  const [items, setItems] = useState<ChangeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
        </div>
      </div>

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
                  </div>
                </div>
                <div className="roadmap-col-timeline">
                  <div className="roadmap-zoom-track">
                    <div className="roadmap-row-track">
                      <div
                        className={`roadmap-bar ${statusClass}`}
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
