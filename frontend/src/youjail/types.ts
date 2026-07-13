export type YouJailTeamRef = {
  id: number
  name: string
}

export type YouJailBoardMeta = {
  id: number
  name: string
  slug: string
  description: string
  sortOrder: number
  isActive: boolean
  ownerEmployeeId?: number | null
  isPersonal?: boolean
  teamIds: number[]
  teams: YouJailTeamRef[]
}

export type YouJailTeamMember = {
  id: number
  teamId: number
  employeeId: number
  employeeName: string
  employeePhotoUrl?: string | null
  role: string
}

export type YouJailTeam = {
  id: number
  name: string
  slug: string
  description: string
  sortOrder: number
  isActive: boolean
  memberCount: number
  boardIds: number[]
  members: YouJailTeamMember[]
}

export type YouJailColumnTone = 'backlog' | 'progress' | 'blocked' | 'done' | 'custom' | string

export type YouJailColumn = {
  id: number
  boardId: number
  columnKey: string
  title: string
  tone: YouJailColumnTone
  sortOrder: number
}

export type YouJailProject = {
  id: number
  name: string
  slug: string
  repoPath?: string | null
  contextMd: string
  instructionsMd: string
  isActive: boolean
}

export type YouJailTaskType = {
  id: number
  name: string
  instructionsMd: string
  sortOrder: number
  isActive: boolean
}

export type YouJailTag = {
  id: number
  name: string
  slug: string
  color?: string | null
}

export type YouJailAttachment = {
  id: number
  cardId: number
  filename: string
  contentType?: string | null
  sizeBytes: number
  downloadUrl: string
  createdAt: string
}

export type YouJailExecutionLog = {
  id: number
  seq: number
  stream: string
  content: string
  createdAt: string
}

export type YouJailExecution = {
  id: number
  cardId: number
  executor: string
  status: string
  startedAt: string
  finishedAt?: string | null
  exitCode?: number | null
  errorMessage?: string | null
  worktreePath?: string | null
  logs?: YouJailExecutionLog[]
}

export type YouJailCard = {
  id: number
  boardId: number
  columnId: number
  columnKey: string
  cardNumber: number
  cardKey: string
  projectId?: number | null
  projectName?: string | null
  taskTypeId?: number | null
  taskTypeName?: string | null
  title: string
  descriptionMd: string
  pinned: boolean
  archived: boolean
  closedAt?: string | null
  scheduledAt?: string | null
  sortOrder: number
  executor: string
  worktreePath?: string | null
  worktreeBranch?: string | null
  executionStatus: string
  assigneeEmployeeId?: number | null
  assigneeName?: string | null
  assigneePhotoUrl?: string | null
  tags: YouJailTag[]
  createdBy?: string | null
  createdAt: string
  updatedAt: string
  attachments: YouJailAttachment[]
  latestExecution?: YouJailExecution | null
}

export type YouJailBoard = {
  board: YouJailBoardMeta
  boards: YouJailBoardMeta[]
  columns: YouJailColumn[]
  cards: YouJailCard[]
  projects: YouJailProject[]
  taskTypes: YouJailTaskType[]
  tags: YouJailTag[]
}

export const YOUJAIL_EXECUTORS = [
  'manual',
  'claude',
  'codex',
  'gemini',
  'pi',
  'openclaw',
  'opencode',
] as const

export type YouJailExecutor = (typeof YOUJAIL_EXECUTORS)[number]
