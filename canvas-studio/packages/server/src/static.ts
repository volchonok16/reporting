// Serving the web app: the production build (dist/) by default; in
// development the sources, with TypeScript stripped on request by the same
// transform the dev server uses. The inline import map gets a Content Security
// Policy hash, so no other inline script can run.

import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { frameAncestorsCsp, securityHeaders } from './http.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface Transform {
  transformTs(source: string): string;
  transformHtml(source: string): string;
}

export interface StaticOptions {
  /** Project root (sources) — used in development. */
  root: string;
  /** Serve dist/ (production) or sources with a transform (development). */
  dev: Transform | null;
}

/** Employee photos live on the reporting site, not on the Симметрика port. */
function reportingImageOrigins(): string {
  const origins = new Set<string>();
  for (const raw of [process.env.CS_PUBLIC_APP_URL, process.env.APP_PUBLIC_URL]) {
    const value = (raw ?? '').trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // A bad address is ignored: photos then stay letters until the env is fixed.
    }
  }
  return [...origins].join(' ');
}

/** CSP for the app: own scripts only (plus the hashed import map), images from data/blob URLs and the reporting site, WebSockets to itself. */
function cspFor(html: string): string {
  const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter((m) => m[1]!.trim().length > 0)
    .map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval': WebAssembly may compile (the neural network of «Удалить фон»); no eval of strings.
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${reportingImageOrigins()}`.trim(),
    "font-src 'self' data:",
    // data: — pictures of a file are decoded from it off the main thread (PERF-003); such an address sends nothing anywhere.
    "connect-src 'self' data:",
    "worker-src 'self' blob:",
    `frame-ancestors ${frameAncestorsCsp()}`,
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * The page HTML import renders in (editor/html-import). It is shown only in an
 * iframe with sandbox="allow-scripts" — an opaque origin that sees neither our
 * cookies nor our storage, and that our API refuses (wrong Origin). So, unlike
 * the app, it may run the imported page's own scripts and load its fonts,
 * pictures and styles from anywhere. The editor sends the HTML by message.
 */
// Changing it? Change the version in packages/editor/src/html-import/sandbox.ts too (browsers keep this page).
const SANDBOX_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
addEventListener('message', function (e) {
  if (e.source !== parent || !e.data || typeof e.data.h2dLoad !== 'string') return;
  document.open();
  document.write(e.data.h2dLoad);
  document.close();
}, { once: true });
parent.postMessage({ h2d: true, kind: 'sandbox' }, '*');
</script></body></html>`;

export function serveSandbox(res: ServerResponse): void {
  // `sandbox`: an opaque origin even when opened as a page of its own, not only in the editor's sandboxed frame (BUG-161).
  securityHeaders(res, `default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors ${frameAncestorsCsp()}; base-uri *; form-action 'none'; sandbox allow-scripts allow-forms`);
  // Kept by the browser: a preview growing while a layout is written opens a frame every second, and
  // each one waited for the server (over a shaky VPN — seconds). The editor asks for ?v=<version>.
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': Buffer.byteLength(SANDBOX_HTML) });
  res.end(SANDBOX_HTML);
}

/**
 * The heavy files (the neural network and its runtime, 70 MB): not in the release —
 * deploy.sh puts them once into their own folder (CS_HEAVY), each name carrying its
 * version or hash, so a year of caching is safe. Streamed, never read whole.
 */
export async function serveHeavy(path: string, res: ServerResponse, dir: string, head: boolean): Promise<boolean> {
  let clean: string;
  try {
    clean = decodeURIComponent(path.slice('/heavy/'.length));
  } catch {
    return false;
  }
  const base = dir.endsWith(sep) ? dir : dir + sep;
  const file = normalize(join(base, clean));
  if (!file.startsWith(base) || /(^|[\\/])\./.test(file.slice(base.length))) return false;
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    size = info.size;
  } catch {
    return false;
  }
  securityHeaders(res);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'public, max-age=31536000, immutable' });
  if (head) {
    res.end();
    return true;
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return true;
}

/** The legal pages: /terms, /privacy, /consent and their English /en/… → apps/web/legal (the build copies them as they are). */
export function legalFile(path: string): string | null {
  const m = /^\/(en\/)?(terms|privacy|consent)\/?$/.exec(path);
  return m ? `apps/web/legal/${m[2]}${m[1] ? '-en' : ''}.html` : null;
}

export async function serveStatic(path: string, res: ServerResponse, options: StaticOptions, req?: IncomingMessage): Promise<boolean> {
  const base = options.dev ? options.root : join(options.root, 'dist');
  let clean: string;
  try {
    clean = decodeURIComponent(path);
  } catch {
    return false;
  }
  const legal = legalFile(clean);
  const isIndex = !legal && (clean === '/' || clean === '/index.html' || !extname(clean));
  const file = legal ? join(base, legal) : isIndex ? (options.dev ? join(options.root, 'apps/web/index.html') : join(base, 'index.html')) : normalize(join(base, clean));
  if (!file.startsWith(base.endsWith(sep) ? base : base + sep)) return false;
  // Server-only code and data never go to the browser.
  const rel = file.slice(base.length);
  if (/[\\/](packages[\\/]server|apps[\\/]server|data|tools|\.git)([\\/]|$)/.test(rel) || /[\\/]\./.test(rel)) return false;
  let info: Stats;
  try {
    info = await stat(file);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  const ext = extname(file);
  const cacheable = ext === '.woff2' || ext === '.ttf' || ext === '.pptx';
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  if (ext === '.pptx' && req?.headers['if-none-match'] === etag) {
    securityHeaders(res);
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=604800' });
    res.end();
    return true;
  }
  let body: Buffer = await readFile(file);
  if (options.dev && ext === '.ts') body = Buffer.from(options.dev.transformTs(body.toString('utf8')));
  if (options.dev && ext === '.html') body = Buffer.from(options.dev.transformHtml(body.toString('utf8')));
  securityHeaders(res, ext === '.html' ? cspFor(body.toString('utf8')) : undefined);
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // HTML always fresh (it names the current modules); fonts can be cached.
    'Cache-Control': cacheable ? 'public, max-age=604800' : 'no-cache',
    'Content-Length': body.length,
  };
  if (ext === '.pptx') headers.ETag = etag;
  // Маркер для iframe reporting — родитель на другом origin читает текст.
  if (clean === '/apps/web/reporting-canvas.txt') {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Cache-Control'] = 'no-store';
  }
  res.writeHead(200, headers);
  res.end(body);
  return true;
}
