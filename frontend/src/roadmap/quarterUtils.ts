export function currentQuarter(date = new Date()): number {
  return Math.floor(date.getMonth() / 3) + 1
}

export function quarterRange(year: number, quarter: number): { from: string; to: string } {
  const startMonth = (quarter - 1) * 3
  const from = toDateInput(new Date(year, startMonth, 1))
  const to = toDateInput(new Date(year, startMonth + 3, 0))
  return { from, to }
}

export function toDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function yearOptions(anchorYear = new Date().getFullYear()): number[] {
  const years: number[] = []
  for (let year = anchorYear - 1; year <= anchorYear + 2; year += 1) {
    years.push(year)
  }
  return years
}

export function formatRuDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`
}
