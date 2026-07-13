import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { deleteJson, getJson, patchJson, postForm, postJson, putJson, resolvePhotoUrl } from '../api'
import { notifyProblem } from '../toast'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import OrgChartCanvas from './OrgChartCanvas'
import OrgChartView from './OrgChartView'
import VacationSchedule from './VacationSchedule'
import WorkspaceBooking from './WorkspaceBooking'
import OfficePresence from './OfficePresence'
import EmployeeCardModal from './EmployeeCardModal'
import { employeeApiRef, employeeApiRefFromId } from './employeeMentions'
import OrgPhoto from './OrgPhoto'
import OrgFilterIcon from './OrgFilterIcon'
import { buildHolidayKeySet } from './ruPublicHolidays'
import { MONTH_NAMES_FULL, WEEKDAY_NAMES, getMonthDays, isWeekendDay, toDayKey } from './scheduleUtils'
import type {
  Department,
  DepartmentMember,
  Employee,
  EmployeeDepartmentBrief,
  EmployeeDetail,
  EmployeeExpertise,
  ExpertiseDirection,
  JobPosition,
  OfficeDay,
  OrgChartData,
  OrgPanel,
  EmployeeOption,
  TeamRole,
} from './types'
import './org.css'

type DepartmentsProps = {
  canManage: boolean
  orgEmployeeId: number | null
}

function formatExpertises(expertises: EmployeeExpertise[] | undefined): string {
  if (!expertises?.length) return '—'
  return expertises
    .map((item) => (item.level ? `${item.directionName} (${item.level})` : item.directionName))
    .join(', ')
}

function formatDepartments(departments: EmployeeDepartmentBrief[] | undefined): string {
  if (!departments?.length) return '—'
  return departments.map((item) => item.departmentName).join(', ')
}

function PersonCell({
  employeeId,
  name,
  photoUrl,
  onOpen,
}: {
  employeeId: number
  name: string
  photoUrl?: string | null
  onOpen: (employeeId: number) => void
}) {
  return (
    <span className="org-person-cell">
      <OrgPhoto
        url={photoUrl}
        name={name}
        className="org-table-avatar-img"
        placeholderClassName="org-table-avatar"
      />
      <EmployeeNameButton employeeId={employeeId} name={name} onOpen={onOpen} />
    </span>
  )
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
  createUserAccount: true,
  userPassword: '12345678',
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
  const savedOrgUi = loadOrgUiState()
  const [panel, setPanel] = useState<OrgPanel>(() => savedOrgUi.panel)
  const [departments, setDepartments] = useState<Department[]>([])
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<number | null>(
    () => savedOrgUi.selectedDepartmentId,
  )
  const [members, setMembers] = useState<DepartmentMember[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [positions, setPositions] = useState<JobPosition[]>([])
  const [teamRoles, setTeamRoles] = useState<TeamRole[]>([])
  const [expertiseDirections, setExpertiseDirections] = useState<ExpertiseDirection[]>([])
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([])
  const [orgChart, setOrgChart] = useState<OrgChartData | null>(null)
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
  const [cardEmployeeRef, setCardEmployeeRef] = useState<string | null>(null)
  const [cardDepartmentId, setCardDepartmentId] = useState<number | null>(null)
  const [expertiseDirectionId, setExpertiseDirectionId] = useState('')
  const [expertiseLevel, setExpertiseLevel] = useState('')
  const [employeeDepartmentIds, setEmployeeDepartmentIds] = useState<number[]>([])
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null)
  const [savingEmployee, setSavingEmployee] = useState(false)
  const [employeeOfficeYear, setEmployeeOfficeYear] = useState(savedOrgUi.workspaceYear)
  const [employeeOfficeMonth, setEmployeeOfficeMonth] = useState(savedOrgUi.workspaceMonth)
  const [employeeOfficeDays, setEmployeeOfficeDays] = useState<OfficeDay[]>([])
  const [loadingEmployeeOfficeDays, setLoadingEmployeeOfficeDays] = useState(false)
  const [savingEmployeeOfficeDay, setSavingEmployeeOfficeDay] = useState<string | null>(null)
  const [rosterNamePrefix, setRosterNamePrefix] = useState('')
  const [rosterManagerFilter, setRosterManagerFilter] = useState('')
  const [rosterNameSort, setRosterNameSort] = useState<'asc' | 'desc'>('asc')
  const [activeRosterFilter, setActiveRosterFilter] = useState<'name' | 'manager' | 'department' | null>(
    null,
  )
  const [rosterDepartmentFilter, setRosterDepartmentFilter] = useState('')
  const photoInputRef = useRef<HTMLInputElement>(null)
  const userPickedAllCompany = useRef(savedOrgUi.allCompany)

  const openDepartmentCard = (departmentId: number) => setCardDepartmentId(departmentId)
  const closeDepartmentCard = () => setCardDepartmentId(null)

  const isAllCompanyView = selectedDepartmentId === null && userPickedAllCompany.current

  const selectedDepartment = useMemo(
    () => departments.find((d) => d.id === selectedDepartmentId) ?? null,
    [departments, selectedDepartmentId],
  )
  const cardDepartment = useMemo(
    () => departments.find((dept) => dept.id === cardDepartmentId) ?? null,
    [departments, cardDepartmentId],
  )

  const positionNames = useMemo(() => positions.map((p) => p.name), [positions])

  const employeeById = useMemo(() => {
    const map = new Map<number, Employee>()
    for (const emp of employees) map.set(emp.id, emp)
    return map
  }, [employees])

  const openEmployeeCard = (employeeRef: string) => setCardEmployeeRef(employeeRef)
  const openEmployeeCardById = (employeeId: number) => {
    setCardEmployeeRef(employeeApiRefFromId(employeeById, employeeId))
  }
  const closeEmployeeCard = () => setCardEmployeeRef(null)
  const cardDepartmentEmployees = useMemo(() => {
    if (cardDepartmentId === null) return []
    return employees
      .filter((employee) =>
        employee.departments.some((department) => department.departmentId === cardDepartmentId),
      )
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'ru'))
  }, [employees, cardDepartmentId])
  const cardDepartmentHead = useMemo(() => {
    if (!cardDepartment?.headEmployeeId) return null
    return employeeById.get(cardDepartment.headEmployeeId) ?? null
  }, [cardDepartment, employeeById])

  const editingEmployee = useMemo(
    () => (editingEmployeeId ? employeeById.get(editingEmployeeId) ?? null : null),
    [editingEmployeeId, employeeById],
  )
  const employeeOfficeMonthDays = useMemo(
    () => getMonthDays(employeeOfficeYear, employeeOfficeMonth),
    [employeeOfficeYear, employeeOfficeMonth],
  )
  const employeeOfficeHolidayKeys = useMemo(
    () => buildHolidayKeySet(employeeOfficeYear),
    [employeeOfficeYear],
  )
  const employeeOfficeDaySet = useMemo(
    () => new Set(employeeOfficeDays.map((item) => item.day)),
    [employeeOfficeDays],
  )

  useEffect(() => {
    saveOrgUiState({
      panel,
      selectedDepartmentId: userPickedAllCompany.current ? null : selectedDepartmentId,
      allCompany: userPickedAllCompany.current,
    })
  }, [panel, selectedDepartmentId])

  const loadBase = useCallback(async () => {
    try {
      const [deptData, empData, posData, roleData, dirData, optData] = await Promise.all([
        getJson<Department[]>('/api/org/departments'),
        getJson<Employee[]>('/api/org/employees'),
        getJson<JobPosition[]>('/api/org/job-positions'),
        getJson<TeamRole[]>('/api/org/team-roles'),
        getJson<ExpertiseDirection[]>('/api/org/expertise-directions'),
        getJson<EmployeeOption[]>('/api/org/employee-options'),
      ])
      setDepartments(deptData)
      setEmployees(empData)
      setPositions(posData)
      setTeamRoles(roleData)
      setExpertiseDirections(dirData)
      setEmployeeOptions(optData)
      setSelectedDepartmentId((current) => {
        if (userPickedAllCompany.current) {
          return null
        }
        if (current !== null) {
          return current
        }
        if (deptData.length === 0) {
          return null
        }
        return deptData[0].id
      })
    } catch (err) {
      notifyProblem(err, 'Ошибка загрузки')
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

  const loadEmployeeOfficeDays = useCallback(
    async (employeeId: number, year: number, month: number) => {
      if (!canManage) return
      setLoadingEmployeeOfficeDays(true)
      try {
        const query = new URLSearchParams({
          year: String(year),
          month: String(month + 1),
        })
        const response = await getJson<OfficeDay[]>(
          `/api/org/employees/${employeeApiRefFromId(employeeById, employeeId)}/office-days?${query.toString()}`,
        )
        setEmployeeOfficeDays(response)
      } catch (err) {
        notifyProblem(err, 'Ошибка загрузки дней офиса')
      } finally {
        setLoadingEmployeeOfficeDays(false)
      }
    },
    [canManage],
  )

  useEffect(() => {
    void loadBase()
  }, [loadBase])

  useEffect(() => {
    if (!activeRosterFilter) return
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest('.org-th-filter')) return
      setActiveRosterFilter(null)
    }
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveRosterFilter(null)
      }
    }
    document.addEventListener('mousedown', handleDocumentMouseDown)
    document.addEventListener('keydown', handleDocumentKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown)
      document.removeEventListener('keydown', handleDocumentKeyDown)
    }
  }, [activeRosterFilter])

  useEffect(() => {
    if (panel === 'roster' && selectedDepartmentId !== null) {
      void loadMembers(selectedDepartmentId).catch((err) =>
        notifyProblem(err, 'Ошибка')
      )
    }
    if (panel === 'pyramid') {
      void loadChart(selectedDepartmentId).catch((err) =>
        notifyProblem(err, 'Ошибка')
      )
    }
  }, [panel, selectedDepartmentId, loadMembers, loadChart])

  useEffect(() => {
    setRosterNamePrefix('')
    setRosterManagerFilter('')
    setRosterDepartmentFilter('')
    setRosterNameSort('asc')
  }, [selectedDepartmentId, isAllCompanyView])

  const rosterRows = useMemo(() => {
    const baseRows = isAllCompanyView
      ? employees.map((emp) => ({
          key: `emp-${emp.id}`,
          employeeId: emp.id,
          fullName: emp.fullName,
          photoUrl: emp.photoUrl,
          secondary: formatDepartments(emp.departments),
          position: emp.position ?? '—',
          managerName: emp.managerName ?? '—',
          email: emp.email ?? '—',
          dailyWorkHours: String(emp.dailyWorkHours),
          expertise: formatExpertises(emp.expertises),
          memberId: null as number | null,
        }))
      : members.map((member) => {
          const emp = employeeById.get(member.employeeId)
          return {
            key: `member-${member.id}`,
            employeeId: member.employeeId,
            fullName: member.employeeName,
            photoUrl: member.photoUrl ?? emp?.photoUrl,
            secondary: member.teamRoleName ?? '—',
            position: member.displayPosition ?? '—',
            managerName: member.managerName ?? '—',
            email: member.displayEmail ?? emp?.email ?? '—',
            dailyWorkHours: String(emp?.dailyWorkHours ?? '—'),
            expertise: formatExpertises(emp?.expertises),
            memberId: member.id,
          }
        })

    const normalizedPrefix = rosterNamePrefix.trim().toLowerCase()
    return baseRows
      .filter((row) =>
        normalizedPrefix
          ? row.fullName.trim().toLowerCase().startsWith(normalizedPrefix)
          : true,
      )
      .filter((row) => (rosterManagerFilter ? row.managerName === rosterManagerFilter : true))
      .filter((row) => {
        if (!isAllCompanyView || !rosterDepartmentFilter) return true
        if (rosterDepartmentFilter === '__without_department__') {
          return row.secondary === '—'
        }
        return row.secondary === rosterDepartmentFilter
      })
      .sort((a, b) => {
        const cmp = a.fullName.localeCompare(b.fullName, 'ru')
        return rosterNameSort === 'asc' ? cmp : -cmp
      })
  }, [
    isAllCompanyView,
    employees,
    members,
    employeeById,
    rosterNamePrefix,
    rosterManagerFilter,
    rosterDepartmentFilter,
    rosterNameSort,
  ])

  const rosterNamePrefixOptions = useMemo(() => {
    const options = new Set<string>()
    for (const row of rosterRows) {
      const letter = row.fullName.trim().charAt(0).toUpperCase()
      if (letter) options.add(letter)
    }
    return [...options].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [rosterRows])

  const rosterManagerOptions = useMemo(() => {
    const options = new Set<string>()
    for (const row of rosterRows) {
      if (row.managerName !== '—') {
        options.add(row.managerName)
      }
    }
    return [...options].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [rosterRows])

  const rosterDepartmentOptions = useMemo(() => {
    if (!isAllCompanyView) return []
    const options = new Set<string>()
    for (const employee of employees) {
      for (const department of employee.departments) {
        if (department.departmentName) {
          options.add(department.departmentName)
        }
      }
    }
    return [...options].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [isAllCompanyView, employees])

  const hasEmployeesWithoutDepartment = useMemo(
    () => isAllCompanyView && employees.some((employee) => employee.departments.length === 0),
    [isAllCompanyView, employees],
  )

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
    setEmployeeOfficeDays([])
    setSavingEmployeeOfficeDay(null)
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
    setEmployeeDepartmentIds([])
    setExpertiseDirectionId('')
    setExpertiseLevel('')
    setEmployeeOfficeDays([])
    resetPhotoState()
    setShowEmployeeModal(true)
  }

  const openEditEmployee = (emp: Employee | EmployeeDetail) => {
    setEditingEmployeeId(emp.id)
    setExpertiseDirectionId('')
    setExpertiseLevel('')
    const departmentIds = new Set(emp.departments.map((item) => item.departmentId))
    if ('headedDepartments' in emp) {
      for (const dept of emp.headedDepartments) {
        departmentIds.add(dept.id)
      }
    }
    setEmployeeDepartmentIds([...departmentIds])
    setEmployeeOfficeYear(savedOrgUi.workspaceYear)
    setEmployeeOfficeMonth(savedOrgUi.workspaceMonth)
    void loadEmployeeOfficeDays(emp.id, savedOrgUi.workspaceYear, savedOrgUi.workspaceMonth)
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

  const toggleEmployeeOfficeDay = async (day: string) => {
    if (!canManage || !editingEmployeeId || savingEmployeeOfficeDay) return
    const present = !employeeOfficeDaySet.has(day)
    setSavingEmployeeOfficeDay(day)
    try {
      await putJson(`/api/org/employees/${employeeApiRefFromId(employeeById, editingEmployeeId)}/office-days/range`, {
        fromDay: day,
        toDay: day,
        present,
      })
      await loadEmployeeOfficeDays(editingEmployeeId, employeeOfficeYear, employeeOfficeMonth)
    } catch (err) {
      notifyProblem(err, 'Ошибка сохранения дней офиса')
    } finally {
      setSavingEmployeeOfficeDay(null)
    }
  }

  useEffect(() => {
    if (!showEmployeeModal || !editingEmployeeId || !canManage) return
    void loadEmployeeOfficeDays(editingEmployeeId, employeeOfficeYear, employeeOfficeMonth)
  }, [
    showEmployeeModal,
    editingEmployeeId,
    canManage,
    employeeOfficeYear,
    employeeOfficeMonth,
    loadEmployeeOfficeDays,
  ])

  const uploadEmployeePhoto = async (employeeId: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    await postForm(`/api/org/employees/${employeeApiRefFromId(employeeById, employeeId)}/photo`, form)
  }

  const saveEmployee = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canManage || savingEmployee) return
    const body = {
      fullName: employeeForm.fullName.trim(),
      email: employeeForm.email.trim() || null,
      positionId: employeeForm.positionId ? Number(employeeForm.positionId) : null,
      managerId: employeeForm.managerId ? Number(employeeForm.managerId) : null,
      dailyWorkHours: Number(employeeForm.dailyWorkHours),
      isActive: employeeForm.isActive,
      isOrganizationHead: employeeForm.isOrganizationHead,
      createUserAccount: true,
      userPassword: '12345678',
      userIsAdmin: employeeForm.userIsAdmin,
      departmentIds: employeeDepartmentIds,
    }
    setSavingEmployee(true)
    try {
      let employeeId = editingEmployeeId
      if (editingEmployeeId) {
        await patchJson(`/api/org/employees/${employeeApiRefFromId(employeeById, editingEmployeeId)}`, {
          fullName: body.fullName,
          email: body.email,
          positionId: body.positionId,
          managerId: body.managerId,
          dailyWorkHours: body.dailyWorkHours,
          isActive: body.isActive,
          isOrganizationHead: body.isOrganizationHead,
          userIsAdmin: body.userIsAdmin,
          userPassword: body.userPassword,
          departmentIds: body.departmentIds,
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
      notifyProblem(err, 'Ошибка сохранения сотрудника')
    } finally {
      setSavingEmployee(false)
    }
  }

  const removeEmployee = async (id: number) => {
    if (!canManage || !window.confirm('Удалить сотрудника?')) return
    try {
      await deleteJson(`/api/org/employees/${employeeApiRefFromId(employeeById, id)}`)
      await refreshAll()
    } catch (err) {
      notifyProblem(err, 'Ошибка удаления')
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
      notifyProblem(err, 'Ошибка сохранения отдела')
    }
  }

  const removeDepartment = async (id: number) => {
    if (!canManage || !window.confirm('Удалить отдел?')) return
    try {
      await deleteJson(`/api/org/departments/${id}`)
      if (selectedDepartmentId === id) setSelectedDepartmentId(null)
      await refreshAll()
    } catch (err) {
      notifyProblem(err, 'Ошибка удаления')
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
      notifyProblem(err, 'Ошибка сохранения участника')
    }
  }

  const removeMember = async (memberId: number) => {
    if (!canManage || selectedDepartmentId === null || !window.confirm('Удалить из состава?')) return
    try {
      await deleteJson(`/api/org/departments/${selectedDepartmentId}/members/${memberId}`)
      await loadMembers(selectedDepartmentId)
      await loadBase()
    } catch (err) {
      notifyProblem(err, 'Ошибка удаления')
    }
  }

  const addPosition = async () => {
    const name = window.prompt('Название должности')
    if (!name?.trim() || !canManage) return
    try {
      await postJson('/api/org/job-positions', { name: name.trim() })
      await loadBase()
    } catch (err) {
      notifyProblem(err, 'Ошибка')
    }
  }

  const addExpertiseDirection = async () => {
    const name = window.prompt('Название направления экспертизы')
    if (!name?.trim() || !canManage) return
    try {
      await postJson('/api/org/expertise-directions', { name: name.trim() })
      await loadBase()
    } catch (err) {
      notifyProblem(err, 'Ошибка')
    }
  }

  const addEmployeeExpertise = async () => {
    if (!editingEmployeeId || !expertiseDirectionId || !canManage) return
    try {
      await postJson(`/api/org/employees/${employeeApiRefFromId(employeeById, editingEmployeeId)}/expertise`, {
        expertiseDirectionId: Number(expertiseDirectionId),
        level: expertiseLevel.trim() || null,
      })
      setExpertiseDirectionId('')
      setExpertiseLevel('')
      await loadBase()
    } catch (err) {
      notifyProblem(err, 'Ошибка добавления экспертизы')
    }
  }

  const toggleRosterFilter = (filter: 'name' | 'manager' | 'department') => {
    setActiveRosterFilter((value) => (value === filter ? null : filter))
  }

  const removeEmployeeExpertise = async (expertiseId: number) => {
    if (!editingEmployeeId || !canManage) return
    if (!window.confirm('Удалить экспертизу?')) return
    try {
      await deleteJson(
        `/api/org/employees/${employeeApiRefFromId(employeeById, editingEmployeeId)}/expertise/${expertiseId}`,
      )
      await loadBase()
    } catch (err) {
      notifyProblem(err, 'Ошибка удаления экспертизы')
    }
  }

  return (
    <div className={`org-page${panel === 'pyramid' ? ' org-page-pyramid' : ''}`}>
      <nav className="org-subtabs" aria-label="Разделы отделов">
        {(
          [
            ['vacations', 'График отпусков'],
            ['workspace', 'Бронь мест'],
            ['office_presence', 'Сотрудники в офисе'],
            ['roster', 'Состав'],
            ['pyramid', 'Пирамида'],
            ['employees', 'Сотрудники'],
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

      {panel === 'roster' || panel === 'pyramid' ? (
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

      {loading ? <p>Обновление…</p> : null}

      {panel === 'roster' ? (
        <section className="org-panel">
          <div className="org-panel-toolbar">
            <h2>{selectedDepartment?.name ?? (isAllCompanyView ? 'Вся компания' : 'Выберите отдел')}</h2>
            {canManage && selectedDepartmentId !== null ? (
              <button type="button" className="btn-primary" onClick={openCreateMember}>
                + Участник
              </button>
            ) : null}
          </div>
          {selectedDepartmentId === null && !isAllCompanyView ? (
            <p className="org-hint">Выберите отдел для просмотра состава.</p>
          ) : (
            <table className="org-table">
              <thead>
                <tr>
                  <th>
                    <div className="org-th-filter">
                      <div className="org-th-filter-head">
                        <span>ФИО</span>
                        <button
                          type="button"
                          className={[
                            'org-th-filter-icon-btn',
                            activeRosterFilter === 'name' || rosterNamePrefix ? ' org-th-filter-icon-btn-active' : '',
                          ].join('')}
                          aria-label="Открыть фильтр ФИО"
                          aria-expanded={activeRosterFilter === 'name'}
                          onClick={() => toggleRosterFilter('name')}
                        >
                          <OrgFilterIcon />
                        </button>
                      </div>
                      {activeRosterFilter === 'name' ? (
                        <div className="org-th-filter-popover">
                          <div className="org-th-filter-controls">
                            <select
                              value={rosterNamePrefix}
                              onChange={(e) => setRosterNamePrefix(e.target.value)}
                              aria-label="Фильтр ФИО по букве"
                            >
                              <option value="">Все</option>
                              {rosterNamePrefixOptions.map((letter) => (
                                <option key={letter} value={letter}>
                                  {letter}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="btn-ghost org-th-sort-btn"
                              onClick={() =>
                                setRosterNameSort((value) => (value === 'asc' ? 'desc' : 'asc'))
                              }
                              title={rosterNameSort === 'asc' ? 'Сортировка А-Я' : 'Сортировка Я-А'}
                            >
                              {rosterNameSort === 'asc' ? 'А-Я' : 'Я-А'}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </th>
                  <th>
                    {isAllCompanyView ? (
                      <div className="org-th-filter">
                        <div className="org-th-filter-head">
                          <span>Отдел</span>
                          <button
                            type="button"
                            className={[
                              'org-th-filter-icon-btn',
                              activeRosterFilter === 'department' || rosterDepartmentFilter
                                ? ' org-th-filter-icon-btn-active'
                                : '',
                            ].join('')}
                            aria-label="Открыть фильтр отдела"
                            aria-expanded={activeRosterFilter === 'department'}
                            onClick={() => toggleRosterFilter('department')}
                          >
                            <OrgFilterIcon />
                          </button>
                        </div>
                        {activeRosterFilter === 'department' ? (
                          <div className="org-th-filter-popover">
                            <div className="org-th-filter-controls">
                              <select
                                value={rosterDepartmentFilter}
                                onChange={(e) => setRosterDepartmentFilter(e.target.value)}
                                aria-label="Фильтр по отделу"
                              >
                                <option value="">Все</option>
                                {hasEmployeesWithoutDepartment ? (
                                  <option value="__without_department__">Без отдела</option>
                                ) : null}
                                {rosterDepartmentOptions.map((department) => (
                                  <option key={department} value={department}>
                                    {department}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      'Роль'
                    )}
                  </th>
                  <th>Должность</th>
                  <th>
                    <div className="org-th-filter">
                      <div className="org-th-filter-head">
                        <span>Руководитель</span>
                        <button
                          type="button"
                          className={[
                            'org-th-filter-icon-btn',
                            activeRosterFilter === 'manager' || rosterManagerFilter
                              ? ' org-th-filter-icon-btn-active'
                              : '',
                          ].join('')}
                          aria-label="Открыть фильтр руководителя"
                          aria-expanded={activeRosterFilter === 'manager'}
                          onClick={() => toggleRosterFilter('manager')}
                        >
                          <OrgFilterIcon />
                        </button>
                      </div>
                      {activeRosterFilter === 'manager' ? (
                        <div className="org-th-filter-popover">
                          <div className="org-th-filter-controls">
                            <select
                              value={rosterManagerFilter}
                              onChange={(e) => setRosterManagerFilter(e.target.value)}
                              aria-label="Фильтр по руководителю"
                            >
                              <option value="">Все</option>
                              {rosterManagerOptions.map((manager) => (
                                <option key={manager} value={manager}>
                                  {manager}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </th>
                  <th>Email</th>
                  <th>Рабочих часов в день</th>
                  <th>Экспертиза</th>
                  {canManage && !isAllCompanyView ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {rosterRows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <PersonCell
                        employeeId={row.employeeId}
                        name={row.fullName}
                        photoUrl={row.photoUrl}
                        onOpen={openEmployeeCardById}
                      />
                    </td>
                    <td>{row.secondary}</td>
                    <td>{row.position}</td>
                    <td>{row.managerName}</td>
                    <td>{row.email}</td>
                    <td>{row.dailyWorkHours}</td>
                    <td>{row.expertise}</td>
                    {canManage && !isAllCompanyView ? (
                      <td className="org-table-actions">
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            const member = members.find((item) => item.id === row.memberId)
                            if (member) openEditMember(member)
                          }}
                        >
                          Изм.
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            if (row.memberId != null) void removeMember(row.memberId)
                          }}
                        >
                          ✕
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {panel === 'pyramid' ? (
        <section className="org-panel org-panel-pyramid">
          <OrgChartCanvas>
            {selectedDepartmentId === null ? (
              <OrgChartView
                organizationHead={orgChart?.organizationHead}
                departments={orgChart?.departments ?? []}
                standaloneRoots={orgChart?.standaloneRoots ?? []}
                canManage={canManage}
                onEmployeeClick={openEmployeeCard}
                onDepartmentClick={openDepartmentCard}
              />
            ) : (
              <OrgChartView
                roots={orgChart?.departmentTree ?? []}
                departmentName={selectedDepartment?.name}
                departmentId={selectedDepartmentId}
                framed
                onEmployeeClick={openEmployeeCard}
                onDepartmentClick={openDepartmentCard}
              />
            )}
          </OrgChartCanvas>
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
                <th>Отделы</th>
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
                    <PersonCell
                      employeeId={emp.id}
                      name={emp.fullName}
                      photoUrl={emp.photoUrl}
                      onOpen={openEmployeeCardById}
                    />
                  </td>
                  <td>{emp.position ?? '—'}</td>
                  <td>{formatDepartments(emp.departments)}</td>
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
        <VacationSchedule orgEmployeeId={orgEmployeeId} canManage={canManage} />
      ) : null}

      {panel === 'workspace' ? <WorkspaceBooking orgEmployeeId={orgEmployeeId} /> : null}

      {panel === 'office_presence' ? <OfficePresence /> : null}

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
                  <OrgPhoto
                    url={photoPreviewUrl}
                    name={employeeForm.fullName}
                    className="org-employee-photo-preview-img"
                    placeholderClassName="org-employee-photo-preview org-employee-photo-placeholder"
                  />
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

                <section className="org-form-section">
                  <h4>Отдел</h4>
                  {departments.filter((dept) => dept.isActive).length > 0 ? (
                    <label>
                      <select
                        value={employeeDepartmentIds[0] ?? ''}
                        onChange={(e) => {
                          const value = e.target.value
                          setEmployeeDepartmentIds(value ? [Number(value)] : [])
                        }}
                      >
                        <option value="">— не выбран —</option>
                        {departments
                          .filter((dept) => dept.isActive)
                          .map((dept) => (
                            <option key={dept.id} value={dept.id}>
                              {dept.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  ) : (
                    <p className="org-hint">Сначала создайте отдел во вкладке «Управление».</p>
                  )}
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

                {editingEmployeeId && canManage ? (
                  <section className="org-form-section">
                    <div className="org-form-section-header">
                      <h4>Дни в офисе (без места)</h4>
                    </div>
                    <div className="org-vacation-toolbar-left">
                      <div className="org-vacation-year-picker" role="group" aria-label="Год">
                        {[new Date().getFullYear() - 1, new Date().getFullYear(), new Date().getFullYear() + 1].map(
                          (y) => (
                            <button
                              key={y}
                              type="button"
                              className={`org-vacation-year-btn${employeeOfficeYear === y ? ' org-vacation-year-btn-active' : ''}`}
                              onClick={() => setEmployeeOfficeYear(y)}
                              aria-pressed={employeeOfficeYear === y}
                            >
                              {y}
                            </button>
                          ),
                        )}
                      </div>
                      <label className="org-workspace-month-picker">
                        <span className="org-workspace-month-label">Месяц</span>
                        <select
                          className="org-workspace-month-select"
                          value={employeeOfficeMonth}
                          onChange={(e) => setEmployeeOfficeMonth(Number(e.target.value))}
                        >
                          {MONTH_NAMES_FULL.map((label, index) => (
                            <option key={label} value={index}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="org-hint">
                      Администратор может проставить сотруднику дни присутствия в офисе без брони места.
                    </p>
                    {loadingEmployeeOfficeDays ? <p className="org-hint">Загрузка…</p> : null}
                    <div className="org-profile-office-grid">
                      {employeeOfficeMonthDays.map((dayDate) => {
                        const day = toDayKey(dayDate)
                        const isMarked = employeeOfficeDaySet.has(day)
                        const isWeekend = isWeekendDay(dayDate) || employeeOfficeHolidayKeys.has(day)
                        return (
                          <button
                            key={day}
                            type="button"
                            className={[
                              'org-profile-office-day',
                              isMarked ? 'org-profile-office-day-active' : '',
                              isWeekend ? 'org-profile-office-day-weekend' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            title={`${WEEKDAY_NAMES[dayDate.getDay()]} ${dayDate.getDate()} ${MONTH_NAMES_FULL[
                              dayDate.getMonth()
                            ].toLowerCase()}`}
                            disabled={savingEmployeeOfficeDay === day}
                            onClick={() => void toggleEmployeeOfficeDay(day)}
                          >
                            <span>{dayDate.getDate()}</span>
                            <small>{WEEKDAY_NAMES[dayDate.getDay()]}</small>
                          </button>
                        )
                      })}
                    </div>
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
                    <p className="org-hint">
                      Учётная запись создаётся автоматически. Стартовый пароль: <strong>12345678</strong>.
                    </p>
                    <label className="org-checkbox">
                      <input
                        type="checkbox"
                        checked={employeeForm.userIsAdmin}
                        onChange={(e) =>
                          setEmployeeForm({ ...employeeForm, userIsAdmin: e.target.checked })
                        }
                      />
                      Администратор
                    </label>
                  </section>
                ) : editingEmployee ? (
                  <section className="org-form-section">
                    <h4>Учётная запись</h4>
                    <p className="org-hint org-account-email">
                      {editingEmployee.user
                        ? editingEmployee.user.email
                        : employeeForm.email.trim()
                          ? `Учётная запись пока не создана. Будет создана с email ${employeeForm.email.trim()} при сохранении пароля.`
                          : 'Учётная запись пока не создана. Чтобы задать пароль, укажите email сотрудника.'}
                    </p>
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
                        Новый пароль (сброс)
                        <div className="org-password-reset-actions">
                          <input
                            type="password"
                            placeholder="Необязательно"
                            value={employeeForm.userPassword}
                            onChange={(e) =>
                              setEmployeeForm({ ...employeeForm, userPassword: e.target.value })
                            }
                          />
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => setEmployeeForm({ ...employeeForm, userPassword: '12345678' })}
                          >
                            Сбросить на 12345678
                          </button>
                        </div>
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

      {cardEmployeeRef !== null ? (
        <EmployeeCardModal
          employeeRef={cardEmployeeRef}
          canManage={canManage}
          onClose={closeEmployeeCard}
          onOpenEmployee={(employeeRef) => setCardEmployeeRef(employeeRef)}
          onEdit={(employee: EmployeeDetail) => {
            closeEmployeeCard()
            openEditEmployee(employee)
          }}
        />
      ) : null}

      {cardDepartment !== null ? (
        <div className="org-modal-backdrop" onClick={closeDepartmentCard}>
          <div className="org-modal org-department-card-modal" onClick={(e) => e.stopPropagation()}>
            <header className="org-modal-header">
              <h3>{cardDepartment.name}</h3>
              <button type="button" className="btn-ghost" onClick={closeDepartmentCard} aria-label="Закрыть">
                ✕
              </button>
            </header>
            <div className="org-department-card-grid">
              <section className="org-department-card-section">
                <h4>Описание</h4>
                <p className="org-hint">
                  {cardDepartment.description?.trim() ? cardDepartment.description : 'Описание не заполнено.'}
                </p>
              </section>

              <section className="org-department-card-section">
                <h4>Руководитель</h4>
                {cardDepartmentHead ? (
                  <button
                    type="button"
                    className="org-department-card-person"
                    onClick={() => {
                      closeDepartmentCard()
                      openEmployeeCardById(cardDepartmentHead.id)
                    }}
                  >
                    <OrgPhoto
                      url={cardDepartmentHead.photoUrl}
                      name={cardDepartmentHead.fullName}
                      className="org-table-avatar-img"
                      placeholderClassName="org-table-avatar"
                    />
                    <span>{cardDepartmentHead.fullName}</span>
                  </button>
                ) : (
                  <p className="org-hint">{cardDepartment.headEmployeeName ?? 'Не назначен.'}</p>
                )}
              </section>

              <section className="org-department-card-section">
                <h4>Сотрудники ({cardDepartmentEmployees.length})</h4>
                {cardDepartmentEmployees.length > 0 ? (
                  <ul className="org-department-card-members">
                    {cardDepartmentEmployees.map((employee) => (
                      <li key={employee.id}>
                        <button
                          type="button"
                          className="org-department-card-person"
                          onClick={() => {
                            closeDepartmentCard()
                            openEmployeeCard(employeeApiRef(employee))
                          }}
                        >
                          <OrgPhoto
                            url={employee.photoUrl}
                            name={employee.fullName}
                            className="org-table-avatar-img"
                            placeholderClassName="org-table-avatar"
                          />
                          <span>{employee.fullName}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="org-hint">Нет сотрудников в этом отделе.</p>
                )}
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
