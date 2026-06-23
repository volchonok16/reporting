export type LinkedError = {
  id: string
  title: string
  url?: string | null
  status?: string | null
}

export type RoadmapPriority = 'red' | 'yellow' | 'green'

export type ChangeRequest = {
  number: string
  rowType?: 'change_request' | 'error'
  title: string
  url?: string | null
  status?: string | null
  boardColumn?: string | null
  startDate?: string | null
  releaseDate?: string | null
  plannedDate?: string | null
  plannedLabel?: string | null
  planQuarter?: string | null
  plannedRelease?: string | null
  boardName?: string | null
  boardCode?: string | null
  customerName?: string | null
  businessGoal?: string | null
  businessValue?: number | null
  roadmapPriority?: RoadmapPriority | null
  roadmapComment?: string | null
  ectResourceReservation?: boolean
  ectAcceptance?: boolean
  hasUc?: boolean
  errors: LinkedError[]
}

export type TaskLookupResponse = {
  items: ChangeRequest[]
}
