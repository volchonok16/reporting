// Ссылка на фото сотрудника reporting. Подпись совпадает с photo_signed_url в backend.

import { createHmac } from 'node:crypto';

const TTL_SECONDS = 30 * 24 * 3600;

/** employees/<file> или null, если путь нельзя отдать в URL. */
export function safeEmployeePhoto(photoPath: string | null | undefined): string | null {
  const normalized = (photoPath ?? '').trim().replace(/\\/g, '/');
  if (!normalized || normalized.split('/').includes('..')) return null;
  const parts = normalized.split('/');
  if (parts.length !== 2 || parts[0] !== 'employees') return null;
  const name = parts[1] ?? '';
  if (!name || name.startsWith('.')) return null;
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return null;
  return `employees/${name}`;
}

/** Абсолютный или корневой URL фото. Без секрета SSO подпись не из чего собрать. */
export function reportingPhotoUrl(photoPath: string | null | undefined, nowMs = Date.now()): string | undefined {
  const safe = safeEmployeePhoto(photoPath);
  const secret = (process.env.CS_REPORTING_SSO_SECRET ?? '').trim();
  if (!safe || !secret) return undefined;
  const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
  const sig = createHmac('sha256', secret).update(`${safe}|${exp}`).digest('hex');
  const path = `/api/org/photos/${safe}?exp=${exp}&sig=${sig}`;
  const base = (process.env.CS_PUBLIC_APP_URL || process.env.APP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}
