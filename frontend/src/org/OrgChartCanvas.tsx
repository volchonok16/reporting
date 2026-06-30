import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

type OrgChartCanvasProps = {
  children: ReactNode
}

const MIN_SCALE = 0.25
const MAX_SCALE = 2.5
const ZOOM_STEP = 1.15

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, label'))
}

export default function OrgChartCanvas({ children }: OrgChartCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const scaleRef = useRef(1)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  const centerSheet = useCallback((nextScale = scaleRef.current) => {
    const stage = stageRef.current
    const sheet = sheetRef.current
    if (!stage || !sheet) return
    const stageRect = stage.getBoundingClientRect()
    const sheetRect = sheet.getBoundingClientRect()
    const sheetWidth = sheetRect.width / nextScale
    const sheetHeight = sheetRect.height / nextScale
    setTranslate({
      x: (stageRect.width - sheetWidth * nextScale) / 2,
      y: Math.max(24, (stageRect.height - sheetHeight * nextScale) / 2),
    })
  }, [])

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  useEffect(() => {
    setScale(1)
    scaleRef.current = 1
    const frame = requestAnimationFrame(() => centerSheet(1))
    return () => cancelAnimationFrame(frame)
  }, [children, centerSheet])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const anchorX = event.clientX - rect.left
      const anchorY = event.clientY - rect.top
      const factor = event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP
      applyZoom(scaleRef.current * factor, anchorX, anchorY)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [applyZoom])

  const applyZoom = useCallback((nextScale: number, anchorX: number, anchorY: number) => {
    const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE)
    setScale((currentScale) => {
      setTranslate((currentTranslate) => {
        const worldX = (anchorX - currentTranslate.x) / currentScale
        const worldY = (anchorY - currentTranslate.y) / currentScale
        return {
          x: anchorX - worldX * clamped,
          y: anchorY - worldY * clamped,
        }
      })
      scaleRef.current = clamped
      return clamped
    })
  }, [])

  const zoomBy = useCallback(
    (factor: number) => {
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      applyZoom(scaleRef.current * factor, rect.width / 2, rect.height / 2)
    },
    [applyZoom],
  )

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return
    const stage = stageRef.current
    if (!stage) return
    stage.setPointerCapture(event.pointerId)
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      tx: translate.x,
      ty: translate.y,
    }
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setTranslate({
      x: drag.tx + (event.clientX - drag.x),
      y: drag.ty + (event.clientY - drag.y),
    })
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const resetView = () => {
    setScale(1)
    scaleRef.current = 1
    requestAnimationFrame(() => centerSheet(1))
  }

  const zoomPercent = Math.round(scale * 100)

  return (
    <div className="org-chart-canvas">
      <div className="org-chart-canvas-toolbar" aria-label="Масштаб схемы">
        <button type="button" className="btn-ghost org-chart-canvas-btn" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Уменьшить">
          −
        </button>
        <span className="org-chart-canvas-zoom">{zoomPercent}%</span>
        <button type="button" className="btn-ghost org-chart-canvas-btn" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Увеличить">
          +
        </button>
        <button type="button" className="btn-ghost org-chart-canvas-reset" onClick={resetView}>
          По центру
        </button>
        <span className="org-chart-canvas-hint">Колёсико — масштаб, перетаскивание — перемещение</span>
      </div>
      <div
        ref={stageRef}
        className={`org-chart-canvas-stage${dragging ? ' org-chart-canvas-stage-dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <div
          ref={sheetRef}
          className="org-chart-canvas-sheet"
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: '0 0',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
