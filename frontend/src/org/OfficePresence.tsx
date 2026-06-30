import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import OrgPhoto from './OrgPhoto'
import { buildHolidayKeySet } from './ruPublicHolidays'
import { getMonthGroups, getYearDays, isDayOff, toDayKey } from './scheduleUtils'
import type { TimeOffKind, WorkspaceOfficePresenceData } from './types'

const KIND_META: Record<TimeOffKind, { label: string; className: string }> = {
  vacation: { label: 'Отпуск', className: 'vac-kind-vacation' },
  dayoff: { label: 'Отгул', className: 'vac-kind-dayoff' },
  sick_leave: { label: 'Больничный', className: 'vac-kind-sick' },
}

function presenceKey(employeeId: number, day: string): string {
  return `${employeeId}:${day}`
}

function formatPresenceTip(
  placeName: string | null,
  officeMarked: boolean,
  timeOffKind: TimeOffKind | null,
): string | undefined {
  if (timeOffKind && placeName) {
    return `${KIND_META[timeOffKind].label} · бронь: ${placeName}`
  }
  if (timeOffKind && officeMarked) {
    return `${KIND_META[timeOffKind].label} · отмечен как в офисе (без места)`
  }
  if (timeOffKind) {
    return KIND_META[timeOffKind].label
  }
  if (placeName) {
    return `В офисе · ${placeName}`
  }
  if (officeMarked) {
    return 'В офисе · без места'
  }
  return undefined
}

export default function OfficePresence() {
  const currentYear = new Date().getFullYear()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.vacationYear)
  const [data, setData] = useState<WorkspaceOfficePresenceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const yearDays = useMemo(() => getYearDays(year), [year])
  const monthGroups = useMemo(() => getMonthGroups(yearDays), [yearDays])
  const holidayKeys = useMemo(() => buildHolidayKeySet(year), [year])
  const todayKey = toDayKey(new Date())

  const presenceMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of data?.presence ?? []) {
      map.set(presenceKey(item.employeeId, item.day), item.placeName)
    }
    return map
  }, [data])

  const timeOffMap = useMemo(() => {
    const map = new Map<string, TimeOffKind>()
    for (const item of data?.timeOffDays ?? []) {
      map.set(presenceKey(item.employeeId, item.day), item.kind)
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
    saveOrgUiState({ vacationYear: year })
  }, [year])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams({ year: String(year) })
      const response = await getJson<WorkspaceOfficePresenceData>(
        `/api/org/workspace/presence?${query.toString()}`,
      )
      setData(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [year])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (scrollRef.current && year === currentYear) {
      const todayIndex = yearDays.findIndex((day) => toDayKey(day) === todayKey)
      if (todayIndex > 0) {
        scrollRef.current.scrollLeft = Math.max(0, todayIndex * 26 - 120)
      }
    }
  }, [year, yearDays, todayKey, currentYear])

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
        </div>
      </div>

      <p className="org-hint">
        План посещения по броням мест и самоотметкам из личного кабинета. Наведите на ячейку, чтобы
        увидеть место или отметку «без места». Отпуска, отгулы и больничные учитываются из графика отпусков.
      </p>

      <div className="org-vacation-legend">
        <span className="org-vacation-legend-item org-office-presence-in">В офисе</span>
        {Object.entries(KIND_META).map(([kind, meta]) => (
          <span key={kind} className={`org-vacation-legend-item ${meta.className}`}>
            {meta.label}
          </span>
        ))}
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
                  {monthGroups.map((group, index) => (
                    <th
                      key={`${group.label}-${index}`}
                      colSpan={group.length}
                      className="org-vacation-month"
                    >
                      {group.label}
                    </th>
                  ))}
                </tr>
                <tr>
                  {yearDays.map((day) => {
                    const key = toDayKey(day)
                    const dayOff = isDayOff(day, holidayKeys)
                    return (
                      <th
                        key={key}
                        className={`org-vacation-day-head${
                          dayOff ? ' org-vacation-weekend' : ''
                        }${key === todayKey ? ' org-vacation-today' : ''}`}
                        title={key}
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
                    {yearDays.map((day) => {
                      const dayKey = toDayKey(day)
                      const placeName = presenceMap.get(presenceKey(employee.id, dayKey)) ?? null
                      const officeMarked = officeDaysSet.has(presenceKey(employee.id, dayKey))
                      const timeOffKind = timeOffMap.get(presenceKey(employee.id, dayKey)) ?? null
                      const dayOff = !timeOffKind && !placeName && !officeMarked && isDayOff(day, holidayKeys)
                      const tip = formatPresenceTip(placeName, officeMarked, timeOffKind)
                      return (
                        <td
                          key={dayKey}
                          className={[
                            'org-vacation-cell',
                            'org-office-presence-cell',
                            timeOffKind ? KIND_META[timeOffKind].className : '',
                            (placeName || officeMarked) && !timeOffKind ? 'org-office-presence-in' : '',
                            placeName && timeOffKind ? 'org-office-presence-conflict' : '',
                            officeMarked && timeOffKind ? 'org-office-presence-conflict' : '',
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
