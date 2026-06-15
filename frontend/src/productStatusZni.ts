import { displayCellText } from './productStatusRichText'

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
  const text = normalizeIntegerNumberText(displayCellText(value).trim())
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
