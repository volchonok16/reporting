import type { OrgChartNode } from './types'

type OrgChartViewProps = {
  roots: OrgChartNode[]
  organizationHead?: OrgChartNode | null
  departmentName?: string
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
  const initials = person.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  const cardBody = (
    <>
      <div className="org-person-avatar">
        {person.photoUrl ? (
          <img src={person.photoUrl} alt="" />
        ) : (
          <span>{initials || '?'}</span>
        )}
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

function OrgNode({
  node,
  onEmployeeClick,
}: {
  node: OrgChartNode
  onEmployeeClick?: (employeeId: number) => void
}) {
  return (
    <div className="org-node">
      <PersonCard node={node} onEmployeeClick={onEmployeeClick} />
      {node.children.length > 0 ? (
        <div className="org-node-children">
          {node.children.map((child) => (
            <OrgNode key={child.person.employeeId} node={child} onEmployeeClick={onEmployeeClick} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default function OrgChartView({
  roots,
  organizationHead,
  departmentName,
  onEmployeeClick,
}: OrgChartViewProps) {
  if (!organizationHead && roots.length === 0) {
    return <p className="org-empty">Нет данных для построения пирамиды.</p>
  }

  return (
    <div className="org-chart-scroll">
      <div className="org-chart">
        {organizationHead ? (
          <div className="org-chart-company">
            <OrgNode node={organizationHead} onEmployeeClick={onEmployeeClick} />
          </div>
        ) : null}
        {departmentName ? <h3 className="org-dept-title">{departmentName}</h3> : null}
        <div className="org-chart-roots">
          {roots.map((root) => (
            <OrgNode key={root.person.employeeId} node={root} onEmployeeClick={onEmployeeClick} />
          ))}
        </div>
      </div>
    </div>
  )
}
