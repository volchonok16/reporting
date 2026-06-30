import type { DepartmentBlock, OrgChartNode } from './types'

export const ORG_TREE_MAX_SIBLINGS_PER_ROW = 5
/** Максимум рамок отделов в одном горизонтальном ряду. */
export const ORG_DEPT_BRANCHES_PER_ROW = 4

const CARD_HEIGHT = 180
const TREE_LEVEL_GAP = 48
const TREE_ROW_GAP = 40
const DEPT_FRAME_OVERHEAD = 130
const BRANCH_ROW_GAP = 32

function chunkItems<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size))
  }
  return rows
}

/** Разбивает ветки на горизонтальные ряды (до 4 в ряд). */
export function distributeBranchRows<T>(items: T[]): T[][] {
  if (items.length === 0) {
    return []
  }
  if (items.length <= ORG_DEPT_BRANCHES_PER_ROW) {
    return [items]
  }
  return chunkItems(items, ORG_DEPT_BRANCHES_PER_ROW)
}

function estimateNodeHeight(node: OrgChartNode): number {
  if (node.children.length === 0) {
    return CARD_HEIGHT
  }

  const childRows = Math.ceil(node.children.length / ORG_TREE_MAX_SIBLINGS_PER_ROW)
  const childrenBandHeight =
    childRows * CARD_HEIGHT + Math.max(0, childRows - 1) * TREE_ROW_GAP + TREE_LEVEL_GAP
  const deepestChild = Math.max(...node.children.map(estimateNodeHeight))

  return CARD_HEIGHT + Math.max(childrenBandHeight, deepestChild)
}

function estimateTreeRootsHeight(roots: OrgChartNode[]): number {
  if (roots.length === 0) {
    return 0
  }
  return Math.max(...roots.map(estimateNodeHeight))
}

function estimateBranchRowsPackHeight(blocks: DepartmentBlock[]): number {
  const rows = distributeBranchRows(blocks)
  return rows.reduce((sum, row, rowIndex) => {
    const rowHeight = Math.max(...row.map(estimateDepartmentBlockHeight))
    const gap = rowIndex === 0 ? 0 : BRANCH_ROW_GAP + TREE_LEVEL_GAP
    return sum + gap + rowHeight
  }, 0)
}

export function estimateDepartmentBlockHeight(block: DepartmentBlock): number {
  let height = DEPT_FRAME_OVERHEAD + estimateTreeRootsHeight(block.roots)
  const nested = block.nestedDepartments ?? []
  if (nested.length > 0) {
    height += TREE_LEVEL_GAP + estimateBranchRowsPackHeight(nested)
  }
  return height
}

export function estimateStandaloneRootHeight(root: OrgChartNode): number {
  return estimateNodeHeight(root)
}
