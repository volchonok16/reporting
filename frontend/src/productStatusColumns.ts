export const PRESENTATION_COPY_COLUMN_LABELS: Record<string, string> = {
  'Полное Описание проекта и статус': 'Описание и статус · полное',
  'Для презентации Описание проекта и статус': 'Описание и статус · презентация',
}

export function formatProductStatusColumnHeader(column: string): string {
  return PRESENTATION_COPY_COLUMN_LABELS[column] ?? column
}
