import { useState } from 'react'
import { loadPlanningUiState, savePlanningUiState } from '../uiState'
import '../org/org.css'
import PlanningAllocations from './PlanningAllocations'
import PlanningDirectories from './PlanningDirectories'
import PlanningProjects from './PlanningProjects'
import PlanningWorkload from './PlanningWorkload'
import type { PlanningPanelId } from './types'
import './planning.css'

type PlanningProps = {
  onNavigateToZni?: (requestNumber: string) => void
}

const PANELS: Array<{ id: PlanningPanelId; label: string }> = [
  { id: 'projects', label: 'Проекты' },
  { id: 'allocations', label: 'Выделение ресурсов' },
  { id: 'workload', label: 'Нагрузка' },
  { id: 'directories', label: 'Справочники' },
]

export default function Planning({ onNavigateToZni }: PlanningProps) {
  const saved = loadPlanningUiState()
  const [panel, setPanel] = useState<PlanningPanelId>(saved.panel)
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(saved.selectedProjectId)

  const changePanel = (next: PlanningPanelId) => {
    setPanel(next)
    savePlanningUiState({ panel: next, selectedProjectId })
  }

  const changeProject = (projectId: number | null) => {
    setSelectedProjectId(projectId)
    savePlanningUiState({ panel, selectedProjectId: projectId })
    if (projectId != null) {
      setPanel('allocations')
      savePlanningUiState({ panel: 'allocations', selectedProjectId: projectId })
    }
  }

  return (
    <div className="org-page">
      <nav className="org-subtabs" aria-label="Разделы планирования">
        {PANELS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`org-subtab${panel === item.id ? ' org-subtab-active' : ''}`}
            onClick={() => changePanel(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {panel === 'projects' ? (
        <PlanningProjects
          selectedProjectId={selectedProjectId}
          onSelectProject={changeProject}
          onNavigateToZni={onNavigateToZni}
        />
      ) : panel === 'allocations' ? (
        <PlanningAllocations selectedProjectId={selectedProjectId} onSelectProject={changeProject} />
      ) : panel === 'directories' ? (
        <PlanningDirectories />
      ) : (
        <PlanningWorkload />
      )}
    </div>
  )
}
