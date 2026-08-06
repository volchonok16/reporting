import type { ChangeRequest } from './zniTypes'

const labelsByCode = new Map<string, string>()
const labelsByName = new Map<string, string>()

/** Заполнить подписи досок из GET /api/boards (alias = displayName). */
export function setBoardDisplayLabels(
  boards: Array<{ code: string; name?: string | null; displayName?: string | null }>,
): void {
  labelsByCode.clear()
  labelsByName.clear()
  for (const board of boards) {
    const label = (board.displayName || board.name || board.code).trim()
    if (!label) continue
    labelsByCode.set(board.code, label)
    if (board.name?.trim()) {
      labelsByName.set(board.name.trim(), label)
    }
  }
}

export function boardNameLabel(name?: string | null, code?: string | null): string {
  if (code && labelsByCode.has(code)) return labelsByCode.get(code)!
  if (name && labelsByName.has(name)) return labelsByName.get(name)!
  if (name && labelsByCode.has(name)) return labelsByCode.get(name)!
  return name || '—'
}

export function formatDate(value?: string | null): string {
  if (!value) return '—'
  const [year, month, day] = value.split('-')
  if (!year || !month || !day) return value
  return `${day}.${month}.${year}`
}

export function formatPlannedDate(item: ChangeRequest): string {
  if (item.plannedLabel) return item.plannedLabel
  return formatDate(item.plannedDate)
}

export function formatEctReservation(value?: boolean): string {
  return value ? 'ДА' : 'НЕТ'
}

export function formatLinkedEnvironmentStatus(env: {
  boardColumn?: string | null
  status?: string | null
}): string {
  const column = env.boardColumn?.trim()
  const status = env.status?.trim()
  if (column && status && column !== status) {
    return `${column} (${status})`
  }
  return column || status || '—'
}

export function businessGoalParagraphs(text: string): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push(current.join('\n'))
        current = []
      }
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join('\n'))
  }
  return paragraphs.length > 0 ? paragraphs : [text]
}

export function customerNameParts(name?: string | null): string[] {
  if (!name?.trim()) return []
  return name.trim().split(/\s+/).slice(0, 3)
}
