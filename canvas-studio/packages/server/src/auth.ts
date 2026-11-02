// Accounts and sessions: passwords are hashed with scrypt (memory-hard, from
// Node's own crypto) with a random salt per account; sessions are random
// 256-bit tokens given to the browser in an HttpOnly cookie, and only their
// SHA-256 is stored, so a leaked data directory does not leak live sessions.
// Login attempts are rate limited per address and per account.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
export const SESSION_DAYS = 30;

export interface User {
  id: string;
  email: string;
  name: string;
  /** scrypt$N$r$p$salt$hash (base64). */
  password: string;
  createdAt: number;
  /** false until the code from the welcome letter is entered; absent on accounts made before email checks. */
  verified?: boolean;
  /** Interface settings (language, theme, panels…), the same on every computer. */
  prefs?: Record<string, string>;
  /** Consent to personal data processing (152-FZ): when, and to which edition of /consent; absent on accounts made before it was asked. */
  consent?: { at: number; edition: string };
  /** Reporting admin/PAT from SSO (`claims.admin`) — for UI/capabilities in embed. */
  reportingAdmin?: boolean;
}

/** Edition of the consent text at /consent (apps/web/legal/consent.html); change both together. */
export const CONSENT_EDITION = '2026-10-14.2';

/** Settings kept with the account; anything else is refused. */
export const PREF_KEYS = ['cs-lang', 'cs-theme', 'cs-ui-scale', 'cs-dock-place', 'cs.view', 'cs.panels', 'cs.mail-comments', 'cs-context-bar', 'cs-nudge', 'cs.content-sets', 'cs.board-templates'] as const;
const PREF_MAX = 2000;
/** Longer settings: the user's own «Контент» text sets (lists of names, prices…). */
export const PREF_MAX_LONG: Record<string, number> = { 'cs.content-sets': 30_000, 'cs.board-templates': 300_000 };

/** Merges a change into stored settings: known keys only, strings only; null removes a key. */
export function mergePrefs(current: Record<string, string> | undefined, patch: unknown): Record<string, string> | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const next = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(PREF_KEYS as readonly string[]).includes(key)) return null;
    if (value === null) delete next[key];
    else if (typeof value === 'string' && value.length <= (PREF_MAX_LONG[key] ?? PREF_MAX)) next[key] = value;
    else return null;
  }
  return next;
}

export interface Session {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/** How a person without a name is shown to someone who has the file only by its link: never their address (BUG-159). */
export const HIDDEN_NAME = 'Участник';

/** What the API shows about a user (never the password hash). */
export function publicUser(u: User): { id: string; email: string; name: string; admin?: boolean } {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    ...(u.reportingAdmin ? { admin: true } : {}),
  };
}

function derive(password: string, salt: Uint8Array, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...params, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to compare against when the account does not exist, so timing does not reveal which emails are registered. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function newId(prefix = ''): string {
  return prefix + randomBytes(12).toString('base64url');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A practical email check: something@something.tld, no spaces, sane length. */
export function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Пароль — не короче 8 символов';
  if (password.length > 200) return 'Пароль слишком длинный';
  return null;
}

/** Sliding-window limiter: at most `limit` events per `windowMs` for a key. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records an attempt; returns false when the key is over the limit. */
  allow(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    // Keep memory bounded on a long-running server.
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
