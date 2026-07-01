import { ORG_TREE_MAX_SIBLINGS_PER_ROW } from './orgChartLayout'
import type { DepartmentBlock, OrgChartNode } from './types'
import ManualOrgChartView from './ManualOrgChartView'
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
  canManage?: boolean
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
    <ul className="org-tree org-tree-roots">
      {roots.map((root) => (
        <OrgTreeNode key={root.person.employeeId} node={root} onEmployeeClick={onEmployeeClick} />
      ))}
    </ul>
  )
}

function CompanyPyramid({
  organizationHead,
  departments,
  standaloneRoots = [],
  canManage = false,
  onEmployeeClick,
  onDepartmentClick,
}: {
  organizationHead?: OrgChartNode | null
  departments: DepartmentBlock[]
  standaloneRoots?: OrgChartNode[]
  canManage?: boolean
  onEmployeeClick?: (employeeId: number) => void
  onDepartmentClick?: (departmentId: number) => void
}) {
  return (
    <ManualOrgChartView
      organizationHead={organizationHead}
      departments={departments}
      standaloneRoots={standaloneRoots}
      canManage={canManage}
      onEmployeeClick={onEmployeeClick}
      onDepartmentClick={onDepartmentClick}
    />
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
  canManage = false,
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
            canManage={canManage}
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
