import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import mermaid from 'mermaid'

type DiagramKind = 'mindmap' | 'flowchart' | 'sequence' | 'bpmn' | 'wave' | 'board'

type KindPreset = {
  id: DiagramKind
  label: string
  title: string
  starter: string
}

type Point = { x: number; y: number }

type DiagramPreviewCanvasProps = {
  content: ReactNode
  contentKey: string
}

const CANVAS_MIN_SCALE = 0.12
const CANVAS_MAX_SCALE = 2.5
const CANVAS_ZOOM_STEP = 1.4
const CANVAS_PINCH_SENSITIVITY = 0.0046
const CANVAS_FIT_MARGIN = 28

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function pinchZoomFactor(deltaY: number): number {
  const delta = clamp(-deltaY, -120, 120)
  return Math.exp(delta * CANVAS_PINCH_SENSITIVITY)
}

function isPinchZoomWheel(event: WheelEvent): boolean {
  return event.ctrlKey || event.metaKey
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, label'))
}

function DiagramPreviewCanvas({ content, contentKey }: DiagramPreviewCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const scaleRef = useRef(1)
  const translateRef = useRef<Point>({ x: 0, y: 0 })
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
    const scaleX = (stageWidth - CANVAS_FIT_MARGIN * 2) / contentWidth
    const scaleY = (stageHeight - CANVAS_FIT_MARGIN * 2) / contentHeight
    const nextScale = clamp(Math.min(scaleX, scaleY, 1), CANVAS_MIN_SCALE, CANVAS_MAX_SCALE)
    userAdjustedRef.current = false
    scaleRef.current = nextScale
    setScale(nextScale)
    setTranslateBoth({
      x: (stageWidth - contentWidth * nextScale) / 2,
      y: (stageHeight - contentHeight * nextScale) / 2,
    })
  }, [setTranslateBoth])

  const centerAtDefaultScale = useCallback(() => {
    const stage = stageRef.current
    const sheet = sheetRef.current
    if (!stage || !sheet) return
    const stageWidth = stage.clientWidth
    const stageHeight = stage.clientHeight
    const contentWidth = sheet.offsetWidth
    const contentHeight = sheet.offsetHeight
    if (contentWidth <= 0 || contentHeight <= 0) return
    const defaultScale = 1
    userAdjustedRef.current = false
    scaleRef.current = defaultScale
    setScale(defaultScale)
    setTranslateBoth({
      x: (stageWidth - contentWidth * defaultScale) / 2,
      y: (stageHeight - contentHeight * defaultScale) / 2,
    })
  }, [setTranslateBoth])

  const applyZoom = useCallback((nextScale: number, anchorX: number, anchorY: number) => {
    const currentScale = scaleRef.current
    const currentTranslate = translateRef.current
    const clamped = clamp(nextScale, CANVAS_MIN_SCALE, CANVAS_MAX_SCALE)
    if (clamped === currentScale) return
    const worldX = (anchorX - currentTranslate.x) / currentScale
    const worldY = (anchorY - currentTranslate.y) / currentScale
    const nextTranslate = {
      x: anchorX - worldX * clamped,
      y: anchorY - worldY * clamped,
    }
    userAdjustedRef.current = true
    scaleRef.current = clamped
    setScale(clamped)
    setTranslateBoth(nextTranslate)
  }, [setTranslateBoth])

  useEffect(() => {
    userAdjustedRef.current = false
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => centerAtDefaultScale()))
    return () => cancelAnimationFrame(frame)
  }, [centerAtDefaultScale, contentKey])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (isPinchZoomWheel(event)) {
        const rect = stage.getBoundingClientRect()
        applyZoom(scaleRef.current * pinchZoomFactor(event.deltaY), event.clientX - rect.left, event.clientY - rect.top)
        return
      }
      userAdjustedRef.current = true
      setTranslateBoth({
        x: translateRef.current.x - event.deltaX,
        y: translateRef.current.y - event.deltaY,
      })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [applyZoom, setTranslateBoth])

  const zoomBy = (factor: number) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    applyZoom(scaleRef.current * factor, rect.width / 2, rect.height / 2)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return
    const stage = stageRef.current
    if (!stage) return
    stage.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, tx: translateRef.current.x, ty: translateRef.current.y }
    setDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    userAdjustedRef.current = true
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

  return (
    <div
      ref={stageRef}
      className={`diagram-canvas${dragging ? ' diagram-canvas-dragging' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={fitToView}
    >
      <div className="diagram-canvas-toolbar" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" className="btn-ghost diagram-canvas-btn" onClick={() => zoomBy(1 / CANVAS_ZOOM_STEP)}>−</button>
        <button type="button" className="diagram-canvas-zoom" onClick={fitToView}>{Math.round(scale * 100)}%</button>
        <button type="button" className="btn-ghost diagram-canvas-btn" onClick={() => zoomBy(CANVAS_ZOOM_STEP)}>+</button>
        <button type="button" className="btn-ghost diagram-canvas-reset" onClick={fitToView}>Вписать</button>
      </div>
      <div
        ref={sheetRef}
        className="diagram-canvas-sheet"
        style={{ transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`, transformOrigin: '0 0' }}
      >
        {content}
      </div>
    </div>
  )
}

const DIAGRAM_STORAGE_KEY = 'reporting.diagramBuilder.v1'

type DiagramStorage = Partial<Record<DiagramKind, string>>

function readDiagramStorage(): DiagramStorage {
  try {
    const raw = localStorage.getItem(DIAGRAM_STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as DiagramStorage
  } catch {
    return {}
  }
}

function writeDiagramStorage(storage: DiagramStorage): void {
  localStorage.setItem(DIAGRAM_STORAGE_KEY, JSON.stringify(storage))
}

function normalizeMindmapSource(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'mindmap\n  root((Новая структура))'
  if (/^mindmap\b/i.test(trimmed)) return input

  const rawLines = input
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => line.trim().length > 0)

  if (rawLines.length === 0) return 'mindmap\n  root((Новая структура))'

  const firstWords = rawLines[0].trim().split(/\s+/).length
  const rootLineIndex = firstWords > 8 && rawLines.length > 1 ? 1 : 0
  const rootLabel = rawLines[rootLineIndex].trim()
  const contentLines = rawLines.slice(rootLineIndex + 1)

  const lines = ['mindmap', `  root((${rootLabel}))`]
  for (const line of contentLines) {
    const text = line.trim()
    if (!text) continue
    const leadingSpaces = line.match(/^\s*/)?.[0].length ?? 0
    const baseLevel = Math.floor(leadingSpaces / 4)
    const depth = Math.max(1, baseLevel)
    lines.push(`${'  '.repeat(depth + 1)}${text}`)
  }
  return lines.join('\n')
}

function normalizeFlowchartSource(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'flowchart LR\n  Root["Новая структура"]'
  if (/^flowchart\b/i.test(trimmed) || /^graph\b/i.test(trimmed)) return input

  const lines = input
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) return 'flowchart LR\n  Root["Новая структура"]'

  const nodes: Array<{ id: string; label: string; level: number }> = []
  const levelStack: number[] = []
  let idCounter = 0

  for (const line of lines) {
    const label = line.trim().replace(/"/g, '\\"')
    const spaces = line.match(/^\s*/)?.[0].length ?? 0
    const level = Math.floor(spaces / 4)
    const nodeId = `N${idCounter}`
    idCounter += 1
    nodes.push({ id: nodeId, label, level })
    levelStack.push(level)
  }

  const result: string[] = ['flowchart LR']
  for (const node of nodes) {
    result.push(`  ${node.id}["${node.label}"]`)
  }

  const parentByIndex: Array<number | null> = new Array(nodes.length).fill(null)
  for (let i = 1; i < nodes.length; i += 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (nodes[j].level < nodes[i].level) {
        parentByIndex[i] = j
        break
      }
    }
    if (parentByIndex[i] === null) {
      parentByIndex[i] = i - 1
    }
  }

  for (let i = 1; i < nodes.length; i += 1) {
    const parentIndex = parentByIndex[i]
    if (parentIndex == null) continue
    result.push(`  ${nodes[parentIndex].id} --> ${nodes[i].id}`)
  }

  return result.join('\n')
}

function normalizeSequenceSource(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'sequenceDiagram\n  participant A as Алиса\n  A->>A: Новый сценарий'
  if (/^sequenceDiagram\b/i.test(trimmed)) return input

  const lines = input
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const out: string[] = ['sequenceDiagram']
  const actorAlias = new Map<string, string>()
  const normalizeActor = (name: string): string => {
    const trimmedName = name.trim()
    return actorAlias.get(trimmedName) ?? trimmedName
  }

  for (const line of lines) {
    const raw = line

    let match = raw.match(/^участник\s+(.+?)\s+как\s+(.+)$/i)
    if (match) {
      const actorName = match[1].trim()
      const alias = match[2].trim()
      actorAlias.set(actorName, alias)
      out.push(`  participant ${alias} as ${actorName}`)
      continue
    }
    match = raw.match(/^участник\s+(.+)$/i)
    if (match) {
      const actorName = match[1].trim()
      actorAlias.set(actorName, actorName)
      out.push(`  participant ${actorName}`)
      continue
    }
    if (/^автонумерация$/i.test(raw)) {
      out.push('  autonumber')
      continue
    }

    match = raw.match(/^начало комментария\s*:?\s*(.+)$/i)
    if (match) {
      out.push(`  rect rgba(245, 245, 245, 0.7)`)
      out.push(`  Note over ${match[1].trim()}: ${match[1].trim()}`)
      continue
    }
    if (/^конец комментария$/i.test(raw)) {
      out.push('  end')
      continue
    }

    match = raw.match(/^начало ветки\s+(.+)$/i)
    if (match) {
      out.push(`  alt ${match[1].trim()}`)
      continue
    }
    if (/^иначе$/i.test(raw)) {
      out.push('  else Иначе')
      continue
    }
    if (/^конец ветки$/i.test(raw)) {
      out.push('  end')
      continue
    }

    match = raw.match(/^начало цикла\s+(.+)$/i)
    if (match) {
      out.push(`  loop ${match[1].trim()}`)
      continue
    }
    if (/^конец цикла$/i.test(raw)) {
      out.push('  end')
      continue
    }

    match = raw.match(/^начало параллельных действий\s+(.+)$/i)
    if (match) {
      out.push(`  par ${match[1].trim()}`)
      continue
    }
    if (/^и$/i.test(raw)) {
      out.push('  and')
      continue
    }
    if (/^конец параллельных действий$/i.test(raw)) {
      out.push('  end')
      continue
    }

    match = raw.match(/^завершить\s+(.+)$/i)
    if (match) {
      out.push(`  destroy ${normalizeActor(match[1])}`)
      continue
    }

    if (raw.includes('->') || raw.includes('-->')) {
      const messageMatch = raw.match(/^(.+?)\s*(-->|->)\s*(.+?)\s*:\s*(.+)$/)
      if (messageMatch) {
        const from = normalizeActor(messageMatch[1])
        const to = normalizeActor(messageMatch[3])
        const arrow = messageMatch[2] === '-->' ? '-->>' : '->>'
        out.push(`  ${from}${arrow}${to}: ${messageMatch[4].trim()}`)
        continue
      }
      const selfMessageMatch = raw.match(/^(.+?)\s*(-->|->)\s*(.+)$/)
      if (selfMessageMatch) {
        const actor = normalizeActor(selfMessageMatch[1])
        const arrow = selfMessageMatch[2] === '-->' ? '-->>' : '->>'
        out.push(`  ${actor}${arrow}${actor}: ${selfMessageMatch[3].trim()}`)
        continue
      }
      const normalized = raw.replace(/\s*-->\s*/g, '-->>').replace(/\s*->\s*/g, '->>')
      out.push(`  ${normalized}`)
      continue
    }

    out.push(`  Note over System: ${raw}`)
  }

  return out.join('\n')
}

function sanitizeNodeId(label: string, used: Set<string>): string {
  const base = (label.toLowerCase().match(/[a-zа-я0-9]+/gi)?.join('_') ?? 'node').replace(/_{2,}/g, '_')
  let id = base || 'node'
  let idx = 1
  while (used.has(id)) {
    id = `${base}_${idx}`
    idx += 1
  }
  used.add(id)
  return id
}

function normalizeBpmnSource(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'flowchart LR\n  start([Старт])\n  start --> end([Финиш])'
  if (/^flowchart\b/i.test(trimmed) || /^graph\b/i.test(trimmed)) return input

  const lines = input
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const usedIds = new Set<string>()
  const idByLabel = new Map<string, string>()
  const laneNodes = new Map<string, string[]>()
  const edges: string[] = []
  const notes: string[] = []
  let currentLane = 'Процесс'

  const ensureNode = (label: string, kind: 'event' | 'task' | 'gateway' | 'plain' = 'plain') => {
    const key = label.trim()
    const existing = idByLabel.get(key)
    if (existing) return existing
    const id = sanitizeNodeId(key, usedIds)
    let node = `${id}[${key}]`
    if (kind === 'event') node = `${id}((${key}))`
    if (kind === 'gateway') node = `${id}{${key}}`
    idByLabel.set(key, id)
    const bucket = laneNodes.get(currentLane) ?? []
    bucket.push(node)
    laneNodes.set(currentLane, bucket)
    return id
  }

  for (const line of lines) {
    const laneMatch = line.match(/^дорожка:\s*(.+)$/i)
    if (laneMatch) {
      currentLane = laneMatch[1].trim() || 'Процесс'
      if (!laneNodes.has(currentLane)) laneNodes.set(currentLane, [])
      continue
    }

    if (/^процесс:\s*/i.test(line)) continue

    let m = line.match(/^событие:\s*([^()]+)(?:\(.+\))?$/i)
    if (m) {
      ensureNode(m[1].trim(), 'event')
      continue
    }
    m = line.match(/^задача:\s*([^()]+)(?:\(.+\))?$/i)
    if (m) {
      ensureNode(m[1].trim(), 'task')
      continue
    }
    m = line.match(/^шлюз:\s*([^()]+)(?:\(.+\))?$/i)
    if (m) {
      ensureNode(m[1].trim(), 'gateway')
      continue
    }

    const noteMatch = line.match(/^\/\/\s*аннотация:\s*(.+)$/i)
    if (noteMatch) {
      notes.push(noteMatch[1].trim())
      continue
    }

    const edgeMatch = line.match(/^(.+?)\s*(-{1,2}|~~)\>\s*(.+?)(?:\s*:\s*(.+))?$/)
    if (edgeMatch) {
      const fromLabel = edgeMatch[1].trim()
      const toLabel = edgeMatch[3].trim()
      const label = edgeMatch[4]?.trim()
      const fromId = ensureNode(fromLabel)
      const toId = ensureNode(toLabel)
      const arrow = edgeMatch[2] === '~~' ? '-.->' : '-->'
      edges.push(`  ${fromId} ${arrow}${label ? `|${label}|` : ''} ${toId}`)
      continue
    }
  }

  const out: string[] = ['flowchart LR']
  for (const [lane, nodes] of laneNodes.entries()) {
    out.push(`  subgraph ${sanitizeNodeId(lane, usedIds)}["${lane}"]`)
    if (nodes.length === 0) {
      const ghostId = sanitizeNodeId(`${lane}_empty`, usedIds)
      out.push(`    ${ghostId}[" "]`)
    } else {
      for (const node of nodes) out.push(`    ${node}`)
    }
    out.push('  end')
  }
  if (notes.length > 0 && edges.length > 0) {
    out.push(`  %% ${notes.join(' | ')}`)
  }
  out.push(...edges)
  if (edges.length === 0 && idByLabel.size > 1) {
    const ids = [...idByLabel.values()]
    for (let i = 0; i < ids.length - 1; i += 1) {
      out.push(`  ${ids[i]} --> ${ids[i + 1]}`)
    }
  }
  return out.join('\n')
}

function normalizeBoardSource(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'flowchart LR\n  todo["Сделать задачу"]'
  if (/^flowchart\b/i.test(trimmed) || /^graph\b/i.test(trimmed)) return input

  const lines = input
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  const used = new Set<string>()
  const out: string[] = ['flowchart LR']
  const laneNodes = new Map<string, string[]>()
  const laneOrder: string[] = []
  const laneIdByTitle = new Map<string, string>()
  const laneFirstNode = new Map<string, string>()
  const laneLastNode = new Map<string, string>()
  let currentLane = 'Сделать'
  let currentTaskId: string | null = null

  const ensureLane = (title: string) => {
    if (!laneNodes.has(title)) {
      laneNodes.set(title, [])
      laneOrder.push(title)
      laneIdByTitle.set(title, sanitizeNodeId(`lane_${title}`, used))
    }
  }

  ensureLane(currentLane)

  const pushTask = (rawTaskLine: string) => {
    const payload = rawTaskLine.replace(/^задача:\s*/i, '').trim()
    const details: string[] = []

    const date = payload.match(/\b(?:дата|до):\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i)?.[1]
    if (date) details.push(`Дата: ${date}`)

    const owner = payload.match(/@([^\s]+)/)?.[1]
    if (owner) details.push(`Ответственный: ${owner}`)

    const urgency = payload.match(/\b(срочно|важно)\b/i)?.[1]
    if (urgency) details.push(`Приоритет: ${urgency}`)

    const tags = [...payload.matchAll(/тег:([^\s(]+)(?:\([^)]+\))?/gi)].map((m) => m[1])
    if (tags.length > 0) details.push(`Теги: ${tags.join(', ')}`)

    const cleanTitle = payload
      .replace(/@[^\s]+/g, '')
      .replace(/\b(?:дата|до):\s*[0-9]{4}-[0-9]{2}-[0-9]{2}/gi, '')
      .replace(/\b(?:срочно|важно)\b/gi, '')
      .replace(/тег:[^\s(]+(?:\([^)]+\))?/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()

    const labelParts = [cleanTitle || 'Задача', ...details]
    const label = labelParts.join('<br/>').replace(/"/g, '\\"')
    const id = sanitizeNodeId(`task_${cleanTitle || 'task'}`, used)
    const node = `${id}["${label}"]`
    laneNodes.get(currentLane)!.push(node)

    if (!laneFirstNode.has(currentLane)) laneFirstNode.set(currentLane, id)
    const prev = laneLastNode.get(currentLane)
    if (prev) out.push(`  ${prev} --> ${id}`)
    laneLastNode.set(currentLane, id)

    currentTaskId = id
  }

  for (const raw of lines) {
    const line = raw.trim()
    const columnMatch = line.match(/^колонка\s+(.+)$/i)
    if (columnMatch) {
      currentLane = columnMatch[1].trim()
      ensureLane(currentLane)
      currentTaskId = null
      continue
    }
    if (/^задача:/i.test(line)) {
      pushTask(line)
      continue
    }
    if ((raw.startsWith(' ') || raw.startsWith('    ')) && currentTaskId) {
      const note = line.replace(/"/g, '\\"')
      const noteId = sanitizeNodeId(`note_${note}`, used)
      out.push(`  ${noteId}["• ${note}"]`)
      out.push(`  ${currentTaskId} -.-> ${noteId}`)
      continue
    }
  }

  for (const lane of laneOrder) {
    out.push(`  subgraph ${laneIdByTitle.get(lane)}["${lane}"]`)
    const nodes = laneNodes.get(lane) ?? []
    if (nodes.length === 0) {
      const ghost = sanitizeNodeId(`empty_${lane}`, used)
      out.push(`    ${ghost}[ ]`)
    } else {
      for (const node of nodes) out.push(`    ${node}`)
    }
    out.push('  end')
  }

  for (let i = 0; i < laneOrder.length - 1; i += 1) {
    const from = laneOrder[i]
    const to = laneOrder[i + 1]
    const fromId = laneLastNode.get(from)
    const toId = laneFirstNode.get(to)
    if (fromId && toId) out.push(`  ${fromId} ==> ${toId}`)
  }

  return out.join('\n')
}

function normalizeWaveSource(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'flowchart LR\n  A["Источник"] -->|100| B["Цель"]'
  if (/^flowchart\b/i.test(trimmed) || /^graph\b/i.test(trimmed) || /^sankey-beta\b/i.test(trimmed)) {
    return input
  }

  const lines = input
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const used = new Set<string>()
  const idByLabel = new Map<string, string>()
  const edges: Array<{ from: string; to: string; value: string }> = []

  const ensureId = (label: string): string => {
    const key = label.trim()
    const existing = idByLabel.get(key)
    if (existing) return existing
    const id = sanitizeNodeId(key, used)
    idByLabel.set(key, id)
    return id
  }

  for (const line of lines) {
    const m = line.match(/^(.+?)\s*->\s*(.+?)\s*:\s*([0-9]+(?:[.,][0-9]+)?)$/)
    if (!m) continue
    const from = m[1].trim()
    const to = m[2].trim()
    const value = m[3].replace(',', '.')
    ensureId(from)
    ensureId(to)
    edges.push({ from, to, value })
  }

  if (edges.length === 0) {
    return 'flowchart LR\n  A["Источник"] -->|100| B["Цель"]'
  }

  const out: string[] = ['flowchart LR']
  for (const [label, id] of idByLabel.entries()) {
    out.push(`  ${id}["${label.replace(/"/g, '\\"')}"]`)
  }
  for (const edge of edges) {
    out.push(`  ${idByLabel.get(edge.from)} -->|${edge.value}| ${idByLabel.get(edge.to)}`)
  }
  return out.join('\n')
}

const PRESETS: KindPreset[] = [
  {
    id: 'mindmap',
    label: 'Радиальный',
    title: 'Радиальная структура',
    starter: `mindmap
  root((Digital IT))
    Разработка
      Backend
      Frontend
      QA
    Интеграции
      CRM
      ESB
    Операции
      Мониторинг
      Поддержка`,
  },
  {
    id: 'flowchart',
    label: 'Иерархический',
    title: 'Иерархическая диаграмма',
    starter: `flowchart LR
  CEO[Руководитель IT]
  Head1[Head разработки]
  Head2[Head аналитики]
  Team1[Backend]
  Team2[Frontend]
  Team3[BI]
  CEO --> Head1
  CEO --> Head2
  Head1 --> Team1
  Head1 --> Team2
  Head2 --> Team3`,
  },
  {
    id: 'sequence',
    label: 'Последовательность',
    title: 'Последовательность процесса',
    starter: `sequenceDiagram
  participant Biz as Бизнес
  participant PO as Product Owner
  participant Dev as Разработка
  participant QA as QA
  Biz->>PO: Инициирует задачу
  PO->>Dev: Передаёт требования
  Dev->>QA: Отдаёт на проверку
  QA->>Biz: Подтверждает готовность`,
  },
  {
    id: 'bpmn',
    label: 'BPMN',
    title: 'BPMN-процесс',
    starter: `flowchart LR
  Start([Старт])
  Task1[Сбор требований]
  Gate{Согласовано?}
  Task2[Разработка]
  Task3[Уточнение]
  End([Финиш])
  Start --> Task1 --> Gate
  Gate -- Да --> Task2 --> End
  Gate -- Нет --> Task3 --> Task1`,
  },
  {
    id: 'wave',
    label: 'Волнообразная',
    title: 'Волнообразный план',
    starter: `timeline
  title Волнообразный цикл поставки
  Q1 : Аналитика
     : Архитектура
  Q2 : Разработка
     : Интеграция
  Q3 : Пилот
     : Обратная связь
  Q4 : Тиражирование`,
  },
  {
    id: 'board',
    label: 'Доска проектов',
    title: 'Проектная доска',
    starter: `flowchart LR
  subgraph Backlog
    A[CRM API]
    B[ESB адаптер]
  end
  subgraph InProgress[В работе]
    C[Миграция клиентов]
    D[Личный кабинет B2B]
  end
  subgraph Done[Готово]
    E[Мониторинг SLA]
  end
  A --> C
  B --> D
  C --> E`,
  },
]

let renderCounter = 0

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'default',
})

export default function DiagramBuilder() {
  const stored = useMemo(() => readDiagramStorage(), [])
  const [kind, setKind] = useState<DiagramKind>('mindmap')
  const [source, setSource] = useState(stored.mindmap ?? PRESETS[0].starter)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)

  const activePreset = useMemo(() => PRESETS.find((preset) => preset.id === kind) ?? PRESETS[0], [kind])

  useEffect(() => {
    let mounted = true
    const render = async () => {
      try {
        const sourceToRender =
          kind === 'mindmap'
            ? normalizeMindmapSource(source)
            : kind === 'flowchart'
              ? normalizeFlowchartSource(source)
              : kind === 'sequence'
                ? normalizeSequenceSource(source)
                : kind === 'bpmn'
                  ? normalizeBpmnSource(source)
                  : kind === 'board'
                    ? normalizeBoardSource(source)
                    : kind === 'wave'
                      ? normalizeWaveSource(source)
              : source
        renderCounter += 1
        const elementId = `diagram-builder-${renderCounter}`
        const { svg: nextSvg } = await mermaid.render(elementId, sourceToRender)
        if (!mounted) return
        setSvg(nextSvg)
        setError(null)
      } catch (err) {
        if (!mounted) return
        setSvg('')
        setError(err instanceof Error ? err.message : 'Ошибка построения диаграммы')
      }
    }
    void render()
    return () => {
      mounted = false
    }
  }, [kind, source])

  useEffect(() => {
    const current = readDiagramStorage()
    writeDiagramStorage({ ...current, [kind]: source })
  }, [kind, source])

  const applyPreset = (nextKind: DiagramKind) => {
    const preset = PRESETS.find((item) => item.id === nextKind)
    setKind(nextKind)
    const saved = readDiagramStorage()[nextKind]
    if (saved) {
      setSource(saved)
      return
    }
    if (preset) setSource(preset.starter)
  }

  return (
    <div className={`diagram-page app${kind === 'mindmap' ? ' diagram-page-radial' : ''}`}>
      <header className="diagram-header">
        <h1 className="diagram-title">Диаграммы</h1>
        <p className="diagram-subtitle">Радиальный, Иерархический, Последовательность, BPMN, Волнообразная, Доска проектов.</p>
      </header>

      <nav className="diagram-kind-tabs" aria-label="Тип диаграммы">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`diagram-kind-tab${preset.id === kind ? ' diagram-kind-tab-active' : ''}`}
            onClick={() => applyPreset(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </nav>

      <section className="table-section diagram-workspace">
        <div className="diagram-editor">
          <h2>{activePreset.title}</h2>
          <textarea
            className="diagram-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="diagram-preview">
          <h2>Предпросмотр</h2>
          {error ? (
            <p className="banner-error">Не удалось построить диаграмму. Проверьте формат текста для выбранного типа.</p>
          ) : (
            <DiagramPreviewCanvas
              contentKey={`${kind}:${svg.length}`}
              content={
                <div
                  className={`diagram-svg${kind === 'mindmap' ? ' diagram-svg-radial' : ''}`}
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              }
            />
          )}
        </div>
      </section>
    </div>
  )
}
