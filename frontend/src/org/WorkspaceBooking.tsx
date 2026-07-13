import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getJson, HttpError, putJson } from '../api'
import { notifyError, notifyWarning, notifyProblem } from '../toast'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import {
  MONTH_NAMES_FULL,
  WEEKDAY_NAMES,
  getMonthGroups,
  getYearDays,
  isDayOff,
  toDayKey,
} from './scheduleUtils'
import { buildHolidayKeySet } from './ruPublicHolidays'
import type { TimeOffKind, WorkspaceBookingCell, WorkspaceBookingScheduleData } from './types'

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

const TIME_OFF_META: Record<TimeOffKind, { label: string; className: string }> = {
  vacation: { label: 'Отпуск', className: 'org-office-presence-vacation' },
  dayoff: { label: 'Отгул', className: 'org-office-presence-dayoff' },
  sick_leave: { label: 'Больничный', className: 'org-office-presence-sick' },
  business_trip: { label: 'Командировка', className: 'org-office-presence-business-trip' },
}

function timeOffDayKey(employeeId: number, day: string): string {
  return `${employeeId}:${day}`
}

function timeOffBookingMessage(
  kind: TimeOffKind,
  targetEmployeeId: number,
  actorEmployeeId: number | null,
  employeeName: string,
): string {
  const kindLabel = TIME_OFF_META[kind].label.toLowerCase()
  if (actorEmployeeId != null && actorEmployeeId === targetEmployeeId) {
    return `У вас запланирован ${kindLabel} на эти даты.`
  }
  return `У ${employeeName} запланирован ${kindLabel} на эти даты.`
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

function countPlannedChanges(
  draft: Map<string, DraftBooking>,
  serverMap: Map<string, WorkspaceBookingCell>,
): number {
  const booksByEmployeeDay = new Set<string>()
  const releasesByEmployeeDay = new Set<string>()
  for (const [key, draftValue] of draft) {
    const serverBooking = serverMap.get(key)
    if (draftValue === null && serverBooking) {
      releasesByEmployeeDay.add(`${serverBooking.employeeId}:${serverBooking.day}`)
      continue
    }
    if (draftValue && !serverBooking) {
      booksByEmployeeDay.add(`${draftValue.employeeId}:${draftValue.day}`)
    }
  }
  let total = booksByEmployeeDay.size
  for (const employeeDay of releasesByEmployeeDay) {
    if (!booksByEmployeeDay.has(employeeDay)) {
      total += 1
    }
  }
  return total
}

function isPlaceNotFoundError(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 404) return false
  return err.message.toLowerCase().includes('место не найдено')
}

const WORKSPACE_NAME_COL_WIDTH = 88
const WORKSPACE_MIN_DAY_CELL = 24
const WORKSPACE_MAX_DAY_CELL = 56
const WORKSPACE_VISIBLE_DAYS = 31

function computeWorkspaceDayCellSize(containerWidth: number): number {
  const available = Math.max(0, containerWidth - WORKSPACE_NAME_COL_WIDTH)
  const stretched = Math.floor(available / WORKSPACE_VISIBLE_DAYS)
  return Math.min(WORKSPACE_MAX_DAY_CELL, Math.max(WORKSPACE_MIN_DAY_CELL, stretched))
}

export default function WorkspaceBooking({ orgEmployeeId }: WorkspaceBookingProps) {
  const today = new Date()
  const currentYear = today.getFullYear()
  const currentMonth = today.getMonth()
  const currentDay = today.getDate()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.workspaceYear)
  const [data, setData] = useState<WorkspaceBookingScheduleData | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [draftChanges, setDraftChanges] = useState<Map<string, DraftBooking>>(() => new Map())
  const [bookForEmployeeId, setBookForEmployeeId] = useState<number | null>(null)
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDayKey(new Date()))
  const [isDragScrolling, setIsDragScrolling] = useState(false)
  const [dayCellSize, setDayCellSize] = useState(WORKSPACE_MIN_DAY_CELL)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const chartWrapRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const dayCellSizeRef = useRef(WORKSPACE_MIN_DAY_CELL)
  const prevDayCellSizeRef = useRef(WORKSPACE_MIN_DAY_CELL)
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
  const todayKey = toDayKey(today)

  const serverBookingMap = useMemo(() => {
    const map = new Map<string, WorkspaceBookingCell>()
    for (const row of data?.bookings ?? []) {
      map.set(cellKey(row.placeId, row.day), row)
    }
    return map
  }, [data])

  const timeOffByEmployeeDay = useMemo(() => {
    const map = new Map<string, TimeOffKind>()
    for (const row of data?.timeOffDays ?? []) {
      map.set(timeOffDayKey(row.employeeId, row.day), row.kind)
    }
    return map
  }, [data?.timeOffDays])

  const timeOffSubjectId = useMemo(() => {
    if (!data) return null
    if (editMode && data.isAdmin) {
      return bookForEmployeeId
    }
    return data.actorEmployeeId ?? null
  }, [data, editMode, bookForEmployeeId])

  const getTimeOffKind = useCallback(
    (employeeId: number, day: string): TimeOffKind | undefined => {
      return timeOffByEmployeeDay.get(timeOffDayKey(employeeId, day))
    },
    [timeOffByEmployeeDay],
  )

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

  const draftCount = useMemo(
    () => countPlannedChanges(draftChanges, serverBookingMap),
    [draftChanges, serverBookingMap],
  )
  const canEditAny = Boolean(data?.isAdmin || data?.actorEmployeeId != null)
  const visiblePlaces = data?.places ?? []


  useEffect(() => {
    saveOrgUiState({ workspaceYear: year, workspaceMonth: currentMonth })
  }, [year, currentMonth])

  useEffect(() => {
    setDraftChanges(new Map())
    setEditMode(false)
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

  useEffect(() => {
    if (selectedDayKey.startsWith(`${year}-`)) return
    const fallbackDate = year === currentYear ? new Date(year, currentMonth, currentDay) : new Date(year, 0, 1)
    setSelectedDayKey(toDayKey(fallbackDate))
  }, [year, selectedDayKey, currentYear, currentMonth, currentDay])

  const fetchSchedule = useCallback(async (): Promise<WorkspaceBookingScheduleData> => {
    const query = new URLSearchParams({
      year: String(year),
    })
    return getJson<WorkspaceBookingScheduleData>(`/api/org/workspace/bookings?${query.toString()}`)
  }, [year])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetchSchedule()
      setData(response)
    } catch (err) {
      notifyError(err, 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [fetchSchedule])

  useEffect(() => {
    void load()
  }, [load])

  const updateScrollState = useCallback(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    setCanScrollLeft(scrollEl.scrollLeft > 2)
    setCanScrollRight(scrollEl.scrollLeft + scrollEl.clientWidth < scrollEl.scrollWidth - 2)
  }, [])

  const updateChartLayout = useCallback(() => {
    const wrap = chartWrapRef.current
    if (!wrap) return
    setDayCellSize(computeWorkspaceDayCellSize(wrap.clientWidth))
    updateScrollState()
  }, [updateScrollState])

  useEffect(() => {
    dayCellSizeRef.current = dayCellSize
  }, [dayCellSize])

  useEffect(() => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const prev = prevDayCellSizeRef.current
    if (prev !== dayCellSize && prev > 0) {
      scrollEl.scrollLeft = (scrollEl.scrollLeft / prev) * dayCellSize
    }
    prevDayCellSizeRef.current = dayCellSize
    updateScrollState()
  }, [dayCellSize, updateScrollState])

  useEffect(() => {
    const wrap = chartWrapRef.current
    const scrollEl = scrollRef.current
    if (!wrap) return

    const observer = new ResizeObserver(() => {
      updateChartLayout()
    })
    observer.observe(wrap)

    scrollEl?.addEventListener('scroll', updateScrollState, { passive: true })
    updateChartLayout()

    return () => {
      observer.disconnect()
      scrollEl?.removeEventListener('scroll', updateScrollState)
    }
  }, [data, updateChartLayout, updateScrollState])

  const scrollToMonthStart = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const scrollEl = scrollRef.current
      if (!scrollEl || year !== currentYear) return
      const monthStartKey = `${year}-${String(currentMonth + 1).padStart(2, '0')}-01`
      const monthStartIndex = yearDays.findIndex((day) => toDayKey(day) === monthStartKey)
      if (monthStartIndex < 0) return
      scrollEl.scrollTo({
        left: Math.max(0, monthStartIndex * dayCellSizeRef.current),
        behavior,
      })
    },
    [year, currentYear, currentMonth, yearDays],
  )

  useEffect(() => {
    if (!scrollRef.current || !data || year !== currentYear) return
    const monthStartKey = `${year}-${String(currentMonth + 1).padStart(2, '0')}-01`
    const monthStartIndex = yearDays.findIndex((day) => toDayKey(day) === monthStartKey)
    if (monthStartIndex < 0) return
    const alignToCurrentMonth = () => {
      if (!scrollRef.current) return
      scrollRef.current.scrollLeft = Math.max(0, monthStartIndex * dayCellSizeRef.current)
      updateScrollState()
    }
    alignToCurrentMonth()
    const rafId = window.requestAnimationFrame(alignToCurrentMonth)
    return () => window.cancelAnimationFrame(rafId)
  }, [year, data, currentYear, currentMonth, yearDays, updateScrollState])

  const scrollChart = useCallback(
    (direction: -1 | 1) => {
      const scrollEl = scrollRef.current
      if (!scrollEl) return
      const step = Math.max(scrollEl.clientWidth - WORKSPACE_NAME_COL_WIDTH, dayCellSize * 7)
      scrollEl.scrollBy({ left: direction * step, behavior: 'smooth' })
    },
    [dayCellSize],
  )

  const resetBookForSelf = useCallback(() => {
    if (!data?.isAdmin) return
    if (data.actorEmployeeId != null) {
      setBookForEmployeeId(data.actorEmployeeId)
      return
    }
    if (data.employees.length > 0) {
      setBookForEmployeeId(data.employees[0].id)
    }
  }, [data])

  const cancelEdit = () => {
    setDraftChanges(new Map())
    setEditMode(false)
    resetBookForSelf()
  }

  const toggleDraftCell = (placeId: number, day: string) => {
    if (suppressCellClickRef.current) return
    setSelectedDayKey(day)
    if (saving || !data) return
    if (!editMode) {
      if (!canEditAny) {
        notifyWarning('Бронирование недоступно без карточки сотрудника.')
        return
      }
      setEditMode(true)
    }

    const key = cellKey(placeId, day)
    const serverBooking = serverBookingMap.get(key)
    const effectiveBooking = getEffectiveBooking(placeId, day)
    const isAdmin = data.isAdmin
    const actorId = data.actorEmployeeId ?? null
    const targetEmployeeId = isAdmin ? bookForEmployeeId : actorId

    if (effectiveBooking) {
      const canRelease =
        effectiveBooking.canRelease || effectiveBooking.isSelf || isAdmin
      if (!canRelease) {
        notifyWarning('Недостаточно прав для снятия брони.')
        return
      }

      setDraftChanges((prev) => {
        const next = new Map(prev)
        if (serverBooking) {
          next.set(key, null)
        } else {
          next.delete(key)
        }
        return next
      })
      return
    }

    if (serverBooking && draftChanges.get(key) === null) {
      setDraftChanges((prev) => {
        const next = new Map(prev)
        next.delete(key)
        return next
      })
      return
    }

    if (targetEmployeeId == null) {
      notifyWarning('Выберите сотрудника для бронирования.')
      return
    }

    const employee = data.employees.find((item) => item.id === targetEmployeeId)
    if (!employee) return

    const timeOffKind = getTimeOffKind(targetEmployeeId, day)
    if (timeOffKind) {
      notifyWarning(
        timeOffBookingMessage(timeOffKind, targetEmployeeId, actorId, employee.fullName),
      )
      return
    }

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

  useEffect(() => {
    if (editMode) {
      finishDragScroll()
    }
  }, [editMode, finishDragScroll])

  const handleScrollPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editMode) return
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
    if (editMode) return
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
    if (editMode) return
    finishDragScroll(event.pointerId)
  }

  const handleScrollPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (editMode) return
    finishDragScroll(event.pointerId)
  }

  const saveDraft = async () => {
    if (!data || saving || draftCount === 0) return

    setSaving(true)
    try {
      let operations = collectSaveOperations(draftChanges, serverBookingMap)
      if (operations.length === 0) {
        cancelEdit()
        return
      }

      let retriedAfterReload = false
      while (operations.length > 0) {
        try {
          for (const operation of operations) {
            await putJson<{
              action: 'book' | 'release'
              booked: boolean
              employeeId?: number
            }>('/api/org/workspace/bookings/toggle', operation)
          }
          break
        } catch (err) {
          if (!retriedAfterReload && isPlaceNotFoundError(err)) {
            retriedAfterReload = true
            const refreshed = await fetchSchedule()
            setData(refreshed)
            const refreshedMap = new Map<string, WorkspaceBookingCell>()
            for (const booking of refreshed.bookings) {
              refreshedMap.set(cellKey(booking.placeId, booking.day), booking)
            }
            operations = collectSaveOperations(draftChanges, refreshedMap)
            continue
          }
          throw err
        }
      }
      setDraftChanges(new Map())
      setEditMode(false)
      resetBookForSelf()
      const refreshed = await fetchSchedule()
      setData(refreshed)
    } catch (err) {
      notifyProblem(err, 'Ошибка сохранения')
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
            {[currentYear, currentYear + 1].map((y) => (
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
        <span className="org-vacation-legend-item org-workspace-weekend-legend">Выходной или праздник</span>
        {(Object.entries(TIME_OFF_META) as Array<[TimeOffKind, (typeof TIME_OFF_META)[TimeOffKind]]>).map(
          ([kind, meta]) => (
            <span key={kind} className={`org-vacation-legend-item ${meta.className}`}>
              {meta.label}
            </span>
          ),
        )}
        {editMode ? (
          <span className="org-vacation-legend-item org-workspace-pending-legend">Не сохранено</span>
        ) : null}
      </div>

      {loading && !data ? <p>Загрузка…</p> : null}

      {data ? (
        <div
          ref={chartWrapRef}
          className={`org-vacation-chart-wrap org-workspace-chart-wrap${saving ? ' org-workspace-saving' : ''}`}
        >
          {saving ? <p className="org-workspace-saving-label">Сохранение…</p> : null}
          <div className="org-workspace-scroll-controls">
            <button
              type="button"
              className="org-workspace-scroll-btn"
              onClick={() => scrollChart(-1)}
              disabled={!canScrollLeft}
              aria-label="Прокрутить календарь влево"
            >
              ←
            </button>
            <button
              type="button"
              className="org-workspace-scroll-btn"
              onClick={() => scrollToMonthStart()}
              disabled={year !== currentYear}
            >
              Текущий месяц
            </button>
            <button
              type="button"
              className="org-workspace-scroll-btn"
              onClick={() => scrollChart(1)}
              disabled={!canScrollRight}
              aria-label="Прокрутить календарь вправо"
            >
              →
            </button>
            <span className="org-workspace-scroll-hint">Кнопки или перетаскивание мышью</span>
          </div>
          <div
            className={`org-vacation-scroll org-workspace-scroll org-workspace-chart${
              isDragScrolling ? ' org-workspace-scroll-dragging' : ''
            }`}
            ref={scrollRef}
            style={{ '--vac-cell-size': `${dayCellSize}px` } as React.CSSProperties}
            aria-label="Календарь брони — прокрутка влево и вправо"
            onPointerDown={handleScrollPointerDown}
            onPointerMove={handleScrollPointerMove}
            onPointerUp={handleScrollPointerUp}
            onPointerCancel={handleScrollPointerCancel}
          >
            <table className="org-vacation-grid org-workspace-grid">
              <thead>
                <tr>
                  <th
                    className="org-vacation-sticky-col org-vacation-names-head org-workspace-names-head"
                    rowSpan={3}
                  >
                    Место
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
                          key === selectedDayKey ? 'org-vacation-day-selected' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
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
                {visiblePlaces.map((place) => (
                  <tr key={place.id}>
                    <td
                      className="org-vacation-sticky-col org-vacation-name org-workspace-place-name"
                      title={place.name}
                    >
                      <span className="org-vacation-name-text">{place.name}</span>
                    </td>
                    {yearDays.map((day) => {
                      const dayKey = toDayKey(day)
                      const serverBooking = serverBookingMap.get(cellKey(place.id, dayKey))
                      const booking = getEffectiveBooking(place.id, dayKey)
                      const pending = isDraftCell(cellKey(place.id, dayKey), draftChanges, serverBooking)
                      const dayOff = isDayOff(day, holidayKeys)
                      const timeOffKind =
                        timeOffSubjectId != null
                          ? getTimeOffKind(timeOffSubjectId, dayKey)
                          : undefined
                      const onTimeOff = timeOffKind != null
                      const canBook =
                        editMode &&
                        !booking &&
                        !onTimeOff &&
                        (data.isAdmin ? bookForEmployeeId != null : data.actorEmployeeId != null)
                      const canRelease =
                        editMode &&
                        Boolean(
                          booking &&
                            (booking.canRelease || booking.isSelf || data.isAdmin),
                        )
                      const isEditable = canBook || canRelease
                      const timeOffLabel = timeOffKind ? TIME_OFF_META[timeOffKind].label.toLowerCase() : null
                      const tip =
                        onTimeOff && editMode && !booking && timeOffLabel
                          ? `${place.name} · ${MONTH_NAMES_FULL[day.getMonth()].toLowerCase()} ${day.getDate()} ${day.getFullYear()} · ${timeOffLabel} · бронь недоступна`
                          : formatWorkspaceCellTip(
                            place.name,
                            day,
                            booking,
                            editMode,
                            canBook,
                            canRelease,
                            pending,
                          )

                      const bookingClass = booking
                        ? booking.isSelf
                          ? 'org-workspace-self'
                          : 'org-workspace-busy'
                        : 'org-workspace-free'
                      const statusClass =
                        onTimeOff && !booking && timeOffKind
                          ? TIME_OFF_META[timeOffKind].className
                          : bookingClass

                      return (
                        <td
                          key={`${place.id}-${dayKey}`}
                          className={[
                            'org-vacation-cell',
                            'org-workspace-cell',
                            statusClass,
                            dayOff ? 'org-workspace-weekend' : '',
                            dayKey === todayKey ? 'org-vacation-today' : '',
                            dayKey === selectedDayKey ? 'org-vacation-cell-selected-day' : '',
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
      ) : null}
    </section>
  )
}
