// The Simmetrika server: the web app and its API from one process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Api, checkCsrf } from './api.ts';
import { LiveHub } from './live.ts';
import { logMailer, type Mailer } from './mail.ts';
import { HttpError, securityHeaders, sendJson, type Ctx } from './http.ts';
import { serveHeavy, serveSandbox, serveStatic, type Transform } from './static.ts';

export interface ServerOptions {
  /** Where accounts, sessions and files are kept (disk fallback / fonts cache). */
  dataDir: string;
  /** Project root (for the web app). */
  root: string;
  /** Serve sources with this transform (development) instead of dist/. */
  dev: Transform | null;
  /** Behind HTTPS: cookies get the Secure flag. */
  secure: boolean;
  /** The heavy files' folder (the neural network, /heavy/…); none — not served. */
  heavy?: string;
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy on this machine. */
  trustProxy: boolean;
  openRegistration: boolean;
  /** Sends letters; without it letters go to the log. */
  mailer?: Mailer;
  /** Public address of the app, shown in letters. */
  appUrl?: string;
  /** Reporting site (APP_PUBLIC_URL): links in letters open the Симметрика tab there. */
  publicUrl?: string;
  /** Log requests and errors. */
  log?: (line: string) => void;
  /** How Google Fonts is reached (tests pass their own). */
  fontsFetch?: typeof fetch;
  /** Fetches pages for link cards (tests pass their own). */
  linkGet?: import('./link-preview.ts').Getter;
  /** The language model gateway for layouts from a description; none — the feature is off. */
  ai?: import('./ai-layout.ts').AiConfig | null;
  /** How the gateway is reached (tests pass their own). */
  aiFetch?: typeof fetch;
  /** Shared HMAC secret with reporting for SSO. */
  reportingSsoSecret?: string;
  /** Disable password auth; only reporting SSO. */
  reportingAuthOnly?: boolean;
  /**
   * PostgreSQL URL (reporting). When set, users/files/blobs go to simmetrika_* tables
   * instead of JSON files under dataDir. Example: postgresql://alex:alex@postgres:5432/reporting
   */
  databaseUrl?: string;
}

export interface CanvasServer {
  server: Server;
  api: Api;
  live: LiveHub;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string') return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export async function createCanvasServer(options: ServerOptions): Promise<CanvasServer> {
  const log = options.log ?? (() => undefined);

  let storage: ConstructorParameters<typeof Api>[1];
  if (options.databaseUrl) {
    const { openPgStorage, pgHealthCheck, searchColleagues } = await import('./pg-storage.ts');
    const pg = await openPgStorage(options.databaseUrl, options.dataDir);
    storage = {
      users: pg.users as never,
      sessions: pg.sessions as never,
      files: pg.files as never,
      codes: pg.codes as never,
      projects: pg.projects as never,
      teams: pg.teams as never,
      blobs: pg.blobs,
      secretLoader: pg.secretLoader,
      healthCheck: () => pgHealthCheck(pg.pool),
      colleagues: (q: string) => searchColleagues(pg.pool, q),
    };
    log('хранилище Симметрики: PostgreSQL (simmetrika_*)');
  } else {
    log(`хранилище Симметрики: файлы в ${options.dataDir}`);
  }

  const api = new Api(
    {
      dataDir: options.dataDir,
      secure: options.secure,
      openRegistration: options.openRegistration,
      mailer: options.mailer ?? logMailer(log),
      appUrl: options.appUrl,
      publicUrl: options.publicUrl,
      log,
      fontsFetch: options.fontsFetch,
      linkGet: options.linkGet,
      ai: options.ai,
      aiFetch: options.aiFetch,
      reportingSsoSecret: options.reportingSsoSecret,
      reportingAuthOnly: options.reportingAuthOnly,
      databaseUrl: options.databaseUrl,
    },
    storage,
  );
  // Merged branches past the time to undo the merge: once a day (and at start).
  const sweep = () => void api.sweepBranches().then((n) => n && log(`удалено слитых веток: ${n}`), (error: unknown) => log(`ветки: ${String(error)}`));
  (setTimeout(sweep, 60_000) as unknown as { unref?(): void }).unref?.();
  (setInterval(sweep, 86_400_000) as unknown as { unref?(): void }).unref?.();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      sendJson(res, 400, { error: 'bad_url', message: 'Неверный адрес' });
      return;
    }
    const path = url.pathname;
    // Behind HTTPS: browsers never try plain http again (the first request could be intercepted and
    // the session cookie read before the redirect). A year; not for subdomains — typehero lives beside.
    if (options.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (path.startsWith('/api/')) {
      securityHeaders(res);
      const ctx: Ctx = { req, res, url, params: {}, ip: clientIp(req, options.trustProxy) };
      try {
        checkCsrf(req, host);
        const match = api.router.match(req.method ?? 'GET', path);
        if (!match) throw new HttpError(404, 'Нет такого адреса API', 'not_found');
        if ('allowed' in match) {
          res.setHeader('Allow', match.allowed.join(', '));
          throw new HttpError(405, 'Метод не поддерживается', 'method');
        }
        ctx.params = match.params;
        const result = await match.handler(ctx);
        if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
      } catch (error) {
        if (error instanceof HttpError) {
          if (!res.headersSent) sendJson(res, error.status, { error: error.code, message: error.message });
        } else {
          log(`500 ${req.method} ${path}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
          if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Ошибка сервера' });
        }
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      securityHeaders(res);
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (path === '/html-sandbox') return serveSandbox(res);
    if (options.heavy && path.startsWith('/heavy/') && (await serveHeavy(path, res, options.heavy, req.method === 'HEAD'))) return;
    if (await serveStatic(path, res, { root: options.root, dev: options.dev }, req)) return;
    securityHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`fatal ${req.method} ${req.url}: ${String(error)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  // Live editing: WebSocket connections at /api/live/<file>.
  const live = new LiveHub(api, log);
  api.live = live;
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost';
    live.handleUpgrade(req, socket, host, clientIp(req, options.trustProxy)).catch((error: unknown) => {
      log(`live: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      socket.destroy();
    });
  });
  return { server, api, live };
}
