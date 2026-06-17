const dayMs = 24 * 60 * 60 * 1000

export function parseDateInput(value: string, endOfDay = false): Date {
  const [year, month, day] = value.split('-').map(Number)
  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function timelinePercent(date: string | Date, from: Date, to: Date): number {
  const total = Math.max(to.getTime() - from.getTime(), dayMs)
  return clamp(((new Date(date).getTime() - from.getTime()) / total) * 100, 0, 100)
}

export function timelineWidth(start: string | Date, end: string | Date, from: Date, to: Date): number {
  return Math.max(timelinePercent(end, from, to) - timelinePercent(start, from, to), 1.4)
}

export type TimelineBarVisual = {
  leftPct: number
  widthPct: number
}

export function barVisual(startDate: string, endDate: string, from: Date, to: Date): TimelineBarVisual {
  return {
    leftPct: timelinePercent(startDate, from, to),
    widthPct: timelineWidth(startDate, endDate, from, to),
  }
}
