import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { getJson, putJson } from '../api'
import type {
  DepartmentBlock,
  OrgChartLayout,
  OrgChartLayoutData,
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
  | { id: string; kind: 'employee'; refId: number; node: OrgChartNode; parentId?: string | null }
  | { id: string; kind: 'department'; refId: number; block: DepartmentBlock; parentId?: string | null }

const EMPLOYEE_NODE_WIDTH = 180
const EMPLOYEE_NODE_HEIGHT = 190
const DEPARTMENT_NODE_WIDTH = 420
const DEPARTMENT_NODE_HEIGHT = 280
const NODE_GAP_X = 36
const NODE_GAP_Y = 48
const NODES_PER_ROW = 4

function employeeNodeId(employeeId: number): string {
  return `employee:${employeeId}`
}

function departmentNodeId(departmentId: number): string {
  return `department:${departmentId}`
}

function edgeId(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}->${toNodeId}`
}

function flattenDepartments(blocks: DepartmentBlock[], parentId: string | null = null): ChartItem[] {
  return blocks.flatMap((block) => {
    const id = departmentNodeId(block.departmentId)
    return [
      { id, kind: 'department' as const, refId: block.departmentId, block, parentId },
      ...flattenDepartments(block.nestedDepartments ?? [], id),
    ]
  })
}

function flattenEmployeeTree(root: OrgChartNode): OrgChartNode[] {
  return [root, ...root.children.flatMap(flattenEmployeeTree)]
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
  const deptItems = flattenDepartments(departments, organizationHead ? employeeNodeId(organizationHead.person.employeeId) : null)
  const standaloneItems = standaloneRoots.flatMap((root) =>
    flattenEmployeeTree(root).map((node) => ({
      id: employeeNodeId(node.person.employeeId),
      kind: 'employee' as const,
      refId: node.person.employeeId,
      node,
      parentId: node.person.employeeId === root.person.employeeId && organizationHead
        ? employeeNodeId(organizationHead.person.employeeId)
        : null,
    })),
  )
  return [...headItem, ...deptItems, ...standaloneItems]
}

function defaultLayout(items: ChartItem[]): OrgChartLayoutData {
  const head = items.find((item) => item.kind === 'employee' && item.parentId == null)
  const rest = items.filter((item) => item.id !== head?.id)
  const maxNodeWidth = DEPARTMENT_NODE_WIDTH
  const rowWidth = NODES_PER_ROW * maxNodeWidth + (NODES_PER_ROW - 1) * NODE_GAP_X
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

  rest.forEach((item, index) => {
    const row = Math.floor(index / NODES_PER_ROW)
    const col = index % NODES_PER_ROW
    const width = item.kind === 'department' ? DEPARTMENT_NODE_WIDTH : EMPLOYEE_NODE_WIDTH
    const height = item.kind === 'department' ? DEPARTMENT_NODE_HEIGHT : EMPLOYEE_NODE_HEIGHT
    nodes.push({
      id: item.id,
      kind: item.kind,
      refId: item.refId,
      x: col * (maxNodeWidth + NODE_GAP_X) + (maxNodeWidth - width) / 2,
      y: EMPLOYEE_NODE_HEIGHT + NODE_GAP_Y + row * (DEPARTMENT_NODE_HEIGHT + NODE_GAP_Y),
      width,
      height,
    })
  })

  const knownNodeIds = new Set(nodes.map((node) => node.id))
  const edges = items
    .filter((item) => item.parentId && knownNodeIds.has(item.parentId))
    .map((item) => ({
      id: edgeId(item.parentId as string, item.id),
      fromNodeId: item.parentId as string,
      toNodeId: item.id,
    }))

  return { nodes, edges }
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
    const savedNode = savedById.get(generatedNode.id)
    const item = itemById.get(generatedNode.id)
    if (!savedNode || !item) return generatedNode
    const width = item.kind === 'department' ? DEPARTMENT_NODE_WIDTH : EMPLOYEE_NODE_WIDTH
    const height = item.kind === 'department' ? DEPARTMENT_NODE_HEIGHT : EMPLOYEE_NODE_HEIGHT
    return { ...savedNode, kind: item.kind, refId: item.refId, width, height }
  })
  const knownNodeIds = new Set(nodes.map((node) => node.id))
  const edges = saved.edges.filter(
    (edge) => knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId),
  )
  for (const generatedEdge of generated.edges) {
    if (!edges.some((edge) => edge.id === generatedEdge.id)) {
      const fromMoved = savedById.has(generatedEdge.fromNodeId)
      const toMoved = savedById.has(generatedEdge.toNodeId)
      if (!fromMoved || !toMoved || generatedById.has(generatedEdge.toNodeId)) {
        edges.push(generatedEdge)
      }
    }
  }
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
  const head = block.roots[0]
  return (
    <div className="org-manual-dept-card">
      {title}
      {head ? <PersonCard node={head} /> : <div className="org-empty">Нет руководителя</div>}
      <div className="org-manual-dept-count">
        {block.roots.flatMap(flattenEmployeeTree).length} сотрудн.
      </div>
    </div>
  )
}

function edgePath(from: OrgChartLayoutNode, to: OrgChartLayoutNode): string {
  const startX = from.x + from.width / 2
  const startY = from.y + from.height
  const endX = to.x + to.width / 2
  const endY = to.y
  const middleY = startY + Math.max(24, (endY - startY) / 2)
  return `M ${startX} ${startY} V ${middleY} H ${endX} V ${endY}`
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
  const items = useMemo(
    () => buildChartItems(organizationHead, departments, standaloneRoots),
    [organizationHead, departments, standaloneRoots],
  )
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const [layout, setLayout] = useState<OrgChartLayoutData>(() => defaultLayout(items))
  const [editing, setEditing] = useState(false)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
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

  const updateNodePosition = useCallback((nodeId: string, x: number, y: number) => {
    setLayout((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, x, y } : node),
    }))
  }, [])

  const handleNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, node: OrgChartLayoutNode) => {
    if (!editing || event.button !== 0) return
    if ((event.target as Element).closest('button')) return
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

    const onMove = (moveEvent: PointerEvent) => {
      updateNodePosition(
        node.id,
        Math.max(0, initialX + (moveEvent.clientX - startX) / scale),
        Math.max(0, initialY + (moveEvent.clientY - startY) / scale),
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

  const handleNodeClick = (nodeId: string) => {
    if (!editing) return
    setSelectedEdgeId(null)
    if (!connectFrom) {
      setConnectFrom(nodeId)
      return
    }
    if (connectFrom === nodeId) {
      setConnectFrom(null)
      return
    }
    const id = edgeId(connectFrom, nodeId)
    setLayout((current) => ({
      ...current,
      edges: current.edges.some((edge) => edge.id === id)
        ? current.edges
        : [...current.edges, { id, fromNodeId: connectFrom, toNodeId: nodeId }],
    }))
    setConnectFrom(null)
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

  const deleteSelectedEdge = () => {
    if (!selectedEdgeId) return
    setLayout((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== selectedEdgeId),
    }))
    setSelectedEdgeId(null)
  }

  return (
    <div className="org-manual-chart-wrap">
      {canManage ? (
        <div className="org-manual-toolbar">
          <button type="button" className="btn-ghost" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Просмотр' : 'Редактировать схему'}
          </button>
          {editing ? (
            <>
              <button type="button" className="btn-ghost" onClick={() => setConnectFrom(null)}>
                {connectFrom ? 'Отменить линию' : 'Линия: клик по двум карточкам'}
              </button>
              <button type="button" className="btn-ghost" onClick={deleteSelectedEdge} disabled={!selectedEdgeId}>
                Удалить линию
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
        <svg className="org-manual-lines" width={canvasWidth} height={canvasHeight}>
          {layout.edges.map((edge) => {
            const from = nodeById.get(edge.fromNodeId)
            const to = nodeById.get(edge.toNodeId)
            if (!from || !to) return null
            return (
              <path
                key={edge.id}
                d={edgePath(from, to)}
                className={`org-manual-line${selectedEdgeId === edge.id ? ' org-manual-line-selected' : ''}`}
                onClick={() => editing && setSelectedEdgeId(edge.id)}
              />
            )
          })}
        </svg>
        {layout.nodes.map((node) => {
          const item = itemById.get(node.id)
          if (!item) return null
          const isConnecting = connectFrom === node.id
          return (
            <div
              key={node.id}
              className={`org-manual-node${editing ? ' org-manual-node-editing' : ''}${isConnecting ? ' org-manual-node-connecting' : ''}`}
              style={{ left: node.x, top: node.y, width: node.width }}
              onPointerDown={(event) => handleNodePointerDown(event, node)}
              onClick={() => handleNodeClick(node.id)}
            >
              {item.kind === 'department' ? (
                <DepartmentCard block={item.block} onDepartmentClick={onDepartmentClick} />
              ) : (
                <PersonCard node={item.node} onEmployeeClick={onEmployeeClick} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
