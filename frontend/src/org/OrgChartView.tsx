import type { DepartmentBlock, OrgChartNode } from './types'
import OrgPhoto from './OrgPhoto'

type OrgChartViewProps = {
  roots?: OrgChartNode[]
  organizationHead?: OrgChartNode | null
  departments?: DepartmentBlock[]
  departmentName?: string
  framed?: boolean
  onEmployeeClick?: (employeeId: number) => void
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
        <ul className="org-tree-children">
          {node.children.map((child) => (
            <OrgTreeNode key={child.person.employeeId} node={child} onEmployeeClick={onEmployeeClick} />
          ))}
        </ul>
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

function NestedDepartmentBlock({
  block,
  onEmployeeClick,
}: {
  block: DepartmentBlock
  onEmployeeClick?: (employeeId: number) => void
}) {
  return (
    <div className="org-dept-block">
      <h4 className="org-dept-title">{block.departmentName}</h4>
      <OrgTreeRoots roots={block.roots} onEmployeeClick={onEmployeeClick} />
      {block.nestedDepartments?.map((nested) => (
        <NestedDepartmentBlock key={nested.departmentId} block={nested} onEmployeeClick={onEmployeeClick} />
      ))}
    </div>
  )
}

function DepartmentBranch({
  block,
  onEmployeeClick,
}: {
  block: DepartmentBlock
  onEmployeeClick?: (employeeId: number) => void
}) {
  return (
    <div className="org-dept-branch">
      <div className="org-chart-scroll">
        <div className="org-dept-frame">
          <h3 className="org-dept-frame-title">{block.departmentName}</h3>
          <div className="org-dept-frame-body">
            <OrgTreeRoots roots={block.roots} onEmployeeClick={onEmployeeClick} />
            {block.nestedDepartments?.map((nested) => (
              <NestedDepartmentBlock key={nested.departmentId} block={nested} onEmployeeClick={onEmployeeClick} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function CompanyPyramid({
  organizationHead,
  departments,
  onEmployeeClick,
}: {
  organizationHead?: OrgChartNode | null
  departments: DepartmentBlock[]
  onEmployeeClick?: (employeeId: number) => void
}) {
  return (
    <div className="org-company-pyramid">
      {organizationHead ? (
        <div className="org-company-pyramid-head">
          <ul className="org-tree">
            <OrgTreeNode node={organizationHead} onEmployeeClick={onEmployeeClick} />
          </ul>
        </div>
      ) : null}
      {departments.length > 0 ? (
        <div className="org-company-pyramid-branches">
          {departments.map((block) => (
            <DepartmentBranch key={block.departmentId} block={block} onEmployeeClick={onEmployeeClick} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default function OrgChartView({
  roots = [],
  organizationHead,
  departments,
  departmentName,
  framed,
  onEmployeeClick,
}: OrgChartViewProps) {
  const isCompanyView = departments !== undefined
  const showFrame = framed ?? Boolean(departmentName)

  if (isCompanyView) {
    if (!organizationHead && departments.length === 0) {
      return <p className="org-empty">Нет данных для построения пирамиды.</p>
    }

    return (
      <div className="org-chart-scroll">
        <div className="org-chart">
          <CompanyPyramid
            organizationHead={organizationHead}
            departments={departments}
            onEmployeeClick={onEmployeeClick}
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
          <h3 className="org-dept-frame-title">{departmentName}</h3>
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
