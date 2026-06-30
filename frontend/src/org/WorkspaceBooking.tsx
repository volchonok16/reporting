import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, putJson } from '../api'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import {
  MONTH_NAMES_FULL,
  WEEKDAY_NAMES,
  getMonthGroups,
  getYearDays,
  isDayOff,
  isWeekendDay,
  toDayKey,
} from './scheduleUtils'
import { buildHolidayKeySet } from './ruPublicHolidays'
import type { WorkspaceBookingCell, WorkspaceBookingScheduleData } from './types'

type WorkspaceBookingProps = {
  orgEmployeeId: number | null
}

type DraftBooking = WorkspaceBookingCell | null

type SaveOperation = {
  placeId: number
  day: string
  action: 'book' | 'release'
  employeeId?: number
}

function cellKey(placeId: number, day: string): string {
  return `${placeId}:${day}`
}

function formatWorkspaceCellTip(
  placeName: string,
  day: Date,
  booking: WorkspaceBookingCell | undefined,
  editMode: boolean,
  canBook: boolean,
  canRelease: boolean,
  isPending: boolean,
): string {
  const monthLabel = MONTH_NAMES_FULL[day.getMonth()].toLowerCase()
  const dateLabel = `${day.getDate()} ${monthLabel} ${day.getFullYear()}`
  const prefix = `${placeName} · ${dateLabel}`
  const pendingSuffix = isPending ? ' · не сохранено' : ''

  if (!booking) {
    if (editMode && canBook) {
      return `${prefix} · свободно · клик — добавить в черновик${pendingSuffix}`
    }
    return `${prefix} · свободно${pendingSuffix}`
  }

  const who = booking.isSelf ? `${booking.employeeName} · ваша бронь` : booking.employeeName
  if (editMode && canRelease) {
    return `${prefix} · ${who} · клик — убрать из черновика${pendingSuffix}`
  }
  return `${prefix} · ${who}${pendingSuffix}`
}

function isDraftCell(
  key: string,
  draft: Map<string, DraftBooking>,
  serverBooking: WorkspaceBookingCell | undefined,
): boolean {
  if (!draft.has(key)) return false
  const draftValue = draft.get(key)
  if (draftValue === null) return Boolean(serverBooking)
  if (draftValue === undefined) return false
  if (!serverBooking) return true
  return (
    draftValue.employeeId !== serverBooking.employeeId || draftValue.placeId !== serverBooking.placeId
  )
}

function collectSaveOperations(
  draft: Map<string, DraftBooking>,
  serverMap: Map<string, WorkspaceBookingCell>,
): SaveOperation[] {
  const releases: SaveOperation[] = []
  const books: SaveOperation[] = []

  for (const [key, draftValue] of draft) {
    const serverBooking = serverMap.get(key)
    if (draftValue === null && serverBooking) {
      releases.push({
        action: 'release',
        placeId: serverBooking.placeId,
        day: serverBooking.day,
      })
    } else if (draftValue && !serverBooking) {
      books.push({
        action: 'book',
        placeId: draftValue.placeId,
        day: draftValue.day,
        employeeId: draftValue.employeeId,
      })
    }
  }

  return [...releases, ...books]
}

export default function WorkspaceBooking({ orgEmployeeId }: WorkspaceBookingProps) {
  const currentDate = new Date()
  const currentYear = currentDate.getFullYear()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.workspaceYear)
  const [data, setData] = useState<WorkspaceBookingScheduleData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [draftChanges, setDraftChanges] = useState<Map<string, DraftBooking>>(() => new Map())
  const [bookForEmployeeId, setBookForEmployeeId] = useState<number | null>(null)
  const [isDragScrolling, setIsDragScrolling] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startScrollLeft: number
    moved: boolean
  } | null>(null)
  const suppressCellClickRef = useRef(false)

  const yearDays = useMemo(() => getYearDays(year), [year])
  const monthGroups = useMemo(() => getMonthGroups(yearDays), [yearDays])
  const holidayKeys = useMemo(() => buildHolidayKeySet(year), [year])
  const todayKey = toDayKey(currentDate)

  const serverBookingMap = useMemo(() => {
    const map = new Map<string, WorkspaceBookingCell>()
    for (const row of data?.bookings ?? []) {
      map.set(cellKey(row.placeId, row.day), row)
    }
    return map
  }, [data])

  const getEffectiveBooking = useCallback(
    (placeId: number, day: string): WorkspaceBookingCell | undefined => {
      const key = cellKey(placeId, day)
      if (draftChanges.has(key)) {
        return draftChanges.get(key) ?? undefined
      }
      return serverBookingMap.get(key)
    },
    [draftChanges, serverBookingMap],
  )

  const draftCount = draftChanges.size
  const canEditAny = Boolean(data?.isAdmin || data?.actorEmployeeId != null)

  useEffect(() => {
    saveOrgUiState({ workspaceYear: year, workspaceMonth: currentDate.getMonth() })
  }, [year, currentDate])

  useEffect(() => {
    setDraftChanges(new Map())
    setEditMode(false)
    setError(null)
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
  }, [year])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!scrollRef.current || !data || year !== currentDate.getFullYear()) return
    const monthStartKey = `${year}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-01`
    const monthStartCell = scrollRef.current.querySelector<HTMLElement>(
      `th[data-day-key="${monthStartKey}"]`,
    )
    if (!monthStartCell) return
    scrollRef.current.scrollLeft = Math.max(0, monthStartCell.offsetLeft)
  }, [year, data, currentDate])

  const cancelEdit = () => {
    setDraftChanges(new Map())
    setEditMode(false)
    setError(null)
  }

  const toggleDraftCell = (placeId: number, day: string) => {
    if (suppressCellClickRef.current) return
    if (!editMode || saving || !data) return

    const key = cellKey(placeId, day)
    const serverBooking = serverBookingMap.get(key)
    const effectiveBooking = getEffectiveBooking(placeId, day)
    const isAdmin = data.isAdmin
    const actorId = data.actorEmployeeId ?? null
    const targetEmployeeId = isAdmin ? bookForEmployeeId : actorId

    if (effectiveBooking) {
      const canRelease =
        effectiveBooking.canRelease || effectiveBooking.isSelf || isAdmin
      if (!canRelease) return

      setDraftChanges((prev) => {
        const next = new Map(prev)
        if (serverBooking) {
          next.set(key, null)
        } else {
          next.delete(key)
        }
        return next
      })
      setError(null)
      return
    }

    if (serverBooking && draftChanges.get(key) === null) {
      setDraftChanges((prev) => {
        const next = new Map(prev)
        next.delete(key)
        return next
      })
      setError(null)
      return
    }

    if (targetEmployeeId == null) {
      setError('Выберите сотрудника для бронирования.')
      return
    }

    const employee = data.employees.find((item) => item.id === targetEmployeeId)
    if (!employee) return

    setDraftChanges((prev) => {
      const next = new Map(prev)

      for (const [otherKey, otherBooking] of serverBookingMap) {
        if (
          otherBooking.day === day &&
          otherBooking.employeeId === targetEmployeeId &&
          otherKey !== key
        ) {
          next.set(otherKey, null)
        }
      }

      for (const [otherKey, draftValue] of next) {
        if (
          draftValue &&
          draftValue.day === day &&
          draftValue.employeeId === targetEmployeeId &&
          otherKey !== key
        ) {
          next.delete(otherKey)
        }
      }

      next.set(key, {
        placeId,
        day,
        employeeId: targetEmployeeId,
        employeeName: employee.fullName,
        isSelf: actorId === targetEmployeeId,
        canRelease: true,
      })
      return next
    })
    setError(null)
  }

  const finishDragScroll = useCallback(
    (pointerId?: number) => {
      const scrollEl = scrollRef.current
      if (scrollEl && pointerId != null && scrollEl.hasPointerCapture(pointerId)) {
        scrollEl.releasePointerCapture(pointerId)
      }
      const hadMovement = Boolean(dragStateRef.current?.moved)
      dragStateRef.current = null
      setIsDragScrolling(false)
      if (hadMovement) {
        suppressCellClickRef.current = true
        window.setTimeout(() => {
          suppressCellClickRef.current = false
        }, 0)
      }
    },
    [setIsDragScrolling],
  )

  const handleScrollPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (!scrollRef.current) return
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

  const saveDraft = async () => {
    if (!data || saving || draftCount === 0) return

    const operations = collectSaveOperations(draftChanges, serverBookingMap)
    if (operations.length === 0) {
      cancelEdit()
      return
    }

    setSaving(true)
    setError(null)
    try {
      for (const operation of operations) {
        await putJson('/api/org/workspace/bookings/toggle', operation)
      }
      setDraftChanges(new Map())
      setEditMode(false)
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
                disabled={editMode && draftCount > 0}
              >
                {y}
              </button>
            ))}
          </div>
        </div>
        <div className="org-vacation-toolbar-right org-workspace-toolbar-actions">
          {canEditAny ? (
            editMode ? (
              <>
                <button type="button" className="btn-ghost" onClick={cancelEdit} disabled={saving}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void saveDraft()}
                  disabled={saving || draftCount === 0}
                >
                  {saving ? 'Сохранение…' : draftCount > 0 ? `Сохранить (${draftCount})` : 'Сохранить'}
                </button>
              </>
            ) : (
              <button type="button" className="btn-ghost" onClick={() => setEditMode(true)}>
                Редактировать
              </button>
            )
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
        <div className="org-workspace-edit-bar">
          <label className="org-workspace-book-for">
            <span className="org-workspace-book-for-label">Бронировать за</span>
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
          <p className="org-workspace-edit-hint">
            Отметьте ячейки в сетке и нажмите «Сохранить». Повторный клик снимает отметку.
          </p>
        </div>
      ) : editMode ? (
        <p className="org-workspace-edit-hint org-workspace-edit-hint-standalone">
          Отметьте нужные ячейки, затем нажмите «Сохранить».
        </p>
      ) : null}

      <div className="org-workspace-legend">
        <span className="org-vacation-legend-item org-workspace-free">Свободно</span>
        <span className="org-vacation-legend-item org-workspace-self">Ваша бронь</span>
        <span className="org-vacation-legend-item org-workspace-busy">Занято</span>
        <span className="org-vacation-legend-item org-workspace-weekend-legend">Выходной</span>
        {editMode ? (
          <span className="org-vacation-legend-item org-workspace-pending-legend">Не сохранено</span>
        ) : null}
      </div>

      {error ? <p className="org-error">{error}</p> : null}
      {loading && !data ? <p>Загрузка…</p> : null}

      {data ? (
        <div className={`org-vacation-chart-wrap${saving ? ' org-workspace-saving' : ''}`}>
          {saving ? <p className="org-workspace-saving-label">Сохранение…</p> : null}
          <div className="org-schedule-chart org-workspace-chart">
            <div className="org-schedule-names">
              <table className="org-vacation-grid org-schedule-names-grid org-workspace-names-grid">
                <thead>
                  <tr>
                    <th className="org-vacation-names-head org-workspace-names-head" rowSpan={3}>
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
              className={`org-schedule-dates org-vacation-scroll org-workspace-scroll${
                isDragScrolling ? ' org-workspace-scroll-dragging' : ''
              }`}
              ref={scrollRef}
              aria-label="Календарь брони — прокрутка влево и вправо"
              onPointerDown={handleScrollPointerDown}
              onPointerMove={handleScrollPointerMove}
              onPointerUp={handleScrollPointerUp}
              onPointerCancel={handleScrollPointerCancel}
            >
              <table className="org-vacation-grid org-schedule-dates-grid org-workspace-grid">
                <thead>
                  <tr>
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
                          key={`wd-${key}`}
                          className={[
                            'org-vacation-day-head',
                            'org-workspace-weekday-head',
                            dayOff ? 'org-workspace-weekend-head' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {WEEKDAY_NAMES[day.getDay()]}
                        </th>
                      )
                    })}
                  </tr>
                  <tr>
                    {yearDays.map((day) => {
                      const key = toDayKey(day)
                      const dayOff = isDayOff(day, holidayKeys)
                      return (
                        <th
                          key={key}
                          data-day-key={key}
                          className={[
                            'org-vacation-day-head',
                            'org-workspace-day-head',
                            dayOff ? 'org-workspace-weekend-head' : '',
                            key === todayKey ? 'org-workspace-today-head' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
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
                      {yearDays.map((day) => {
                        const dayKey = toDayKey(day)
                        const serverBooking = serverBookingMap.get(cellKey(place.id, dayKey))
                        const booking = getEffectiveBooking(place.id, dayKey)
                        const pending = isDraftCell(cellKey(place.id, dayKey), draftChanges, serverBooking)
                        const dayOff = isDayOff(day, holidayKeys)
                        const canBook =
                          editMode &&
                          !booking &&
                          (data.isAdmin ? bookForEmployeeId != null : data.actorEmployeeId != null)
                        const canRelease =
                          editMode &&
                          Boolean(
                            booking &&
                              (booking.canRelease || booking.isSelf || data.isAdmin),
                          )
                        const isEditable = canBook || canRelease
                        const tip = formatWorkspaceCellTip(
                          place.name,
                          day,
                          booking,
                          editMode,
                          canBook,
                          canRelease,
                          pending,
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
                              dayOff ? 'org-workspace-weekend' : '',
                              pending ? 'org-workspace-pending' : '',
                              isEditable ? 'org-vacation-editable' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            data-tip={tip}
                            aria-label={tip}
                            onClick={() => toggleDraftCell(place.id, dayKey)}
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
