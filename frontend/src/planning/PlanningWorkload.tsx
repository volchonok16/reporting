import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson } from '../api'
import { MONTH_NAMES_FULL } from '../org/scheduleUtils'
import { notifyProblem } from '../toast'
import { monthBounds } from './planningUtils'
import type {
  PlanningWorkload,
  PlanningWorkloadDayCell,
  PlanningWorkloadEmployee,
  WorkloadViewMode,
} from './types'

type WorkloadRow = {
  key: string
  employeeId: number
  employeeName: string
  projectId: number | null
  projectLabel: string | null
  expertises: string[]
  departmentNames: string[]
  isSummary: boolean
  projectCount: number
  getCell: (day: string) => PlanningWorkloadDayCell | undefined
  projectHours: (day: string) => number
}

type EmployeeGroup = {
  employeeId: number
  summary: WorkloadRow
  projects: WorkloadRow[]
}

function cellClass(cell: PlanningWorkloadDayCell | undefined, plannedHours: number): string {
  if (!cell || !cell.isWorkingDay) return 'planning-cell-off'
  if (plannedHours <= 0) return 'planning-cell-free'
  if (cell.isWorkingDay && plannedHours >= cell.capacityHours) return 'planning-cell-busy'
  if (plannedHours > 0) return 'planning-cell-partial'
  return 'planning-cell-free'
}

function buildSummaryRow(employee: PlanningWorkloadEmployee, projectCount = 0): WorkloadRow {
  return {
    key: `emp-${employee.id}`,
    employeeId: employee.id,
    employeeName: employee.fullName,
    projectId: null,
    projectLabel: null,
    expertises: employee.expertises,
    departmentNames: employee.departmentNames,
    isSummary: true,
    projectCount,
    getCell: (day) => employee.days[day],
    projectHours: (day) => employee.days[day]?.plannedHours ?? 0,
  }
}

function buildEmployeeGroup(employee: PlanningWorkloadEmployee): EmployeeGroup {
  const projects = new Map<number, { requestNumber: string; requestName: string }>()
  for (const cell of Object.values(employee.days)) {
    for (const allocation of cell.allocations) {
      projects.set(allocation.projectId, {
        requestNumber: allocation.requestNumber,
        requestName: allocation.requestName,
      })
    }
  }

  const projectRows: WorkloadRow[] = [...projects.entries()]
    .sort((a, b) => a[1].requestNumber.localeCompare(b[1].requestNumber, 'ru'))
    .map(([projectId, meta]) => ({
      key: `emp-${employee.id}-proj-${projectId}`,
      employeeId: employee.id,
      employeeName: employee.fullName,
      projectId,
      projectLabel: `${meta.requestNumber} — ${meta.requestName}`,
      expertises: employee.expertises,
      departmentNames: employee.departmentNames,
      isSummary: false,
      projectCount: projects.size,
      getCell: (day: string) => employee.days[day],
      projectHours: (day: string) =>
        employee.days[day]?.allocations
          .filter((item) => item.projectId === projectId)
          .reduce((sum, item) => sum + item.plannedHours, 0) ?? 0,
    }))

  return {
    employeeId: employee.id,
    summary: buildSummaryRow(employee, projectRows.length),
    projects: projectRows,
  }
}

function cellTitle(row: WorkloadRow, day: string): string {
  const cell = row.getCell(day)
  if (!cell) return ''
  const planned = row.isSummary ? cell.plannedHours : row.projectHours(day)
  const parts = [
    row.projectLabel ? `${row.employeeName} · ${row.projectLabel}` : row.employeeName,
    `День: ${day}`,
    `План: ${planned}`,
  ]
  if (row.isSummary) {
    parts.push(`Ёмкость: ${cell.capacityHours}`, `Свободно: ${cell.availableHours}`, `Факт: ${cell.actualHours}`)
  }
  if (cell.timeOffKind) parts.push(`Отсутствие: ${cell.timeOffKind}`)
  if (row.isSummary && cell.allocations.length) {
    parts.push(
      ...cell.allocations.map(
        (item) => `${item.requestNumber}: план ${item.plannedHours}, факт ${item.actualHours}`,
      ),
    )
  }
  return parts.join('\n')
}

function WorkloadCells({ row, dayKeys }: { row: WorkloadRow; dayKeys: string[] }) {
  return (
    <>
      {dayKeys.map((day) => {
        const cell = row.getCell(day)
        const planned = row.isSummary ? cell?.plannedHours ?? 0 : row.projectHours(day)
        return (
          <td key={day} className={cellClass(cell, planned)} title={cellTitle(row, day)}>
            {cell && cell.isWorkingDay ? (
              row.isSummary ? (
                <>
                  <div>{planned || '·'}</div>
                  <div className="planning-cell-muted">{cell.availableHours}</div>
                </>
              ) : (
                <div>{planned || '·'}</div>
              )
            ) : (
              '—'
            )}
          </td>
        )
      })}
    </>
  )
}

export default function PlanningWorkload() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [viewMode, setViewMode] = useState<WorkloadViewMode>('byProject')
  const [workload, setWorkload] = useState<PlanningWorkload | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set())

  const bounds = useMemo(() => monthBounds(year, month), [year, month])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        dateFrom: bounds.from,
        dateTo: bounds.to,
      })
      const data = await getJson<PlanningWorkload>(`/api/planning/workload?${params.toString()}`)
      setWorkload(data)
    } catch (error) {
      notifyProblem(error, 'Не удалось загрузить нагрузку сотрудников')
    } finally {
      setLoading(false)
    }
  }, [bounds.from, bounds.to])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setExpandedIds(new Set())
  }, [year, month, viewMode])

  const dayKeys = workload?.days.map((day) => day.slice(0, 10)) ?? []

  const groups = useMemo(() => {
    if (!workload) return []
    return workload.employees.map((employee) => buildEmployeeGroup(employee))
  }, [workload])

  const toggleExpanded = (employeeId: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(employeeId)) next.delete(employeeId)
      else next.add(employeeId)
      return next
    })
  }

  return (
    <section className="org-panel">
      <div className="org-panel-toolbar">
        <h2>Нагрузка</h2>
        <div className="org-panel-toolbar-actions">
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            Обновить
          </button>
          {loading ? <span className="org-hint">Обновление…</span> : null}
        </div>
      </div>

      <div className="planning-filter-bar">
        <label>
          Год
          <input
            type="number"
            min="2000"
            max="2100"
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
          />
        </label>
        <label>
          Месяц
          <select value={month} onChange={(event) => setMonth(Number(event.target.value))}>
            {MONTH_NAMES_FULL.map((label, index) => (
              <option key={label} value={index}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Вид
          <select value={viewMode} onChange={(event) => setViewMode(event.target.value as WorkloadViewMode)}>
            <option value="byProject">По проектам</option>
            <option value="summary">Сводка</option>
          </select>
        </label>
      </div>

      <p className="org-hint">
        Учитываются производственный календарь, отпуска и выделения на проекты. В режиме «По проектам» нагрузка по
        проектам скрыта в раскрывающемся списке под сотрудником.
      </p>

      <div className="planning-workload-list">
        {groups.map((group) => {
          const canExpand = viewMode === 'byProject' && group.projects.length > 0
          const expanded = canExpand && expandedIds.has(group.employeeId)
          const summary = group.summary

          return (
            <article key={group.employeeId} className="planning-workload-employee-block">
              <header className="planning-workload-employee-header">
                {canExpand ? (
                  <button
                    type="button"
                    className="planning-workload-expand"
                    aria-expanded={expanded}
                    onClick={() => toggleExpanded(group.employeeId)}
                  >
                    <span className="planning-workload-expand-icon" aria-hidden>
                      {expanded ? '▾' : '▸'}
                    </span>
                    <span className="planning-workload-employee-name">{summary.employeeName}</span>
                    <span className="planning-workload-employee-meta">
                      {summary.departmentNames.join(', ') || '—'}
                      {summary.expertises.length ? ` · ${summary.expertises.join(', ')}` : ''}
                      {` · проектов: ${group.projects.length}`}
                    </span>
                  </button>
                ) : (
                  <div className="planning-workload-employee-title">
                    <span className="planning-workload-employee-name">{summary.employeeName}</span>
                    <span className="planning-workload-employee-meta">
                      {summary.departmentNames.join(', ') || '—'}
                      {summary.expertises.length ? ` · ${summary.expertises.join(', ')}` : ''}
                    </span>
                  </div>
                )}
              </header>

              <div className="planning-workload-scroll">
                <table className="planning-workload-table">
                  <thead>
                    <tr>
                      <th className="sticky-col">{expanded ? 'Сводка / проект' : 'Сводка'}</th>
                      {dayKeys.map((day) => (
                        <th key={day}>{day.slice(8, 10)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="planning-workload-summary-row">
                      <td className="sticky-col">
                        <div className="planning-workload-row-title">Итого</div>
                        <div className="planning-workload-project-label">план / свободно</div>
                      </td>
                      <WorkloadCells row={summary} dayKeys={dayKeys} />
                    </tr>
                    {expanded
                      ? group.projects.map((row) => (
                          <tr key={row.key} className="planning-workload-project-row">
                            <td className="sticky-col">
                              <div className="planning-workload-project-label">{row.projectLabel}</div>
                            </td>
                            <WorkloadCells row={row} dayKeys={dayKeys} />
                          </tr>
                        ))
                      : null}
                  </tbody>
                </table>
              </div>
            </article>
          )
        })}

        {!loading && groups.length === 0 ? (
          <p className="org-hint">Нет сотрудников для отображения.</p>
        ) : null}
      </div>
    </section>
  )
}
