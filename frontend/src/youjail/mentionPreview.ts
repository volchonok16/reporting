import type { MouseEvent } from 'react'

export function handleMentionPreviewClick(
  event: MouseEvent<HTMLElement>,
  onEmployeeClick: (employeeId: number) => void,
): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-employee-id]')
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  const employeeId = Number(target.dataset.employeeId)
  if (Number.isFinite(employeeId) && employeeId > 0) {
    onEmployeeClick(employeeId)
  }
}
