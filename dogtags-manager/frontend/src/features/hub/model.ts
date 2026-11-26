import { ApiFailure, object, string, type Api, type Correction, type Revision } from '../../api/client';
import type { Status } from '../../design/status-semantics';

export type Remote<T> = { state: 'loading' | 'ready' | 'error'; data?: T; error?: string };
export const loading = <T,>(): Remote<T> => ({ state: 'loading' });
export const ready = <T,>(data: T): Remote<T> => ({ state: 'ready', data });
export function failure(error: unknown) {
  return error instanceof ApiFailure ? error : new ApiFailure(0, 'unexpected_response', 'Ответ сервиса не получен. Проверьте сохранённое состояние.');
}
export function errorText(error: unknown) {
  const e = failure(error);
  if (['save_location_unavailable', 'save_location_failed', 'file_save_failed'].includes(e.code)) return e.message;
  const kind: Record<number, string> = { 0: 'Сеть', 401: 'Требуется вход', 403: 'Нет разрешения', 404: 'Не найдено в доступной области', 409: 'Версия изменилась', 413: 'Файл превышает допустимый размер', 422: 'Данные не приняты', 503: 'Сервис недоступен' };
  return `${kind[e.status] ?? `HTTP ${e.status}`}: ${e.message} (${e.code})`;
}
export const statusFor = (state: string): Status => ({ DRAFT: 'draft', QUEUED: 'queued', PROCESSING: 'running', NEEDS_REVIEW: 'review', BLOCKED: 'blocked', PREPARED: 'prepared', APPROVED: 'approved', FAILED: 'blocked' } as Record<string, Status>)[state] ?? 'review';
export function profileValue(revision: Revision, field: Api['ProfileOverrideInput']['field']) {
  return string(object(object(revision.settings.profile_overrides)[field]).after) ?? string(revision.profile_snapshot[field]) ?? '';
}
export function time(value: string | undefined) {
  return value ? `${value} (UTC)` : 'Неизвестно';
}
export const hubFields = ['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS'] as const;
export const fieldLabels: Record<Correction['field'], string> = {
  INN: 'ИНН', MSISDN: 'Номер', MAV_LABEL_NAME: 'Этикетка на русском', MAV_LABEL_LATIN: 'Этикетка латиницей', IS_MAV: 'Флаг IS_MAV', IS_KSS: 'Флаг IS_KSS',
  COMPANY_NAME: 'Название компании', COMPANY_CONTRACT: 'Договор компании', MAV_OPERATOR_NAME: 'Оператор клиента', IS_ACTIVE: 'Флаг IS_ACTIVE', SPREADING: 'Флаг SPREADING', INTERNAL_OPERATOR_NAME: 'Внутреннее имя оператора', STATUS: 'STATUS',
};
export const dispositionLabels: Record<string, string> = {
  included: 'Включена', exact_duplicate: 'Точный дубль', excluded_error: 'Ошибка блокирует полный комплект', conflict: 'Конфликт', agreed_skip: 'Согласованный пропуск',
  excluded_scientific_inn: 'Строка исключена из CSV: ИНН записан экспонентой',
  excluded_manual: 'Исключена пользователем',
};
