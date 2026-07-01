import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import OrgPhoto from './OrgPhoto'
import { buildHolidayKeySet } from './ruPublicHolidays'
import { getMonthGroups, getYearDays, isDayOff, toDayKey } from './scheduleUtils'
import type { VacationEmployee, WorkspaceOfficePresenceData } from './types'

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

type EmployeeGroup = {
  key: string
  label: string
  employees: VacationEmployee[]
}

function sortLeadersFirst(employees: VacationEmployee[]): VacationEmployee[] {
  const leaderIds = new Set<number>()
  for (const employee of employees) {
    if (employee.managerId != null) {
      leaderIds.add(employee.managerId)
    }
  }
  return [...employees].sort((a, b) => {
    const aLeader = leaderIds.has(a.id)
    const bLeader = leaderIds.has(b.id)
    if (aLeader !== bLeader) return aLeader ? -1 : 1
    return a.fullName.localeCompare(b.fullName, 'ru')
  })
}

function groupEmployeesByDepartment(employees: VacationEmployee[]): EmployeeGroup[] {
  const namedGroups = new Map<string, VacationEmployee[]>()
  const noDepartment: VacationEmployee[] = []
  for (const employee of employees) {
    const departmentName = employee.departmentName?.trim()
    if (departmentName) {
      if (!namedGroups.has(departmentName)) {
        namedGroups.set(departmentName, [])
      }
      namedGroups.get(departmentName)?.push(employee)
    } else {
      noDepartment.push(employee)
    }
  }
  const groups = Array.from(namedGroups.entries()).map(([label, groupEmployees]) => ({
    key: label,
    label,
    employees: sortLeadersFirst(groupEmployees),
  }))
  if (noDepartment.length > 0) {
    groups.unshift({
      key: '__no_department__',
      label: 'Без отдела',
      employees: sortLeadersFirst(noDepartment),
    })
  }
  return groups
}

export default function OfficePresence() {
  const currentDate = new Date()
  const currentYear = currentDate.getFullYear()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.workspaceYear)
  const [data, setData] = useState<WorkspaceOfficePresenceData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDayKey(new Date()))
  const [isDragScrolling, setIsDragScrolling] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startScrollLeft: number
    moved: boolean
  } | null>(null)

  const yearDays = useMemo(() => getYearDays(year), [year])
  const monthGroups = useMemo(() => getMonthGroups(yearDays), [yearDays])
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
  const employeeGroups = useMemo(() => groupEmployeesByDepartment(data?.employees ?? []), [data?.employees])

  useEffect(() => {
    saveOrgUiState({ workspaceYear: year, workspaceMonth: new Date().getMonth() })
  }, [year])

  useEffect(() => {
    if (selectedDayKey.startsWith(`${year}-`)) return
    const fallbackDate =
      year === currentYear
        ? new Date(year, currentDate.getMonth(), currentDate.getDate())
        : new Date(year, 0, 1)
    setSelectedDayKey(toDayKey(fallbackDate))
  }, [year, selectedDayKey, currentYear, currentDate])

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
      const monthStartIndex = yearDays.findIndex(
        (day) => day.getMonth() === currentDate.getMonth() && day.getDate() === 1,
      )
      if (monthStartIndex >= 0) {
        scrollRef.current.scrollLeft = Math.max(0, monthStartIndex * 26 - 80)
      }
    }
  }, [year, yearDays, currentYear, currentDate])

  const finishDragScroll = (pointerId?: number) => {
    const scrollEl = scrollRef.current
    if (scrollEl && pointerId != null && scrollEl.hasPointerCapture(pointerId)) {
      scrollEl.releasePointerCapture(pointerId)
    }
    dragStateRef.current = null
    setIsDragScrolling(false)
  }

  const handleScrollPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (!scrollRef.current) return
    const target = event.target as Element | null
    if (target?.closest('.org-vacation-day-head')) {
      return
    }
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: scrollRef.current.scrollLeft,
      moved: false,
    }
    scrollRef.current.setPointerCapture(event.pointerId)
    setIsDragScrolling(true)
  }

  const handleScrollPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag || !scrollRef.current) return
    const deltaX = event.clientX - drag.startX
    if (!drag.moved && Math.abs(deltaX) > 3) {
      drag.moved = true
    }
    scrollRef.current.scrollLeft = drag.startScrollLeft - deltaX
    if (drag.moved) {
      event.preventDefault()
    }
  }

  const handleScrollPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    finishDragScroll(event.pointerId)
  }

  const handleScrollPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    finishDragScroll(event.pointerId)
  }

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
            className={`org-vacation-scroll org-workspace-scroll${
              isDragScrolling ? ' org-workspace-scroll-dragging' : ''
            }`}
            ref={scrollRef}
            aria-label="Календарь посещений — прокрутка влево и вправо"
            onPointerDown={handleScrollPointerDown}
            onPointerMove={handleScrollPointerMove}
            onPointerUp={handleScrollPointerUp}
            onPointerCancel={handleScrollPointerCancel}
          >
            <table className="org-vacation-grid">
              <thead>
                <tr>
                  <th className="org-vacation-sticky-col org-vacation-names-head" rowSpan={2}>
                    Сотрудник
                  </th>
                  {monthGroups.map((group, index) => (
                    <th key={`${group.label}-${index}`} colSpan={group.length} className="org-vacation-month">
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
                        }${key === todayKey ? ' org-vacation-today' : ''}${
                          key === selectedDayKey ? ' org-vacation-day-selected' : ''
                        }`}
                        title={key}
                        onClick={() => setSelectedDayKey(key)}
                      >
                        {day.getDate()}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {employeeGroups.map((group) => (
                  <Fragment key={group.key}>
                    <tr className="org-vacation-group-row">
                      <th className="org-vacation-sticky-col org-vacation-group-cell" scope="rowgroup">
                        {group.label}
                      </th>
                      <td className="org-vacation-group-fill" colSpan={yearDays.length} />
                    </tr>
                    {group.employees.map((employee) => (
                      <tr
                        key={employee.id}
                        className={employee.isSelf ? 'org-vacation-row-self' : undefined}
                      >
                        <td
                          className="org-vacation-sticky-col org-vacation-name"
                          title={employee.position ?? undefined}
                        >
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
                          const dayOff =
                            !placeName &&
                            !officeMarked &&
                            isDayOff(day, holidayKeys)
                          const tip = formatPresenceTip(placeName, officeMarked)
                          return (
                            <td
                              key={dayKey}
                              className={[
                                'org-vacation-cell',
                                'org-office-presence-cell',
                                placeName || officeMarked ? 'org-office-presence-in' : 'org-workspace-free',
                                dayOff ? 'org-vacation-weekend' : '',
                                dayKey === selectedDayKey ? 'org-vacation-cell-selected-day' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              data-tip={tip}
                              aria-label={tip}
                            />
                          )
                        })}
                      </tr>
                    ))}
                  </Fragment>
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
