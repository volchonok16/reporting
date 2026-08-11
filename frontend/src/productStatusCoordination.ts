import { displayCellText } from './productStatusRichText'

export const COORDINATION_PROJECT_SEPARATOR = '; '

export function isCoordinationProjectColumn(column: string): boolean {
  return column.trim().toLowerCase().includes('координац')
}

export function isPriorityColumn(column: string): boolean {
  return column.trim().toLowerCase() === 'приоритет'
}

export function isObsoleteColumn(column: string): boolean {
  const key = column.trim().toLowerCase()
  return key.includes('неактуальн')
}

export function splitCoordinationProjects(raw: string): string[] {
  const text = displayCellText(raw).trim()
  if (!text) return []
  return text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
}

export function joinCoordinationProjects(projects: string[]): string {
  return projects
    .map((item) => item.trim())
    .filter(Boolean)
    .join(COORDINATION_PROJECT_SEPARATOR)
}

export function parsePriorityValue(raw: string): number | null {
  const text = displayCellText(raw).trim()
  if (!text) return null
  const match = text.match(/-?\d+/)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

export function compareRowsByPriority(
  left: Record<string, string>,
  right: Record<string, string>,
  priorityColumn: string,
): number {
  const leftPriority = parsePriorityValue(left[priorityColumn] ?? '')
  const rightPriority = parsePriorityValue(right[priorityColumn] ?? '')
  if (leftPriority == null && rightPriority == null) return 0
  if (leftPriority == null) return 1
  if (rightPriority == null) return -1
  if (leftPriority !== rightPriority) return leftPriority - rightPriority
  return 0
}

export function applyPrioritySequence(
  rows: Record<string, string>[],
  priorityColumn: string,
): Record<string, string>[] {
  return rows.map((row, index) => ({
    ...row,
    [priorityColumn]: String(index + 1),
  }))
}
