import { displayCellText } from './productStatusRichText'

export function isZniColumn(column: string): boolean {
  return column.trim().toLowerCase() === 'зни'
}

export function parseZniNumber(value: string): string | null {
  const text = displayCellText(value).trim()
  if (!text) return null
  const match = text.match(/\d{4,}/)
  return match?.[0] ?? null
}

export function collectZniNumbers(
  rows: Record<string, string>[],
  column: string,
): string[] {
  const numbers = new Set<string>()
  for (const row of rows) {
    const number = parseZniNumber(row[column] ?? '')
    if (number) {
      numbers.add(number)
    }
  }
  return [...numbers]
}
