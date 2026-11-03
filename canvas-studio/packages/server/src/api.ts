// HTTP API: accounts (register with an emailed code, login, logout, me,
// password reset), the user's projects and files (with previews).
// Every state-changing request must carry the `X-CS: 1` header — a custom
// header cannot be sent cross-site without a CORS preflight, which this server
// never allows — and, when the browser sends an Origin, it must be our own.
// Together with SameSite cookies this closes cross-site request forgery.

import { randomBytes, randomInt } from 'node:crypto';
import { LinkPreviews, previewTarget } from './link-preview.ts';
import { askText, checkAnswer, parseAnswer, parseTextRequest, TEXT_MAX } from './ai-text.ts';
import { AiError, answerKind, BASE_MAX, FILES_MAX, PROMPT_MAX, streamLayout, type AiConfig } from './ai-layout.ts';
import { snapshotKind } from '../../core/src/schema.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CONSENT_EDITION,
  dummyPasswordHash,
  hashPassword,
  HIDDEN_NAME,
  mergePrefs,
  newId,
  newToken,
  normalizeEmail,
  passwordProblem,
  publicUser,
  RateLimiter,
  SESSION_DAYS,
  tokenHash,
  validEmail,
  verifyPassword,
  type Session,
  type User,
} from './auth.ts';
import { isSsoUserPassword, SSO_PASSWORD_MARKER, verifyReportingSsoToken } from './reporting-sso.ts';
import {
  atLeast,
  claimInvites,
  higher,
  INVITE_DAYS,
  isGrantRole,
  isOpenLink,
  linkGrant,
  LINK_MODES,
  linkRole,
  liveInvites,
  memberRole,
  parseLinkHeader,
  type GrantRole,
  type LinkMode,
  type Role,
  type Sharing,
} from './access.ts';
import { addReply, addThread, cleanMentions, cleanPlace, cleanText, CommentError, commentMailPref, deleteComment, editComment, mailRecipients, movePin, parseThreads, publicThread, setResolved, THREADS_PER_FILE, type CommentEntry, type Thread } from './comments.ts';
import { cookie, HttpError, parseCookies, readBody, readJson, Router, type Ctx } from './http.ts';
import { codeLetter, commentLetter, reviewLetter, shareLetter, teamLetter, verdictLetter, type Mailer } from './mail.ts';
import { FileBlobs, isSafeId, JsonStore, writeAtomic } from './storage.ts';
import { Versions } from './versions.ts';
import { Documents } from './documents.ts';
import { GoogleFonts, parseFaceRequest } from './fonts.ts';
import { addTeamInvite, addTeamMember, claimTeamInvite, isTeamRole, liveTeamInvites, TEAM_ROLES, teamAtLeast, teamRole, withTeam, type Team, type TeamRole } from './teams.ts';
import { mkdir, readFile } from 'node:fs/promises';

export const SESSION_COOKIE = 'cs_session';
/** A whole document with its images can be large. */
const MAX_DOCUMENT = 64 * 1024 * 1024;
const CODE_MINUTES = 15;
const CODE_ATTEMPTS = 5;
/** A preview image is small: a few hundred pixels wide. */
const MAX_THUMBNAIL = 1024 * 1024;
const THUMBNAIL_TYPES: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

export type CodePurpose = 'verify' | 'reset';

/** A one-time code sent by mail; only its hash is kept, keyed by purpose and user id. */
export interface OneTimeCode {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

/** A folder of files, as projects in Figma: a person's own, or a team's. */
export interface Project {
  id: string;
  name: string;
  /** Who made it; for a team project this gives nothing by itself — the team decides. */
  ownerId: string;
  /** The team the project belongs to; none — the owner's own project. */
  teamId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileMeta extends Sharing {
  id: string;
  name: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  /** Increases on every save; a save based on an older version is refused (409). */
  version: number;
  /** Project the file is in; none — "Drafts". */
  projectId?: string | null;
  /** When the preview was last updated (for cache busting); none — no preview yet. */
  thumbAt?: number;
  /** Published as a library: its components can be used in other files (files/<id>/library.json). */
  library?: { publishedAt: number; publishedBy: string; components: number };
  /** A branch of another file (FR-BR-001): not in file lists, access as to the main file. */
  branch?: BranchInfo;
  /** A board (FEAT-083); none — a design. */
  kind?: 'board' | 'diagram' | 'slides';
}

export interface BranchInfo {
  /** The main file. */
  of: string;
  description?: string;
  /** Merged into the main file: the versions of the main file right before and right after. */
  merged?: { at: number; by: string; before: string; after: string };
  /** A review request (FR-BR-003): who asked, what to look at, and each reviewer's answer. */
  review?: BranchReview;
}

export interface BranchReview {
  by: string;
  at: number;
  description: string;
  reviewers: { id: string; verdict?: 'approved' | 'changes'; at?: number; note?: string }[];
}

/** A merged branch is kept this long, so the merge can be undone (FR-BR-005). */
export const BRANCH_KEEP_DAYS = 30;

export interface ApiOptions {
  dataDir: string;
  /** Cookies get the Secure flag (behind HTTPS). */
  secure: boolean;
  /** Registration open to anyone (otherwise only the first account can be created). */
  openRegistration: boolean;
  /** Sends letters (password reset codes). */
  mailer: Mailer;
  /** Public address of the app, shown in letters. */
  appUrl?: string;
  /** Адрес reporting (APP_PUBLIC_URL). Ссылки в письмах ведут сюда, не на порт Симметрики. */
  publicUrl?: string;
  log?: (line: string) => void;
  /** How Google Fonts is reached (tests pass their own). */
  fontsFetch?: typeof fetch;
  /** Fetches pages for link cards (tests pass their own). */
  linkGet?: import('./link-preview.ts').Getter;
  /** The language model gateway for layouts from a description (ai-layout.ts); none — the feature is off. */
  ai?: AiConfig | null;
  /** How the gateway is reached (tests pass their own). */
  aiFetch?: typeof fetch;
  /**
   * Shared HMAC secret with reporting (`CANVAS_STUDIO_SSO_SECRET`).
   * When set, `POST /api/auth/reporting-sso` creates a Simmetrika session from reporting login.
   */
  reportingSsoSecret?: string;
  /** Disable password register/login/reset — only reporting SSO. */
  reportingAuthOnly?: boolean;
  /**
   * PostgreSQL URL (reporting). When set, users/files/blobs go to simmetrika_* tables
   * instead of JSON files under dataDir.
   */
  databaseUrl?: string;
}

/** Where a branch keeps the main file's state it was made from (or last took changes from), without pictures. */
const BRANCH_BASE = 'base.json';

/** A snapshot without picture data: the common ancestor is only compared, never shown. */
function withoutPictures(text: string): string {
  const snap = JSON.parse(text) as { nodes?: unknown; blobs?: unknown };
  if (!snap || !Array.isArray(snap.nodes)) throw new Error('no nodes');
  delete snap.blobs;
  return JSON.stringify(snap);
}

/**
 * Who has which file, kept in memory as the files change (PERF-006): the list of a
 * person's files, a team's files and a file's branches no longer go through every
 * file of the server.
 */
export class FileIndex {
  private readonly byUser = new Map<string, Set<string>>();
  private readonly byEmail = new Map<string, Set<string>>();
  private readonly byProject = new Map<string, Set<string>>();
  private readonly byMain = new Map<string, Set<string>>();

  private static put(map: Map<string, Set<string>>, key: string | null | undefined, id: string, on: boolean): void {
    if (!key) return;
    let set = map.get(key);
    if (on) {
      if (!set) map.set(key, (set = new Set()));
      set.add(id);
    } else if (set) {
      set.delete(id);
      if (!set.size) map.delete(key);
    }
  }

  private mark(f: FileMeta, on: boolean): void {
    FileIndex.put(this.byUser, f.ownerId, f.id, on);
    for (const m of f.members ?? []) FileIndex.put(this.byUser, m.userId, f.id, on);
    for (const i of f.invites ?? []) FileIndex.put(this.byEmail, i.email, f.id, on);
    FileIndex.put(this.byProject, f.projectId ?? null, f.id, on);
    FileIndex.put(this.byMain, f.branch?.of, f.id, on);
  }

  update(before: FileMeta | null, after: FileMeta | null): void {
    if (before) this.mark(before, false);
    if (after) this.mark(after, true);
  }

  /** Files a person owns or is a member of, or is invited to by address. */
  forPerson(userId: string, email: string): Set<string> {
    return new Set([...(this.byUser.get(userId) ?? []), ...(this.byEmail.get(email) ?? [])]);
  }

  inProjects(projects: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const p of projects) for (const id of this.byProject.get(p) ?? []) out.add(id);
    return out;
  }

  branchesOf(id: string): string[] {
    return [...(this.byMain.get(id) ?? [])];
  }
}

type KvStore<T> = JsonStore<T> | import('./pg-storage.ts').PgJsonStore<T>;

export class Api {
  readonly router = new Router();
  readonly users: KvStore<User>;
  readonly sessions: KvStore<Session>;
  readonly files: KvStore<FileMeta>;
  /** Who has which file (PERF-006); ready once every file record was read. */
  private readonly fileIndex = new FileIndex();
  private fileIndexReady: Promise<FileIndex> | null = null;
  readonly codes: KvStore<OneTimeCode>;
  readonly projects: KvStore<Project>;
  readonly teams: KvStore<Team>;
  readonly blobs: import('./storage.ts').BlobStore;
  private secretLoader: (() => Promise<Uint8Array>) | null = null;
  private healthCheck: (() => Promise<{ ok: true; storage: string }>) | null = null;
  private colleagues: ((q: string) => Promise<{ name: string; email: string }[]>) | null = null;
  readonly versions: Versions;
  /** Documents on disk: pictures apart from the rest (documents.ts). */
  readonly documents: Documents;
  private readonly googleFonts: GoogleFonts;
  private readonly options: ApiOptions;
  private emails: Map<string, string> | null = null;
  private readonly loginByIp = new RateLimiter(30, 10 * 60_000);
  private readonly loginByEmail = new RateLimiter(10, 10 * 60_000);
  private readonly registerByIp = new RateLimiter(10, 60 * 60_000);
  private readonly forgotByIp = new RateLimiter(10, 60 * 60_000);
  private readonly forgotByEmail = new RateLimiter(3, 60 * 60_000);
  private readonly resetByIp = new RateLimiter(30, 10 * 60_000);
  private readonly verifyByIp = new RateLimiter(30, 10 * 60_000);
  /** Welcome letters (registration, resend, login before confirming) per address. */
  private readonly verifyMailByEmail = new RateLimiter(5, 60 * 60_000);
  /** Invitation letters a person may send (protects other people's mailboxes). */
  private readonly invitesByUser = new RateLimiter(50, 60 * 60_000);
  private readonly unlockByIp = new RateLimiter(20, 10 * 60_000);
  /** Font faces from Google: a big file may need a few dozen at once. */
  private readonly fontsByIp = new RateLimiter(300, 10 * 60_000);
  private readonly commentsByUser = new RateLimiter(300, 60 * 60_000);
  /** @ in board texts: letters one person may cause in an hour. */
  private readonly mentionsByUser = new RateLimiter(60, 60 * 60_000);
  /** Link cards on boards: pasting a list of links is fine, crawling through us is not. */
  private readonly previewsByUser = new RateLimiter(120, 10 * 60_000);
  private readonly linkPreviews: LinkPreviews;
  /** Layouts from a description: each costs money, so a day's share per person… */
  private readonly layoutsByUser = new RateLimiter(20, 24 * 60 * 60_000);
  /** …and one at a time. */
  private readonly layoutsRunning = new Set<string>();
  /** Small requests (texts, notes, names — ai-text.ts): cheap, but not unlimited. */
  private readonly aiTextsByUser = new RateLimiter(150, 24 * 60 * 60_000);
  /** Comment letters one person gets: at most so many an hour… */
  private readonly commentMailsTo = new RateLimiter(30, 60 * 60_000);
  /** …and one per discussion in ten minutes, unless called with @ (a lively thread is not a flood of letters). */
  private readonly threadMailsTo = new RateLimiter(1, 10 * 60_000);
  private secret: Promise<Uint8Array> | null = null;
  /** Live editing rooms (set by the server); files open in a room are saved by the room. */
  live: { isLive(id: string): Promise<boolean>; rename(id: string, name: string): Promise<boolean>; deleted(id: string): Promise<void>; accessChanged(id: string): Promise<void>; broadcast(id: string, message: object | ((insider: boolean) => object)): Promise<void>; flush(id: string): Promise<void>; signedOut(who: { session?: string; userId?: string }): Promise<void> } | null = null;

  constructor(options: ApiOptions, storage?: {
    users: KvStore<User>;
    sessions: KvStore<Session>;
    files: KvStore<FileMeta>;
    codes: KvStore<OneTimeCode>;
    projects: KvStore<Project>;
    teams: KvStore<Team>;
    blobs: import('./storage.ts').BlobStore;
    secretLoader?: () => Promise<Uint8Array>;
    healthCheck?: () => Promise<{ ok: true; storage: string }>;
    colleagues?: (q: string) => Promise<{ name: string; email: string }[]>;
  }) {
    this.options = options;
    if (storage) {
      this.users = storage.users;
      this.sessions = storage.sessions;
      this.files = storage.files;
      this.codes = storage.codes;
      this.projects = storage.projects;
      this.teams = storage.teams;
      this.blobs = storage.blobs;
      this.secretLoader = storage.secretLoader ?? null;
      this.healthCheck = storage.healthCheck ?? null;
      this.colleagues = storage.colleagues ?? null;
    } else {
      this.users = new JsonStore<User>(`${options.dataDir}/users`);
      this.sessions = new JsonStore<Session>(`${options.dataDir}/sessions`);
      this.files = new JsonStore<FileMeta>(`${options.dataDir}/files-meta`);
      this.codes = new JsonStore<OneTimeCode>(`${options.dataDir}/codes`);
      this.projects = new JsonStore<Project>(`${options.dataDir}/projects`);
      this.teams = new JsonStore<Team>(`${options.dataDir}/teams`);
      this.blobs = new FileBlobs(`${options.dataDir}/files`);
    }
    this.files.onWrite = (_id, before, after) => this.fileIndex.update(before, after);
    this.versions = new Versions(this.blobs, options.log);
    this.documents = new Documents(this.blobs);
    this.googleFonts = new GoogleFonts(`${options.dataDir}/fonts-google`, options.fontsFetch);
    this.linkPreviews = new LinkPreviews(options.linkGet);
    const r = this.router;
    r.on('GET', '/api/health', async () => {
      if (this.healthCheck) return this.healthCheck();
      return { ok: true, storage: 'disk' };
    });
    r.on('GET', '/api/fonts/google', (c) => this.googleFont(c));
    r.on('GET', '/api/link-preview', (c) => this.linkPreview(c));
    r.on('POST', '/api/ai/layout', (c) => this.aiLayout(c));
    r.on('POST', '/api/ai/text', (c) => this.aiText(c));
    r.on('POST', '/api/auth/register', (c) => this.register(c));
    r.on('POST', '/api/auth/login', (c) => this.login(c));
    r.on('POST', '/api/auth/reporting-sso', (c) => this.reportingSso(c));
    r.on('POST', '/api/auth/logout', (c) => this.logout(c));
    r.on('POST', '/api/auth/verify', (c) => this.verify(c));
    r.on('POST', '/api/auth/resend', (c) => this.resend(c));
    r.on('POST', '/api/auth/forgot', (c) => this.forgot(c));
    r.on('POST', '/api/auth/reset', (c) => this.reset(c));
    r.on('GET', '/api/directory', (c) => this.directory(c));
    r.on('GET', '/api/me', async (c) => {
      const user = await this.requireUser(c);
      return { user: publicUser(user), prefs: user.prefs ?? {} };
    });
    r.on('PUT', '/api/me/prefs', (c) => this.savePrefs(c));
    r.on('PATCH', '/api/me', (c) => this.renameMe(c));
    r.on('GET', '/api/me/deletion', (c) => this.deletionPreview(c));
    r.on('DELETE', '/api/me', (c) => this.deleteAccount(c));
    r.on('GET', '/api/files', (c) => this.listFiles(c));
    r.on('GET', '/api/files/:id', (c) => this.getFile(c));
    r.on('PUT', '/api/files/:id', (c) => this.putFile(c));
    r.on('PATCH', '/api/files/:id', (c) => this.patchFile(c));
    r.on('DELETE', '/api/files/:id', (c) => this.deleteFile(c));
    r.on('GET', '/api/files/:id/thumbnail', (c) => this.getThumbnail(c));
    r.on('PUT', '/api/files/:id/thumbnail', (c) => this.putThumbnail(c));
    r.on('GET', '/api/projects', (c) => this.listProjects(c));
    r.on('POST', '/api/projects', (c) => this.createProject(c));
    r.on('PATCH', '/api/projects/:id', (c) => this.renameProject(c));
    r.on('DELETE', '/api/projects/:id', (c) => this.deleteProject(c));
    r.on('GET', '/api/teams', (c) => this.listTeams(c));
    r.on('POST', '/api/teams', (c) => this.createTeam(c));
    r.on('PATCH', '/api/teams/:id', (c) => this.renameTeam(c));
    r.on('DELETE', '/api/teams/:id', (c) => this.deleteTeam(c));
    r.on('POST', '/api/teams/:id/invite', (c) => this.teamInvite(c));
    r.on('PATCH', '/api/teams/:id/members/:userId', (c) => this.setTeamRole(c));
    r.on('DELETE', '/api/teams/:id/members/:userId', (c) => this.removeTeamMember(c));
    r.on('DELETE', '/api/teams/:id/invites', (c) => this.removeTeamInvite(c));
    r.on('GET', '/api/files/:id/share', (c) => this.getShare(c));
    r.on('PUT', '/api/files/:id/share/link', (c) => this.setLink(c));
    r.on('PUT', '/api/files/:id/share/restricted', (c) => this.setRestricted(c));
    r.on('POST', '/api/files/:id/share/invite', (c) => this.invite(c));
    r.on('PATCH', '/api/files/:id/share/members/:userId', (c) => this.setMemberRole(c));
    r.on('DELETE', '/api/files/:id/share/members/:userId', (c) => this.removeMember(c));
    r.on('DELETE', '/api/files/:id/share/invites', (c) => this.removeInvite(c));
    r.on('POST', '/api/files/:id/share/unlock', (c) => this.unlockLink(c));
    r.on('GET', '/api/files/:id/fresh', (c) => this.freshFile(c));
    r.on('GET', '/api/files/:id/branches', (c) => this.listBranches(c));
    r.on('POST', '/api/files/:id/branches', (c) => this.createBranch(c));
    r.on('POST', '/api/files/:id/branches/:branchId/merged', (c) => this.branchMerged(c, true));
    r.on('POST', '/api/files/:id/branches/:branchId/unmerged', (c) => this.branchMerged(c, false));
    r.on('GET', '/api/files/:id/branch', (c) => this.branchOf(c));
    r.on('POST', '/api/files/:id/review', (c) => this.requestReview(c));
    r.on('DELETE', '/api/files/:id/review', (c) => this.cancelReview(c));
    r.on('POST', '/api/files/:id/review/verdict', (c) => this.reviewVerdict(c));
    r.on('POST', '/api/files/:id/branches/:branchId/comments', (c) => this.carryComments(c));
    r.on('PUT', '/api/files/:id/branch/base', (c) => this.setBranchBase(c));
    r.on('GET', '/api/files/:id/versions', (c) => this.listVersions(c));
    r.on('POST', '/api/files/:id/versions', (c) => this.saveVersion(c));
    r.on('GET', '/api/files/:id/versions/:versionId', (c) => this.getVersion(c));
    r.on('PATCH', '/api/files/:id/versions/:versionId', (c) => this.renameVersion(c));
    r.on('GET', '/api/files/:id/comments', (c) => this.listComments(c));
    r.on('GET', '/api/files/:id/people', (c) => this.listPeople(c));
    r.on('GET', '/api/libraries', (c) => this.listLibraries(c));
    r.on('GET', '/api/files/:id/library', (c) => this.getLibrary(c));
    r.on('PUT', '/api/files/:id/library', (c) => this.publishLibrary(c));
    r.on('DELETE', '/api/files/:id/library', (c) => this.unpublishLibrary(c));
    r.on('POST', '/api/files/:id/comments', (c) => this.createThread(c));
    r.on('POST', '/api/files/:id/mentions', (c) => this.boardMention(c));
    r.on('PATCH', '/api/files/:id/comments/:threadId', (c) => this.patchThread(c));
    r.on('POST', '/api/files/:id/comments/:threadId/replies', (c) => this.reply(c));
    r.on('PATCH', '/api/files/:id/comments/:threadId/:commentId', (c) => this.editComment(c));
    r.on('DELETE', '/api/files/:id/comments/:threadId/:commentId', (c) => this.deleteComment(c));
  }

  /** The index of files, built from the records the first time it is needed. */
  private indexOfFiles(): Promise<FileIndex> {
    this.fileIndexReady ??= this.files.all().then((all) => {
      for (const f of all) this.fileIndex.update(f, f);
      return this.fileIndex;
    });
    return this.fileIndexReady;
  }

  /** File records by id, those still there. */
  private async metas(ids: Iterable<string>): Promise<FileMeta[]> {
    const out: FileMeta[] = [];
    for (const id of ids) {
      const f = await this.files.get(id);
      if (f) out.push(f);
    }
    return out;
  }

  // ---------- accounts ----------

  private async emailIndex(): Promise<Map<string, string>> {
    if (!this.emails) {
      const map = new Map<string, string>();
      for (const u of await this.users.all()) map.set(u.email, u.id);
      this.emails = map;
    }
    return this.emails;
  }

  /** Resolve user id by email: memory index, then PostgreSQL expression index when available. */
  private async userIdByEmail(email: string): Promise<string | undefined> {
    const index = await this.emailIndex();
    const cached = index.get(email);
    if (cached) return cached;
    const store = this.users as { findIdByField?: (field: string, value: string) => Promise<string | null> };
    if (store.findIdByField) {
      const id = await store.findIdByField('email', email);
      if (id) {
        index.set(email, id);
        return id;
      }
    }
    return undefined;
  }

  private setSession(c: Ctx, token: string | null): void {
    c.res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, token ?? '', { maxAge: token ? SESSION_DAYS * 86400 : 0, secure: this.options.secure }));
  }

  private async startSession(c: Ctx, user: User): Promise<void> {
    const token = newToken();
    const now = Date.now();
    await this.sessions.put(tokenHash(token), { userId: user.id, createdAt: now, expiresAt: now + SESSION_DAYS * 86400_000 });
    this.setSession(c, token);
  }

  private refusePasswordAuth(): void {
    if (this.options.reportingAuthOnly) {
      throw new HttpError(403, 'Вход только через reporting. Отдельная регистрация отключена.', 'reporting_auth');
    }
  }

  /** Exchange a short reporting SSO token for a Simmetrika session cookie. */
  private async reportingSso(c: Ctx): Promise<unknown> {
    const secret = this.options.reportingSsoSecret?.trim();
    if (!secret) throw new HttpError(503, 'SSO reporting не настроен', 'sso_disabled');
    if (!this.loginByIp.allow(c.ip)) throw new HttpError(429, 'Слишком много попыток. Подождите несколько минут.', 'rate_limited');
    const body = await readJson<{ token?: unknown }>(c.req);
    const token = String(body.token ?? '').trim();
    if (!token) throw new HttpError(400, 'Нет SSO-токена', 'bad_token');
    let claims;
    try {
      claims = verifyReportingSsoToken(token, secret);
    } catch (error) {
      throw new HttpError(401, error instanceof Error ? error.message : 'Некорректный SSO-токен', 'invalid_sso');
    }
    const email = normalizeEmail(claims.email);
    if (!validEmail(email)) throw new HttpError(400, 'Проверьте email', 'bad_email');
    const name = (claims.name ?? '').trim().slice(0, 80);
    const reportingAdmin = Boolean(claims.admin);
    const index = await this.emailIndex();
    const existingId = await this.userIdByEmail(email);
    let user = existingId ? await this.users.get(existingId) : null;
    if (!user) {
      user = {
        id: newId('u'),
        email,
        name,
        password: SSO_PASSWORD_MARKER,
        createdAt: Date.now(),
        verified: true,
        consent: { at: Date.now(), edition: CONSENT_EDITION },
        reportingAdmin,
      };
      index.set(email, user.id);
      try {
        await this.users.put(user.id, user);
      } catch (error) {
        // Unique email index (PG): concurrent first SSO — reload winner.
        const raced = await this.userIdByEmail(email);
        const existing = raced ? await this.users.get(raced) : null;
        if (!existing) throw error;
        user = existing;
      }
    }
    {
      const nextName = name || user.name;
      const updated = await this.users.update(user.id, (cur) =>
        cur
          ? {
              ...cur,
              name: nextName,
              verified: true,
              reportingAdmin,
              // Keep SSO marker for accounts created via reporting; leave real passwords alone.
              password: isSsoUserPassword(cur.password) || !cur.password ? SSO_PASSWORD_MARKER : cur.password,
              consent: cur.consent ?? { at: Date.now(), edition: CONSENT_EDITION },
            }
          : undefined,
      );
      user = updated ?? user;
    }
    this.loginByEmail.reset(email);
    await this.startSession(c, user);
    return { user: publicUser(user) };
  }

  private async register(c: Ctx): Promise<unknown> {
    this.refusePasswordAuth();
    if (!this.registerByIp.allow(c.ip)) throw new HttpError(429, 'Слишком много регистраций с этого адреса. Попробуйте позже.', 'rate_limited');
    const body = await readJson<{ email?: unknown; password?: unknown; name?: unknown; consent?: unknown }>(c.req);
    const email = normalizeEmail(String(body.email ?? ''));
    const password = String(body.password ?? '');
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!validEmail(email)) throw new HttpError(400, 'Проверьте email', 'bad_email');
    const problem = passwordProblem(password);
    if (problem) throw new HttpError(400, problem, 'bad_password');
    // The name is optional (less personal data): without it others see the email address.
    if (body.consent !== true) throw new HttpError(400, 'Отметьте согласие на обработку персональных данных', 'no_consent');
    const consent = { at: Date.now(), edition: CONSENT_EDITION };
    const index = await this.emailIndex();
    const existingId = index.get(email);
    const existing = existingId ? await this.users.get(existingId) : null;
    // An unconfirmed account can be registered again: whoever gets the letter owns the address.
    if (existing && existing.verified !== false) throw new HttpError(409, 'Такой email уже зарегистрирован. Войдите.', 'exists');
    if (!existing && !this.options.openRegistration && index.size > 0) throw new HttpError(403, 'Регистрация закрыта. Попросите приглашение у владельца.', 'closed');
    if (!this.verifyMailByEmail.allow(email)) throw new HttpError(429, 'Слишком много писем на этот адрес. Попробуйте через час.', 'rate_limited');
    const hash = await hashPassword(password);
    if (existing) {
      const user = await this.users.update(existing.id, (cur) => (cur && cur.verified === false ? { ...cur, name, password: hash, consent } : undefined));
      if (!user || user.verified !== false) throw new HttpError(409, 'Такой email уже зарегистрирован. Войдите.', 'exists');
      await this.sendCode(user, 'verify');
      return { pending: true, email };
    }
    const user: User = { id: newId('u'), email, name, password: hash, createdAt: Date.now(), verified: false, consent };
    // Re-check after the slow hash: two requests for one email must not both succeed.
    if (index.has(email)) throw new HttpError(409, 'Такой email уже регистрируется. Проверьте почту.', 'exists');
    index.set(email, user.id);
    try {
      await this.users.put(user.id, user);
      await this.sendCode(user, 'verify');
    } catch (error) {
      // No letter — no account: the address stays free to try again.
      index.delete(email);
      await this.users.delete(user.id).catch(() => undefined);
      throw error;
    }
    return { pending: true, email };
  }

  /**
   * What deleting an account does, worked out once for the preview and the deletion itself:
   * the person's own files go; files in a team project stay with the team (its owner gets
   * them); a team they own passes to the senior member, or goes if nobody else is in it.
   */
  private async deletionPlan(user: User) {
    const teams = await this.teams.all();
    const projects = await this.projects.all();
    const files = await this.files.all();
    const teamOfProject = new Map(projects.filter((p) => p.teamId).map((p) => [p.id, p.teamId!]));
    const heirs = new Map<string, string>();
    const gone = new Set<string>();
    for (const t of teams) {
      if (t.ownerId !== user.id) continue;
      // The highest role, and among equals whoever joined first.
      const heir = t.members
        .filter((m) => m.userId !== user.id)
        .sort((a, b) => TEAM_ROLES.indexOf(b.role) - TEAM_ROLES.indexOf(a.role) || a.addedAt - b.addedAt)[0];
      if (heir) heirs.set(t.id, heir.userId);
      else gone.add(t.id);
    }
    const kept: { file: FileMeta; to: string }[] = [];
    const removed: FileMeta[] = [];
    for (const f of files) {
      if (f.ownerId !== user.id) continue;
      const teamId = f.projectId ? teamOfProject.get(f.projectId) : undefined;
      const team = teamId && !gone.has(teamId) ? teams.find((t) => t.id === teamId) : undefined;
      const to = team ? (heirs.get(team.id) ?? team.ownerId) : null;
      if (to && to !== user.id) kept.push({ file: f, to });
      else removed.push(f);
    }
    return { teams, projects, files, heirs, gone, kept, removed };
  }

  /** The name others see; empty — they see the email address. */
  private async renameMe(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const body = await readJson<{ name?: unknown }>(c.req);
    const name = String(body.name ?? '').trim().slice(0, 80);
    const saved = await this.users.update(user.id, (cur) => (cur ? { ...cur, name } : undefined));
    return { user: publicUser(saved ?? { ...user, name }) };
  }

  private async deletionPreview(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const plan = await this.deletionPlan(user);
    const nameOf = async (id: string) => {
      const u = await this.users.get(id);
      return u?.name || u?.email || '';
    };
    const handedOver = [];
    for (const [teamId, heir] of plan.heirs) handedOver.push({ team: plan.teams.find((t) => t.id === teamId)!.name, to: await nameOf(heir) });
    return {
      files: plan.removed.length,
      shared: plan.removed.filter((f) => (f.members?.length ?? 0) > 0 || isOpenLink(f.link)).length,
      keptInTeams: plan.kept.length,
      teamsHandedOver: handedOver,
      teamsDeleted: plan.teams.filter((t) => plan.gone.has(t.id)).map((t) => t.name),
    };
  }

  /** Deletes the account and everything that is only theirs, by the plan above; the password confirms it. */
  private async deleteAccount(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    if (this.options.reportingAuthOnly || isSsoUserPassword(user.password)) {
      throw new HttpError(403, 'Удаление аккаунта через reporting. Отдельный пароль не используется.', 'reporting_auth');
    }
    const body = await readJson<{ password?: unknown }>(c.req);
    if (!this.loginByIp.allow(c.ip)) throw new HttpError(429, 'Слишком много попыток. Подождите несколько минут.', 'rate_limited');
    if (!(await verifyPassword(String(body.password ?? ''), user.password))) throw new HttpError(403, 'Неверный пароль', 'bad_password');
    const plan = await this.deletionPlan(user);
    const now = Date.now();
    for (const t of plan.teams) {
      if (plan.gone.has(t.id)) {
        // As when the owner deletes the team: the files of others go to their Drafts.
        for (const p of plan.projects.filter((p) => p.teamId === t.id)) {
          await this.emptyProject(p.id);
          await this.projects.delete(p.id);
        }
        await this.teams.delete(t.id);
        continue;
      }
      const heir = plan.heirs.get(t.id);
      const inTeam = heir || t.members.some((m) => m.userId === user.id) || t.invites.some((i) => i.email === user.email);
      if (!inTeam) continue;
      await this.teams.update(t.id, (cur) =>
        cur
          ? {
              ...cur,
              ownerId: heir ?? cur.ownerId,
              members: cur.members.filter((m) => m.userId !== user.id && m.userId !== heir),
              invites: cur.invites.filter((i) => i.email !== user.email),
              updatedAt: now,
            }
          : undefined,
      );
      await this.teamAccessChanged(t.id);
    }
    for (const { file, to } of plan.kept) {
      await this.files.update(file.id, (cur) => (cur ? { ...cur, ownerId: to, members: (cur.members ?? []).filter((m) => m.userId !== to) } : undefined));
      await this.live?.accessChanged(file.id);
    }
    for (const f of plan.removed) {
      await this.live?.deleted(f.id);
      await this.files.delete(f.id);
      await this.blobs.remove(f.id);
    }
    for (const f of plan.files) {
      if (f.ownerId === user.id) continue;
      if (!f.members?.some((m) => m.userId === user.id) && !f.invites?.some((i) => i.email === user.email)) continue;
      await this.files.update(f.id, (cur) => (cur ? { ...cur, members: (cur.members ?? []).filter((m) => m.userId !== user.id), invites: (cur.invites ?? []).filter((i) => i.email !== user.email) } : undefined));
      await this.live?.accessChanged(f.id);
    }
    for (const p of plan.projects) {
      if (p.ownerId !== user.id || p.teamId) continue;
      await this.emptyProject(p.id);
      await this.projects.delete(p.id);
    }
    for (const id of await this.sessions.ids()) if ((await this.sessions.get(id))?.userId === user.id) await this.sessions.delete(id);
    await this.live?.signedOut({ userId: user.id });
    for (const purpose of ['verify', 'reset']) await this.codes.delete(`${purpose}_${user.id}`);
    await this.users.delete(user.id);
    (await this.emailIndex()).delete(user.email);
    this.setSession(c, null);
    this.options.log?.(`аккаунт ${user.id} удалён: файлов удалено ${plan.removed.length}, оставлено командам ${plan.kept.length}`);
    return { ok: true };
  }

  /** Mails a fresh one-time code; the previous one stops working. */
  private async sendCode(user: User, purpose: CodePurpose): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const key = `${purpose}_${user.id}`;
    await this.codes.put(key, { codeHash: tokenHash(`${key}:${code}`), expiresAt: Date.now() + CODE_MINUTES * 60_000, attempts: 0 });
    try {
      await this.options.mailer(codeLetter({ to: user.email, name: user.name, code, purpose, appUrl: this.options.appUrl }));
    } catch (error) {
      await this.codes.delete(key);
      this.options.log?.(`письмо для ${user.email} не отправлено: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError(502, 'Не получилось отправить письмо. Попробуйте позже.', 'mail_failed');
    }
  }

  /** Checks a code from a letter; wrong guesses are counted and burn the code after a few. */
  private async checkCode(userId: string, purpose: CodePurpose, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const key = `${purpose}_${userId}`;
    let ok = false;
    await this.codes.update(key, (cur) => {
      if (!cur || cur.expiresAt < Date.now() || cur.attempts >= CODE_ATTEMPTS) return undefined;
      ok = cur.codeHash === tokenHash(`${key}:${code}`);
      return ok ? undefined : { ...cur, attempts: cur.attempts + 1 };
    });
    if (ok) await this.codes.delete(key);
    return ok;
  }

  /** Confirms the email with the code from the welcome letter and signs in. */
  private async verify(c: Ctx): Promise<unknown> {
    this.refusePasswordAuth();
    const body = await readJson<{ email?: unknown; code?: unknown }>(c.req);
    const email = normalizeEmail(String(body.email ?? ''));
    const code = String(body.code ?? '').replace(/\s+/g, '');
    if (!this.verifyByIp.allow(c.ip)) throw new HttpError(429, 'Слишком много попыток. Подождите несколько минут.', 'rate_limited');
    const id = (await this.emailIndex()).get(email);
    const wrong = new HttpError(400, 'Неверный или устаревший код', 'bad_code');
    if (!id || !(await this.checkCode(id, 'verify', code))) throw wrong;
    const user = await this.users.update(id, (cur) => (cur ? { ...cur, verified: true } : undefined));
    if (!user) throw wrong;
    await this.startSession(c, user);
    return { user: publicUser(user) };
  }

  /** Sends the welcome code again. Same answer for unknown or confirmed addresses. */
  private async resend(c: Ctx): Promise<unknown> {
    this.refusePasswordAuth();
    const body = await readJson<{ email?: unknown }>(c.req);
    const email = normalizeEmail(String(body.email ?? ''));
    if (!validEmail(email)) throw new HttpError(400, 'Проверьте email', 'bad_email');
    if (!this.forgotByIp.allow(c.ip) || !this.verifyMailByEmail.allow(email)) {
      throw new HttpError(429, 'Код уже отправлен. Новый можно запросить позже — проверьте почту и папку «Спам».', 'rate_limited');
    }
    const id = (await this.emailIndex()).get(email);
    const user = id ? await this.users.get(id) : null;
    if (user && user.verified === false) await this.sendCode(user, 'verify');
    return { ok: true };
  }

  private async login(c: Ctx): Promise<unknown> {
    this.refusePasswordAuth();
    const body = await readJson<{ email?: unknown; password?: unknown }>(c.req);
    const email = normalizeEmail(String(body.email ?? ''));
    const password = String(body.password ?? '');
    if (!this.loginByIp.allow(c.ip) || !this.loginByEmail.allow(email)) {
      throw new HttpError(429, 'Слишком много попыток входа. Подождите несколько минут.', 'rate_limited');
    }
    const id = (await this.emailIndex()).get(email);
    const user = id ? await this.users.get(id) : null;
    if (user && isSsoUserPassword(user.password)) {
      throw new HttpError(403, 'Этот аккаунт входит только через reporting', 'reporting_auth');
    }
    // The same work whether or not the account exists: timing reveals nothing.
    const ok = await verifyPassword(password, user?.password ?? (await dummyPasswordHash()));
    if (!user || !ok) throw new HttpError(401, 'Неверный email или пароль', 'bad_credentials');
    this.loginByEmail.reset(email);
    if (user.verified === false) {
      // The password is right but the address is not confirmed yet: send a fresh code (if not too often).
      let sent = false;
      if (this.verifyMailByEmail.allow(email)) sent = await this.sendCode(user, 'verify').then(() => true, () => false);
      throw new HttpError(403, sent ? `Сначала подтвердите почту: код отправлен на ${user.email}` : `Сначала подтвердите почту: введите код из письма, отправленного на ${user.email}`, 'unverified');
    }
    await this.startSession(c, user);
    return { user: publicUser(user) };
  }

  /** Interface settings follow the account: `{prefs: {key: value | null}}`. */
  private async savePrefs(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    // Own «Контент» sets and board templates make the settings longer than the usual 64 KB of a request.
    const body = await readJson<{ prefs?: unknown }>(c.req, 512 * 1024);
    if (!mergePrefs(user.prefs, body.prefs)) throw new HttpError(400, 'Неизвестная настройка', 'bad_prefs');
    const saved = await this.users.update(user.id, (cur) => (cur ? { ...cur, prefs: mergePrefs(cur.prefs, body.prefs) ?? cur.prefs } : undefined));
    return { prefs: saved?.prefs ?? {} };
  }

  private async logout(c: Ctx): Promise<unknown> {
    const token = parseCookies(c.req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      await this.sessions.delete(tokenHash(token));
      // Files open in other tabs of this session close too (BUG-162).
      await this.live?.signedOut({ session: tokenHash(token) });
    }
    this.setSession(c, null);
    return { ok: true };
  }

  /**
   * Sends a one-time code to the account's email. The answer is the same
   * whether or not the account exists, so it does not reveal who is registered.
   */
  private async forgot(c: Ctx): Promise<unknown> {
    this.refusePasswordAuth();
    const body = await readJson<{ email?: unknown }>(c.req);
    const email = normalizeEmail(String(body.email ?? ''));
    if (!validEmail(email)) throw new HttpError(400, 'Проверьте email', 'bad_email');
    if (!this.forgotByIp.allow(c.ip) || !this.forgotByEmail.allow(email)) {
      throw new HttpError(429, 'Код уже отправлен. Новый можно запросить позже — проверьте почту и папку «Спам».', 'rate_limited');
    }
    const id = (await this.emailIndex()).get(email);
    const user = id ? await this.users.get(id) : null;
    if (user) await this.sendCode(user, 'reset');
    return { ok: true };
  }

  /** Sets a new password by the code from the letter, ends every other session and signs in. */
  private async reset(c: Ctx): Promise<unknown> {
    this.refusePasswordAuth();
    const body = await readJson<{ email?: unknown; code?: unknown; password?: unknown }>(c.req);
    const email = normalizeEmail(String(body.email ?? ''));
    const code = String(body.code ?? '').replace(/\s+/g, '');
    const password = String(body.password ?? '');
    if (!this.resetByIp.allow(c.ip)) throw new HttpError(429, 'Слишком много попыток. Подождите несколько минут.', 'rate_limited');
    const problem = passwordProblem(password);
    if (problem) throw new HttpError(400, problem, 'bad_password');
    const id = (await this.emailIndex()).get(email);
    const wrong = new HttpError(400, 'Неверный или устаревший код', 'bad_code');
    if (!id || !(await this.checkCode(id, 'reset', code))) throw wrong;
    const hash = await hashPassword(password);
    // The code came by mail, so the address is confirmed too.
    const user = await this.users.update(id, (cur) => (cur ? { ...cur, password: hash, verified: true } : undefined));
    if (!user) throw wrong;
    for (const key of await this.sessions.ids()) {
      const s = await this.sessions.get(key);
      if (s?.userId === id) await this.sessions.delete(key);
    }
    // Whoever knew the old password is out of the open files too.
    await this.live?.signedOut({ userId: id });
    this.loginByEmail.reset(email);
    await this.startSession(c, user);
    return { user: publicUser(user) };
  }

  /** The signed-in user, or null. Expired sessions are removed. */
  async userOf(req: IncomingMessage): Promise<User | null> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const key = tokenHash(token);
    const session = await this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      await this.sessions.delete(key);
      return null;
    }
    const user = await this.users.get(session.userId);
    return user && user.verified !== false ? user : null;
  }

  /** Сотрудники reporting по фамилии или почте — для приглашения в файл. */
  async directory(c: Ctx): Promise<{ people: { name: string; email: string }[] }> {
    await this.requireUser(c);
    const q = c.url.searchParams.get('q') ?? '';
    if (!this.colleagues) return { people: [] };
    return { people: await this.colleagues(q) };
  }

  async requireUser(c: Ctx): Promise<User> {
    const user = await this.userOf(c.req);
    if (!user) throw new HttpError(401, 'Нужно войти', 'unauthorized');
    return user;
  }

  // ---------- files ----------

  /** Key for link password proofs; made once (PostgreSQL or data directory). */
  private secretKey(): Promise<Uint8Array> {
    this.secret ??= (async () => {
      if (this.secretLoader) return this.secretLoader();
      const path = `${this.options.dataDir}/secret`;
      try {
        const key = await readFile(path);
        if (key.length >= 32) return key;
      } catch {
        // first start: make one
      }
      await mkdir(this.options.dataDir, { recursive: true });
      const key = randomBytes(32);
      await writeAtomic(path, key);
      return key;
    })();
    return this.secret;
  }

  /**
   * The file of the request and what the visitor may do with it: as the owner,
   * a member, or through the share link (X-CS-Link header). Someone with no
   * access gets "not found" — exactly as for a file that does not exist.
   */
  private access(c: Ctx, needed: Role = 'viewer'): Promise<{ meta: FileMeta; user: User | null; role: Role }> {
    return this.accessTo(c.req, c.params.id!, needed, c.req.headers['x-cs-link']);
  }

  /** The same check for a request without a route (the live connection passes the link in its address). */
  async accessTo(req: IncomingMessage, id: string, needed: Role, linkValue: string | string[] | undefined): Promise<{ meta: FileMeta; user: User | null; role: Role }> {
    let meta = isSafeId(id) ? await this.files.get(id) : null;
    if (!meta) throw new HttpError(404, 'Файл не найден', 'not_found');
    const user = await this.userOf(req);
    // An invitation sent before this person had an account becomes membership now.
    if (user && liveInvites(meta).some((i) => i.email === user.email)) {
      meta = (await this.files.update(meta.id, (cur) => (cur ? (claimInvites(cur, user) ?? undefined) : undefined))) ?? meta;
    }
    const linkTeam = user && meta.link?.mode === 'team' && meta.link.teamId ? await this.teams.get(meta.link.teamId) : null;
    const inTeam = () => !!linkTeam && teamRole(linkTeam, user!.id) !== null;
    const byLink = linkRole(meta, parseLinkHeader(linkValue), { signedIn: user !== null, inTeam, board: meta.kind === 'board' }, await this.secretKey(), meta.id);
    const team = await this.teamOfFile(meta);
    let role = withTeam(higher(memberRole(meta, user?.id ?? null), byLink === 'password' ? null : byLink), team && teamRole(team, user?.id ?? null), meta.restricted);
    // A branch is open to whoever has the main file, with the same role (its author owns it).
    if (meta.branch) {
      const main = await this.accessTo(req, meta.branch.of, 'viewer', undefined).catch(() => null);
      role = higher(memberRole(meta, user?.id ?? null), main?.role ?? null);
      // Someone asked to review the branch can comment in it, whatever their role in the main file.
      if (role && user && meta.branch.review?.reviewers.some((r) => r.id === user.id)) role = higher(role, 'commenter');
    }
    if (!role) {
      if (byLink === 'password') throw new HttpError(401, 'Файл защищён паролем', 'link_password');
      // The right team link, but the visitor is not (known to be) in the team: say so — they hold the link already.
      if (meta.link?.mode === 'team' && linkRole(meta, parseLinkHeader(linkValue), { signedIn: true, inTeam: () => true }, await this.secretKey(), meta.id) !== null) {
        if (!user) throw new HttpError(401, 'Ссылка открывает файл только людям из команды. Войдите, чтобы открыть его.', 'unauthorized');
        throw new HttpError(403, 'Ссылка открывает файл только людям из команды, а вы в неё не входите. Попросите владельца пригласить вас.', 'forbidden');
      }
      throw new HttpError(404, 'Файл не найден', 'not_found');
    }
    if (!atLeast(role, needed)) {
      if (!user) throw new HttpError(401, needed === 'commenter' ? 'Войдите, чтобы комментировать' : 'Войдите, чтобы редактировать', 'unauthorized');
      throw new HttpError(403, needed === 'owner' ? 'Это может сделать только владелец файла' : 'У вас доступ только на просмотр', 'forbidden');
    }
    return { meta, user, role };
  }

  /** A file record as a visitor sees it: no tokens, hashes or member lists. */
  private publicFile(meta: FileMeta, role: Role, ownerName?: string, inTeam = false): Record<string, unknown> {
    const shared = (meta.members?.length ?? 0) > 0 || liveInvites(meta).length > 0 || isOpenLink(meta.link);
    return {
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      version: meta.version,
      ...(meta.thumbAt ? { thumbAt: meta.thumbAt } : {}),
      role,
      shared,
      // Own projects are the owner's folders: others do not see where the file sits (the team sees its projects).
      ...(role === 'owner' || inTeam ? { projectId: meta.projectId ?? null } : {}),
      ...(meta.restricted ? { restricted: true } : {}),
      ...(meta.kind ? { kind: meta.kind } : {}),
      ...(ownerName !== undefined ? { ownerName } : {}),
      ...(meta.library ? { library: { publishedAt: meta.library.publishedAt, components: meta.library.components } } : {}),
    };
  }

  private async listFiles(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const out: Record<string, unknown>[] = [];
    const names = new Map<string, string>();
    const ownerName = async (id: string) => {
      if (!names.has(id)) {
        const u = await this.users.get(id);
        names.set(id, u?.name || u?.email || '');
      }
      return names.get(id)!;
    };
    const visible = await this.visibleFiles(user);
    const index = await this.indexOfFiles();
    for (const { meta: f, role, inTeam } of visible) {
      // Branches are reached from their main file, not from the list.
      if (f.branch) continue;
      const file = this.publicFile(f, role, f.ownerId === user.id ? undefined : await ownerName(f.ownerId), inTeam);
      const open = (await this.metas(index.branchesOf(f.id))).filter((b) => !b.branch?.merged).length;
      if (open) file.branches = open;
      out.push(file);
    }
    out.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
    return { files: out };
  }

  /**
   * Every file the person has: their own, shared with them, and the files of
   * their teams' projects — each with the role it gives. Invitations to the
   * person's address (files and teams) are taken up on the way.
   */
  private async visibleFiles(user: User): Promise<{ meta: FileMeta; role: Role; inTeam: boolean }[]> {
    const roles = await this.myTeamRoles(user);
    const teamOfProject = new Map<string, string>();
    for (const p of await this.projects.all()) if (p.teamId && roles.has(p.teamId)) teamOfProject.set(p.id, p.teamId);
    const out: { meta: FileMeta; role: Role; inTeam: boolean }[] = [];
    // Only the files this person may have: theirs, shared with them or their address, and their teams' (PERF-006).
    const index = await this.indexOfFiles();
    const candidates = new Set([...index.forPerson(user.id, user.email), ...index.inProjects(teamOfProject.keys())]);
    for (let f of await this.metas(candidates)) {
      if (liveInvites(f).some((i) => i.email === user.email)) f = (await this.files.update(f.id, (cur) => (cur ? (claimInvites(cur, user) ?? undefined) : undefined))) ?? f;
      const teamId = f.projectId ? teamOfProject.get(f.projectId) : undefined;
      const role = withTeam(memberRole(f, user.id), teamId ? roles.get(teamId)! : null, f.restricted);
      if (role) out.push({ meta: f, role, inTeam: teamId !== undefined });
    }
    return out;
  }

  private async getFile(c: Ctx): Promise<unknown> {
    const { meta, user, role } = await this.access(c);
    const snapshot = await this.documents.read(meta.id);
    const owner = meta.ownerId === user?.id ? user : await this.users.get(meta.ownerId);
    const team = await this.teamOfFile(meta);
    const inTeam = !!team && teamRole(team, user?.id ?? null) !== null;
    const branch = meta.branch ? await this.branchView(meta) : null;
    const head = { file: this.publicFile(meta, role, this.shownName(owner, await this.isInsider(meta, user?.id)), inTeam), role, signedIn: user !== null, ...(inTeam ? { team: { id: team.id, name: team.name } } : {}), ...(branch ? { branch } : {}) };
    // `?format=lines` (PERF-004): the record on the first line, the document as it is on the second —
    // a heavy file is neither escaped into a JSON string here nor parsed twice in the browser.
    if (c.url.searchParams.get('format') === 'lines') {
      const text = snapshot === null ? JSON.stringify(head) : `${JSON.stringify(head)}\n${snapshot}`;
      c.res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
      c.res.end(text);
      return undefined;
    }
    return { ...head, snapshot };
  }

  /**
   * Creates or saves a file. The client names new files (so work started
   * offline keeps its id); `baseVersion` must match the stored version, or
   * the save is refused as a conflict. Saving someone else's file needs the
   * editor role.
   */
  private async putFile(c: Ctx): Promise<unknown> {
    const id = c.params.id!;
    if (!isSafeId(id)) throw new HttpError(400, 'Недопустимый идентификатор файла', 'bad_id');
    const existing = await this.files.get(id);
    const { user, role } = existing ? await this.access(c, 'editor') : { user: await this.requireUser(c), role: 'owner' as Role };
    if (!user) throw new HttpError(401, 'Нужно войти', 'unauthorized');
    // People are editing it together right now: a whole-file save would overwrite their work.
    if (existing && (await this.live?.isLive(id))) throw new HttpError(409, 'Файл сейчас редактируют вместе — обновите страницу, чтобы подключиться', 'conflict');
    const type = String(c.req.headers['content-type'] ?? '');
    if (!type.startsWith('application/json')) throw new HttpError(415, 'Ожидался JSON', 'bad_type');
    const raw = (await readBody(c.req, MAX_DOCUMENT)).toString('utf8');
    let body: { name?: unknown; snapshot?: unknown; baseVersion?: unknown; projectId?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new HttpError(400, 'Неверный JSON', 'bad_json');
    }
    if (typeof body.snapshot !== 'string') throw new HttpError(400, 'Нет содержимого файла', 'bad_snapshot');
    try {
      const parsed = JSON.parse(body.snapshot) as { nodes?: unknown };
      if (!parsed || !Array.isArray(parsed.nodes)) throw new Error('no nodes');
    } catch {
      throw new HttpError(400, 'Повреждённое содержимое файла', 'bad_snapshot');
    }
    const name = String(body.name ?? 'Без названия').trim().slice(0, 200) || 'Без названия';
    const base = typeof body.baseVersion === 'number' ? body.baseVersion : null;
    // A new file may be created right in a project (an existing one keeps its place).
    const projectId = !existing && typeof body.projectId === 'string' ? (await this.projectForFiles(body.projectId, user, user.id)).id : null;
    const now = Date.now();
    let conflict: FileMeta | null = null;
    let taken = false;
    const meta = await this.files.update(id, (current) => {
      // Created by someone else between the check and now.
      if (current && !existing) {
        taken = true;
        return undefined;
      }
      if (current && base !== null && base !== current.version) {
        conflict = current;
        return undefined;
      }
      const kind = snapshotKind(body.snapshot as string);
      return current ? { ...current, name, updatedAt: now, version: current.version + 1, ...(kind ? { kind } : {}) } : { id, name, ownerId: user.id, createdAt: now, updatedAt: now, version: 1, projectId, ...(kind ? { kind } : {}) };
    });
    if (taken || !meta) throw new HttpError(404, 'Файл не найден', 'not_found');
    if (conflict) throw new HttpError(409, 'Файл изменён в другом окне или на другом устройстве', 'conflict');
    await this.documents.write(id, body.snapshot);
    // Saves without a live connection make versions too (the first one is the file as created).
    await this.versions.add(id, body.snapshot, { authors: [user.id] }).catch(() => null);
    return { file: this.publicFile(meta, role) };
  }

  // ---------- branches (FR-BR-001, 002, 005) ----------

  /** The file as it is this moment: what its live room holds is written first (a merge reads both sides). */
  private async freshFile(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c);
    await this.live?.flush(meta.id);
    const snapshot = await this.documents.read(meta.id);
    if (!snapshot) throw new HttpError(404, 'Файл не найден', 'not_found');
    return { snapshot };
  }

  private async branchView(meta: FileMeta): Promise<Record<string, unknown>> {
    const b = meta.branch!;
    const main = await this.files.get(b.of);
    const author = await this.users.get(meta.ownerId);
    return {
      of: b.of,
      mainName: main?.name ?? '',
      description: b.description ?? '',
      author: author?.name || author?.email || '',
      ...(b.merged ? { merged: { at: b.merged.at, before: b.merged.before, after: b.merged.after } } : {}),
      ...(b.review ? { review: await this.reviewView(b.review) } : {}),
    };
  }

  private async reviewView(r: BranchReview): Promise<Record<string, unknown>> {
    const name = async (id: string) => {
      const u = await this.users.get(id);
      return u?.name || u?.email || '';
    };
    return {
      by: r.by,
      byName: await name(r.by),
      at: r.at,
      description: r.description,
      reviewers: await Promise.all(r.reviewers.map(async (x) => ({ id: x.id, name: await name(x.id), ...(x.verdict ? { verdict: x.verdict, at: x.at, note: x.note ?? '' } : {}) }))),
    };
  }

  private branchUrl(id: string): string {
    return this.shareUrl(id);
  }

  /** Ссылка на файл: вкладка Симметрики на сайте reporting, иначе прямой адрес canvas. */
  private shareUrl(id: string, extra: Record<string, string> = {}): string {
    const reporting = (this.options.publicUrl ?? '').trim().replace(/\/+$/, '');
    if (reporting) {
      const url = new URL(reporting.includes('://') ? reporting : `http://${reporting}`);
      url.searchParams.set('sheet', 'canvas-studio');
      url.searchParams.set('file', id);
      for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
      return url.toString();
    }
    const base = (this.options.appUrl ?? '').replace(/\/+$/, '');
    const params = new URLSearchParams({ file: id, ...extra });
    return `${base}/?${params.toString()}`;
  }

  /** Asks people of the main file to look at the branch; a letter goes to each (a new request replaces the old one). */
  private async requestReview(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    if (!meta.branch) throw new HttpError(404, 'Это не ветка', 'not_found');
    if (meta.branch.merged) throw new HttpError(400, 'Ветка уже слита', 'merged');
    const body = await readJson<{ reviewers?: unknown; description?: unknown }>(c.req);
    const people = await this.people(meta);
    const ids = [...new Set(Array.isArray(body.reviewers) ? body.reviewers.map(String) : [])].filter((id) => id !== user!.id);
    if (!ids.length) throw new HttpError(400, 'Выберите, кто посмотрит ветку', 'no_reviewers');
    if (ids.length > 20) throw new HttpError(400, 'Не больше 20 рецензентов', 'too_many');
    if (ids.some((id) => !people.has(id))) throw new HttpError(400, 'Рецензентом может быть только тот, у кого есть основной файл', 'bad_reviewer');
    const review: BranchReview = { by: user!.id, at: Date.now(), description: String(body.description ?? '').trim().slice(0, 2000), reviewers: ids.map((id) => ({ id })) };
    await this.files.update(meta.id, (cur) => (cur?.branch ? { ...cur, branch: { ...cur.branch, review } } : undefined));
    const main = await this.files.get(meta.branch.of);
    let mailFailed = false;
    for (const id of ids) {
      const to = await this.users.get(id);
      if (!to) continue;
      try {
        await this.options.mailer(reviewLetter({ to: to.email, author: user!.name || user!.email, branchName: meta.name, mainName: main?.name ?? '', description: review.description, url: this.branchUrl(meta.id), appUrl: this.options.appUrl }));
      } catch (error) {
        mailFailed = true;
        this.options.log?.(`письмо о ревью для ${to.email} не отправлено: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { review: await this.reviewView(review), ...(mailFailed ? { mailFailed: true } : {}) };
  }

  private async cancelReview(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c, 'editor');
    if (!meta.branch) throw new HttpError(404, 'Это не ветка', 'not_found');
    await this.files.update(meta.id, (cur) => {
      if (!cur?.branch) return undefined;
      const { review: _, ...rest } = cur.branch;
      return { ...cur, branch: rest };
    });
    return { ok: true };
  }

  /** A reviewer's answer: approved, or changes needed (with a note); the author gets a letter. */
  private async reviewVerdict(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c);
    const review = meta.branch?.review;
    if (!review) throw new HttpError(404, 'Ревью не запрошено', 'not_found');
    if (!review.reviewers.some((r) => r.id === user?.id)) throw new HttpError(403, 'Вас не просили посмотреть эту ветку', 'forbidden');
    const body = await readJson<{ verdict?: unknown; note?: unknown }>(c.req);
    if (body.verdict !== 'approved' && body.verdict !== 'changes') throw new HttpError(400, 'Ожидалось «одобрено» или «нужны правки»', 'bad_verdict');
    const verdict = body.verdict;
    const note = String(body.note ?? '').trim().slice(0, 2000);
    if (verdict === 'changes' && !note) throw new HttpError(400, 'Напишите, что поправить', 'no_note');
    const saved = await this.files.update(meta.id, (cur) => {
      const r = cur?.branch?.review;
      if (!cur?.branch || !r) return undefined;
      return { ...cur, branch: { ...cur.branch, review: { ...r, reviewers: r.reviewers.map((x) => (x.id === user!.id ? { id: x.id, verdict, at: Date.now(), ...(note ? { note } : {}) } : x)) } } };
    });
    const author = await this.users.get(review.by);
    if (author && author.id !== user!.id) {
      await this.options
        .mailer(verdictLetter({ to: author.email, reviewer: user!.name || user!.email, branchName: meta.name, approved: verdict === 'approved', note, url: this.branchUrl(meta.id), appUrl: this.options.appUrl }))
        .catch((error: unknown) => this.options.log?.(`письмо о решении по ревью не отправлено: ${error instanceof Error ? error.message : String(error)}`));
    }
    return { review: saved?.branch?.review ? await this.reviewView(saved.branch.review) : null };
  }

  /** At a merge: the branch's discussions go to the main file too (FR-BR-002); the layers have the same ids there. */
  private async carryComments(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c, 'editor');
    const branchId = c.params.branchId!;
    const branch = isSafeId(branchId) ? await this.files.get(branchId) : null;
    if (!branch?.branch || branch.branch.of !== meta.id) throw new HttpError(404, 'Ветка не найдена', 'not_found');
    const threads = parseThreads(await this.blobs.read(branch.id, 'comments.json'));
    if (!threads.length) return { carried: 0 };
    const copies = threads.map((t) => ({ ...structuredClone(t), id: newId('t') }));
    await this.blobs.update(meta.id, 'comments.json', (text) => JSON.stringify([...parseThreads(text), ...copies].slice(-THREADS_PER_FILE)));
    const inside = await this.authorNames(copies);
    const outside = await this.authorNames(copies, false);
    for (const t of copies) await this.live?.broadcast(meta.id, (insider) => ({ type: 'thread', thread: publicThread(t, insider ? inside : outside) }));
    return { carried: copies.length };
  }

  private async listBranches(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c);
    const out: Record<string, unknown>[] = [];
    for (const f of await this.metas((await this.indexOfFiles()).branchesOf(meta.id))) {
      if (f.branch?.of !== meta.id) continue;
      out.push({ id: f.id, name: f.name, createdAt: f.createdAt, updatedAt: f.updatedAt, ...(await this.branchView(f)) });
    }
    out.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
    return { branches: out };
  }

  /** A branch: a copy of the main file as it is now, which also remembers this state as the common ancestor. */
  private async createBranch(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    if (meta.branch) throw new HttpError(400, 'Ветку создают от основного файла, а не от другой ветки', 'branch_of_branch');
    const body = await readJson<{ name?: unknown; description?: unknown }>(c.req);
    const name = String(body.name ?? '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Укажите название ветки', 'bad_name');
    const description = String(body.description ?? '').trim().slice(0, 1000);
    await this.live?.flush(meta.id);
    const snapshot = await this.documents.read(meta.id);
    if (!snapshot) throw new HttpError(404, 'Файл не найден', 'not_found');
    const id = newId('f');
    const now = Date.now();
    // The file's name lives in its document too (saves take it from there): the branch's own.
    const copy = JSON.parse(snapshot) as { nodes: { parent: string | null; props: Record<string, unknown> }[] };
    const root = copy.nodes.find((n) => n.parent === null);
    if (root) root.props.name = name;
    await this.documents.write(id, JSON.stringify(copy));
    await this.blobs.write(id, BRANCH_BASE, withoutPictures(snapshot));
    await this.files.put(id, { id, name, ownerId: user!.id, createdAt: now, updatedAt: now, version: 1, projectId: meta.projectId ?? null, branch: { of: meta.id, ...(description ? { description } : {}) } });
    await this.versions.add(id, JSON.stringify(copy), { authors: [user!.id] }).catch(() => null);
    return { branch: { id, name } };
  }

  /** In a branch: what it is a branch of, the common ancestor, and what this person may do with the main file. */
  private async branchOf(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c);
    if (!meta.branch) throw new HttpError(404, 'Это не ветка', 'not_found');
    const main = await this.accessTo(c.req, meta.branch.of, 'viewer', undefined);
    const base = await this.blobs.read(meta.id, BRANCH_BASE);
    if (!base) throw new HttpError(500, 'Не найдено состояние, от которого создана ветка', 'no_base');
    return { branch: await this.branchView(meta), main: { id: main.meta.id, name: main.meta.name, role: main.role }, base };
  }

  /** After the branch took the main file's changes: that state of the main file is the new common ancestor. */
  private async setBranchBase(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c, 'editor');
    if (!meta.branch) throw new HttpError(404, 'Это не ветка', 'not_found');
    const body = await readJson<{ snapshot?: unknown }>(c.req, MAX_DOCUMENT);
    if (typeof body.snapshot !== 'string') throw new HttpError(400, 'Нет содержимого файла', 'bad_snapshot');
    let text: string;
    try {
      text = withoutPictures(body.snapshot);
    } catch {
      throw new HttpError(400, 'Повреждённое содержимое файла', 'bad_snapshot');
    }
    await this.blobs.write(meta.id, BRANCH_BASE, text);
    return { ok: true };
  }

  /** Marks a branch merged into its main file (with the versions before and after), or not any more (the merge undone). */
  private async branchMerged(c: Ctx, merged: boolean): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    const branchId = c.params.branchId!;
    const branch = isSafeId(branchId) ? await this.files.get(branchId) : null;
    if (!branch?.branch || branch.branch.of !== meta.id) throw new HttpError(404, 'Ветка не найдена', 'not_found');
    let mark: BranchInfo['merged'];
    if (merged) {
      const body = await readJson<{ before?: unknown; after?: unknown }>(c.req);
      const version = /^v[a-f0-9]{12}$/;
      if (typeof body.before !== 'string' || typeof body.after !== 'string' || !version.test(body.before) || !version.test(body.after)) throw new HttpError(400, 'Нет версий до и после слияния', 'bad_versions');
      mark = { at: Date.now(), by: user!.id, before: body.before, after: body.after };
    }
    await this.files.update(branch.id, (cur) => {
      if (!cur?.branch) return undefined;
      const { merged: _, ...rest } = cur.branch;
      return { ...cur, branch: mark ? { ...rest, merged: mark } : rest };
    });
    return { ok: true };
  }

  /** Merged branches older than the time to undo the merge are deleted. */
  async sweepBranches(now = Date.now()): Promise<number> {
    let n = 0;
    for (const f of await this.files.all()) {
      if (!f.branch?.merged || now - f.branch.merged.at < BRANCH_KEEP_DAYS * 86_400_000) continue;
      await this.live?.deleted(f.id);
      await this.files.delete(f.id);
      await this.blobs.remove(f.id);
      n++;
    }
    return n;
  }

  /** Renames a file (editors) and/or moves it to a project (owner; `projectId: null` — to Drafts). */
  private async patchFile(c: Ctx): Promise<unknown> {
    const body = await readJson<{ name?: unknown; projectId?: unknown }>(c.req);
    const { meta, user, role } = await this.access(c, 'projectId' in body ? 'owner' : 'editor');
    if ('projectId' in body) {
      if (meta.branch) throw new HttpError(400, 'Ветка лежит там же, где основной файл', 'branch');
      const projectId = body.projectId === null ? null : (await this.projectForFiles(String(body.projectId), user!, meta.ownerId)).id;
      // Moving is not an edit of the document: the version (and so open editors) stay as they are.
      const moved = await this.files.update(c.params.id!, (cur) => (cur ? { ...cur, projectId } : undefined));
      // In or out of a team: who may open it changes.
      await this.live?.accessChanged(c.params.id!);
      if (body.name === undefined) return { file: moved && this.publicFile(moved, role) };
    }
    const name = String(body.name ?? '').trim().slice(0, 200);
    if (!name) throw new HttpError(400, 'Укажите название', 'bad_name');
    if (await this.live?.rename(c.params.id!, name)) return { file: this.publicFile((await this.files.get(c.params.id!))!, role) };
    // The name lives in the document too: keep both in step.
    const snapshot = await this.blobs.read(c.params.id!, 'snapshot.json');
    if (snapshot) {
      const doc = JSON.parse(snapshot) as { nodes: { parent: string | null; props: { name?: string } }[] };
      const root = doc.nodes.find((n) => n.parent === null);
      if (root) root.props.name = name;
      await this.blobs.write(c.params.id!, 'snapshot.json', JSON.stringify(doc));
    }
    const renamed = await this.files.update(c.params.id!, (cur) => (cur ? { ...cur, name, updatedAt: Date.now(), version: cur.version + 1 } : undefined));
    return { file: renamed && this.publicFile(renamed, role) };
  }

  private async getThumbnail(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c);
    const bytes = await this.blobs.readBytes(meta.id, 'thumbnail');
    if (!bytes) throw new HttpError(404, 'Превью ещё нет', 'not_found');
    const kind = bytes[0] === 0x89 ? 'png' : bytes[0] === 0xff ? 'jpeg' : 'webp';
    c.res.writeHead(200, { 'Content-Type': THUMBNAIL_TYPES[kind]!, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
    c.res.end(bytes);
    return undefined;
  }

  /** Stores the preview the editor drew: `{ image: "data:image/png;base64,…" }`. */
  private async putThumbnail(c: Ctx): Promise<unknown> {
    const { meta, role } = await this.access(c, 'editor');
    const body = await readJson<{ image?: unknown }>(c.req, Math.ceil(MAX_THUMBNAIL * 1.4));
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image ?? ''));
    if (!m) throw new HttpError(400, 'Ожидалось изображение PNG, JPEG или WebP', 'bad_image');
    const bytes = Buffer.from(m[2]!, 'base64');
    const magic = { png: bytes[0] === 0x89 && bytes[1] === 0x50, jpeg: bytes[0] === 0xff && bytes[1] === 0xd8, webp: bytes.subarray(8, 12).toString('latin1') === 'WEBP' }[m[1] as 'png' | 'jpeg' | 'webp'];
    if (!magic || bytes.length > MAX_THUMBNAIL) throw new HttpError(400, 'Неверное или слишком большое изображение', 'bad_image');
    await this.blobs.write(meta.id, 'thumbnail', bytes);
    const file = await this.files.update(meta.id, (cur) => (cur ? { ...cur, thumbAt: Date.now() } : undefined));
    return { file: file && this.publicFile(file, role) };
  }

  // ---------- sharing ----------

  /** People with access, pending invitations and the link — for the "Share" dialog. */
  private async getShare(c: Ctx): Promise<unknown> {
    const { meta, user, role } = await this.access(c, 'editor');
    const person = async (id: string) => {
      const u = await this.users.get(id);
      return { id, name: u?.name ?? '', email: u?.email ?? '' };
    };
    const link = meta.link;
    const team = await this.teamOfFile(meta);
    const linkTeam = link?.mode === 'team' && link.teamId ? await this.teams.get(link.teamId) : null;
    // Teams a "team" link may be for: the file's own, or — for a file outside teams — any of the person's.
    const teams: { id: string; name: string }[] = [];
    if (team) teams.push({ id: team.id, name: team.name });
    else for (const id of (await this.myTeamRoles(user!)).keys()) {
      const t = await this.teams.get(id);
      if (t) teams.push({ id: t.id, name: t.name });
    }
    return {
      role,
      ...(team ? { team: { id: team.id, name: team.name, people: 1 + team.members.length } } : {}),
      restricted: !!(team && meta.restricted),
      teams,
      owner: await person(meta.ownerId),
      members: await Promise.all((meta.members ?? []).map(async (m) => ({ ...(await person(m.userId)), role: m.role }))),
      invites: liveInvites(meta).map((i) => ({ email: i.email, role: i.role, expiresAt: i.expiresAt })),
      link: {
        mode: link?.mode === 'team' && !linkTeam ? 'invited' : (link?.mode ?? 'invited'),
        ...(linkTeam ? { team: { id: linkTeam.id, name: linkTeam.name } } : {}),
        role: link?.role ?? 'viewer',
        token: link?.token ?? null,
        hasPassword: !!link?.passwordHash,
        expiresAt: link?.expiresAt ?? null,
        guests: !!link?.guests,
      },
    };
  }

  /**
   * Link settings: who it opens the file for, with what role, password and
   * expiry. `password: null` removes the password, a string sets it, absent —
   * keeps it. `reset: true` makes a new link (old copies stop working).
   */
  private async setLink(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    const body = await readJson<{ mode?: unknown; teamId?: unknown; role?: unknown; password?: unknown; expiresInDays?: unknown; reset?: unknown; guests?: unknown }>(c.req);
    if (body.guests !== undefined && typeof body.guests !== 'boolean') throw new HttpError(400, 'Ожидалось guests: true или false', 'bad_request');
    if (body.mode !== undefined && !(LINK_MODES as readonly unknown[]).includes(body.mode)) throw new HttpError(400, 'Неизвестный режим ссылки', 'bad_mode');
    // "Everyone in the team": the file's team; outside teams — one of the person's own.
    let teamId: string | undefined;
    if (body.mode === 'team' || (body.teamId !== undefined && (body.mode ?? meta.link?.mode) === 'team')) {
      const fileTeam = await this.teamOfFile(meta);
      const wanted = body.teamId !== undefined ? String(body.teamId) : (fileTeam?.id ?? meta.link?.teamId);
      if (fileTeam ? wanted !== fileTeam.id : !wanted || !isSafeId(wanted) || !(await this.myTeamRoles(user!)).has(wanted)) {
        throw new HttpError(400, fileTeam ? 'Ссылка файла команды — только для этой команды' : 'Выберите свою команду', 'bad_team');
      }
      teamId = wanted;
    }
    if (body.role !== undefined && !isGrantRole(body.role)) throw new HttpError(400, 'Неизвестная роль', 'bad_role');
    if (body.password !== undefined && body.password !== null && (typeof body.password !== 'string' || body.password.length < 4 || body.password.length > 200)) {
      throw new HttpError(400, 'Пароль ссылки — от 4 символов', 'bad_password');
    }
    const days = body.expiresInDays;
    if (days !== undefined && days !== null && ![1, 7, 30].includes(days as number)) throw new HttpError(400, 'Срок ссылки: 1, 7 или 30 дней, либо без срока', 'bad_expiry');
    const passwordHash = typeof body.password === 'string' ? await hashPassword(body.password) : body.password === null ? null : undefined;
    await this.files.update(c.params.id!, (cur) => {
      if (!cur) return undefined;
      const old = cur.link;
      const link = {
        mode: (body.mode as LinkMode | undefined) ?? old?.mode ?? 'invited',
        ...((teamId ?? old?.teamId) ? { teamId: teamId ?? old!.teamId } : {}),
        role: (body.role as GrantRole | undefined) ?? old?.role ?? 'viewer',
        token: old?.token && body.reset !== true ? old.token : newToken().slice(0, 32),
        passwordHash: passwordHash === undefined ? (old?.passwordHash ?? null) : passwordHash,
        expiresAt: days === undefined ? (old?.expiresAt ?? null) : days === null ? null : Date.now() + (days as number) * 86_400_000,
        // Guests may edit a board only (a design keeps a name behind every change).
        ...(cur.kind === 'board' && (body.guests ?? old?.guests) === true ? { guests: true } : {}),
      };
      return { ...cur, link };
    });
    await this.live?.accessChanged(c.params.id!);
    return this.getShare(c);
  }

  /**
   * Closes a team file to the team (`{restricted: true}`): only the people of
   * the file, team admins and the link open it. Owners and team admins decide.
   */
  private async setRestricted(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c, 'owner');
    const body = await readJson<{ restricted?: unknown }>(c.req);
    if (typeof body.restricted !== 'boolean') throw new HttpError(400, 'Ожидалось restricted: true или false', 'bad_request');
    if (!(await this.teamOfFile(meta))) throw new HttpError(400, 'Ограничить можно только файл в проекте команды', 'not_in_team');
    await this.files.update(meta.id, (cur) => {
      if (!cur) return undefined;
      const { restricted: _, ...rest } = cur;
      return body.restricted ? { ...rest, restricted: true } : rest;
    });
    await this.live?.accessChanged(meta.id);
    return this.getShare(c);
  }

  /**
   * Gives a person access by email. Someone with an account gets it at once;
   * an address without one gets an invitation for 30 days that turns into
   * access after sign-up. Both are told by letter.
   */
  private async invite(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    const body = await readJson<{ email?: unknown; role?: unknown }>(c.req);
    const email = normalizeEmail(String(body.email ?? ''));
    if (!validEmail(email)) throw new HttpError(400, 'Проверьте email', 'bad_email');
    const role = body.role ?? 'editor';
    if (!isGrantRole(role)) throw new HttpError(400, 'Неизвестная роль', 'bad_role');
    if (!this.invitesByUser.allow(user!.id)) throw new HttpError(429, 'Слишком много приглашений. Попробуйте через час.', 'rate_limited');
    const id = (await this.emailIndex()).get(email);
    const target = id ? await this.users.get(id) : null;
    if (target && target.id === meta.ownerId) throw new HttpError(400, 'Это владелец файла: у него уже есть полный доступ', 'owner');
    const now = Date.now();
    const registered = !!target && target.verified !== false;
    await this.files.update(meta.id, (cur) => {
      if (!cur) return undefined;
      if (registered) {
        const members = (cur.members ?? []).filter((m) => m.userId !== target!.id);
        members.push({ userId: target!.id, role, addedAt: now });
        return { ...cur, members };
      }
      const invites = liveInvites(cur, now).filter((i) => i.email !== email);
      invites.push({ email, role, createdAt: now, expiresAt: now + INVITE_DAYS * 86_400_000 });
      return { ...cur, invites };
    });
    await this.live?.accessChanged(meta.id);
    try {
      await this.options.mailer(
        shareLetter({ to: email, inviter: user!.name || user!.email, fileName: meta.name, role, url: this.shareUrl(meta.id), needsAccount: !registered, appUrl: this.options.publicUrl || this.options.appUrl }),
      );
    } catch (error) {
      // Access is given anyway: the letter is a courtesy, the link can be sent by hand.
      this.options.log?.(`приглашение для ${email} не отправлено: ${error instanceof Error ? error.message : String(error)}`);
      return { ...(await this.getShare(c) as object), mailFailed: true };
    }
    return this.getShare(c);
  }

  private async setMemberRole(c: Ctx): Promise<unknown> {
    await this.access(c, 'editor');
    const body = await readJson<{ role?: unknown }>(c.req);
    if (!isGrantRole(body.role)) throw new HttpError(400, 'Неизвестная роль', 'bad_role');
    const role = body.role;
    const userId = c.params.userId!;
    let found = false;
    await this.files.update(c.params.id!, (cur) => {
      if (!cur?.members?.some((m) => m.userId === userId)) return undefined;
      found = true;
      return { ...cur, members: cur.members.map((m) => (m.userId === userId ? { ...m, role } : m)) };
    });
    if (!found) throw new HttpError(404, 'Участник не найден', 'not_found');
    await this.live?.accessChanged(c.params.id!);
    return this.getShare(c);
  }

  /** Takes access away; anyone may also leave a file shared with them. */
  private async removeMember(c: Ctx): Promise<unknown> {
    const userId = c.params.userId!;
    const self = (await this.userOf(c.req))?.id === userId;
    await this.access(c, self ? 'viewer' : 'editor');
    await this.files.update(c.params.id!, (cur) => (cur ? { ...cur, members: (cur.members ?? []).filter((m) => m.userId !== userId) } : undefined));
    await this.live?.accessChanged(c.params.id!);
    return self ? { ok: true } : this.getShare(c);
  }

  private async removeInvite(c: Ctx): Promise<unknown> {
    await this.access(c, 'editor');
    const email = normalizeEmail(c.url.searchParams.get('email') ?? '');
    await this.files.update(c.params.id!, (cur) => (cur ? { ...cur, invites: (cur.invites ?? []).filter((i) => i.email !== email) } : undefined));
    return this.getShare(c);
  }

  /** Checks the password of a share link; returns the proof to send with later requests. */
  private async unlockLink(c: Ctx): Promise<unknown> {
    if (!this.unlockByIp.allow(c.ip)) throw new HttpError(429, 'Слишком много попыток. Подождите несколько минут.', 'rate_limited');
    const body = await readJson<{ token?: unknown; password?: unknown }>(c.req);
    const id = c.params.id!;
    const meta = isSafeId(id) ? await this.files.get(id) : null;
    const link = meta?.link;
    const presented = parseLinkHeader(String(body.token ?? ''));
    const wrong = new HttpError(400, 'Неверный пароль', 'bad_password');
    // A team link checks the team after the password: only the token decides here.
    const open = link?.mode === 'team' ? { ...link, mode: 'anyone' as const } : link;
    if (!meta || !open?.passwordHash || !presented || linkRole({ ...meta, link: open }, { token: presented.token, grant: null }, { signedIn: false }, await this.secretKey(), id) !== 'password') {
      // The same work and answer whether the link exists or not.
      await verifyPassword(String(body.password ?? ''), await dummyPasswordHash());
      throw wrong;
    }
    if (!(await verifyPassword(String(body.password ?? ''), open.passwordHash))) throw wrong;
    return { grant: linkGrant(await this.secretKey(), id, open) };
  }

  // ---------- versions ----------

  private async listVersions(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c);
    const reveal = await this.isInsider(meta, user?.id);
    const list = await this.versions.list(meta.id);
    const names = new Map<string, string>();
    const nameOf = async (id: string) => {
      if (!names.has(id)) {
        names.set(id, this.shownName(await this.users.get(id), reveal));
      }
      return names.get(id)!;
    };
    const out = [];
    for (const v of [...list].reverse()) {
      out.push({ id: v.id, at: v.at, name: v.name ?? null, description: v.description ?? null, by: v.by ? await nameOf(v.by) : null, authors: await Promise.all(v.authors.map(nameOf)) });
    }
    return { versions: out };
  }

  private async getVersion(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c);
    const snapshot = await this.versions.snapshot(meta.id, c.params.versionId!);
    if (!snapshot) throw new HttpError(404, 'Версия не найдена', 'not_found');
    return { snapshot };
  }

  private versionText(body: { name?: unknown; description?: unknown }): { name: string; description: string | undefined } {
    const name = String(body.name ?? '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Укажите название версии', 'bad_name');
    const description = body.description === undefined ? undefined : String(body.description ?? '').trim().slice(0, 1000);
    return { name, description };
  }

  /** "Save version": the file as it is now, with a name; kept until the file is deleted. */
  private async saveVersion(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    const { name, description } = this.versionText(await readJson<{ name?: unknown; description?: unknown }>(c.req));
    await this.live?.flush(meta.id);
    const snapshot = await this.documents.read(meta.id);
    if (!snapshot) throw new HttpError(404, 'Файл не найден', 'not_found');
    const version = await this.versions.add(meta.id, snapshot, { authors: [], name, description, by: user!.id });
    return { version };
  }

  private async renameVersion(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    const { name, description } = this.versionText(await readJson<{ name?: unknown; description?: unknown }>(c.req));
    const version = await this.versions.rename(meta.id, c.params.versionId!, name, description, user!.id);
    if (!version) throw new HttpError(404, 'Версия не найдена', 'not_found');
    return { version };
  }

  // ---------- comments ----------

  /** Names of the people in the threads, for display (`reveal` — addresses of those without a name, for people of the file). */
  private async authorNames(threads: Thread[], reveal = true): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const t of threads) {
      for (const id of [...t.comments.flatMap((x) => [x.authorId, ...(x.mentions ?? [])]), t.resolvedBy ?? '']) {
        if (!id || names.has(id)) continue;
        names.set(id, this.shownName(await this.users.get(id), reveal));
      }
    }
    return names;
  }

  /** A person as someone sees them: the name; without one — the address for people of the file, else HIDDEN_NAME (BUG-159). */
  private shownName(u: User | null | undefined, reveal: boolean): string {
    if (!u) return '';
    return u.name || (reveal ? u.email : HIDDEN_NAME);
  }

  /** Whether a person has the file as its owner, a member or through its team — not only by the link: they see addresses. */
  async isInsider(meta: FileMeta, userId: string | null | undefined): Promise<boolean> {
    return !!userId && (await this.roleOfUser(meta, userId)) !== null;
  }

  /**
   * Changes the comments of a file under its queue, then tells everyone in
   * the file. `fn` returns the new list and the thread to send (or the id of
   * a deleted one).
   */
  private async changeComments(fileId: string, reveal: boolean, fn: (threads: Thread[]) => { threads: Thread[]; thread: string }, after?: (thread: Thread) => void): Promise<Record<string, unknown>> {
    const out: { changed: Thread | null; id: string } = { changed: null, id: '' };
    try {
      await this.blobs.update(fileId, 'comments.json', (text) => {
        const result = fn(parseThreads(text));
        out.id = result.thread;
        out.changed = result.threads.find((t) => t.id === result.thread) ?? null;
        return JSON.stringify(result.threads);
      });
    } catch (error) {
      if (error instanceof CommentError) throw new HttpError(error.status, error.message, error.code);
      throw error;
    }
    const changed = out.changed as Thread | null;
    const inside = changed ? await this.authorNames([changed]) : null;
    const outside = changed ? await this.authorNames([changed], false) : null;
    const message = (insider: boolean) => (changed ? { type: 'thread', thread: publicThread(changed, insider ? inside! : outside!) } : { type: 'thread', id: out.id, deleted: true });
    await this.live?.broadcast(fileId, message);
    if (changed && after) after(changed);
    return message(reveal);
  }

  /** What a person has of a file through membership or their team (no link); a branch — as its main file, its author owns it. */
  private async roleOfUser(meta: FileMeta, userId: string, team?: Team | null): Promise<Role | null> {
    if (meta.branch) {
      const main = await this.files.get(meta.branch.of);
      const role = higher(memberRole(meta, userId), main ? await this.roleOfUser(main, userId) : null);
      return role && meta.branch.review?.reviewers.some((r) => r.id === userId) ? higher(role, 'commenter') : role;
    }
    const t = team === undefined ? await this.teamOfFile(meta) : team;
    return withTeam(memberRole(meta, userId), t && teamRole(t, userId), meta.restricted);
  }

  /** People who have the file through membership (owner and members), by id → name: whom @ can call. */
  private async people(meta: FileMeta, reveal = true): Promise<Map<string, string>> {
    // A branch: the people of its main file, and its author.
    if (meta.branch) {
      const main = await this.files.get(meta.branch.of);
      const out = main ? await this.people(main, reveal) : new Map<string, string>();
      const author = await this.users.get(meta.ownerId);
      if (author && author.verified !== false && !out.has(author.id)) out.set(author.id, this.shownName(author, reveal));
      return out;
    }
    const out = new Map<string, string>();
    const team = await this.teamOfFile(meta);
    // A restricted file: of the team, only those who still have it (admins).
    const fromTeam = team ? [team.ownerId, ...team.members.map((m) => m.userId)].filter((id) => withTeam(null, teamRole(team, id), meta.restricted) !== null) : [];
    const ids = new Set([meta.ownerId, ...(meta.members ?? []).map((m) => m.userId), ...fromTeam]);
    for (const id of ids) {
      const u = await this.users.get(id);
      if (u && u.verified !== false) out.set(id, this.shownName(u, reveal));
    }
    return out;
  }

  /** For the @ list of a comment box: the people of the file, without their addresses. */
  private async listPeople(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'commenter');
    return { people: [...(await this.people(meta, await this.isInsider(meta, user?.id)))].map(([id, name]) => ({ id, name })) };
  }

  /**
   * Tells people about a new comment by letter, after the answer is sent (a
   * slow mail server never holds up the comment). `only` — just these people
   * (newly called with @ when a comment is edited).
   */
  private notifyComment(fileId: string, thread: Thread, entry: CommentEntry, author: User, only?: Set<string>): void {
    void (async () => {
      const meta = await this.files.get(fileId);
      if (!meta) return;
      const url = this.shareUrl(fileId, { comment: thread.id });
      const first = thread.comments[0]?.id === entry.id;
      const team = await this.teamOfFile(meta);
      for (const { userId, mention } of mailRecipients(thread, entry, meta.ownerId)) {
        if (only && !only.has(userId)) continue;
        const user = await this.users.get(userId);
        // Only people who still have the file and want such letters.
        if (!user || user.verified === false || (await this.roleOfUser(meta, userId, team)) === null) continue;
        const pref = commentMailPref(user.prefs?.['cs.mail-comments']);
        if (pref === 'none' || (pref === 'mentions' && !mention)) continue;
        if (!mention && !this.threadMailsTo.allow(`${userId}:${fileId}:${thread.id}`)) continue;
        if (!this.commentMailsTo.allow(userId)) continue;
        const kind = mention ? 'mention' : first ? 'new' : 'reply';
        try {
          await this.options.mailer(commentLetter({ to: user.email, author: author.name || author.email, fileName: meta.name, text: entry.text, url, kind, appUrl: this.options.appUrl }));
        } catch (error) {
          this.options.log?.(`письмо о комментарии для ${user.email} не отправлено: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })().catch((error: unknown) => this.options.log?.(`письма о комментарии: ${error instanceof Error ? error.message : String(error)}`));
  }

  private commenter(user: User | null): User {
    if (!user) throw new HttpError(401, 'Войдите, чтобы комментировать', 'unauthorized');
    if (!this.commentsByUser.allow(user.id)) throw new HttpError(429, 'Слишком много комментариев. Попробуйте позже.', 'rate_limited');
    return user;
  }

  private async listComments(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c);
    const threads = parseThreads(await this.blobs.read(meta.id, 'comments.json'));
    const names = await this.authorNames(threads, await this.isInsider(meta, user?.id));
    return { threads: threads.map((t) => publicThread(t, names)) };
  }

  private async createThread(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'commenter');
    const author = this.commenter(user);
    const body = await readJson<{ pageId?: unknown; nodeId?: unknown; x?: unknown; y?: unknown; text?: unknown; mentions?: unknown }>(c.req);
    const id = newId('t');
    const entry = await this.newEntry(meta, author, body);
    return this.changeComments(
      meta.id,
      await this.isInsider(meta, author.id),
      (threads) => {
        const thread: Thread = { id, ...cleanPlace(body), createdAt: entry.createdAt, resolved: false, comments: [entry] };
        return { threads: addThread(threads, thread), thread: id };
      },
      (thread) => this.notifyComment(meta.id, thread, entry, author),
    );
  }

  /** `{resolved}` — any commenter; `{pageId, nodeId, x, y}` — moves the pin (its author or an editor). */
  private async patchThread(c: Ctx): Promise<unknown> {
    const { meta, user, role } = await this.access(c, 'commenter');
    const me = this.commenter(user);
    const body = await readJson<{ resolved?: unknown; pageId?: unknown; nodeId?: unknown; x?: unknown; y?: unknown }>(c.req);
    const threadId = c.params.threadId!;
    return this.changeComments(meta.id, await this.isInsider(meta, me.id), (threads) => {
      let next = threads;
      if (body.pageId !== undefined) {
        const place = cleanPlace(body);
        const t = threads.find((x) => x.id === threadId);
        if (t && t.comments[0]?.authorId !== me.id && !atLeast(role, 'editor')) throw new CommentError(403, 'Перенести обсуждение может его автор или редактор', 'forbidden');
        next = movePin(next, threadId, place);
      }
      if (typeof body.resolved === 'boolean') next = setResolved(next, threadId, body.resolved, me.id, Date.now());
      return { threads: next, thread: threadId };
    });
  }

  private async reply(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'commenter');
    const author = this.commenter(user);
    const body = await readJson<{ text?: unknown; mentions?: unknown }>(c.req);
    const threadId = c.params.threadId!;
    const entry = await this.newEntry(meta, author, body);
    return this.changeComments(meta.id, await this.isInsider(meta, author.id), (threads) => ({ threads: addReply(threads, threadId, entry), thread: threadId }), (thread) => this.notifyComment(meta.id, thread, entry, author));
  }

  private async editComment(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'commenter');
    const me = this.commenter(user);
    const body = await readJson<{ text?: unknown; mentions?: unknown }>(c.req);
    const threadId = c.params.threadId!;
    const commentId = c.params.commentId!;
    const { text, mentions } = await this.commentText(meta, body, me.id);
    let before: string[] = [];
    return this.changeComments(
      meta.id,
      await this.isInsider(meta, me.id),
      (threads) => {
        before = threads.find((t) => t.id === threadId)?.comments.find((x) => x.id === commentId)?.mentions ?? [];
        return { threads: editComment(threads, threadId, commentId, me.id, text, Date.now(), mentions), thread: threadId };
      },
      (thread) => {
        // Letters only to people called with @ for the first time.
        const added = new Set(mentions.filter((id) => !before.includes(id)));
        const entry = thread.comments.find((x) => x.id === commentId);
        if (entry && added.size) this.notifyComment(meta.id, thread, { ...entry, mentions: [...added] }, me, added);
      },
    );
  }

  /** A new comment from the request body: text and the people called with @. */
  private async newEntry(meta: FileMeta, author: User, body: { text?: unknown; mentions?: unknown }): Promise<CommentEntry> {
    const { text, mentions } = await this.commentText(meta, body, author.id);
    return { id: newId('c'), authorId: author.id, text, createdAt: Date.now(), ...(mentions.length ? { mentions } : {}) };
  }

  /** The text of a comment and the people it calls, checked. */
  private async commentText(meta: FileMeta, body: { text?: unknown; mentions?: unknown }, authorId: string): Promise<{ text: string; mentions: string[] }> {
    let text: string;
    try {
      text = cleanText(body.text);
    } catch (error) {
      if (error instanceof CommentError) throw new HttpError(error.status, error.message, error.code);
      throw error;
    }
    return { text, mentions: cleanMentions(body.mentions, text, await this.people(meta, await this.isInsider(meta, authorId))) };
  }

  private async deleteComment(c: Ctx): Promise<unknown> {
    const { meta, user, role } = await this.access(c, 'commenter');
    if (!user) throw new HttpError(401, 'Нужно войти', 'unauthorized');
    const threadId = c.params.threadId!;
    return this.changeComments(meta.id, await this.isInsider(meta, user.id), (threads) => ({ threads: deleteComment(threads, threadId, c.params.commentId!, user.id, role === 'owner').threads, thread: threadId }));
  }

  /**
   * «@Name» put into a sticker or a text of a board: the person gets a letter with
   * the text and a link to that object. Only the people of the file can be called
   * (by the names the author sees), only by someone who edits the board with an account.
   */
  private async boardMention(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    if (!user) throw new HttpError(401, 'Войдите, чтобы упоминать людей', 'unauthorized');
    if (meta.kind !== 'board') throw new HttpError(400, 'Упоминать людей в тексте можно на доске', 'not_board');
    const body = await readJson<{ userId?: unknown; nodeId?: unknown; text?: unknown }>(c.req);
    const userId = String(body.userId ?? '');
    const nodeId = typeof body.nodeId === 'string' && /^[A-Za-z0-9:_.-]{1,100}$/.test(body.nodeId) ? body.nodeId : null;
    const text = String(body.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!nodeId) throw new HttpError(400, 'Не указан объект доски', 'bad_node');
    if (userId === user.id) return { sent: false };
    const people = await this.people(meta, await this.isInsider(meta, user.id));
    if (!people.has(userId)) throw new HttpError(400, 'Упомянуть можно только того, у кого есть этот файл', 'bad_person');
    if (!this.mentionsByUser.allow(user.id)) throw new HttpError(429, 'Слишком много упоминаний. Попробуйте позже.', 'rate_limited');
    const to = await this.users.get(userId);
    if (!to || commentMailPref(to.prefs?.['cs.mail-comments']) === 'none' || !this.commentMailsTo.allow(userId)) return { sent: false };
    const url = this.shareUrl(meta.id, { node: nodeId });
    try {
      await this.options.mailer(commentLetter({ to: to.email, author: user.name || user.email, fileName: meta.name, text, url, kind: 'board', appUrl: this.options.appUrl }));
    } catch (error) {
      this.options.log?.(`письмо об упоминании для ${to.email} не отправлено: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError(502, 'Не получилось отправить письмо. Попробуйте позже.', 'mail_failed');
    }
    return { sent: true };
  }

  // ---------- libraries ----------

  /** Published libraries the person can open: their own files and files shared with them. */
  private async listLibraries(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const out: Record<string, unknown>[] = [];
    for (const { meta: f } of await this.visibleFiles(user)) {
      if (!f.library) continue;
      const owner = f.ownerId === user.id ? null : await this.users.get(f.ownerId);
      out.push({ fileId: f.id, name: f.name, publishedAt: f.library.publishedAt, components: f.library.components, own: f.ownerId === user.id, ...(owner ? { ownerName: owner.name || owner.email } : {}) });
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    return { libraries: out };
  }

  private async getLibrary(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c);
    const text = meta.library ? await this.blobs.read(meta.id, 'library.json') : null;
    if (!text) throw new HttpError(404, 'Файл не опубликован как библиотека', 'not_published');
    return { library: JSON.parse(text) as unknown };
  }

  /**
   * Publishes the file's components (made by the editor from the open file:
   * the server does not take documents apart). Publishing again replaces the
   * library; files that use it update when their people choose to.
   */
  private async publishLibrary(c: Ctx): Promise<unknown> {
    const { meta, user } = await this.access(c, 'editor');
    const raw = (await readBody(c.req, MAX_DOCUMENT)).toString('utf8');
    let body: { version?: unknown; components?: unknown; nodes?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new HttpError(400, 'Неверные данные библиотеки', 'bad_library');
    }
    if (body.version !== 1 || !Array.isArray(body.components) || !Array.isArray(body.nodes)) throw new HttpError(400, 'Неверные данные библиотеки', 'bad_library');
    if (body.components.length === 0) throw new HttpError(400, 'В файле нет компонентов: публиковать нечего', 'empty_library');
    if (body.components.length > 5000 || body.nodes.length > 200_000) throw new HttpError(413, 'Слишком большая библиотека', 'too_large');
    const publishedAt = Date.now();
    await this.blobs.write(meta.id, 'library.json', JSON.stringify({ ...body, fileId: meta.id, name: meta.name, publishedAt }));
    const file = await this.files.update(meta.id, (cur) => (cur ? { ...cur, library: { publishedAt, publishedBy: user!.id, components: (body.components as unknown[]).length } } : undefined));
    return { library: file?.library ?? null };
  }

  private async unpublishLibrary(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c, 'editor');
    await this.blobs.removeFile(meta.id, 'library.json');
    await this.files.update(meta.id, (cur) => {
      if (!cur) return undefined;
      const { library: _, ...rest } = cur;
      return rest;
    });
    return { ok: true };
  }

  // ---------- fonts ----------

  /**
   * One face of a Google font as TTF (`?family=Roboto&weight=700&italic=1`):
   * for files that use a font this computer lacks. No account needed — the
   * editor works without one too; the faces are public anyway.
   */
  private async googleFont(c: Ctx): Promise<unknown> {
    const req = parseFaceRequest(c.url.searchParams);
    if (!req) throw new HttpError(400, 'Неверное название шрифта или начертание', 'bad_font');
    if (!this.fontsByIp.allow(c.ip)) throw new HttpError(429, 'Слишком много запросов шрифтов. Подождите несколько минут.', 'rate_limited');
    let bytes: Uint8Array | null;
    try {
      bytes = await this.googleFonts.face(req);
    } catch (error) {
      this.options.log?.(`шрифт ${req.family} ${req.weight}${req.italic ? ' italic' : ''}: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError(502, 'Google Fonts сейчас не отвечает. Попробуйте позже.', 'fonts_unavailable');
    }
    if (!bytes) throw new HttpError(404, 'Такого шрифта нет в Google Fonts', 'not_found');
    c.res.writeHead(200, { 'Content-Type': 'font/ttf', 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=2592000' });
    c.res.end(bytes);
    return undefined;
  }

  /** A link card's contents (FEAT-160): only for the signed in, so the server is no open proxy. */
  private async linkPreview(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const target = previewTarget(c.url.searchParams.get('url') ?? '');
    if (!target) throw new HttpError(400, 'Это не ссылка на страницу в интернете', 'bad_url');
    if (!this.previewsByUser.allow(user.id)) throw new HttpError(429, 'Слишком много ссылок подряд. Подождите несколько минут.', 'rate_limited');
    try {
      return await this.linkPreviews.preview(target);
    } catch (error) {
      this.options.log?.(`превью ${target.host}: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError(502, 'Страница не открылась', 'unreachable');
    }
  }

  /**
   * A layout from a description (FEAT-172): the model's HTML page, passed on as
   * plain text while it is being written. Only for the signed in, with a day's
   * limit: the server pays for every request.
   */
  private async aiLayout(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const ai = this.options.ai;
    if (!ai) throw new HttpError(503, 'Создание макетов по описанию на этом сервере не настроено', 'ai_off');
    const body = await readJson<{ prompt?: unknown; width?: unknown; base?: unknown; files?: unknown; slide?: unknown }>(c.req, (BASE_MAX + FILES_MAX) * 2 + 32 * 1024);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (prompt.length < 3) throw new HttpError(400, 'Опишите экран хотя бы парой слов', 'bad_prompt');
    if (prompt.length > PROMPT_MAX) throw new HttpError(400, `Описание длиннее ${PROMPT_MAX} знаков — сократите его`, 'bad_prompt');
    // A change of a page: the page as it is now.
    const base = typeof body.base === 'string' && body.base.trim() ? body.base : undefined;
    if (base && base.length > BASE_MAX) throw new HttpError(413, 'Макет слишком большой, чтобы менять его словами. Выделите его часть.', 'too_large');
    // Attached files, already text.
    const files = Array.isArray(body.files)
      ? body.files.filter((f): f is { name: string; text: string } => !!f && typeof f === 'object' && typeof (f as { name?: unknown }).name === 'string' && typeof (f as { text?: unknown }).text === 'string').slice(0, 10).map((f) => ({ name: f.name.slice(0, 200), text: f.text }))
      : [];
    if (files.reduce((n, f) => n + f.text.length, 0) > FILES_MAX) throw new HttpError(413, 'Файлы слишком большие — оставьте нужную часть таблицы или текста', 'too_large');
    const width = Math.round(Math.min(1920, Math.max(320, typeof body.width === 'number' && Number.isFinite(body.width) ? body.width : 1440)));
    // In a presentation: the slide's size (any format — 16:9, 4:3, a portrait post), within sane bounds.
    const side = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(4096, Math.max(200, v))) : null);
    const raw = body.slide && typeof body.slide === 'object' ? (body.slide as { w?: unknown; h?: unknown }) : null;
    const slideW = raw ? side(raw.w) : null;
    const slideH = raw ? side(raw.h) : null;
    const slide = slideW && slideH ? { w: slideW, h: slideH } : undefined;
    if (this.layoutsRunning.has(user.id)) throw new HttpError(429, 'Предыдущий макет ещё создаётся', 'busy');
    if (!this.layoutsByUser.allow(user.id)) throw new HttpError(429, 'На сегодня макеты по описанию закончились — 20 в сутки. Попробуйте завтра.', 'rate_limited');
    this.layoutsRunning.add(user.id);
    // The person closed the window: the model stops too (and is not paid for further).
    const gone = new AbortController();
    c.res.on('close', () => gone.abort());
    const started = Date.now();
    let size = 0;
    try {
      const pieces = streamLayout(ai, { prompt, width: slide?.w ?? width, base, files, slide }, gone.signal, this.options.aiFetch);
      // The start of the answer decides it: until the page (or a refusal) shows, an error is still
      // an error status, and nothing but a layout goes out — the endpoint is not a free chat.
      let head = '';
      let done = false;
      let kind: ReturnType<typeof answerKind> = null;
      try {
        while (!kind) {
          const next = await pieces.next();
          if (next.done) done = true;
          else head += next.value;
          kind = answerKind(head, done);
        }
      } catch (error) {
        this.options.log?.(`макет по описанию: ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof AiError && error.status === 429) throw new HttpError(503, 'Нейросеть сейчас перегружена. Попробуйте через минуту.', 'ai_busy');
        throw new HttpError(502, 'Нейросеть не ответила. Попробуйте ещё раз.', 'ai_unavailable');
      }
      if (kind === 'other' && !head.trim()) throw new HttpError(502, 'Нейросеть не ответила. Попробуйте ещё раз.', 'ai_unavailable');
      if (kind !== 'layout') {
        gone.abort();
        await pieces.return(undefined).catch(() => undefined);
        this.options.log?.(`макет по описанию: ${kind === 'off_topic' ? 'не по теме' : 'ответ не макетом'} (${head.length} знаков)`);
        throw new HttpError(
          422,
          base ? 'Я помогаю только с этим макетом. Скажите, что в нём поправить — например, «сделай кнопки синими».' : 'Я помогаю только с макетами и презентациями: экраны, страницы, слайды. Опишите, что должно быть на экране — например, «лендинг кофейни с меню и ценами».',
          'off_topic',
        );
      }
      c.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      if (head) {
        size += head.length;
        c.res.write(head);
      }
      if (!done) {
        try {
          for await (const piece of pieces) {
            size += piece.length;
            c.res.write(piece);
          }
        } catch (error) {
          // Too late for a status: the page so far is what the person gets (the import takes a cut page too).
          this.options.log?.(`макет по описанию оборвался: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      c.res.end();
      this.options.log?.(`макет по описанию: ${size} знаков за ${Math.round((Date.now() - started) / 1000)} с`);
      return undefined;
    } finally {
      this.layoutsRunning.delete(user.id);
    }
  }

  /** Texts for a layout, a slide's notes, names for layers (ai-text.ts): a short JSON, checked and cut to what was asked. */
  private async aiText(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const ai = this.options.ai;
    if (!ai) throw new HttpError(503, 'Нейросеть на этом сервере не настроена', 'ai_off');
    const req = parseTextRequest(await readJson<Record<string, unknown>>(c.req, TEXT_MAX * 3));
    if (!req) throw new HttpError(400, 'Слишком много или нечего отправить — выделите меньше', 'bad_request');
    if (!this.aiTextsByUser.allow(user.id)) throw new HttpError(429, 'На сегодня запросы к нейросети закончились. Попробуйте завтра.', 'rate_limited');
    const gone = new AbortController();
    c.res.on('close', () => gone.abort());
    let text: string;
    try {
      text = await askText(ai, req, gone.signal, this.options.aiFetch);
    } catch (error) {
      this.options.log?.(`нейросеть (${req.task}): ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof AiError && error.status === 429) throw new HttpError(503, 'Нейросеть сейчас перегружена. Попробуйте через минуту.', 'ai_busy');
      throw new HttpError(502, 'Нейросеть не ответила. Попробуйте ещё раз.', 'ai_unavailable');
    }
    const answer = parseAnswer(text);
    const checked = answer && checkAnswer(req, answer);
    if (!checked) {
      this.options.log?.(`нейросеть (${req.task}): ответ не по форме (${text.length} знаков)`);
      throw new HttpError(502, 'Нейросеть ответила не то. Попробуйте ещё раз.', 'ai_bad_answer');
    }
    return checked;
  }

  // ---------- teams ----------

  /** The team of a file's project; none for a file in Drafts or in someone's own project. */
  private async teamOfFile(meta: { projectId?: string | null }): Promise<Team | null> {
    if (!meta.projectId) return null;
    const project = await this.projects.get(meta.projectId);
    return project?.teamId ? await this.teams.get(project.teamId) : null;
  }

  /** The person's teams with their role in each; invitations to their address become membership. */
  private async myTeamRoles(user: User): Promise<Map<string, TeamRole | 'owner'>> {
    const out = new Map<string, TeamRole | 'owner'>();
    for (let t of await this.teams.all()) {
      if (liveTeamInvites(t).some((i) => i.email === user.email)) {
        t = (await this.teams.update(t.id, (cur) => (cur ? (claimTeamInvite(cur, user) ?? undefined) : undefined))) ?? t;
      }
      const role = teamRole(t, user.id);
      if (role) out.set(t.id, role);
    }
    return out;
  }

  /** The team of the request with the person's role; someone outside gets "not found". */
  private async team(c: Ctx, needed: TeamRole | 'owner'): Promise<{ team: Team; user: User; role: TeamRole | 'owner' }> {
    const user = await this.requireUser(c);
    const roles = await this.myTeamRoles(user);
    const id = c.params.id!;
    const team = isSafeId(id) && roles.has(id) ? await this.teams.get(id) : null;
    if (!team) throw new HttpError(404, 'Команда не найдена', 'not_found');
    const role = roles.get(id)!;
    if (!teamAtLeast(role, needed)) {
      throw new HttpError(403, needed === 'owner' ? 'Это может сделать только владелец команды' : needed === 'admin' ? 'Это могут делать только администраторы команды' : 'У вас в команде доступ только на просмотр', 'forbidden');
    }
    return { team, user, role };
  }

  /** A team as its member sees it: the people (addresses too — they work together) and, for admins, the invitations. */
  private async teamView(team: Team, role: TeamRole | 'owner'): Promise<Record<string, unknown>> {
    const person = async (id: string, r: TeamRole | 'owner') => {
      const u = await this.users.get(id);
      return { id, name: u?.name ?? '', email: u?.email ?? '', role: r };
    };
    const admin = teamAtLeast(role, 'admin');
    return {
      id: team.id,
      name: team.name,
      role,
      createdAt: team.createdAt,
      members: [await person(team.ownerId, 'owner'), ...(await Promise.all(team.members.map((m) => person(m.userId, m.role))))],
      ...(admin ? { invites: liveTeamInvites(team).map((i) => ({ email: i.email, role: i.role, expiresAt: i.expiresAt })) } : {}),
    };
  }

  /** People joined or left, or their role changed: open team files check who is in them. */
  private async teamAccessChanged(teamId: string): Promise<void> {
    if (!this.live) return;
    const projects = (await this.projects.all()).filter((p) => p.teamId === teamId).map((p) => p.id);
    for (const id of (await this.indexOfFiles()).inProjects(projects)) await this.live.accessChanged(id);
  }

  private teamName(body: { name?: unknown }): string {
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Укажите название команды', 'bad_name');
    return name;
  }

  private async listTeams(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const out: Record<string, unknown>[] = [];
    for (const [id, role] of await this.myTeamRoles(user)) {
      const team = await this.teams.get(id);
      if (team) out.push(await this.teamView(team, role));
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
    return { teams: out };
  }

  private async createTeam(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const name = this.teamName(await readJson<{ name?: unknown }>(c.req));
    const now = Date.now();
    const team: Team = { id: newId('m'), name, ownerId: user.id, members: [], invites: [], createdAt: now, updatedAt: now };
    await this.teams.put(team.id, team);
    return { team: await this.teamView(team, 'owner') };
  }

  private async renameTeam(c: Ctx): Promise<unknown> {
    const { team, role } = await this.team(c, 'admin');
    const name = this.teamName(await readJson<{ name?: unknown }>(c.req));
    const saved = await this.teams.update(team.id, (cur) => (cur ? { ...cur, name, updatedAt: Date.now() } : undefined));
    return { team: await this.teamView(saved ?? team, role) };
  }

  /** Deletes a team and its projects; the files are not lost — each goes to the Drafts of the person who made it. */
  private async deleteTeam(c: Ctx): Promise<unknown> {
    const { team } = await this.team(c, 'owner');
    const projects = (await this.projects.all()).filter((p) => p.teamId === team.id);
    let moved = 0;
    for (const p of projects) moved += await this.emptyProject(p.id);
    for (const p of projects) await this.projects.delete(p.id);
    await this.teams.delete(team.id);
    return { ok: true, moved };
  }

  /**
   * Adds a person by email: someone with an account joins at once, an address
   * without one gets an invitation for 30 days. Both are told by letter.
   */
  private async teamInvite(c: Ctx): Promise<unknown> {
    const { team, user, role: myRole } = await this.team(c, 'admin');
    const body = await readJson<{ email?: unknown; role?: unknown }>(c.req);
    const email = normalizeEmail(String(body.email ?? ''));
    if (!validEmail(email)) throw new HttpError(400, 'Проверьте email', 'bad_email');
    const role = body.role ?? 'editor';
    if (!isTeamRole(role)) throw new HttpError(400, 'Неизвестная роль', 'bad_role');
    if (!this.invitesByUser.allow(user.id)) throw new HttpError(429, 'Слишком много приглашений. Попробуйте через час.', 'rate_limited');
    const id = (await this.emailIndex()).get(email);
    const target = id ? await this.users.get(id) : null;
    if (target && target.id === team.ownerId) throw new HttpError(400, 'Владелец команды уже в ней', 'owner');
    const registered = !!target && target.verified !== false;
    const saved = await this.teams.update(team.id, (cur) => (cur ? (registered ? addTeamMember(cur, target!.id, role) : addTeamInvite(cur, email, role, user.id)) : undefined));
    if (registered) await this.teamAccessChanged(team.id);
    const reporting = (this.options.publicUrl ?? '').trim().replace(/\/+$/, '');
    const teamUrl = reporting
      ? `${new URL(reporting.includes('://') ? reporting : `http://${reporting}`).origin}/?sheet=canvas-studio`
      : `${(this.options.appUrl ?? '').replace(/\/+$/, '')}/`;
    const view = await this.teamView(saved ?? team, myRole);
    try {
      await this.options.mailer(teamLetter({ to: email, inviter: user.name || user.email, teamName: team.name, role, url: teamUrl, needsAccount: !registered, appUrl: this.options.publicUrl || this.options.appUrl }));
    } catch (error) {
      // The person is in the team anyway: the letter is a courtesy.
      this.options.log?.(`приглашение в команду для ${email} не отправлено: ${error instanceof Error ? error.message : String(error)}`);
      return { team: view, mailFailed: true };
    }
    return { team: view };
  }

  private async setTeamRole(c: Ctx): Promise<unknown> {
    const { team, role: myRole } = await this.team(c, 'admin');
    const body = await readJson<{ role?: unknown }>(c.req);
    if (!isTeamRole(body.role)) throw new HttpError(400, 'Неизвестная роль', 'bad_role');
    const userId = c.params.userId!;
    if (!team.members.some((m) => m.userId === userId)) throw new HttpError(404, 'Участник не найден', 'not_found');
    const saved = await this.teams.update(team.id, (cur) => (cur ? addTeamMember(cur, userId, body.role as TeamRole) : undefined));
    await this.teamAccessChanged(team.id);
    return { team: await this.teamView(saved ?? team, myRole) };
  }

  /** Removes a person from the team (admins); anyone but the owner may also leave. Their own files stay theirs. */
  private async removeTeamMember(c: Ctx): Promise<unknown> {
    const userId = c.params.userId!;
    const self = (await this.userOf(c.req))?.id === userId;
    const { team, role } = await this.team(c, self ? 'viewer' : 'admin');
    if (userId === team.ownerId) throw new HttpError(400, self ? 'Владелец не может выйти из команды — её можно только удалить' : 'Владельца нельзя убрать из команды', 'owner');
    const saved = await this.teams.update(team.id, (cur) => (cur ? { ...cur, members: cur.members.filter((m) => m.userId !== userId), updatedAt: Date.now() } : undefined));
    await this.teamAccessChanged(team.id);
    return self ? { ok: true } : { team: await this.teamView(saved ?? team, role) };
  }

  private async removeTeamInvite(c: Ctx): Promise<unknown> {
    const { team, role } = await this.team(c, 'admin');
    const email = normalizeEmail(c.url.searchParams.get('email') ?? '');
    const saved = await this.teams.update(team.id, (cur) => (cur ? { ...cur, invites: cur.invites.filter((i) => i.email !== email) } : undefined));
    return { team: await this.teamView(saved ?? team, role) };
  }

  // ---------- projects ----------

  /**
   * A project that may take files: the person's own (only for their own
   * files — another's file there would vanish from its owner's view) or a
   * project of a team where they can edit.
   */
  private async projectForFiles(id: string, user: User, fileOwnerId: string): Promise<Project> {
    const project = isSafeId(id) ? await this.projects.get(id) : null;
    if (project?.teamId) {
      const team = await this.teams.get(project.teamId);
      const role = team && teamRole(team, user.id);
      if (role && teamAtLeast(role, 'editor')) return project;
      if (role) throw new HttpError(403, 'У вас в команде доступ только на просмотр', 'forbidden');
    } else if (project && project.ownerId === user.id) {
      if (fileOwnerId !== user.id) throw new HttpError(403, 'Чужой файл можно перенести только в проект команды', 'forbidden');
      return project;
    }
    throw new HttpError(404, 'Проект не найден', 'not_found');
  }

  /** A project the person may change: their own, or a team's with the role needed there. */
  private async manageProject(id: string, user: User, needed: TeamRole): Promise<Project> {
    const project = isSafeId(id) ? await this.projects.get(id) : null;
    if (project?.teamId) {
      const team = await this.teams.get(project.teamId);
      const role = team && teamRole(team, user.id);
      if (role && teamAtLeast(role, needed)) return project;
      if (role) throw new HttpError(403, needed === 'admin' ? 'Удалять проекты команды могут её администраторы' : 'У вас в команде доступ только на просмотр', 'forbidden');
    } else if (project && project.ownerId === user.id) {
      return project;
    }
    throw new HttpError(404, 'Проект не найден', 'not_found');
  }

  private projectName(body: { name?: unknown }): string {
    const name = String(body.name ?? '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Укажите название проекта', 'bad_name');
    return name;
  }

  /** Own projects and the projects of the person's teams (with `teamId`). */
  private async listProjects(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const teams = await this.myTeamRoles(user);
    const mine = (await this.projects.all())
      .filter((p) => (p.teamId ? teams.has(p.teamId) : p.ownerId === user.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { projects: mine };
  }

  /** `{name, teamId?}` — a team project needs the editor role in the team. */
  private async createProject(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const body = await readJson<{ name?: unknown; teamId?: unknown }>(c.req);
    const name = this.projectName(body);
    let teamId: string | undefined;
    if (body.teamId !== undefined && body.teamId !== null) {
      const team = isSafeId(String(body.teamId)) ? await this.teams.get(String(body.teamId)) : null;
      const role = team && teamRole(team, user.id);
      if (!team || !role) throw new HttpError(404, 'Команда не найдена', 'not_found');
      if (!teamAtLeast(role, 'editor')) throw new HttpError(403, 'У вас в команде доступ только на просмотр', 'forbidden');
      teamId = team.id;
    }
    const now = Date.now();
    const project: Project = { id: newId('p'), name, ownerId: user.id, createdAt: now, updatedAt: now, ...(teamId ? { teamId } : {}) };
    await this.projects.put(project.id, project);
    return { project };
  }

  private async renameProject(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const project = await this.manageProject(c.params.id!, user, 'editor');
    const name = this.projectName(await readJson<{ name?: unknown }>(c.req));
    return { project: await this.projects.update(project.id, (cur) => (cur ? { ...cur, name, updatedAt: Date.now() } : undefined)) };
  }

  /** Moves every file of a project to Drafts (of the person who made each file); returns how many. */
  private async emptyProject(projectId: string): Promise<number> {
    let moved = 0;
    for (const f of await this.metas((await this.indexOfFiles()).inProjects([projectId]))) {
      if (f.projectId !== projectId) continue;
      await this.files.update(f.id, (cur) => (cur ? { ...cur, projectId: null } : undefined));
      await this.live?.accessChanged(f.id);
      moved++;
    }
    return moved;
  }

  /** Deletes a project; its files are not lost — they move to Drafts. */
  private async deleteProject(c: Ctx): Promise<unknown> {
    const user = await this.requireUser(c);
    const project = await this.manageProject(c.params.id!, user, 'admin');
    // Leave the project first, so a file never points at a project that is gone.
    const moved = await this.emptyProject(project.id);
    await this.projects.delete(project.id);
    return { ok: true, moved };
  }

  private async deleteFile(c: Ctx): Promise<unknown> {
    const { meta } = await this.access(c, 'owner');
    // The branches of a file go with it.
    for (const f of await this.metas((await this.indexOfFiles()).branchesOf(meta.id))) {
      if (f.branch?.of !== meta.id) continue;
      await this.live?.deleted(f.id);
      await this.files.delete(f.id);
      await this.blobs.remove(f.id);
    }
    await this.live?.deleted(meta.id);
    await this.files.delete(meta.id);
    await this.blobs.remove(meta.id);
    return { ok: true };
  }
}

/** Cross-site request checks for state-changing API calls. */
export function checkCsrf(req: IncomingMessage, host: string | undefined): void {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return;
  if (req.headers['x-cs'] !== '1') throw new HttpError(403, 'Запрос отклонён (нет заголовка X-CS)', 'csrf');
  const origin = req.headers.origin;
  if (typeof origin === 'string' && host) {
    let ok = false;
    try {
      ok = new URL(origin).host === host;
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(403, 'Запрос с чужого сайта отклонён', 'csrf');
  }
}

export type { ServerResponse };
