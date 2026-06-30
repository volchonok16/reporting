import { useMemo, type ReactNode } from 'react'
import { distributeBranchRows } from './orgChartLayout'

type DepartmentBranchRowsProps<T> = {
  items: T[]
  getKey: (item: T) => string | number
  renderItem: (item: T) => ReactNode
  className?: string
}

export default function DepartmentBranchRows<T>({
  items,
  getKey,
  renderItem,
  className = 'org-dept-branch-rows',
}: DepartmentBranchRowsProps<T>) {
  const itemSignature = useMemo(() => items.map(getKey).join('|'), [items, getKey])
  const rows = useMemo(() => distributeBranchRows(items), [itemSignature, items])

  if (items.length === 0) {
    return null
  }

  return (
    <div className={`${className}${items.length === 1 ? ` ${className}-single` : ''}`}>
      {rows.map((row) => (
        <div key={row.map(getKey).join('-')} className="org-dept-branch-row">
          {row.map((item) => (
            <div key={getKey(item)} className="org-dept-branch-row-item">
              {renderItem(item)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
