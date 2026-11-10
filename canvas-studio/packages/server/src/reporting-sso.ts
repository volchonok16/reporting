// SSO from reporting: short HMAC token → Simmetrika session.
// Same scheme as Voice (body.base64url + hmac-sha256 signature).

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ReportingSsoClaims {
  email: string;
  name: string | null;
  admin: boolean;
  avatar: string | null;
}

function b64urlEncode(raw: Buffer | string): string {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  return buf.toString('base64url');
}

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Sentinel password for SSO accounts: scrypt verifier never accepts this form. */
export const SSO_PASSWORD_MARKER = 'sso$reporting';

export function isSsoUserPassword(password: string | undefined): boolean {
  return typeof password === 'string' && password.startsWith('sso$');
}

export function verifyReportingSsoToken(token: string, secret: string): ReportingSsoClaims {
  const trimmed = token.trim();
  const cut = trimmed.indexOf('.');
  if (cut <= 0) throw new Error('Некорректный SSO-токен');
  const body = trimmed.slice(0, cut);
  const signature = trimmed.slice(cut + 1);
  const expected = b64urlEncode(createHmac('sha256', secret).update(body, 'ascii').digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Подпись SSO-токена недействительна');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Некорректный SSO-токен');
  }
  if (Number(payload.exp ?? 0) < Math.floor(Date.now() / 1000)) throw new Error('SSO-токен истёк');
  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('В SSO-токене нет email');
  const nameRaw = payload.name;
  const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim().slice(0, 80) : null;
  const avatarRaw = payload.avatar;
  const avatar = typeof avatarRaw === 'string' && /^https?:\/\//i.test(avatarRaw.trim()) ? avatarRaw.trim().slice(0, 500) : null;
  return { email, name, admin: Boolean(payload.admin), avatar };
}
