import { useEffect, useMemo, useRef, useState } from 'react'
import '../planning/planning.css'
import type { EmployeeOption } from './types'

type EmployeeOverlapMultiSelectProps = {
  options: EmployeeOption[]
  value: number[]
  onChange: (ids: number[]) => void
  placeholder?: string
  disabled?: boolean
}

export default function EmployeeOverlapMultiSelect({
  options,
  value,
  onChange,
  placeholder = '— выберите сотрудников —',
  disabled = false,
}: EmployeeOverlapMultiSelectProps) {
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
    const names = options.filter((option) => value.includes(option.id)).map((option) => option.name)
    return names.length > 0 ? names.join(', ') : placeholder
  }, [options, placeholder, value])

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
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerLabel}
      </button>
      {open ? (
        <div className="planning-multi-select-menu" role="listbox" aria-multiselectable="true">
          {options.length === 0 ? (
            <div className="planning-multi-select-option">Нет сотрудников</div>
          ) : (
            options.map((option) => {
              const checked = value.includes(option.id)
              return (
                <label
                  key={option.id}
                  className={`planning-multi-select-option${checked ? ' is-selected' : ''}`}
                >
                  <input type="checkbox" checked={checked} onChange={() => toggle(option.id)} />
                  <span>{option.name}</span>
                </label>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}
