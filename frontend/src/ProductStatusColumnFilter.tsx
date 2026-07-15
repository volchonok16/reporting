import { useEffect, useMemo, useRef, useState } from 'react'
import { displayCellText } from './productStatusRichText'

type ProductStatusColumnFilterProps = {
  column: string
  rows: Array<Record<string, string>>
  selected: Set<string> | null
  onChange: (column: string, selected: Set<string> | null) => void
}

export function rowFilterValue(row: Record<string, string>, column: string): string {
  return displayCellText(row[column] ?? '').trim()
}

export function rowMatchesColumnFilters(
  row: Record<string, string>,
  filters: Record<string, Set<string> | null>,
): boolean {
  for (const [column, selected] of Object.entries(filters)) {
    if (!selected) continue
    if (!selected.has(rowFilterValue(row, column))) return false
  }
  return true
}

export default function ProductStatusColumnFilter({
  column,
  rows,
  selected,
  onChange,
}: ProductStatusColumnFilterProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const isActive = selected !== null

  const uniqueValues = useMemo(() => {
    const values = new Set<string>()
    for (const row of rows) {
      values.add(rowFilterValue(row, column))
    }
    return [...values].sort((a, b) => {
      if (a === '' && b !== '') return 1
      if (b === '' && a !== '') return -1
      return a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' })
    })
  }, [column, rows])

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return uniqueValues
    return uniqueValues.filter((value) => {
      const label = value || '(пусто)'
      return label.toLowerCase().includes(q)
    })
  }, [search, uniqueValues])

  const effectiveSelected = selected ?? new Set(uniqueValues)

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const toggleValue = (value: string) => {
    const next = new Set(effectiveSelected)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    if (next.size === uniqueValues.length) {
      onChange(column, null)
    } else {
      onChange(column, next)
    }
  }

  const selectAll = () => onChange(column, null)
  const clearAll = () => onChange(column, new Set())

  return (
    <div className="product-status-col-filter" ref={rootRef}>
      <button
        type="button"
        className={`product-status-col-filter-btn${isActive ? ' is-active' : ''}`}
        aria-label={`Фильтр: ${column}`}
        aria-expanded={open}
        title={isActive ? 'Фильтр включён' : 'Фильтр'}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((current) => !current)
          setSearch('')
        }}
      >
        ▾
      </button>
      {open ? (
        <div className="product-status-col-filter-menu" role="dialog" aria-label={`Фильтр «${column}»`}>
          <input
            type="search"
            className="product-status-col-filter-search"
            placeholder="Поиск…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoFocus
          />
          <div className="product-status-col-filter-actions">
            <button type="button" className="product-status-col-filter-link" onClick={selectAll}>
              Выбрать все
            </button>
            <button type="button" className="product-status-col-filter-link" onClick={clearAll}>
              Очистить
            </button>
          </div>
          <div className="product-status-col-filter-list">
            {filteredOptions.length === 0 ? (
              <div className="product-status-col-filter-empty">Нет значений</div>
            ) : (
              filteredOptions.map((value) => {
                const label = value || '(пусто)'
                const checked = effectiveSelected.has(value)
                return (
                  <label key={value || '__empty'} className="product-status-col-filter-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleValue(value)}
                    />
                    <span title={label}>{label}</span>
                  </label>
                )
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
