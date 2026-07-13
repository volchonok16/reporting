export const YOUJAIL_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${Math.round(bytes / (1024 * 1024))} МБ`
}

export function validateYouJailAttachment(file: File): string | null {
  if (file.size > YOUJAIL_MAX_ATTACHMENT_BYTES) {
    return `Файл слишком большой (максимум ${formatFileSize(YOUJAIL_MAX_ATTACHMENT_BYTES)})`
  }
  return null
}
