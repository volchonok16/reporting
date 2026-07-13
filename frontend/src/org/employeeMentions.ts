/** Публичная ссылка на сотрудника в API и упоминаниях (UUID). */
export function employeeApiRef(employee: { id: number; publicId?: string }): string {
  return employee.publicId ?? String(employee.id)
}

export function employeeApiRefFromId(
  employeesById: ReadonlyMap<number, { id: number; publicId?: string }>,
  employeeId: number,
): string {
  return employeeApiRef(employeesById.get(employeeId) ?? { id: employeeId })
}

/** Markdown-токен упоминания: @[ФИО](employee:uuid) */
export function buildEmployeeMentionToken(employee: {
  id: number
  publicId?: string
  fullName: string
}): string {
  return `@[${employee.fullName}](employee:${employeeApiRef(employee)})`
}

const EMPLOYEE_MENTION_RE = /@\[([^\]]+)\]\(employee:([\w-]+)\)/g

export const EMPLOYEE_MENTION_PATTERN = EMPLOYEE_MENTION_RE

export function stripEmployeeMentions(markdown: string): string {
  return markdown.replace(EMPLOYEE_MENTION_RE, '$1')
}

export function renderEmployeeMentionHtml(_match: string, name: string, employeeRef: string): string {
  const safeName = name
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const safeRef = employeeRef
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
  return `<button type="button" class="youjail-mention-chip" data-employee-ref="${safeRef}">${safeName}</button>`
}

export function replaceEmployeeMentionsInText(text: string): string {
  return text.replace(EMPLOYEE_MENTION_RE, renderEmployeeMentionHtml)
}
