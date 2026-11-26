import { object, string, type Api } from '../../api/client';
export type Intake = Api['IntakeDetail'];
export type Decisions = Api['IntakeDecisions'];
export const partners = ['RTK HUB', 'RTK ABC', 'RTK MVNO', 'ГПБМ'] as const;
export const operations = { WHITEMAV: 'Исключения из МАВ', ADD: 'Добавление', DELETE: 'Удаление', CHANGE: 'Изменение', STATUS: 'Разбор возврата', REPAIR: 'Исправление файла с ошибками из базы' } as const;
export const repairRoles = ['CLIENTS', 'DOGTAGS', 'NUMBERS'] as const;
export const repairFields = {
  CLIENTS: ['COMPANY_NAME', 'COMPANY_CONTRACT', 'MAV_OPERATOR_NAME', 'INN', 'STATUS'],
  DOGTAGS: ['INN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_ACTIVE', 'STATUS'],
  NUMBERS: ['INN', 'MAV_LABEL_NAME', 'MSISDN', 'IS_MAV', 'IS_KSS', 'SPREADING', 'INTERNAL_OPERATOR_NAME', 'MAV_OPERATOR_NAME', 'STATUS'],
} as const;
export function repairRole(value: unknown) { return repairRoles.find(role => role === value); }
export function artifactLabel(role: string) { return role === 'ERRORS' ? 'Строки с ошибками' : role === 'ERROR_OTHER_OPERATOR' ? 'ERROR OTHER OPERATOR' : role; }
export const reviewCountLabels: Record<string, string> = {
  CLIENTS: 'Клиенты для загрузки', DOGTAGS: 'Этикетки для загрузки', NUMBERS: 'Номера для загрузки', DELETE: 'Номера для удаления', ERRORS: 'Строки с ошибками',
  ERROR_OTHER_OPERATOR: 'Строки другого оператора',
  included: 'Включены в основной файл', exact_duplicate: 'Точные дубли', excluded_error: 'Требуют исправления', conflict: 'Конфликтующие строки', agreed_skip: 'Обработаны по STATUS', excluded_manual: 'Исключены вами',
};
export function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
export function mappingOf(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0));
}
export function label(item: Intake) {
  if (item.intake.state === 'RECONCILED') return 'Возврат сверён';
  if (item.job?.state === 'FAILED') return 'Ошибка обработки';
  if (item.job?.state === 'QUEUED' && item.job.error) return 'Ожидает ресурсов';
  if (item.revision?.state === 'APPROVED') return 'Комплект подтверждён';
  if (item.revision?.state === 'PREPARED') return 'Файлы подготовлены';
  if (item.assessment?.questions.length || ['BLOCKED', 'NEEDS_REVIEW'].includes(item.revision?.state ?? '')) return 'Требуется решение';
  return item.job?.state === 'QUEUED' ? 'В очереди' : 'Обрабатывается';
}
export function partnerOf(item: Intake) { return string(object(item.assessment?.result.partner).partner) ?? string(item.version.decisions.partner) ?? 'Не выбран'; }
export function workDate(item: Intake) {
  const date = new Date(item.intake.worked_at ?? item.intake.created_at);
  const options = { timeZone: 'Europe/Moscow' };
  return `${new Intl.DateTimeFormat('ru-RU', { ...options, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)} время ${new Intl.DateTimeFormat('ru-RU', { ...options, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)}`;
}
