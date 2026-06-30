import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { deleteJson, getJson, patchJson, postForm, postJson, putJson, resolvePhotoUrl } from '../api'
import OrgChartView from './OrgChartView'
import VacationSchedule from './VacationSchedule'
import EmployeeCardModal from './EmployeeCardModal'
import type {
  Department,
  DepartmentMember,
  Employee,
  EmployeeDetail,
  EmployeeExpertise,
  ExpertiseDirection,
  JobPosition,
  OrgChartData,
  OrgPanel,
  SelectOption,
  TeamRole,
} from './types'
import './org.css'

type DepartmentsProps = {
  canManage: boolean
  orgEmployeeId: number | null
}

function employeeInitials(fullName: string): string {
  return (
    fullName
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

function formatExpertises(expertises: EmployeeExpertise[] | undefined): string {
  if (!expertises?.length) return '—'
  return expertises
    .map((item) => (item.level ? `${item.directionName} (${item.level})` : item.directionName))
    .join(', ')
}

function EmployeeNameButton({
  employeeId,
  name,
  onOpen,
}: {
  employeeId: number
  name: string
  onOpen: (employeeId: number) => void
}) {
  return (
    <button type="button" className="org-employee-link" onClick={() => onOpen(employeeId)}>
      {name}
    </button>
  )
}

const EMPTY_EMPLOYEE = {
  fullName: '',
  email: '',
  positionId: '',
  managerId: '',
  dailyWorkHours: '8',
  isActive: true,
  isOrganizationHead: false,
  createUserAccount: false,
  userPassword: '',
  userIsAdmin: false,
}

const EMPTY_DEPARTMENT = {
  name: '',
  description: '',
  headEmployeeId: '',
  sortOrder: '0',
  isActive: true,
}

const EMPTY_MEMBER = {
  employeeId: '',
  teamRoleId: '',
  position: '',
  managerId: '',
  email: '',
  sortOrder: '0',
}

export default function Departments({ canManage, orgEmployeeId }: DepartmentsProps) {
  const [panel, setPanel] = useState<OrgPanel>('roster')
  const [departments, setDepartments] = useState<Department[]>([])
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<number | null>(null)
  const [members, setMembers] = useState<DepartmentMember[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [positions, setPositions] = useState<JobPosition[]>([])
  const [teamRoles, setTeamRoles] = useState<TeamRole[]>([])
  const [expertiseDirections, setExpertiseDirections] = useState<ExpertiseDirection[]>([])
  const [employeeOptions, setEmployeeOptions] = useState<SelectOption[]>([])
  const [orgChart, setOrgChart] = useState<OrgChartData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [employeeForm, setEmployeeForm] = useState({ ...EMPTY_EMPLOYEE })
  const [editingEmployeeId, setEditingEmployeeId] = useState<number | null>(null)
  const [departmentForm, setDepartmentForm] = useState({ ...EMPTY_DEPARTMENT })
  const [editingDepartmentId, setEditingDepartmentId] = useState<number | null>(null)
  const [memberForm, setMemberForm] = useState({ ...EMPTY_MEMBER })
  const [editingMemberId, setEditingMemberId] = useState<number | null>(null)
  const [showEmployeeModal, setShowEmployeeModal] = useState(false)
  const [showDepartmentModal, setShowDepartmentModal] = useState(false)
  const [showMemberModal, setShowMemberModal] = useState(false)
  const [cardEmployeeId, setCardEmployeeId] = useState<number | null>(null)
  const [expertiseDirectionId, setExpertiseDirectionId] = useState('')
  const [expertiseLevel, setExpertiseLevel] = useState('')
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)
  const [savingEmployee, setSavingEmployee] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const userPickedAllCompany = useRef(false)

  const openEmployeeCard = (employeeId: number) => setCardEmployeeId(employeeId)
  const closeEmployeeCard = () => setCardEmployeeId(null)

  const selectedDepartment = useMemo(
    () => departments.find((d) => d.id === selectedDepartmentId) ?? null,
    [departments, selectedDepartmentId],
  )

  const positionNames = useMemo(() => positions.map((p) => p.name), [positions])

  const employeeById = useMemo(() => {
    const map = new Map<number, Employee>()
    for (const emp of employees) map.set(emp.id, emp)
    return map
  }, [employees])

  const editingEmployee = useMemo(
    () => (editingEmployeeId ? employeeById.get(editingEmployeeId) ?? null : null),
    [editingEmployeeId, employeeById],
  )

  const loadBase = useCallback(async () => {
    setError(null)
    try {
      const [deptData, empData, posData, roleData, dirData, optData] = await Promise.all([
        getJson<Department[]>('/api/org/departments'),
        getJson<Employee[]>('/api/org/employees'),
        getJson<JobPosition[]>('/api/org/job-positions'),
        getJson<TeamRole[]>('/api/org/team-roles'),
        getJson<ExpertiseDirection[]>('/api/org/expertise-directions'),
        getJson<SelectOption[]>('/api/org/employee-options'),
      ])
      setDepartments(deptData)
      setEmployees(empData)
      setPositions(posData)
      setTeamRoles(roleData)
      setExpertiseDirections(dirData)
      setEmployeeOptions(optData)
      setSelectedDepartmentId((current) => {
        if (current !== null || userPickedAllCompany.current || deptData.length === 0) {
          return current
        }
        return deptData[0].id
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    }
  }, [])

  const loadMembers = useCallback(async (departmentId: number) => {
    const data = await getJson<DepartmentMember[]>(`/api/org/departments/${departmentId}/members`)
    setMembers(data)
  }, [])

  const loadChart = useCallback(async (departmentId: number | null) => {
    const query = departmentId ? `?department_id=${departmentId}` : ''
    const data = await getJson<OrgChartData>(`/api/org/org-chart${query}`)
    setOrgChart(data)
  }, [])

  useEffect(() => {
    void loadBase()
  }, [loadBase])

  useEffect(() => {
    if (panel === 'roster' && selectedDepartmentId !== null) {
      void loadMembers(selectedDepartmentId).catch((err) =>
        setError(err instanceof Error ? err.message : 'Ошибка'),
      )
    }
    if (panel === 'pyramid') {
      void loadChart(selectedDepartmentId).catch((err) =>
        setError(err instanceof Error ? err.message : 'Ошибка'),
      )
    }
  }, [panel, selectedDepartmentId, loadMembers, loadChart])

  const refreshAll = async () => {
    setLoading(true)
    await loadBase()
    if (selectedDepartmentId !== null) {
      await loadMembers(selectedDepartmentId)
    }
    if (panel === 'pyramid') {
      await loadChart(selectedDepartmentId)
    }
    setLoading(false)
  }

  const resetPhotoState = (existingUrl?: string | null) => {
    if (photoPreviewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(photoPreviewUrl)
    }
    setPhotoFile(null)
    setPhotoPreviewUrl(existingUrl ?? null)
    if (photoInputRef.current) {
      photoInputRef.current.value = ''
    }
  }

  const closeEmployeeModal = () => {
    resetPhotoState()
    setShowEmployeeModal(false)
  }

  const handlePhotoPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (photoPreviewUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(photoPreviewUrl)
    }
    setPhotoFile(file)
    setPhotoPreviewUrl(URL.createObjectURL(file))
  }

  const openCreateEmployee = () => {
    setEditingEmployeeId(null)
    setEmployeeForm({ ...EMPTY_EMPLOYEE })
    setExpertiseDirectionId('')
    setExpertiseLevel('')
    resetPhotoState()
    setShowEmployeeModal(true)
  }

  const openEditEmployee = (emp: Employee) => {
    setEditingEmployeeId(emp.id)
    setExpertiseDirectionId('')
    setExpertiseLevel('')
    resetPhotoState(resolvePhotoUrl(emp.photoUrl))
    setEmployeeForm({
      fullName: emp.fullName,
      email: emp.email ?? '',
      positionId: emp.positionId ? String(emp.positionId) : '',
      managerId: emp.managerId ? String(emp.managerId) : '',
      dailyWorkHours: String(emp.dailyWorkHours),
      isActive: emp.isActive,
      isOrganizationHead: emp.isOrganizationHead,
      createUserAccount: false,
      userPassword: '',
      userIsAdmin: emp.user?.role === 'admin',
    })
    setShowEmployeeModal(true)
  }

  const uploadEmployeePhoto = async (employeeId: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    await postForm(`/api/org/employees/${employeeId}/photo`, form)
  }

  const saveEmployee = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canManage || savingEmployee) return
    setError(null)
    const body = {
      fullName: employeeForm.fullName.trim(),
      email: employeeForm.email.trim() || null,
      positionId: employeeForm.positionId ? Number(employeeForm.positionId) : null,
      managerId: employeeForm.managerId ? Number(employeeForm.managerId) : null,
      dailyWorkHours: Number(employeeForm.dailyWorkHours),
      isActive: employeeForm.isActive,
      isOrganizationHead: employeeForm.isOrganizationHead,
      createUserAccount: employeeForm.createUserAccount,
      userPassword: employeeForm.userPassword || null,
      userIsAdmin: employeeForm.userIsAdmin,
    }
    setSavingEmployee(true)
    try {
      let employeeId = editingEmployeeId
      if (editingEmployeeId) {
        await patchJson(`/api/org/employees/${editingEmployeeId}`, {
          fullName: body.fullName,
          email: body.email,
          positionId: body.positionId,
          managerId: body.managerId,
          dailyWorkHours: body.dailyWorkHours,
          isActive: body.isActive,
          isOrganizationHead: body.isOrganizationHead,
          userIsAdmin: body.userIsAdmin,
          userPassword: body.userPassword,
        })
      } else {
        const created = await postJson<Employee>('/api/org/employees', body)
        employeeId = created.id
      }
      if (photoFile && employeeId) {
        await uploadEmployeePhoto(employeeId, photoFile)
      }
      closeEmployeeModal()
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения сотрудника')
    } finally {
      setSavingEmployee(false)
    }
  }

  const removeEmployee = async (id: number) => {
    if (!canManage || !window.confirm('Удалить сотрудника?')) return
    try {
      await deleteJson(`/api/org/employees/${id}`)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления')
    }
  }

  const openCreateDepartment = () => {
    setEditingDepartmentId(null)
    setDepartmentForm({ ...EMPTY_DEPARTMENT })
    setShowDepartmentModal(true)
  }

  const openEditDepartment = (dept: Department) => {
    setEditingDepartmentId(dept.id)
    setDepartmentForm({
      name: dept.name,
      description: dept.description ?? '',
      headEmployeeId: dept.headEmployeeId ? String(dept.headEmployeeId) : '',
      sortOrder: String(dept.sortOrder),
      isActive: dept.isActive,
    })
    setShowDepartmentModal(true)
  }

  const saveDepartment = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canManage) return
    const body = {
      name: departmentForm.name.trim(),
      description: departmentForm.description.trim() || null,
      headEmployeeId: departmentForm.headEmployeeId ? Number(departmentForm.headEmployeeId) : null,
      sortOrder: Number(departmentForm.sortOrder),
      isActive: departmentForm.isActive,
    }
    try {
      if (editingDepartmentId) {
        await putJson(`/api/org/departments/${editingDepartmentId}`, body)
      } else {
        await postJson('/api/org/departments', body)
      }
      setShowDepartmentModal(false)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения отдела')
    }
  }

  const removeDepartment = async (id: number) => {
    if (!canManage || !window.confirm('Удалить отдел?')) return
    try {
      await deleteJson(`/api/org/departments/${id}`)
      if (selectedDepartmentId === id) setSelectedDepartmentId(null)
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления')
    }
  }

  const openCreateMember = () => {
    setEditingMemberId(null)
    setMemberForm({ ...EMPTY_MEMBER })
    setShowMemberModal(true)
  }

  const openEditMember = (member: DepartmentMember) => {
    setEditingMemberId(member.id)
    setMemberForm({
      employeeId: String(member.employeeId),
      teamRoleId: member.teamRoleId ? String(member.teamRoleId) : '',
      position: member.position ?? '',
      managerId: member.managerId ? String(member.managerId) : '',
      email: member.email ?? '',
      sortOrder: String(member.sortOrder),
    })
    setShowMemberModal(true)
  }

  const saveMember = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canManage || selectedDepartmentId === null) return
    const body = {
      employeeId: Number(memberForm.employeeId),
      teamRoleId: memberForm.teamRoleId ? Number(memberForm.teamRoleId) : null,
      position: memberForm.position.trim() || null,
      managerId: memberForm.managerId ? Number(memberForm.managerId) : null,
      email: memberForm.email.trim() || null,
      sortOrder: Number(memberForm.sortOrder),
    }
    try {
      if (editingMemberId) {
        await patchJson(`/api/org/departments/${selectedDepartmentId}/members/${editingMemberId}`, body)
      } else {
        await postJson(`/api/org/departments/${selectedDepartmentId}/members`, body)
      }
      setShowMemberModal(false)
      await loadMembers(selectedDepartmentId)
      await loadBase()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения участника')
    }
  }

  const removeMember = async (memberId: number) => {
    if (!canManage || selectedDepartmentId === null || !window.confirm('Удалить из состава?')) return
    try {
      await deleteJson(`/api/org/departments/${selectedDepartmentId}/members/${memberId}`)
      await loadMembers(selectedDepartmentId)
      await loadBase()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления')
    }
  }

  const addPosition = async () => {
    const name = window.prompt('Название должности')
    if (!name?.trim() || !canManage) return
    try {
      await postJson('/api/org/job-positions', { name: name.trim() })
      await loadBase()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка')
    }
  }

  const addExpertiseDirection = async () => {
    const name = window.prompt('Название направления экспертизы')
    if (!name?.trim() || !canManage) return
    try {
      await postJson('/api/org/expertise-directions', { name: name.trim() })
      await loadBase()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка')
    }
  }

  const addEmployeeExpertise = async () => {
    if (!editingEmployeeId || !expertiseDirectionId || !canManage) return
    setError(null)
    try {
      await postJson(`/api/org/employees/${editingEmployeeId}/expertise`, {
        expertiseDirectionId: Number(expertiseDirectionId),
        level: expertiseLevel.trim() || null,
      })
      setExpertiseDirectionId('')
      setExpertiseLevel('')
      await loadBase()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка добавления экспертизы')
    }
  }

  const removeEmployeeExpertise = async (expertiseId: number) => {
    if (!editingEmployeeId || !canManage) return
    if (!window.confirm('Удалить экспертизу?')) return
    setError(null)
    try {
      await deleteJson(`/api/org/employees/${editingEmployeeId}/expertise/${expertiseId}`)
      await loadBase()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления экспертизы')
    }
  }

  return (
    <div className="org-page">
      <nav className="org-subtabs" aria-label="Разделы отделов">
        {(
          [
            ['roster', 'Состав'],
            ['pyramid', 'Пирамида'],
            ['employees', 'Сотрудники'],
            ['vacations', 'График отпусков'],
            ['manage', 'Управление'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`org-subtab${panel === id ? ' org-subtab-active' : ''}`}
            onClick={() => setPanel(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {panel === 'roster' || panel === 'pyramid' || panel === 'vacations' ? (
        <div className="org-dept-filter">
          <label className="org-dept-filter-label">
            Отдел
            <select
              value={selectedDepartmentId ?? ''}
              onChange={(e) => {
                if (e.target.value === '') {
                  userPickedAllCompany.current = true
                  setSelectedDepartmentId(null)
                } else {
                  userPickedAllCompany.current = false
                  setSelectedDepartmentId(Number(e.target.value))
                }
              }}
            >
              <option value="">Вся компания</option>
              {departments.map((dept) => (
                <option key={dept.id} value={dept.id}>
                  {dept.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {error ? <p className="org-error">{error}</p> : null}
      {loading ? <p>Обновление…</p> : null}

      {panel === 'roster' ? (
        <section className="org-panel">
          <div className="org-panel-toolbar">
            <h2>{selectedDepartment?.name ?? 'Выберите отдел'}</h2>
            {canManage && selectedDepartmentId !== null ? (
              <button type="button" className="btn-primary" onClick={openCreateMember}>
                + Участник
              </button>
            ) : null}
          </div>
          {selectedDepartmentId === null ? (
            <p className="org-hint">Выберите отдел для просмотра состава.</p>
          ) : (
            <table className="org-table">
              <thead>
                <tr>
                  <th>ФИО</th>
                  <th>Роль</th>
                  <th>Должность</th>
                  <th>Руководитель</th>
                  <th>Email</th>
                  <th>Рабочих часов в день</th>
                  <th>Экспертиза</th>
                  {canManage ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const emp = employeeById.get(member.employeeId)
                  return (
                  <tr key={member.id}>
                    <td>
                      <EmployeeNameButton
                        employeeId={member.employeeId}
                        name={member.employeeName}
                        onOpen={openEmployeeCard}
                      />
                    </td>
                    <td>{member.teamRoleName ?? '—'}</td>
                    <td>{member.displayPosition ?? '—'}</td>
                    <td>{member.managerName ?? '—'}</td>
                    <td>{member.displayEmail ?? emp?.email ?? '—'}</td>
                    <td>{emp?.dailyWorkHours ?? '—'}</td>
                    <td>{formatExpertises(emp?.expertises)}</td>
                    {canManage ? (
                      <td className="org-table-actions">
                        <button type="button" className="btn-ghost" onClick={() => openEditMember(member)}>
                          Изм.
                        </button>
                        <button type="button" className="btn-ghost" onClick={() => void removeMember(member.id)}>
                          ✕
                        </button>
                      </td>
                    ) : null}
                  </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {panel === 'pyramid' ? (
        <section className="org-panel">
          {selectedDepartmentId === null ? (
            <>
              {orgChart?.organizationHead ? (
                <OrgChartView
                  organizationHead={orgChart.organizationHead}
                  roots={[]}
                  onEmployeeClick={openEmployeeCard}
                />
              ) : null}
              {orgChart?.departments?.map((block) => (
                <div key={block.departmentId} className="org-dept-block">
                  <OrgChartView
                    roots={block.roots}
                    departmentName={block.departmentName}
                    framed
                    onEmployeeClick={openEmployeeCard}
                  />
                </div>
              )) ?? (
                <OrgChartView roots={orgChart?.departmentTree ?? []} onEmployeeClick={openEmployeeCard} />
              )}
            </>
          ) : (
            <OrgChartView
              roots={orgChart?.departmentTree ?? []}
              departmentName={selectedDepartment?.name}
              framed
              onEmployeeClick={openEmployeeCard}
            />
          )}
        </section>
      ) : null}

      {panel === 'employees' ? (
        <section className="org-panel">
          <div className="org-panel-toolbar">
            <h2>Сотрудники</h2>
            {canManage ? (
              <div className="org-panel-toolbar-actions">
                <button type="button" className="btn-ghost" onClick={() => void addExpertiseDirection()}>
                  + Направление
                </button>
                <button type="button" className="btn-ghost" onClick={() => void addPosition()}>
                  + Должность
                </button>
                <button type="button" className="btn-primary" onClick={openCreateEmployee}>
                  + Сотрудник
                </button>
              </div>
            ) : null}
          </div>
          <table className="org-table">
            <thead>
              <tr>
                <th>ФИО</th>
                <th>Должность</th>
                <th>Email</th>
                <th>Рабочих часов в день</th>
                <th>Экспертиза</th>
                <th>Руководитель</th>
                <th>Активен</th>
                {canManage ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => (
                <tr key={emp.id}>
                  <td>
                    <EmployeeNameButton employeeId={emp.id} name={emp.fullName} onOpen={openEmployeeCard} />
                  </td>
                  <td>{emp.position ?? '—'}</td>
                  <td>{emp.email ?? '—'}</td>
                  <td>{emp.dailyWorkHours}</td>
                  <td>{formatExpertises(emp.expertises)}</td>
                  <td>{emp.managerName ?? '—'}</td>
                  <td>{emp.isActive ? 'Да' : 'Нет'}</td>
                  {canManage ? (
                    <td className="org-table-actions">
                      <button type="button" className="btn-ghost" onClick={() => openEditEmployee(emp)}>
                        Изм.
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => void removeEmployee(emp.id)}>
                        ✕
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {panel === 'vacations' ? (
        <VacationSchedule
          departmentId={selectedDepartmentId}
          orgEmployeeId={orgEmployeeId}
          canManage={canManage}
        />
      ) : null}

      {panel === 'manage' ? (
        <section className="org-panel">
          <div className="org-panel-toolbar">
            <h2>Отделы</h2>
            {canManage ? (
              <button type="button" className="btn-primary" onClick={openCreateDepartment}>
                + Отдел
              </button>
            ) : null}
          </div>
          <table className="org-table">
            <thead>
              <tr>
                <th>Название</th>
                <th>Руководитель</th>
                <th>Участников</th>
                <th>Порядок</th>
                <th>Активен</th>
                {canManage ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {departments.map((dept) => (
                <tr key={dept.id}>
                  <td>{dept.name}</td>
                  <td>{dept.headEmployeeName ?? '—'}</td>
                  <td>{dept.memberCount}</td>
                  <td>{dept.sortOrder}</td>
                  <td>{dept.isActive ? 'Да' : 'Нет'}</td>
                  {canManage ? (
                    <td className="org-table-actions">
                      <button type="button" className="btn-ghost" onClick={() => openEditDepartment(dept)}>
                        Изм.
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => void removeDepartment(dept.id)}>
                        ✕
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {showEmployeeModal ? (
        <div className="org-modal-backdrop" onClick={closeEmployeeModal}>
          <div className="org-modal org-employee-modal" onClick={(e) => e.stopPropagation()}>
            <header className="org-modal-header">
              <h3>{editingEmployeeId ? 'Редактирование сотрудника' : 'Новый сотрудник'}</h3>
              <button type="button" className="btn-ghost" onClick={closeEmployeeModal} aria-label="Закрыть">
                ✕
              </button>
            </header>
            <form className="org-employee-form" onSubmit={(e) => void saveEmployee(e)}>
              <div className="org-employee-modal-body org-form">
                <section className="org-employee-hero">
                  <div className="org-employee-photo-preview">
                    {photoPreviewUrl ? (
                      <img src={photoPreviewUrl} alt="" />
                    ) : (
                      <div className="org-employee-photo-placeholder">
                        {employeeInitials(employeeForm.fullName)}
                      </div>
                    )}
                  </div>
                  <div className="org-employee-photo-actions">
                    <label className="org-photo-upload-btn">
                      {photoPreviewUrl ? 'Сменить фото' : 'Добавить фото'}
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={handlePhotoPick}
                      />
                    </label>
                    <p className="org-hint">PNG, JPEG или WebP, до 5 МБ</p>
                  </div>
                </section>

                <section className="org-employee-fields">
                  <label>
                    ФИО
                    <input
                      value={employeeForm.fullName}
                      onChange={(e) => setEmployeeForm({ ...employeeForm, fullName: e.target.value })}
                      required
                      autoFocus
                    />
                  </label>
                  <div className="org-form-row-2">
                    <label>
                      Email
                      <input
                        type="email"
                        value={employeeForm.email}
                        onChange={(e) => setEmployeeForm({ ...employeeForm, email: e.target.value })}
                      />
                    </label>
                    <label>
                      Рабочих часов в день
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        max="24"
                        value={employeeForm.dailyWorkHours}
                        onChange={(e) =>
                          setEmployeeForm({ ...employeeForm, dailyWorkHours: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Должность
                    <select
                      value={employeeForm.positionId}
                      onChange={(e) => setEmployeeForm({ ...employeeForm, positionId: e.target.value })}
                    >
                      <option value="">— выберите —</option>
                      {positions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Руководитель
                    <select
                      value={employeeForm.managerId}
                      onChange={(e) => setEmployeeForm({ ...employeeForm, managerId: e.target.value })}
                    >
                      <option value="">— не назначен —</option>
                      {employeeOptions
                        .filter((o) => o.id !== editingEmployeeId)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </section>

                {editingEmployeeId && editingEmployee ? (
                  <section className="org-form-section">
                    <div className="org-form-section-header">
                      <h4>Экспертиза</h4>
                      {canManage ? (
                        <button type="button" className="btn-ghost" onClick={() => void addExpertiseDirection()}>
                          + Направление
                        </button>
                      ) : null}
                    </div>
                    {editingEmployee.expertises.length > 0 ? (
                      <ul className="org-expertise-list">
                        {editingEmployee.expertises.map((item) => (
                          <li key={item.id}>
                            <span>
                              {item.directionName}
                              {item.level ? ` (${item.level})` : ''}
                            </span>
                            {canManage ? (
                              <button
                                type="button"
                                className="btn-ghost org-expertise-remove"
                                onClick={() => void removeEmployeeExpertise(item.id)}
                              >
                                ✕
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="org-hint">Экспертиза не указана</p>
                    )}
                    {canManage ? (
                      <div className="org-inline-form org-employee-expertise-form">
                        <select
                          value={expertiseDirectionId}
                          onChange={(e) => setExpertiseDirectionId(e.target.value)}
                        >
                          <option value="">— направление —</option>
                          {expertiseDirections.map((direction) => (
                            <option key={direction.id} value={direction.id}>
                              {direction.name}
                            </option>
                          ))}
                        </select>
                        <input
                          value={expertiseLevel}
                          onChange={(e) => setExpertiseLevel(e.target.value)}
                          placeholder="Уровень, например senior"
                        />
                        <button type="button" className="btn-primary" onClick={() => void addEmployeeExpertise()}>
                          Добавить
                        </button>
                      </div>
                    ) : null}
                  </section>
                ) : null}

                <section className="org-form-section">
                  <h4>Статус</h4>
                  <div className="org-form-checkboxes">
                    <label className="org-checkbox">
                      <input
                        type="checkbox"
                        checked={employeeForm.isActive}
                        onChange={(e) => setEmployeeForm({ ...employeeForm, isActive: e.target.checked })}
                      />
                      Активен
                    </label>
                    <label className="org-checkbox">
                      <input
                        type="checkbox"
                        checked={employeeForm.isOrganizationHead}
                        onChange={(e) =>
                          setEmployeeForm({ ...employeeForm, isOrganizationHead: e.target.checked })
                        }
                      />
                      Директор организации
                    </label>
                  </div>
                </section>

                {!editingEmployeeId ? (
                  <section className="org-form-section">
                    <h4>Учётная запись</h4>
                    <label className="org-checkbox">
                      <input
                        type="checkbox"
                        checked={employeeForm.createUserAccount}
                        onChange={(e) =>
                          setEmployeeForm({ ...employeeForm, createUserAccount: e.target.checked })
                        }
                      />
                      Создать учётную запись для входа
                    </label>
                    {employeeForm.createUserAccount ? (
                      <div className="org-form-row-2 org-form-row-align-end">
                        <label>
                          Пароль для входа
                          <input
                            type="password"
                            value={employeeForm.userPassword}
                            onChange={(e) =>
                              setEmployeeForm({ ...employeeForm, userPassword: e.target.value })
                            }
                          />
                        </label>
                        <label className="org-checkbox org-checkbox-field">
                          <input
                            type="checkbox"
                            checked={employeeForm.userIsAdmin}
                            onChange={(e) =>
                              setEmployeeForm({ ...employeeForm, userIsAdmin: e.target.checked })
                            }
                          />
                          Администратор
                        </label>
                      </div>
                    ) : null}
                  </section>
                ) : editingEmployee?.user ? (
                  <section className="org-form-section">
                    <h4>Учётная запись</h4>
                    <p className="org-hint org-account-email">{editingEmployee.user.email}</p>
                    <div className="org-form-row-2 org-form-row-align-end">
                      <label className="org-checkbox org-checkbox-field">
                        <input
                          type="checkbox"
                          checked={employeeForm.userIsAdmin}
                          onChange={(e) =>
                            setEmployeeForm({ ...employeeForm, userIsAdmin: e.target.checked })
                          }
                        />
                        Администратор
                      </label>
                      <label>
                        Новый пароль
                        <input
                          type="password"
                          placeholder="Необязательно"
                          value={employeeForm.userPassword}
                          onChange={(e) =>
                            setEmployeeForm({ ...employeeForm, userPassword: e.target.value })
                          }
                        />
                      </label>
                    </div>
                  </section>
                ) : null}
              </div>

              <footer className="org-employee-modal-footer org-modal-actions">
                <button type="submit" className="btn-primary" disabled={savingEmployee}>
                  {savingEmployee ? 'Сохранение…' : 'Сохранить'}
                </button>
                <button type="button" className="btn-ghost" onClick={closeEmployeeModal} disabled={savingEmployee}>
                  Отмена
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}

      {showDepartmentModal ? (
        <div className="org-modal-backdrop" onClick={() => setShowDepartmentModal(false)}>
          <div className="org-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingDepartmentId ? 'Редактирование отдела' : 'Новый отдел'}</h3>
            <form className="org-form" onSubmit={(e) => void saveDepartment(e)}>
              <label>
                Название
                <input
                  value={departmentForm.name}
                  onChange={(e) => setDepartmentForm({ ...departmentForm, name: e.target.value })}
                  required
                />
              </label>
              <label>
                Руководитель
                <select
                  value={departmentForm.headEmployeeId}
                  onChange={(e) =>
                    setDepartmentForm({ ...departmentForm, headEmployeeId: e.target.value })
                  }
                >
                  <option value="">— не назначен —</option>
                  {employeeOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Описание
                <textarea
                  rows={3}
                  value={departmentForm.description}
                  onChange={(e) => setDepartmentForm({ ...departmentForm, description: e.target.value })}
                />
              </label>
              <label>
                Порядок
                <input
                  type="number"
                  value={departmentForm.sortOrder}
                  onChange={(e) => setDepartmentForm({ ...departmentForm, sortOrder: e.target.value })}
                />
              </label>
              <label className="org-checkbox">
                <input
                  type="checkbox"
                  checked={departmentForm.isActive}
                  onChange={(e) => setDepartmentForm({ ...departmentForm, isActive: e.target.checked })}
                />
                Активен
              </label>
              <div className="org-modal-actions">
                <button type="submit" className="btn-primary">
                  Сохранить
                </button>
                <button type="button" className="btn-ghost" onClick={() => setShowDepartmentModal(false)}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showMemberModal && selectedDepartmentId !== null ? (
        <div className="org-modal-backdrop" onClick={() => setShowMemberModal(false)}>
          <div className="org-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingMemberId ? 'Редактирование участника' : 'Добавить участника'}</h3>
            <form className="org-form" onSubmit={(e) => void saveMember(e)}>
              {!editingMemberId ? (
                <label>
                  Сотрудник
                  <select
                    value={memberForm.employeeId}
                    onChange={(e) => setMemberForm({ ...memberForm, employeeId: e.target.value })}
                    required
                  >
                    <option value="">Выберите сотрудника</option>
                    {employeeOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                Роль в отделе
                <select
                  value={memberForm.teamRoleId}
                  onChange={(e) => setMemberForm({ ...memberForm, teamRoleId: e.target.value })}
                >
                  <option value="">— выберите —</option>
                  {teamRoles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Должность
                <select
                  value={memberForm.position}
                  onChange={(e) => setMemberForm({ ...memberForm, position: e.target.value })}
                >
                  <option value="">— из карточки сотрудника —</option>
                  {positionNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Руководитель
                <select
                  value={memberForm.managerId}
                  onChange={(e) => setMemberForm({ ...memberForm, managerId: e.target.value })}
                >
                  <option value="">— не назначен —</option>
                  {employeeOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Email
                <input
                  type="email"
                  placeholder="Если пусто — из справочника"
                  value={memberForm.email}
                  onChange={(e) => setMemberForm({ ...memberForm, email: e.target.value })}
                />
              </label>
              <label>
                Порядок
                <input
                  type="number"
                  value={memberForm.sortOrder}
                  onChange={(e) => setMemberForm({ ...memberForm, sortOrder: e.target.value })}
                />
              </label>
              <div className="org-modal-actions">
                <button type="submit" className="btn-primary">
                  Сохранить
                </button>
                <button type="button" className="btn-ghost" onClick={() => setShowMemberModal(false)}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {cardEmployeeId !== null ? (
        <EmployeeCardModal
          employeeId={cardEmployeeId}
          canManage={canManage}
          onClose={closeEmployeeCard}
          onOpenEmployee={openEmployeeCard}
          onEdit={(employee: EmployeeDetail) => {
            closeEmployeeCard()
            openEditEmployee(employee)
          }}
        />
      ) : null}
    </div>
  )
}
