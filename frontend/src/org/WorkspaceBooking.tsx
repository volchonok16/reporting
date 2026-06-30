import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, putJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import {
  MONTH_NAMES_FULL,
  getMonthDays,
  isDayOff,
  toDayKey,
} from './scheduleUtils'
import { buildHolidayKeySet } from './ruPublicHolidays'
import type { WorkspaceBookingCell, WorkspaceBookingScheduleData } from './types'

type WorkspaceBookingProps = {
  orgEmployeeId: number | null
}

function formatWorkspaceCellTip(
  placeName: string,
  day: Date,
  booking: WorkspaceBookingCell | undefined,
  editMode: boolean,
  canBook: boolean,
  canRelease: boolean,
): string {
  const monthLabel = MONTH_NAMES_FULL[day.getMonth()].toLowerCase()
  const dateLabel = `${day.getDate()} ${monthLabel} ${day.getFullYear()}`
  const prefix = `${placeName} · ${dateLabel}`

  if (!booking) {
    if (editMode && canBook) {
      return `${prefix} · свободно · клик — забронировать`
    }
    return `${prefix} · свободно`
  }

  const who = booking.isSelf ? `${booking.employeeName} · ваша бронь` : booking.employeeName
  if (editMode && canRelease) {
    return `${prefix} · ${who} · клик — снять бронь`
  }
  return `${prefix} · ${who}`
}

export default function WorkspaceBooking({ orgEmployeeId }: WorkspaceBookingProps) {
  const currentDate = new Date()
  const currentYear = currentDate.getFullYear()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.workspaceYear)
  const [month, setMonth] = useState(savedOrgUi.workspaceMonth)
  const [data, setData] = useState<WorkspaceBookingScheduleData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [bookForEmployeeId, setBookForEmployeeId] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const monthDays = useMemo(() => getMonthDays(year, month), [year, month])
  const holidayKeys = useMemo(() => buildHolidayKeySet(year), [year])
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
    saveOrgUiState({ workspaceYear: year, workspaceMonth: month })
  }, [year, month])

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
        scrollRef.current.scrollLeft = Math.max(0, todayIndex * 26 - 80)
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
        <div className="org-vacation-chart-wrap">
          <div className="org-schedule-chart">
            <div className="org-schedule-names">
              <table className="org-vacation-grid org-schedule-names-grid">
                <thead>
                  <tr>
                    <th className="org-vacation-names-head" rowSpan={2}>
                      Место
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.places.map((place) => (
                    <tr key={place.id}>
                      <td className="org-vacation-name org-workspace-place-name" title={place.name}>
                        <span className="org-vacation-name-text">{place.name}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div
              className="org-schedule-dates org-vacation-scroll org-workspace-scroll"
              ref={scrollRef}
              aria-label="Календарь брони — прокрутка влево и вправо"
            >
              <table className="org-vacation-grid org-schedule-dates-grid org-workspace-grid">
                <thead>
                  <tr>
                    <th colSpan={monthDays.length} className="org-vacation-month">
                      {MONTH_NAMES_FULL[month]} {year}
                    </th>
                  </tr>
                  <tr>
                    {monthDays.map((day) => {
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
                  {data.places.map((place) => (
                    <tr key={place.id}>
                      {monthDays.map((day) => {
                        const dayKey = toDayKey(day)
                        const booking = bookingMap.get(`${place.id}:${dayKey}`)
                        const dayOff = !booking && isDayOff(day, holidayKeys)
                        const canBook =
                          editMode &&
                          !booking &&
                          (data.isAdmin ? bookForEmployeeId != null : data.actorEmployeeId != null)
                        const canRelease = editMode && Boolean(booking?.canRelease)
                        const isEditable = canBook || canRelease
                        const tip = formatWorkspaceCellTip(
                          place.name,
                          day,
                          booking,
                          editMode,
                          canBook,
                          canRelease,
                        )

                        return (
                          <td
                            key={`${place.id}-${dayKey}`}
                            className={[
                              'org-vacation-cell',
                              'org-workspace-cell',
                              booking
                                ? booking.isSelf
                                  ? 'org-workspace-self'
                                  : 'org-workspace-busy'
                                : 'org-workspace-free',
                              dayOff ? 'org-vacation-weekend' : '',
                              dayKey === todayKey ? 'org-vacation-today' : '',
                              isEditable ? 'org-vacation-editable' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            data-tip={tip}
                            aria-label={tip}
                            onClick={() => void toggleCell(place.id, dayKey, booking)}
                          />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
