import type { Intake } from './model';

const stages: Record<string, string> = {
  queued: 'Ожидаем начала проверки', claim: 'Начинаем проверку', verify: 'Проверяем исходный файл',
  discovery: 'Читаем таблицу и определяем столбцы', validation: 'Проверяем данные и дубликаты',
  retry_selection: 'Проверяем строки для повторной обработки', retry_dependencies: 'Сверяем связанные данные',
  reconciliation: 'Сверяем результаты', serialization: 'Формируем выходные файлы',
  publication: 'Сохраняем результаты проверки', finalization: 'Завершаем проверку',
  recovery: 'Возобновляем проверку', capacity_wait: 'Ожидаем свободных ресурсов', failed: 'Ожидаем повторной проверки',
};
export function isProcessing(item: Intake) {
  return item.job ? ['QUEUED', 'PROCESSING'].includes(item.job.state) : ['DISCOVERING', 'PROCESSING'].includes(item.intake.state);
}
export function processingProgress(item: Intake) {
  const job = item.job;
  const value = job?.progress.percent;
  const percent = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(99, value)) : 0;
  // DISCOVER and BUILD are separate server tasks in one user-visible check.
  // These are completed-stage milestones, not a timer or a prediction of remaining time.
  const overall = job?.kind === 'BUILD' ? 40 + percent * 0.6 : percent * 0.4;
  const stage = typeof job?.progress.stage === 'string' ? job.progress.stage : 'queued';
  return { percent: Math.floor(overall), stage: stages[stage] ?? 'Проверяем файл' };
}
