export type LinkedError = {
  id: string
  title: string
  url?: string | null
  status?: string | null
}

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
  ectResourceReservation?: boolean
  errors: LinkedError[]
}

export type TaskLookupResponse = {
  items: ChangeRequest[]
}
