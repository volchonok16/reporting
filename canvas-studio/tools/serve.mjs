// Development server: no dependencies, TypeScript is stripped on request.
// Usage: node tools/serve.mjs [--port 5173] [--dist]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT, transformHtml, transformTs } from './transform.mjs';
import { serveSandbox } from '../packages/server/src/static.ts';

const args = process.argv.slice(2);
const useDist = args.includes('--dist');
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 5173;
const base = useDist ? join(ROOT, 'dist') : ROOT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  if (clean === '/' || clean === '/index.html') {
    return useDist ? join(base, 'index.html') : join(ROOT, 'apps/web/index.html');
  }
  // The legal pages, as the server maps them (packages/server/src/static.ts, legalFile).
  const legal = /^\/(en\/)?(terms|privacy|consent)\/?$/.exec(clean);
  if (legal) return join(base, `apps/web/legal/${legal[2]}${legal[1] ? '-en' : ''}.html`);
  const full = normalize(join(base, clean));
  // Never serve anything outside the project root.
  if (!full.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  // HTML import renders pages in this frame (FEAT-036); without it the import dialog never gets a picture.
  if ((req.url ?? '').split('?')[0] === '/html-sandbox') return serveSandbox(res);
  const file = resolvePath(req.url ?? '/');
  if (!file) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const ext = extname(file);
    let body = await readFile(file);
    if (!useDist && ext === '.ts') body = Buffer.from(transformTs(body.toString('utf8')));
    if (!useDist && ext === '.html') body = Buffer.from(transformHtml(body.toString('utf8')));
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (error) {
    if (!useDist && extname(file) === '.ts' && error instanceof Error && error.message !== 'not a file' && !('code' in error)) {
      // Type stripping failed: report the syntax error in the browser console.
      res.writeHead(500, { 'Content-Type': MIME['.js'] });
      res.end(`console.error(${JSON.stringify(`[canvas-studio] ${req.url}: ${error.message}`)});`);
      return;
    }
    res.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Canvas Studio${useDist ? ' (dist)' : ''}: http://localhost:${port}`);
});
