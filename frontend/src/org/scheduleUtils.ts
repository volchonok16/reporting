export const MONTH_NAMES_FULL = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]

export const MONTH_NAMES_SHORT = [
  'Янв',
  'Фев',
  'Мар',
  'Апр',
  'Май',
  'Июн',
  'Июл',
  'Авг',
  'Сен',
  'Окт',
  'Ноя',
  'Дек',
]

export const WEEKDAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

export function toDayKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getYearDays(year: number): Date[] {
  const days: Date[] = []
  const cursor = new Date(year, 0, 1)
  const end = new Date(year + 1, 0, 1)
  while (cursor < end) {
    days.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

export function getMonthDays(year: number, month: number): Date[] {
  const days: Date[] = []
  const cursor = new Date(year, month, 1)
  const end = new Date(year, month + 1, 1)
  while (cursor < end) {
    days.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

export function getMonthGroups(days: Date[]) {
  const groups: Array<{ label: string; length: number }> = []
  let currentMonth = -1
  let currentLength = 0
  for (const day of days) {
    const month = day.getMonth()
    if (month !== currentMonth) {
      if (currentMonth !== -1) {
        groups.push({ label: MONTH_NAMES_SHORT[currentMonth], length: currentLength })
      }
      currentMonth = month
      currentLength = 1
    } else {
      currentLength += 1
    }
  }
  if (currentMonth !== -1) {
    groups.push({ label: MONTH_NAMES_SHORT[currentMonth], length: currentLength })
  }
  return groups
}

export function isWeekendDay(date: Date): boolean {
  const dow = date.getDay()
  return dow === 0 || dow === 6
}

export function isDayOff(date: Date, holidayKeys: Set<string>): boolean {
  return isWeekendDay(date) || holidayKeys.has(toDayKey(date))
}
