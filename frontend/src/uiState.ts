const STORAGE_KEY = 'reporting.uiState'

export type SheetId = 'zni' | 'product-status-b2b'

export type DashboardUiState = {
  boardCode: string
  search: string
  sort: string
  dateFrom: string
  dateTo: string
  statusFilter: string
  quarterFilter: string
  ectReservationFilter: string
  tagGroupFilter: string[]
  metricFilter: string
}

type UiState = {
  activeSheet?: SheetId
  dashboard?: Partial<DashboardUiState>
  productStatusB2bGid?: string | null
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

export function loadActiveSheet(): SheetId {
  const sheet = readUiState().activeSheet
  return sheet === 'product-status-b2b' ? sheet : 'zni'
}

export function saveActiveSheet(activeSheet: SheetId): void {
  writeUiState({ activeSheet })
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
