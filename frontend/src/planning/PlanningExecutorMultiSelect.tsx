import { useEffect, useMemo, useRef, useState } from 'react'
import type { Employee as OrgEmployee } from '../org/types'

type PlanningExecutorMultiSelectProps = {
  employees: OrgEmployee[]
  value: number[]
  onChange: (ids: number[]) => void
  placeholder?: string
}

export default function PlanningExecutorMultiSelect({
  employees,
  value,
  onChange,
  placeholder = '— выберите исполнителей —',
}: PlanningExecutorMultiSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onDocumentClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocumentClick)
    return () => document.removeEventListener('mousedown', onDocumentClick)
  }, [open])

  const triggerLabel = useMemo(() => {
    if (value.length === 0) return placeholder
    const names = employees.filter((employee) => value.includes(employee.id)).map((employee) => employee.fullName)
    return names.length > 0 ? names.join(', ') : placeholder
  }, [employees, placeholder, value])

  const toggle = (employeeId: number) => {
    onChange(
      value.includes(employeeId) ? value.filter((id) => id !== employeeId) : [...value, employeeId],
    )
  }

  return (
    <div ref={rootRef} className={`planning-multi-select${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="planning-multi-select-trigger"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((current) => !current)}
      >
        {triggerLabel}
      </button>
      {open ? (
        <div className="planning-multi-select-menu" role="listbox" aria-multiselectable="true">
          {employees.map((employee) => {
            const checked = value.includes(employee.id)
            return (
              <label
                key={employee.id}
                className={`planning-multi-select-option${checked ? ' is-selected' : ''}`}
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(employee.id)} />
                <span>{employee.fullName}</span>
              </label>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
