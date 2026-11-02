// Starts the Simmetrika server.
//
//   node apps/server/src/main.ts [--port 8080] [--host 127.0.0.1] [--data ./data] [--dev]
//
// Environment (overrides flags): CS_PORT, CS_HOST, CS_DATA, CS_SECURE=1 (behind
// HTTPS), CS_TRUST_PROXY=1 (behind a reverse proxy on this machine),
// CS_OPEN_REGISTRATION=0 (only the first account may register). Mail (password
// reset codes): CS_SMTP_* and CS_MAIL_FROM, see packages/server/src/mail.ts.
// Layouts from a description: CS_AI_KEY (and CS_AI_URL, CS_AI_MODEL), see
// packages/server/src/ai-layout.ts. CS_HEAVY — the folder of the neural network
// for «Удалить фон» (/heavy/…; by default apps/web/heavy of the project).
// CS_DATABASE_URL — PostgreSQL (reporting): users/files/blobs in simmetrika_* tables.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvasServer } from '../../../packages/server/src/server.ts';
import { smtpConfigFromEnv, smtpMailer } from '../../../packages/server/src/mail.ts';
import { aiConfigFromEnv } from '../../../packages/server/src/ai-layout.ts';
import type { Transform } from '../../../packages/server/src/static.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = process.env;
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const port = Number(env.CS_PORT ?? flag('port') ?? 8080);
const host = env.CS_HOST ?? flag('host') ?? '127.0.0.1';
const dataDir = resolve(env.CS_DATA ?? flag('data') ?? `${root}/data`);
const devMode = args.includes('--dev');
const databaseUrl = (env.CS_DATABASE_URL ?? '').trim() || undefined;

// Development serves sources with TypeScript stripped, using the dev server's transform.
const transformModule = '../../../tools/transform.mjs';
const dev: Transform | null = devMode ? ((await import(transformModule)) as Transform) : null;

const smtp = smtpConfigFromEnv(env);
const ai = aiConfigFromEnv(env);
const reportingSsoSecret = (env.CS_REPORTING_SSO_SECRET ?? '').trim() || undefined;
// По умолчанию при наличии секрета — только SSO reporting (отдельный логин не нужен).
const reportingAuthOnly =
  env.CS_REPORTING_AUTH_ONLY === '1' || (Boolean(reportingSsoSecret) && env.CS_REPORTING_AUTH_ONLY !== '0');

const { server, live } = await createCanvasServer({
  dataDir,
  root,
  dev,
  secure: env.CS_SECURE === '1',
  heavy: resolve(env.CS_HEAVY ?? `${root}/apps/web/heavy`),
  trustProxy: env.CS_TRUST_PROXY === '1',
  openRegistration: reportingAuthOnly ? false : env.CS_OPEN_REGISTRATION !== '0',
  mailer: smtp ? smtpMailer(smtp) : undefined,
  appUrl: env.CS_APP_URL,
  ai,
  reportingSsoSecret,
  reportingAuthOnly,
  databaseUrl,
  log: (line) => console.error(`[${new Date().toISOString()}] ${line}`),
});

server.listen(port, host, () => {
  const where = databaseUrl ? 'PostgreSQL (simmetrika_*)' : dataDir;
  console.log(`Симметрика: http://${host}:${port}  (данные: ${where}${devMode ? ', разработка' : ''})`);
  console.log(smtp ? `Почта: ${smtp.from} через ${smtp.host}:${smtp.port}` : 'Почта не настроена (CS_SMTP_HOST) — письма пишутся в журнал');
  console.log(ai ? `Макеты по описанию: ${ai.model}` : 'Макеты по описанию выключены (CS_AI_KEY)');
  console.log(
    reportingSsoSecret
      ? `SSO reporting: включён${reportingAuthOnly ? ' (только SSO)' : ''}`
      : 'SSO reporting: выключен (CS_REPORTING_SSO_SECRET)',
  );
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  console.log('Остановка…');
  // Never hang: live connections (WebSockets) are not counted by server.close and would keep it waiting.
  (setTimeout(() => process.exit(0), 8000) as unknown as { unref?(): void }).unref?.();
  // Files open for live editing are saved before the process ends.
  void live.flushAll().finally(() => {
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
