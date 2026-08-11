import { useEffect, useMemo, useRef, useState } from 'react'
import {
  joinCoordinationProjects,
  splitCoordinationProjects,
} from './productStatusCoordination'

type ProductStatusProjectMultiSelectProps = {
  value: string
  options: string[]
  disabled?: boolean
  ariaLabel: string
  onChange: (value: string) => void
}

export default function ProductStatusProjectMultiSelect({
  value,
  options,
  disabled = false,
  ariaLabel,
  onChange,
}: ProductStatusProjectMultiSelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = useMemo(() => new Set(splitCoordinationProjects(value)), [value])
  const label = useMemo(() => {
    const items = splitCoordinationProjects(value)
    if (items.length === 0) return 'Выберите проекты…'
    return items.join('; ')
  }, [value])

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const toggle = (project: string) => {
    const next = new Set(selected)
    if (next.has(project)) next.delete(project)
    else next.add(project)
    const ordered = options.filter((item) => next.has(item))
    const extras = [...next].filter((item) => !options.includes(item))
    onChange(joinCoordinationProjects([...ordered, ...extras]))
  }

  return (
    <div className="product-status-project-select" ref={rootRef}>
      <button
        type="button"
        className="product-status-project-select-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={label}
      >
        <span>{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="product-status-project-select-menu" role="listbox" aria-multiselectable="true">
          {options.map((project) => {
            const checked = selected.has(project)
            return (
              <label key={project} className="product-status-project-select-option">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(project)}
                />
                <span>{project}</span>
              </label>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
