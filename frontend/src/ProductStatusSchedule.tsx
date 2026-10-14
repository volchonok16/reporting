import { useEffect, useState } from 'react'
import { apiFetch, getJson, readApiError } from './api'
import { notifyProblem, notifySuccess } from './toast'

const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']

type ScheduleSlot = {
  weekday: number
  time: string
}

type Schedule = {
  reminder: ScheduleSlot
  lock: ScheduleSlot
  unlock: ScheduleSlot
}

const EMPTY: Schedule = {
  reminder: { weekday: 2, time: '10:00' },
  lock: { weekday: 3, time: '09:30' },
  unlock: { weekday: 3, time: '18:00' },
}

export default function ProductStatusSchedule({ apiBase }: { apiBase: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [schedule, setSchedule] = useState<Schedule>(EMPTY)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const data = await getJson<Schedule>(`${apiBase}/schedule`)
        if (!cancelled) setSchedule(data)
      } catch (err) {
        if (!cancelled) notifyProblem(err, 'Не удалось загрузить расписание')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [apiBase, open])

  function update(key: keyof Schedule, patch: Partial<ScheduleSlot>) {
    setSchedule((current) => ({ ...current, [key]: { ...current[key], ...patch } }))
  }

  async function save() {
    setSaving(true)
    try {
      const response = await apiFetch(`${apiBase}/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(schedule),
      })
      if (!response.ok) throw new Error(await readApiError(response))
      setSchedule((await response.json()) as Schedule)
      notifySuccess('Расписание сохранено')
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить расписание')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="product-status-office-access">
      <button
        type="button"
        className="btn-secondary product-status-toolbar-btn"
        onClick={() => setOpen((current) => !current)}
      >
        Расписание
      </button>
      {open ? (
        <div className="product-status-office-access-panel">
          <p className="product-status-office-access-note">
            Время московское. Напоминание уходит лидам и администраторам. Блокировка и
            разблокировка действуют на офисы с включённой автоблокировкой.
          </p>
          {loading ? <p className="product-status-office-access-note">Загрузка…</p> : null}
          {(
            [
              ['reminder', 'Напоминание'],
              ['lock', 'Блокировка'],
              ['unlock', 'Разблокировка'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="product-status-schedule-row">
              <span>{label}</span>
              <select
                value={schedule[key].weekday}
                onChange={(event) => update(key, { weekday: Number(event.target.value) })}
              >
                {WEEKDAYS.map((name, index) => (
                  <option key={name} value={index}>
                    {name}
                  </option>
                ))}
              </select>
              <input
                type="time"
                value={schedule[key].time}
                onChange={(event) => update(key, { time: event.target.value })}
              />
            </label>
          ))}
          <button
            type="button"
            className="btn-primary product-status-toolbar-btn"
            onClick={() => void save()}
            disabled={saving || loading}
          >
            Сохранить
          </button>
        </div>
      ) : null}
    </section>
  )
}
