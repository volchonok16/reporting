import { toDayKey } from './scheduleUtils'

/** Нерабочие праздничные дни РФ (ст. 112 ТК РФ): месяц-день без года. */
const FIXED_HOLIDAY_MD = new Set([
  '01-01',
  '01-02',
  '01-03',
  '01-04',
  '01-05',
  '01-06',
  '01-07',
  '01-08',
  '02-23',
  '03-08',
  '05-01',
  '05-09',
  '06-12',
  '11-04',
])

/** Дополнительные нерабочие дни по переносам (Постановления Правительства РФ). */
const YEAR_EXTRA_MD: Record<number, readonly string[]> = {
  2024: ['05-10', '12-31'],
  2025: ['01-09', '05-02', '05-08', '06-13', '11-03', '12-31'],
  2026: ['01-09', '12-31'],
}

function monthDayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${m}-${d}`
}

export function isRuPublicHoliday(date: Date): boolean {
  const md = monthDayKey(date)
  if (FIXED_HOLIDAY_MD.has(md)) {
    return true
  }
  const extras = YEAR_EXTRA_MD[date.getFullYear()]
  return extras?.includes(md) ?? false
}

export function buildHolidayKeySet(year: number): Set<string> {
  const keys = new Set<string>()
  const start = new Date(year, 0, 1)
  const end = new Date(year + 1, 0, 1)
  const cursor = new Date(start)
  while (cursor < end) {
    if (isRuPublicHoliday(cursor)) {
      keys.add(toDayKey(cursor))
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}
