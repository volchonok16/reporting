import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, putJson } from '../api'
import { notifyError, notifyProblem } from '../toast'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import { MONTH_NAMES_FULL, WEEKDAY_NAMES, getMonthDays, isWeekendDay, toDayKey } from './scheduleUtils'
import { buildHolidayKeySet } from './ruPublicHolidays'
import type { OfficeDay } from './types'

type ProfileOfficeCalendarProps = {
  enabled: boolean
}

export default function ProfileOfficeCalendar({ enabled }: ProfileOfficeCalendarProps) {
  const current = new Date()
  const currentYear = current.getFullYear()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.workspaceYear)
  const [month, setMonth] = useState(savedOrgUi.workspaceMonth)
  const [days, setDays] = useState<OfficeDay[]>([])
  const [loading, setLoading] = useState(false)
  const [savingDay, setSavingDay] = useState<string | null>(null)

  const monthDays = useMemo(() => getMonthDays(year, month), [year, month])
  const holidayKeys = useMemo(() => buildHolidayKeySet(year), [year])
  const daySet = useMemo(() => new Set(days.map((item) => item.day)), [days])

  useEffect(() => {
    saveOrgUiState({ workspaceYear: year, workspaceMonth: month })
  }, [year, month])

  const load = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      const query = new URLSearchParams({
        year: String(year),
        month: String(month + 1),
      })
      const response = await getJson<OfficeDay[]>(`/api/profile/office-days?${query.toString()}`)
      setDays(response)
    } catch (err) {
      notifyError(err, 'Ошибка загрузки календаря офиса')
    } finally {
      setLoading(false)
    }
  }, [enabled, year, month])

  useEffect(() => {
    void load()
  }, [load])

  const toggleDay = async (dayKey: string) => {
    if (!enabled || savingDay) return
    setSavingDay(dayKey)
    const present = !daySet.has(dayKey)
    try {
      await putJson('/api/profile/office-days/range', {
        fromDay: dayKey,
        toDay: dayKey,
        present,
      })
      await load()
    } catch (err) {
      notifyProblem(err, 'Ошибка сохранения даты')
      await load()
    } finally {
      setSavingDay(null)
    }
  }

  if (!enabled) {
    return (
      <section className="org-panel">
        <h3>Дни в офисе</h3>
        <p className="org-hint">
          Доступно после привязки учётной записи к карточке сотрудника.
        </p>
      </section>
    )
  }

  return (
    <section className="org-panel">
      <div className="org-panel-toolbar">
        <h3>Дни в офисе (без места)</h3>
        <div className="org-vacation-toolbar-left">
          <div className="org-vacation-year-picker" role="group" aria-label="Год">
            {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
              <button
                key={y}
                type="button"
                className={`org-vacation-year-btn${year === y ? ' org-vacation-year-btn-active' : ''}`}
                onClick={() => setYear(y)}
                aria-pressed={year === y}
              >
                {y}
              </button>
            ))}
          </div>
          <label className="org-workspace-month-picker">
            <span className="org-workspace-month-label">Месяц</span>
            <select className="org-workspace-month-select" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTH_NAMES_FULL.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <p className="org-hint">Клик по дате переключает признак «в офисе». Эти дни видны во вкладке «Сотрудники в офисе».</p>
      {loading ? <p>Загрузка…</p> : null}
      <div className="org-profile-office-grid">
        {monthDays.map((day) => {
          const key = toDayKey(day)
          const isMarked = daySet.has(key)
          const isHoliday = holidayKeys.has(key)
          const isWeekend = isWeekendDay(day)
          return (
            <button
              key={key}
              type="button"
              className={[
                'org-profile-office-day',
                isMarked ? 'org-profile-office-day-active' : '',
                isWeekend || isHoliday ? 'org-profile-office-day-weekend' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => void toggleDay(key)}
              disabled={savingDay === key}
              title={`${WEEKDAY_NAMES[day.getDay()]} ${day.getDate()} ${MONTH_NAMES_FULL[day.getMonth()].toLowerCase()}`}
            >
              <span>{day.getDate()}</span>
              <small>{WEEKDAY_NAMES[day.getDay()]}</small>
            </button>
          )
        })}
      </div>
    </section>
  )
}
