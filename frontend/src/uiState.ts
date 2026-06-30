const STORAGE_KEY = 'reporting.uiState'

export type SheetId = 'zni' | 'product-status-b2b' | 'roadmap' | 'departments'

export type OrgPanelId = 'roster' | 'pyramid' | 'employees' | 'manage' | 'vacations' | 'workspace'

export type OrgUiState = {
  panel: OrgPanelId
  selectedDepartmentId: number | null
  allCompany: boolean
  vacationYear: number
}

export type RoadmapUiState = {
  year: number
  quarter: number
}

export type B2bPanelId = 'status' | 'news'

export type DashboardUiState = {
  boardCode: string
  search: string
  sort: string
  dateFrom: string
  dateTo: string
  statusFilter: string
  quarterFilter: string
  ectReservationFilter: string
  linkedEnvironmentFilter: boolean
  tagGroupFilter: string[]
  metricFilter: string
}

type UiState = {
  activeSheet?: SheetId
  dashboard?: Partial<DashboardUiState>
  roadmap?: Partial<RoadmapUiState>
  productStatusB2bGid?: string | null
  b2bNewsGid?: string | null
  b2bPanel?: B2bPanelId
  org?: Partial<OrgUiState>
}

function readUiState(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as UiState
  } catch {
    return {}
  }
}

function writeUiState(patch: UiState): void {
  const current = readUiState()
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }))
}

const WORKBOOK_SHEETS: SheetId[] = ['zni', 'product-status-b2b', 'roadmap', 'departments']

const ORG_PANELS: OrgPanelId[] = ['roster', 'pyramid', 'employees', 'manage', 'vacations', 'workspace']

export function loadActiveSheet(): SheetId {
  const sheet = readUiState().activeSheet as string | undefined
  if (sheet === 'b2b-news') {
    return 'product-status-b2b'
  }
  if (sheet === 'digital-plan') {
    return 'roadmap'
  }
  if (sheet && WORKBOOK_SHEETS.includes(sheet as SheetId)) {
    return sheet as SheetId
  }
  return 'zni'
}

export function saveActiveSheet(activeSheet: SheetId): void {
  writeUiState({ activeSheet })
}

export function loadOrgUiState(): OrgUiState {
  const org = readUiState().org
  const currentYear = new Date().getFullYear()
  const panel = org?.panel && ORG_PANELS.includes(org.panel) ? org.panel : 'roster'
  const allCompany = org?.allCompany === true
  const selectedDepartmentId =
    allCompany || org?.selectedDepartmentId === null || org?.selectedDepartmentId === undefined
      ? null
      : Number(org.selectedDepartmentId)
  const vacationYear =
    typeof org?.vacationYear === 'number' && org.vacationYear >= 2000 && org.vacationYear <= 2100
      ? org.vacationYear
      : currentYear
  return { panel, selectedDepartmentId, allCompany, vacationYear }
}

export function saveOrgUiState(patch: Partial<OrgUiState>): void {
  const current = loadOrgUiState()
  writeUiState({
    org: {
      panel: patch.panel ?? current.panel,
      selectedDepartmentId:
        patch.selectedDepartmentId !== undefined ? patch.selectedDepartmentId : current.selectedDepartmentId,
      allCompany: patch.allCompany !== undefined ? patch.allCompany : current.allCompany,
      vacationYear: patch.vacationYear ?? current.vacationYear,
    },
  })
}

export function loadDashboardUiState(): Partial<DashboardUiState> {
  return readUiState().dashboard ?? {}
}

export function saveDashboardUiState(state: DashboardUiState): void {
  writeUiState({ dashboard: state })
}

export function loadProductStatusB2bGid(): string | null {
  const gid = readUiState().productStatusB2bGid
  return typeof gid === 'string' && gid ? gid : null
}

export function saveProductStatusB2bGid(gid: string | null): void {
  writeUiState({ productStatusB2bGid: gid })
}

export function loadB2bNewsGid(): string | null {
  const gid = readUiState().b2bNewsGid
  return typeof gid === 'string' && gid ? gid : null
}

export function saveB2bNewsGid(gid: string | null): void {
  writeUiState({ b2bNewsGid: gid })
}

export function loadB2bPanel(): B2bPanelId {
  const state = readUiState()
  if (state.b2bPanel === 'status' || state.b2bPanel === 'news') {
    return state.b2bPanel
  }
  if ((state.activeSheet as string | undefined) === 'b2b-news') {
    return 'news'
  }
  return 'status'
}

export function saveB2bPanel(panel: B2bPanelId): void {
  writeUiState({ b2bPanel: panel })
}

export function loadRoadmapUiState(): Partial<RoadmapUiState> {
  return readUiState().roadmap ?? {}
}

export function saveRoadmapUiState(state: RoadmapUiState): void {
  writeUiState({ roadmap: state })
}
