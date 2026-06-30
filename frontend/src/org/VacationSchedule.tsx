import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, putJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import OrgPhoto from './OrgPhoto'
import { buildHolidayKeySet } from './ruPublicHolidays'
import { getMonthGroups, getYearDays, toDayKey } from './scheduleUtils'
import type { EditableTimeOffKind, TimeOffKind, VacationScheduleData } from './types'

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
  const currentYear = new Date().getFullYear()
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
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const yearDays = useMemo(() => getYearDays(year), [year])
  const monthGroups = useMemo(() => getMonthGroups(yearDays), [yearDays])
  const holidayKeys = useMemo(() => buildHolidayKeySet(year), [year])
  const todayKey = toDayKey(new Date())

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
    if (scrollRef.current && year === currentYear) {
      const todayIndex = yearDays.findIndex((day) => toDayKey(day) === todayKey)
      if (todayIndex > 0) {
        scrollRef.current.scrollLeft = Math.max(0, todayIndex * 26 - 120)
      }
    }
  }, [year, yearDays, todayKey, currentYear])

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
          <span className="org-vacation-legend-item org-vacation-holiday">Праздник</span>
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
                    const isWeekend = day.getDay() === 0 || day.getDay() === 6
                    const isHoliday = holidayKeys.has(key)
                    return (
                      <th
                        key={key}
                        className={`org-vacation-day-head${
                          isHoliday ? ' org-vacation-holiday' : isWeekend ? ' org-vacation-weekend' : ''
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
                          className="org-table-avatar-img"
                          placeholderClassName="org-table-avatar"
                        />
                        <span className="org-vacation-name-text">
                          {employee.fullName}
                          {employee.isSelf ? <span className="org-vacation-self-badge">вы</span> : null}
                        </span>
                      </span>
                    </td>
                    {yearDays.map((day) => {
                      const dayKey = toDayKey(day)
                      const kind = dayKindMap.get(`${employee.id}:${dayKey}`)
                      const isWeekend = day.getDay() === 0 || day.getDay() === 6
                      const isHoliday = holidayKeys.has(dayKey)
                      const inPreview =
                        rangeStart?.employeeId === employee.id && previewDays.has(dayKey)
                      const isSelecting = rangeStart?.employeeId === employee.id && rangeStart.day === dayKey
                      return (
                        <td
                          key={dayKey}
                          className={[
                            'org-vacation-cell',
                            kind ? KIND_META[kind].className : '',
                            !kind && isHoliday ? 'org-vacation-holiday' : !kind && isWeekend ? 'org-vacation-weekend' : '',
                            dayKey === todayKey ? 'org-vacation-today' : '',
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
