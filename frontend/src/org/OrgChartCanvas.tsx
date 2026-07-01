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

const MIN_SCALE = 0.12
const MAX_SCALE = 2.5
const ZOOM_STEP = 1.4
const PINCH_ZOOM_SENSITIVITY = 0.0046
const FIT_MARGIN = 36

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function pinchZoomFactor(deltaY: number): number {
  const delta = clamp(-deltaY, -120, 120)
  return Math.exp(delta * PINCH_ZOOM_SENSITIVITY)
}

function isPinchZoomWheel(event: WheelEvent): boolean {
  return event.ctrlKey || event.metaKey
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, label'))
}

export default function OrgChartCanvas({ children }: OrgChartCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const scaleRef = useRef(1)
  const translateRef = useRef<Point>({ x: 0, y: 0 })
  const gestureStartScaleRef = useRef(1)
  const userAdjustedRef = useRef(false)
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState<Point>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  const setTranslateBoth = useCallback((next: Point) => {
    translateRef.current = next
    setTranslate(next)
  }, [])

  const fitToView = useCallback(() => {
    const stage = stageRef.current
    const sheet = sheetRef.current
    if (!stage || !sheet) return

    const stageWidth = stage.clientWidth
    const stageHeight = stage.clientHeight
    const contentWidth = sheet.offsetWidth
    const contentHeight = sheet.offsetHeight
    if (contentWidth <= 0 || contentHeight <= 0) return

    const scaleX = (stageWidth - FIT_MARGIN * 2) / contentWidth
    const scaleY = (stageHeight - FIT_MARGIN * 2) / contentHeight
    const nextScale = clamp(Math.min(scaleX, scaleY, 1), MIN_SCALE, MAX_SCALE)

    userAdjustedRef.current = false
    scaleRef.current = nextScale
    setScale(nextScale)
    setTranslateBoth({
      x: (stageWidth - contentWidth * nextScale) / 2,
      y: (stageHeight - contentHeight * nextScale) / 2,
    })
  }, [setTranslateBoth])

  const markUserAdjusted = useCallback(() => {
    userAdjustedRef.current = true
  }, [])

  const applyZoom = useCallback(
    (nextScale: number, anchorX: number, anchorY: number) => {
      const currentScale = scaleRef.current
      const currentTranslate = translateRef.current
      const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE)
      if (clamped === currentScale) return

      const worldX = (anchorX - currentTranslate.x) / currentScale
      const worldY = (anchorY - currentTranslate.y) / currentScale
      const nextTranslate = {
        x: anchorX - worldX * clamped,
        y: anchorY - worldY * clamped,
      }

      markUserAdjusted()
      scaleRef.current = clamped
      translateRef.current = nextTranslate
      setScale(clamped)
      setTranslate(nextTranslate)
    },
    [markUserAdjusted],
  )

  const applyPan = useCallback(
    (deltaX: number, deltaY: number) => {
      markUserAdjusted()
      setTranslateBoth({
        x: translateRef.current.x - deltaX,
        y: translateRef.current.y - deltaY,
      })
    },
    [markUserAdjusted, setTranslateBoth],
  )

  useEffect(() => {
    userAdjustedRef.current = false
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => fitToView())
    })
    return () => cancelAnimationFrame(frame)
  }, [children, fitToView])

  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet || typeof ResizeObserver === 'undefined') return

    let frame = 0
    const observer = new ResizeObserver(() => {
      if (userAdjustedRef.current) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => fitToView())
    })
    observer.observe(sheet)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [children, fitToView])

  useEffect(() => {
    const onResize = () => {
      if (userAdjustedRef.current) return
      requestAnimationFrame(() => fitToView())
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fitToView])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()

      if (isPinchZoomWheel(event)) {
        const rect = stage.getBoundingClientRect()
        applyZoom(
          scaleRef.current * pinchZoomFactor(event.deltaY),
          event.clientX - rect.left,
          event.clientY - rect.top,
        )
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
    markUserAdjusted()
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
          <button
            type="button"
            className="btn-ghost org-chart-canvas-btn"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            aria-label="Уменьшить"
            title="Уменьшить"
          >
            −
          </button>
          <button
            type="button"
            className="org-chart-canvas-zoom"
            onClick={fitToView}
            title="Вписать схему в экран"
            aria-label={`Масштаб ${zoomPercent}%, вписать в экран`}
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            className="btn-ghost org-chart-canvas-btn"
            onClick={() => zoomBy(ZOOM_STEP)}
            aria-label="Увеличить"
            title="Увеличить"
          >
            +
          </button>
          <span className="org-chart-canvas-toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            className="btn-ghost org-chart-canvas-reset"
            onClick={fitToView}
            title="Вписать схему в экран"
          >
            Вписать
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
