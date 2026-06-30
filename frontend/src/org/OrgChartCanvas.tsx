import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

type OrgChartCanvasProps = {
  children: ReactNode
}

type Point = { x: number; y: number }

interface SafariGestureEvent extends Event {
  scale: number
  clientX: number
  clientY: number
}

const MIN_SCALE = 0.35
const MAX_SCALE = 2
const ZOOM_STEP = 1.08
const WHEEL_ZOOM_SENSITIVITY = 0.0016

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function wheelZoomFactor(deltaY: number): number {
  const delta = clamp(-deltaY, -100, 100)
  return Math.exp(delta * WHEEL_ZOOM_SENSITIVITY)
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, label'))
}

function isPinchZoomWheel(event: WheelEvent): boolean {
  return event.ctrlKey || event.metaKey
}

export default function OrgChartCanvas({ children }: OrgChartCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const scaleRef = useRef(1)
  const translateRef = useRef<Point>({ x: 0, y: 0 })
  const gestureStartScaleRef = useRef(1)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState<Point>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  const setTranslateBoth = useCallback((next: Point | ((current: Point) => Point)) => {
    setTranslate((current) => {
      const resolved = typeof next === 'function' ? next(current) : next
      translateRef.current = resolved
      return resolved
    })
  }, [])

  const centerSheet = useCallback((nextScale = scaleRef.current) => {
    const stage = stageRef.current
    const sheet = sheetRef.current
    if (!stage || !sheet) return
    const stageRect = stage.getBoundingClientRect()
    const sheetRect = sheet.getBoundingClientRect()
    const sheetWidth = sheetRect.width / nextScale
    const sheetHeight = sheetRect.height / nextScale
    setTranslateBoth({
      x: (stageRect.width - sheetWidth * nextScale) / 2,
      y: Math.max(24, (stageRect.height - sheetHeight * nextScale) / 2),
    })
  }, [setTranslateBoth])

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  useEffect(() => {
    translateRef.current = translate
  }, [translate])

  const applyZoom = useCallback((nextScale: number, anchorX: number, anchorY: number) => {
    const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE)
    setScale((currentScale) => {
      setTranslateBoth((currentTranslate) => {
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
  }, [setTranslateBoth])

  const applyPan = useCallback(
    (deltaX: number, deltaY: number) => {
      setTranslateBoth((current) => ({
        x: current.x - deltaX,
        y: current.y - deltaY,
      }))
    },
    [setTranslateBoth],
  )

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

      if (isPinchZoomWheel(event)) {
        applyZoom(scaleRef.current * wheelZoomFactor(event.deltaY), anchorX, anchorY)
        return
      }

      applyPan(event.deltaX, event.deltaY)
    }

    const onGestureStart = (event: Event) => {
      event.preventDefault()
      gestureStartScaleRef.current = scaleRef.current
    }

    const onGestureChange = (event: Event) => {
      event.preventDefault()
      const gesture = event as SafariGestureEvent
      const rect = stage.getBoundingClientRect()
      applyZoom(
        gestureStartScaleRef.current * gesture.scale,
        gesture.clientX - rect.left,
        gesture.clientY - rect.top,
      )
    }

    const onGestureEnd = (event: Event) => {
      event.preventDefault()
    }

    stage.addEventListener('wheel', onWheel, { passive: false })
    stage.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false })
    stage.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false })
    stage.addEventListener('gestureend', onGestureEnd as EventListener, { passive: false })

    return () => {
      stage.removeEventListener('wheel', onWheel)
      stage.removeEventListener('gesturestart', onGestureStart as EventListener)
      stage.removeEventListener('gesturechange', onGestureChange as EventListener)
      stage.removeEventListener('gestureend', onGestureEnd as EventListener)
    }
  }, [applyPan, applyZoom])

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
      tx: translateRef.current.x,
      ty: translateRef.current.y,
    }
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    setTranslateBoth({
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
      <div
        ref={stageRef}
        className={`org-chart-canvas-stage${dragging ? ' org-chart-canvas-stage-dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <div
          className="org-chart-canvas-toolbar"
          aria-label="Масштаб схемы"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" className="btn-ghost org-chart-canvas-btn" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Уменьшить">
            −
          </button>
          <span className="org-chart-canvas-zoom">{zoomPercent}%</span>
          <button type="button" className="btn-ghost org-chart-canvas-btn" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Увеличить">
            +
          </button>
          <span className="org-chart-canvas-toolbar-divider" aria-hidden="true" />
          <button type="button" className="btn-ghost org-chart-canvas-reset" onClick={resetView}>
            По центру
          </button>
        </div>
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
