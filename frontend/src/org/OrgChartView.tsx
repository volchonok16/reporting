import type { OrgChartNode } from './types'
import OrgPhoto from './OrgPhoto'

type OrgChartViewProps = {
  roots: OrgChartNode[]
  organizationHead?: OrgChartNode | null
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
        {person.email ? <div className="org-person-email">{person.email}</div> : null}
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

function OrgTree({
  roots,
  organizationHead,
  onEmployeeClick,
}: {
  roots: OrgChartNode[]
  organizationHead?: OrgChartNode | null
  onEmployeeClick?: (employeeId: number) => void
}) {
  return (
    <div className="org-tree-chart">
      {organizationHead ? (
        <div className="org-chart-company-head">
          <ul className="org-tree">
            <OrgTreeNode node={organizationHead} onEmployeeClick={onEmployeeClick} />
          </ul>
        </div>
      ) : null}
      {roots.length > 0 ? (
        <ul className="org-tree org-tree-roots">
          {roots.map((root) => (
            <OrgTreeNode key={root.person.employeeId} node={root} onEmployeeClick={onEmployeeClick} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default function OrgChartView({
  roots,
  organizationHead,
  departmentName,
  framed,
  onEmployeeClick,
}: OrgChartViewProps) {
  const showFrame = framed ?? Boolean(departmentName)

  if (!organizationHead && roots.length === 0) {
    return <p className="org-empty">Нет данных для построения пирамиды.</p>
  }

  const chart = (
    <OrgTree roots={roots} organizationHead={organizationHead} onEmployeeClick={onEmployeeClick} />
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
