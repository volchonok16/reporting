import { useState } from 'react'
import { loadOrgUiState, saveOrgUiState } from '../uiState'
import VacationSchedule from './VacationSchedule'
import WorkspaceBooking from './WorkspaceBooking'

type VacationsPanelProps = {
  orgEmployeeId: number | null
  canManage: boolean
}

export default function VacationsPanel({ orgEmployeeId, canManage }: VacationsPanelProps) {
  const currentYear = new Date().getFullYear()
  const savedOrgUi = loadOrgUiState()
  const [year, setYear] = useState(savedOrgUi.vacationYear)
  const [month, setMonth] = useState(new Date().getMonth())

  const handleYearChange = (nextYear: number) => {
    setYear(nextYear)
    saveOrgUiState({ vacationYear: nextYear })
  }

  return (
    <div className="org-schedule-page">
      <VacationSchedule
        orgEmployeeId={orgEmployeeId}
        canManage={canManage}
        year={year}
        onYearChange={handleYearChange}
      />
      <WorkspaceBooking
        orgEmployeeId={orgEmployeeId}
        year={year}
        month={month}
        onMonthChange={setMonth}
      />
    </div>
  )
}
