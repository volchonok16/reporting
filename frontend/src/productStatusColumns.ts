export type PresentationCopyPair = {
  from: string
  to: string
  label: string
}

type SheetLike = {
  columns: string[]
  rows: Array<Record<string, string>>
}

export const PRESENTATION_COPY_COLUMN_LABELS: Record<string, string> = {
  'Полное Описание проекта и статус': 'Описание и статус · полное',
  'Для презентации Описание проекта и статус': 'Описание и статус · презентация',
  'Зачем и для чего делаем полное описание': 'Зачем · полное',
  'Зачем и для чего делаем для презентации': 'Зачем · презентация',
}

function columnKey(column: string): string {
  return column.trim().toLowerCase()
}

export function formatProductStatusColumnHeader(column: string): string {
  return PRESENTATION_COPY_COLUMN_LABELS[column] ?? column
}

export function isDescriptionPresentationColumn(column: string): boolean {
  const key = columnKey(column)
  return key.includes('для презентации') && key.includes('описан') && !key.includes('зачем')
}

export function isWhyPresentationColumn(column: string): boolean {
  const key = columnKey(column)
  return key.includes('для презентации') && key.includes('зачем')
}

export function isFullDescriptionColumn(column: string): boolean {
  const key = columnKey(column)
  return (
    key.includes('полное') &&
    key.includes('описан') &&
    !key.includes('зачем') &&
    !key.includes('для презентации')
  )
}

export function isFullWhyColumn(column: string): boolean {
  const key = columnKey(column)
  return key.includes('полное') && key.includes('зачем') && !key.includes('для презентации')
}

export function resolvePresentationCopyPairs(columns: string[]): PresentationCopyPair[] {
  const fullDescription = columns.find(isFullDescriptionColumn)
  const presentationDescription = columns.find(isDescriptionPresentationColumn)
  const fullWhy = columns.find(isFullWhyColumn)
  const presentationWhy = columns.find(isWhyPresentationColumn)

  const pairs: PresentationCopyPair[] = []
  if (fullDescription && presentationDescription) {
    pairs.push({
      from: fullDescription,
      to: presentationDescription,
      label: 'описание',
    })
  }
  if (fullWhy && presentationWhy) {
    pairs.push({
      from: fullWhy,
      to: presentationWhy,
      label: 'зачем',
    })
  }
  return pairs
}

export function copyFullColumnsToPresentation<T extends SheetLike>(
  sheet: T,
  options?: { onlyPresentationRows?: boolean; isPresentationRow?: (row: Record<string, string>) => boolean },
): { sheet: T; copiedCells: number } {
  const pairs = resolvePresentationCopyPairs(sheet.columns)
  if (pairs.length === 0) {
    return { sheet, copiedCells: 0 }
  }

  let copiedCells = 0
  const rows = sheet.rows.map((row) => {
    if (options?.onlyPresentationRows && options.isPresentationRow && !options.isPresentationRow(row)) {
      return row
    }
    const next = { ...row }
    for (const pair of pairs) {
      const source = row[pair.from] ?? ''
      if (source.trim() && next[pair.to] !== source) {
        next[pair.to] = source
        copiedCells += 1
      }
    }
    return next
  })

  return {
    sheet: { ...sheet, rows },
    copiedCells,
  }
}
