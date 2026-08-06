export type PlanningComplexity = {
  id: number
  name: string
  sortOrder: number
  isActive: boolean
}

export type PlanningCustomerDepartment = {
  id: number
  name: string
  sortOrder: number
  isActive: boolean
}

export type PlanningExecutor = {
  id: number
  fullName: string
  fromAllocation?: boolean
}

export type PlanningProjectStatus = 'new' | 'in_progress' | 'completed'

export type PlanningProject = {
  id: number
  requestNumber: string
  requestName: string
  requestUrl?: string | null
  complexityId?: number | null
  complexityName?: string | null
  executorIds?: number[]
  executors?: PlanningExecutor[]
  customerEmployeeId?: number | null
  customerEmployeeName?: string | null
  customerName?: string | null
  customerDepartmentId?: number | null
  customerDepartmentName?: string | null
  plannedStartDate?: string | null
  actualStartDate?: string | null
  plannedEndDate?: string | null
  actualEndDate?: string | null
  status?: PlanningProjectStatus
  notes?: string | null
  createdByLabel?: string | null
  createdAt?: string | null
  allocationCount: number
  totalPlannedHours: number
  totalActualHours: number
}

export type PlanningAllocationDay = {
  day: string
  plannedHours: number
  actualHours: number
}

export type PlanningAllocation = {
  id: number
  projectId: number
  employeeId: number
  employeeName: string
  employeeExpertises: string[]
  allocationStartDate: string
  allocationEndDate: string
  bookingMode: 'daily' | 'period'
  plannedHoursPerDay?: number | null
  createdByLabel?: string | null
  totalPlannedHours: number
  totalActualHours: number
  days: PlanningAllocationDay[]
}

export type PlanningWorkloadAllocationCell = {
  allocationId: number
  projectId: number
  requestNumber: string
  requestName: string
  plannedHours: number
  actualHours: number
}

export type PlanningWorkloadDayCell = {
  capacityHours: number
  plannedHours: number
  actualHours: number
  availableHours: number
  isWorkingDay: boolean
  timeOffKind?: string | null
  allocations: PlanningWorkloadAllocationCell[]
}

export type PlanningWorkloadEmployee = {
  id: number
  fullName: string
  dailyWorkHours: number
  expertises: string[]
  departmentNames: string[]
  days: Record<string, PlanningWorkloadDayCell>
}

export type PlanningWorkload = {
  dateFrom: string
  dateTo: string
  days: string[]
  employees: PlanningWorkloadEmployee[]
}

export type PlanningPanelId = 'projects' | 'allocations' | 'workload' | 'directories'

export type WorkloadViewMode = 'summary' | 'byProject'
