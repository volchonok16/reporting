export const workflowSteps = ['Загрузка', 'Проверка', 'Подтверждение', 'Скачивание'] as const;
export type WorkflowStep = 1 | 2 | 3;

export function restoreWorkflowStep(saved: string | null, legacy: string | null, approved: boolean): WorkflowStep {
  const current = saved == null ? undefined : Number(saved);
  if (current === 1 || current === 2 || current === 3) return current;
  const previous = legacy == null ? undefined : Number(legacy);
  if (previous === 1 || previous === 2) return 1;
  if (previous === 3) return 2;
  if (previous === 4) return 3;
  return approved ? 3 : 1;
}
