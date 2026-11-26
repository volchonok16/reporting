import { api, type Api } from '../../api/client';
export type OperationCommand =
  | { action: 'intake.database_status'; intakeId: string; caseId: string; body: Api['IntakeDatabaseStatusBody'] }
  | { action: 'intake.archive'; intakeId: string; caseId: string; body: Api['IntakeArchiveBody'] }
  | { action: 'intake.decisions'; intakeId: string; caseId: string; body: Api['IntakeDecisionBody'] }
  | { action: 'revision.save'; caseId: string; body: Api['SaveRevisionBody'] }
  | { action: 'processing.save_start'; caseId: string; body: Api['SaveRevisionBody'] }
  | { action: 'package.approve'; caseId: string; body: Api['ApproveBody'] }
  | { action: 'return.retry'; intakeId: string; caseId: string; body: Api['RetryBody'] };
export type Mutate = (command: OperationCommand) => Promise<boolean>;
export function sendOperation(csrf: string, command: OperationCommand) {
  switch (command.action) {
    case 'intake.database_status': return api.intakeDatabaseStatus(csrf, command.intakeId, command.body);
    case 'intake.archive': return api.intakeArchive(csrf, command.intakeId, command.body);
    case 'intake.decisions': return api.intakeDecisions(csrf, command.intakeId, command.body);
    case 'revision.save': return api.save(csrf, command.caseId, command.body, false);
    case 'processing.save_start': return api.save(csrf, command.caseId, command.body, true);
    case 'package.approve': return api.approve(csrf, command.caseId, command.body);
    case 'return.retry': return api.retryReturn(csrf, command.intakeId, command.body);
  }
}
export type DirectCommand = { kind: 'attempt'; body: Api['ExternalAttemptBody'] } | { kind: 'evidence'; attemptId: string; body: Api['EvidenceBody'] } | { kind: 'resolution'; body: Api['EvidenceResolutionBody'] };
export type DirectMutation = (command: DirectCommand) => Promise<boolean>;
export function sendDirect(csrf: string, command: DirectCommand) {
  if (command.kind === 'attempt') return api.submitAttempt(csrf, command.body);
  if (command.kind === 'evidence') return api.submitEvidence(csrf, command.attemptId, command.body);
  return api.resolveEvidence(csrf, command.body);
}
export const stateLabels: Record<string, string> = { APPLIED: 'Применено', REJECTED: 'Отказ', UNKNOWN: 'Результат неизвестен', PARTIAL: 'Частично, строки неизвестны', DELETED: 'Удалено', CONFLICT: 'Противоречие — нужна сверка', MISSING: 'Нет сведений', UNMATCHED: 'Строка не сопоставлена', AMBIGUOUS: 'Несколько совпадений', INVALID: 'Неоднозначные исходные данные', KNOWN: 'Точное покрытие' };
export const preparationLabels: Record<string, string> = { DRAFT: 'Черновик', QUEUED: 'Ожидает обработки', RUNNING: 'Обрабатывается', LEASED: 'Обрабатывается', PREPARED: 'Файлы подготовлены', APPROVED: 'Комплект подтверждён', BLOCKED: 'Нужен разбор', NEEDS_REVIEW: 'Нужен разбор', FAILED: 'Ошибка обработки', SUCCEEDED: 'Обработка завершена', CANCELLED: 'Отменено' };
export function date(value: string) { return `${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(value))} МСК`; }
export function values(value: Record<string, string>) { return Object.entries(value).map(([key, text]) => `${key}: ${text || '(пусто)'}`).join(' · '); }
export function attemptLabel(value: Api['ExternalAttemptState']) { return `${value.role} · ${value.filename} · версия ${value.revision_sequence} · ${date(value.created_at)} · ${value.reason}`; }
