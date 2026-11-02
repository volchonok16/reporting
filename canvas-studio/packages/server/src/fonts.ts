// Fonts from Google Fonts for files that use them (a .fig made on a computer
// with Roboto, opened where there is none). The server fetches one face —
// family, weight, slant — as a whole TTF and keeps it on disk; the editor
// embeds it into the file, so everyone sees the same text. Every Google font is
// under an open licence (OFL, Apache, UFL): embedding is allowed.
//
// The server goes to Google, not the browsers: people's addresses are not
// handed to a third party, and a face is fetched once for everybody.

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './storage.ts';

const CSS_URL = 'https://fonts.googleapis.com/css2';
/** Largest font file accepted (CJK families are the biggest, a few MB). */
const MAX_BYTES = 20 * 1024 * 1024;
/** A family Google does not have is asked again only after this. */
const MISSING_MS = 24 * 3600_000;

export interface FontFaceRequest {
  family: string;
  weight: number;
  italic: boolean;
}

/** A family name as Google writes them: letters, digits, spaces (and a few signs). */
export function parseFaceRequest(params: URLSearchParams): FontFaceRequest | null {
  const family = (params.get('family') ?? '').trim().replace(/\s+/g, ' ');
  const weight = Number(params.get('weight') ?? 400);
  const italic = params.get('italic') === '1';
  if (!/^[\p{L}\p{N} .'&+-]{1,80}$/u.test(family)) return null;
  if (!Number.isInteger(weight) || weight < 100 || weight > 900 || weight % 100 !== 0) return null;
  return { family, weight, italic };
}

export class GoogleFonts {
  private readonly dir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly missing = new Map<string, number>();
  private readonly pending = new Map<string, Promise<Uint8Array | null>>();

  constructor(dir: string, fetchImpl: typeof fetch = fetch) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
  }

  /** The face as TTF bytes; null — Google has no such family or face. */
  face(req: FontFaceRequest): Promise<Uint8Array | null> {
    const key = `${req.family}\u0000${req.weight}\u0000${req.italic ? 1 : 0}`;
    const until = this.missing.get(key);
    if (until !== undefined && until > Date.now()) return Promise.resolve(null);
    let p = this.pending.get(key);
    if (!p) {
      p = this.load(key, req).finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  private async load(key: string, req: FontFaceRequest): Promise<Uint8Array | null> {
    const file = join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.ttf`);
    const cached = await readFile(file).catch(() => null);
    if (cached) return new Uint8Array(cached);
    const url = `${CSS_URL}?family=${encodeURIComponent(req.family).replace(/%20/g, '+')}:ital,wght@${req.italic ? 1 : 0},${req.weight}`;
    // Without a browser's User-Agent Google answers with whole TTF files (not split by alphabets).
    const css = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (css.status === 400 || css.status === 404) {
      this.missing.set(key, Date.now() + MISSING_MS);
      return null;
    }
    if (!css.ok) throw new Error(`Google Fonts: ${css.status}`);
    const src = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+\.ttf)\)/.exec(await css.text())?.[1];
    if (!src) {
      this.missing.set(key, Date.now() + MISSING_MS);
      return null;
    }
    const res = await this.fetchImpl(src, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Google Fonts: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES || bytes.length < 12) throw new Error('Google Fonts: неожиданный файл');
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(file, bytes);
    return bytes;
  }
}
