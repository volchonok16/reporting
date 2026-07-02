import { displayCellText } from './productStatusRichText'

export const PRODUCT_STATUS_ROW_ID_KEY = '__rowId'

export function isZniColumn(column: string): boolean {
  return column.trim().toLowerCase() === 'зни'
}

function normalizeIntegerNumberText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return text
  if (/^\d+\.0+$/.test(trimmed)) {
    return trimmed.replace(/\.0+$/, '')
  }
  const number = Number(trimmed)
  if (!Number.isNaN(number) && Number.isFinite(number) && Number.isInteger(number)) {
    return String(Math.trunc(number))
  }
  return text
}

export function normalizeZniCellValue(value: string): string {
  const text = displayCellText(value).trim()
  if (!text) return value
  const normalized = normalizeIntegerNumberText(text)
  if (normalized === text) return value
  return value.replace(text, normalized)
}

export function parseZniNumber(value: string): string | null {
  const numbers = parseZniNumbers(value)
  return numbers[0] ?? null
}

export function parseZniNumbers(value: string): string[] {
  const text = displayCellText(value).trim()
  if (!text) return []
  const matches = text.match(/\d{4,}/g)
  if (!matches) return []
  const unique = new Set<string>()
  for (const match of matches) {
    unique.add(normalizeIntegerNumberText(match))
  }
  return [...unique]
}

export function collectZniNumbers(
  rows: Record<string, string>[],
  column: string,
): string[] {
  const numbers = new Set<string>()
  for (const row of rows) {
    for (const number of parseZniNumbers(row[column] ?? '')) {
      numbers.add(number)
    }
  }
  return [...numbers]
}

export function formatZniNumbers(numbers: string[]): string {
  return numbers.join(', ')
}
