/** Изменение ширины столбцов «Статус продукта» с сохранением в localStorage. */

import type { MouseEvent as ReactMouseEvent } from 'react'

export type ProductStatusColumnWidths = Record<string, number>

const MIN_WIDTH = 56
const MAX_WIDTH = 720
const STORAGE_SCOPE = 'productStatusColumnWidths'

export function clampProductStatusColumnWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}

export function productStatusColumnWidthKey(sheetGid: string, column: string): string {
  return `${sheetGid}::${column}`
}

export function loadProductStatusColumnWidths(): ProductStatusColumnWidths {
  try {
    const raw = localStorage.getItem(STORAGE_SCOPE)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ProductStatusColumnWidths
    if (!parsed || typeof parsed !== 'object') return {}
    const next: ProductStatusColumnWidths = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        next[key] = clampProductStatusColumnWidth(value)
      }
    }
    return next
  } catch {
    return {}
  }
}

export function saveProductStatusColumnWidths(widths: ProductStatusColumnWidths): void {
  localStorage.setItem(STORAGE_SCOPE, JSON.stringify(widths))
}

export function startProductStatusColumnResize(
  event: ReactMouseEvent,
  column: string,
  currentWidth: number | undefined,
  onChange: (column: string, width: number, locked: Record<string, number>) => void,
  measureColumns: () => Record<string, number>,
): void {
  event.preventDefault()
  event.stopPropagation()
  const locked = measureColumns()
  const th = (event.target as HTMLElement).closest('th')
  const startWidth =
    currentWidth ?? locked[column] ?? th?.getBoundingClientRect().width ?? 120
  const startX = event.clientX

  const onMove = (moveEvent: MouseEvent) => {
    onChange(column, clampProductStatusColumnWidth(startWidth + (moveEvent.clientX - startX)), locked)
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.classList.remove('product-status-col-resizing')
  }
  document.body.classList.add('product-status-col-resizing')
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
