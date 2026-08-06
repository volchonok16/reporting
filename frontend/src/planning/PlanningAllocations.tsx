import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deleteJson, getJson, patchJson, postJson } from '../api'
import { notifyProblem, notifyWarning } from '../toast'
import { iterDaysInclusive } from './planningUtils'
import type { PlanningAllocation, PlanningProject, PlanningWorkload } from './types'
import type { Employee as OrgEmployee, VacationScheduleData } from '../org/types'

type PlanningAllocationsProps = {
  selectedProjectId: number | null
  onSelectProject: (projectId: number | null) => void
}

function todayIsoDate(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function emptyAllocationForm(project?: PlanningProject | null) {
  return {
    employeeId: '',
    allocationStartDate: todayIsoDate(),
    allocationEndDate: project?.plannedEndDate?.slice(0, 10) ?? '',
    bookingMode: 'period' as 'period' | 'daily',
    plannedHoursPerDay: '8',
  }
}

async function findCapacityOverload(args: {
  employeeId: number
  dateFrom: string
  dateTo: string
  bookingMode: 'period' | 'daily'
  plannedHoursPerDay: number
  dailyHours: Record<string, { planned: string; actual: string }>
  timeOffDays: Set<string>
  excludeAllocationId: number | null
}): Promise<string | null> {
  const params = new URLSearchParams({
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    employeeId: String(args.employeeId),
  })
  const workload = await getJson<PlanningWorkload>(`/api/planning/workload?${params.toString()}`)
  const employee = workload.employees.find((item) => item.id === args.employeeId)
  if (!employee) return null

  const conflicts: string[] = []
  for (const day of iterDaysInclusive(args.dateFrom, args.dateTo)) {
    if (args.timeOffDays.has(day)) continue
    const cell = employee.days[day]
    if (!cell || !cell.isWorkingDay) continue

    let proposed = 0
    if (args.bookingMode === 'period') {
      proposed = args.plannedHoursPerDay
    } else {
      proposed = Number(args.dailyHours[day]?.planned || 0)
    }
    if (proposed <= 0) continue

    const currentOwned =
      args.excludeAllocationId == null
        ? 0
        : cell.allocations
            .filter((item) => item.allocationId === args.excludeAllocationId)
            .reduce((sum, item) => sum + item.plannedHours, 0)
    const otherPlanned = cell.plannedHours - currentOwned
    const total = otherPlanned + proposed
    if (total <= cell.capacityHours) continue

    const available = Math.max(0, cell.capacityHours - otherPlanned)
    conflicts.push(
      `${day}: нужно ${proposed} ч, доступно ${available} ч (норма ${cell.capacityHours} ч, уже занято ${otherPlanned} ч)`,
    )
  }

  if (conflicts.length === 0) return null
  const shown = conflicts.slice(0, 8)
  let message = `Превышена доступная загрузка сотрудника. ${shown.join('; ')}`
  if (conflicts.length > 8) {
    message += ` и ещё ${conflicts.length - 8} дн.`
  }
  return message
}

export default function PlanningAllocations({
  selectedProjectId,
  onSelectProject,
}: PlanningAllocationsProps) {
  const [projects, setProjects] = useState<PlanningProject[]>([])
  const [employees, setEmployees] = useState<OrgEmployee[]>([])
  const [allocations, setAllocations] = useState<PlanningAllocation[]>([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState(() => emptyAllocationForm())
  const [editingAllocationId, setEditingAllocationId] = useState<number | null>(null)
  const [dailyHours, setDailyHours] = useState<Record<string, { planned: string; actual: string }>>({})
  const [timeOffDays, setTimeOffDays] = useState<Set<string>>(new Set())
  const prevProjectIdRef = useRef<number | null | undefined>(undefined)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  )

  const loadProjects = useCallback(async () => {
    try {
      const rows = await getJson<PlanningProject[]>('/api/planning/projects')
      setProjects(rows)
    } catch (error) {
      notifyProblem('Не удалось загрузить проекты', error)
    }
  }, [])

  const loadAllocations = useCallback(async (projectId: number) => {
    setLoading(true)
    try {
      const rows = await getJson<PlanningAllocation[]>(`/api/planning/projects/${projectId}/allocations`)
      setAllocations(rows)
    } catch (error) {
      notifyProblem('Не удалось загрузить выделения', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProjects()
    void getJson<OrgEmployee[]>('/api/org/employees').then(setEmployees).catch((error) => {
      notifyProblem('Не удалось загрузить сотрудников', error)
    })
  }, [loadProjects])

  useEffect(() => {
    if (selectedProjectId) {
      void loadAllocations(selectedProjectId)
    } else {
      setAllocations([])
    }
  }, [selectedProjectId, loadAllocations])

  useEffect(() => {
    if (editingAllocationId) return
    const projectChanged = prevProjectIdRef.current !== selectedProjectId
    prevProjectIdRef.current = selectedProjectId
    const project = projects.find((item) => item.id === selectedProjectId) ?? null

    if (projectChanged) {
      const base = emptyAllocationForm(project)
      if ((project?.executorIds?.length ?? 0) === 1) {
        base.employeeId = String(project!.executorIds![0])
      }
      setForm(base)
      setDailyHours({})
      return
    }

    if (!project) return
    setForm((prev) => {
      const nextStart = prev.allocationStartDate || todayIsoDate()
      const nextEnd = prev.allocationEndDate || project.plannedEndDate?.slice(0, 10) || ''
      const nextEmployee =
        prev.employeeId ||
        ((project.executorIds?.length ?? 0) === 1 ? String(project.executorIds![0]) : '')
      if (
        nextStart === prev.allocationStartDate &&
        nextEnd === prev.allocationEndDate &&
        nextEmployee === prev.employeeId
      ) {
        return prev
      }
      return {
        ...prev,
        allocationStartDate: nextStart,
        allocationEndDate: nextEnd,
        employeeId: nextEmployee,
      }
    })
  }, [selectedProjectId, projects, editingAllocationId])

  useEffect(() => {
    if (!form.employeeId || !form.allocationStartDate || !form.allocationEndDate) {
      setTimeOffDays(new Set())
      return
    }
    const startYear = new Date(`${form.allocationStartDate}T12:00:00`).getFullYear()
    const endYear = new Date(`${form.allocationEndDate}T12:00:00`).getFullYear()
    const years = Array.from(new Set([startYear, endYear]))
    void Promise.all(
      years.map((year) => getJson<VacationScheduleData>(`/api/org/vacations?year=${year}`)),
    )
      .then((results) => {
        const employeeId = Number(form.employeeId)
        const keys = new Set<string>()
        for (const data of results) {
          for (const item of data.timeOffDays) {
            if (item.employeeId === employeeId) {
              keys.add(item.day.slice(0, 10))
            }
          }
        }
        setTimeOffDays(keys)
      })
      .catch((error) => {
        notifyProblem('Не удалось загрузить график отсутствий', error)
      })
  }, [form.employeeId, form.allocationStartDate, form.allocationEndDate])

  const resetForm = () => {
    setForm(emptyAllocationForm(selectedProject))
    setEditingAllocationId(null)
    setDailyHours({})
  }

  const buildDailyPayload = () => {
    if (!form.allocationStartDate || !form.allocationEndDate) return []
    return iterDaysInclusive(form.allocationStartDate, form.allocationEndDate)
      .filter((day) => !timeOffDays.has(day))
      .map((day) => ({
        day,
        plannedHours: Number(dailyHours[day]?.planned || 0),
        actualHours: Number(dailyHours[day]?.actual || 0),
      }))
  }

  const saveAllocation = async () => {
    if (!selectedProjectId) {
      notifyWarning('Выберите проект')
      return
    }
    if (!form.employeeId || !form.allocationStartDate || !form.allocationEndDate) {
      notifyWarning('Заполните сотрудника и период выделения')
      return
    }

    const employeeId = Number(form.employeeId)
    try {
      const capacityCheck = await findCapacityOverload({
        employeeId,
        dateFrom: form.allocationStartDate,
        dateTo: form.allocationEndDate,
        bookingMode: form.bookingMode,
        plannedHoursPerDay: form.bookingMode === 'period' ? Number(form.plannedHoursPerDay || 0) : 0,
        dailyHours,
        timeOffDays,
        excludeAllocationId: editingAllocationId,
      })
      if (capacityCheck) {
        notifyWarning(capacityCheck)
        return
      }
    } catch {
      // серверная проверка всё равно сработает при сохранении
    }

    const payload = {
      employeeId,
      allocationStartDate: form.allocationStartDate,
      allocationEndDate: form.allocationEndDate,
      bookingMode: form.bookingMode,
      plannedHoursPerDay: form.bookingMode === 'period' ? Number(form.plannedHoursPerDay || 0) : null,
      days: form.bookingMode === 'daily' ? buildDailyPayload() : [],
    }
    try {
      if (editingAllocationId) {
        await patchJson(`/api/planning/allocations/${editingAllocationId}`, payload)
      } else {
        await postJson(`/api/planning/projects/${selectedProjectId}/allocations`, payload)
      }
      resetForm()
      await loadAllocations(selectedProjectId)
      await loadProjects()
    } catch (error) {
      notifyProblem(error, 'Не удалось сохранить выделение')
    }
  }

  const editAllocation = (allocation: PlanningAllocation) => {
    setEditingAllocationId(allocation.id)
    setForm({
      employeeId: String(allocation.employeeId),
      allocationStartDate: allocation.allocationStartDate.slice(0, 10),
      allocationEndDate: allocation.allocationEndDate.slice(0, 10),
      bookingMode: allocation.bookingMode,
      plannedHoursPerDay: allocation.plannedHoursPerDay != null ? String(allocation.plannedHoursPerDay) : '8',
    })
    const nextDaily: Record<string, { planned: string; actual: string }> = {}
    for (const day of allocation.days) {
      nextDaily[day.day.slice(0, 10)] = {
        planned: String(day.plannedHours),
        actual: String(day.actualHours),
      }
    }
    setDailyHours(nextDaily)
  }

  const removeAllocation = async (allocationId: number) => {
    if (!selectedProjectId || !window.confirm('Удалить выделение ресурса?')) return
    try {
      await deleteJson(`/api/planning/allocations/${allocationId}`)
      await loadAllocations(selectedProjectId)
      if (editingAllocationId === allocationId) resetForm()
    } catch (error) {
      notifyProblem('Не удалось удалить выделение', error)
    }
  }

  const dailyDayKeys =
    form.allocationStartDate && form.allocationEndDate
      ? iterDaysInclusive(form.allocationStartDate, form.allocationEndDate)
      : []

  return (
    <section className="org-panel">
      <div className="org-panel-toolbar">
        <h2>Выделение ресурсов</h2>
        <div className="org-panel-toolbar-actions">
          {loading ? <span className="org-hint">Обновление…</span> : null}
        </div>
      </div>

      <div className="org-dept-filter">
        <label className="org-dept-filter-label">
          Проект
          <select
            value={selectedProjectId ?? ''}
            onChange={(event) => onSelectProject(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">— выберите проект —</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.requestNumber} — {project.requestName}
              </option>
            ))}
          </select>
        </label>
        {selectedProject ? (
          <p className="org-hint">
            {selectedProject.requestNumber}: план {selectedProject.totalPlannedHours} ч / факт{' '}
            {selectedProject.totalActualHours} ч
            {selectedProject.executors?.length ? (
              <>
                {' '}
                · исполнители:{' '}
                {selectedProject.executors
                  .map((item) => `${item.fullName}${item.fromAllocation ? ' *' : ''}`)
                  .join(', ')}
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {selectedProjectId ? (
        <>
          <div className="org-form planning-allocation-form">
            <div className="org-form-row-2">
              <label>
                Сотрудник
                <select
                  value={form.employeeId}
                  onChange={(event) => setForm((prev) => ({ ...prev, employeeId: event.target.value }))}
                >
                  <option value="">—</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.fullName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Режим бронирования
                <select
                  value={form.bookingMode}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      bookingMode: event.target.value as 'period' | 'daily',
                    }))
                  }
                >
                  <option value="period">На весь период (по рабочим дням)</option>
                  <option value="daily">По дням</option>
                </select>
              </label>
            </div>
            <div className="org-form-row-2">
              <label>
                Дата выделения (начало)
                <input
                  type="date"
                  value={form.allocationStartDate}
                  onChange={(event) => setForm((prev) => ({ ...prev, allocationStartDate: event.target.value }))}
                />
              </label>
              <label>
                Дата окончания выделения
                <input
                  type="date"
                  value={form.allocationEndDate}
                  onChange={(event) => setForm((prev) => ({ ...prev, allocationEndDate: event.target.value }))}
                />
              </label>
            </div>
            {form.bookingMode === 'period' ? (
              <label>
                Плановые часы в день
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={form.plannedHoursPerDay}
                  onChange={(event) => setForm((prev) => ({ ...prev, plannedHoursPerDay: event.target.value }))}
                />
              </label>
            ) : null}
          </div>

          <p className="org-hint">
            Часы не проставляются в дни отсутствия сотрудника (отпуск, больничный и т.д.) и нерабочие дни
            календаря. Сумма плановых часов по всем проектам не может превышать дневную норму сотрудника.
          </p>

          {form.bookingMode === 'daily' && dailyDayKeys.length > 0 ? (
            <div className="planning-daily-grid">
              {dailyDayKeys.map((day) =>
                timeOffDays.has(day) ? (
                  <div key={day} className="planning-daily-cell planning-daily-off">
                    <div className="planning-daily-cell-date">{day}</div>
                    <div className="org-hint">Отсутствие</div>
                  </div>
                ) : (
                  <div key={day} className="planning-daily-cell">
                    <div className="planning-daily-cell-date">{day}</div>
                    <label className="planning-daily-field">
                      <span className="planning-daily-field-label">план</span>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={dailyHours[day]?.planned ?? ''}
                        onChange={(event) =>
                          setDailyHours((prev) => ({
                            ...prev,
                            [day]: { planned: event.target.value, actual: prev[day]?.actual ?? '' },
                          }))
                        }
                      />
                    </label>
                    <label className="planning-daily-field">
                      <span className="planning-daily-field-label">факт</span>
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={dailyHours[day]?.actual ?? ''}
                        onChange={(event) =>
                          setDailyHours((prev) => ({
                            ...prev,
                            [day]: { planned: prev[day]?.planned ?? '', actual: event.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>
                ),
              )}
            </div>
          ) : null}

          <footer className="org-modal-actions" style={{ justifyContent: 'flex-start', marginTop: 16, marginBottom: 16 }}>
            <button type="button" className="btn-ghost" onClick={resetForm}>
              Очистить
            </button>
            <button type="button" className="btn-primary" onClick={() => void saveAllocation()}>
              {editingAllocationId ? 'Сохранить изменения' : 'Добавить выделение'}
            </button>
          </footer>

          <div className="planning-table-scroll">
            <table className="org-table">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Экспертиза</th>
                  <th>Период</th>
                  <th>Режим</th>
                  <th>Часы план/факт</th>
                  <th>Создал</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {allocations.map((allocation) => (
                  <tr key={allocation.id}>
                    <td>{allocation.employeeName}</td>
                    <td>{allocation.employeeExpertises.join(', ') || '—'}</td>
                    <td>
                      {allocation.allocationStartDate.slice(0, 10)} — {allocation.allocationEndDate.slice(0, 10)}
                    </td>
                    <td>{allocation.bookingMode === 'period' ? 'Период' : 'По дням'}</td>
                    <td>
                      {allocation.totalPlannedHours} / {allocation.totalActualHours}
                    </td>
                    <td>{allocation.createdByLabel ?? '—'}</td>
                    <td className="org-table-actions">
                      <button type="button" className="btn-ghost" onClick={() => editAllocation(allocation)}>
                        Изменить
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => void removeAllocation(allocation.id)}>
                        Удалить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="org-hint">Выберите проект, чтобы назначить сотрудников и часы.</p>
      )}
    </section>
  )
}
