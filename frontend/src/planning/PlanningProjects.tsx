import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { deleteJson, getJson, patchJson, postJson } from '../api'
import { notifyProblem } from '../toast'
import ZniDetailModal from '../ZniDetailModal'
import type { ChangeRequest } from '../zniTypes'
import PlanningExecutorMultiSelect from './PlanningExecutorMultiSelect'
import {
  formatPlanningStatus,
  lookupZniByNumbers,
  mapZniToProjectForm,
  PLANNING_STATUS_LABELS,
  resolvePlanningStatus,
} from './planningZni'
import type { PlanningComplexity, PlanningCustomerDepartment, PlanningProject, PlanningProjectStatus } from './types'
import type { Employee as OrgEmployee } from '../org/types'

type PlanningProjectsProps = {
  selectedProjectId: number | null
  onSelectProject: (projectId: number | null) => void
  onNavigateToZni?: (requestNumber: string) => void
}

const EMPTY_FORM = {
  requestNumber: '',
  requestName: '',
  requestUrl: '',
  complexityId: '',
  executorIds: [] as number[],
  customerName: '',
  customerDepartmentId: '',
  plannedStartDate: '',
  actualStartDate: '',
  plannedEndDate: '',
  actualEndDate: '',
  status: 'new' as PlanningProjectStatus,
  notes: '',
}

function formatExecutors(project: PlanningProject): string {
  if (project.executors?.length) {
    return project.executors
      .map((item) => `${item.fullName}${item.fromAllocation ? ' *' : ''}`)
      .join(', ')
  }
  return project.customerEmployeeName ?? '—'
}

function formatDate(value?: string | null): string {
  if (!value) return '—'
  return value.slice(0, 10)
}

function statusClass(status?: PlanningProjectStatus | null): string {
  if (status === 'completed') return 'planning-status planning-status-completed'
  if (status === 'in_progress') return 'planning-status planning-status-in-progress'
  return 'planning-status planning-status-new'
}

export default function PlanningProjects({
  selectedProjectId,
  onSelectProject,
  onNavigateToZni,
}: PlanningProjectsProps) {
  const [projects, setProjects] = useState<PlanningProject[]>([])
  const [complexities, setComplexities] = useState<PlanningComplexity[]>([])
  const [employees, setEmployees] = useState<OrgEmployee[]>([])
  const [customerDepartments, setCustomerDepartments] = useState<PlanningCustomerDepartment[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [zniLookup, setZniLookup] = useState<Record<string, ChangeRequest>>({})
  const [zniModalItem, setZniModalItem] = useState<ChangeRequest | null>(null)
  const [zniAutofillHint, setZniAutofillHint] = useState<string | null>(null)
  const lastLookupNumberRef = useRef('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [projectRows, complexityRows, employeeRows, customerDepartmentRows] = await Promise.all([
        getJson<PlanningProject[]>('/api/planning/projects'),
        getJson<PlanningComplexity[]>('/api/planning/complexities'),
        getJson<OrgEmployee[]>('/api/org/employees'),
        getJson<PlanningCustomerDepartment[]>('/api/planning/customer-departments'),
      ])
      setProjects(projectRows)
      setComplexities(complexityRows)
      setEmployees(employeeRows)
      setCustomerDepartments(customerDepartmentRows)
    } catch (error) {
      notifyProblem('Не удалось загрузить проекты планирования', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const projectNumbersKey = useMemo(
    () => projects.map((project) => project.requestNumber.trim()).filter(Boolean).join(','),
    [projects],
  )

  useEffect(() => {
    if (!projectNumbersKey) {
      setZniLookup({})
      return
    }
    let cancelled = false
    void lookupZniByNumbers(projectNumbersKey.split(','))
      .then((next) => {
        if (!cancelled) setZniLookup(next)
      })
      .catch(() => {
        if (!cancelled) setZniLookup({})
      })
    return () => {
      cancelled = true
    }
  }, [projectNumbersKey])

  useEffect(() => {
    if (!modalOpen) {
      lastLookupNumberRef.current = ''
      setZniAutofillHint(null)
      return
    }
    const number = form.requestNumber.trim()
    if (!/^\d+$/.test(number) || number === lastLookupNumberRef.current) {
      return
    }
    const timer = window.setTimeout(() => {
      void lookupZniByNumbers([number])
        .then((next) => {
          const zni = next[number]
          if (!zni) {
            setZniAutofillHint(null)
            return
          }
          lastLookupNumberRef.current = number
          const patch = mapZniToProjectForm(zni)
          setForm((prev) => ({
            ...prev,
            ...patch,
            status: resolvePlanningStatus(patch.status, patch.actualEndDate),
          }))
          setZniLookup((current) => ({ ...current, [number]: zni }))
          setZniAutofillHint(`Данные подставлены из ЗНИ ${number}`)
        })
        .catch(() => setZniAutofillHint(null))
    }, 400)
    return () => window.clearTimeout(timer)
  }, [form.requestNumber, modalOpen])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setZniAutofillHint(null)
    setModalOpen(true)
  }

  const openEdit = (project: PlanningProject) => {
    setEditingId(project.id)
    setForm({
      requestNumber: project.requestNumber,
      requestName: project.requestName,
      requestUrl: project.requestUrl ?? '',
      complexityId: project.complexityId ? String(project.complexityId) : '',
      executorIds: project.executorIds ?? (project.customerEmployeeId ? [project.customerEmployeeId] : []),
      customerName: project.customerName ?? '',
      customerDepartmentId: project.customerDepartmentId ? String(project.customerDepartmentId) : '',
      plannedStartDate: project.plannedStartDate?.slice(0, 10) ?? '',
      actualStartDate: project.actualStartDate?.slice(0, 10) ?? '',
      plannedEndDate: project.plannedEndDate?.slice(0, 10) ?? '',
      actualEndDate: project.actualEndDate?.slice(0, 10) ?? '',
      status: project.status ?? 'new',
      notes: project.notes ?? '',
    })
    setZniAutofillHint(null)
    lastLookupNumberRef.current = project.requestNumber.trim()
    setModalOpen(true)
  }

  const updateActualEndDate = (actualEndDate: string) => {
    setForm((prev) => ({
      ...prev,
      actualEndDate,
      status: resolvePlanningStatus(prev.status, actualEndDate),
    }))
  }

  const payloadFromForm = () => ({
    requestNumber: form.requestNumber.trim(),
    requestName: form.requestName.trim(),
    requestUrl: form.requestUrl.trim() || null,
    complexityId: form.complexityId ? Number(form.complexityId) : null,
    executorIds: form.executorIds,
    customerName: form.customerName.trim() || null,
    customerDepartmentId: form.customerDepartmentId ? Number(form.customerDepartmentId) : null,
    plannedStartDate: form.plannedStartDate || null,
    actualStartDate: form.actualStartDate || null,
    plannedEndDate: form.plannedEndDate || null,
    actualEndDate: form.actualEndDate || null,
    status: resolvePlanningStatus(form.status, form.actualEndDate),
    notes: form.notes.trim() || null,
  })

  const saveProject = async () => {
    if (!form.requestNumber.trim() || !form.requestName.trim()) {
      notifyProblem('Заполните номер и наименование запроса')
      return
    }
    try {
      if (editingId) {
        await patchJson(`/api/planning/projects/${editingId}`, payloadFromForm())
      } else {
        await postJson('/api/planning/projects', payloadFromForm())
      }
      setModalOpen(false)
      await load()
    } catch (error) {
      notifyProblem('Не удалось сохранить проект', error)
    }
  }

  const removeProject = async (projectId: number) => {
    if (!window.confirm('Удалить проект и все выделения ресурсов?')) return
    try {
      await deleteJson(`/api/planning/projects/${projectId}`)
      if (selectedProjectId === projectId) onSelectProject(null)
      await load()
    } catch (error) {
      notifyProblem('Не удалось удалить проект', error)
    }
  }

  const openZniModal = (zni: ChangeRequest) => {
    setZniModalItem(zni)
  }

  const renderProjectName = (project: PlanningProject) => {
    const zni = zniLookup[project.requestNumber.trim()]
    if (zni) {
      return (
        <span className="planning-project-name-links">
          <button type="button" className="org-employee-link" onClick={() => openZniModal(zni)} title="Карточка ЗНИ">
            {project.requestName}
          </button>
          {onNavigateToZni ? (
            <>
              {' · '}
              <button
                type="button"
                className="org-employee-link"
                onClick={() => onNavigateToZni(project.requestNumber)}
                title="Открыть во вкладке ЗНИ"
              >
                ЗНИ
              </button>
            </>
          ) : null}
        </span>
      )
    }
    if (project.requestUrl) {
      return (
        <a href={project.requestUrl} target="_blank" rel="noreferrer">
          {project.requestName}
        </a>
      )
    }
    return project.requestName
  }

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.requestNumber.localeCompare(b.requestNumber, 'ru')),
    [projects],
  )

  const statusLocked = Boolean(form.actualEndDate)

  const departmentOptions = useMemo(() => {
    const selectedId = form.customerDepartmentId ? Number(form.customerDepartmentId) : null
    return customerDepartments.filter(
      (department) => department.isActive || department.id === selectedId,
    )
  }, [customerDepartments, form.customerDepartmentId])

  return (
    <section className="org-panel">
      <div className="org-panel-toolbar">
        <h2>Проекты</h2>
        <div className="org-panel-toolbar-actions">
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            Обновить
          </button>
          <button type="button" className="btn-primary" onClick={openCreate}>
            Новый проект
          </button>
        </div>
      </div>

      {loading ? <p className="org-hint">Обновление…</p> : null}

      <div className="planning-table-scroll">
        <table className="org-table">
          <thead>
            <tr>
              <th>Номер</th>
              <th>Наименование</th>
              <th>Статус</th>
              <th>Сложность</th>
              <th>Исполнитель</th>
              <th>Заказчик</th>
              <th>Департамент</th>
              <th>Старт план/факт</th>
              <th>Завершение план/факт</th>
              <th>Часы план/факт</th>
              <th>Создал</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedProjects.map((project) => (
              <tr
                key={project.id}
                className={selectedProjectId === project.id ? 'planning-row-selected' : undefined}
              >
                <td>
                  <button
                    type="button"
                    className="org-employee-link"
                    onClick={() => onSelectProject(project.id)}
                  >
                    {project.requestNumber}
                  </button>
                </td>
                <td>{renderProjectName(project)}</td>
                <td>
                  <span className={statusClass(project.status)}>{formatPlanningStatus(project.status)}</span>
                </td>
                <td>{project.complexityName ?? '—'}</td>
                <td>{formatExecutors(project)}</td>
                <td>{project.customerName ?? '—'}</td>
                <td>{project.customerDepartmentName ?? '—'}</td>
                <td>
                  {formatDate(project.plannedStartDate)} / {formatDate(project.actualStartDate)}
                </td>
                <td>
                  {formatDate(project.plannedEndDate)} / {formatDate(project.actualEndDate)}
                </td>
                <td>
                  {project.totalPlannedHours} / {project.totalActualHours}
                </td>
                <td>{project.createdByLabel ?? '—'}</td>
                <td className="org-table-actions">
                  <button type="button" className="btn-ghost" onClick={() => openEdit(project)}>
                    Изменить
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => void removeProject(project.id)}>
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen ? (
        <div className="org-modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="org-modal org-profile-modal" onClick={(event) => event.stopPropagation()}>
            <header className="org-modal-header">
              <h3>{editingId ? 'Редактирование проекта' : 'Новый проект'}</h3>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setModalOpen(false)}
                aria-label="Закрыть"
              >
                ✕
              </button>
            </header>
            <div className="org-form">
              <div className="org-form-row-2">
                <label>
                  Номер запроса
                  <input
                    value={form.requestNumber}
                    onChange={(event) => {
                      lastLookupNumberRef.current = ''
                      setForm((prev) => ({ ...prev, requestNumber: event.target.value }))
                    }}
                  />
                </label>
                <label>
                  Статус
                  <select
                    value={form.status}
                    disabled={statusLocked}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        status: event.target.value as PlanningProjectStatus,
                      }))
                    }
                  >
                    {(Object.keys(PLANNING_STATUS_LABELS) as PlanningProjectStatus[]).map((status) => (
                      <option key={status} value={status}>
                        {PLANNING_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {zniAutofillHint ? <p className="org-hint">{zniAutofillHint}</p> : null}
              {statusLocked ? (
                <p className="org-hint">Статус «Завершен» проставляется автоматически при указании даты завершения (факт).</p>
              ) : null}
              <label>
                Наименование запроса
                <input
                  value={form.requestName}
                  onChange={(event) => setForm((prev) => ({ ...prev, requestName: event.target.value }))}
                />
              </label>
              <label>
                Ссылка на запрос
                <input
                  value={form.requestUrl}
                  onChange={(event) => setForm((prev) => ({ ...prev, requestUrl: event.target.value }))}
                />
              </label>
              <div className="org-form-row-2">
                <label>
                  Сложность
                  <select
                    value={form.complexityId}
                    onChange={(event) => setForm((prev) => ({ ...prev, complexityId: event.target.value }))}
                  >
                    <option value="">—</option>
                    {complexities.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Департамент заказчика
                  <select
                    value={form.customerDepartmentId}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, customerDepartmentId: event.target.value }))
                    }
                  >
                    <option value="">—</option>
                    {departmentOptions.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.isActive ? department.name : `${department.name} (выкл.)`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Заказчик (текст)
                <input
                  value={form.customerName}
                  onChange={(event) => setForm((prev) => ({ ...prev, customerName: event.target.value }))}
                />
              </label>
              <label>
                Исполнители
                <PlanningExecutorMultiSelect
                  employees={employees}
                  value={form.executorIds}
                  onChange={(executorIds) => setForm((prev) => ({ ...prev, executorIds }))}
                />
              </label>
              <p className="org-hint">* — добавлен автоматически из выделения ресурсов</p>
              <div className="org-form-row-2">
                <label>
                  Старт (план)
                  <input
                    type="date"
                    value={form.plannedStartDate}
                    onChange={(event) => setForm((prev) => ({ ...prev, plannedStartDate: event.target.value }))}
                  />
                </label>
                <label>
                  Старт (факт)
                  <input
                    type="date"
                    value={form.actualStartDate}
                    onChange={(event) => setForm((prev) => ({ ...prev, actualStartDate: event.target.value }))}
                  />
                </label>
              </div>
              <div className="org-form-row-2">
                <label>
                  Завершение (план)
                  <input
                    type="date"
                    value={form.plannedEndDate}
                    onChange={(event) => setForm((prev) => ({ ...prev, plannedEndDate: event.target.value }))}
                  />
                </label>
                <label>
                  Завершение (факт)
                  <input
                    type="date"
                    value={form.actualEndDate}
                    onChange={(event) => updateActualEndDate(event.target.value)}
                  />
                </label>
              </div>
              <label>
                Примечание
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                />
              </label>
            </div>
            <footer className="org-modal-actions" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" className="btn-ghost" onClick={() => setModalOpen(false)}>
                Отмена
              </button>
              <button type="button" className="btn-primary" onClick={() => void saveProject()}>
                Сохранить
              </button>
            </footer>
          </div>
        </div>
      ) : null}

      <ZniDetailModal item={zniModalItem} onClose={() => setZniModalItem(null)} />
    </section>
  )
}
