import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, putJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import OrgPhoto from './OrgPhoto'
import type { EditableTimeOffKind, TimeOffKind, VacationScheduleData } from './types'

type VacationScheduleProps = {
  orgEmployeeId: number | null
  canManage: boolean
}

const MONTH_NAMES = [
  'Янв',
  'Фев',
  'Мар',
  'Апр',
  'Май',
  'Июн',
  'Июл',
  'Авг',
  'Сен',
  'Окт',
  'Ноя',
  'Дек',
]

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

function getYearDays(year: number): Date[] {
  const days: Date[] = []
  const cursor = new Date(year, 0, 1)
  const end = new Date(year + 1, 0, 1)
  while (cursor < end) {
    days.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

function toDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
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

function getMonthGroups(days: Date[]) {
  const groups: Array<{ label: string; length: number }> = []
  let currentMonth = -1
  let currentLength = 0
  for (const day of days) {
    const month = day.getMonth()
    if (month !== currentMonth) {
      if (currentMonth !== -1) {
        groups.push({ label: MONTH_NAMES[currentMonth], length: currentLength })
      }
      currentMonth = month
      currentLength = 1
    } else {
      currentLength += 1
    }
  }
  if (currentMonth !== -1) {
    groups.push({ label: MONTH_NAMES[currentMonth], length: currentLength })
  }
  return groups
}

export default function VacationSchedule({ orgEmployeeId, canManage }: VacationScheduleProps) {
  const currentYear = new Date().getFullYear()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.vacationYear)
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
  const todayKey = toDayKey(new Date())

  const dayKindMap = useMemo(() => {
    const map = new Map<string, TimeOffKind>()
    for (const row of data?.timeOffDays ?? []) {
      map.set(`${row.employeeId}:${row.day}`, row.kind)
    }
    return map
  }, [data])

  useEffect(() => {
    saveOrgUiState({ vacationYear: year })
  }, [year])

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
        scrollRef.current.scrollLeft = Math.max(0, todayIndex * 24 - 120)
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
          <label className="org-vacation-year">
            Год
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
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
      ) : null}

      <div className="org-vacation-legend">
        {Object.entries(KIND_META).map(([kind, meta]) => (
          <span key={kind} className={`org-vacation-legend-item ${meta.className}`}>
            {meta.label}
          </span>
        ))}
      </div>

      {error ? <p className="org-error">{error}</p> : null}
      {loading ? <p>Загрузка…</p> : null}
      {saving ? <p>Сохранение…</p> : null}

      {data && !loading ? (
        <div className="org-vacation-chart">
          <div className="org-vacation-names">
            <table className="org-vacation-names-grid">
              <thead>
                <tr>
                  <th className="org-vacation-names-head" rowSpan={2}>
                    Сотрудник
                  </th>
                </tr>
                <tr aria-hidden="true" />
              </thead>
              <tbody>
                {data.employees.map((employee) => (
                  <tr
                    key={employee.id}
                    className={employee.isSelf ? 'org-vacation-row-self' : undefined}
                  >
                    <td className="org-vacation-name" title={employee.position ?? undefined}>
                      <span className="org-person-cell">
                        <OrgPhoto
                          url={employee.photoUrl}
                          name={employee.fullName}
                          className="org-table-avatar-img"
                          placeholderClassName="org-table-avatar"
                        />
                        <span>
                          {employee.fullName}
                          {employee.isSelf ? <span className="org-vacation-self-badge">вы</span> : null}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="org-vacation-dates-scroll"
            ref={scrollRef}
            aria-label="Календарь — прокрутка влево и вправо"
          >
            <table className="org-vacation-dates-grid">
              <thead>
                <tr>
                  {monthGroups.map((group) => (
                    <th key={group.label} colSpan={group.length} className="org-vacation-month">
                      {group.label}
                    </th>
                  ))}
                </tr>
                <tr>
                  {yearDays.map((day) => {
                    const key = toDayKey(day)
                    const isWeekend = day.getDay() === 0 || day.getDay() === 6
                    return (
                      <th
                        key={key}
                        className={`org-vacation-day-head${isWeekend ? ' org-vacation-weekend' : ''}${
                          key === todayKey ? ' org-vacation-today' : ''
                        }`}
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
                    {yearDays.map((day) => {
                      const dayKey = toDayKey(day)
                      const kind = dayKindMap.get(`${employee.id}:${dayKey}`)
                      const isWeekend = day.getDay() === 0 || day.getDay() === 6
                      const inPreview =
                        rangeStart?.employeeId === employee.id && previewDays.has(dayKey)
                      const isSelecting = rangeStart?.employeeId === employee.id && rangeStart.day === dayKey
                      return (
                        <td
                          key={dayKey}
                          className={[
                            'org-vacation-cell',
                            kind ? KIND_META[kind].className : '',
                            isWeekend ? 'org-vacation-weekend' : '',
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
