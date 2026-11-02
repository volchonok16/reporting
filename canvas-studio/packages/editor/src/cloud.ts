// Talking to the Simmetrika server (stage "Server", part 1): accounts and
// files. Every state-changing request carries `X-CS: 1` (the server refuses
// cross-site requests without it). When the app is opened without a server —
// the static dev server or a plain file host — `probe` reports it and the app
// keeps working with files in the browser, as before.

import { brand, locale, tr } from '#core';
import type { FileMeta, ProjectMeta, Role, StoredFile } from './storage.ts';
import { localProjects, storage } from './storage.ts';
import { adoptAccountPrefs, forgetAccountPrefs } from './prefs.ts';
import { offline, rememberedUser, rememberUser } from './offline.ts';
import type { LibraryPayload } from './library.ts';

export interface CloudUser {
  id: string;
  email: string;
  name: string;
}

export class CloudError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * How long a reading request waits for the server to start answering, then for its one retry
 * (BUG-130). A stuck connection (a VPN dropping it, a sleeping network) used to hang the start
 * on its skeleton for good, until the page was reloaded; now a fresh connection is tried, then
 * the editor goes on without the server. Only until the answer starts: a large file still loads.
 */
export const ANSWER_WAIT = [8000, 15000];

async function fetchAnswered(path: string, init: RequestInit, wait: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), wait);
  try {
    return await fetch(path, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response | null = null;
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { 'X-CS': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  // Reading is safe to ask again; a change is not (it might be made twice), so it waits as long as it takes.
  const waits = method === 'GET' ? ANSWER_WAIT : [0];
  for (const wait of waits) {
    try {
      res = wait ? await fetchAnswered(path, init, wait) : await fetch(path, init);
      break;
    } catch {
      // No answer in time, or no network: the next try on a fresh connection, or offline.
    }
  }
  if (!res) throw new CloudError(0, 'offline', tr('Нет связи с сервером'));
  const text = await res.text();
  // A file as two lines (PERF-004): its record, then its document as it is — not a string inside JSON.
  if (res.ok && (res.headers.get('Content-Type') ?? '').startsWith('application/x-ndjson')) {
    const cut = text.indexOf('\n');
    const head = JSON.parse(cut < 0 ? text : text.slice(0, cut)) as Record<string, unknown>;
    return { ...head, snapshot: cut < 0 ? null : text.slice(cut + 1) } as T;
  }
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // not JSON: a static host answered, not our API
    if (!res.ok) throw new CloudError(res.status, 'no_api', tr('Сервер не отвечает как {0}', brand()));
  }
  if (!res.ok) throw new CloudError(res.status, String(data.error ?? 'error'), data.message !== undefined ? tr(String(data.message)) : tr('Ошибка {0}', res.status));
  return data as T;
}

/** Just signed in: the account's settings apply here too (another language reloads the page). */
async function withAccountPrefs(user: CloudUser): Promise<CloudUser> {
  try {
    const me = await request<{ prefs?: Record<string, string> }>('GET', '/api/me');
    if (adoptAccountPrefs(me.prefs)) {
      location.reload();
      await new Promise(() => undefined);
    }
  } catch {
    // settings stay as they are in this browser
  }
  return user;
}

// ---------- versions ----------

export interface VersionInfo {
  id: string;
  at: number;
  /** Saved on purpose; null — automatic. */
  name: string | null;
  description: string | null;
  by: string | null;
  authors: string[];
}

const versionsPath = (id: string, rest = '') => `/api/files/${encodeURIComponent(id)}/versions${rest}`;

export const versions = {
  list: async (id: string) => (await request<{ versions: VersionInfo[] }>('GET', versionsPath(id), undefined, linkHeaders(id))).versions,
  snapshot: async (id: string, version: string) => (await request<{ snapshot: string }>('GET', versionsPath(id, `/${encodeURIComponent(version)}`), undefined, linkHeaders(id))).snapshot,
  save: (id: string, name: string, description?: string) => request<{ version: { id: string } | null }>('POST', versionsPath(id), { name, ...(description ? { description } : {}) }, linkHeaders(id)),
  rename: (id: string, version: string, name: string) => request<{ version: unknown }>('PATCH', versionsPath(id, `/${encodeURIComponent(version)}`), { name }, linkHeaders(id)),
};

// ---------- branches (FR-BR-001, 002, 005) ----------

/** What a branch is: of which file, by whom, and — once merged — the main file's versions around the merge. */
export interface BranchMeta {
  of: string;
  mainName: string;
  description: string;
  author: string;
  merged?: { at: number; before: string; after: string };
  review?: BranchReview;
}

/** A review request (FR-BR-003): who asked, what to look at, each reviewer's answer. */
export interface BranchReview {
  by: string;
  byName: string;
  at: number;
  description: string;
  reviewers: { id: string; name: string; verdict?: 'approved' | 'changes'; at?: number; note?: string }[];
}

export interface BranchInfo extends BranchMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

const filePath = (id: string, rest = '') => `/api/files/${encodeURIComponent(id)}${rest}`;

export const branches = {
  list: async (mainId: string) => (await request<{ branches: BranchInfo[] }>('GET', filePath(mainId, '/branches'))).branches,
  create: async (mainId: string, name: string, description: string) => (await request<{ branch: { id: string; name: string } }>('POST', filePath(mainId, '/branches'), { name, description })).branch,
  /** In a branch: the common ancestor (a snapshot) and the main file with this person's role there. */
  info: (branchId: string) => request<{ branch: BranchMeta; main: { id: string; name: string; role: Role }; base: string }>('GET', filePath(branchId, '/branch')),
  /** The branch took the main file's changes: that state is the new common ancestor. */
  setBase: (branchId: string, snapshot: string) => request<{ ok: true }>('PUT', filePath(branchId, '/branch/base'), { snapshot }),
  /** A file as it is this moment (what its live room holds is written first). */
  fresh: async (id: string) => (await request<{ snapshot: string }>('GET', filePath(id, '/fresh'))).snapshot,
  merged: (mainId: string, branchId: string, before: string, after: string) => request<{ ok: true }>('POST', filePath(mainId, `/branches/${encodeURIComponent(branchId)}/merged`), { before, after }),
  unmerged: (mainId: string, branchId: string) => request<{ ok: true }>('POST', filePath(mainId, `/branches/${encodeURIComponent(branchId)}/unmerged`), {}),
  remove: (branchId: string) => request<{ ok: true }>('DELETE', filePath(branchId)),
  requestReview: async (branchId: string, reviewers: string[], description: string) => request<{ review: BranchReview; mailFailed?: boolean }>('POST', filePath(branchId, '/review'), { reviewers, description }),
  cancelReview: (branchId: string) => request<{ ok: true }>('DELETE', filePath(branchId, '/review')),
  verdict: async (branchId: string, verdict: 'approved' | 'changes', note: string) => (await request<{ review: BranchReview }>('POST', filePath(branchId, '/review/verdict'), { verdict, note })).review,
  /** At a merge: the branch's discussions are copied into the main file. */
  carryComments: async (mainId: string, branchId: string) => (await request<{ carried: number }>('POST', filePath(mainId, `/branches/${encodeURIComponent(branchId)}/comments`), {})).carried,
};

// ---------- libraries ----------

/** A published library the person can use: their own file or one shared with them. */
export interface LibraryInfo {
  fileId: string;
  name: string;
  publishedAt: number;
  components: number;
  own: boolean;
  ownerName?: string;
}

const libraryPath = (id: string) => `/api/files/${encodeURIComponent(id)}/library`;

export const libraries = {
  list: async () => (await request<{ libraries: LibraryInfo[] }>('GET', '/api/libraries')).libraries,
  get: async (id: string) => (await request<{ library: LibraryPayload }>('GET', libraryPath(id), undefined, linkHeaders(id))).library,
  publish: (id: string, payload: LibraryPayload) => request<{ library: { publishedAt: number; components: number } | null }>('PUT', libraryPath(id), payload, linkHeaders(id)),
  unpublish: (id: string) => request<{ ok: true }>('DELETE', libraryPath(id), undefined, linkHeaders(id)),
};

// ---------- comments ----------

export interface CommentItem {
  id: string;
  authorId: string;
  author: string;
  text: string;
  createdAt: number;
  editedAt?: number;
  /** People called with @ (shown highlighted in the text). */
  mentions?: { id: string; name: string }[];
}

/** Someone with the file whom @ can call. */
export interface Person {
  id: string;
  name: string;
}

/** A discussion pinned to the canvas: a point of a page, or a point of a layer (offset from its corner). */
export interface CommentThread {
  id: string;
  pageId: string;
  nodeId: string | null;
  x: number;
  y: number;
  createdAt: number;
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: number;
  comments: CommentItem[];
}

/** What the server answers to every change (and sends to everyone in the file). */
export type ThreadChange = { type: 'thread'; thread: CommentThread } | { type: 'thread'; id: string; deleted: true };

export type CommentPlace = { pageId: string; nodeId: string | null; x: number; y: number };

const threadsPath = (id: string, rest = '') => `/api/files/${encodeURIComponent(id)}/comments${rest}`;

export const comments = {
  list: async (id: string) => (await request<{ threads: CommentThread[] }>('GET', threadsPath(id), undefined, linkHeaders(id))).threads,
  create: (id: string, place: CommentPlace, text: string, mentions: string[] = []) => request<ThreadChange>('POST', threadsPath(id), { ...place, text, mentions }, linkHeaders(id)),
  reply: (id: string, thread: string, text: string, mentions: string[] = []) => request<ThreadChange>('POST', threadsPath(id, `/${encodeURIComponent(thread)}/replies`), { text, mentions }, linkHeaders(id)),
  resolve: (id: string, thread: string, resolved: boolean) => request<ThreadChange>('PATCH', threadsPath(id, `/${encodeURIComponent(thread)}`), { resolved }, linkHeaders(id)),
  move: (id: string, thread: string, place: CommentPlace) => request<ThreadChange>('PATCH', threadsPath(id, `/${encodeURIComponent(thread)}`), place, linkHeaders(id)),
  edit: (id: string, thread: string, comment: string, text: string, mentions: string[] = []) =>
    request<ThreadChange>('PATCH', threadsPath(id, `/${encodeURIComponent(thread)}/${encodeURIComponent(comment)}`), { text, mentions }, linkHeaders(id)),
  /** The people of the file, for the @ list. */
  people: async (id: string) => (await request<{ people: Person[] }>('GET', `/api/files/${encodeURIComponent(id)}/people`, undefined, linkHeaders(id))).people,
  remove: (id: string, thread: string, comment: string) => request<ThreadChange>('DELETE', threadsPath(id, `/${encodeURIComponent(thread)}/${encodeURIComponent(comment)}`), undefined, linkHeaders(id)),
};

/** «@Name» put into a sticker or a text of a board: the server sends that person a letter with a link to the object. */
export const boardMentions = {
  notify: (id: string, userId: string, nodeId: string, text: string) => request<{ sent: boolean }>('POST', `/api/files/${encodeURIComponent(id)}/mentions`, { userId, nodeId, text }, linkHeaders(id)),
};

// ---------- share links ----------
//
// A link (?file=<id>&t=<token>) is remembered in this tab for the file, and
// every request about that file carries it in X-CS-Link; after the password
// of a protected link is entered, the server's proof is added: "<token>.<grant>".

const linkKey = (fileId: string) => `cs.link.${fileId}`;

export function rememberLink(fileId: string, token: string): void {
  try {
    sessionStorage.setItem(linkKey(fileId), token);
  } catch {
    // storage blocked: the link works only for this page load
  }
}

export function linkOf(fileId: string): string | null {
  try {
    return sessionStorage.getItem(linkKey(fileId));
  } catch {
    return null;
  }
}

function linkHeaders(fileId: string): Record<string, string> {
  const link = linkOf(fileId);
  return link ? { 'X-CS-Link': link } : {};
}

export type GrantRole = Exclude<Role, 'owner'>;

export interface SharePerson {
  id: string;
  name: string;
  email: string;
}

/** Who the link opens the file for: the people listed, a team's people, anyone. */
export type LinkMode = 'invited' | 'team' | 'anyone';

export interface ShareInfo {
  role: Role;
  owner: SharePerson;
  members: (SharePerson & { role: GrantRole })[];
  invites: { email: string; role: GrantRole; expiresAt: number }[];
  link: { mode: LinkMode; team?: { id: string; name: string }; role: GrantRole; token: string | null; hasPassword: boolean; expiresAt: number | null; guests?: boolean };
  /** The file is in a project of this team: all its people have it (unless restricted). */
  team?: { id: string; name: string; people: number };
  /** Closed to the team: of it, only admins have the file. */
  restricted: boolean;
  /** Teams a "team" link may be for. */
  teams: { id: string; name: string }[];
  /** The invitation was saved but its letter did not go out. */
  mailFailed?: boolean;
}

/** Sharing a server file (the "Share" dialog). */
export const sharing = {
  get: (id: string) => request<ShareInfo>('GET', `/api/files/${encodeURIComponent(id)}/share`, undefined, linkHeaders(id)),
  setLink: (id: string, patch: { mode?: LinkMode; teamId?: string; role?: GrantRole; password?: string | null; expiresInDays?: 1 | 7 | 30 | null; reset?: boolean; guests?: boolean }) =>
    request<ShareInfo>('PUT', `/api/files/${encodeURIComponent(id)}/share/link`, patch, linkHeaders(id)),
  setRestricted: (id: string, restricted: boolean) => request<ShareInfo>('PUT', `/api/files/${encodeURIComponent(id)}/share/restricted`, { restricted }, linkHeaders(id)),
  invite: (id: string, email: string, role: GrantRole) => request<ShareInfo>('POST', `/api/files/${encodeURIComponent(id)}/share/invite`, { email, role }, linkHeaders(id)),
  setRole: (id: string, userId: string, role: GrantRole) =>
    request<ShareInfo>('PATCH', `/api/files/${encodeURIComponent(id)}/share/members/${encodeURIComponent(userId)}`, { role }, linkHeaders(id)),
  remove: (id: string, userId: string) => request<ShareInfo>('DELETE', `/api/files/${encodeURIComponent(id)}/share/members/${encodeURIComponent(userId)}`, undefined, linkHeaders(id)),
  removeInvite: (id: string, email: string) => request<ShareInfo>('DELETE', `/api/files/${encodeURIComponent(id)}/share/invites?email=${encodeURIComponent(email)}`, undefined, linkHeaders(id)),
  /** Enters the password of a protected link; later requests carry the proof. */
  async unlock(id: string, password: string): Promise<void> {
    const token = (linkOf(id) ?? '').split('.')[0]!;
    const { grant } = await request<{ grant: string }>('POST', `/api/files/${encodeURIComponent(id)}/share/unlock`, { token, password });
    rememberLink(id, `${token}.${grant}`);
  },
  /** The address to send: the file, optionally a page and a layer to show. */
  url(id: string, token: string | null, target?: { page?: string; node?: string }): string {
    const u = new URL('/', location.origin);
    u.searchParams.set('file', id);
    if (token) u.searchParams.set('t', token);
    if (target?.page) u.searchParams.set('page', target.page);
    if (target?.node) u.searchParams.set('node', target.node);
    return u.href;
  },
};

export type TeamRole = 'viewer' | 'commenter' | 'editor' | 'admin';

export interface TeamInfo {
  id: string;
  name: string;
  /** This person's role in the team. */
  role: TeamRole | 'owner';
  createdAt: number;
  /** Everyone in the team, the owner first. */
  members: (SharePerson & { role: TeamRole | 'owner' })[];
  /** Invitations waiting for sign-up (admins only). */
  invites?: { email: string; role: TeamRole; expiresAt: number }[];
}

/** Teams on the server (the home screen and the "People" dialog). */
export const teams = {
  list: async () => (await request<{ teams: TeamInfo[] }>('GET', '/api/teams')).teams,
  create: async (name: string) => (await request<{ team: TeamInfo }>('POST', '/api/teams', { name })).team,
  rename: async (id: string, name: string) => (await request<{ team: TeamInfo }>('PATCH', `/api/teams/${encodeURIComponent(id)}`, { name })).team,
  remove: (id: string) => request<{ ok: true; moved: number }>('DELETE', `/api/teams/${encodeURIComponent(id)}`),
  invite: (id: string, email: string, role: TeamRole) => request<{ team: TeamInfo; mailFailed?: boolean }>('POST', `/api/teams/${encodeURIComponent(id)}/invite`, { email, role }),
  setRole: async (id: string, userId: string, role: TeamRole) => (await request<{ team: TeamInfo }>('PATCH', `/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { role })).team,
  removeMember: (id: string, userId: string) => request<{ team?: TeamInfo; ok?: true }>('DELETE', `/api/teams/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`),
  removeInvite: async (id: string, email: string) => (await request<{ team: TeamInfo }>('DELETE', `/api/teams/${encodeURIComponent(id)}/invites?email=${encodeURIComponent(email)}`)).team,
};

export type Probe = { state: 'signed-in'; user: CloudUser; offline?: boolean } | { state: 'signed-out' } | { state: 'no-server' };

export const cloud = {
  /** Is there a server, and are we signed in? */
  async probe(): Promise<Probe> {
    try {
      const me = await request<{ user: CloudUser; prefs?: Record<string, string> }>('GET', '/api/me');
      // Settings of the account (from another computer): another language needs a reload.
      if (adoptAccountPrefs(me.prefs)) {
        location.reload();
        await new Promise(() => undefined);
      }
      rememberUser(me.user);
      return { state: 'signed-in', user: me.user };
    } catch (error) {
      if (error instanceof CloudError && error.status === 401) {
        rememberUser(null);
        return { state: 'signed-out' };
      }
      // No network: the account last signed in here works with its copies of the files.
      const known = error instanceof CloudError && error.status === 0 ? rememberedUser() : null;
      if (known) return { state: 'signed-in', user: known, offline: true };
      return { state: 'no-server' };
    }
  },
  /** Creates an account and mails a code; the account works once `verify` gets that code. */
  /** `consent`: the person ticked consent to personal data processing (the server refuses without it). */
  async register(email: string, password: string, name: string, consent: boolean): Promise<{ email: string }> {
    return request<{ pending: true; email: string }>('POST', '/api/auth/register', { email, password, name, consent });
  },
  async verify(email: string, code: string): Promise<CloudUser> {
    return withAccountPrefs((await request<{ user: CloudUser }>('POST', '/api/auth/verify', { email, code })).user);
  },
  /** Mails the registration code again. */
  async resend(email: string): Promise<void> {
    await request('POST', '/api/auth/resend', { email });
  },
  /** Changes the name others see; empty — they see the email address. */
  async rename(name: string): Promise<CloudUser> {
    return (await request<{ user: CloudUser }>('PATCH', '/api/me', { name })).user;
  },
  /** What deleting the account would do: own files (and how many are shared), files kept by teams, teams handed over or deleted. */
  async deletionPreview(): Promise<{ files: number; shared: number; keptInTeams: number; teamsHandedOver: { team: string; to: string }[]; teamsDeleted: string[] }> {
    return request('GET', '/api/me/deletion');
  },
  /** Deletes the account; the password confirms it. */
  async deleteAccount(password: string): Promise<void> {
    await request('DELETE', '/api/me', { password });
  },
  async login(email: string, password: string): Promise<CloudUser> {
    return withAccountPrefs((await request<{ user: CloudUser }>('POST', '/api/auth/login', { email, password })).user);
  },
  /** Вход через SSO reporting (короткий токен → cookie-сессия Симметрики). */
  async loginWithReportingSso(token: string): Promise<CloudUser> {
    return withAccountPrefs((await request<{ user: CloudUser }>('POST', '/api/auth/reporting-sso', { token })).user);
  },
  /** Asks the server to mail a password reset code (the answer is the same for unknown emails). */
  async forgotPassword(email: string): Promise<void> {
    await request('POST', '/api/auth/forgot', { email });
  },
  async resetPassword(email: string, code: string, password: string): Promise<CloudUser> {
    return withAccountPrefs((await request<{ user: CloudUser }>('POST', '/api/auth/reset', { email, code, password })).user);
  },
  async logout(): Promise<void> {
    await request('POST', '/api/auth/logout', {});
    forgetAccountPrefs();
    rememberUser(null);
  },
};

/** Where the app keeps files: this browser, or the server. */
export interface FileBackend {
  readonly kind: 'local' | 'cloud';
  /** localStorage key remembering the file opened last. */
  readonly lastFileKey: string;
  load(id: string): Promise<StoredFile | undefined>;
  /** Saves; returns the id the file was saved under (a conflicting save goes to a new copy). */
  save(file: StoredFile): Promise<string>;
  remove(id: string): Promise<void>;
  list(): Promise<FileMeta[]>;
  rename(id: string, name: string): Promise<void>;
  /** Moves a file to a project (null — to Drafts). */
  move(id: string, projectId: string | null): Promise<void>;
  /** Stores the preview drawn by the editor (a data: URL). */
  saveThumbnail(id: string, dataUrl: string): Promise<void>;
  projects(): Promise<ProjectMeta[]>;
  /** A new project: one's own, or a team's (server only). */
  createProject(name: string, teamId?: string): Promise<ProjectMeta>;
  renameProject(id: string, name: string): Promise<void>;
  /** Deletes a project; its files move to Drafts. */
  removeProject(id: string): Promise<void>;
  /** Removes a file shared with this person from their list (gives the access up). */
  leave(id: string): Promise<void>;
}

export const localBackend: FileBackend = {
  kind: 'local',
  lastFileKey: 'cs.file',
  load: (id) => storage.load(id),
  save: async (file) => {
    await storage.save(file);
    return file.id;
  },
  remove: (id) => storage.remove(id).then(() => undefined),
  list: () => storage.list(),
  rename: (id, name) => storage.rename(id, name),
  move: (id, projectId) => storage.setMeta(id, { projectId }),
  saveThumbnail: (id, dataUrl) => storage.setMeta(id, { thumb: dataUrl }),
  projects: async () => localProjects.list(),
  createProject: async (name) => localProjects.create(name),
  renameProject: async (id, name) => localProjects.rename(id, name),
  removeProject: (id) => localProjects.remove(id),
  leave: async () => undefined,
};

interface ServerMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  projectId?: string | null;
  thumbAt?: number;
  role?: Role;
  ownerName?: string;
  shared?: boolean;
  restricted?: boolean;
  /** Open (not merged) branches of the file. */
  branches?: number;
  kind?: 'board' | 'diagram' | 'slides';
}

/** Per-user view of a file (page and viewport) stays in this browser: it is nobody else's business. */
function viewKey(id: string): string {
  return `cs.cloud.view.${id}`;
}

export class CloudBackend implements FileBackend {
  readonly kind = 'cloud';
  readonly lastFileKey: string;
  /** null — a visitor without an account, opening a file by its link. */
  readonly user: CloudUser | null;
  /** The version each open file was loaded or saved at: a save from an older one is a conflict. */
  private readonly versions = new Map<string, number>();
  /** Called when a conflicting save was kept as a copy. */
  onConflict: (copyName: string) => void = () => {};
  /** The last file list came from the copies in this browser (no network). */
  offline = false;

  constructor(user: CloudUser | null) {
    this.user = user;
    this.lastFileKey = `cs.cloud.file.${user?.id ?? 'guest'}`;
  }

  /** Version of the file as last loaded or saved here (the live session starts from it). */
  versionOf(id: string): number | null {
    return this.versions.get(id) ?? null;
  }

  async load(id: string): Promise<StoredFile | undefined> {
    try {
      const data = await request<{ file: ServerMeta; snapshot: string | null; role: Role; signedIn: boolean; branch?: BranchMeta }>('GET', `/api/files/${encodeURIComponent(id)}?format=lines`, undefined, linkHeaders(id));
      if (!data.snapshot) return undefined;
      this.versions.set(id, data.file.version);
      let view: Pick<StoredFile, 'viewport' | 'pageId'> = {};
      try {
        view = JSON.parse(localStorage.getItem(viewKey(id)) ?? '{}') as typeof view;
      } catch {
        view = {};
      }
      // A copy for working without a network; changes not confirmed earlier are kept and sent now.
      const kept = this.user ? await offline.get(id, this.user.id) : null;
      if (this.user) void offline.put({ id, userId: this.user.id, name: data.file.name, snapshot: data.snapshot, version: data.file.version, role: data.role, savedAt: Date.now(), pending: kept?.pending ?? [] });
      return { id, name: data.file.name, snapshot: data.snapshot, savedAt: data.file.updatedAt, role: data.role, signedIn: data.signedIn, ...(data.branch ? { branch: data.branch } : {}), ...(data.file.ownerName ? { ownerName: data.file.ownerName } : {}), ...(kept?.pending.length ? { pending: kept.pending } : {}), ...view };
    } catch (error) {
      if (error instanceof CloudError && error.status === 404) {
        // Deleted or access closed: the copy here goes too.
        void offline.remove(id);
        return undefined;
      }
      // No network: the copy from the last time.
      if (error instanceof CloudError && error.status === 0 && this.user) {
        const kept = await offline.get(id, this.user.id);
        if (kept) {
          this.versions.set(id, kept.version);
          return { id, name: kept.name, snapshot: kept.snapshot, savedAt: kept.savedAt, role: kept.role, signedIn: true, offline: true, ...(kept.pending.length ? { pending: kept.pending } : {}) };
        }
      }
      throw error;
    }
  }

  async save(file: StoredFile): Promise<string> {
    try {
      localStorage.setItem(viewKey(file.id), JSON.stringify({ viewport: file.viewport, pageId: file.pageId }));
    } catch {
      // storage full or blocked: the view is a convenience
    }
    const put = async (id: string, name: string, base: number | undefined) => {
      const data = await request<{ file: ServerMeta }>('PUT', `/api/files/${encodeURIComponent(id)}`, {
        name,
        snapshot: file.snapshot,
        ...(base !== undefined ? { baseVersion: base } : {}),
        ...(file.projectId ? { projectId: file.projectId } : {}),
      }, linkHeaders(id));
      this.versions.set(id, data.file.version);
      return id;
    };
    try {
      return await put(file.id, file.name, this.versions.get(file.id));
    } catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'conflict') throw error;
      // Someone saved this file from another window: keep both, never overwrite.
      const copyName = tr('{0} (конфликт {1})', file.name, new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }));
      const id = await put(newCloudId(), copyName, undefined);
      this.onConflict(copyName);
      return id;
    }
  }

  async remove(id: string): Promise<void> {
    await request('DELETE', `/api/files/${encodeURIComponent(id)}`);
    this.versions.delete(id);
    void offline.remove(id);
    try {
      localStorage.removeItem(viewKey(id));
    } catch {
      // ignore
    }
  }

  async list(): Promise<FileMeta[]> {
    let data: { files: ServerMeta[] };
    try {
      data = await request<{ files: ServerMeta[] }>('GET', '/api/files');
      this.offline = false;
    } catch (error) {
      // No network: the files that have a copy in this browser.
      if (!(error instanceof CloudError && error.status === 0) || !this.user) throw error;
      this.offline = true;
      return (await offline.list(this.user.id)).map((f) => ({ id: f.id, name: f.name, savedAt: f.savedAt, createdAt: f.savedAt, role: f.role }));
    }
    return data.files.map((f) => ({
      id: f.id,
      name: f.name,
      savedAt: f.updatedAt,
      createdAt: f.createdAt,
      projectId: f.projectId ?? null,
      ...(f.role ? { role: f.role } : {}),
      ...(f.ownerName ? { ownerName: f.ownerName } : {}),
      ...(f.shared ? { shared: true } : {}),
      ...(f.restricted ? { restricted: true } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.branches ? { branches: f.branches } : {}),
      ...(f.thumbAt ? { thumb: `/api/files/${encodeURIComponent(f.id)}/thumbnail?v=${f.thumbAt}` } : {}),
    }));
  }

  async move(id: string, projectId: string | null): Promise<void> {
    await request('PATCH', `/api/files/${encodeURIComponent(id)}`, { projectId });
  }

  async saveThumbnail(id: string, dataUrl: string): Promise<void> {
    await request('PUT', `/api/files/${encodeURIComponent(id)}/thumbnail`, { image: dataUrl }, linkHeaders(id));
  }

  async projects(): Promise<ProjectMeta[]> {
    try {
      return (await request<{ projects: ProjectMeta[] }>('GET', '/api/projects')).projects;
    } catch (error) {
      // No network: files are shown without their projects (the copies are in "Recent").
      if (error instanceof CloudError && error.status === 0) return [];
      throw error;
    }
  }

  async createProject(name: string, teamId?: string): Promise<ProjectMeta> {
    return (await request<{ project: ProjectMeta }>('POST', '/api/projects', { name, ...(teamId ? { teamId } : {}) })).project;
  }

  async renameProject(id: string, name: string): Promise<void> {
    await request('PATCH', `/api/projects/${encodeURIComponent(id)}`, { name });
  }

  async leave(id: string): Promise<void> {
    if (this.user) await request('DELETE', `/api/files/${encodeURIComponent(id)}/share/members/${encodeURIComponent(this.user.id)}`);
  }

  async removeProject(id: string): Promise<void> {
    await request('DELETE', `/api/projects/${encodeURIComponent(id)}`);
  }

  async rename(id: string, name: string): Promise<void> {
    const data = await request<{ file: ServerMeta }>('PATCH', `/api/files/${encodeURIComponent(id)}`, { name }, linkHeaders(id));
    if (this.versions.has(id)) this.versions.set(id, data.file.version);
  }
}

export function newCloudId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'f' + [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}
