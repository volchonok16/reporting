import { useEffect, useMemo, useRef, useState } from 'react'

export type AppPageOption = {
  pageKey: string
  label: string
}

type AppPageMultiSelectProps = {
  pages: AppPageOption[]
  value: string[]
  onChange: (pageKeys: string[]) => void
  placeholder?: string
  disabled?: boolean
}

export default function AppPageMultiSelect({
  pages,
  value,
  onChange,
  placeholder = '— выберите страницы —',
  disabled = false,
}: AppPageMultiSelectProps) {
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
    const labels = pages.filter((page) => value.includes(page.pageKey)).map((page) => page.label)
    return labels.length > 0 ? labels.join(', ') : placeholder
  }, [pages, placeholder, value])

  const toggle = (pageKey: string) => {
    onChange(value.includes(pageKey) ? value.filter((key) => key !== pageKey) : [...value, pageKey])
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
          {pages.map((page) => {
            const checked = value.includes(page.pageKey)
            return (
              <label
                key={page.pageKey}
                className={`planning-multi-select-option${checked ? ' is-selected' : ''}`}
              >
                <input type="checkbox" checked={checked} onChange={() => toggle(page.pageKey)} />
                <span>{page.label}</span>
              </label>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
