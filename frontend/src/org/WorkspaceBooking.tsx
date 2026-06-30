import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, putJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import type { WorkspaceBookingScheduleData } from './types'
import {
  MONTH_NAMES_FULL,
  WEEKDAY_NAMES,
  getMonthDays,
  isWeekendDay,
  toDayKey,
} from './scheduleUtils'

type WorkspaceBookingProps = {
  orgEmployeeId: number | null
}

function employeeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase()
}

export default function WorkspaceBooking({ orgEmployeeId }: WorkspaceBookingProps) {
  const currentDate = new Date()
  const currentYear = currentDate.getFullYear()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.vacationYear)
  const [month, setMonth] = useState(currentDate.getMonth())
  const [data, setData] = useState<WorkspaceBookingScheduleData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [bookForEmployeeId, setBookForEmployeeId] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const monthDays = useMemo(() => getMonthDays(year, month), [year, month])
  const todayKey = toDayKey(currentDate)

  const bookingMap = useMemo(() => {
    const map = new Map<string, WorkspaceBookingScheduleData['bookings'][number]>()
    for (const row of data?.bookings ?? []) {
      map.set(`${row.placeId}:${row.day}`, row)
    }
    return map
  }, [data])

  const canEditAny = Boolean(data?.isAdmin || data?.actorEmployeeId != null)

  useEffect(() => {
    saveOrgUiState({ vacationYear: year })
  }, [year])

  useEffect(() => {
    if (!data?.isAdmin || bookForEmployeeId != null) return
    if (data.actorEmployeeId != null) {
      setBookForEmployeeId(data.actorEmployeeId)
      return
    }
    if (data.employees.length > 0) {
      setBookForEmployeeId(data.employees[0].id)
    }
  }, [data, bookForEmployeeId])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const query = new URLSearchParams({
        year: String(year),
        month: String(month + 1),
      })
      const response = await getJson<WorkspaceBookingScheduleData>(
        `/api/org/workspace/bookings?${query.toString()}`,
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
    if (scrollRef.current && year === currentDate.getFullYear() && month === currentDate.getMonth()) {
      const todayIndex = monthDays.findIndex((day) => toDayKey(day) === todayKey)
      if (todayIndex > 0) {
        scrollRef.current.scrollLeft = Math.max(0, todayIndex * 28 - 80)
      }
    }
  }, [monthDays, todayKey, year, month, currentDate])

  const toggleCell = async (
    placeId: number,
    day: string,
    booking: WorkspaceBookingScheduleData['bookings'][number] | undefined,
  ) => {
    if (!editMode || saving) return

    const isAdmin = data?.isAdmin ?? false
    const actorId = data?.actorEmployeeId ?? null

    if (booking) {
      if (!booking.canRelease) return
      setSaving(true)
      setError(null)
      try {
        await putJson('/api/org/workspace/bookings/toggle', {
          placeId,
          day,
          action: 'release',
        })
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ошибка сохранения')
      } finally {
        setSaving(false)
      }
      return
    }

    if (actorId == null && !isAdmin) return

    const employeeId = isAdmin ? bookForEmployeeId : actorId
    if (employeeId == null) {
      setError('Выберите сотрудника для бронирования.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      await putJson('/api/org/workspace/bookings/toggle', {
        placeId,
        day,
        action: 'book',
        employeeId,
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="org-panel org-workspace-panel">
      <div className="org-panel-toolbar org-vacation-toolbar">
        <div className="org-vacation-toolbar-left">
          <h2>Бронь мест</h2>
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
          <label className="org-vacation-year">
            Месяц
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES_FULL.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="org-vacation-toolbar-right">
          {canEditAny ? (
            <button
              type="button"
              className={editMode ? 'btn-primary' : 'btn-ghost'}
              onClick={() => setEditMode((value) => !value)}
            >
              {editMode ? 'Готово' : 'Редактировать'}
            </button>
          ) : (
            <span className="org-hint">Бронирование недоступно без карточки сотрудника</span>
          )}
        </div>
      </div>

      {data?.isAdmin ? (
        <p className="org-hint">Администратор может бронировать место за любого сотрудника.</p>
      ) : null}

      {orgEmployeeId === null && !data?.isAdmin ? (
        <p className="org-hint">
          Просмотр занятости доступен всем. Чтобы бронировать за себя, привяжите учётную запись к карточке
          сотрудника.
        </p>
      ) : null}

      {editMode && data?.isAdmin ? (
        <label className="org-workspace-book-for">
          Бронировать за
          <select
            value={bookForEmployeeId ?? ''}
            onChange={(e) => setBookForEmployeeId(Number(e.target.value))}
          >
            {data.employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.fullName}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {editMode ? (
        <p className="org-hint">
          Свободная ячейка — забронировать{data?.isAdmin ? ' выбранному сотруднику' : ''}; занятая — снять бронь
          (если есть права).
        </p>
      ) : null}

      <div className="org-vacation-legend">
        <span className="org-vacation-legend-item org-workspace-free">Свободно</span>
        <span className="org-vacation-legend-item org-workspace-self">Ваша бронь</span>
        <span className="org-vacation-legend-item org-workspace-busy">Занято</span>
      </div>

      {error ? <p className="org-error">{error}</p> : null}
      {loading ? <p>Загрузка…</p> : null}
      {saving ? <p>Сохранение…</p> : null}

      {data && !loading ? (
        <div className="org-vacation-chart org-workspace-chart">
          <div className="org-vacation-names">
            <table className="org-vacation-names-grid">
              <thead>
                <tr>
                  <th className="org-vacation-names-head" rowSpan={3}>
                    Место
                  </th>
                </tr>
                <tr aria-hidden="true" />
                <tr aria-hidden="true" />
              </thead>
              <tbody>
                {data.places.map((place) => (
                  <tr key={place.id}>
                    <td className="org-vacation-name org-workspace-place-name" title={place.name}>
                      {place.name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="org-vacation-dates-scroll"
            ref={scrollRef}
            aria-label="Календарь брони — прокрутка влево и вправо"
          >
            <table className="org-vacation-dates-grid org-workspace-dates-grid">
              <thead>
                <tr>
                  {monthDays.map((day) => {
                    const key = toDayKey(day)
                    const isWeekend = isWeekendDay(day)
                    return (
                      <th
                        key={`wd-${key}`}
                        className={`org-vacation-day-head org-workspace-weekday${isWeekend ? ' org-vacation-weekend' : ''}`}
                      >
                        {WEEKDAY_NAMES[day.getDay()]}
                      </th>
                    )
                  })}
                </tr>
                <tr>
                  {monthDays.map((day) => {
                    const key = toDayKey(day)
                    const isWeekend = isWeekendDay(day)
                    return (
                      <th
                        key={key}
                        className={`org-vacation-day-head${isWeekend ? ' org-vacation-weekend' : ''}${
                          key === todayKey ? ' org-vacation-today' : ''
                        }`}
                      >
                        {day.getDate()}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {data.places.map((place) => (
                  <tr key={place.id}>
                    {monthDays.map((day) => {
                      const dayKey = toDayKey(day)
                      const booking = bookingMap.get(`${place.id}:${dayKey}`)
                      const isWeekend = isWeekendDay(day)
                      const canBook =
                        editMode &&
                        !booking &&
                        (data.isAdmin ? bookForEmployeeId != null : data.actorEmployeeId != null)
                      const canRelease = editMode && booking?.canRelease
                      const isEditable = canBook || canRelease

                      return (
                        <td
                          key={`${place.id}-${dayKey}`}
                          className={[
                            'org-vacation-cell',
                            'org-workspace-cell',
                            booking ? (booking.isSelf ? 'org-workspace-self' : 'org-workspace-busy') : 'org-workspace-free',
                            isWeekend ? 'org-vacation-weekend' : '',
                            dayKey === todayKey ? 'org-vacation-today' : '',
                            isEditable ? 'org-vacation-editable' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          title={
                            booking
                              ? `${booking.employeeName}${booking.isSelf ? ' (вы)' : ''}`
                              : 'Свободно'
                          }
                          onClick={() => void toggleCell(place.id, dayKey, booking)}
                        >
                          {booking ? (
                            <span className="org-workspace-mark" aria-label={booking.employeeName}>
                              {data.isAdmin || booking.isSelf
                                ? employeeInitials(booking.employeeName)
                                : '×'}
                            </span>
                          ) : null}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  )
}
