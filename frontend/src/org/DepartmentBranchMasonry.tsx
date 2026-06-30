import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  columnsFromMeasuredHeights,
  distributeShortestColumn,
  masonryColumnCount,
} from './orgChartLayout'

type DepartmentBranchMasonryProps<T> = {
  items: T[]
  getKey: (item: T) => string | number
  estimateHeight: (item: T) => number
  renderItem: (item: T, meta: { columnIndex: number; itemIndex: number }) => ReactNode
  className?: string
  columnClassName?: string
}

export default function DepartmentBranchMasonry<T>({
  items,
  getKey,
  estimateHeight,
  renderItem,
  className = 'org-dept-branch-masonry',
  columnClassName = 'org-dept-branch-masonry-column',
}: DepartmentBranchMasonryProps<T>) {
  const measureRef = useRef<HTMLDivElement>(null)
  const measuredHeightsRef = useRef<Map<string | number, number> | null>(null)
  const columnCount = masonryColumnCount(items.length)
  const [columns, setColumns] = useState<T[][]>(() =>
    distributeShortestColumn(items, columnCount, estimateHeight),
  )

  const itemSignature = useMemo(() => items.map(getKey).join('|'), [items, getKey])

  useLayoutEffect(() => {
    measuredHeightsRef.current = null
    setColumns(distributeShortestColumn(items, masonryColumnCount(items.length), estimateHeight))
  }, [itemSignature, items, estimateHeight])

  useLayoutEffect(() => {
    const measureRoot = measureRef.current
    if (!measureRoot || items.length === 0) {
      return
    }

    const measured = new Map<string | number, number>()
    for (const item of items) {
      const key = getKey(item)
      const node = measureRoot.querySelector<HTMLElement>(`[data-masonry-key="${key}"]`)
      if (!node) {
        return
      }
      measured.set(key, node.offsetHeight)
    }

    if (measuredHeightsRef.current) {
      return
    }
    measuredHeightsRef.current = measured

    const nextColumns = columnsFromMeasuredHeights(
      items,
      masonryColumnCount(items.length),
      measured,
      getKey,
      estimateHeight,
    )

    setColumns((current) => {
      const currentSignature = current.flat().map(getKey).join('|')
      const nextSignature = nextColumns.flat().map(getKey).join('|')
      return currentSignature === nextSignature ? current : nextColumns
    })
  })

  const renderColumns = useCallback(
    () =>
      columns.map((column, columnIndex) => (
        <div
          key={`col-${column.map(getKey).join('-')}`}
          className={columnClassName}
          data-masonry-column={columnIndex}
        >
          {column.map((item, itemIndex) => (
            <div
              key={getKey(item)}
              className={`org-dept-branch-masonry-item${
                itemIndex === 0 ? ' org-dept-branch-masonry-item-first' : ' org-dept-branch-masonry-item-follow'
              }`}
              data-masonry-key={getKey(item)}
            >
              {renderItem(item, { columnIndex, itemIndex })}
            </div>
          ))}
        </div>
      )),
    [columnClassName, columns, getKey, renderItem],
  )

  if (items.length === 0) {
    return null
  }

  if (items.length === 1) {
    return (
      <div className={`${className} ${className}-single`}>
        <div className={columnClassName}>
          <div className="org-dept-branch-masonry-item org-dept-branch-masonry-item-first" data-masonry-key={getKey(items[0])}>
            {renderItem(items[0], { columnIndex: 0, itemIndex: 0 })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div ref={measureRef} className={`${className} ${className}-measure`} aria-hidden="true">
        {items.map((item) => (
          <div key={getKey(item)} className="org-dept-branch-masonry-measure-item" data-masonry-key={getKey(item)}>
            {renderItem(item, { columnIndex: 0, itemIndex: 0 })}
          </div>
        ))}
      </div>
      <div className={className}>{renderColumns()}</div>
    </>
  )
}
