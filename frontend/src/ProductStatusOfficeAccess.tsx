import { useEffect, useMemo, useState } from 'react'
import { apiFetch, getJson, readApiError } from './api'
import { notifyProblem, notifySuccess } from './toast'

type EmployeeOption = {
  id: number
  name: string
}

type OfficeMember = {
  employeeId: number
  fullName: string
  email?: string | null
}

type ScheduleSlot = {
  weekday: number
  time: string
}

type OfficeAccess = {
  autoLockEnabled: boolean
  lock: ScheduleSlot
  unlock: ScheduleSlot
  skipLockUntil?: string | null
  members: OfficeMember[]
}

const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье']
const DEFAULT_LOCK: ScheduleSlot = { weekday: 3, time: '09:30' }
const DEFAULT_UNLOCK: ScheduleSlot = { weekday: 3, time: '18:00' }

function moscowDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`
}

type ProductStatusOfficeAccessProps = {
  apiBase: string
  gid: string
  officeName: string
}

export default function ProductStatusOfficeAccess({
  apiBase,
  gid,
  officeName,
}: ProductStatusOfficeAccessProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [autoLockEnabled, setAutoLockEnabled] = useState(true)
  const [lock, setLock] = useState<ScheduleSlot>(DEFAULT_LOCK)
  const [unlock, setUnlock] = useState<ScheduleSlot>(DEFAULT_UNLOCK)
  const [skipLockUntil, setSkipLockUntil] = useState('')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    setOpen(false)
    setQuery('')
  }, [gid])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const [access, options] = await Promise.all([
          getJson<OfficeAccess>(`${apiBase}/offices/${encodeURIComponent(gid)}/access`),
          getJson<EmployeeOption[]>('/api/org/employee-options'),
        ])
        if (cancelled) return
        setAutoLockEnabled(Boolean(access.autoLockEnabled))
        setLock(access.lock ?? DEFAULT_LOCK)
        setUnlock(access.unlock ?? DEFAULT_UNLOCK)
        setSkipLockUntil(moscowDateTimeLocal(access.skipLockUntil))
        setSelectedIds(access.members.map((member) => member.employeeId))
        setEmployees(options)
      } catch (err) {
        if (!cancelled) notifyProblem(err, 'Не удалось загрузить состав офиса')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [apiBase, gid, open])

  const selectedNames = useMemo(() => {
    const byId = new Map(employees.map((employee) => [employee.id, employee.name]))
    return selectedIds.map((id) => byId.get(id) ?? `Сотрудник ${id}`)
  }, [employees, selectedIds])

  const visibleEmployees = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = needle
      ? employees.filter((employee) => employee.name.toLowerCase().includes(needle))
      : employees
    return matched.slice(0, 40)
  }, [employees, query])

  function toggleEmployee(id: number) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  async function save() {
    setSaving(true)
    try {
      const response = await apiFetch(`${apiBase}/offices/${encodeURIComponent(gid)}/access`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoLockEnabled,
          employeeIds: selectedIds,
          lock,
          unlock,
          skipLockUntil: skipLockUntil || null,
        }),
      })
      if (!response.ok) throw new Error(await readApiError(response))
      const saved = (await response.json()) as OfficeAccess
      setAutoLockEnabled(Boolean(saved.autoLockEnabled))
      setLock(saved.lock ?? DEFAULT_LOCK)
      setUnlock(saved.unlock ?? DEFAULT_UNLOCK)
      setSkipLockUntil(moscowDateTimeLocal(saved.skipLockUntil))
      setSelectedIds(saved.members.map((member) => member.employeeId))
      notifySuccess('Состав офиса сохранён')
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить состав офиса')
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
        Сотрудники офиса
      </button>
      {open ? (
        <div className="product-status-office-access-panel">
          <p className="product-status-office-access-note">
            {officeName}. Время московское. Письмо уходит только закреплённым сотрудникам.
          </p>
          <label className="product-status-schedule-row product-status-schedule-row--wide">
            <span>Не блокировать до</span>
            <input
              type="datetime-local"
              value={skipLockUntil}
              onChange={(event) => setSkipLockUntil(event.target.value)}
            />
          </label>
          <label className="product-status-schedule-row">
            <span>Блокировка</span>
            <select
              value={lock.weekday}
              onChange={(event) => setLock((current) => ({ ...current, weekday: Number(event.target.value) }))}
            >
              {WEEKDAYS.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
            <input
              type="time"
              value={lock.time}
              onChange={(event) => setLock((current) => ({ ...current, time: event.target.value }))}
            />
          </label>
          <label className="product-status-schedule-row">
            <span>Разблокировка</span>
            <select
              value={unlock.weekday}
              onChange={(event) => setUnlock((current) => ({ ...current, weekday: Number(event.target.value) }))}
            >
              {WEEKDAYS.map((name, index) => (
                <option key={name} value={index}>
                  {name}
                </option>
              ))}
            </select>
            <input
              type="time"
              value={unlock.time}
              onChange={(event) => setUnlock((current) => ({ ...current, time: event.target.value }))}
            />
          </label>
          <button
            type="button"
            className={`btn-secondary product-status-toolbar-btn${
              autoLockEnabled ? ' product-status-office-access-toggle-on' : ''
            }`}
            aria-pressed={autoLockEnabled}
            onClick={() => setAutoLockEnabled((current) => !current)}
          >
            {autoLockEnabled ? 'Автоблокировка включена' : 'Автоблокировка выключена'}
          </button>
          {selectedNames.length > 0 ? (
            <p className="product-status-office-access-selected">{selectedNames.join(', ')}</p>
          ) : (
            <p className="product-status-office-access-selected">Сотрудники не закреплены</p>
          )}
          <input
            className="product-status-office-access-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти сотрудника"
            aria-label="Найти сотрудника"
          />
          <ul className="product-status-office-access-list">
            {loading ? <li>Загрузка…</li> : null}
            {!loading && visibleEmployees.length === 0 ? <li>Никого не найдено</li> : null}
            {visibleEmployees.map((employee) => (
              <li key={employee.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(employee.id)}
                    onChange={() => toggleEmployee(employee.id)}
                  />
                  <span>{employee.name}</span>
                </label>
              </li>
            ))}
          </ul>
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
