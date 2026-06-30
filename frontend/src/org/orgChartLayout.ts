import type { DepartmentBlock, OrgChartNode } from './types'

export const ORG_TREE_MAX_SIBLINGS_PER_ROW = 5
/** Максимум колонок для раскладки рамок отделов (masonry). */
export const ORG_DEPT_MASONRY_COLUMNS_MAX = 3

const CARD_HEIGHT = 180
const TREE_LEVEL_GAP = 48
const TREE_ROW_GAP = 40
const DEPT_FRAME_OVERHEAD = 130
const MASONRY_ITEM_GAP = 32

/** 1 → одна колонка, 2 → две, 3+ → до трёх колонок. */
export function masonryColumnCount(itemCount: number): number {
  if (itemCount <= 1) {
    return 1
  }
  if (itemCount === 2) {
    return 2
  }
  return Math.min(ORG_DEPT_MASONRY_COLUMNS_MAX, itemCount)
}
const TREE_LEVEL_GAP = 48
const TREE_ROW_GAP = 40
const DEPT_FRAME_OVERHEAD = 130
const MASONRY_ITEM_GAP = 32

export function distributeShortestColumn<T>(
  items: T[],
  columnCount: number,
  getHeight: (item: T) => number,
): T[][] {
  if (items.length === 0) {
    return []
  }

  const columns = Array.from({ length: columnCount }, () => [] as T[])
  const heights = Array.from({ length: columnCount }, () => 0)

  for (const item of items) {
    let targetColumn = 0
    for (let i = 1; i < columnCount; i += 1) {
      if (heights[i] < heights[targetColumn]) {
        targetColumn = i
      }
    }
    columns[targetColumn].push(item)
    heights[targetColumn] += getHeight(item) + MASONRY_ITEM_GAP
  }

  return columns.filter((column) => column.length > 0)
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

export function estimateDepartmentBlockHeight(block: DepartmentBlock): number {
  let height = DEPT_FRAME_OVERHEAD + estimateTreeRootsHeight(block.roots)
  const nested = block.nestedDepartments ?? []
  if (nested.length > 0) {
    height += TREE_LEVEL_GAP + estimateMasonryPackHeight(nested)
  }
  return height
}

export function estimateStandaloneRootHeight(root: OrgChartNode): number {
  return estimateNodeHeight(root)
}

export function estimateMasonryPackHeight(blocks: DepartmentBlock[]): number {
  const columns = distributeShortestColumn(
    blocks,
    masonryColumnCount(blocks.length),
    estimateDepartmentBlockHeight,
  )
  if (columns.length === 0) {
    return 0
  }
  return Math.max(
    ...columns.map((column) =>
      column.reduce((sum, block, index) => {
        const gap = index === 0 ? 0 : MASONRY_ITEM_GAP
        return sum + gap + estimateDepartmentBlockHeight(block)
      }, 0),
    ),
  )
}

export function columnsFromMeasuredHeights<T>(
  items: T[],
  columnCount: number,
  heights: Map<string | number, number>,
  getKey: (item: T) => string | number,
  fallbackHeight: (item: T) => number,
): T[][] {
  const columnHeights = Array.from({ length: columnCount }, () => 0)
  const columns = Array.from({ length: columnCount }, () => [] as T[])

  for (const item of items) {
    const key = getKey(item)
    let targetColumn = 0
    for (let i = 1; i < columnCount; i += 1) {
      if (columnHeights[i] < columnHeights[targetColumn]) {
        targetColumn = i
      }
    }
    columns[targetColumn].push(item)
    columnHeights[targetColumn] += (heights.get(key) ?? fallbackHeight(item)) + MASONRY_ITEM_GAP
  }

  return columns.filter((column) => column.length > 0)
}
