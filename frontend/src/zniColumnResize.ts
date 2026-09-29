/** Изменение ширины столбцов таблицы ЗНИ с сохранением в localStorage. */

import type { MouseEvent as ReactMouseEvent } from 'react'

export type ZniColumnKey =
  | 'expand'
  | 'id'
  | 'board'
  | 'title'
  | 'goal'
  | 'businessValue'
  | 'status'
  | 'quarter'
  | 'reservation'
  | 'externalPriority'
  | 'externalCategory'
  | 'externalEffect'
  | 'externalActual'
  | 'externalDesired'
  | 'externalComment'

export type ZniColumnWidths = Partial<Record<ZniColumnKey, number>>

const MIN_WIDTH = 48
const MAX_WIDTH = 640

export function clampZniColumnWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}

export function startZniColumnResize(
  event: ReactMouseEvent,
  columnKey: ZniColumnKey,
  currentWidth: number | undefined,
  onChange: (key: ZniColumnKey, width: number) => void,
): void {
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const th = (event.target as HTMLElement).closest('th')
  const measured = currentWidth ?? th?.getBoundingClientRect().width ?? 100
  const startWidth = measured

  const onMove = (moveEvent: MouseEvent) => {
    const next = clampZniColumnWidth(startWidth + (moveEvent.clientX - startX))
    onChange(columnKey, next)
  }
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.classList.remove('zni-col-resizing')
  }
  document.body.classList.add('zni-col-resizing')
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
