// Approval (other editors, item 9; as in Filestage, Abstract): a frame or a
// section is «На согласовании», then «Утверждено» or «Нужны правки»; asked of
// one person; who approved which version. No record — a draft. Kept on the
// server next to the comments (files/<id>/approvals.json), not in the
// document: someone who may only comment (a client) can approve too. At an
// approval the server saves a version of the file, so what changed after it
// can be shown. Pure functions over the list; the API stores it and tells
// everyone in the file.

export type ApprovalStatus = 'REVIEW' | 'APPROVED' | 'CHANGES';

export interface ApprovalEvent {
  status: ApprovalStatus | 'WITHDRAWN';
  by: string;
  at: number;
  note?: string;
  /** The file version saved at the approval. */
  version?: string;
}

export interface Approval {
  /** The frame or section (a layer id: the same in every version of the file). */
  nodeId: string;
  pageId: string;
  /** The layer's name when asked: for letters and the history. */
  name: string;
  status: ApprovalStatus;
  /** Who asked. */
  by: string;
  /** Who was asked. */
  reviewer: string;
  at: number;
  /** A note to the request or to «Нужны правки». */
  note?: string;
  /** Approved: when and which version. */
  approvedAt?: number;
  version?: string;
  history: ApprovalEvent[];
}

export const APPROVALS_PER_FILE = 1000;
export const NOTE_LIMIT = 2000;
const HISTORY_LIMIT = 50;
const REF = /^[A-Za-z0-9:_.-]{1,100}$/;

export class ApprovalError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseApprovals(text: string | null): Approval[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? (list.filter((a) => a && typeof a === 'object' && typeof (a as Approval).nodeId === 'string') as Approval[]) : [];
  } catch {
    return [];
  }
}

const note = (v: unknown) => String(v ?? '').trim().slice(0, NOTE_LIMIT);

/** A request, first or again after changes: «На согласовании»; the history is kept. */
export function requestApproval(list: Approval[], input: { nodeId: unknown; pageId: unknown; name: unknown; reviewer: string; note?: unknown }, by: string, now: number): Approval[] {
  const nodeId = String(input.nodeId ?? '');
  const pageId = String(input.pageId ?? '');
  if (!REF.test(nodeId) || !REF.test(pageId)) throw new ApprovalError(400, 'Не указан фрейм', 'bad_node');
  if (input.reviewer === by) throw new ApprovalError(400, 'Утвердить свой фрейм нельзя — выберите другого человека', 'self');
  const name = String(input.name ?? '').trim().slice(0, 200) || 'Фрейм';
  const text = note(input.note);
  const old = list.find((a) => a.nodeId === nodeId);
  if (!old && list.length >= APPROVALS_PER_FILE) throw new ApprovalError(400, 'В файле слишком много фреймов на согласовании', 'too_many');
  const event: ApprovalEvent = { status: 'REVIEW', by, at: now, ...(text ? { note: text } : {}) };
  const next: Approval = {
    nodeId,
    pageId,
    name,
    status: 'REVIEW',
    by,
    reviewer: input.reviewer,
    at: now,
    ...(text ? { note: text } : {}),
    history: [...(old?.history ?? []), event].slice(-HISTORY_LIMIT),
  };
  return [...list.filter((a) => a.nodeId !== nodeId), next];
}

/** The answer of the person asked: approved (with the file version) or changes needed (with a note). */
export function decide(list: Approval[], nodeId: string, userId: string, verdict: unknown, input: { note?: unknown; version?: string }, now: number): Approval[] {
  const a = list.find((x) => x.nodeId === nodeId);
  if (!a) throw new ApprovalError(404, 'Согласование не запрошено', 'not_found');
  if (a.reviewer !== userId) throw new ApprovalError(403, 'Утвердить может только тот, кого попросили', 'forbidden');
  if (verdict !== 'approved' && verdict !== 'changes') throw new ApprovalError(400, 'Ожидалось «Утвердить» или «Нужны правки»', 'bad_verdict');
  const text = note(input.note);
  if (verdict === 'changes' && !text) throw new ApprovalError(400, 'Напишите, что поправить', 'no_note');
  const status: ApprovalStatus = verdict === 'approved' ? 'APPROVED' : 'CHANGES';
  const event: ApprovalEvent = { status, by: userId, at: now, ...(text ? { note: text } : {}), ...(input.version ? { version: input.version } : {}) };
  const { note: _n, approvedAt: _a, version: _v, ...rest } = a;
  const next: Approval = {
    ...rest,
    status,
    ...(text ? { note: text } : {}),
    ...(status === 'APPROVED' ? { approvedAt: now, ...(input.version ? { version: input.version } : {}) } : {}),
    history: [...a.history, event].slice(-HISTORY_LIMIT),
  };
  return list.map((x) => (x.nodeId === nodeId ? next : x));
}

/** Back to a draft: by whoever asked, or an editor of the file. */
export function withdraw(list: Approval[], nodeId: string): Approval[] {
  if (!list.some((a) => a.nodeId === nodeId)) throw new ApprovalError(404, 'Согласование не запрошено', 'not_found');
  return list.filter((a) => a.nodeId !== nodeId);
}

/** For the client: names instead of ids. */
export function publicApproval(a: Approval, names: Map<string, string>): Record<string, unknown> {
  const n = (id: string) => names.get(id) ?? '';
  return {
    nodeId: a.nodeId,
    pageId: a.pageId,
    name: a.name,
    status: a.status,
    by: { id: a.by, name: n(a.by) },
    reviewer: { id: a.reviewer, name: n(a.reviewer) },
    at: a.at,
    ...(a.note ? { note: a.note } : {}),
    ...(a.approvedAt ? { approvedAt: a.approvedAt } : {}),
    ...(a.version ? { version: a.version } : {}),
    history: a.history.map((e) => ({ status: e.status, by: n(e.by), at: e.at, ...(e.note ? { note: e.note } : {}), ...(e.version ? { version: e.version } : {}) })),
  };
}

/** Whose names are needed to show the records. */
export function peopleOf(list: Approval[]): Set<string> {
  const out = new Set<string>();
  for (const a of list) {
    out.add(a.by);
    out.add(a.reviewer);
    for (const e of a.history) out.add(e.by);
  }
  return out;
}
