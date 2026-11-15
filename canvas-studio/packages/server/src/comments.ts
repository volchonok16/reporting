// Comments (stage 8, part 4): discussions pinned to a point on the canvas.
// A thread sits on a page — at a point of the page, or on a layer (the point
// is then relative to the layer, so the pin moves with it) — and holds the
// first comment and the replies. Anyone who can open the file reads them;
// writing needs the commenter role; a comment is edited by its author and
// deleted by its author or the file owner; "Resolved" is set by any commenter.
// Pure functions over the stored list: the API keeps them in
// files/<id>/comments.json and tells everyone in the file about each change.

export interface CommentEntry {
  id: string;
  authorId: string;
  text: string;
  createdAt: number;
  editedAt?: number;
  /** People called with @ in the text (their ids; only people with access to the file). */
  mentions?: string[];
}

export interface Thread {
  id: string;
  pageId: string;
  /** Layer the pin is attached to; none — a point of the page. */
  nodeId: string | null;
  /** World point of the page, or offset from the layer's top-left corner. */
  x: number;
  y: number;
  createdAt: number;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: number;
  comments: CommentEntry[];
}

export const COMMENT_LIMIT = 5000;
export const THREADS_PER_FILE = 2000;
export const COMMENTS_PER_THREAD = 500;
export const MENTIONS_PER_COMMENT = 20;
const REF = /^[A-Za-z0-9:_.-]{1,100}$/;

export class CommentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function parseThreads(text: string | null): Thread[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? (list as Thread[]) : [];
  } catch {
    return [];
  }
}

/** Trims a comment, keeps line breaks, drops other control characters. */
export function cleanText(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim();
  if (!text) throw new CommentError(400, 'Напишите комментарий', 'empty');
  if (text.length > COMMENT_LIMIT) throw new CommentError(400, `Комментарий длиннее ${COMMENT_LIMIT} символов`, 'too_long');
  return text;
}

/**
 * The people a comment calls with @: ids sent by the editor, kept only if
 * they have access to the file (`people`) and their name is in the text
 * (`@Имя`), without repeats.
 */
export function cleanMentions(value: unknown, text: string, people: Map<string, string>): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || out.includes(id)) continue;
    const name = people.get(id);
    if (name && text.includes(`@${name}`)) out.push(id);
    if (out.length >= MENTIONS_PER_COMMENT) break;
  }
  return out;
}

/** Comment preference of an account: every letter, only when called with @, or none. */
export type CommentMail = 'all' | 'mentions' | 'none';

export function commentMailPref(value: string | undefined): CommentMail {
  return value === 'mentions' || value === 'none' ? value : 'all';
}

/**
 * Who is told by letter about a new comment `entry` in `thread` (already in
 * it): people called with @ (`mention: true`), everyone who wrote in the
 * discussion before, and for a new discussion the file owner. Never the
 * author. Access and preferences are checked by the caller.
 */
export function mailRecipients(thread: Thread, entry: CommentEntry, ownerId: string): { userId: string; mention: boolean }[] {
  const out = new Map<string, boolean>();
  for (const id of entry.mentions ?? []) out.set(id, true);
  const earlier = thread.comments.filter((c) => c.id !== entry.id);
  for (const c of earlier) if (!out.has(c.authorId)) out.set(c.authorId, false);
  if (earlier.length === 0 && !out.has(ownerId)) out.set(ownerId, false);
  out.delete(entry.authorId);
  return [...out].map(([userId, mention]) => ({ userId, mention }));
}

/** Where a new thread is pinned, checked. */
export function cleanPlace(body: { pageId?: unknown; nodeId?: unknown; x?: unknown; y?: unknown }): Pick<Thread, 'pageId' | 'nodeId' | 'x' | 'y'> {
  if (typeof body.pageId !== 'string' || !REF.test(body.pageId)) throw new CommentError(400, 'Не указана страница', 'bad_place');
  const nodeId = body.nodeId === null || body.nodeId === undefined ? null : typeof body.nodeId === 'string' && REF.test(body.nodeId) ? body.nodeId : undefined;
  if (nodeId === undefined) throw new CommentError(400, 'Неверный слой', 'bad_place');
  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) throw new CommentError(400, 'Неверная точка', 'bad_place');
  return { pageId: body.pageId, nodeId, x, y };
}

function find(threads: Thread[], threadId: string): Thread {
  const t = threads.find((x) => x.id === threadId);
  if (!t) throw new CommentError(404, 'Обсуждение не найдено', 'not_found');
  return t;
}

export function addThread(threads: Thread[], thread: Thread): Thread[] {
  if (threads.length >= THREADS_PER_FILE) throw new CommentError(400, 'В файле слишком много обсуждений', 'too_many');
  return [...threads, thread];
}

export function addReply(threads: Thread[], threadId: string, entry: CommentEntry): Thread[] {
  const t = find(threads, threadId);
  if (t.comments.length >= COMMENTS_PER_THREAD) throw new CommentError(400, 'В обсуждении слишком много ответов', 'too_many');
  // A reply reopens a resolved discussion, as in Figma.
  return threads.map((x) => (x.id === threadId ? { ...x, resolved: false, resolvedBy: undefined, resolvedAt: undefined, comments: [...x.comments, entry] } : x));
}

export function setResolved(threads: Thread[], threadId: string, resolved: boolean, userId: string, now: number): Thread[] {
  find(threads, threadId);
  return threads.map((x) => (x.id === threadId ? (resolved ? { ...x, resolved, resolvedBy: userId, resolvedAt: now } : { ...x, resolved, resolvedBy: undefined, resolvedAt: undefined }) : x));
}

/** Moves a pin (its author or an editor; the API checks who). */
export function movePin(threads: Thread[], threadId: string, place: Pick<Thread, 'pageId' | 'nodeId' | 'x' | 'y'>): Thread[] {
  find(threads, threadId);
  return threads.map((x) => (x.id === threadId ? { ...x, ...place } : x));
}

export function editComment(threads: Thread[], threadId: string, commentId: string, userId: string, text: string, now: number, mentions?: string[]): Thread[] {
  const t = find(threads, threadId);
  const c = t.comments.find((x) => x.id === commentId);
  if (!c) throw new CommentError(404, 'Комментарий не найден', 'not_found');
  if (c.authorId !== userId) throw new CommentError(403, 'Изменить комментарий может только его автор', 'forbidden');
  return threads.map((x) => (x.id === threadId ? { ...x, comments: x.comments.map((y) => (y.id === commentId ? { ...y, text, editedAt: now, mentions: mentions?.length ? mentions : undefined } : y)) } : x));
}

/**
 * Deletes a comment (its author or the file owner). Deleting the first one
 * deletes the whole discussion. Returns the list and whether the thread is gone.
 */
export function deleteComment(threads: Thread[], threadId: string, commentId: string, userId: string, isOwner: boolean): { threads: Thread[]; threadGone: boolean } {
  const t = find(threads, threadId);
  const index = t.comments.findIndex((x) => x.id === commentId);
  if (index < 0) throw new CommentError(404, 'Комментарий не найден', 'not_found');
  if (t.comments[index]!.authorId !== userId && !isOwner) throw new CommentError(403, 'Удалить комментарий может его автор или владелец файла', 'forbidden');
  if (index === 0) return { threads: threads.filter((x) => x.id !== threadId), threadGone: true };
  return { threads: threads.map((x) => (x.id === threadId ? { ...x, comments: x.comments.filter((y) => y.id !== commentId) } : x)), threadGone: false };
}

/** A thread as it is sent to people: authors with names, no ids beyond what the editor needs. */
export function publicThread(t: Thread, names: Map<string, string>): Record<string, unknown> {
  return {
    id: t.id,
    pageId: t.pageId,
    nodeId: t.nodeId,
    x: t.x,
    y: t.y,
    createdAt: t.createdAt,
    resolved: t.resolved,
    ...(t.resolved ? { resolvedBy: names.get(t.resolvedBy ?? '') ?? '', resolvedAt: t.resolvedAt } : {}),
    comments: t.comments.map((c) => ({ id: c.id, authorId: c.authorId, author: names.get(c.authorId) ?? '', text: c.text, createdAt: c.createdAt, ...(c.editedAt ? { editedAt: c.editedAt } : {}), ...(c.mentions?.length ? { mentions: c.mentions.map((id) => ({ id, name: names.get(id) ?? '' })) } : {}) })),
  };
}
