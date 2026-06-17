export function columnBarClass(column: string | null | undefined): string {
  const normalized = (column ?? '').trim()
  switch (normalized) {
    case 'New':
      return 'new'
    case 'Backlog':
    case 'To do':
      return 'backlog'
    case 'Express Analysis':
      return 'express'
    case 'Analysis Backlog':
      return 'analysis-bl'
    case 'Analysis':
    case 'Architecture':
    case 'Full Analysis':
    case 'Pre-analysis':
    case 'Pre-analysis Backlog':
      return 'analysis'
    case 'Briefing/Formulation':
    case 'Design':
    case 'Design Backlog':
      return 'backlog'
    case 'Development':
      return 'development'
    case 'UAT':
      return 'uat'
    case 'Pilot':
      return 'pilot'
    case 'Closed':
    case 'TERM':
    case 'Done':
      return 'closed'
    default:
      return 'default'
  }
}
