/** Колонки вкладки «Активности по выручкам». */

export const REVENUE_ACTIVITY_COLUMNS = [
  'Активность',
  'Статус F2 2026',
  'Ответственный',
  'Влияние на базу, тыс',
  'Влияние на выручку, млн',
  'Влияние на gmc, млн',
  'Комментарий',
] as const

export const REVENUE_NUMERIC_COLUMNS = [
  'Влияние на базу, тыс',
  'Влияние на выручку, млн',
  'Влияние на gmc, млн',
] as const

/** @deprecated Колонка «Результат» удалена */
export const REVENUE_SUM_COLUMN = 'Результат'

export function isRevenueNumericColumn(column: string): boolean {
  return (REVENUE_NUMERIC_COLUMNS as readonly string[]).includes(column)
}

/** Парсит число из ячейки; текстовые / пустые значения не участвуют в сумме. */
export function parseRevenueNumber(value: string | undefined | null): number | null {
  const raw = String(value ?? '')
    .trim()
    .replace(/\u00a0/g, '')
    .replace(/\s/g, '')
    .replace(',', '.')
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

export function formatRevenueNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toPrecision(12)))
}

/** Сумма только по числовым ячейкам; текстовые поля игнорируются. */
export function computeRevenueResult(
  row: Record<string, string>,
  sourceColumns: readonly string[] = REVENUE_NUMERIC_COLUMNS,
): string {
  let total = 0
  let hasValue = false
  for (const column of sourceColumns) {
    const parsed = parseRevenueNumber(row[column])
    if (parsed === null) continue
    total += parsed
    hasValue = true
  }
  return hasValue ? formatRevenueNumber(total) : ''
}

export function withRevenueResult(
  row: Record<string, string>,
  sourceColumns: readonly string[] = REVENUE_NUMERIC_COLUMNS,
  sumColumn: string = REVENUE_SUM_COLUMN,
): Record<string, string> {
  return {
    ...row,
    [sumColumn]: computeRevenueResult(row, sourceColumns),
  }
}

/** Итоги по колонкам: суммируются только числовые значения, текст игнорируется. */
export function computeRevenueColumnTotals(
  rows: Array<Record<string, string>>,
  columns: readonly string[],
  totalColumns: readonly string[] = REVENUE_NUMERIC_COLUMNS,
): Record<string, string> {
  const totals: Record<string, string> = {}
  for (const column of columns) {
    if (!(totalColumns as readonly string[]).includes(column)) {
      totals[column] = ''
      continue
    }
    let total = 0
    let hasValue = false
    for (const row of rows) {
      const parsed = parseRevenueNumber(row[column])
      if (parsed === null) continue
      total += parsed
      hasValue = true
    }
    totals[column] = hasValue ? formatRevenueNumber(total) : ''
  }
  return totals
}
