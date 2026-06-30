import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { getJson, putJson } from '../api'
import type {
  DepartmentBlock,
  OrgChartLayout,
  OrgChartLayoutData,
  OrgChartLayoutEdge,
  OrgChartLayoutNode,
  OrgChartNode,
} from './types'
import OrgPhoto from './OrgPhoto'

type ManualOrgChartViewProps = {
  organizationHead?: OrgChartNode | null
  departments: DepartmentBlock[]
  standaloneRoots?: OrgChartNode[]
  canManage: boolean
  onEmployeeClick?: (employeeId: number) => void
  onDepartmentClick?: (departmentId: number) => void
}

type ChartItem =
  | {
      id: string
      kind: 'employee'
      refId: number
      node: OrgChartNode
      parentId?: string | null
      parentNodeId?: string | null
    }
  | {
      id: string
      kind: 'department'
      refId: number
      block: DepartmentBlock
      parentId?: string | null
      parentNodeId?: string | null
    }

const EMPLOYEE_NODE_WIDTH = 180
const EMPLOYEE_NODE_HEIGHT = 190
const DEPARTMENT_NODE_WIDTH = 640
const DEPARTMENT_TITLE_HEIGHT = 52
const DEPARTMENT_PADDING = 24
const DEPARTMENT_EMPLOYEE_GAP = 18
const DEPARTMENT_EMPLOYEES_PER_ROW = 3
const NODE_GAP_X = 36
const NODE_GAP_Y = 56
const NODES_PER_ROW = 3
const MIN_DEPARTMENT_WIDTH = DEPARTMENT_PADDING * 2 + EMPLOYEE_NODE_WIDTH
const MIN_DEPARTMENT_HEIGHT = DEPARTMENT_TITLE_HEIGHT + DEPARTMENT_PADDING * 2 + EMPLOYEE_NODE_HEIGHT

type Point = { x: number; y: number }
type EdgeAnchor = 'top' | 'bottom'

function employeeNodeId(employeeId: number): string {
  return `employee:${employeeId}`
}

function departmentEmployeeNodeId(departmentId: number, employeeId: number): string {
  return `department:${departmentId}:employee:${employeeId}`
}

function departmentNodeId(departmentId: number): string {
  return `department:${departmentId}`
}

function edgeId(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}->${toNodeId}`
}

function anchoredEdgeId(fromNodeId: string, toNodeId: string, fromAnchor: EdgeAnchor, toAnchor: EdgeAnchor): string {
  return `${fromNodeId}:${fromAnchor}->${toNodeId}:${toAnchor}`
}

function flattenEmployeeTree(root: OrgChartNode): OrgChartNode[] {
  return [root, ...root.children.flatMap(flattenEmployeeTree)]
}

function uniqueEmployees(roots: OrgChartNode[]): OrgChartNode[] {
  const seen = new Set<number>()
  const employees: OrgChartNode[] = []
  for (const root of roots) {
    for (const node of flattenEmployeeTree(root)) {
      if (seen.has(node.person.employeeId)) continue
      seen.add(node.person.employeeId)
      employees.push(node)
    }
  }
  return employees
}

function departmentHeight(block: DepartmentBlock): number {
  const employeeCount = Math.max(1, uniqueEmployees(block.roots).length)
  const rows = Math.ceil(employeeCount / DEPARTMENT_EMPLOYEES_PER_ROW)
  return (
    DEPARTMENT_TITLE_HEIGHT +
    DEPARTMENT_PADDING * 2 +
    rows * EMPLOYEE_NODE_HEIGHT +
    Math.max(0, rows - 1) * DEPARTMENT_EMPLOYEE_GAP
  )
}

function flattenDepartments(
  blocks: DepartmentBlock[],
  parentId: string | null = null,
): ChartItem[] {
  return blocks.flatMap((block) => {
    const id = departmentNodeId(block.departmentId)
    const departmentItem: ChartItem = {
      id,
      kind: 'department',
      refId: block.departmentId,
      block,
      parentId,
    }
    const employeeItems: ChartItem[] = uniqueEmployees(block.roots).map((node) => ({
      id: departmentEmployeeNodeId(block.departmentId, node.person.employeeId),
      kind: 'employee',
      refId: node.person.employeeId,
      node,
      parentNodeId: id,
    }))
    return [
      departmentItem,
      ...employeeItems,
      ...flattenDepartments(block.nestedDepartments ?? [], id),
    ]
  })
}

function buildStandaloneItems(
  roots: OrgChartNode[],
  organizationHead?: OrgChartNode | null,
): ChartItem[] {
  const build = (node: OrgChartNode, parentId: string | null): ChartItem[] => {
    const id = employeeNodeId(node.person.employeeId)
    return [
      {
        id,
        kind: 'employee' as const,
        refId: node.person.employeeId,
        node,
        parentId,
      },
      ...node.children.flatMap((child) => build(child, id)),
    ]
  }
  const rootParent = organizationHead ? employeeNodeId(organizationHead.person.employeeId) : null
  return roots.flatMap((root) => build(root, rootParent))
}

function buildChartItems(
  organizationHead: OrgChartNode | null | undefined,
  departments: DepartmentBlock[],
  standaloneRoots: OrgChartNode[],
): ChartItem[] {
  const headItem: ChartItem[] = organizationHead
    ? [{
        id: employeeNodeId(organizationHead.person.employeeId),
        kind: 'employee',
        refId: organizationHead.person.employeeId,
        node: organizationHead,
        parentId: null,
      }]
    : []
  const topParent = organizationHead ? employeeNodeId(organizationHead.person.employeeId) : null
  return [
    ...headItem,
    ...flattenDepartments(departments, topParent),
    ...buildStandaloneItems(standaloneRoots, organizationHead),
  ]
}

function defaultEmployeePositionInDepartment(
  departmentNode: OrgChartLayoutNode,
  employeeIndex: number,
): { x: number; y: number } {
  const col = employeeIndex % DEPARTMENT_EMPLOYEES_PER_ROW
  const row = Math.floor(employeeIndex / DEPARTMENT_EMPLOYEES_PER_ROW)
  return {
    x: departmentNode.x + DEPARTMENT_PADDING + col * (EMPLOYEE_NODE_WIDTH + DEPARTMENT_EMPLOYEE_GAP),
    y: departmentNode.y + DEPARTMENT_TITLE_HEIGHT + DEPARTMENT_PADDING + row * (EMPLOYEE_NODE_HEIGHT + DEPARTMENT_EMPLOYEE_GAP),
  }
}

function defaultLayout(items: ChartItem[]): OrgChartLayoutData {
  const head = items.find((item) => item.kind === 'employee' && item.parentId == null && !item.parentNodeId)
  const freeItems = items.filter((item) => item.id !== head?.id && !item.parentNodeId)
  const rowWidth = NODES_PER_ROW * DEPARTMENT_NODE_WIDTH + (NODES_PER_ROW - 1) * NODE_GAP_X
  const nodes: OrgChartLayoutNode[] = []

  if (head) {
    nodes.push({
      id: head.id,
      kind: head.kind,
      refId: head.refId,
      x: rowWidth / 2 - EMPLOYEE_NODE_WIDTH / 2,
      y: 0,
      width: EMPLOYEE_NODE_WIDTH,
      height: EMPLOYEE_NODE_HEIGHT,
    })
  }

  const freeRows: ChartItem[][] = []
  for (let i = 0; i < freeItems.length; i += NODES_PER_ROW) {
    freeRows.push(freeItems.slice(i, i + NODES_PER_ROW))
  }
  let rowY = EMPLOYEE_NODE_HEIGHT + NODE_GAP_Y
  freeRows.forEach((rowItems) => {
    const rowHeights = rowItems.map((item) => item.kind === 'department' ? departmentHeight(item.block) : EMPLOYEE_NODE_HEIGHT)
    rowItems.forEach((item, col) => {
      const width = item.kind === 'department' ? DEPARTMENT_NODE_WIDTH : EMPLOYEE_NODE_WIDTH
      const height = item.kind === 'department' ? departmentHeight(item.block) : EMPLOYEE_NODE_HEIGHT
      nodes.push({
        id: item.id,
        kind: item.kind,
        refId: item.refId,
        x: col * (DEPARTMENT_NODE_WIDTH + NODE_GAP_X) + (DEPARTMENT_NODE_WIDTH - width) / 2,
        y: rowY,
        width,
        height,
      })
    })
    rowY += Math.max(...rowHeights) + NODE_GAP_Y
  })

  const departmentEmployeeIndex = new Map<string, number>()
  for (const item of items) {
    if (!item.parentNodeId) continue
    const departmentNode = nodes.find((node) => node.id === item.parentNodeId)
    if (!departmentNode) continue
    const index = departmentEmployeeIndex.get(item.parentNodeId) ?? 0
    departmentEmployeeIndex.set(item.parentNodeId, index + 1)
    const position = defaultEmployeePositionInDepartment(departmentNode, index)
    nodes.push({
      id: item.id,
      kind: item.kind,
      refId: item.refId,
      parentNodeId: item.parentNodeId,
      x: position.x,
      y: position.y,
      width: EMPLOYEE_NODE_WIDTH,
      height: EMPLOYEE_NODE_HEIGHT,
    })
  }

  return { nodes, edges: [] }
}

function reconcileLayout(saved: OrgChartLayoutData | null, items: ChartItem[]): OrgChartLayoutData {
  const generated = defaultLayout(items)
  if (!saved || saved.nodes.length === 0) {
    return generated
  }
  const itemById = new Map(items.map((item) => [item.id, item]))
  const generatedById = new Map(generated.nodes.map((node) => [node.id, node]))
  const savedById = new Map(saved.nodes.map((node) => [node.id, node]))
  const nodes = generated.nodes.map((generatedNode) => {
    const item = itemById.get(generatedNode.id)
    const savedNode = savedById.get(generatedNode.id)
    if (!item) return generatedNode
    const width = item.kind === 'department'
      ? Math.max(MIN_DEPARTMENT_WIDTH, savedNode?.width ?? DEPARTMENT_NODE_WIDTH)
      : EMPLOYEE_NODE_WIDTH
    const height = item.kind === 'department'
      ? Math.max(MIN_DEPARTMENT_HEIGHT, savedNode?.height ?? departmentHeight(item.block))
      : EMPLOYEE_NODE_HEIGHT
    if (!savedNode) {
      if (generatedNode.parentNodeId) {
        const savedParent = savedById.get(generatedNode.parentNodeId)
        const generatedParent = generatedById.get(generatedNode.parentNodeId)
        if (savedParent && generatedParent) {
          return {
            ...generatedNode,
            x: savedParent.x + (generatedNode.x - generatedParent.x),
            y: savedParent.y + (generatedNode.y - generatedParent.y),
          }
        }
      }
      return generatedNode
    }
    return {
      ...savedNode,
      kind: item.kind,
      refId: item.refId,
      parentNodeId: item.parentNodeId ?? null,
      width,
      height,
    }
  })
  const knownNodeIds = new Set(nodes.map((node) => node.id))
  const edges = saved.edges.filter(
    (edge) => edge.manual === true && knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId),
  )
  return { nodes, edges }
}

function PersonCard({
  node,
  onEmployeeClick,
}: {
  node: OrgChartNode
  onEmployeeClick?: (employeeId: number) => void
}) {
  const body = (
    <>
      <div className="org-person-avatar">
        <OrgPhoto
          url={node.person.photoUrl}
          name={node.person.fullName}
          className="org-person-avatar-img"
          placeholderClassName="org-person-avatar-placeholder"
        />
      </div>
      <div className="org-person-info">
        <div className="org-person-name">{node.person.fullName}</div>
        {node.person.position ? <div className="org-person-position">{node.person.position}</div> : null}
        {node.person.teamRole ? <div className="org-person-role">{node.person.teamRole}</div> : null}
      </div>
    </>
  )
  return (
    <div className={`org-person-card${node.person.isHead ? ' org-person-card-head' : ''}`}>
      {onEmployeeClick ? (
        <button
          type="button"
          className="org-person-card-button"
          onClick={() => onEmployeeClick(node.person.employeeId)}
        >
          {body}
        </button>
      ) : body}
    </div>
  )
}

function DepartmentCard({
  block,
  onDepartmentClick,
}: {
  block: DepartmentBlock
  onDepartmentClick?: (departmentId: number) => void
}) {
  const title = onDepartmentClick ? (
    <button
      type="button"
      className="org-manual-dept-title org-dept-frame-title-btn"
      onClick={() => onDepartmentClick(block.departmentId)}
    >
      {block.departmentName}
    </button>
  ) : (
    <div className="org-manual-dept-title">{block.departmentName}</div>
  )
  return (
    <div className="org-manual-dept-card">
      {title}
    </div>
  )
}

function anchorPoint(node: OrgChartLayoutNode, anchor: EdgeAnchor = 'bottom'): Point {
  return {
    x: node.x + node.width / 2,
    y: anchor === 'top' ? node.y : node.y + node.height,
  }
}

function edgePath(edge: OrgChartLayoutEdge, from: OrgChartLayoutNode, to: OrgChartLayoutNode): string {
  const start = anchorPoint(from, edge.fromAnchor ?? 'bottom')
  const end = anchorPoint(to, edge.toAnchor ?? 'top')
  if (edge.points?.length) {
    return [
      `M ${start.x} ${start.y}`,
      ...edge.points.map((point) => `L ${point.x} ${point.y}`),
      `L ${end.x} ${end.y}`,
    ].join(' ')
  }
  const middleY = start.y + (end.y - start.y) / 2
  return `M ${start.x} ${start.y} V ${middleY} H ${end.x} V ${end.y}`
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

export default function ManualOrgChartView({
  organizationHead,
  departments,
  standaloneRoots = [],
  canManage,
  onEmployeeClick,
  onDepartmentClick,
}: ManualOrgChartViewProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragMovedRef = useRef(false)
  const items = useMemo(
    () => buildChartItems(organizationHead, departments, standaloneRoots),
    [organizationHead, departments, standaloneRoots],
  )
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const [layout, setLayout] = useState<OrgChartLayoutData>(() => defaultLayout(items))
  const [editing, setEditing] = useState(false)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [dragConnection, setDragConnection] = useState<{
    fromNodeId: string
    fromAnchor: EdgeAnchor
    point: Point
  } | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getJson<OrgChartLayout>('/api/org/org-chart-layout?scope=company')
      .then((saved) => {
        if (!active) return
        setLayout(reconcileLayout(saved.layout, items))
      })
      .catch(() => {
        if (!active) return
        setLayout(defaultLayout(items))
      })
    return () => {
      active = false
    }
  }, [items])

  const nodeById = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes])
  const canvasWidth = Math.max(1200, ...layout.nodes.map((node) => node.x + node.width + 80), 0)
  const canvasHeight = Math.max(600, ...layout.nodes.map((node) => node.y + node.height + 80), 0)

  const eventToCanvasPoint = useCallback((event: { clientX: number; clientY: number }): Point | null => {
    const root = canvasRef.current
    const rect = root?.getBoundingClientRect()
    if (!root || !rect) return null
    const scale = rect.width / root.offsetWidth
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    }
  }, [])

  const moveNode = useCallback((nodeId: string, nextX: number, nextY: number) => {
    setLayout((current) => {
      const currentNode = current.nodes.find((node) => node.id === nodeId)
      if (!currentNode) return current
      const parentNode = currentNode.parentNodeId
        ? current.nodes.find((node) => node.id === currentNode.parentNodeId)
        : null
      const x = parentNode
        ? clamp(nextX, parentNode.x + DEPARTMENT_PADDING, parentNode.x + parentNode.width - currentNode.width - DEPARTMENT_PADDING)
        : Math.max(0, nextX)
      const y = parentNode
        ? clamp(nextY, parentNode.y + DEPARTMENT_TITLE_HEIGHT, parentNode.y + parentNode.height - currentNode.height - DEPARTMENT_PADDING)
        : Math.max(0, nextY)
      const dx = x - currentNode.x
      const dy = y - currentNode.y
      return {
        ...current,
        nodes: current.nodes.map((node) => {
          if (node.id === nodeId) {
            return { ...node, x, y }
          }
          if (currentNode.kind === 'department' && node.parentNodeId === nodeId) {
            return { ...node, x: node.x + dx, y: node.y + dy }
          }
          return node
        }),
      }
    })
  }, [])

  const resizeDepartmentNode = useCallback((nodeId: string, nextWidth: number, nextHeight: number) => {
    setLayout((current) => {
      const departmentNode = current.nodes.find((node) => node.id === nodeId && node.kind === 'department')
      if (!departmentNode) return current
      const width = Math.max(MIN_DEPARTMENT_WIDTH, nextWidth)
      const height = Math.max(MIN_DEPARTMENT_HEIGHT, nextHeight)
      return {
        ...current,
        nodes: current.nodes.map((node) => {
          if (node.id === nodeId) {
            return { ...node, width, height }
          }
          if (node.parentNodeId === nodeId) {
            return {
              ...node,
              x: clamp(node.x, departmentNode.x + DEPARTMENT_PADDING, departmentNode.x + width - node.width - DEPARTMENT_PADDING),
              y: clamp(node.y, departmentNode.y + DEPARTMENT_TITLE_HEIGHT, departmentNode.y + height - node.height - DEPARTMENT_PADDING),
            }
          }
          return node
        }),
      }
    })
  }, [])

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, node: OrgChartLayoutNode) => {
    event.stopPropagation()
    if (!editing || event.button !== 0) return
    if ((event.target as Element).closest('button, .org-manual-connector-handle')) return
    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const root = canvasRef.current
    const rect = root?.getBoundingClientRect()
    const scale = root && rect ? rect.width / root.offsetWidth : 1
    const startX = event.clientX
    const startY = event.clientY
    const initialX = node.x
    const initialY = node.y
    dragMovedRef.current = false

    const onMove = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3) {
        dragMovedRef.current = true
      }
      const nextX = initialX + (moveEvent.clientX - startX) / scale
      const nextY = moveEvent.ctrlKey ? initialY : initialY + (moveEvent.clientY - startY) / scale
      moveNode(
        node.id,
        nextX,
        nextY,
      )
    }
    const onUp = () => {
      element.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, node: OrgChartLayoutNode) => {
    event.stopPropagation()
    if (!editing || node.kind !== 'department') return
    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const root = canvasRef.current
    const rect = root?.getBoundingClientRect()
    const scale = root && rect ? rect.width / root.offsetWidth : 1
    const startX = event.clientX
    const startY = event.clientY
    const initialWidth = node.width
    const initialHeight = node.height

    const onMove = (moveEvent: PointerEvent) => {
      dragMovedRef.current = true
      resizeDepartmentNode(
        node.id,
        initialWidth + (moveEvent.clientX - startX) / scale,
        initialHeight + (moveEvent.clientY - startY) / scale,
      )
    }
    const onUp = () => {
      element.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleNodeClick = (event: ReactMouseEvent<HTMLDivElement>, nodeId: string) => {
    if (!editing) return
    event.stopPropagation()
    if (dragMovedRef.current) {
      dragMovedRef.current = false
      return
    }
    setSelectedEdgeId(null)
    if (!connectFrom) {
      setConnectFrom(nodeId)
      return
    }
    if (connectFrom === nodeId) {
      setConnectFrom(null)
      return
    }
    const id = anchoredEdgeId(connectFrom, nodeId, 'bottom', 'top')
    setLayout((current) => ({
      ...current,
      edges: current.edges.some((edge) => edge.id === id)
        ? current.edges
        : [...current.edges, {
            id,
            fromNodeId: connectFrom,
            toNodeId: nodeId,
            fromAnchor: 'bottom',
            toAnchor: 'top',
            manual: true,
            points: [],
          }],
    }))
    setConnectFrom(null)
  }

  const createEdge = useCallback((
    fromNodeId: string,
    toNodeId: string,
    fromAnchor: EdgeAnchor,
    toAnchor: EdgeAnchor,
  ) => {
    if (fromNodeId === toNodeId) return
    const id = anchoredEdgeId(fromNodeId, toNodeId, fromAnchor, toAnchor)
    setLayout((current) => ({
      ...current,
      edges: current.edges.some((edge) => edge.id === id)
        ? current.edges
        : [...current.edges, { id, fromNodeId, toNodeId, fromAnchor, toAnchor, manual: true, points: [] }],
    }))
    setSelectedEdgeId(id)
  }, [])

  const handleConnectorPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    fromNodeId: string,
    fromAnchor: EdgeAnchor,
  ) => {
    event.stopPropagation()
    if (!editing) return
    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const initialPoint = eventToCanvasPoint(event)
    if (!initialPoint) return
    setDragConnection({ fromNodeId, fromAnchor, point: initialPoint })

    const onMove = (moveEvent: PointerEvent) => {
      const point = eventToCanvasPoint(moveEvent)
      if (point) {
        setDragConnection({ fromNodeId, fromAnchor, point })
      }
    }
    const onUp = (upEvent: PointerEvent) => {
      element.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const target = document
        .elementFromPoint(upEvent.clientX, upEvent.clientY)
        ?.closest<HTMLElement>('[data-node-id]')
      const toNodeId = target?.dataset.nodeId
      const toAnchor = (target?.dataset.anchor as EdgeAnchor | undefined)
        ?? (target && upEvent.clientY < target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2
          ? 'top'
          : 'bottom')
      if (toNodeId) {
        createEdge(fromNodeId, toNodeId, fromAnchor, toAnchor)
      }
      setDragConnection(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const saveLayout = async () => {
    setStatus('Сохраняем...')
    try {
      const saved = await putJson<OrgChartLayout>('/api/org/org-chart-layout?scope=company', { layout })
      setLayout(reconcileLayout(saved.layout, items))
      setStatus('Схема сохранена')
      setEditing(false)
      setConnectFrom(null)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Не удалось сохранить схему')
    }
  }

  const resetLayout = () => {
    setLayout(defaultLayout(items))
    setConnectFrom(null)
    setSelectedEdgeId(null)
  }

  const clearEdges = () => {
    setLayout((current) => ({ ...current, edges: [] }))
    setConnectFrom(null)
    setSelectedEdgeId(null)
  }

  const deleteSelectedEdge = () => {
    if (!selectedEdgeId) return
    setLayout((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== selectedEdgeId),
    }))
    setSelectedEdgeId(null)
  }

  const addPointToSelectedEdge = (point: Point) => {
    if (!selectedEdgeId) return
    setLayout((current) => ({
      ...current,
      edges: current.edges.map((edge) =>
        edge.id === selectedEdgeId
          ? { ...edge, points: [...(edge.points ?? []), point] }
          : edge,
      ),
    }))
  }

  const moveEdgePoint = useCallback((edgeIdValue: string, pointIndex: number, point: Point) => {
    setLayout((current) => ({
      ...current,
      edges: current.edges.map((edge) => {
        if (edge.id !== edgeIdValue) return edge
        const points = [...(edge.points ?? [])]
        points[pointIndex] = point
        return { ...edge, points }
      }),
    }))
  }, [])

  const handleEdgePointPointerDown = (
    event: ReactPointerEvent<SVGCircleElement>,
    edgeIdValue: string,
    pointIndex: number,
  ) => {
    event.stopPropagation()
    if (!editing) return
    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const onMove = (moveEvent: PointerEvent) => {
      const point = eventToCanvasPoint(moveEvent)
      if (point) moveEdgePoint(edgeIdValue, pointIndex, point)
    }
    const onUp = () => {
      element.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const deleteLastPointFromSelectedEdge = () => {
    if (!selectedEdgeId) return
    setLayout((current) => ({
      ...current,
      edges: current.edges.map((edge) => {
        if (edge.id !== selectedEdgeId) return edge
        return { ...edge, points: (edge.points ?? []).slice(0, -1) }
      }),
    }))
  }

  return (
    <div className="org-manual-chart-wrap">
      {canManage ? (
        <div className="org-manual-toolbar" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="btn-ghost" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Просмотр' : 'Редактировать схему'}
          </button>
          {editing ? (
            <>
              <button type="button" className="btn-ghost" onClick={() => setConnectFrom(null)}>
                {connectFrom ? 'Отменить линию' : 'Линия: потяните точку к карточке'}
              </button>
              <button type="button" className="btn-ghost" onClick={deleteSelectedEdge} disabled={!selectedEdgeId}>
                Удалить линию
              </button>
              <button type="button" className="btn-ghost" onClick={deleteLastPointFromSelectedEdge} disabled={!selectedEdgeId}>
                Убрать точку
              </button>
              <button type="button" className="btn-ghost" onClick={clearEdges}>
                Очистить линии
              </button>
              <button type="button" className="btn-ghost" onClick={resetLayout}>
                Сбросить раскладку
              </button>
              <button type="button" className="btn-primary" onClick={() => void saveLayout()}>
                Сохранить
              </button>
            </>
          ) : null}
          {status ? <span className="org-manual-status">{status}</span> : null}
        </div>
      ) : null}
      <div
        ref={canvasRef}
        className={`org-manual-chart${editing ? ' org-manual-chart-editing' : ''}`}
        style={{ width: canvasWidth, height: canvasHeight }}
      >
        <svg
          className="org-manual-lines"
          width={canvasWidth}
          height={canvasHeight}
          onPointerDown={(event) => editing && event.stopPropagation()}
          onClick={(event) => {
            if (!editing || !selectedEdgeId) return
            event.stopPropagation()
            const point = eventToCanvasPoint(event)
            if (point) addPointToSelectedEdge(point)
          }}
        >
          {layout.edges.map((edge) => {
            const from = nodeById.get(edge.fromNodeId)
            const to = nodeById.get(edge.toNodeId)
            if (!from || !to) return null
            return (
              <path
                key={edge.id}
                d={edgePath(edge, from, to)}
                className={`org-manual-line${selectedEdgeId === edge.id ? ' org-manual-line-selected' : ''}`}
                onClick={(event) => {
                  if (!editing) return
                  event.stopPropagation()
                  setSelectedEdgeId(edge.id)
                }}
              />
            )
          })}
          {dragConnection ? (() => {
            const from = nodeById.get(dragConnection.fromNodeId)
            if (!from) return null
            const start = anchorPoint(from, dragConnection.fromAnchor)
            return (
              <path
                className="org-manual-line org-manual-line-preview"
                d={`M ${start.x} ${start.y} L ${dragConnection.point.x} ${dragConnection.point.y}`}
              />
            )
          })() : null}
          {editing && selectedEdgeId ? layout.edges
            .filter((edge) => edge.id === selectedEdgeId)
            .flatMap((edge) => (edge.points ?? []).map((point, pointIndex) => (
              <circle
                key={`${edge.id}:point:${pointIndex}`}
                className="org-manual-line-point"
                cx={point.x}
                cy={point.y}
                r={7}
                onPointerDown={(event) => handleEdgePointPointerDown(event, edge.id, pointIndex)}
              />
            ))) : null}
        </svg>
        {layout.nodes.map((node) => {
          const item = itemById.get(node.id)
          if (!item) return null
          const isConnecting = connectFrom === node.id
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              className={`org-manual-node org-manual-node-${node.kind}${editing ? ' org-manual-node-editing' : ''}${isConnecting ? ' org-manual-node-connecting' : ''}`}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              onPointerDown={(event) => handleNodePointerDown(event, node)}
              onClick={(event) => handleNodeClick(event, node.id)}
            >
              {item.kind === 'department' ? (
                <>
                  <DepartmentCard block={item.block} onDepartmentClick={editing ? undefined : onDepartmentClick} />
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="org-manual-connector-handle org-manual-connector-handle-top"
                        aria-label="Протянуть линию от верхней точки отдела"
                        data-node-id={node.id}
                        data-anchor="top"
                        onPointerDown={(event) => handleConnectorPointerDown(event, node.id, 'top')}
                        onClick={(event) => event.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="org-manual-connector-handle org-manual-connector-handle-bottom"
                        aria-label="Протянуть линию от нижней точки отдела"
                        data-node-id={node.id}
                        data-anchor="bottom"
                        onPointerDown={(event) => handleConnectorPointerDown(event, node.id, 'bottom')}
                        onClick={(event) => event.stopPropagation()}
                      />
                      <button
                        type="button"
                        className="org-manual-resize-handle"
                        aria-label="Изменить размер отдела"
                        onPointerDown={(event) => handleResizePointerDown(event, node)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <PersonCard node={item.node} onEmployeeClick={editing ? undefined : onEmployeeClick} />
                  {editing ? (
                    <button
                      type="button"
                      className="org-manual-connector-handle org-manual-connector-handle-top"
                      aria-label="Протянуть линию от верхней точки сотрудника"
                      data-node-id={node.id}
                      data-anchor="top"
                      onPointerDown={(event) => handleConnectorPointerDown(event, node.id, 'top')}
                      onClick={(event) => event.stopPropagation()}
                    />
                    <button
                      type="button"
                      className="org-manual-connector-handle org-manual-connector-handle-bottom"
                      aria-label="Протянуть линию от нижней точки сотрудника"
                      data-node-id={node.id}
                      data-anchor="bottom"
                      onPointerDown={(event) => handleConnectorPointerDown(event, node.id, 'bottom')}
                      onClick={(event) => event.stopPropagation()}
                    />
                  ) : null}
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
