import { saveBlob, sourceFilename } from './downloads';
import { dogtagsApiPath, reportingHeaders } from '../reporting';
import type { components } from './schema';

export type Api = components['schemas'];
export type Revision = Api['RevisionState'];
export type Correction = Api['CorrectionInput'];
export type Override = Api['ProfileOverrideInput'];

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
export function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
export function boolean(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) {
    super(message);
  }
}

export const REQUEST_TIMEOUT_MS = 30_000;
export const TRANSFER_TIMEOUT_MS = 300_000;

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: { id: string; suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
};
export function canChooseDownloadLocation() {
  return window.isSecureContext && typeof (window as SavePickerWindow).showSaveFilePicker === 'function';
}

async function responseWithin<T>(path: string, init: RequestInit | undefined, timeoutMs: number,
  consume: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(dogtagsApiPath(path), { credentials: 'same-origin', cache: 'no-store', ...init, headers: reportingHeaders(init?.headers), signal: controller.signal });
    await ensure(response);
    return await consume(response);
  } catch (error) {
    if (controller.signal.aborted) throw new ApiFailure(0, 'request_timeout', 'Время ожидания ответа истекло. Исход операции неизвестен. Проверьте сохранённое состояние.');
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure(0, 'network_unknown', 'Ответ сервиса не получен. Исход операции неизвестен.');
  } finally { clearTimeout(timer); }
}

async function ensure(response: Response) {
  if (response.ok) return;
  let data: unknown;
  try { data = await response.json(); } catch { data = undefined; }
  const error = object(object(data).error);
  throw new ApiFailure(response.status, string(error.code) ?? 'service_response',
    string(error.message) ?? string(object(data).detail) ?? `Сервис вернул HTTP ${response.status}.`, boolean(error.retryable) ?? false);
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  return responseWithin(path, init, timeoutMs, async response => {
    try { return await response.json() as T; }
    catch { throw new ApiFailure(0, 'response_unknown', 'Ответ сервиса повреждён. Проверьте сохранённое состояние операции.'); }
  });
}

function query(values: Record<string, string | number | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value != null) params.set(key, String(value));
  return params.size ? `?${params}` : '';
}
function pageQuery(values: Record<string, string | number | null | undefined> = {}) { return query({ ...values, limit: 500 }); }
export function revisionPath(caseId: string, revisionId: string) {
  return `/api/cases/${caseId}/revisions/${revisionId}`;
}
function post<T>(path: string, csrf: string, body: unknown) {
  return request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
}

// A single challenge request survives StrictMode's effect replay, avoiding a
// second Set-Cookie response racing with the CSRF token from the first response.
let sessionRequest: Promise<Api['SessionState']> | undefined;
export function readSession() {
  if (!sessionRequest) {
    sessionRequest = request<Api['SessionState']>('/api/session').finally(() => { sessionRequest = undefined; });
  }
  return sessionRequest;
}

export const api = {
  downloadSource: async (caseId: string, sourceId: string, filename = 'source.csv') => {
    const result = await responseWithin(`/api/cases/${caseId}/sources/${sourceId}/raw`, undefined, TRANSFER_TIMEOUT_MS, async response => ({
      blob: await response.blob(), filename: sourceFilename(response.headers.get('Content-Disposition'), filename),
    }));
    saveBlob(result.blob, result.filename);
  },
  processingSettings: () => request<Api['ProcessingSettingsState']>('/api/processing-settings'),
  writeMnemonic: (csrf: string, body: Api['MnemonicWriteBody']) => post<Api['ProcessingSettingsState']>('/api/dictionary/mnemonics', csrf, body),
  writePartnerSettings: (csrf: string, body: Api['PartnerSettingsBody']) => post<Api['ProcessingSettingsState']>('/api/processing-settings/partners', csrf, body),
  attemptCandidates: (after?: string | null) => request<Api['ExternalAttemptPage']>(`/api/external-attempts${pageQuery({ after })}`),
  attempts: (artifact: string, after?: string | null) => request<Api['ExternalAttemptPage']>(`/api/artifacts/${artifact}/external-attempts${pageQuery({ after })}`),
  attempt: (id: string) => request<Api['ExternalAttemptState']>(`/api/external-attempts/${id}`),
  submitAttempt: (csrf: string, body: Api['ExternalAttemptBody']) => post<Api['ExternalAttemptState']>('/api/external-attempts', csrf, body),
  externalEvidence: (id: string, after?: string | null) => request<Api['EvidencePage']>(`/api/external-attempts/${id}/evidence${pageQuery({ after })}`),
  submitEvidence: (csrf: string, id: string, body: Api['EvidenceBody']) => post<Api['EvidenceState']>(`/api/external-attempts/${id}/evidence`, csrf, body),
  exportRows: (id: string, after = 0) => request<Api['ExportRowPage']>(`/api/artifacts/${id}/export-rows${pageQuery({ after })}`),
  registry: (kind?: Api['RegistryEntryState']['kind'] | '', state?: Api['RegistryEntryState']['external_state'] | '', after?: string | null) => request<Api['RegistryPage']>(`/api/registry${pageQuery({ kind: kind || undefined, state: state || undefined, after })}`),
  registrySources: (id: string, after?: string | null) => request<Api['RegistrySourcePage']>(`/api/registry/${id}/sources${pageQuery({ after })}`),
  registryEvidence: (id: string, after?: string | null) => request<Api['EvidencePage']>(`/api/registry/${id}/evidence${pageQuery({ after })}`),
  backfill: (csrf: string, artifact_id?: string) => post<Api['RegistryBatchState']>('/api/registry/backfill', csrf, { batch_size: 1000, artifact_id }),
  resolveEvidence: (csrf: string, body: Api['EvidenceResolutionBody']) => post<Api['EvidenceResolutionState']>('/api/registry/resolutions', csrf, body),
  changeSources: (after?: string | null) => request<Api['ChangeSourcePage']>(`/api/change-sources${pageQuery({ after })}`),
  change: (c: string, r: string) => request<Api['ChangeState']>(`${revisionPath(c, r)}/change`),
  returnDetail: (id: string, assessment_id?: string) => request<Api['ReturnDetailWithRetryTarget']>(`/api/returns/${id}${query({ assessment_id })}`),
  returnRows: (id: string, assessment_id: string, after = 0) => request<Api['ReturnRowPage']>(`/api/returns/${id}/rows${pageQuery({ assessment_id, after })}`),
  returnHistory: (id: string, after?: string | null) => request<Api['ReturnHistoryPage']>(`/api/returns/${id}/assessments${pageQuery({ after })}`),
  retryHistory: (id: string, after?: string | null) => request<Api['RetryHistoryPage']>(`/api/returns/${id}/retries${pageQuery({ after })}`),
  retryDetail: (id: string, revision: string, after = 0) => request<Api['RetryDetail']>(`/api/returns/${id}/retries/${revision}${pageQuery({ after })}`),
  retryReturn: (csrf: string, id: string, body: Api['RetryBody']) => post<Api['OperationState']>(`/api/returns/${id}/retries`, csrf, body),
  intakes: (after?: string | null, deleted = false) => request<Api['IntakePage']>(`/api/intakes${pageQuery({ after, deleted: deleted ? 'true' : undefined })}`),
  intakeDatabaseStatus: (csrf: string, intake: string, body: Api['IntakeDatabaseStatusBody']) => post<Api['IntakeOperationState']>(`/api/intakes/${intake}/database-status`, csrf, body),
  intakeArchive: (csrf: string, intake: string, body: Api['IntakeArchiveBody']) => post<Api['IntakeOperationState']>(`/api/intakes/${intake}/archive`, csrf, body),
  intake: (id: string) => request<Api['IntakeDetail']>(`/api/intakes/${id}`),
  intakeRecords: (id: string, after = 0) => request<Api['IntakeRawPage']>(`/api/intakes/${id}/records${pageQuery({ after })}`),
  whitemavInns: () => request<Api['WhitemavInnList']>('/api/whitemav/inns'),
  addWhitemavInn: (csrf: string, inn: string, company_name: string) => post<Api['WhitemavInnList']>('/api/whitemav/inns', csrf, { inn, company_name }),
  nameWhitemavInn: (csrf: string, inn: string, company_name: string) => request<Api['WhitemavInnList']>(`/api/whitemav/inns/${encodeURIComponent(inn)}`, { method: 'PUT', headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ company_name }) }),
  deleteWhitemavInn: (csrf: string, inn: string) => request<Api['WhitemavInnList']>(`/api/whitemav/inns/${encodeURIComponent(inn)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } }),
  intakeUpload: (csrf: string, id: string, file: File, partner?: Api['IntakeDecisions']['partner'], operation?: Api['IntakeDecisions']['operation'], whitemavInn?: string) => {
    const body = new FormData(); body.append('file', file);
    return request<Api['IntakeOperationState']>(`/api/intakes${query({ partner, operation, whitemav_inn: whitemavInn })}`, { method: 'POST', headers: { 'X-CSRF-Token': csrf, 'X-Operation-ID': id }, body }, TRANSFER_TIMEOUT_MS);
  },
  intakeDecisions: (csrf: string, intake: string, body: Api['IntakeDecisionBody']) => post<Api['IntakeOperationState']>(`/api/intakes/${intake}/decisions`, csrf, body),
  login: (csrf: string, username: string, password: string) => post<Api['SessionState']>('/api/session/login', csrf, { username, password }),
  logout: (csrf: string) => post<Api['LogoutState']>('/api/session/logout', csrf, {}),
  cases: (after?: string | null) => request<Api['CasePage']>(`/api/cases${pageQuery({ after })}`),
  case: (id: string) => request<Api['CaseState']>(`/api/cases/${id}`),
  revision: (caseId: string, id: string) => request<Revision>(revisionPath(caseId, id)),
  create: (csrf: string, operationId: string) => post<Api['OperationState']>('/api/cases', csrf, { operation_id: operationId, title: 'HUB' }),
  upload: (csrf: string, caseId: string, operationId: string, file: File, encoding: 'utf-8' | 'cp1251', expected: string | null) => {
    const body = new FormData(); body.append('file', file);
    return request<Api['OperationState']>(`/api/cases/${caseId}/sources${query({ encoding, expected_revision_id: expected })}`,
      { method: 'POST', headers: { 'X-CSRF-Token': csrf, 'X-Operation-ID': operationId }, body }, TRANSFER_TIMEOUT_MS);
  },
  save: (csrf: string, caseId: string, body: Api['SaveRevisionBody'], start: boolean) => post<Api['OperationState']>(
    `/api/cases/${caseId}/${start ? 'processing/save-and-start' : 'revisions'}`, csrf, body),
  start: (csrf: string, caseId: string, body: Api['StartProcessingBody'], retry = false) => post<Api['OperationState']>(
    `/api/cases/${caseId}/processing/${retry ? 'retry' : 'start'}`, csrf, body),
  job: (caseId: string, id: string) => request<Api['ProcessingState']>(`/api/cases/${caseId}/processing/${id}`),
  operation: (operationId: string, action: string, caseId: string | null) => request<Api['OperationState']>(
    `/api/operations${query({ operation_id: operationId, action, case_id: caseId })}`),
  review: (c: string, r: string) => request<Api['ReviewState']>(`${revisionPath(c, r)}/review`),
  records: (c: string, r: string, after = 0, sort: 'source' | 'errors_first' = 'source') => request<Api['RecordPage']>(`${revisionPath(c, r)}/records${pageQuery({ after, sort })}`),
  record: (c: string, r: string, id: string, ordinal: number) => request<Api['RecordDetail']>(`${revisionPath(c, r)}/records/${id}${query({ ordinal })}`),
  issues: (c: string, r: string, after = 0) => request<Api['IssuePage']>(`${revisionPath(c, r)}/issues${pageQuery({ after })}`),
  artifacts: (c: string, r: string) => request<Api['ArtifactSetState']>(`${revisionPath(c, r)}/artifacts`),
  preview: (c: string, r: string, id: string, after = 0) => request<Api['ArtifactPreview']>(`${revisionPath(c, r)}/artifacts/${id}/preview${pageQuery({ after })}`),
  approval: (c: string, r: string) => request<Api['RevisionApprovalState']>(`${revisionPath(c, r)}/approval`),
  approve: (csrf: string, c: string, body: Api['ApproveBody']) => post<Api['OperationState']>(`/api/cases/${c}/approval`, csrf, body),
  evidence: (c: string, r: string, id: string) => request<Api['DownloadEvidenceState']>(`${revisionPath(c, r)}/artifacts/${id}/download-evidence`),
  download: async (c: string, r: string, artifact: Api['ArtifactState'], manifestHash: string, chooseLocation = false) => {
    let file: FileSystemFileHandle | undefined;
    if (chooseLocation) {
      if (!canChooseDownloadLocation()) throw new ApiFailure(0, 'save_location_unavailable', 'Для выбора папки включите в настройках браузера запрос места сохранения каждого файла.');
      try {
        // Open before any network await, while the click still grants user activation.
        file = await (window as SavePickerWindow).showSaveFilePicker!({
          id: 'dogtags-results', suggestedName: artifact.download_filename,
          types: artifact.role === 'ZIP'
            ? [{ description: 'ZIP-архив', accept: { 'application/zip': ['.zip'] } }]
            : [{ description: 'CSV-файл', accept: { 'text/csv': ['.csv'] } }],
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return { status: 'cancelled' as const, filename: artifact.download_filename };
        throw new ApiFailure(0, 'save_location_failed', 'Не удалось открыть выбор места сохранения. Попробуйте ещё раз или используйте обычное скачивание.');
      }
    }
    const blob = await responseWithin(`${revisionPath(c, r)}/artifacts/${artifact.id}/download${query({ expected_revision_id: r, manifest_hash: manifestHash })}`,
      undefined, TRANSFER_TIMEOUT_MS, response => response.blob());
    if (blob.size !== artifact.size_bytes) throw new ApiFailure(0, 'download_incomplete', 'Получен неполный файл. Сохранение не подтверждено.');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (hash !== artifact.sha256) throw new ApiFailure(0, 'download_hash_mismatch', 'Хеш полученного файла не совпадает с показанным комплектом.');
    if (file) {
      let writable: FileSystemWritableFileStream | undefined;
      try {
        writable = await file.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch {
        await writable?.abort().catch(() => {});
        throw new ApiFailure(0, 'file_save_failed', 'Не удалось сохранить файл в выбранном месте. Проверьте доступ к папке и свободное место.');
      }
      return { status: 'saved' as const, filename: file.name };
    }
    saveBlob(blob, artifact.download_filename);
    return { status: 'downloaded' as const, filename: artifact.download_filename };
  },
};
