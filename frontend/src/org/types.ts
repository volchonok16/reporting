export type OrgChartPerson = {
  employeeId: number
  publicId: string
  fullName: string
  position?: string | null
  email?: string | null
  photoUrl?: string | null
  teamRole?: string | null
  isHead?: boolean
}

export type OrgChartNode = {
  memberId?: number | null
  person: OrgChartPerson
  children: OrgChartNode[]
}

export type DepartmentBlock = {
  departmentId: number
  departmentName: string
  headEmployeeId?: number | null
  roots: OrgChartNode[]
  nestedDepartments?: DepartmentBlock[]
}

export type OrgChartData = {
  organizationHead?: OrgChartNode | null
  departments?: DepartmentBlock[]
  standaloneRoots?: OrgChartNode[]
  departmentTree?: OrgChartNode[]
}

export type OrgChartLayoutNodeKind = 'employee' | 'department'

export type OrgChartLayoutNode = {
  id: string
  kind: OrgChartLayoutNodeKind
  refId: number
  parentNodeId?: string | null
  x: number
  y: number
  width: number
  height: number
}

export type OrgChartLayoutEdge = {
  id: string
  fromNodeId: string
  toNodeId: string
  fromAnchor?: 'top' | 'bottom'
  toAnchor?: 'top' | 'bottom'
  manual?: boolean
  points?: Array<{ x: number; y: number }>
}

export type OrgChartLayoutData = {
  nodes: OrgChartLayoutNode[]
  edges: OrgChartLayoutEdge[]
}

export type OrgChartLayout = {
  scope: 'company' | 'department'
  departmentId?: number | null
  layout: OrgChartLayoutData
}

export type JobPosition = {
  id: number
  name: string
  sortOrder: number
  isActive: boolean
}

export type TeamRole = {
  id: number
  name: string
  sortOrder: number
  isActive: boolean
}

export type ExpertiseDirection = {
  id: number
  name: string
  description?: string | null
  sortOrder: number
  isActive: boolean
}

export type EmployeeExpertise = {
  id: number
  directionId: number
  directionName: string
  level?: string | null
}

export type OrgUserBrief = {
  id: number
  email: string
  role: 'user' | 'admin'
  status: 'active' | 'inactive' | 'deleted'
}

export type Employee = {
  id: number
  publicId: string
  fullName: string
  email?: string | null
  positionId?: number | null
  position?: string | null
  managerId?: number | null
  managerName?: string | null
  managerPublicId?: string | null
  photoUrl?: string | null
  dailyWorkHours: number
  isActive: boolean
  isOrganizationHead: boolean
  user?: OrgUserBrief | null
  expertises: EmployeeExpertise[]
  departments: EmployeeDepartmentBrief[]
}

export type EmployeeBrief = {
  id: number
  publicId: string
  fullName: string
  position?: string | null
}

export type EmployeeDepartmentBrief = {
  departmentId: number
  departmentName: string
}

export type EmployeeDepartmentMembership = EmployeeDepartmentBrief & {
  teamRoleName?: string | null
  displayPosition?: string | null
  managerName?: string | null
  displayEmail?: string | null
}

export type EmployeeHeadedDepartment = {
  id: number
  name: string
}

export type EmployeeDetail = Omit<Employee, 'departments'> & {
  subordinates: EmployeeBrief[]
  departments: EmployeeDepartmentMembership[]
  headedDepartments: EmployeeHeadedDepartment[]
}

export type Department = {
  id: number
  name: string
  description?: string | null
  headEmployeeId?: number | null
  headEmployeeName?: string | null
  sortOrder: number
  isActive: boolean
  memberCount: number
}

export type DepartmentMember = {
  id: number
  departmentId: number
  employeeId: number
  employeePublicId: string
  employeeName: string
  teamRoleId?: number | null
  teamRoleName?: string | null
  position?: string | null
  displayPosition?: string | null
  managerId?: number | null
  managerName?: string | null
  email?: string | null
  displayEmail?: string | null
  sortOrder: number
  photoUrl?: string | null
}

export type ProfileData = {
  email: string
  role: 'user' | 'admin' | 'full' | 'roadmap'
  employee?: Employee | null
}

export type SelectOption = {
  id: number
  name: string
}

export type EmployeeOption = {
  id: number
  publicId: string
  name: string
}

export type OrgPanel =
  | 'roster'
  | 'pyramid'
  | 'employees'
  | 'manage'
  | 'vacations'
  | 'workspace'
  | 'office_presence'

export type TimeOffKind = 'vacation' | 'dayoff' | 'sick_leave' | 'business_trip'
export type EditableTimeOffKind = TimeOffKind | 'erase'

export type VacationEmployee = {
  id: number
  publicId: string
  fullName: string
  departmentName?: string | null
  position?: string | null
  managerId?: number | null
  photoUrl?: string | null
  canEdit: boolean
  isSelf: boolean
}

export type VacationTimeOffDay = {
  employeeId: number
  day: string
  kind: TimeOffKind
}

export type OfficeDay = {
  employeeId: number
  day: string
}

export type VacationScheduleData = {
  year: number
  departmentId?: number | null
  actorEmployeeId?: number | null
  employees: VacationEmployee[]
  timeOffDays: VacationTimeOffDay[]
}

export type WorkspacePlace = {
  id: number
  name: string
  sortOrder: number
  isActive: boolean
}

export type WorkspaceBookingCell = {
  placeId: number
  day: string
  employeeId: number
  employeeName: string
  isSelf: boolean
  canRelease: boolean
}

export type WorkspaceBookingScheduleData = {
  year: number
  month?: number | null
  actorEmployeeId?: number | null
  isAdmin: boolean
  places: WorkspacePlace[]
  bookings: WorkspaceBookingCell[]
  employees: VacationEmployee[]
  timeOffDays: VacationTimeOffDay[]
}

export type WorkspacePresenceCell = {
  employeeId: number
  day: string
  placeId: number
  placeName: string
}

export type WorkspaceOfficePresenceData = {
  year: number
  month?: number | null
  employees: VacationEmployee[]
  presence: WorkspacePresenceCell[]
  officeDays: OfficeDay[]
  timeOffDays: VacationTimeOffDay[]
}
