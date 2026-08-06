import { postJson } from '../api'
import type { ChangeRequest, TaskLookupResponse } from '../zniTypes'
import type { PlanningProjectStatus } from './types'

export const PLANNING_STATUS_LABELS: Record<PlanningProjectStatus, string> = {
  new: 'Новый',
  in_progress: 'В работе',
  completed: 'Завершен',
}

export function formatPlanningStatus(status?: PlanningProjectStatus | null): string {
  if (!status) return '—'
  return PLANNING_STATUS_LABELS[status] ?? status
}

export function sliceDate(value?: string | null): string {
  if (!value) return ''
  return value.slice(0, 10)
}

export function isZniClosed(zni: ChangeRequest): boolean {
  const values = [zni.status, zni.boardColumn]
  return values.some((item) => item?.trim().toLowerCase() === 'closed')
}

export function inferStatusFromZni(zni: ChangeRequest, actualEndDate?: string): PlanningProjectStatus {
  if (actualEndDate || isZniClosed(zni)) return 'completed'
  if (zni.startDate) return 'in_progress'
  return 'new'
}

export function resolvePlanningStatus(
  status: PlanningProjectStatus,
  actualEndDate: string,
): PlanningProjectStatus {
  if (actualEndDate) return 'completed'
  return status
}

function buildNotesFromZni(zni: ChangeRequest): string {
  const parts: string[] = []
  if (zni.businessGoal?.trim()) parts.push(zni.businessGoal.trim())
  if (zni.businessValue != null) parts.push(`Бизнес-ценность: ${zni.businessValue}`)
  if (zni.roadmapComment?.trim()) parts.push(`Комментарий: ${zni.roadmapComment.trim()}`)
  return parts.join('\n\n')
}

export type PlanningProjectFormPatch = {
  requestName: string
  requestUrl: string
  customerName: string
  plannedStartDate: string
  actualStartDate: string
  plannedEndDate: string
  actualEndDate: string
  status: PlanningProjectStatus
  notes: string
}

export function mapZniToProjectForm(zni: ChangeRequest): PlanningProjectFormPatch {
  const startDate = sliceDate(zni.startDate)
  const plannedEnd = sliceDate(zni.plannedDate || zni.releaseDate)
  const actualEnd = isZniClosed(zni) ? sliceDate(zni.releaseDate || zni.plannedDate) : ''
  return {
    requestName: zni.title,
    requestUrl: zni.url ?? '',
    customerName: zni.customerName ?? '',
    plannedStartDate: startDate,
    actualStartDate: startDate,
    plannedEndDate: plannedEnd,
    actualEndDate: actualEnd,
    status: inferStatusFromZni(zni, actualEnd),
    notes: buildNotesFromZni(zni),
  }
}

export async function lookupZniByNumbers(numbers: string[]): Promise<Record<string, ChangeRequest>> {
  const normalized = [...new Set(numbers.map((item) => item.trim()).filter((item) => /^\d+$/.test(item)))]
  if (normalized.length === 0) return {}
  const payload = await postJson<TaskLookupResponse>('/api/tasks/lookup', { numbers: normalized })
  const result: Record<string, ChangeRequest> = {}
  for (const item of payload.items) {
    result[item.number] = item
  }
  return result
}
