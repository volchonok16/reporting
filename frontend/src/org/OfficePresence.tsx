import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import OrgPhoto from './OrgPhoto'
import { buildHolidayKeySet } from './ruPublicHolidays'
import { MONTH_NAMES_FULL, WEEKDAY_NAMES, getMonthDays, isWeekendDay, toDayKey } from './scheduleUtils'
import type { WorkspaceOfficePresenceData } from './types'

function presenceKey(employeeId: number, day: string): string {
  return `${employeeId}:${day}`
}

function formatPresenceTip(
  placeName: string | null,
  officeMarked: boolean,
): string | undefined {
  if (placeName) {
    return `В офисе · ${placeName}`
  }
  if (officeMarked) {
    return 'В офисе · без места'
  }
  return undefined
}

export default function OfficePresence() {
  const currentDate = new Date()
  const currentYear = currentDate.getFullYear()
  const currentMonth = currentDate.getMonth()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.workspaceYear)
  const [month, setMonth] = useState(savedOrgUi.workspaceMonth)
  const [data, setData] = useState<WorkspaceOfficePresenceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const monthDays = useMemo(() => getMonthDays(year, month), [year, month])
  const holidayKeys = useMemo(() => buildHolidayKeySet(year), [year])
  const todayKey = toDayKey(currentDate)

  const presenceMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of data?.presence ?? []) {
      map.set(presenceKey(item.employeeId, item.day), item.placeName)
    }
    return map
  }, [data])

  const officeDaysSet = useMemo(() => {
    const set = new Set<string>()
    for (const item of data?.officeDays ?? []) {
      set.add(presenceKey(item.employeeId, item.day))
    }
    return set
  }, [data])

  useEffect(() => {
    saveOrgUiState({ workspaceYear: year, workspaceMonth: month })
  }, [year, month])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams({ year: String(year), month: String(month + 1) })
      const response = await getJson<WorkspaceOfficePresenceData>(
        `/api/org/workspace/presence?${query.toString()}`,
      )
      setData(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [year, month])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (scrollRef.current && year === currentYear && month === currentMonth) {
      const todayIndex = monthDays.findIndex((day) => toDayKey(day) === todayKey)
      if (todayIndex > 0) {
        scrollRef.current.scrollLeft = Math.max(0, todayIndex * 26 - 100)
      }
    }
  }, [year, month, monthDays, todayKey, currentYear, currentMonth])

  return (
    <section className="org-panel org-vacation-panel org-office-presence-panel">
      <div className="org-panel-toolbar org-vacation-toolbar">
        <div className="org-vacation-toolbar-left">
          <h2>Сотрудники в офисе</h2>
          <div className="org-vacation-year-picker" role="group" aria-label="Год">
            {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
              <button
                key={y}
                type="button"
                className={`org-vacation-year-btn${year === y ? ' org-vacation-year-btn-active' : ''}`}
                onClick={() => setYear(y)}
                aria-pressed={year === y}
              >
                {y}
              </button>
            ))}
          </div>
          <label className="org-workspace-month-picker">
            <span className="org-workspace-month-label">Месяц</span>
            <select
              className="org-workspace-month-select"
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
            >
              {MONTH_NAMES_FULL.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p className="org-hint">
        План посещения по броням мест и самоотметкам из личного кабинета. Наведите на ячейку, чтобы
        увидеть место или отметку «без места».
      </p>

      <div className="org-vacation-legend">
        <span className="org-vacation-legend-item org-office-presence-in">В офисе</span>
        <span className="org-vacation-legend-item org-workspace-free">Нет отметки</span>
        <span className="org-vacation-legend-item org-vacation-weekend">Выходной и праздник</span>
      </div>

      {error ? <p className="org-error">{error}</p> : null}
      {loading && !data ? <p>Загрузка…</p> : null}

      {data && !loading ? (
        <div className="org-vacation-chart-wrap">
          <div
            className="org-vacation-scroll"
            ref={scrollRef}
            aria-label="Календарь посещений — прокрутка влево и вправо"
          >
            <table className="org-vacation-grid">
              <thead>
                <tr>
                  <th className="org-vacation-sticky-col org-vacation-names-head" rowSpan={2}>
                    Сотрудник
                  </th>
                  <th colSpan={monthDays.length} className="org-vacation-month">
                    {MONTH_NAMES_FULL[month]} {year}
                  </th>
                </tr>
                <tr>
                  {monthDays.map((day) => {
                    const key = toDayKey(day)
                    const dayOff = isWeekendDay(day) || holidayKeys.has(key)
                    return (
                      <th
                        key={key}
                        className={`org-vacation-day-head${
                          dayOff ? ' org-vacation-weekend' : ''
                        }${key === todayKey ? ' org-vacation-today' : ''}`}
                        title={`${WEEKDAY_NAMES[day.getDay()]} · ${key}`}
                      >
                        {day.getDate()}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {data.employees.map((employee) => (
                  <tr
                    key={employee.id}
                    className={employee.isSelf ? 'org-vacation-row-self' : undefined}
                  >
                    <td className="org-vacation-sticky-col org-vacation-name" title={employee.position ?? undefined}>
                      <span className="org-person-cell">
                        <OrgPhoto
                          url={employee.photoUrl}
                          name={employee.fullName}
                          className="org-table-avatar-img org-vacation-avatar"
                          placeholderClassName="org-table-avatar org-vacation-avatar"
                        />
                        <span className="org-vacation-name-text">
                          {employee.fullName}
                          {employee.isSelf ? <span className="org-vacation-self-badge">вы</span> : null}
                        </span>
                      </span>
                    </td>
                    {monthDays.map((day) => {
                      const dayKey = toDayKey(day)
                      const placeName = presenceMap.get(presenceKey(employee.id, dayKey)) ?? null
                      const officeMarked = officeDaysSet.has(presenceKey(employee.id, dayKey))
                      const dayOff =
                        !placeName &&
                        !officeMarked &&
                        (isWeekendDay(day) || holidayKeys.has(dayKey))
                      const tip = formatPresenceTip(placeName, officeMarked)
                      return (
                        <td
                          key={dayKey}
                          className={[
                            'org-vacation-cell',
                            'org-office-presence-cell',
                            placeName || officeMarked ? 'org-office-presence-in' : 'org-workspace-free',
                            dayOff ? 'org-vacation-weekend' : '',
                            dayKey === todayKey ? 'org-vacation-today' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          data-tip={tip}
                          title={tip}
                          aria-label={tip}
                        />
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {data && data.employees.length === 0 ? (
        <p className="org-hint">Нет активных сотрудников.</p>
      ) : null}
    </section>
  )
}
