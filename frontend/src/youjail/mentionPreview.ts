import type { MouseEvent } from 'react'
import { handleEmployeeMentionClick } from '../org/employeeMentionClick'

/** @deprecated Используйте handleEmployeeMentionClick и employeeRef (UUID). */
export function handleMentionPreviewClick(
  event: MouseEvent<HTMLElement>,
  onEmployeeClick: (employeeId: number) => void,
): void {
  handleEmployeeMentionClick(event, (employeeRef) => {
    const employeeId = Number(employeeRef)
    if (Number.isFinite(employeeId) && employeeId > 0) {
      onEmployeeClick(employeeId)
    }
  })
}

export { handleEmployeeMentionClick } from '../org/employeeMentionClick'
