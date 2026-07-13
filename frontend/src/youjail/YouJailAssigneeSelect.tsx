import { useEffect, useMemo, useRef, useState } from 'react'
import { getJson } from '../api'
import OrgPhoto from '../org/OrgPhoto'
import type { Employee } from '../org/types'

type YouJailAssigneeSelectProps = {
  value: number | null | undefined
  disabled?: boolean
  onChange: (employeeId: number | null) => void
}

export default function YouJailAssigneeSelect({
  value,
  disabled = false,
  onChange,
}: YouJailAssigneeSelectProps) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void getJson<Employee[]>('/api/org/employees')
      .then((items) => {
        if (!cancelled) {
          setEmployees(items.filter((item) => item.isActive))
        }
      })
      .catch(() => {
        if (!cancelled) setEmployees([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  const selected = useMemo(
    () => employees.find((employee) => employee.id === value) ?? null,
    [employees, value],
  )

  const suggestions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return employees
      .filter((employee) => !needle || employee.fullName.toLowerCase().includes(needle))
      .slice(0, 12)
  }, [employees, query])

  const pickEmployee = (employee: Employee | null) => {
    onChange(employee?.id ?? null)
    setQuery('')
    setOpen(false)
  }

  return (
    <div className="youjail-assignee-select" ref={rootRef}>
      <div className={`youjail-assignee-input${disabled ? ' is-disabled' : ''}`}>
        {selected ? (
          <OrgPhoto
            url={selected.photoUrl}
            name={selected.fullName}
            className="youjail-assignee-photo"
            placeholderClassName="youjail-assignee-photo youjail-assignee-photo--placeholder"
          />
        ) : (
          <div className="youjail-assignee-photo youjail-assignee-photo--placeholder" aria-hidden="true">
            ?
          </div>
        )}
        <input
          type="search"
          className="youjail-assignee-search"
          value={open ? query : selected?.fullName ?? ''}
          disabled={disabled || loading}
          placeholder={loading ? 'Загрузка…' : 'Найти сотрудника…'}
          onFocus={() => {
            setOpen(true)
            setQuery('')
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false)
              setQuery('')
            }
          }}
        />
        {selected && !disabled ? (
          <button
            type="button"
            className="youjail-assignee-clear"
            aria-label="Снять ответственного"
            onClick={() => pickEmployee(null)}
          >
            ×
          </button>
        ) : null}
      </div>
      {open && !disabled ? (
        <div className="youjail-assignee-suggestions" role="listbox">
          <button
            type="button"
            className="youjail-assignee-option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pickEmployee(null)}
          >
            Не назначен
          </button>
          {suggestions.map((employee) => (
            <button
              key={employee.id}
              type="button"
              className={`youjail-assignee-option${employee.id === value ? ' is-active' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pickEmployee(employee)}
            >
              <OrgPhoto
                url={employee.photoUrl}
                name={employee.fullName}
                className="youjail-mention-photo"
                placeholderClassName="youjail-mention-photo youjail-mention-photo--placeholder"
              />
              <span>{employee.fullName}</span>
            </button>
          ))}
          {suggestions.length === 0 ? (
            <p className="youjail-muted youjail-assignee-empty">Никого не найдено</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
