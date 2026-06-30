import DepartmentBranchRows from './DepartmentBranchRows'
import { ORG_TREE_MAX_SIBLINGS_PER_ROW } from './orgChartLayout'
import type { DepartmentBlock, OrgChartNode } from './types'
import OrgPhoto from './OrgPhoto'

function chunkItems<T>(items: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size))
  }
  return rows
}

type OrgChartViewProps = {
  roots?: OrgChartNode[]
  organizationHead?: OrgChartNode | null
  departments?: DepartmentBlock[]
  standaloneRoots?: OrgChartNode[]
  departmentName?: string
  departmentId?: number | null
  framed?: boolean
  onEmployeeClick?: (employeeId: number) => void
  onDepartmentClick?: (departmentId: number) => void
}

function PersonCard({
  node,
  onEmployeeClick,
}: {
  node: OrgChartNode
  onEmployeeClick?: (employeeId: number) => void
}) {
  const { person } = node

  const cardBody = (
    <>
      <div className="org-person-avatar">
        <OrgPhoto
          url={person.photoUrl}
          name={person.fullName}
          className="org-person-avatar-img"
          placeholderClassName="org-person-avatar-placeholder"
        />
      </div>
      <div className="org-person-info">
        <div className="org-person-name">{person.fullName}</div>
        {person.position ? <div className="org-person-position">{person.position}</div> : null}
        {person.teamRole ? <div className="org-person-role">{person.teamRole}</div> : null}
      </div>
    </>
  )

  return (
    <div className={`org-person-card${person.isHead ? ' org-person-card-head' : ''}`}>
      {onEmployeeClick ? (
        <button
          type="button"
          className="org-person-card-button"
          onClick={() => onEmployeeClick(person.employeeId)}
        >
          {cardBody}
        </button>
      ) : (
        cardBody
      )}
    </div>
  )
}

function OrgTreeChildren({
  children,
  onEmployeeClick,
}: {
  children: OrgChartNode[]
  onEmployeeClick?: (employeeId: number) => void
}) {
  const rows =
    children.length <= ORG_TREE_MAX_SIBLINGS_PER_ROW
      ? [children]
      : chunkItems(children, ORG_TREE_MAX_SIBLINGS_PER_ROW)

  if (rows.length === 1) {
    return (
      <ul className="org-tree-children">
        {children.map((child) => (
          <OrgTreeNode key={child.person.employeeId} node={child} onEmployeeClick={onEmployeeClick} />
        ))}
      </ul>
    )
  }

  return (
    <div className="org-tree-children-stacked">
      {rows.map((row) => (
        <ul key={row.map((node) => node.person.employeeId).join('-')} className="org-tree-children org-tree-children-row">
          {row.map((child) => (
            <OrgTreeNode key={child.person.employeeId} node={child} onEmployeeClick={onEmployeeClick} />
          ))}
        </ul>
      ))}
    </div>
  )
}

function OrgTreeNode({
  node,
  onEmployeeClick,
}: {
  node: OrgChartNode
  onEmployeeClick?: (employeeId: number) => void
}) {
  return (
    <li className="org-tree-node">
      <PersonCard node={node} onEmployeeClick={onEmployeeClick} />
      {node.children.length > 0 ? (
        <OrgTreeChildren children={node.children} onEmployeeClick={onEmployeeClick} />
      ) : null}
    </li>
  )
}

function OrgTreeRoots({
  roots,
  onEmployeeClick,
}: {
  roots: OrgChartNode[]
  onEmployeeClick?: (employeeId: number) => void
}) {
  if (roots.length === 0) {
    return null
  }

  return (
    <ul className="org-tree">
      {roots.map((root) => (
        <OrgTreeNode key={root.person.employeeId} node={root} onEmployeeClick={onEmployeeClick} />
      ))}
    </ul>
  )
}

function DepartmentFrame({
  block,
  onEmployeeClick,
  onDepartmentClick,
}: {
  block: DepartmentBlock
  onEmployeeClick?: (employeeId: number) => void
  onDepartmentClick?: (departmentId: number) => void
}) {
  return (
    <div className="org-dept-frame">
      {onDepartmentClick ? (
        <button
          type="button"
          className="org-dept-frame-title org-dept-frame-title-btn"
          onClick={() => onDepartmentClick(block.departmentId)}
          title="Открыть карточку отдела"
        >
          {block.departmentName}
        </button>
      ) : (
        <h3 className="org-dept-frame-title">{block.departmentName}</h3>
      )}
      <div className="org-dept-frame-body">
        <OrgTreeRoots roots={block.roots} onEmployeeClick={onEmployeeClick} />
      </div>
    </div>
  )
}

function NestedDepartments({
  blocks,
  onEmployeeClick,
  onDepartmentClick,
}: {
  blocks: DepartmentBlock[]
  onEmployeeClick?: (employeeId: number) => void
  onDepartmentClick?: (departmentId: number) => void
}) {
  return (
    <DepartmentBranchRows
      className="org-dept-branch-rows org-dept-branch-nested"
      items={blocks}
      getKey={(block) => block.departmentId}
      renderItem={(nestedBlock) => (
        <DepartmentBranchColumn
          block={nestedBlock}
          onEmployeeClick={onEmployeeClick}
          onDepartmentClick={onDepartmentClick}
          nested
        />
      )}
    />
  )
}

function DepartmentBranchColumn({
  block,
  onEmployeeClick,
  onDepartmentClick,
  nested = false,
}: {
  block: DepartmentBlock
  onEmployeeClick?: (employeeId: number) => void
  onDepartmentClick?: (departmentId: number) => void
  nested?: boolean
}) {
  return (
    <div className={`org-dept-branch-column${nested ? ' org-dept-branch-column-nested' : ''}`}>
      <div className="org-dept-branch">
        <div className="org-chart-scroll">
          <DepartmentFrame
            block={block}
            onEmployeeClick={onEmployeeClick}
            onDepartmentClick={onDepartmentClick}
          />
        </div>
      </div>
      {block.nestedDepartments && block.nestedDepartments.length > 0 ? (
        <NestedDepartments
          blocks={block.nestedDepartments}
          onEmployeeClick={onEmployeeClick}
          onDepartmentClick={onDepartmentClick}
        />
      ) : null}
    </div>
  )
}

function StandaloneBranchColumn({
  root,
  onEmployeeClick,
}: {
  root: OrgChartNode
  onEmployeeClick?: (employeeId: number) => void
}) {
  return (
    <div className="org-dept-branch-column org-dept-branch-column-standalone">
      <div className="org-dept-branch org-dept-branch-standalone">
        <div className="org-chart-scroll">
          <OrgTreeRoots roots={[root]} onEmployeeClick={onEmployeeClick} />
        </div>
      </div>
    </div>
  )
}

type CompanyBranchItem =
  | { kind: 'department'; block: DepartmentBlock }
  | { kind: 'standalone'; root: OrgChartNode }

function CompanyPyramid({
  organizationHead,
  departments,
  standaloneRoots = [],
  onEmployeeClick,
  onDepartmentClick,
}: {
  organizationHead?: OrgChartNode | null
  departments: DepartmentBlock[]
  standaloneRoots?: OrgChartNode[]
  onEmployeeClick?: (employeeId: number) => void
  onDepartmentClick?: (departmentId: number) => void
}) {
  const branchItems: CompanyBranchItem[] = [
    ...departments.map((block) => ({ kind: 'department' as const, block })),
    ...standaloneRoots.map((root) => ({ kind: 'standalone' as const, root })),
  ]
  const hasBranches = branchItems.length > 0

  return (
    <div className="org-company-pyramid">
      {organizationHead ? (
        <div className="org-company-pyramid-head">
          <ul className="org-tree">
            <OrgTreeNode node={organizationHead} onEmployeeClick={onEmployeeClick} />
          </ul>
        </div>
      ) : null}
      {hasBranches ? (
        <DepartmentBranchRows
          className="org-dept-branch-rows org-company-pyramid-branches"
          items={branchItems}
          getKey={(item) => (item.kind === 'department' ? item.block.departmentId : item.root.person.employeeId)}
          renderItem={(item) =>
            item.kind === 'department' ? (
              <DepartmentBranchColumn
                block={item.block}
                onEmployeeClick={onEmployeeClick}
                onDepartmentClick={onDepartmentClick}
              />
            ) : (
              <StandaloneBranchColumn root={item.root} onEmployeeClick={onEmployeeClick} />
            )
          }
        />
      ) : null}
    </div>
  )
}

export default function OrgChartView({
  roots = [],
  organizationHead,
  departments,
  standaloneRoots: standaloneRootsProp,
  departmentName,
  departmentId,
  framed,
  onEmployeeClick,
  onDepartmentClick,
}: OrgChartViewProps) {
  const isCompanyView = departments !== undefined
  const showFrame = framed ?? Boolean(departmentName)

  if (isCompanyView) {
    const standaloneRoots = standaloneRootsProp ?? []
    if (!organizationHead && departments.length === 0 && standaloneRoots.length === 0) {
      return <p className="org-empty">Нет данных для построения пирамиды.</p>
    }

    return (
      <div className="org-chart-scroll">
        <div className="org-chart">
          <CompanyPyramid
            organizationHead={organizationHead}
            departments={departments}
            standaloneRoots={standaloneRoots}
            onEmployeeClick={onEmployeeClick}
            onDepartmentClick={onDepartmentClick}
          />
        </div>
      </div>
    )
  }

  if (!organizationHead && roots.length === 0) {
    return <p className="org-empty">Нет данных для построения пирамиды.</p>
  }

  const chart = (
    <div className="org-tree-chart">
      <OrgTreeRoots roots={roots} onEmployeeClick={onEmployeeClick} />
    </div>
  )

  if (showFrame && departmentName) {
    return (
      <div className="org-chart-scroll">
        <div className="org-dept-frame">
          {onDepartmentClick && departmentId != null ? (
            <button
              type="button"
              className="org-dept-frame-title org-dept-frame-title-btn"
              onClick={() => onDepartmentClick(departmentId)}
              title="Открыть карточку отдела"
            >
              {departmentName}
            </button>
          ) : (
            <h3 className="org-dept-frame-title">{departmentName}</h3>
          )}
          <div className="org-dept-frame-body">{chart}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="org-chart-scroll">
      <div className="org-chart">{chart}</div>
    </div>
  )
}
