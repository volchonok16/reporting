import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const DRAG_START_THRESHOLD_PX = 4

type DragSession = {
  fromIndex: number
  offsetY: number
  left: number
  ghost: HTMLElement
  pointerId: number
  handle: HTMLButtonElement
}

function findRowIndexAtPoint(x: number, y: number): number | null {
  const elements = document.elementsFromPoint(x, y)
  for (const element of elements) {
    const row = element.closest('tr[data-row-index]')
    if (!row?.closest('.product-status-table')) continue
    const rowIndex = Number(row.getAttribute('data-row-index'))
    if (!Number.isNaN(rowIndex)) return rowIndex
  }
  return null
}

function createRowDragGhost(row: HTMLTableRowElement): HTMLElement {
  const rect = row.getBoundingClientRect()
  const wrapper = document.createElement('div')
  wrapper.className = 'product-status-row-drag-ghost'
  wrapper.style.width = `${rect.width}px`
  wrapper.style.transform = `translate(${rect.left}px, ${rect.top}px)`

  const table = document.createElement('table')
  table.className = row.closest('table')?.className ?? 'product-status-table'

  const tbody = document.createElement('tbody')
  const clone = row.cloneNode(true) as HTMLTableRowElement
  clone.classList.remove('product-status-row--dragging', 'product-status-row--drag-over')
  clone.removeAttribute('data-row-index')
  clone.querySelectorAll('[contenteditable]').forEach((element) => {
    element.removeAttribute('contenteditable')
  })
  tbody.appendChild(clone)
  table.appendChild(tbody)
  wrapper.appendChild(table)
  document.body.appendChild(wrapper)
  return wrapper
}

function moveGhost(ghost: HTMLElement, left: number, top: number) {
  ghost.style.transform = `translate(${left}px, ${top}px)`
}

type UseProductStatusRowReorderOptions = {
  enabled: boolean
  onMoveRow: (fromIndex: number, toIndex: number) => void
}

export function useProductStatusRowReorder({ enabled, onMoveRow }: UseProductStatusRowReorderOptions) {
  const [draggingRowIndex, setDraggingRowIndex] = useState<number | null>(null)
  const [dragOverRowIndex, setDragOverRowIndex] = useState<number | null>(null)
  const sessionRef = useRef<DragSession | null>(null)
  const pendingRef = useRef<{
    fromIndex: number
    startX: number
    startY: number
    rowElement: HTMLTableRowElement
    handle: HTMLButtonElement
    pointerId: number
  } | null>(null)

  const finishDrag = useCallback((dropIndex: number | null) => {
    const session = sessionRef.current
    if (session) {
      if (dropIndex !== null && dropIndex !== session.fromIndex) {
        onMoveRow(session.fromIndex, dropIndex)
      }
      session.ghost.remove()
      document.body.classList.remove('product-status-row-drag-active')
      try {
        session.handle.releasePointerCapture(session.pointerId)
      } catch {
        // pointer may already be released
      }
      sessionRef.current = null
    }
    pendingRef.current = null
    setDraggingRowIndex(null)
    setDragOverRowIndex(null)
  }, [onMoveRow])

  const handleRowPointerDragStart = useCallback(
    (
      rowIndex: number,
      event: ReactPointerEvent<HTMLButtonElement>,
      rowElement: HTMLTableRowElement,
    ) => {
      if (!enabled || event.button !== 0) return
      event.preventDefault()

      pendingRef.current = {
        fromIndex: rowIndex,
        startX: event.clientX,
        startY: event.clientY,
        rowElement,
        handle: event.currentTarget,
        pointerId: event.pointerId,
      }

      const onPointerMove = (moveEvent: PointerEvent) => {
        const session = sessionRef.current
        if (session) {
          if (moveEvent.pointerId !== session.pointerId) return

          moveGhost(session.ghost, session.left, moveEvent.clientY - session.offsetY)

          const overIndex = findRowIndexAtPoint(moveEvent.clientX, moveEvent.clientY)
          if (overIndex !== null) {
            setDragOverRowIndex(overIndex)
          }
          return
        }

        const pending = pendingRef.current
        if (!pending || moveEvent.pointerId !== pending.pointerId) return

        const distance = Math.hypot(
          moveEvent.clientX - pending.startX,
          moveEvent.clientY - pending.startY,
        )
        if (distance < DRAG_START_THRESHOLD_PX) return

        const rect = pending.rowElement.getBoundingClientRect()
        const ghost = createRowDragGhost(pending.rowElement)
        const nextSession: DragSession = {
          fromIndex: pending.fromIndex,
          offsetY: pending.startY - rect.top,
          left: rect.left,
          ghost,
          pointerId: pending.pointerId,
          handle: pending.handle,
        }
        sessionRef.current = nextSession
        pendingRef.current = null
        setDraggingRowIndex(nextSession.fromIndex)
        setDragOverRowIndex(nextSession.fromIndex)
        pending.handle.setPointerCapture(pending.pointerId)
        document.body.classList.add('product-status-row-drag-active')

        moveGhost(nextSession.ghost, nextSession.left, moveEvent.clientY - nextSession.offsetY)

        const overIndex = findRowIndexAtPoint(moveEvent.clientX, moveEvent.clientY)
        if (overIndex !== null) {
          setDragOverRowIndex(overIndex)
        }
      }

      const onPointerUp = (upEvent: PointerEvent) => {
        const session = sessionRef.current
        const pending = pendingRef.current
        const pointerId = session?.pointerId ?? pending?.pointerId
        if (pointerId !== undefined && upEvent.pointerId !== pointerId) return

        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerUp)

        const dropIndex = session
          ? findRowIndexAtPoint(upEvent.clientX, upEvent.clientY)
          : null
        finishDrag(dropIndex)
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
    },
    [enabled, finishDrag],
  )

  return {
    draggingRowIndex,
    dragOverRowIndex,
    handleRowPointerDragStart,
  }
}
