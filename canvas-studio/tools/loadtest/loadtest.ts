// Load test of the live editing server: how many people it carries.
//
//   node --disable-warning=ExperimentalWarning tools/loadtest/loadtest.ts [--files 5] [--per 10] [--seconds 20] [--image-mb 0] [--pages 3]
//
// Starts the server as a separate process on a temporary data folder (so its
// memory and CPU are measured alone), makes an account and `files` files, and
// connects `per` people to each. Every person moves the pointer 20 times a
// second (as the editor does while the mouse moves), changes a layer every two
// seconds, and walks between `pages` pages now and then. `--image-mb` puts a
// picture of that size in every file (pictures are most of a real file's weight).
//
// Prints, every second and in the end: the server's memory (RSS) and CPU,
// messages delivered per second, and how long a pointer and an edit take to
// reach the others (median and 95th percentile).

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Document, serialize, type NodeId } from '../../packages/core/src/index.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const FILES = opt('files', 5);
const PER = opt('per', 10);
const SECONDS = opt('seconds', 20);
const IMAGE_MB = opt('image-mb', 0);
const PAGES = Math.max(1, opt('pages', 3));
const PORT = opt('port', 8790);
const base = `http://127.0.0.1:${PORT}`;

const root = new URL('../..', import.meta.url).pathname;
const dataDir = await mkdtemp(join(tmpdir(), 'cs-load-'));
let output = '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function startServer() {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'apps/server/src/main.ts'), '--port', String(PORT), '--data', dataDir], { env: { ...process.env, CS_SMTP_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  return child;
}
let server = startServer();
async function waitHealth(): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      if (i > 100) {
        console.error(output);
        await finish(1);
      }
      await sleep(100);
    }
  }
}

async function finish(code: number): Promise<never> {
  server.kill('SIGTERM');
  await sleep(300);
  await rm(dataDir, { recursive: true, force: true });
  process.exit(code);
}

await waitHealth();

// An account.
let cookie = '';
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-CS': '1', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
await api('POST', '/api/auth/register', { email: 'load@example.com', password: '12345678', name: 'Нагрузка', consent: true });
await sleep(200);
const code = [...output.matchAll(/(\d{6})/g)].at(-1)?.[1];
await api('POST', '/api/auth/verify', { email: 'load@example.com', code });

// Files: pages with layers, optionally a picture.
const files: { id: string; pages: NodeId[]; layers: NodeId[] }[] = [];
for (let f = 0; f < FILES; f++) {
  const doc = Document.createEmpty(`Нагрузка ${f}`, `load${f}`);
  const pages: NodeId[] = [doc.pages()[0]!];
  const layers: NodeId[] = [];
  doc.withTransaction((tx) => {
    for (let p = 1; p < PAGES; p++) pages.push(tx.create('PAGE', doc.rootId, { name: `Страница ${p + 1}` }));
    for (const page of pages) {
      for (let i = 0; i < 40; i++) layers.push(tx.create('RECTANGLE', page, { x: (i % 8) * 120, y: Math.floor(i / 8) * 120, width: 100, height: 100 }));
    }
    if (IMAGE_MB > 0) {
      const bytes = new Uint8Array(Math.round(IMAGE_MB * 1024 * 1024));
      for (let i = 0; i < bytes.length; i += 4096) bytes.set(crypto.getRandomValues(new Uint8Array(Math.min(4096, bytes.length - i))), i);
      const hash = tx.addBlob(bytes, 'image/png');
      tx.set(layers[0]!, 'fills', [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }]);
    }
  }, 'local');
  const id = `fLoad${String(f).padStart(5, '0')}`;
  await api('PUT', `/api/files/${id}`, { name: `Нагрузка ${f}`, snapshot: serialize(doc) });
  files.push({ id, pages, layers });
}

// A fresh server: the memory taken by uploading the files is not counted.
server.kill('SIGTERM');
await new Promise((r) => server.once('exit', r));
server = startServer();
await waitHealth();
const idle = serverStats();

// People.
const pointer: number[] = [];
const edits: number[] = [];
let delivered = 0;
let session = 0;
interface Person {
  ws: WebSocket;
  file: (typeof files)[number];
  page: NodeId;
  counter: number;
  session: string;
}
const people: Person[] = [];
async function connect(file: (typeof files)[number]): Promise<Person> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/live/${file.id}`, { headers: { Cookie: cookie, Origin: base } } as unknown as string[]);
  const person: Person = { ws, file, page: file.pages[0]!, counter: 1_000_000, session: `s${++session}` };
  ws.addEventListener('message', (e: MessageEvent) => {
    delivered++;
    const m = JSON.parse(String(e.data)) as { type: string; cursor?: { x: number; y: number }; ops?: { value?: unknown }[]; from?: string };
    const now = performance.now();
    if (m.type === 'presence' && m.cursor) pointer.push(now - m.cursor.y);
    if (m.type === 'ops' && m.from && typeof m.ops?.[0]?.value === 'number') edits.push(now - (m.ops[0].value as number));
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  ws.send(JSON.stringify({ type: 'hello', version: null, since: null, rawSnapshot: true }));
  return person;
}
for (const file of files) for (let i = 0; i < PER; i++) people.push(await connect(file));
await sleep(500);

// Activity: pointer 20/s, an edit every 2 s, a page change every ~10 s.
const timers: ReturnType<typeof setInterval>[] = [];
people.forEach((p, i) => {
  setTimeout(() => {
    timers.push(
      setInterval(() => {
        if (p.ws.readyState !== WebSocket.OPEN) return;
        p.ws.send(JSON.stringify({ type: 'presence', page: p.page, cursor: { x: Math.random() * 1000, y: performance.now() }, selection: [], view: null, chat: null }));
      }, 50),
    );
    timers.push(
      setInterval(() => {
        if (p.ws.readyState !== WebSocket.OPEN) return;
        const layer = p.file.layers[Math.floor(Math.random() * p.file.layers.length)]!;
        // The value carries the send time: receivers measure the delay from it.
        p.ws.send(JSON.stringify({ type: 'ops', id: `${p.session}-${p.counter}`, ops: [{ kind: 'set', id: layer, key: 'x', value: performance.now(), time: { counter: ++p.counter, session: p.session } }] }));
        if (Math.random() < 0.2) p.page = p.file.pages[Math.floor(Math.random() * p.file.pages.length)]!;
      }, 2000),
    );
  }, (i * 37) % 2000);
});

function serverStats(): { rss: number; cpu: number } {
  try {
    // LC_ALL=C: a Russian locale prints "12,5".
    const [cpu, rss] = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', String(server.pid)], { env: { ...process.env, LC_ALL: 'C' } }).toString().trim().split(/\s+/).map(Number);
    return { rss: Math.round((rss ?? 0) / 1024), cpu: cpu ?? 0 };
  } catch {
    return { rss: 0, cpu: 0 };
  }
}
const pct = (list: number[], p: number) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
};

console.log(`Файлов: ${FILES}, людей в файле: ${PER} (всего ${FILES * PER}), страниц: ${PAGES}, картинка: ${IMAGE_MB} МБ; сервер без нагрузки — ${idle.rss} МБ`);
const samples: { rss: number; cpu: number; msgs: number; p50: number; p95: number }[] = [];
for (let s = 0; s < SECONDS; s++) {
  const before = delivered;
  pointer.length = 0;
  await sleep(1000);
  const st = serverStats();
  const row = { ...st, msgs: delivered - before, p50: pct(pointer, 50), p95: pct(pointer, 95) };
  samples.push(row);
  console.log(`${String(s + 1).padStart(3)} с  память ${row.rss} МБ  процессор ${row.cpu}%  сообщений/с ${row.msgs}  курсор p50 ${row.p50} мс p95 ${row.p95} мс`);
}
for (const t of timers) clearInterval(t);
const avg = (k: keyof (typeof samples)[number]) => Math.round(samples.slice(2).reduce((a, r) => a + r[k], 0) / Math.max(1, samples.length - 2));
console.log(`\nИтог (без первых 2 с): память ~${avg('rss')} МБ (макс ${Math.max(...samples.map((r) => r.rss))}), процессор ~${avg('cpu')}%, сообщений/с ~${avg('msgs')}, курсор p50 ~${avg('p50')} мс, p95 ~${avg('p95')} мс, правка p50 ${pct(edits, 50)} мс p95 ${pct(edits, 95)} мс`);
for (const p of people) p.ws.close();
await finish(0);
