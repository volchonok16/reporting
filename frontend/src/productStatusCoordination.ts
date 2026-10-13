import { displayCellText } from './productStatusRichTextUtils'

export const COORDINATION_PROJECT_SEPARATOR = '; '

export type PriorityRange = {
  rangeFrom: number
  rangeTo: number
}

export type ProjectPriorityRangesMap = Record<string, PriorityRange>

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

export function isObsoleteYes(value: string): boolean {
  const normalized = displayCellText(value).trim().toLowerCase()
  if (normalized === 'нет' || normalized === 'no' || normalized === '0' || normalized === 'false') {
    return false
  }
  return normalized === 'да' || normalized === 'yes' || normalized === '1' || normalized === 'true'
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
  obsoleteColumn?: string,
): number {
  if (obsoleteColumn) {
    const leftObsolete = isObsoleteYes(left[obsoleteColumn] ?? '')
    const rightObsolete = isObsoleteYes(right[obsoleteColumn] ?? '')
    if (leftObsolete !== rightObsolete) return leftObsolete ? 1 : -1
  }
  if (!priorityColumn) return 0
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

/**
 * После изменения порядка строк: для каждого проекта заново выдать
 * приоритеты rangeFrom, rangeFrom+1… в порядке строк сверху вниз.
 */
export function applyProjectPrioritySequence(
  rows: Record<string, string>[],
  priorityColumn: string,
  projectColumn: string,
  projectPriorityRanges: ProjectPriorityRangesMap | undefined,
  obsoleteColumn?: string,
): Record<string, string>[] {
  if (!projectPriorityRanges || Object.keys(projectPriorityRanges).length === 0) {
    return applyPrioritySequence(rows, priorityColumn)
  }

  const nextCounter = new Map<string, number>()
  return rows.map((row) => {
    if (obsoleteColumn && isObsoleteYes(row[obsoleteColumn] ?? '')) {
      return { ...row, [priorityColumn]: '' }
    }
    const selected = splitCoordinationProjects(row[projectColumn] ?? '')
    const projectName = selected[0]
    if (!projectName) {
      return { ...row, [priorityColumn]: '' }
    }
    const range = projectPriorityRanges[projectName]
    if (!range || range.rangeTo < range.rangeFrom) {
      return row
    }
    const current = nextCounter.get(projectName) ?? range.rangeFrom
    const priority = Math.min(current, range.rangeTo)
    nextCounter.set(projectName, priority + 1)
    return { ...row, [priorityColumn]: String(priority) }
  })
}

/**
 * Сортировка по числу в «Приоритет»: актуальные сверху, «Неактуальное» в конце.
 * Выбранный номер сохраняется. У неактуальной строки приоритет очищается.
 */
export function sortProductStatusRows(
  rows: Record<string, string>[],
  columns: string[],
): Record<string, string>[] {
  const priorityColumn = columns.find(isPriorityColumn)
  const obsoleteColumn = columns.find(isObsoleteColumn)
  let next = [...rows]
  if (priorityColumn || obsoleteColumn) {
    next.sort((left, right) =>
      compareRowsByPriority(left, right, priorityColumn ?? '', obsoleteColumn),
    )
  }
  if (priorityColumn && obsoleteColumn) {
    next = next.map((row) =>
      isObsoleteYes(row[obsoleteColumn] ?? '') ? { ...row, [priorityColumn]: '' } : row,
    )
  }
  return next
}

/**
 * После перетаскивания строки: заново выдать приоритеты rangeFrom, rangeFrom+1…
 * в текущем порядке строк. Ручная смена числа сюда не попадает.
 */
export function settleProductStatusRows(
  rows: Record<string, string>[],
  columns: string[],
  projectPriorityRanges?: ProjectPriorityRangesMap,
): Record<string, string>[] {
  const priorityColumn = columns.find(isPriorityColumn)
  const projectColumn = columns.find(isCoordinationProjectColumn)
  const obsoleteColumn = columns.find(isObsoleteColumn)
  if (
    priorityColumn &&
    projectColumn &&
    sheetHasFixedProjectPriorities(projectPriorityRanges)
  ) {
    return applyProjectPrioritySequence(
      rows,
      priorityColumn,
      projectColumn,
      projectPriorityRanges,
      obsoleteColumn,
    )
  }
  return sortProductStatusRows(rows, columns)
}

export function sheetHasFixedProjectPriorities(
  projectPriorityRanges: ProjectPriorityRangesMap | undefined,
): boolean {
  if (!projectPriorityRanges) return false
  return Object.values(projectPriorityRanges).some(
    (range) => range && range.rangeTo >= range.rangeFrom && range.rangeFrom >= 1,
  )
}

export function resolvePriorityRangeForRow(
  projectCellValue: string,
  projectPriorityRanges: ProjectPriorityRangesMap | undefined,
): PriorityRange | null {
  if (!projectPriorityRanges || Object.keys(projectPriorityRanges).length === 0) return null
  const selected = splitCoordinationProjects(projectCellValue)
  for (const projectName of selected) {
    const range = projectPriorityRanges[projectName]
    if (range && range.rangeTo >= range.rangeFrom && range.rangeFrom >= 1) {
      return range
    }
  }
  return null
}

/** Числа диапазона для выпадающего списка (одно число = приоритет строки). */
export function expandPriorityRangeOptions(range: PriorityRange | null): string[] {
  if (!range) return []
  const from = Math.max(1, Math.floor(range.rangeFrom))
  const to = Math.floor(range.rangeTo)
  if (to < from) return []
  const options: string[] = []
  for (let value = from; value <= to; value += 1) {
    options.push(String(value))
  }
  return options
}

export function formatPriorityRangeHint(range: PriorityRange | null): string {
  if (!range) return ''
  return `${range.rangeFrom}–${range.rangeTo}`
}

/**
 * Следующий свободный номер в диапазоне проекта среди строк с этим проектом.
 * Исключает rowIndex (текущая строка).
 */
export function nextPriorityInProjectRange(
  rows: Record<string, string>[],
  rowIndex: number,
  projectCellValue: string,
  projectPriorityRanges: ProjectPriorityRangesMap | undefined,
  priorityColumn: string,
  projectColumn: string,
  obsoleteColumn?: string,
): string | null {
  const selected = splitCoordinationProjects(projectCellValue)
  if (selected.length === 0) return null
  const projectName = selected[0]
  const range = projectPriorityRanges?.[projectName]
  if (!range || range.rangeTo < range.rangeFrom) return null

  const used = new Set<number>()
  rows.forEach((row, index) => {
    if (index === rowIndex) return
    if (obsoleteColumn && isObsoleteYes(row[obsoleteColumn] ?? '')) return
    const rowProjects = splitCoordinationProjects(row[projectColumn] ?? '')
    if (!rowProjects.includes(projectName)) return
    const priority = parsePriorityValue(row[priorityColumn] ?? '')
    if (priority != null) used.add(priority)
  })

  for (let value = range.rangeFrom; value <= range.rangeTo; value += 1) {
    if (!used.has(value)) return String(value)
  }
  return String(range.rangeTo)
}

export function priorityNeedsReassign(
  currentPriority: string,
  projectCellValue: string,
  projectPriorityRanges: ProjectPriorityRangesMap | undefined,
): boolean {
  const range = resolvePriorityRangeForRow(projectCellValue, projectPriorityRanges)
  if (!range) return false
  const value = parsePriorityValue(currentPriority)
  if (value == null) return true
  return value < range.rangeFrom || value > range.rangeTo
}
