import type { MouseEvent } from 'react'

export function handleEmployeeMentionClick(
  event: MouseEvent<HTMLElement>,
  onEmployeeRef: (employeeRef: string) => void,
): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-employee-ref]')
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  const employeeRef = target.dataset.employeeRef?.trim()
  if (employeeRef) {
    onEmployeeRef(employeeRef)
  }
}
