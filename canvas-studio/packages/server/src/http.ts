// Small HTTP toolkit over node:http: routing with path parameters, JSON bodies
// with a size limit, cookies, errors as JSON, and the security headers every
// response carries.

import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Client address (the proxy's X-Forwarded-For when behind one we trust). */
  ip: string;
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  /** Finds a route; `allowed` lists methods of a path that matched with another method. */
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | { allowed: string[] } | null {
    const segs = path.split('/').filter(Boolean);
    const allowed: string[] = [];
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i]!;
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(segs[i]!);
          } catch {
            ok = false;
            break;
          }
        } else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method === method) return { handler: r.handler, params };
      allowed.push(r.method);
    }
    return allowed.length > 0 ? { allowed } : null;
  }
}

/** Reads the request body up to `limit` bytes. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'Слишком большой запрос', 'too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос', 'too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage, limit = 64 * 1024): Promise<T> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Ожидался JSON', 'bad_type');
  const body = await readBody(req, limit);
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as T;
  } catch {
    throw new HttpError(400, 'Неверный JSON', 'bad_json');
  }
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const text = Array.isArray(header) ? header.join(';') : (header ?? '');
  for (const part of text.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function cookie(name: string, value: string, options: { maxAge: number; secure: boolean }): string {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`, ...(options.secure ? ['Secure'] : [])].join('; ');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** Optional allow-list for embedding in reporting (CS_FRAME_ANCESTORS). Empty — только 'self'. */
export function frameAncestorsCsp(): string {
  const raw = (process.env.CS_FRAME_ANCESTORS ?? '').trim();
  return raw || "'self'";
}

/** Headers on every response: no sniffing, no framing by other sites, no referrer leaks. */
export function securityHeaders(res: ServerResponse, csp?: string): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const ancestors = frameAncestorsCsp();
  // X-Frame-Options не умеет список origin'ов; при embed через CSP убираем заголовок.
  if (ancestors === "'self'") {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (csp) res.setHeader('Content-Security-Policy', csp);
}
