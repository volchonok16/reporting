import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, putJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import OrgPhoto from './OrgPhoto'
import { buildHolidayKeySet } from './ruPublicHolidays'
import { getMonthGroups, getYearDays, isDayOff, toDayKey } from './scheduleUtils'
import type { EditableTimeOffKind, TimeOffKind, VacationEmployee, VacationScheduleData } from './types'

type VacationScheduleProps = {
  orgEmployeeId: number | null
  canManage: boolean
  year?: number
  onYearChange?: (year: number) => void
}

const KIND_META: Record<TimeOffKind, { label: string; className: string }> = {
  vacation: { label: 'Отпуск', className: 'vac-kind-vacation' },
  dayoff: { label: 'Отгул', className: 'vac-kind-dayoff' },
  sick_leave: { label: 'Больничный', className: 'vac-kind-sick' },
}

const BRUSHES: Array<{ id: EditableTimeOffKind; label: string; className: string }> = [
  { id: 'vacation', label: 'Отпуск', className: 'vac-kind-vacation' },
  { id: 'dayoff', label: 'Отгул', className: 'vac-kind-dayoff' },
  { id: 'sick_leave', label: 'Больничный', className: 'vac-kind-sick' },
  { id: 'erase', label: 'Рабочий', className: 'vac-kind-erase' },
]

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

function buildRangeDays(fromDay: string, toDay: string): string[] {
  const from = new Date(`${fromDay}T12:00:00`)
  const to = new Date(`${toDay}T12:00:00`)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return []
  const start = from <= to ? from : to
  const end = from <= to ? to : from
  const days: string[] = []
  const cursor = new Date(start)
  while (cursor <= end) {
    days.push(toDayKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

export default function VacationSchedule({
  orgEmployeeId,
  canManage,
  year: yearProp,
  onYearChange,
}: VacationScheduleProps) {
  const currentDate = useMemo(() => new Date(), [])
  const currentYear = currentDate.getFullYear()
  const currentMonth = currentDate.getMonth()
  const currentDay = currentDate.getDate()
  const savedOrgUi = loadOrgUiState()
  const [internalYear, setInternalYear] = useState(savedOrgUi.vacationYear)
  const year = yearProp ?? internalYear
  const [data, setData] = useState<VacationScheduleData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [brush, setBrush] = useState<EditableTimeOffKind>('vacation')
  const [rangeStart, setRangeStart] = useState<{ employeeId: number; day: string } | null>(null)
  const [hoverDay, setHoverDay] = useState<string | null>(null)
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDayKey(new Date()))
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const yearDays = useMemo(() => getYearDays(year), [year])
  const monthGroups = useMemo(() => getMonthGroups(yearDays), [yearDays])
  const holidayKeys = useMemo(() => buildHolidayKeySet(year), [year])
  const todayKey = toDayKey(currentDate)

  const dayKindMap = useMemo(() => {
    const map = new Map<string, TimeOffKind>()
    for (const row of data?.timeOffDays ?? []) {
      map.set(`${row.employeeId}:${row.day}`, row.kind)
    }
    return map
  }, [data])

  useEffect(() => {
    if (yearProp == null) {
      saveOrgUiState({ vacationYear: year })
    }
  }, [year, yearProp])

  useEffect(() => {
    if (selectedDayKey.startsWith(`${year}-`)) return
    const fallbackDate = new Date(year, currentMonth, currentDay)
    setSelectedDayKey(toDayKey(fallbackDate))
  }, [year, selectedDayKey, currentMonth, currentDay])

  const setYear = (nextYear: number) => {
    if (onYearChange) {
      onYearChange(nextYear)
      return
    }
    setInternalYear(nextYear)
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams({ year: String(year) })
      const response = await getJson<VacationScheduleData>(`/api/org/vacations?${query.toString()}`)
      setData(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [year])

  useEffect(() => {
    void load()
    setRangeStart(null)
  }, [load])

  useEffect(() => {
    if (!scrollRef.current || !data) return
    const monthStartKey = `${year}-${String(currentMonth + 1).padStart(2, '0')}-01`
    const monthStartCell = scrollRef.current.querySelector<HTMLElement>(
      `th[data-day-key="${monthStartKey}"]`,
    )
    if (!monthStartCell) return
    const stickyNamesWidth = 220
    scrollRef.current.scrollLeft = Math.max(0, monthStartCell.offsetLeft - stickyNamesWidth - 24)
  }, [year, data, currentMonth])

  const applyRange = async (employeeId: number, fromDay: string, toDay: string) => {
    setSaving(true)
    setError(null)
    try {
      await putJson<{ affectedDays: number }>('/api/org/vacations/range', {
        employeeId,
        fromDay,
        toDay,
        kind: brush,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    } finally {
      setSaving(false)
      setRangeStart(null)
      setHoverDay(null)
    }
  }

  const handleCellClick = (employeeId: number, day: string, canEdit: boolean) => {
    if (!editMode || !canEdit || saving) return
    if (rangeStart === null) {
      setRangeStart({ employeeId, day })
      return
    }
    if (rangeStart.employeeId !== employeeId) {
      setRangeStart({ employeeId, day })
      return
    }
    void applyRange(employeeId, rangeStart.day, day)
  }

  const previewDays = useMemo(() => {
    if (!rangeStart || !hoverDay) return new Set<string>()
    return new Set(buildRangeDays(rangeStart.day, hoverDay))
  }, [rangeStart, hoverDay])

  const hasEditableRows = (data?.employees ?? []).some((emp) => emp.canEdit)
  const employeeGroups = useMemo(() => groupEmployeesByDepartment(data?.employees ?? []), [data?.employees])

  return (
    <section className="org-panel org-vacation-panel">
      <div className="org-panel-toolbar org-vacation-toolbar">
        <div className="org-vacation-toolbar-left">
          <h2>График отпусков</h2>
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
        <div className="org-vacation-toolbar-right">
          {hasEditableRows ? (
            <button
              type="button"
              className={editMode ? 'btn-primary' : 'btn-ghost'}
              onClick={() => {
                setEditMode((value) => !value)
                setRangeStart(null)
              }}
            >
              {editMode ? 'Готово' : 'Редактировать'}
            </button>
          ) : (
            <span className="org-hint">Редактирование доступно только для своей строки</span>
          )}
        </div>
      </div>

      {canManage ? (
        <p className="org-hint">Администратор может редактировать график любого сотрудника.</p>
      ) : null}

      {orgEmployeeId === null ? (
        <p className="org-hint">
          Просмотр графика всей компании доступен всем. Чтобы редактировать свою строку, привяжите учётную
          запись к карточке сотрудника (Личный кабинет или «Управление»).
        </p>
      ) : null}

      {editMode ? (
        <div className="org-vacation-brushes" role="toolbar" aria-label="Тип отсутствия">
          {BRUSHES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`org-vacation-brush${brush === item.id ? ' org-vacation-brush-active' : ''} ${item.className}`}
              onClick={() => setBrush(item.id)}
            >
              {item.label}
            </button>
          ))}
          <span className="org-hint">Клик по началу и концу диапазона в строке сотрудника</span>
        </div>
      ) : (
        <div className="org-vacation-legend">
          {Object.entries(KIND_META).map(([kind, meta]) => (
            <span key={kind} className={`org-vacation-legend-item ${meta.className}`}>
              {meta.label}
            </span>
          ))}
          <span className="org-vacation-legend-item org-vacation-weekend">Выходной и праздник</span>
        </div>
      )}

      {error ? <p className="org-error">{error}</p> : null}
      {loading ? <p>Загрузка…</p> : null}
      {saving ? <p>Сохранение…</p> : null}

      {data && !loading ? (
        <div className="org-vacation-chart-wrap">
          <div
            className="org-vacation-scroll"
            ref={scrollRef}
            aria-label="Календарь — прокрутка влево и вправо"
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
                        data-day-key={key}
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
                    <tr key={`group-${group.key}`} className="org-vacation-group-row">
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
                              {employee.isSelf ? (
                                <span className="org-vacation-self-badge">вы</span>
                              ) : null}
                            </span>
                          </span>
                        </td>
                        {yearDays.map((day) => {
                          const dayKey = toDayKey(day)
                          const kind = dayKindMap.get(`${employee.id}:${dayKey}`)
                          const dayOff = !kind && isDayOff(day, holidayKeys)
                          const inPreview =
                            rangeStart?.employeeId === employee.id && previewDays.has(dayKey)
                          const isSelecting =
                            rangeStart?.employeeId === employee.id && rangeStart.day === dayKey
                          return (
                            <td
                              key={dayKey}
                              className={[
                                'org-vacation-cell',
                                kind ? KIND_META[kind].className : '',
                                dayOff ? 'org-vacation-weekend' : '',
                                dayKey === todayKey ? 'org-vacation-today' : '',
                                dayKey === selectedDayKey ? 'org-vacation-cell-selected-day' : '',
                                inPreview ? 'org-vacation-preview' : '',
                                isSelecting ? 'org-vacation-selecting' : '',
                                editMode && employee.canEdit ? 'org-vacation-editable' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                              title={kind ? KIND_META[kind].label : undefined}
                              onClick={() => handleCellClick(employee.id, dayKey, employee.canEdit)}
                              onMouseEnter={() => {
                                if (rangeStart?.employeeId === employee.id) setHoverDay(dayKey)
                              }}
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
