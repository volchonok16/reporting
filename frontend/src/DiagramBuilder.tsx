import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import mermaid from 'mermaid'

type DiagramKind = 'mindmap' | 'flowchart' | 'sequence' | 'bpmn' | 'wave' | 'board'
type DiagramTheme = 'default' | 'forest' | 'dark' | 'neutral' | 'neon' | 'ocean' | 'pastel'

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
const CANVAS_MAX_SCALE = 6.2
const CANVAS_ZOOM_STEP = 1.4
const CANVAS_PINCH_SENSITIVITY = 0.0046
const CANVAS_FIT_MARGIN = 28
const CANVAS_BASE_SCALE = 1.55
const THEME_OPTIONS: Array<{ id: DiagramTheme; label: string }> = [
  { id: 'default', label: 'Default' },
  { id: 'forest', label: 'Forest' },
  { id: 'dark', label: 'Dark' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'neon', label: 'Neon' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'pastel', label: 'Pastel' },
]

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
    const defaultScale = CANVAS_BASE_SCALE
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
          <button type="button" className="diagram-canvas-zoom" onClick={fitToView}>
            {Math.round((scale / CANVAS_BASE_SCALE) * 100)}%
          </button>
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
type BoardTask = {
  name: string
  column: string
  assignee: string
  priority: 'обычная' | 'срочно' | 'важно'
  tags: Array<{ text: string; color: string | null }>
  dueDate: string
  description: string
}
type BoardData = { columns: Array<{ name: string }>; tasks: BoardTask[] }
type TreeNode = { text: string; level: number; children: TreeNode[]; x: number; y: number; width: number; height: number }

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

function parseBoardData(text: string): BoardData | null {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return null

  const colorNames: Record<string, string> = {
    красный: '#ef4444', оранжевый: '#f97316', жёлтый: '#eab308', зеленый: '#22c55e', зелёный: '#22c55e',
    голубой: '#06b6d4', синий: '#3b82f6', фиолетовый: '#8b5cf6', розовый: '#ec4899', серый: '#6b7280',
    чёрный: '#1f2937', белый: '#ffffff', коричневый: '#92400e', бирюзовый: '#14b8a6', лайм: '#84cc16', индиго: '#6366f1',
  }

  const columns: Array<{ name: string }> = []
  const tasks: BoardTask[] = []
  let currentColumn: string | null = null
  let pendingTask: BoardTask | null = null
  let descriptionLines: string[] = []

  const savePendingTask = () => {
    if (!pendingTask) return
    pendingTask.description = descriptionLines.join('\n')
    tasks.push(pendingTask)
    pendingTask = null
    descriptionLines = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    const leadingSpaces = line.match(/^[ ]*/)?.[0].length ?? 0
    const isDescriptionLine = leadingSpaces >= 4 || /^Описание:/i.test(trimmed)
    if (isDescriptionLine && pendingTask) {
      const textLine = trimmed.replace(/^Описание:\s*/i, '')
      descriptionLines.push(textLine)
      continue
    }

    const colMatch = trimmed.match(/^колонка\s+(.+)$/i)
    if (colMatch) {
      savePendingTask()
      currentColumn = colMatch[1].trim()
      columns.push({ name: currentColumn })
      continue
    }

    const taskMatch = trimmed.match(/^задача:\s*(.+)$/i)
    if (taskMatch && currentColumn) {
      savePendingTask()
      const details = taskMatch[1].trim()
      let name = details
      let assignee = ''
      let priority: BoardTask['priority'] = 'обычная'
      const tags: BoardTask['tags'] = []
      let dueDate = ''

      const assigneeMatch = details.match(/@(\S+)/)
      if (assigneeMatch) {
        assignee = assigneeMatch[1]
        name = name.replace(assigneeMatch[0], '').trim()
      }
      if (details.includes('срочно') || details.includes('важно')) {
        priority = details.includes('срочно') ? 'срочно' : 'важно'
        name = name.replace(/срочно|важно/gi, '').trim()
      }
      const tagRegex = /тег:\s*([^(\s]+)(?:\(([^)]+)\))?/gi
      let tagMatch: RegExpExecArray | null
      while ((tagMatch = tagRegex.exec(details)) !== null) {
        const label = tagMatch[1]
        let color: string | null = null
        if (tagMatch[2]) {
          const input = tagMatch[2].trim().toLowerCase()
          color = /^#[0-9A-Fa-f]{6}$/.test(input) ? input : (colorNames[input] ?? null)
        }
        tags.push({ text: label, color })
      }
      name = name.replace(/тег:\s*[^(\s]+(?:\([^)]+\))?/gi, '').trim()
      const dateMatch = details.match(/(?:дата|до):\s*(\d{4}-\d{2}-\d{2})/i)
      if (dateMatch) {
        dueDate = dateMatch[1]
        name = name.replace(dateMatch[0], '').trim()
      }
      pendingTask = { name: name.replace(/\s{2,}/g, ' ').trim(), column: currentColumn, assignee, priority, tags, dueDate, description: '' }
    }
  }
  savePendingTask()
  return { columns, tasks }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function parseIndentedTree(input: string): TreeNode | null {
  const lines = input
    .replace(/\t/g, '    ')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => line.trim().length > 0)
  if (lines.length === 0) return null
  if (/^(flowchart|graph)\b/i.test(lines[0].trim())) return null

  const nodes = lines.map((line) => {
    const spaces = line.match(/^\s*/)?.[0].length ?? 0
    const level = Math.floor(spaces / 2)
    const text = line.trim()
    return { text, level, children: [], x: 0, y: 0, width: Math.max(110, text.length * 8 + 28), height: 34 } as TreeNode
  })

  const root = nodes[0]
  const stack: TreeNode[] = [root]
  for (let i = 1; i < nodes.length; i += 1) {
    const node = nodes[i]
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop()
    const parent = stack[stack.length - 1] ?? root
    parent.children.push(node)
    stack.push(node)
  }
  return root
}

function layoutTreeHorizontal(root: TreeNode, x: number, y: number, gapX: number, gapY: number): number {
  if (root.children.length === 0) {
    root.x = x
    root.y = y
    return root.height + gapY
  }
  let childY = y
  for (const child of root.children) {
    childY += layoutTreeHorizontal(child, x + gapX, childY, gapX, gapY)
  }
  const first = root.children[0]
  const last = root.children[root.children.length - 1]
  root.x = x
  root.y = (first.y + last.y + last.height / 2 - root.height / 2)
  return Math.max(root.height + gapY, childY - y)
}

function collectTreeBounds(node: TreeNode, bounds: { minX: number; minY: number; maxX: number; maxY: number }): void {
  bounds.minX = Math.min(bounds.minX, node.x)
  bounds.minY = Math.min(bounds.minY, node.y)
  bounds.maxX = Math.max(bounds.maxX, node.x + node.width)
  bounds.maxY = Math.max(bounds.maxY, node.y + node.height)
  for (const child of node.children) collectTreeBounds(child, bounds)
}

function renderFlowchartSvg(input: string): string | null {
  const root = parseIndentedTree(input)
  if (!root) return null
  layoutTreeHorizontal(root, 60, 60, 210, 20)
  const bounds = { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY }
  collectTreeBounds(root, bounds)
  const width = Math.max(700, bounds.maxX - bounds.minX + 120)
  const height = Math.max(420, bounds.maxY - bounds.minY + 120)
  const shiftX = 40 - bounds.minX
  const shiftY = 40 - bounds.minY
  const lines: string[] = []
  const nodes: string[] = []

  const walk = (node: TreeNode) => {
    const x = node.x + shiftX
    const y = node.y + shiftY
    for (const child of node.children) {
      const cx = child.x + shiftX
      const cy = child.y + shiftY
      const x1 = x + node.width
      const y1 = y + node.height / 2
      const x2 = cx
      const y2 = cy + child.height / 2
      const mx = (x1 + x2) / 2
      lines.push(`<polyline points="${x1},${y1} ${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#5f7ea0" stroke-width="2.5"/>`)
      walk(child)
    }
    const fill = node.level === 0 ? '#27465f' : '#3f6488'
    nodes.push(`<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="8" fill="${fill}" stroke="${fill}"/>`)
    nodes.push(`<text x="${x + node.width / 2}" y="${y + node.height / 2 + 5}" text-anchor="middle" font-size="${node.level === 0 ? 14 : 13}" font-weight="600" fill="#ffffff">${escapeXml(node.text)}</text>`)
  }
  walk(root)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:Inter,sans-serif">${lines.join('')}${nodes.join('')}</svg>`
}

function parseSequenceData(text: string): { participants: string[]; messages: Array<{ from: string; to: string; text: string; dashed: boolean }>; blocks: Array<{ kind: 'alt' | 'loop' | 'par'; label: string; start: number; end: number }> } | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  const participants: string[] = []
  const messages: Array<{ from: string; to: string; text: string; dashed: boolean }> = []
  const blocks: Array<{ kind: 'alt' | 'loop' | 'par'; label: string; start: number; end: number }> = []
  const stack: Array<{ kind: 'alt' | 'loop' | 'par'; label: string; start: number }> = []
  for (const line of lines) {
    const p = line.match(/^[Уу]частник\s+(.+?)(?:\s+как\s+(.+))?$/)
    if (p) {
      const name = (p[2] ?? p[1]).trim()
      if (!participants.includes(name)) participants.push(name)
      continue
    }
    const msg = line.match(/^(.+?)\s*(->|-->)\s*(.+?):\s*(.+)$/)
    if (msg) {
      const from = msg[1].trim()
      const to = msg[3].trim()
      if (!participants.includes(from)) participants.push(from)
      if (!participants.includes(to)) participants.push(to)
      messages.push({ from, to, text: msg[4].trim(), dashed: msg[2] === '-->' })
      continue
    }
    const startAlt = line.match(/^Начало ветки\s*(.*)$/i)
    const startLoop = line.match(/^Начало цикла\s*(.*)$/i)
    const startPar = line.match(/^Начало параллельных действий\s*(.*)$/i)
    if (startAlt) stack.push({ kind: 'alt', label: startAlt[1].trim(), start: messages.length })
    if (startLoop) stack.push({ kind: 'loop', label: startLoop[1].trim(), start: messages.length })
    if (startPar) stack.push({ kind: 'par', label: startPar[1].trim(), start: messages.length })
    if (/^конец ветки$/i.test(line) || /^конец цикла$/i.test(line) || /^конец параллельных действий$/i.test(line)) {
      const last = stack.pop()
      if (last) blocks.push({ ...last, end: Math.max(last.start, messages.length - 1) })
    }
  }
  return { participants, messages, blocks }
}

function renderSequenceSvg(input: string): string | null {
  const data = parseSequenceData(input)
  if (!data || data.participants.length === 0) return null
  const startX = 120
  const gapX = 200
  const topY = 60
  const msgStartY = 130
  const msgGap = 52
  const width = Math.max(760, startX * 2 + (data.participants.length - 1) * gapX + 120)
  const height = Math.max(420, msgStartY + data.messages.length * msgGap + 90)
  const xByName = new Map<string, number>()
  data.participants.forEach((p, idx) => xByName.set(p, startX + idx * gapX))
  const bg: string[] = []
  const lines: string[] = []
  const labels: string[] = []

  for (const block of data.blocks) {
    const y = msgStartY + block.start * msgGap - 24
    const h = (block.end - block.start + 1) * msgGap + 38
    const pad = block.kind === 'loop' ? '#dbeafe' : block.kind === 'par' ? '#fef3c7' : '#f3f4f6'
    const stroke = block.kind === 'loop' ? '#2563eb' : block.kind === 'par' ? '#d97706' : '#6b7280'
    bg.push(`<rect x="64" y="${y}" width="${width - 128}" height="${h}" rx="10" fill="none" stroke="${stroke}" stroke-width="2" ${block.kind === 'alt' ? 'stroke-dasharray="6,4"' : ''}/>`)
    bg.push(`<rect x="80" y="${y + 8}" width="${Math.max(70, block.label.length * 8 + 20)}" height="20" rx="4" fill="${pad}" stroke="${stroke}" stroke-width="1.2"/>`)
    bg.push(`<text x="90" y="${y + 22}" fill="${stroke}" font-size="11" font-weight="700">${escapeXml(block.label || block.kind)}</text>`)
  }

  for (const p of data.participants) {
    const x = xByName.get(p) ?? 0
    lines.push(`<line x1="${x}" y1="${topY}" x2="${x}" y2="${height - 40}" stroke="#51779b" stroke-width="2"/>`)
    labels.push(`<text x="${x}" y="${topY - 12}" text-anchor="middle" font-size="13" font-weight="700" fill="#1f2937">${escapeXml(p)}</text>`)
  }

  data.messages.forEach((msg, idx) => {
    const y = msgStartY + idx * msgGap
    const x1 = xByName.get(msg.from) ?? startX
    const x2 = xByName.get(msg.to) ?? startX
    const right = x2 >= x1
    const toX = x2 + (right ? -10 : 10)
    lines.push(`<line x1="${x1}" y1="${y}" x2="${toX}" y2="${y}" stroke="#2f5a82" stroke-width="2" ${msg.dashed ? 'stroke-dasharray="6,4"' : ''}/>`)
    lines.push(`<polygon points="${x2},${y} ${x2 + (right ? -10 : 10)},${y - 5} ${x2 + (right ? -10 : 10)},${y + 5}" fill="#2f5a82"/>`)
    lines.push(`<text x="${(x1 + x2) / 2}" y="${y - 8}" text-anchor="middle" font-size="12" fill="#1f2937">${escapeXml(msg.text)}</text>`)
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:Inter,sans-serif">${bg.join('')}${lines.join('')}${labels.join('')}</svg>`
}

function parseBpmnData(text: string): { lanes: string[]; elements: Array<{ id: string; name: string; type: 'task' | 'event' | 'gateway'; lane: string }>; flows: Array<{ from: string; to: string; dashed: boolean; label: string }> } | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  const lanes: string[] = []
  const elements: Array<{ id: string; name: string; type: 'task' | 'event' | 'gateway'; lane: string }> = []
  const flows: Array<{ from: string; to: string; dashed: boolean; label: string }> = []
  let lane = 'Основная дорожка'
  const ensureLane = (name: string) => { if (!lanes.includes(name)) lanes.push(name) }
  ensureLane(lane)
  for (const line of lines) {
    const laneMatch = line.match(/^Дорожка:\s*(.+)$/i)
    if (laneMatch) { lane = laneMatch[1].trim(); ensureLane(lane); continue }
    const taskMatch = line.match(/^Задача:\s*(.+?)(?:\s*\(.*\))?$/i)
    if (taskMatch) { const name = taskMatch[1].trim(); elements.push({ id: `task_${elements.length}`, name, type: 'task', lane }); continue }
    const eventMatch = line.match(/^Событие:\s*(.+?)(?:\s*\(.*\))?$/i)
    if (eventMatch) { const name = eventMatch[1].trim(); elements.push({ id: `event_${elements.length}`, name, type: 'event', lane }); continue }
    const gateMatch = line.match(/^Шлюз:\s*(.+?)(?:\s*\(.*\))?$/i)
    if (gateMatch) { const name = gateMatch[1].trim(); elements.push({ id: `gate_${elements.length}`, name, type: 'gateway', lane }); continue }
    const flowMatch = line.match(/^(.+?)\s*(->|-->|~~>)\s*(.+?)(?:\s*:\s*(.*))?$/)
    if (flowMatch) flows.push({ from: flowMatch[1].trim(), to: flowMatch[3].trim(), dashed: flowMatch[2] !== '->', label: (flowMatch[4] ?? '').trim() })
  }
  return { lanes, elements, flows }
}

function renderBpmnSvg(input: string): string | null {
  const data = parseBpmnData(input)
  if (!data || data.elements.length === 0) return null
  const laneHeight = 150
  const laneGap = 44
  const startX = 130
  const startY = 70
  const width = 1200
  const laneIndex = new Map<string, number>()
  data.lanes.forEach((name, idx) => laneIndex.set(name, idx))
  const positioned = data.elements.map((el, idx) => {
    const li = laneIndex.get(el.lane) ?? 0
    const yBase = startY + li * (laneHeight + laneGap)
    const rowIndex = data.elements.filter((item, i2) => i2 < idx && item.lane === el.lane).length
    const x = startX + rowIndex * 220
    const y = yBase + 45
    return { ...el, x, y, w: el.type === 'task' ? 130 : 50, h: el.type === 'task' ? 62 : 50 }
  })
  const byName = new Map(positioned.map((el) => [el.name, el] as const))
  const height = startY + data.lanes.length * (laneHeight + laneGap) + 40
  const laneSvg = data.lanes.map((lane, idx) => {
    const y = startY + idx * (laneHeight + laneGap)
    return `<rect x="30" y="${y}" width="${width - 60}" height="${laneHeight}" rx="10" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/><text x="46" y="${y + 24}" fill="#1f2937" font-size="14" font-weight="700">${escapeXml(lane)}</text>`
  }).join('')

  const flows = data.flows.map((f) => {
    const from = byName.get(f.from); const to = byName.get(f.to)
    if (!from || !to) return ''
    const x1 = from.x + from.w
    const y1 = from.y + from.h / 2
    const x2 = to.x
    const y2 = to.y + to.h / 2
    const mx = (x1 + x2) / 2
    const label = f.label ? `<text x="${mx}" y="${Math.min(y1, y2) - 8}" text-anchor="middle" font-size="11" fill="#1f2937">${escapeXml(f.label)}</text>` : ''
    return `<polyline points="${x1},${y1} ${mx},${y1} ${mx},${y2} ${x2 - 8},${y2}" fill="none" stroke="#2f5a82" stroke-width="2" ${f.dashed ? 'stroke-dasharray="6,4"' : ''}/><polygon points="${x2},${y2} ${x2 - 10},${y2 - 5} ${x2 - 10},${y2 + 5}" fill="#2f5a82"/>${label}`
  }).join('')

  const elements = positioned.map((el) => {
    if (el.type === 'task') {
      return `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" rx="8" fill="#ffffff" stroke="#2f5a82" stroke-width="2"/><text x="${el.x + el.w / 2}" y="${el.y + el.h / 2 + 5}" text-anchor="middle" font-size="12" fill="#1f2937">${escapeXml(el.name)}</text>`
    }
    if (el.type === 'event') {
      return `<circle cx="${el.x + 25}" cy="${el.y + 25}" r="24" fill="#ffffff" stroke="#2f5a82" stroke-width="2"/><text x="${el.x + 25}" y="${el.y + 66}" text-anchor="middle" font-size="11" fill="#1f2937">${escapeXml(el.name)}</text>`
    }
    return `<polygon points="${el.x + 25},${el.y} ${el.x + 50},${el.y + 25} ${el.x + 25},${el.y + 50} ${el.x},${el.y + 25}" fill="#ffffff" stroke="#2f5a82" stroke-width="2"/><text x="${el.x + 25}" y="${el.y + 66}" text-anchor="middle" font-size="11" fill="#1f2937">${escapeXml(el.name)}</text>`
  }).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:Inter,sans-serif">${laneSvg}${flows}${elements}</svg>`
}

function parseWaveData(text: string): { nodes: string[]; links: Array<{ source: string; target: string; value: number }> } | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return null
  const nodeSet = new Set<string>()
  const links: Array<{ source: string; target: string; value: number }> = []
  for (const line of lines) {
    const m = line.match(/^(.+?)\s*->\s*(.+?)\s*:\s*([0-9]+(?:[.,][0-9]+)?)$/)
    if (!m) continue
    const source = m[1].trim()
    const target = m[2].trim()
    const value = Number(m[3].replace(',', '.'))
    if (!(value > 0)) continue
    nodeSet.add(source)
    nodeSet.add(target)
    links.push({ source, target, value })
  }
  const nodes = [...nodeSet]
  if (nodes.length === 0 || links.length === 0) return null
  return { nodes, links }
}

function renderWaveSvg(input: string): string | null {
  const data = parseWaveData(input)
  if (!data) return null
  const layers = new Map<string, number>()
  const incoming = new Set(data.links.map((l) => l.target))
  const queue = data.nodes.filter((n) => !incoming.has(n))
  if (queue.length === 0) queue.push(data.nodes[0])
  for (const node of queue) layers.set(node, 0)
  while (queue.length > 0) {
    const node = queue.shift()!
    const layer = layers.get(node) ?? 0
    for (const edge of data.links.filter((l) => l.source === node)) {
      const next = (layers.get(edge.target) ?? -1)
      if (layer + 1 > next) layers.set(edge.target, layer + 1)
      if (!queue.includes(edge.target)) queue.push(edge.target)
    }
  }
  for (const node of data.nodes) if (!layers.has(node)) layers.set(node, 0)
  const maxLayer = Math.max(...layers.values())
  const byLayer: string[][] = Array.from({ length: maxLayer + 1 }, () => [])
  for (const n of data.nodes) byLayer[layers.get(n) ?? 0].push(n)
  const nodePos = new Map<string, { x: number; y: number; h: number }>()
  const width = Math.max(900, 160 + maxLayer * 240 + 220)
  let maxY = 0
  const nodeWidth = 120
  byLayer.forEach((list, layer) => {
    let y = 70
    list.forEach((name) => {
      const total = data.links.filter((l) => l.source === name || l.target === name).reduce((sum, item) => sum + item.value, 0)
      const h = Math.max(26, Math.min(230, total * 2.2))
      const x = 70 + layer * 240
      nodePos.set(name, { x, y, h })
      y += h + 28
      maxY = Math.max(maxY, y)
    })
  })
  const height = Math.max(420, maxY + 40)
  const palette = ['#3b82f6', '#16a34a', '#f97316', '#8b5cf6', '#06b6d4', '#ef4444', '#d97706']
  const colorByNode = new Map<string, string>()
  data.nodes.forEach((n, i) => colorByNode.set(n, palette[i % palette.length]))
  const links = data.links.map((edge) => {
    const s = nodePos.get(edge.source); const t = nodePos.get(edge.target)
    if (!s || !t) return ''
    const x1 = s.x + nodeWidth
    const y1 = s.y + s.h / 2
    const x2 = t.x
    const y2 = t.y + t.h / 2
    const cp1x = x1 + (x2 - x1) * 0.4
    const cp2x = x2 - (x2 - x1) * 0.4
    return `<path d="M ${x1} ${y1} C ${cp1x} ${y1}, ${cp2x} ${y2}, ${x2} ${y2}" fill="none" stroke="${colorByNode.get(edge.target) ?? '#3b82f6'}" stroke-width="${Math.max(2, edge.value * 0.8)}" opacity="0.55"/><text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#334155">${edge.value}</text>`
  }).join('')
  const nodes = data.nodes.map((name) => {
    const pos = nodePos.get(name)!
    const color = colorByNode.get(name) ?? '#3b82f6'
    return `<rect x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${pos.h}" rx="4" fill="${color}"/><text x="${pos.x + nodeWidth / 2}" y="${pos.y + pos.h / 2 + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">${escapeXml(name)}</text>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="font-family:Inter,sans-serif">${links}${nodes}</svg>`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightSyntax(text: string, kind: DiagramKind): string {
  let escaped = escapeHtml(text)
  const wrapKeyword = (pattern: RegExp) => {
    escaped = escaped.replace(pattern, '<span class="diagram-hl-keyword">$1</span>')
  }
  const wrapArrow = (pattern: RegExp) => {
    escaped = escaped.replace(pattern, '<span class="diagram-hl-arrow">$1</span>')
  }

  if (kind === 'sequence') {
    wrapKeyword(/\b(Участник|участник|как|автонумерация|Начало комментария|Конец комментария|Начало ветки|иначе|конец ветки|Начало цикла|конец цикла|Начало параллельных действий|и|конец параллельных действий|завершить)\b/g)
    wrapArrow(/(-&gt;|--&gt;|:)/g)
  } else if (kind === 'bpmn') {
    wrapKeyword(/\b(Процесс:|Дорожка:|Событие:|Задача:|Шлюз:|тип:|доп\.тип:|начало|промежуточное|завершение|исключающий|параллельный|сервисная|ручная|пользовательская|бизнес-правило|таймер|сообщение)\b/g)
    wrapArrow(/(-&gt;|--&gt;|~~&gt;)/g)
  } else if (kind === 'board') {
    wrapKeyword(/\b(колонка|задача:|тег:|дата:|до:|срочно|важно)\b/g)
    wrapArrow(/(@[^\s]+)/g)
  } else if (kind === 'wave') {
    wrapArrow(/(-&gt;|:)/g)
  }
  return escaped
}

function mermaidThemeDirective(theme: DiagramTheme): string {
  if (theme === 'default' || theme === 'forest' || theme === 'dark' || theme === 'neutral') {
    return `%%{init: {"theme":"${theme}"}}%%`
  }
  if (theme === 'neon') {
    return '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#00F6FF","primaryTextColor":"#0b1020","primaryBorderColor":"#ff00ff","lineColor":"#8b5cf6","fontFamily":"Inter"}}}%%'
  }
  if (theme === 'ocean') {
    return '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#bfdbfe","primaryTextColor":"#0f172a","primaryBorderColor":"#0369a1","lineColor":"#0ea5e9","fontFamily":"Inter"}}}%%'
  }
  return '%%{init: {"theme":"base","themeVariables":{"primaryColor":"#fce7f3","primaryTextColor":"#1f2937","primaryBorderColor":"#fb7185","lineColor":"#f59e0b","fontFamily":"Inter"}}}%%'
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

function normalizeWaveSource(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return 'sankey-beta\nИсточник,Цель,100'
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
    return 'sankey-beta\nИсточник,Цель,100'
  }

  const out: string[] = ['sankey-beta']
  for (const edge of edges) {
    out.push(`${edge.from.replace(/,/g, ' ')} , ${edge.to.replace(/,/g, ' ')} , ${edge.value}`)
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
  const storageRef = useRef<DiagramStorage>(stored)
  const renderJobRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const [kind, setKind] = useState<DiagramKind>('mindmap')
  const [theme, setTheme] = useState<DiagramTheme>('dark')
  const [source, setSource] = useState(stored.mindmap ?? PRESETS[0].starter)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [boardData, setBoardData] = useState<BoardData | null>(null)

  const activePreset = useMemo(() => PRESETS.find((preset) => preset.id === kind) ?? PRESETS[0], [kind])

  const highlightedHtml = useMemo(() => highlightSyntax(source, kind), [source, kind])

  const syncHighlightScroll = () => {
    if (!textareaRef.current || !highlightRef.current) return
    highlightRef.current.scrollTop = textareaRef.current.scrollTop
    highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
  }

  useEffect(() => {
    const currentJob = renderJobRef.current + 1
    renderJobRef.current = currentJob

    const timer = window.setTimeout(() => {
      const render = async () => {
        try {
          const customSvg =
            kind === 'flowchart'
              ? renderFlowchartSvg(source)
              : kind === 'sequence'
                ? renderSequenceSvg(source)
                : kind === 'bpmn'
                  ? renderBpmnSvg(source)
                  : kind === 'wave'
                    ? renderWaveSvg(source)
                    : null
          if (customSvg) {
            setSvg(customSvg)
            setBoardData(null)
            setError(null)
            return
          }
          if (kind === 'board') {
            setBoardData(parseBoardData(source))
            setError(null)
            return
          }
          const sourceToRender =
            kind === 'mindmap'
              ? normalizeMindmapSource(source)
              : kind === 'flowchart'
                ? normalizeFlowchartSource(source)
                : kind === 'sequence'
                  ? normalizeSequenceSource(source)
                  : kind === 'bpmn'
                    ? normalizeBpmnSource(source)
                    : kind === 'wave'
                        ? normalizeWaveSource(source)
                : source
          const themedSource = `${mermaidThemeDirective(theme)}\n${sourceToRender}`
          renderCounter += 1
          const elementId = `diagram-builder-${renderCounter}`
          const { svg: nextSvg } = await mermaid.render(elementId, themedSource)
          if (renderJobRef.current !== currentJob) return
          setSvg(nextSvg)
          setBoardData(null)
          setError(null)
        } catch (err) {
          if (renderJobRef.current !== currentJob) return
          setSvg('')
          setBoardData(null)
          setError(err instanceof Error ? err.message : 'Ошибка построения диаграммы')
        }
      }
      void render()
    }, 220)

    return () => {
      window.clearTimeout(timer)
    }
  }, [kind, source, theme])

  useEffect(() => {
    const nextStorage = { ...storageRef.current, [kind]: source }
    storageRef.current = nextStorage
    writeDiagramStorage(nextStorage)
  }, [kind, source])

  const applyPreset = (nextKind: DiagramKind) => {
    const preset = PRESETS.find((item) => item.id === nextKind)
    setKind(nextKind)
    const saved = storageRef.current[nextKind]
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
          <div className="diagram-textarea-wrapper">
            <div ref={highlightRef} className="diagram-highlight-layer" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          <textarea
            ref={textareaRef}
            className="diagram-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            onScroll={syncHighlightScroll}
            spellCheck={false}
          />
          </div>
        </div>
        <div className="diagram-preview">
          <div className="diagram-preview-header">
            <h2>Предпросмотр</h2>
            <div className="diagram-theme-row">
              <span className="diagram-theme-label">Тема</span>
              <div className="diagram-theme-buttons">
                {THEME_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`diagram-theme-btn${theme === option.id ? ' is-active' : ''}`}
                    onClick={() => setTheme(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {error ? (
            <p className="banner-error">Не удалось построить диаграмму. Проверьте формат текста для выбранного типа.</p>
          ) : kind === 'board' && boardData ? (
            <DiagramPreviewCanvas
              contentKey={`${kind}:${source.length}`}
              content={
                <div className="board-preview">
                  {boardData.columns.map((column, idx) => {
                    const columnTasks = boardData.tasks.filter((task) => task.column === column.name)
                    return (
                      <section key={`${column.name}-${idx}`} className="board-column">
                        <header className="board-column-header">{column.name}</header>
                        <div className="board-column-body">
                          {columnTasks.map((task, taskIdx) => (
                            <article key={`${task.name}-${taskIdx}`} className="board-card">
                              <div className="board-card-title-row">
                                <h4 className="board-card-title">{task.name}</h4>
                                {task.priority !== 'обычная' ? <span className={`board-priority board-priority-${task.priority}`}>{task.priority}</span> : null}
                              </div>
                              {task.tags.length > 0 ? (
                                <div className="board-tags">
                                  {task.tags.map((tag, tagIdx) => (
                                    <span key={`${tag.text}-${tagIdx}`} className="board-tag" style={{ background: tag.color ?? '#3b82f6' }}>
                                      {tag.text}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {task.description ? <p className="board-description">{task.description}</p> : null}
                              <div className="board-footer">
                                <span>{task.dueDate ? `📅 ${task.dueDate}` : ''}</span>
                                <span>{task.assignee ? `👤 ${task.assignee}` : ''}</span>
                              </div>
                            </article>
                          ))}
                        </div>
                      </section>
                    )
                  })}
                </div>
              }
            />
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
