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

type OfficeAccess = {
  autoLockEnabled: boolean
  members: OfficeMember[]
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
        }),
      })
      if (!response.ok) throw new Error(await readApiError(response))
      const saved = (await response.json()) as OfficeAccess
      setAutoLockEnabled(Boolean(saved.autoLockEnabled))
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
            {officeName}. Офис с автоблокировкой закрывается и открывается по расписанию. Письмо
            уходит только закреплённым сотрудникам.
          </p>
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
