import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { hashPassword, RateLimiter, verifyPassword } from '../src/auth.ts';
import { createCanvasServer } from '../src/server.ts';
import { codeLetter, smtpMailer, type Letter } from '../src/mail.ts';
import { JsonStore } from '../src/storage.ts';

async function start(openRegistration = true, mailer?: (letter: Letter) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-test-'));
  /** Letters the server sent (when no mailer is given). */
  const letters: Letter[] = [];
  const { server, api } = await createCanvasServer({ dataDir, root: dataDir, dev: null, secure: false, trustProxy: false, openRegistration, mailer: mailer ?? (async (l) => void letters.push(l)) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // A room may still be writing (a version after the last person left): retry.
    await new Promise((r) => setTimeout(r, 50));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { base, dataDir, stop, letters, api };
}

/** The code from the newest letter to an address. */
function codeFor(letters: Letter[], email: string): string {
  const letter = letters.filter((l) => l.to === email).at(-1);
  assert.ok(letter, `no letter for ${email}`);
  return /(\d{6})/.exec(letter.text)![1]!;
}

/** Registers and confirms the address with the emailed code, as a person would. */
async function signUp(api: ReturnType<typeof client>, letters: Letter[], email: string, password: string, name: string) {
  const reg = await api('POST', '/api/auth/register', { email, password, name, consent: true });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  return api('POST', '/api/auth/verify', { email: email.trim().toLowerCase(), code: codeFor(letters, email.trim().toLowerCase()) });
}

/** A tiny client keeping the session cookie, as a browser would. */
function client(base: string) {
  let cookie = '';
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-CS': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null, setCookie: set };
  };
}

const SNAPSHOT = JSON.stringify({ version: 1, nodes: [{ id: 'r', parent: null, props: { name: 'Документ' } }] });

test('passwords: scrypt hash round trip, wrong password, rate limiter', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
  assert.notEqual(await hashPassword('correct horse'), h, 'random salt');
  const rl = new RateLimiter(2, 1000);
  assert.deepEqual([rl.allow('a', 0), rl.allow('a', 10), rl.allow('a', 20), rl.allow('a', 1500)], [true, true, false, true]);
});

test('storage: atomic JSON records, safe ids only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cs-store-'));
  const store = new JsonStore<{ n: number }>(dir);
  await Promise.all([1, 2, 3, 4, 5].map((n) => store.update('counter1', (cur) => ({ n: (cur?.n ?? 0) + n }))));
  assert.deepEqual(await store.get('counter1'), { n: 15 }, 'queued updates never lose a write');
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'counter1.json'), 'utf8')), { n: 15 });
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
  assert.equal(await store.get('../etc/passwd'), null);
  await assert.rejects(store.put('../escape', { n: 1 }));
  await rm(dir, { recursive: true, force: true });
});

test('API: register, session cookie, login, logout, CSRF', async () => {
  const { base, stop, letters } = await start();
  try {
    const api = client(base);
    assert.equal((await api('GET', '/api/me')).status, 401);
    const bad = await api('POST', '/api/auth/register', { email: 'not-an-email', password: '12345678', name: 'A', consent: true });
    assert.equal(bad.status, 400);
    assert.equal((await api('POST', '/api/auth/register', { email: 'a@b.ru', password: 'short', name: 'A', consent: true })).status, 400);
    const noConsent = await api('POST', '/api/auth/register', { email: 'a@b.ru', password: '12345678', name: 'A' });
    assert.equal(noConsent.status, 400, 'no account without consent to personal data processing');
    assert.equal(letters.length, 0, 'and no letter');
    const reg = await signUp(api, letters, ' Anna@Example.com ', 'секретный пароль', 'Анна');
    assert.equal(reg.status, 200);
    assert.deepEqual(reg.body!.user.email, 'anna@example.com');
    assert.equal(reg.body!.user.password, undefined, 'the hash never leaves the server');
    assert.match(reg.setCookie!, /HttpOnly; SameSite=Lax/);
    assert.equal((await api('GET', '/api/me')).body!.user.name, 'Анна');
    assert.equal((await api('POST', '/api/auth/register', { email: 'anna@example.com', password: '12345678', name: 'Б', consent: true })).status, 409);

    await api('POST', '/api/auth/logout', {});
    assert.equal((await api('GET', '/api/me')).status, 401, 'logged out');
    assert.equal((await api('POST', '/api/auth/login', { email: 'anna@example.com', password: 'неверный' })).status, 401);
    const missing = await api('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'неверный' });
    assert.equal(missing.body!.message, 'Неверный email или пароль', 'same answer for unknown accounts');
    assert.equal((await api('POST', '/api/auth/login', { email: 'ANNA@example.com', password: 'секретный пароль' })).status, 200);

    // Cross-site: no X-CS header, or a foreign Origin, is refused.
    const raw = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
    assert.equal(raw.status, 403);
    assert.equal((await api('POST', '/api/auth/logout', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await api('GET', '/api/nothing')).status, 404);
    assert.equal((await api('PUT', '/api/me')).status, 405);
  } finally {
    await stop();
  }
});

test('API: files are private, saved with versions, renamed and deleted', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    const boris = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    await signUp(boris, letters, 'boris@example.com', '12345678', 'Борис');
    assert.equal((await anna('PUT', '/api/files/fileA0001', { name: 'Макет', snapshot: 'не json' })).status, 400);
    const created = await anna('PUT', '/api/files/fileA0001', { name: 'Макет', snapshot: SNAPSHOT });
    assert.equal(created.status, 200);
    assert.equal(created.body!.file.version, 1);
    const saved = await anna('PUT', '/api/files/fileA0001', { name: 'Макет', snapshot: SNAPSHOT, baseVersion: 1 });
    assert.equal(saved.body!.file.version, 2);
    assert.equal((await anna('PUT', '/api/files/fileA0001', { name: 'Макет', snapshot: SNAPSHOT, baseVersion: 1 })).status, 409, 'a save from an older version conflicts');
    assert.equal((await anna('PUT', '/api/files/..%2Fescape', { name: 'x', snapshot: SNAPSHOT })).status, 400);

    // Boris sees nothing of Anna's and cannot overwrite it.
    assert.deepEqual((await boris('GET', '/api/files')).body!.files, []);
    assert.equal((await boris('GET', '/api/files/fileA0001')).status, 404);
    assert.equal((await boris('PUT', '/api/files/fileA0001', { name: 'взлом', snapshot: SNAPSHOT })).status, 404);

    const list = await anna('GET', '/api/files');
    assert.deepEqual(list.body!.files.map((f: { id: string }) => f.id), ['fileA0001']);
    assert.equal(list.body!.files[0].kind, undefined, 'a design has no kind');
    // A board (FEAT-083) is known by its document: the list says so for the card.
    const board = JSON.stringify({ version: 1, nodes: [{ id: 'r', parent: null, props: { name: 'Доска', fileKind: 'BOARD' } }] });
    assert.equal((await anna('PUT', '/api/files/fileB0001', { name: 'Доска', snapshot: board })).body!.file.kind, 'board');
    // A diagram drawn from text (FEAT-090) too.
    const diagram = JSON.stringify({ version: 1, nodes: [{ id: 'r', parent: null, props: { name: 'Схема', fileKind: 'DIAGRAM' } }] });
    assert.equal((await anna('PUT', '/api/files/fileD0001', { name: 'Схема', snapshot: diagram })).body!.file.kind, 'diagram');
    assert.equal((await anna('GET', '/api/files')).body!.files.find((f: { id: string }) => f.id === 'fileB0001').kind, 'board');
    await anna('DELETE', '/api/files/fileB0001');
    const renamed = await anna('PATCH', '/api/files/fileA0001', { name: 'Главный экран' });
    assert.equal(renamed.body!.file.name, 'Главный экран');
    const opened = await anna('GET', '/api/files/fileA0001');
    assert.equal(JSON.parse(opened.body!.snapshot).nodes[0].props.name, 'Главный экран', 'the name inside the document follows');
    assert.equal((await anna('DELETE', '/api/files/fileA0001')).status, 200);
    assert.equal((await anna('GET', '/api/files/fileA0001')).status, 404);
  } finally {
    await stop();
  }
});

test('API: closed registration admits only the first account', async () => {
  const { base, stop } = await start(false);
  try {
    assert.equal((await client(base)('POST', '/api/auth/register', { email: 'owner@example.com', password: '12345678', name: 'Владелец', consent: true })).status, 200);
    assert.equal((await client(base)('POST', '/api/auth/register', { email: 'other@example.com', password: '12345678', name: 'Другой', consent: true })).status, 403);
  } finally {
    await stop();
  }
});

test('API: password reset by a code from the letter', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    await signUp(owner, letters, 'Ann@Example.com', 'old password', 'Аня <b>');
    letters.length = 0;
    const unknown = await client(base)('POST', '/api/auth/forgot', { email: 'nobody@example.com' });
    assert.equal(unknown.status, 200, 'same answer for an unknown email');
    assert.equal(letters.length, 0);

    const api = client(base);
    assert.equal((await api('POST', '/api/auth/forgot', { email: 'ann@example.com' })).status, 200);
    assert.equal(letters.length, 1);
    const letter = letters[0]!;
    assert.equal(letter.to, 'ann@example.com');
    assert.match(letter.subject, /Симметрика/);
    assert.match(letter.html, /Аня &#60;b&#62;/, 'name is escaped');
    const code = /(\d{6})/.exec(letter.text)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';

    assert.equal((await api('POST', '/api/auth/reset', { email: 'ann@example.com', code: wrong, password: 'new password' })).body!.error, 'bad_code');
    assert.equal((await api('POST', '/api/auth/reset', { email: 'ann@example.com', code, password: 'short' })).body!.error, 'bad_password');
    const ok = await api('POST', '/api/auth/reset', { email: 'ann@example.com', code, password: 'new password' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body!.user.email, 'ann@example.com');
    assert.equal((await api('GET', '/api/me')).status, 200, 'signed in after reset');
    assert.equal((await owner('GET', '/api/me')).status, 401, 'other sessions ended');
    assert.equal((await api('POST', '/api/auth/reset', { email: 'ann@example.com', code, password: 'another one' })).body!.error, 'bad_code', 'code works once');
    assert.equal((await client(base)('POST', '/api/auth/login', { email: 'ann@example.com', password: 'old password' })).status, 401);
    assert.equal((await client(base)('POST', '/api/auth/login', { email: 'ann@example.com', password: 'new password' })).status, 200);

    // Five wrong guesses burn the code.
    await api('POST', '/api/auth/forgot', { email: 'ann@example.com' });
    const second = /(\d{6})/.exec(letters[1]!.text)![1]!;
    const bad = second === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await api('POST', '/api/auth/reset', { email: 'ann@example.com', code: bad, password: 'new password 2' });
    assert.equal((await api('POST', '/api/auth/reset', { email: 'ann@example.com', code: second, password: 'new password 2' })).body!.error, 'bad_code');
    // A third request within the hour is refused.
    assert.equal((await api('POST', '/api/auth/forgot', { email: 'ann@example.com' })).status, 200);
    assert.equal((await api('POST', '/api/auth/forgot', { email: 'ann@example.com' })).status, 429);
  } finally {
    await stop();
  }
});

test('API: a failed letter is reported and leaves no code behind', async () => {
  const { base, stop } = await start(true, async () => {
    throw new Error('smtp down');
  });
  try {
    const api = client(base);
    const reg = await api('POST', '/api/auth/register', { email: 'b@example.com', password: 'password1', name: 'B', consent: true });
    assert.equal(reg.status, 502);
    assert.equal(reg.body!.error, 'mail_failed');
    // No letter — no account: the same address can try again.
    assert.equal((await api('POST', '/api/auth/login', { email: 'b@example.com', password: 'password1' })).status, 401);
  } finally {
    await stop();
  }
});

test('mail: SMTP dialogue with AUTH LOGIN, multipart message, dot-stuffing', async () => {
  const seen: string[] = [];
  let data = '';
  const smtp = createTcpServer((sock: Socket) => {
    sock.setEncoding('utf8');
    let inData = false;
    let buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        sock.write('250 queued\r\n');
      }
      let i;
      while (!inData && (i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        seen.push(line);
        if (line.startsWith('EHLO')) sock.write('250-test\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN' || seen.length === 3) sock.write('334 ok\r\n');
        else if (seen.length === 4) sock.write('235 ok\r\n');
        else if (line === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (line === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  try {
    const port = (smtp.address() as AddressInfo).port;
    const send = smtpMailer({ host: '127.0.0.1', port, secure: 'none', user: 'u@typehero.online', pass: 'secret', from: 'u@typehero.online', fromName: 'Canvas Studio' });
    const letter = codeLetter({ to: 'x@example.com', name: 'Икс', code: '123456', purpose: 'reset', appUrl: 'https://canvas.example.com' });
    await send({ ...letter, text: letter.text + '\n.dot line' });
    assert.deepEqual(seen.slice(0, 7), ['EHLO canvas-studio', 'AUTH LOGIN', Buffer.from('u@typehero.online').toString('base64'), Buffer.from('secret').toString('base64'), 'MAIL FROM:<u@typehero.online>', 'RCPT TO:<x@example.com>', 'DATA']);
    assert.match(data, /^From: =\?UTF-8\?B\?[^?]+\?= <u@typehero\.online>\r\n/);
    assert.match(data, /multipart\/alternative/);
    const parts = [...data.matchAll(/base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map((m) => Buffer.from(m[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'));
    assert.match(parts[0]!, /123456[\s\S]*\n\.dot line/);
    assert.match(parts[1]!, /Симметри[\s\S]*123456[\s\S]*canvas\.example\.com/);
  } finally {
    smtp.close();
  }
});

test('API: registration needs the code from the welcome letter', async () => {
  const { base, stop, letters } = await start();
  try {
    const api = client(base);
    const reg = await api('POST', '/api/auth/register', { email: 'Vera@Example.com', password: 'password1', name: 'Вера', consent: true });
    assert.equal(reg.status, 200);
    assert.deepEqual(reg.body, { pending: true, email: 'vera@example.com' });
    assert.equal(reg.setCookie, null, 'no session before the address is confirmed');
    assert.equal(letters.length, 1);
    assert.match(letters[0]!.subject, /Подтвердите почту/);
    assert.equal((await api('GET', '/api/me')).status, 401);

    // The right password is not enough yet; a new code is sent.
    const early = await api('POST', '/api/auth/login', { email: 'vera@example.com', password: 'password1' });
    assert.equal(early.status, 403);
    assert.equal(early.body!.error, 'unverified');
    assert.equal(letters.length, 2);
    const stale = /(\d{6})/.exec(letters[0]!.text)![1]!;
    const code = codeFor(letters, 'vera@example.com');
    if (stale !== code) assert.equal((await api('POST', '/api/auth/verify', { email: 'vera@example.com', code: stale })).body!.error, 'bad_code', 'an older code stops working');

    // Registering the pending address again (say, someone else typed it) replaces the details and mails a new code.
    assert.equal((await client(base)('POST', '/api/auth/register', { email: 'vera@example.com', password: 'other password', name: 'Не Вера', consent: true })).status, 200);
    const fresh = codeFor(letters, 'vera@example.com');
    const ok = await api('POST', '/api/auth/verify', { email: 'vera@example.com', code: fresh });
    assert.equal(ok.status, 200);
    assert.equal(ok.body!.user.name, 'Не Вера');
    assert.match(ok.setCookie!, /^cs_session=/);
    assert.equal((await api('GET', '/api/me')).status, 200);
    assert.equal((await api('POST', '/api/auth/verify', { email: 'vera@example.com', code: fresh })).body!.error, 'bad_code', 'code works once');
    assert.equal((await client(base)('POST', '/api/auth/register', { email: 'vera@example.com', password: 'password1', name: 'X', consent: true })).status, 409, 'confirmed address is taken');

    // Resend: same answer for anyone, letters only for pending accounts.
    const before = letters.length;
    assert.equal((await api('POST', '/api/auth/resend', { email: 'vera@example.com' })).status, 200);
    assert.equal((await api('POST', '/api/auth/resend', { email: 'nobody@example.com' })).status, 200);
    assert.equal(letters.length, before);
  } finally {
    await stop();
  }
});

test('API: accounts made before email checks keep working', async () => {
  const { base, dataDir, stop } = await start();
  try {
    const users = new JsonStore<Record<string, unknown>>(join(dataDir, 'users'));
    await users.put('uOldAccount1', { id: 'uOldAccount1', email: 'old@example.com', name: 'Старый', password: await hashPassword('password1'), createdAt: 1 });
    assert.equal((await client(base)('POST', '/api/auth/login', { email: 'old@example.com', password: 'password1' })).status, 200);
  } finally {
    await stop();
  }
});

test('API: projects group files; deleting a project keeps its files in Drafts', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    const boris = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    await signUp(boris, letters, 'boris@example.com', '12345678', 'Борис');
    assert.equal((await anna('POST', '/api/projects', { name: '  ' })).status, 400);
    const p = (await anna('POST', '/api/projects', { name: 'Сайт' })).body!.project;
    assert.match(p.id, /^p/);
    assert.deepEqual((await anna('GET', '/api/projects')).body!.projects.map((x: { name: string }) => x.name), ['Сайт']);
    assert.deepEqual((await boris('GET', '/api/projects')).body!.projects, [], 'projects are private');

    const inProject = await anna('PUT', '/api/files/fileP0001', { name: 'Главная', snapshot: SNAPSHOT, projectId: p.id });
    assert.equal(inProject.body!.file.projectId, p.id);
    assert.equal((await anna('PUT', '/api/files/fileD0001', { name: 'Черновик', snapshot: SNAPSHOT })).body!.file.projectId, null);
    assert.equal((await boris('PUT', '/api/files/fileB0001', { name: 'x', snapshot: SNAPSHOT, projectId: p.id })).status, 404, 'not into someone else\'s project');

    const moved = await anna('PATCH', '/api/files/fileD0001', { projectId: p.id });
    assert.equal(moved.body!.file.projectId, p.id);
    assert.equal(moved.body!.file.version, 1, 'moving is not an edit');
    assert.equal((await anna('PATCH', '/api/files/fileD0001', { projectId: null })).body!.file.projectId, null);
    assert.equal((await boris('PATCH', `/api/projects/${p.id}`, { name: 'взлом' })).status, 404);
    assert.equal((await anna('PATCH', `/api/projects/${p.id}`, { name: 'Сайт 2.0' })).body!.project.name, 'Сайт 2.0');

    const del = await anna('DELETE', `/api/projects/${p.id}`);
    assert.equal(del.body!.moved, 1);
    const files = (await anna('GET', '/api/files')).body!.files as { id: string; projectId: string | null }[];
    assert.deepEqual(files.map((f) => [f.id, f.projectId]).sort(), [['fileD0001', null], ['fileP0001', null]]);
  } finally {
    await stop();
  }
});

test('API: file previews are private images', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    const boris = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    await signUp(boris, letters, 'boris@example.com', '12345678', 'Борис');
    await anna('PUT', '/api/files/fileA0001', { name: 'Макет', snapshot: SNAPSHOT });
    assert.equal((await anna('GET', '/api/files/fileA0001/thumbnail')).status, 404);
    // The smallest valid PNG header is enough for the check.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    assert.equal((await anna('PUT', '/api/files/fileA0001/thumbnail', { image: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400, 'no SVG (scripts)');
    assert.equal((await anna('PUT', '/api/files/fileA0001/thumbnail', { image: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}` })).status, 400);
    const put = await anna('PUT', '/api/files/fileA0001/thumbnail', { image: `data:image/png;base64,${png.toString('base64')}` });
    assert.equal(put.status, 200);
    assert.ok(put.body!.file.thumbAt > 0);
    assert.equal(put.body!.file.version, 1, 'a preview is not an edit');
    assert.equal((await boris('GET', '/api/files/fileA0001/thumbnail')).status, 404);
    assert.equal((await boris('PUT', '/api/files/fileA0001/thumbnail', { image: `data:image/png;base64,${png.toString('base64')}` })).status, 404);
  } finally {
    await stop();
  }
});

test('sharing: roles decide who may open, save, rename, move and delete', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const ed = client(base);
    const viewer = client(base);
    const stranger = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    await signUp(viewer, letters, 'vi@example.com', '12345678', 'Вика');
    await signUp(stranger, letters, 'st@example.com', '12345678', 'Стас');
    await owner('PUT', '/api/files/fShared001', { name: 'Макет', snapshot: SNAPSHOT });
    assert.equal((await ed('POST', '/api/files/fShared001/share/invite', { email: 'vi@example.com', role: 'viewer' })).status, 404, 'no access — no file');

    const inv = await owner('POST', '/api/files/fShared001/share/invite', { email: 'ed@example.com', role: 'editor' });
    assert.equal(inv.status, 200);
    assert.deepEqual(inv.body!.members.map((m: { email: string; role: string }) => [m.email, m.role]), [['ed@example.com', 'editor']]);
    assert.match(letters.at(-1)!.subject, /Оля открыл\(а\) вам доступ к «Макет»/);
    assert.match(letters.at(-1)!.html, /\?file=fShared001/);
    await owner('POST', '/api/files/fShared001/share/invite', { email: 'vi@example.com', role: 'viewer' });

    // Editor: sees it in the list, saves, renames, shares on; cannot move or delete.
    const listed = (await ed('GET', '/api/files')).body!.files;
    assert.deepEqual(listed.map((f: { id: string; role: string; ownerName: string }) => [f.id, f.role, f.ownerName]), [['fShared001', 'editor', 'Оля']]);
    assert.equal(listed[0].projectId, undefined, 'the owner\'s projects are not shown to others');
    assert.equal((await ed('PUT', '/api/files/fShared001', { name: 'Макет', snapshot: SNAPSHOT, baseVersion: 1 })).status, 200);
    assert.equal((await ed('PATCH', '/api/files/fShared001', { name: 'Макет 2' })).status, 200);
    assert.equal((await ed('PATCH', '/api/files/fShared001', { projectId: null })).status, 403);
    assert.equal((await ed('DELETE', '/api/files/fShared001')).status, 403);
    assert.equal((await ed('GET', '/api/files/fShared001/share')).status, 200);

    // Viewer: opens, cannot save, rename, see the share settings.
    const opened = await viewer('GET', '/api/files/fShared001');
    assert.equal(opened.body!.role, 'viewer');
    assert.equal((await viewer('PUT', '/api/files/fShared001', { name: 'x', snapshot: SNAPSHOT })).status, 403);
    assert.equal((await viewer('PATCH', '/api/files/fShared001', { name: 'x' })).status, 403);
    assert.equal((await viewer('PUT', '/api/files/fShared001/thumbnail', { image: 'data:image/png;base64,iVBORw0KGgo=' })).status, 403);
    assert.equal((await viewer('GET', '/api/files/fShared001/share')).status, 403);
    // A stranger cannot tell the file exists.
    assert.equal((await stranger('GET', '/api/files/fShared001')).status, 404);
    assert.equal((await stranger('PUT', '/api/files/fShared001', { name: 'x', snapshot: SNAPSHOT })).status, 404);

    // Role change, leaving, removing.
    const vid = inv.body!.members[0].id as string;
    assert.equal((await owner('PATCH', `/api/files/fShared001/share/members/${vid}`, { role: 'commenter' })).body!.members.find((m: { id: string }) => m.id === vid).role, 'commenter');
    const viewerId = (await viewer('GET', '/api/me')).body!.user.id as string;
    assert.equal((await viewer('DELETE', `/api/files/fShared001/share/members/${viewerId}`)).status, 200, 'anyone may leave');
    assert.equal((await viewer('GET', '/api/files/fShared001')).status, 404);
    assert.equal((await owner('DELETE', '/api/files/fShared001')).status, 200);
  } finally {
    await stop();
  }
});

test('sharing: link for anyone — role, no account, password, expiry, reset', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const bob = client(base);
    const anon = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(bob, letters, 'bob@example.com', '12345678', 'Боб');
    await owner('PUT', '/api/files/fLinked001', { name: 'Макет', snapshot: SNAPSHOT });
    const invitedOnly = (await owner('GET', '/api/files/fLinked001/share')).body!.link;
    assert.equal(invitedOnly.mode, 'invited');

    const on = (await owner('PUT', '/api/files/fLinked001/share/link', { mode: 'anyone', role: 'editor' })).body!.link;
    assert.match(on.token, /^[A-Za-z0-9_-]{32}$/);
    const L = { 'X-CS-Link': on.token };
    assert.equal((await bob('GET', '/api/files/fLinked001')).status, 404, 'without the link — nothing');
    assert.equal((await bob('GET', '/api/files/fLinked001', undefined, { 'X-CS-Link': 'A'.repeat(32) })).status, 404, 'a wrong token — nothing');
    const viaLink = await bob('GET', '/api/files/fLinked001', undefined, L);
    assert.equal(viaLink.body!.role, 'editor');
    assert.equal(JSON.stringify(viaLink.body).includes(on.token), false, 'the token never comes back to visitors');
    assert.equal((await bob('PUT', '/api/files/fLinked001', { name: 'Макет', snapshot: SNAPSHOT }, L)).status, 200);
    // Without an account the link only shows the file.
    const anonView = await anon('GET', '/api/files/fLinked001', undefined, L);
    assert.equal(anonView.body!.role, 'viewer');
    assert.equal(anonView.body!.signedIn, false);
    assert.equal((await anon('PUT', '/api/files/fLinked001', { name: 'x', snapshot: SNAPSHOT }, L)).status, 401);

    // Password: the link alone is not enough; the proof from /unlock is.
    await owner('PUT', '/api/files/fLinked001/share/link', { password: 'тайна' });
    const locked = await anon('GET', '/api/files/fLinked001', undefined, L);
    assert.equal(locked.status, 401);
    assert.equal(locked.body!.error, 'link_password');
    assert.equal((await anon('POST', '/api/files/fLinked001/share/unlock', { token: on.token, password: 'не та' })).status, 400);
    const grant = (await anon('POST', '/api/files/fLinked001/share/unlock', { token: on.token, password: 'тайна' })).body!.grant as string;
    assert.equal((await anon('GET', '/api/files/fLinked001', undefined, { 'X-CS-Link': `${on.token}.${grant}` })).status, 200);
    await owner('PUT', '/api/files/fLinked001/share/link', { password: 'другая' });
    assert.equal((await anon('GET', '/api/files/fLinked001', undefined, { 'X-CS-Link': `${on.token}.${grant}` })).status, 401, 'a new password cancels old proofs');
    await owner('PUT', '/api/files/fLinked001/share/link', { password: null });

    // Reset: old copies of the link stop working.
    const reset = (await owner('PUT', '/api/files/fLinked001/share/link', { reset: true })).body!.link;
    assert.notEqual(reset.token, on.token);
    assert.equal((await anon('GET', '/api/files/fLinked001', undefined, L)).status, 404);
    // Expiry and "invited only".
    assert.equal((await owner('PUT', '/api/files/fLinked001/share/link', { expiresInDays: 3 })).status, 400);
    assert.ok((await owner('PUT', '/api/files/fLinked001/share/link', { expiresInDays: 7 })).body!.link.expiresAt > Date.now());
    await owner('PUT', '/api/files/fLinked001/share/link', { mode: 'invited' });
    assert.equal((await anon('GET', '/api/files/fLinked001', undefined, { 'X-CS-Link': reset.token })).status, 404);
  } finally {
    await stop();
  }
});

test('sharing: a board may let guests without an account edit by an open link; a design may not (FEAT-088)', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const anon = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    const board = JSON.stringify({ version: 1, nodes: [{ id: 'r', parent: null, props: { name: 'Ретро', fileKind: 'BOARD' } }] });
    await owner('PUT', '/api/files/fBoard0001', { name: 'Ретро', snapshot: board });
    await owner('PUT', '/api/files/fDesign001', { name: 'Макет', snapshot: SNAPSHOT });

    const on = (await owner('PUT', '/api/files/fBoard0001/share/link', { mode: 'anyone', role: 'editor', guests: true })).body!.link;
    assert.equal(on.guests, true);
    const L = { 'X-CS-Link': on.token };
    assert.equal((await anon('GET', '/api/files/fBoard0001', undefined, L)).body!.role, 'editor', 'a guest edits the board');
    // The link's role still rules: "can view" — guests view.
    await owner('PUT', '/api/files/fBoard0001/share/link', { role: 'viewer' });
    assert.equal((await anon('GET', '/api/files/fBoard0001', undefined, L)).body!.role, 'viewer');
    await owner('PUT', '/api/files/fBoard0001/share/link', { role: 'editor' });
    assert.equal((await owner('GET', '/api/files/fBoard0001/share')).body!.link.guests, true, 'kept through other changes');
    await owner('PUT', '/api/files/fBoard0001/share/link', { guests: false });
    assert.equal((await anon('GET', '/api/files/fBoard0001', undefined, L)).body!.role, 'viewer', 'turned off — viewing only');
    assert.equal((await owner('PUT', '/api/files/fBoard0001/share/link', { guests: 'yes' })).status, 400);

    // A design keeps a name behind every change: the flag is not kept.
    const design = (await owner('PUT', '/api/files/fDesign001/share/link', { mode: 'anyone', role: 'editor', guests: true })).body!.link;
    assert.equal(design.guests, false);
    assert.equal((await anon('GET', '/api/files/fDesign001', undefined, { 'X-CS-Link': design.token })).body!.role, 'viewer');
  } finally {
    await stop();
  }
});

test('sharing: an invitation to an address without an account turns into access after sign-up', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await owner('PUT', '/api/files/fInvite001', { name: 'Макет', snapshot: SNAPSHOT });
    const share = await owner('POST', '/api/files/fInvite001/share/invite', { email: 'New@Example.com', role: 'commenter' });
    assert.deepEqual(share.body!.invites.map((i: { email: string; role: string }) => [i.email, i.role]), [['new@example.com', 'commenter']]);
    assert.match(letters.at(-1)!.text, /зарегистрируйтесь/);
    assert.equal((await owner('POST', '/api/files/fInvite001/share/invite', { email: 'owner@example.com' })).status, 400, 'not the owner');

    const newcomer = client(base);
    await signUp(newcomer, letters, 'new@example.com', '12345678', 'Нина');
    const files = (await newcomer('GET', '/api/files')).body!.files;
    assert.deepEqual(files.map((f: { id: string; role: string }) => [f.id, f.role]), [['fInvite001', 'commenter']]);
    const after = (await owner('GET', '/api/files/fInvite001/share')).body!;
    assert.deepEqual(after.invites, []);
    assert.deepEqual(after.members.map((m: { email: string }) => m.email), ['new@example.com']);
  } finally {
    await stop();
  }
});

test('teams: members see the team projects and files with their team role; admins invite, change roles, remove; deleting keeps the files', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const ed = client(base);
    const vi = client(base);
    const stranger = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    await signUp(vi, letters, 'vi@example.com', '12345678', 'Вика');
    await signUp(stranger, letters, 'st@example.com', '12345678', 'Стас');
    const edId = (await ed('GET', '/api/me')).body!.user.id as string;
    const viId = (await vi('GET', '/api/me')).body!.user.id as string;

    assert.equal((await owner('POST', '/api/teams', { name: '  ' })).status, 400);
    const team = (await owner('POST', '/api/teams', { name: 'Продукт' })).body!.team;
    assert.equal(team.role, 'owner');
    const t = team.id as string;
    const inv = await owner('POST', `/api/teams/${t}/invite`, { email: 'ed@example.com', role: 'editor' });
    assert.equal(inv.status, 200);
    assert.deepEqual(inv.body!.team.members.map((m: { email: string; role: string }) => [m.email, m.role]), [['owner@example.com', 'owner'], ['ed@example.com', 'editor']]);
    assert.match(letters.at(-1)!.subject, /Оля пригласил\(а\) вас в команду «Продукт»/);
    await owner('POST', `/api/teams/${t}/invite`, { email: 'vi@example.com', role: 'viewer' });
    assert.equal((await owner('POST', `/api/teams/${t}/invite`, { email: 'owner@example.com' })).status, 400, 'the owner is in already');
    assert.equal((await stranger('GET', `/api/teams`)).body!.teams.length, 0);
    assert.equal((await stranger('POST', `/api/teams/${t}/invite`, { email: 'st@example.com' })).status, 404, 'no team for outsiders');
    assert.equal((await ed('POST', `/api/teams/${t}/invite`, { email: 'st@example.com' })).status, 403, 'editors do not invite');
    assert.equal((await ed('GET', '/api/teams')).body!.teams[0].invites, undefined, 'invitations are for admins');

    // Projects: editors make them, viewers do not; members see them, outsiders do not.
    const project = (await ed('POST', '/api/projects', { name: 'Сайт', teamId: t })).body!.project;
    assert.equal(project.teamId, t);
    assert.equal((await vi('POST', '/api/projects', { name: 'x', teamId: t })).status, 403);
    assert.equal((await stranger('POST', '/api/projects', { name: 'x', teamId: t })).status, 404);
    assert.deepEqual((await vi('GET', '/api/projects')).body!.projects.map((p: { name: string }) => p.name), ['Сайт']);
    assert.deepEqual((await stranger('GET', '/api/projects')).body!.projects, []);

    // A file made in the team project: every member has it with the team role.
    assert.equal((await vi('PUT', '/api/files/fTeam00001', { name: 'x', snapshot: SNAPSHOT, projectId: project.id })).status, 403, 'viewers make no files');
    assert.equal((await ed('PUT', '/api/files/fTeam00001', { name: 'Главная', snapshot: SNAPSHOT, projectId: project.id })).status, 200);
    const seen = (await vi('GET', '/api/files')).body!.files;
    assert.deepEqual(seen.map((f: { id: string; role: string; projectId: string }) => [f.id, f.role, f.projectId]), [['fTeam00001', 'viewer', project.id]]);
    assert.equal((await owner('GET', '/api/files')).body!.files[0].role, 'owner', 'the team owner manages team files');
    assert.equal((await vi('PUT', '/api/files/fTeam00001', { name: 'x', snapshot: SNAPSHOT })).status, 403);
    assert.equal((await owner('PUT', '/api/files/fTeam00001', { name: 'Главная', snapshot: SNAPSHOT, baseVersion: 1 })).status, 200);
    assert.equal((await stranger('GET', '/api/files/fTeam00001')).status, 404);
    assert.equal((await vi('GET', '/api/files/fTeam00001')).body!.team.name, 'Продукт');
    assert.equal((await ed('GET', '/api/files/fTeam00001/share')).body!.team.people, 3);
    // Everyone in the team can be called with @.
    const people = (await ed('GET', '/api/files/fTeam00001/people')).body!.people.map((p: { name: string }) => p.name).sort();
    assert.deepEqual(people, ['Вика', 'Оля', 'Эд']);

    // Moving: one's own file into the team; another's file never into one's own project.
    await vi('PUT', '/api/files/fViOwn0001', { name: 'Моё', snapshot: SNAPSHOT });
    assert.equal((await vi('PATCH', '/api/files/fViOwn0001', { projectId: project.id })).status, 403, 'a team viewer cannot put files into the team');
    const own = (await owner('POST', '/api/projects', { name: 'Личное' })).body!.project;
    assert.equal((await owner('PATCH', '/api/files/fTeam00001', { projectId: own.id })).status, 403, 'another\'s file stays out of one\'s own projects');

    // Roles: an admin changes them, the change counts at once; the owner cannot be removed.
    assert.equal((await owner('PATCH', `/api/teams/${t}/members/${viId}`, { role: 'admin' })).status, 200);
    assert.equal((await vi('GET', '/api/files/fTeam00001')).body!.role, 'owner');
    assert.equal((await vi('POST', `/api/teams/${t}/invite`, { email: 'new@example.com', role: 'commenter' })).status, 200);
    assert.equal((await vi('GET', '/api/teams')).body!.teams[0].invites.length, 1);
    const ownerId = (await owner('GET', '/api/me')).body!.user.id as string;
    assert.equal((await vi('DELETE', `/api/teams/${t}/members/${ownerId}`)).status, 400);
    assert.equal((await vi('DELETE', `/api/teams/${t}`)).status, 403, 'only the owner deletes the team');
    assert.equal((await vi('DELETE', `/api/teams/${t}/members/${edId}`)).status, 200);
    assert.equal((await ed('GET', '/api/files')).body!.files.length, 1, 'a removed member keeps only the files they made');
    assert.equal((await ed('GET', '/api/projects')).body!.projects.length, 0);
    assert.equal((await vi('DELETE', `/api/teams/${t}/members/${viId}`)).status, 200, 'anyone may leave');
    assert.equal((await vi('GET', '/api/files/fTeam00001')).status, 404);

    // A newcomer joins on sign-up.
    const nina = client(base);
    await signUp(nina, letters, 'new@example.com', '12345678', 'Нина');
    assert.equal((await nina('GET', '/api/teams')).body!.teams[0].role, 'commenter');
    assert.equal((await nina('GET', '/api/files/fTeam00001')).body!.role, 'commenter');

    // Deleting the team: projects go, files stay with the people who made them, in Drafts.
    const gone = await owner('DELETE', `/api/teams/${t}`);
    assert.deepEqual(gone.body, { ok: true, moved: 1 });
    assert.equal((await nina('GET', '/api/files/fTeam00001')).status, 404);
    const kept = (await ed('GET', '/api/files')).body!.files;
    assert.deepEqual(kept.map((f: { id: string; projectId: string | null }) => [f.id, f.projectId]), [['fTeam00001', null]]);
  } finally {
    await stop();
  }
});

test('account deletion: own files go, team files and teams stay with the team, the password confirms it', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    const ed = client(base);
    const vi = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    await signUp(vi, letters, 'vi@example.com', '12345678', 'Вика');

    // Anna: a file of her own shared with Vika, a team with Ed (editor) and Vika (viewer), a file in it.
    await anna('PUT', '/api/files/fAnnaOwn01', { name: 'Моё', snapshot: SNAPSHOT });
    await anna('POST', '/api/files/fAnnaOwn01/share/invite', { email: 'vi@example.com', role: 'viewer' });
    const t = (await anna('POST', '/api/teams', { name: 'Продукт' })).body!.team.id as string;
    await anna('POST', `/api/teams/${t}/invite`, { email: 'vi@example.com', role: 'viewer' });
    await anna('POST', `/api/teams/${t}/invite`, { email: 'ed@example.com', role: 'editor' });
    const project = (await anna('POST', '/api/projects', { name: 'Сайт', teamId: t })).body!.project;
    await anna('PUT', '/api/files/fAnnaTeam1', { name: 'Командный', snapshot: SNAPSHOT, projectId: project.id });
    // A team of her own with nobody else in it goes away.
    await anna('POST', '/api/teams', { name: 'Черновики' });
    // Ed's file that Anna can edit.
    await ed('PUT', '/api/files/fEdOwn0001', { name: 'Эда', snapshot: SNAPSHOT });
    await ed('POST', '/api/files/fEdOwn0001/share/invite', { email: 'anna@example.com', role: 'editor' });

    const preview = (await anna('GET', '/api/me/deletion')).body!;
    assert.deepEqual(preview, { files: 1, shared: 1, keptInTeams: 1, teamsHandedOver: [{ team: 'Продукт', to: 'Эд' }], teamsDeleted: ['Черновики'] });

    assert.equal((await anna('DELETE', '/api/me', { password: 'не тот' })).status, 403);
    assert.equal((await anna('GET', '/api/me')).status, 200, 'a wrong password deletes nothing');
    const done = await anna('DELETE', '/api/me', { password: '12345678' });
    assert.equal(done.status, 200);
    assert.match(done.setCookie!, /Max-Age=0/);

    assert.equal((await anna('GET', '/api/me')).status, 401);
    assert.equal((await anna('POST', '/api/auth/login', { email: 'anna@example.com', password: '12345678' })).status, 401);
    assert.equal((await vi('GET', '/api/files/fAnnaOwn01')).status, 404, 'her own file is gone for those she shared it with');
    const teams = (await ed('GET', '/api/teams')).body!.teams;
    assert.deepEqual(teams.map((x: { name: string; role: string }) => [x.name, x.role]), [['Продукт', 'owner']], 'the senior member got the team');
    const teamFile = (await ed('GET', '/api/files')).body!.files.find((f: { id: string }) => f.id === 'fAnnaTeam1');
    assert.equal(teamFile.role, 'owner', 'the team file stays, with the new owner');
    assert.equal((await vi('GET', '/api/files/fAnnaTeam1')).status, 200, 'and the team still sees it');
    const share = (await ed('GET', '/api/files/fEdOwn0001/share')).body!;
    assert.deepEqual(share.members, [], 'she is gone from the files of others');
    // The address is free again.
    assert.equal((await anna('POST', '/api/auth/register', { email: 'anna@example.com', password: '12345678', name: 'Анна', consent: true })).status, 200);
  } finally {
    await stop();
  }
});

test('branches: editors make them, they are hidden from the list, open to the people of the main file, keep the common ancestor, are marked merged and go after 30 days', async () => {
  const { base, stop, letters, api: server } = await start();
  try {
    const owner = client(base);
    const ed = client(base);
    const vi = client(base);
    const stranger = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    await signUp(vi, letters, 'vi@example.com', '12345678', 'Вика');
    await signUp(stranger, letters, 'st@example.com', '12345678', 'Стас');
    await owner('PUT', '/api/files/fMain00001', { name: 'Сайт', snapshot: SNAPSHOT });
    await owner('POST', '/api/files/fMain00001/share/invite', { email: 'ed@example.com', role: 'editor' });
    await owner('POST', '/api/files/fMain00001/share/invite', { email: 'vi@example.com', role: 'viewer' });

    assert.equal((await vi('POST', '/api/files/fMain00001/branches', { name: 'x' })).status, 403, 'viewers make no branches');
    assert.equal((await ed('POST', '/api/files/fMain00001/branches', { name: ' ' })).status, 400);
    const made = await ed('POST', '/api/files/fMain00001/branches', { name: 'Новая шапка', description: 'Пробуем' });
    assert.equal(made.status, 200);
    const id = made.body!.branch.id as string;

    // Not in the lists; the main file says how many branches it has.
    const listed = (await owner('GET', '/api/files')).body!.files;
    assert.deepEqual(listed.map((f: { id: string; branches?: number }) => [f.id, f.branches]), [['fMain00001', 1]]);
    // People of the main file have the branch with their role there; its author owns it; others do not see it.
    assert.equal((await vi('GET', `/api/files/${id}`)).body!.role, 'viewer');
    assert.equal((await owner('GET', `/api/files/${id}`)).body!.role, 'owner');
    assert.equal((await ed('GET', `/api/files/${id}`)).body!.role, 'owner');
    assert.equal((await stranger('GET', `/api/files/${id}`)).status, 404);
    const opened = (await vi('GET', `/api/files/${id}`)).body!;
    assert.deepEqual([opened.branch.of, opened.branch.mainName, opened.branch.description, opened.branch.author], ['fMain00001', 'Сайт', 'Пробуем', 'Эд']);
    assert.equal((await ed('POST', `/api/files/${id}/branches`, { name: 'x' })).status, 400, 'no branches of branches');
    assert.equal((await ed('PATCH', `/api/files/${id}`, { projectId: null })).status, 400, 'a branch stays where its main file is');

    // The branch: the common ancestor and the main file's role.
    const info = (await vi('GET', `/api/files/${id}/branch`)).body!;
    assert.equal(JSON.parse(info.base).nodes[0].id, 'r');
    assert.deepEqual(info.main, { id: 'fMain00001', name: 'Сайт', role: 'viewer' });
    assert.equal((await vi('PUT', `/api/files/${id}/branch/base`, { snapshot: SNAPSHOT })).status, 403);
    const newer = JSON.stringify({ version: 1, nodes: [{ id: 'r', parent: null, props: { name: 'Новее' } }], blobs: { abc: { mime: 'image/png', data: 'AAAA' } } });
    assert.equal((await ed('PUT', `/api/files/${id}/branch/base`, { snapshot: newer })).status, 200);
    const stored = JSON.parse((await ed('GET', `/api/files/${id}/branch`)).body!.base);
    assert.equal(stored.nodes[0].props.name, 'Новее');
    assert.equal(stored.blobs, undefined, 'the ancestor is kept without pictures');
    assert.ok((await vi('GET', '/api/files/fMain00001/fresh')).body!.snapshot);

    // Merged: only editors of the main file mark it; the list of branches says so.
    assert.equal((await vi('POST', `/api/files/fMain00001/branches/${id}/merged`, { before: 'v000000000001', after: 'v000000000002' })).status, 403);
    assert.equal((await ed('POST', `/api/files/fMain00001/branches/${id}/merged`, { before: 'x', after: 'y' })).status, 400);
    assert.equal((await ed('POST', `/api/files/fMain00001/branches/${id}/merged`, { before: 'v000000000001', after: 'v000000000002' })).status, 200);
    const branches = (await vi('GET', '/api/files/fMain00001/branches')).body!.branches;
    assert.deepEqual(branches.map((b: { name: string; merged?: { before: string } }) => [b.name, b.merged?.before]), [['Новая шапка', 'v000000000001']]);
    assert.equal((await owner('GET', '/api/files')).body!.files[0].branches, undefined, 'merged branches are not counted');
    await ed('POST', `/api/files/fMain00001/branches/${id}/unmerged`, {});
    assert.equal((await vi('GET', '/api/files/fMain00001/branches')).body!.branches[0].merged, undefined);
    await ed('POST', `/api/files/fMain00001/branches/${id}/merged`, { before: 'v000000000001', after: 'v000000000002' });
    assert.equal(await server.sweepBranches(), 0, 'kept for 30 days');
    assert.equal(await server.sweepBranches(Date.now() + 31 * 86_400_000), 1);
    assert.equal((await ed('GET', `/api/files/${id}`)).status, 404);

    // Deleting the main file deletes its branches.
    const second = (await ed('POST', '/api/files/fMain00001/branches', { name: 'Вторая' })).body!.branch.id as string;
    assert.equal((await owner('DELETE', '/api/files/fMain00001')).status, 200);
    assert.equal((await ed('GET', `/api/files/${second}`)).status, 404);
  } finally {
    await stop();
  }
});

test('branch review: reviewers from the people of the main file, letters both ways, verdicts; comments go to the main file at a merge', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const ed = client(base);
    const vi = client(base);
    const stranger = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    await signUp(vi, letters, 'vi@example.com', '12345678', 'Вика');
    await signUp(stranger, letters, 'st@example.com', '12345678', 'Стас');
    const id = async (api: ReturnType<typeof client>) => (await api('GET', '/api/me')).body!.user.id as string;
    const [ownerId, viId, stId] = [await id(owner), await id(vi), await id(stranger)];
    await owner('PUT', '/api/files/fMainRev01', { name: 'Сайт', snapshot: SNAPSHOT });
    await owner('POST', '/api/files/fMainRev01/share/invite', { email: 'ed@example.com', role: 'editor' });
    await owner('POST', '/api/files/fMainRev01/share/invite', { email: 'vi@example.com', role: 'viewer' });
    const branch = (await ed('POST', '/api/files/fMainRev01/branches', { name: 'Шапка' })).body!.branch.id as string;

    // In the branch, the people are those of the main file (for @ and for reviewers).
    const people = (await ed('GET', `/api/files/${branch}/people`)).body!.people.map((p: { name: string }) => p.name).sort();
    assert.deepEqual(people, ['Вика', 'Оля', 'Эд']);

    assert.equal((await vi('POST', `/api/files/${branch}/review`, { reviewers: [ownerId] })).status, 403, 'viewers do not ask for reviews');
    assert.equal((await ed('POST', `/api/files/${branch}/review`, { reviewers: [] })).status, 400);
    assert.equal((await ed('POST', `/api/files/${branch}/review`, { reviewers: [stId] })).status, 400, 'not a person of the main file');
    const sent = letters.length;
    const asked = await ed('POST', `/api/files/${branch}/review`, { reviewers: [viId, ownerId], description: 'Новая шапка' });
    assert.equal(asked.status, 200);
    assert.deepEqual(asked.body!.review.reviewers.map((r: { name: string }) => r.name), ['Вика', 'Оля']);
    assert.deepEqual(letters.slice(sent).map((l) => [l.to, l.subject]), [
      ['vi@example.com', 'Эд просит посмотреть ветку «Шапка» — Симметрика'],
      ['owner@example.com', 'Эд просит посмотреть ветку «Шапка» — Симметрика'],
    ]);
    assert.match(letters.at(-1)!.text, /Новая шапка/);

    assert.equal((await stranger('POST', `/api/files/${branch}/review/verdict`, { verdict: 'approved' })).status, 404);
    assert.equal((await vi('POST', `/api/files/${branch}/review/verdict`, { verdict: 'changes' })).status, 400, 'say what to change');
    const answered = await vi('POST', `/api/files/${branch}/review/verdict`, { verdict: 'changes', note: 'Крупнее заголовок' });
    assert.equal(answered.status, 200);
    assert.deepEqual([letters.at(-1)!.to, letters.at(-1)!.subject], ['ed@example.com', 'Вика просит доработать ветку «Шапка» — Симметрика']);
    await owner('POST', `/api/files/${branch}/review/verdict`, { verdict: 'approved' });
    const review = (await vi('GET', `/api/files/${branch}`)).body!.branch.review;
    assert.deepEqual(review.reviewers.map((r: { name: string; verdict: string; note: string }) => [r.name, r.verdict, r.note]), [['Вика', 'changes', 'Крупнее заголовок'], ['Оля', 'approved', '']]);
    assert.equal((await ed('POST', `/api/files/${branch}/review/verdict`, { verdict: 'approved' })).status, 403, 'only the reviewers answer');
    // A reviewer who can only view the main file comments in the branch.
    assert.equal((await vi('GET', `/api/files/${branch}`)).body!.role, 'commenter');
    assert.equal((await vi('POST', `/api/files/${branch}/comments`, { pageId: 'p', nodeId: null, x: 5, y: 5, text: 'Мелковато' })).status, 200);
    assert.equal((await vi('GET', '/api/files/fMainRev01')).body!.role, 'viewer', 'but only there');

    // Comments of the branch are its own until the merge brings them over.
    await owner('POST', `/api/files/${branch}/comments`, { pageId: 'p', nodeId: null, x: 1, y: 2, text: 'Отступ слева?' });
    assert.equal((await owner('GET', '/api/files/fMainRev01/comments')).body!.threads.length, 0);
    assert.equal((await vi('POST', `/api/files/fMainRev01/branches/${branch}/comments`, {})).status, 403);
    assert.equal((await ed('POST', `/api/files/fMainRev01/branches/${branch}/comments`, {})).body!.carried, 2);
    const carried = (await owner('GET', '/api/files/fMainRev01/comments')).body!.threads;
    assert.deepEqual(carried.map((t: { comments: { text: string; author: string }[] }) => [t.comments[0]!.text, t.comments[0]!.author]).sort(), [['Мелковато', 'Вика'], ['Отступ слева?', 'Оля']]);

    await ed('DELETE', `/api/files/${branch}/review`);
    assert.equal((await vi('GET', `/api/files/${branch}`)).body!.branch.review, undefined);
  } finally {
    await stop();
  }
});

test('sharing: a link for everyone in the team; a restricted file is closed to the team except admins and the people of the file', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const ed = client(base);
    const vi = client(base);
    const stranger = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    await signUp(vi, letters, 'vi@example.com', '12345678', 'Вика');
    await signUp(stranger, letters, 'st@example.com', '12345678', 'Стас');
    const t = (await owner('POST', '/api/teams', { name: 'Продукт' })).body!.team.id as string;
    await owner('POST', `/api/teams/${t}/invite`, { email: 'ed@example.com', role: 'editor' });
    await owner('POST', `/api/teams/${t}/invite`, { email: 'vi@example.com', role: 'viewer' });

    // A draft of Эд shared with the team by link: team people with the link get its role, others nothing.
    await ed('PUT', '/api/files/fDraft0001', { name: 'Черновик', snapshot: SNAPSHOT });
    const offer = (await ed('GET', '/api/files/fDraft0001/share')).body!;
    assert.deepEqual(offer.teams.map((x: { name: string }) => x.name), ['Продукт']);
    assert.equal(offer.restricted, false);
    assert.equal((await ed('PUT', '/api/files/fDraft0001/share/link', { mode: 'team' })).status, 400, 'a draft needs the team named');
    const otherTeam = (await stranger('POST', '/api/teams', { name: 'Чужая' })).body!.team.id as string;
    assert.equal((await ed('PUT', '/api/files/fDraft0001/share/link', { mode: 'team', teamId: otherTeam })).status, 400, 'only one\'s own team');
    const share = (await ed('PUT', '/api/files/fDraft0001/share/link', { mode: 'team', teamId: t, role: 'commenter' })).body!;
    assert.deepEqual([share.link.mode, share.link.team.name, share.link.role], ['team', 'Продукт', 'commenter']);
    const L = { 'X-CS-Link': share.link.token as string };
    assert.equal((await vi('GET', '/api/files/fDraft0001')).status, 404, 'without the link — nothing');
    assert.equal((await vi('GET', '/api/files/fDraft0001', undefined, L)).body!.role, 'commenter');
    assert.equal((await stranger('GET', '/api/files/fDraft0001', undefined, L)).status, 403, 'not in the team — told so');
    assert.equal((await stranger('GET', '/api/files/fDraft0001', undefined, { 'X-CS-Link': 'A'.repeat(32) })).status, 404, 'a wrong token — nothing');
    assert.equal((await client(base)('GET', '/api/files/fDraft0001', undefined, L)).status, 401, 'no account — asked to sign in');
    // A password works for team links too.
    await ed('PUT', '/api/files/fDraft0001/share/link', { password: 'тайна' });
    assert.equal((await vi('GET', '/api/files/fDraft0001', undefined, L)).body!.error, 'link_password');
    assert.equal((await stranger('GET', '/api/files/fDraft0001', undefined, L)).status, 403);
    const grant = (await vi('POST', '/api/files/fDraft0001/share/unlock', { token: share.link.token, password: 'тайна' })).body!.grant as string;
    assert.equal((await vi('GET', '/api/files/fDraft0001', undefined, { 'X-CS-Link': `${share.link.token}.${grant}` })).body!.role, 'commenter');
    // Leaving the team closes the link.
    const viId = (await vi('GET', '/api/me')).body!.user.id as string;
    await vi('DELETE', `/api/teams/${t}/members/${viId}`);
    assert.equal((await vi('GET', '/api/files/fDraft0001', undefined, { 'X-CS-Link': `${share.link.token}.${grant}` })).status, 403);
    await owner('POST', `/api/teams/${t}/invite`, { email: 'vi@example.com', role: 'viewer' });

    // A restricted team file.
    const project = (await ed('POST', '/api/projects', { name: 'Сайт', teamId: t })).body!.project;
    await ed('PUT', '/api/files/fSecret001', { name: 'Секрет', snapshot: SNAPSHOT, projectId: project.id });
    assert.equal((await vi('GET', '/api/files/fSecret001')).body!.role, 'viewer');
    assert.equal((await ed('PUT', '/api/files/fDraft0001/share/restricted', { restricted: true })).status, 400, 'only team files');
    assert.equal((await vi('PUT', '/api/files/fSecret001/share/restricted', { restricted: true })).status, 403);
    const closed = (await ed('PUT', '/api/files/fSecret001/share/restricted', { restricted: true })).body!;
    assert.equal(closed.restricted, true);
    assert.equal((await vi('GET', '/api/files/fSecret001')).status, 404, 'the team no longer sees it');
    assert.deepEqual((await vi('GET', '/api/files')).body!.files.map((f: { id: string }) => f.id), []);
    assert.equal((await ed('GET', '/api/files/fSecret001')).body!.role, 'owner', 'the one who made it keeps it');
    assert.equal((await owner('GET', '/api/files/fSecret001')).body!.role, 'owner', 'team admins keep it');
    assert.deepEqual((await ed('GET', '/api/files/fSecret001/people')).body!.people.map((p: { name: string }) => p.name).sort(), ['Оля', 'Эд']);
    // Invited by name — back in, with the role given.
    await ed('POST', '/api/files/fSecret001/share/invite', { email: 'vi@example.com', role: 'commenter' });
    const listed = (await vi('GET', '/api/files')).body!.files;
    assert.deepEqual(listed.map((f: { id: string; role: string; restricted: boolean; projectId: string }) => [f.id, f.role, f.restricted, f.projectId]), [['fSecret001', 'commenter', true, project.id]]);
    // A team link still works for the team.
    const tl = (await ed('PUT', '/api/files/fSecret001/share/link', { mode: 'team', role: 'viewer' })).body!.link;
    assert.equal(tl.team.name, 'Продукт');
    assert.equal((await ed('PUT', '/api/files/fSecret001/share/link', { mode: 'team', teamId: otherTeam })).status, 400, 'a team file — only its team');
    // Opened again.
    await owner('PUT', '/api/files/fSecret001/share/restricted', { restricted: false });
    assert.equal((await ed('GET', '/api/files/fSecret001/share')).body!.restricted, false);
  } finally {
    await stop();
  }
});

test('fonts: a Google font face comes as TTF, is kept on disk, an unknown family is a 404 asked once', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-test-'));
  const asked: string[] = [];
  const ttf = new Uint8Array([0, 1, 0, 0, ...Array.from({ length: 60 }, (_, i) => i)]);
  const fontsFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith('https://fonts.gstatic.com/')) return new Response(ttf);
    if (url.includes('family=Roboto:ital,wght@0,700')) return new Response("@font-face { font-family: 'Roboto'; src: url(https://fonts.gstatic.com/s/roboto/v51/abc.ttf) format('truetype'); }");
    return new Response('bad', { status: 400 });
  }) as typeof fetch;
  const { server } = await createCanvasServer({ dataDir, root: dataDir, dev: null, secure: false, trustProxy: false, openRegistration: true, mailer: async () => undefined, fontsFetch });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const first = await fetch(`${base}/api/fonts/google?family=Roboto&weight=700`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'font/ttf');
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), ttf);
    assert.equal(asked.length, 2, 'the CSS and the file');
    assert.equal((await fetch(`${base}/api/fonts/google?family=Roboto&weight=700`)).status, 200);
    assert.equal(asked.length, 2, 'the second time from disk');
    assert.equal((await fetch(`${base}/api/fonts/google?family=Roboto&weight=700&italic=1`)).status, 404, 'no such face');
    assert.equal((await fetch(`${base}/api/fonts/google?family=SF%20Pro&weight=400`)).status, 404);
    const before = asked.length;
    assert.equal((await fetch(`${base}/api/fonts/google?family=SF%20Pro&weight=400`)).status, 404);
    assert.equal(asked.length, before, 'a missing family is not asked again at once');
    for (const bad of ['family=a%2Fb&weight=400', 'family=Roboto&weight=450', 'family=Roboto&weight=1000', 'family=&weight=400', `family=${'x'.repeat(81)}`]) {
      assert.equal((await fetch(`${base}/api/fonts/google?${bad}`)).status, 400, bad);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

/** A live connection as the editor opens it, collecting what the server sends. */
async function liveClient(base: string, fileId: string, cookie: string, hello: { version: number | null; since: number | null }) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/live/${fileId}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: base } } as unknown as string[]);
  const got: Record<string, any>[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener('message', (e: MessageEvent) => {
    got.push(JSON.parse(String(e.data)));
    for (const w of waiters.splice(0)) w();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
  ws.send(JSON.stringify({ type: 'hello', ...hello }));
  const until = async (pred: (m: Record<string, any>) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const found = got.find(pred);
      if (found) return found;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error(`no message: ${JSON.stringify(got)}`);
  };
  return { ws, got, until };
}

test('live editing: operations reach everyone in the file, viewers cannot write, the room saves the file', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    const boris = client(base);
    const vera = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    await signUp(boris, letters, 'boris@example.com', '12345678', 'Борис');
    await signUp(vera, letters, 'vera@example.com', '12345678', 'Вера');
    const { Document, serialize } = await import('../../core/src/index.ts');
    const doc = Document.createEmpty('Макет');
    await anna('PUT', '/api/files/fLive00001', { name: 'Макет', snapshot: serialize(doc) });
    await anna('POST', '/api/files/fLive00001/share/invite', { email: 'boris@example.com', role: 'editor' });
    await anna('POST', '/api/files/fLive00001/share/invite', { email: 'vera@example.com', role: 'viewer' });
    const login = async (email: string) => {
      const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email, password: '12345678' }) });
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };
    const a = await liveClient(base, 'fLive00001', await login('anna@example.com'), { version: 1, since: null });
    const b = await liveClient(base, 'fLive00001', await login('boris@example.com'), { version: 1, since: null });
    const v = await liveClient(base, 'fLive00001', await login('vera@example.com'), { version: 1, since: null });
    const peers = await a.until((m) => m.type === 'peers' && m.peers.length === 3);
    assert.deepEqual(peers.peers.map((p: { name: string; role: string }) => [p.name, p.role]).sort(), [['Анна', 'owner'], ['Борис', 'editor'], ['Вера', 'viewer']]);
    assert.equal(new Set(peers.peers.map((p: { color: string }) => p.color)).size, 3, 'everyone gets their own colour');

    // Anna renames the file: Boris and Vera get the operation, Anna gets the acknowledgement.
    const ops: unknown[] = [];
    doc.onLocalOps((o) => ops.push(...o));
    doc.transact((tx) => tx.set(doc.rootId, 'name', 'Главный экран'));
    a.ws.send(JSON.stringify({ type: 'ops', id: 1, ops }));
    assert.equal((await a.until((m) => m.type === 'ack' && m.id === 1)).seq, 1);
    const atBoris = await b.until((m) => m.type === 'ops' && m.seq === 1);
    assert.deepEqual(atBoris.ops, ops);
    await v.until((m) => m.type === 'ops' && m.seq === 1);
    assert.equal(a.got.some((m) => m.type === 'ops'), false, 'no echo to the author');

    // A viewer cannot write.
    v.ws.send(JSON.stringify({ type: 'ops', id: 7, ops }));
    assert.match((await v.until((m) => m.type === 'error' && m.id === 7)).message, /просмотр/);

    // Sharing changes apply to people already in the file: Vera may edit now, Boris loses access.
    await anna('PATCH', `/api/files/fLive00001/share/members/${peers.peers.find((p: { name: string }) => p.name === 'Вера').userId}`, { role: 'editor' });
    assert.equal((await v.until((m) => m.type === 'role')).role, 'editor');
    v.ws.send(JSON.stringify({ type: 'ops', id: 8, ops }));
    await v.until((m) => m.type === 'ack' && m.id === 8);
    await anna('DELETE', `/api/files/fLive00001/share/members/${peers.peers.find((p: { name: string }) => p.name === 'Борис').userId}`);
    await b.until((m) => m.type === 'revoked');
    await new Promise<void>((r) => (b.ws.readyState === WebSocket.CLOSED ? r() : b.ws.addEventListener('close', () => r())));
    const left = await a.until((m) => m.type === 'peers' && m.peers.some((p: { name: string }) => p.name === 'Вера') && !m.peers.some((p: { name: string }) => p.name === 'Борис'));
    assert.deepEqual(left.peers.map((p: { name: string; role: string }) => [p.name, p.role]).sort(), [['Анна', 'owner'], ['Вера', 'editor']]);
    await anna('POST', '/api/files/fLive00001/share/invite', { email: 'boris@example.com', role: 'editor' });

    // A whole-file save by HTTP would overwrite live work.
    assert.equal((await anna('PUT', '/api/files/fLive00001', { name: 'x', snapshot: serialize(doc) })).status, 409);

    // The room saves the file by itself.
    let saved: Record<string, any> | null = null;
    for (let i = 0; i < 40 && !(saved && saved.file.version > 1); i++) {
      await new Promise((r) => setTimeout(r, 100));
      saved = (await anna('GET', '/api/files/fLive00001')).body;
    }
    assert.equal(saved!.file.name, 'Главный экран');
    assert.equal(JSON.parse(saved!.snapshot).nodes.find((n: { parent: string | null }) => n.parent === null).props.name, 'Главный экран');

    // Reconnecting after missing a batch: the gap is sent; from an unknown point — the whole file.
    const late = await liveClient(base, 'fLive00001', await login('boris@example.com'), { version: null, since: 0 });
    assert.deepEqual((await late.until((m) => m.type === 'ops')).ops, ops);
    const fresh = await liveClient(base, 'fLive00001', await login('boris@example.com'), { version: null, since: null });
    assert.match((await fresh.until((m) => m.type === 'snapshot')).snapshot, /Главный экран/);

    // Another site cannot open a connection with these cookies; a stranger gets nothing.
    const evil = new WebSocket(`${base.replace('http', 'ws')}/api/live/fLive00001`, { headers: { Cookie: await login('anna@example.com'), Origin: 'https://evil.example' } } as unknown as string[]);
    assert.equal(await new Promise((r) => { evil.addEventListener('open', () => r('open')); evil.addEventListener('error', () => r('refused')); }), 'refused');
    for (const c of [a, b, v, late, fresh]) c.ws.close();
  } finally {
    await stop();
  }
});

test('live editing: pointers and selections reach the others, are cleaned and shown to newcomers', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    const { Document, serialize } = await import('../../core/src/index.ts');
    await anna('PUT', '/api/files/fPres00001', { name: 'Макет', snapshot: serialize(Document.createEmpty('Макет')) });
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email: 'anna@example.com', password: '12345678' }) });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const a = await liveClient(base, 'fPres00001', cookie, { version: 1, since: null });
    const b = await liveClient(base, 'fPres00001', cookie, { version: 1, since: null });
    await a.until((m) => m.type === 'peers' && m.peers.length === 2);
    const you = (await a.until((m) => m.type === 'welcome')).you;
    a.ws.send(JSON.stringify({ type: 'presence', page: 'p:1', cursor: { x: 10.5, y: 'oops' }, selection: ['n:1', 42], secret: 'x' }));
    const seen = await b.until((m) => m.type === 'presence');
    assert.deepEqual(seen, { type: 'presence', from: you, page: 'p:1', cursor: null, selection: ['n:1'], view: null, chat: null });
    a.ws.send(JSON.stringify({ type: 'presence', page: 'p:1', cursor: { x: 1, y: 2 }, selection: [] }));
    await b.until((m) => m.type === 'presence' && m.cursor?.x === 1);
    assert.equal(a.got.some((m) => m.type === 'presence'), false, 'own presence is not echoed');
    const c = await liveClient(base, 'fPres00001', cookie, { version: 1, since: null });
    assert.deepEqual((await c.until((m) => m.type === 'presence')).cursor, { x: 1, y: 2 }, 'a newcomer sees where the others are');
    for (const x of [a, b, c]) x.ws.close();
  } finally {
    await stop();
  }
});

test('live editing: the visible area and cursor chat are passed on; spotlight goes to everyone and ends when its author leaves', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    const { Document, serialize } = await import('../../core/src/index.ts');
    await anna('PUT', '/api/files/fSpot00001', { name: 'Макет', snapshot: serialize(Document.createEmpty('Макет')) });
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email: 'anna@example.com', password: '12345678' }) });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const a = await liveClient(base, 'fSpot00001', cookie, { version: 1, since: null });
    const b = await liveClient(base, 'fSpot00001', cookie, { version: 1, since: null });
    await a.until((m) => m.type === 'peers' && m.peers.length === 2);
    const you = (await a.until((m) => m.type === 'welcome')).you;

    a.ws.send(JSON.stringify({ type: 'presence', page: 'p:1', cursor: null, selection: [], view: { x: 5, y: 6, zoom: 2, width: 1200, height: 800 }, chat: `Привет\n${'я'.repeat(200)}` }));
    const seen = await b.until((m) => m.type === 'presence' && m.view);
    assert.deepEqual(seen.view, { x: 5, y: 6, zoom: 2, width: 1200, height: 800 });
    assert.equal(seen.chat.length, 100, 'a chat message is cut to the limit');
    assert.ok(seen.chat.startsWith('Привет '), 'line breaks become spaces');
    a.ws.send(JSON.stringify({ type: 'presence', page: 'p:1', cursor: null, selection: [], view: { x: 1, y: 1, zoom: 0, width: 10, height: 10 } }));
    assert.equal((await b.until((m) => m.type === 'presence' && m.view === null)).chat, null, 'a broken view is dropped');

    a.ws.send(JSON.stringify({ type: 'spotlight', on: true }));
    assert.equal((await b.until((m) => m.type === 'spotlight')).from, you);
    await a.until((m) => m.type === 'spotlight' && m.from === you);
    const c = await liveClient(base, 'fSpot00001', cookie, { version: 1, since: null });
    assert.equal((await c.until((m) => m.type === 'spotlight')).from, you, 'a newcomer joins the spotlight');
    b.ws.send(JSON.stringify({ type: 'spotlight', on: false }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.got.filter((m) => m.type === 'spotlight').length, 1, 'only its author ends a spotlight');
    a.ws.close();
    assert.equal((await c.until((m) => m.type === 'spotlight' && m.from === null)).from, null, 'it ends when the author leaves');
    for (const x of [b, c]) x.ws.close();
  } finally {
    await stop();
  }
});

test('comments: viewers read, commenters write, authors edit, owner deletes; everyone in the file is told', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const com = client(base);
    const viewer = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(com, letters, 'com@example.com', '12345678', 'Костя');
    await signUp(viewer, letters, 'vi@example.com', '12345678', 'Вика');
    const { Document, serialize } = await import('../../core/src/index.ts');
    await owner('PUT', '/api/files/fComm00001', { name: 'Макет', snapshot: serialize(Document.createEmpty('Макет')) });
    await owner('POST', '/api/files/fComm00001/share/invite', { email: 'com@example.com', role: 'commenter' });
    await owner('POST', '/api/files/fComm00001/share/invite', { email: 'vi@example.com', role: 'viewer' });
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email: 'vi@example.com', password: '12345678' }) });
    const room = await liveClient(base, 'fComm00001', res.headers.get('set-cookie')!.split(';')[0]!, { version: 1, since: null });
    await room.until((m) => m.type === 'welcome');

    // A commenter starts a discussion on a layer; a viewer cannot.
    assert.equal((await viewer('POST', '/api/files/fComm00001/comments', { pageId: 'p:1', nodeId: null, x: 1, y: 2, text: 'Можно?' })).status, 403);
    assert.equal((await com('POST', '/api/files/fComm00001/comments', { pageId: 'p:1', nodeId: null, x: 'a', y: 2, text: 'x' })).status, 400);
    assert.equal((await com('POST', '/api/files/fComm00001/comments', { pageId: 'p:1', nodeId: null, x: 1, y: 2, text: '   ' })).status, 400);
    const made = await com('POST', '/api/files/fComm00001/comments', { pageId: 'p:1', nodeId: 'n:5', x: 10, y: 20, text: ' Кнопка\nмелкая \u0007' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const thread = made.body!.thread;
    assert.deepEqual([thread.pageId, thread.nodeId, thread.x, thread.y, thread.resolved], ['p:1', 'n:5', 10, 20, false]);
    assert.deepEqual(thread.comments.map((c: { author: string; text: string }) => [c.author, c.text]), [['Костя', 'Кнопка\nмелкая']]);
    assert.equal((await room.until((m) => m.type === 'thread')).thread.id, thread.id, 'people in the file see it at once');

    // Replies, resolving (a reply reopens), editing by the author only.
    const replied = await owner('POST', `/api/files/fComm00001/comments/${thread.id}/replies`, { text: 'Увеличу' });
    const ownerComment = replied.body!.thread.comments[1];
    assert.equal(ownerComment.author, 'Оля');
    const resolved = await com('PATCH', `/api/files/fComm00001/comments/${thread.id}`, { resolved: true });
    assert.deepEqual([resolved.body!.thread.resolved, resolved.body!.thread.resolvedBy], [true, 'Костя']);
    assert.equal((await owner('POST', `/api/files/fComm00001/comments/${thread.id}/replies`, { text: 'Ещё вопрос' })).body!.thread.resolved, false);
    assert.equal((await com('PATCH', `/api/files/fComm00001/comments/${thread.id}/${ownerComment.id}`, { text: 'чужое' })).status, 403);
    const edited = await owner('PATCH', `/api/files/fComm00001/comments/${thread.id}/${ownerComment.id}`, { text: 'Увеличу до 44' });
    assert.ok(edited.body!.thread.comments[1].editedAt);
    // Moving the pin: its author or an editor.
    assert.equal((await com('PATCH', `/api/files/fComm00001/comments/${thread.id}`, { pageId: 'p:1', nodeId: null, x: 5, y: 5 })).body!.thread.nodeId, null);

    // Everyone with access reads; a stranger does not; deleting.
    const listed = await viewer('GET', '/api/files/fComm00001/comments');
    assert.equal(listed.body!.threads[0].comments.length, 3);
    assert.equal((await client(base)('GET', '/api/files/fComm00001/comments')).status, 404);
    assert.equal((await com('DELETE', `/api/files/fComm00001/comments/${thread.id}/${ownerComment.id}`)).status, 403, 'only the author or the owner');
    const thirdId = listed.body!.threads[0].comments[2].id;
    assert.equal((await owner('DELETE', `/api/files/fComm00001/comments/${thread.id}/${thirdId}`)).body!.thread.comments.length, 2);
    const gone = await owner('DELETE', `/api/files/fComm00001/comments/${thread.id}/${thread.comments[0].id}`);
    assert.deepEqual(gone.body, { type: 'thread', id: thread.id, deleted: true }, 'deleting the first comment deletes the discussion');
    await room.until((m) => m.type === 'thread' && m.deleted);
    assert.deepEqual((await viewer('GET', '/api/files/fComm00001/comments')).body!.threads, []);
    room.ws.close();
  } finally {
    await stop();
  }
});

test('comment mentions and letters: @ only for people of the file, who is told, limits, preferences', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const com = client(base);
    const viewer = client(base);
    const stranger = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(com, letters, 'com@example.com', '12345678', 'Костя');
    await signUp(viewer, letters, 'vi@example.com', '12345678', 'Вика');
    await signUp(stranger, letters, 'pe@example.com', '12345678', 'Петя');
    const id = async (api: ReturnType<typeof client>) => (await api('GET', '/api/me')).body!.user.id as string;
    const [oId, kId, vId, pId] = [await id(owner), await id(com), await id(viewer), await id(stranger)];
    const { Document, serialize } = await import('../../core/src/index.ts');
    await owner('PUT', '/api/files/fMent00001', { name: 'Макет', snapshot: serialize(Document.createEmpty('Макет')) });
    await owner('POST', '/api/files/fMent00001/share/invite', { email: 'com@example.com', role: 'commenter' });
    await owner('POST', '/api/files/fMent00001/share/invite', { email: 'vi@example.com', role: 'viewer' });
    letters.length = 0;
    /** Letters about comments arrive after the answer: wait a moment. */
    const settle = () => new Promise((r) => setTimeout(r, 80));
    const to = (email: string) => letters.filter((l) => l.to === email);

    // The @ list: the people of the file, for those who may comment.
    const people = await com('GET', '/api/files/fMent00001/people');
    assert.deepEqual(people.body!.people.map((p: { name: string }) => p.name).sort(), ['Вика', 'Костя', 'Оля']);
    assert.equal((await viewer('GET', '/api/files/fMent00001/people')).status, 403);

    // Only people of the file whose name is in the text are called.
    const made = await com('POST', '/api/files/fMent00001/comments', { pageId: 'p:1', nodeId: null, x: 1, y: 2, text: '@Вика глянь, и @Петя', mentions: [vId, pId, vId, oId] });
    const thread = made.body!.thread;
    assert.deepEqual(thread.comments[0].mentions, [{ id: vId, name: 'Вика' }]);
    await settle();
    assert.match(to('vi@example.com')[0]!.subject, /Костя упомянул\(а\) вас в «Макет»/);
    assert.match(to('vi@example.com')[0]!.text, new RegExp(`\\?file=fMent00001&comment=${thread.id}`));
    assert.match(to('owner@example.com')[0]!.subject, /оставил\(а\) комментарий/, 'the owner hears of a new discussion');
    assert.equal(to('pe@example.com').length, 0);
    assert.equal(to('com@example.com').length, 0, 'never the author');

    // A reply tells those who wrote before; a second one soon after does not (one letter per discussion in 10 minutes).
    await owner('POST', `/api/files/fMent00001/comments/${thread.id}/replies`, { text: 'Ок' });
    await owner('POST', `/api/files/fMent00001/comments/${thread.id}/replies`, { text: 'Ещё' });
    await settle();
    assert.equal(to('com@example.com').length, 1);
    assert.match(to('com@example.com')[0]!.subject, /ответил\(а\) в обсуждении/);
    assert.equal(to('vi@example.com').length, 1, 'a person only called once is not a participant');

    // "Only when called with @": replies are quiet, a mention still comes (past the 10-minute limit).
    assert.equal((await com('PUT', '/api/me/prefs', { prefs: { 'cs.mail-comments': 'mentions' } })).status, 200);
    await owner('POST', `/api/files/fMent00001/comments/${thread.id}/replies`, { text: '@Костя смотри', mentions: [kId] });
    await settle();
    assert.equal(to('com@example.com').length, 2);
    assert.match(to('com@example.com')[1]!.subject, /упомянул/);

    // Editing: a letter only to someone called for the first time; "none" turns letters off.
    const ownerReply = (await owner('POST', `/api/files/fMent00001/comments/${thread.id}/replies`, { text: 'Итог' })).body!.thread.comments.at(-1);
    await settle();
    const before = letters.length;
    await owner('PATCH', `/api/files/fMent00001/comments/${thread.id}/${ownerReply.id}`, { text: 'Итог, @Вика', mentions: [vId] });
    await owner('PATCH', `/api/files/fMent00001/comments/${thread.id}/${ownerReply.id}`, { text: 'Итог!, @Вика', mentions: [vId] });
    await settle();
    assert.deepEqual(letters.slice(before).map((l) => l.to), ['vi@example.com']);
    await viewer('PUT', '/api/me/prefs', { prefs: { 'cs.mail-comments': 'none' } });
    await owner('POST', `/api/files/fMent00001/comments/${thread.id}/replies`, { text: '@Вика и ещё', mentions: [vId] });
    await settle();
    assert.equal(to('vi@example.com').length, 2);

    // Someone whose access was closed gets nothing.
    await owner('DELETE', `/api/files/fMent00001/share/members/${kId}`);
    await owner('POST', `/api/files/fMent00001/comments/${thread.id}/replies`, { text: '@Костя', mentions: [kId] });
    await settle();
    assert.equal(to('com@example.com').length, 2);
  } finally {
    await stop();
  }
});

test('libraries: editors publish, people with the file see and take it, others do not', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const com = client(base);
    const stranger = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(com, letters, 'com@example.com', '12345678', 'Костя');
    await signUp(stranger, letters, 'pe@example.com', '12345678', 'Петя');
    const { Document, serialize } = await import('../../core/src/index.ts');
    await owner('PUT', '/api/files/fLibr00001', { name: 'Дизайн-система', snapshot: serialize(Document.createEmpty('Дизайн-система')) });
    await owner('POST', '/api/files/fLibr00001/share/invite', { email: 'com@example.com', role: 'commenter' });
    const payload = { version: 1, components: [{ id: 'a:1', component: 'a:1', name: 'Кнопка', description: '', variants: 0, page: 'Стр' }], nodes: [{ id: 'a:1', type: 'COMPONENT', parent: null, index: 'a0', props: { name: 'Кнопка' } }], styles: [], variables: [], collections: [], blobs: [] };

    assert.equal((await owner('PUT', '/api/files/fLibr00001/library', { ...payload, components: [] })).status, 400, 'nothing to publish');
    assert.equal((await owner('PUT', '/api/files/fLibr00001/library', { nodes: [] })).status, 400);
    assert.equal((await com('PUT', '/api/files/fLibr00001/library', payload)).status, 403, 'publishing needs the editor role');
    const published = await owner('PUT', '/api/files/fLibr00001/library', payload);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body!.library.components, 1);

    // The list: for people with the file only.
    const list = await com('GET', '/api/libraries');
    assert.deepEqual(list.body!.libraries.map((l: { fileId: string; name: string; own: boolean; ownerName: string }) => [l.fileId, l.name, l.own, l.ownerName]), [['fLibr00001', 'Дизайн-система', false, 'Оля']]);
    assert.equal((await owner('GET', '/api/libraries')).body!.libraries[0].own, true);
    assert.deepEqual((await stranger('GET', '/api/libraries')).body!.libraries, []);
    const got = await com('GET', '/api/files/fLibr00001/library');
    assert.equal(got.body!.library.name, 'Дизайн-система');
    assert.equal(got.body!.library.fileId, 'fLibr00001');
    assert.ok(got.body!.library.publishedAt > 0);
    assert.equal(got.body!.library.nodes[0].id, 'a:1');
    assert.equal((await stranger('GET', '/api/files/fLibr00001/library')).status, 404);
    assert.equal((await owner('GET', '/api/files')).body!.files[0].library.components, 1, 'the file list knows it is a library');

    // Saving the file keeps it a library; unpublishing ends it.
    await owner('PUT', '/api/files/fLibr00001', { name: 'Дизайн-система 2', snapshot: serialize(Document.createEmpty('Дизайн-система')), baseVersion: 1 });
    assert.equal((await com('GET', '/api/libraries')).body!.libraries.length, 1);
    assert.equal((await owner('DELETE', '/api/files/fLibr00001/library')).status, 200);
    assert.deepEqual((await com('GET', '/api/libraries')).body!.libraries, []);
    assert.equal((await com('GET', '/api/files/fLibr00001/library')).status, 404);
  } finally {
    await stop();
  }
});

test('live load: pointers only to the same page, pictures of an open file on disk, not in memory', async () => {
  const { base, dataDir, stop, letters } = await start();
  try {
    const anna = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    const { Document, serialize, deserialize } = await import('../../core/src/index.ts');
    const doc = Document.createEmpty('Макет', 'pic');
    let hash = '';
    doc.withTransaction((tx) => {
      hash = tx.addBlob(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), 'image/png');
      tx.create('RECTANGLE', doc.pages()[0]!, { fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] });
    }, 'local');
    await anna('PUT', '/api/files/fPics00001', { name: 'Макет', snapshot: serialize(doc) });
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email: 'anna@example.com', password: '12345678' }) });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const a = await liveClient(base, 'fPics00001', cookie, { version: null, since: null });
    const first = await a.until((m) => m.type === 'snapshot');
    assert.equal(deserialize(first.snapshot).store.blobs.get(hash)?.data, 'iVBORwECAwQ=', 'the newcomer gets the picture');
    const files = await readdir(join(dataDir, 'files', 'fPics00001'));
    assert.ok(files.includes(`i${hash}`), 'the picture is kept apart from the document');
    const stored = JSON.parse(await readFile(join(dataDir, 'files', 'fPics00001', 'snapshot.json'), 'utf8'));
    assert.equal(stored.blobs, undefined, 'the stored document has no picture data');
    assert.deepEqual(stored.blobMimes, { [hash]: 'image/png' });

    const b = await liveClient(base, 'fPics00001', cookie, { version: null, since: null });
    const c = await liveClient(base, 'fPics00001', cookie, { version: null, since: null });
    await b.until((m) => m.type === 'snapshot');
    await c.until((m) => m.type === 'snapshot');
    const presence = (ws: WebSocket, page: string, x: number) => ws.send(JSON.stringify({ type: 'presence', page, cursor: { x, y: 0 }, selection: [], view: null, chat: null }));
    presence(a.ws, 'p:1', 1);
    presence(b.ws, 'p:1', 2);
    presence(c.ws, 'p:2', 3);
    await a.until((m) => m.type === 'presence' && m.cursor?.x === 3);
    // C is on another page now: A's pointer moves do not reach C, B's do reach A.
    c.got.length = 0;
    presence(a.ws, 'p:1', 11);
    presence(b.ws, 'p:1', 12);
    await a.until((m) => m.type === 'presence' && m.cursor?.x === 12);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.got.filter((m) => m.type === 'presence').length, 0, 'no pointers from another page');
    // C comes to page 1: everyone learns it, and C gets the pointers already there.
    presence(c.ws, 'p:1', 13);
    await a.until((m) => m.type === 'presence' && m.cursor?.x === 13);
    const there = await c.until((m) => m.type === 'presence' && m.cursor?.x === 12);
    assert.equal(there.page, 'p:1');
    await c.until((m) => m.type === 'presence' && m.cursor?.x === 11);

    // A picture in an operation: saved with the file; someone coming back past that batch gets the whole file.
    const seqBefore = (await b.until((m) => m.type === 'welcome')).seq;
    a.ws.send(JSON.stringify({ type: 'ops', id: 'x1', ops: [{ kind: 'blob', hash: 'a'.repeat(64), mime: 'image/png', data: 'AQID', time: { counter: 5, session: 'zz' } }] }));
    await a.until((m) => m.type === 'ack' && m.id === 'x1');
    const d = await liveClient(base, 'fPics00001', cookie, { version: null, since: seqBefore });
    const full = await d.until((m) => m.type === 'snapshot');
    assert.equal(deserialize(full.snapshot).store.blobs.get('a'.repeat(64))?.data, 'AQID');
    for (const x of [a, b, c, d]) x.ws.close();
    // Everyone left: the file opened anew has both pictures.
    await new Promise((r) => setTimeout(r, 200));
    const saved = deserialize((await anna('GET', '/api/files/fPics00001')).body!.snapshot);
    assert.equal(saved.store.blobs.get(hash)?.data, 'iVBORwECAwQ=');
    assert.equal(saved.store.blobs.get('a'.repeat(64))?.data, 'AQID');
    assert.ok((await readdir(join(dataDir, 'files', 'fPics00001'))).includes(`i${'a'.repeat(64)}`));
  } finally {
    await stop();
  }
});

test('documents written before (pictures inside snapshot.json) open as they are and take the new form when the room saves', async () => {
  const { base, dataDir, stop, letters } = await start();
  try {
    const anna = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    const { Document, serialize, deserialize } = await import('../../core/src/index.ts');
    const doc = Document.createEmpty('Старый', 'old');
    let hash = '';
    let rect = '';
    doc.withTransaction((tx) => {
      hash = tx.addBlob(new Uint8Array([1, 2, 3, 4, 5]), 'image/jpeg');
      rect = tx.create('RECTANGLE', doc.pages()[0]!, { fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }] });
    }, 'local');
    await anna('PUT', '/api/files/fOld000001', { name: 'Старый', snapshot: serialize(Document.createEmpty('Старый')) });
    // As the server wrote it before: the whole snapshot with the picture inside.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dataDir, 'files', 'fOld000001', 'snapshot.json'), serialize(doc));
    assert.equal(deserialize((await anna('GET', '/api/files/fOld000001')).body!.snapshot).store.blobs.get(hash)?.data, 'AQIDBAU=');
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email: 'anna@example.com', password: '12345678' }) });
    const a = await liveClient(base, 'fOld000001', res.headers.get('set-cookie')!.split(';')[0]!, { version: null, since: null });
    assert.equal(deserialize((await a.until((m) => m.type === 'snapshot')).snapshot).store.blobs.get(hash)?.data, 'AQIDBAU=');
    a.ws.send(JSON.stringify({ type: 'ops', id: 'e1', ops: [{ kind: 'set', id: rect, key: 'x', value: 5, time: { counter: 99, session: 'zz' } }] }));
    await a.until((m) => m.type === 'ack');
    a.ws.close();
    for (let i = 0; i < 60; i++) {
      if (!JSON.parse(await readFile(join(dataDir, 'files', 'fOld000001', 'snapshot.json'), 'utf8')).blobs) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const stored = JSON.parse(await readFile(join(dataDir, 'files', 'fOld000001', 'snapshot.json'), 'utf8'));
    assert.equal(stored.blobs, undefined);
    assert.deepEqual(stored.blobMimes, { [hash]: 'image/jpeg' });
    const again = deserialize((await anna('GET', '/api/files/fOld000001')).body!.snapshot);
    assert.equal(again.store.blobs.get(hash)?.data, 'AQIDBAU=');
    assert.equal(again.get(rect, 'x'), 5);
  } finally {
    await stop();
  }
});

test('the name is optional: others see the email until one is set; it can be changed later', async () => {
  const { base, stop, letters } = await start();
  try {
    const anon = client(base);
    const ed = client(base);
    await signUp(anon, letters, 'nameless@example.com', '12345678', '');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    assert.equal((await anon('GET', '/api/me')).body!.user.name, '');
    await anon('PUT', '/api/files/fNameless1', { name: 'Макет', snapshot: SNAPSHOT });
    await anon('POST', '/api/files/fNameless1/share/invite', { email: 'ed@example.com', role: 'editor' });
    assert.match(letters.at(-1)!.subject, /^nameless@example\.com открыл\(а\) вам доступ/, 'the letter names the email');
    const renamed = await anon('PATCH', '/api/me', { name: '  Нина  ' });
    assert.equal(renamed.body!.user.name, 'Нина');
    assert.equal((await anon('GET', '/api/me')).body!.user.name, 'Нина');
    assert.equal((await ed('GET', '/api/files')).body!.files[0].ownerName, 'Нина');
  } finally {
    await stop();
  }
});

test('code audit (BUG-159…163): addresses only to people of the file, small messages from viewers, signing out ends live connections, the sandbox page is sandboxed, 6to4 and Teredo are not public', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const ed = client(base);
    const anon = client(base);
    await signUp(owner, letters, 'nameless@example.com', '12345678', '');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    const { Document, serialize } = await import('../../core/src/index.ts');
    await owner('PUT', '/api/files/fPrivacy01', { name: 'Макет', snapshot: serialize(Document.createEmpty('Макет')) });
    await owner('POST', '/api/files/fPrivacy01/share/invite', { email: 'ed@example.com', role: 'editor' });
    await owner('POST', '/api/files/fPrivacy01/comments', { pageId: 'p:1', nodeId: null, x: 1, y: 2, text: 'Проверьте отступы' });
    const token = (await owner('PUT', '/api/files/fPrivacy01/share/link', { mode: 'anyone', role: 'viewer' })).body!.link.token as string;
    const L = { 'X-CS-Link': token };

    // People of the file see the address of someone without a name; a visitor by the link never does.
    assert.equal((await ed('GET', '/api/files/fPrivacy01')).body!.file.ownerName, 'nameless@example.com');
    const byLink = await anon('GET', '/api/files/fPrivacy01', undefined, L);
    assert.equal(byLink.body!.file.ownerName, 'Участник');
    for (const path of ['/comments', '/versions']) {
      const text = JSON.stringify((await anon('GET', `/api/files/fPrivacy01${path}`, undefined, L)).body);
      assert.equal(text.includes('nameless@'), false, path);
    }
    assert.equal((await ed('GET', '/api/files/fPrivacy01/comments')).body!.threads[0].comments[0].author, 'nameless@example.com');

    // Live: the list of people and a new comment — each gets the names they may see.
    const cookie = async (email: string) => {
      const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email, password: '12345678' }) });
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };
    const ownerCookie = await cookie('nameless@example.com');
    const o = await liveClient(base, 'fPrivacy01', ownerCookie, { version: 1, since: null });
    const g = await liveClient(base, `fPrivacy01?link=${token}`, '', { version: 1, since: null });
    assert.deepEqual((await g.until((m) => m.type === 'peers' && m.peers.length === 2)).peers.map((p: { name: string }) => p.name).sort(), ['Гость', 'Участник']);
    assert.deepEqual((await o.until((m) => m.type === 'peers' && m.peers.length === 2)).peers.map((p: { name: string }) => p.name).sort(), ['nameless@example.com', 'Гость']);
    await owner('POST', '/api/files/fPrivacy01/comments', { pageId: 'p:1', nodeId: null, x: 3, y: 4, text: 'Ещё одно' });
    assert.equal((await g.until((m) => m.type === 'thread' && m.thread?.comments[0].text === 'Ещё одно')).thread.comments[0].author, 'Участник');
    assert.equal((await o.until((m) => m.type === 'thread' && m.thread?.comments[0].text === 'Ещё одно')).thread.comments[0].author, 'nameless@example.com');

    // A viewer's message is small: a big one closes the connection.
    const closed = new Promise<void>((r) => g.ws.addEventListener('close', () => r()));
    g.ws.send(JSON.stringify({ type: 'presence', chat: 'x'.repeat(300 * 1024) }));
    await closed;

    // Signing out ends the live connections of that session.
    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'X-CS': '1', Cookie: ownerCookie } });
    assert.equal(out.status, 200);
    await o.until((m) => m.type === 'signedOut');

    // The sandbox page is an opaque origin by its own header too.
    assert.match((await fetch(`${base}/html-sandbox?v=2`)).headers.get('content-security-policy') ?? '', /sandbox allow-scripts allow-forms/);
  } finally {
    await stop();
  }
  const { isPublicAddress } = await import('../src/link-preview.ts');
  for (const ip of ['2002:7f00:1::1', '2001:0:4136:e378::1', '2001::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
});

test('board mentions: «@Name» in a sticker sends a letter with a link to it; only people of the file, only on a board, only editors with an account; preferences and limits', async () => {
  const { base, stop, letters } = await start();
  try {
    const owner = client(base);
    const ed = client(base);
    const viewer = client(base);
    const outsider = client(base);
    await signUp(owner, letters, 'owner@example.com', '12345678', 'Оля');
    await signUp(ed, letters, 'ed@example.com', '12345678', 'Эд');
    await signUp(viewer, letters, 'viewer@example.com', '12345678', 'Вика');
    await signUp(outsider, letters, 'out@example.com', '12345678', 'Чужой');
    const board = JSON.stringify({ version: 1, nodes: [{ id: 'r', parent: null, props: { name: 'Ретро', fileKind: 'BOARD' } }] });
    await owner('PUT', '/api/files/fBoardMen1', { name: 'Ретро', snapshot: board });
    await owner('PUT', '/api/files/fDesignMe1', { name: 'Макет', snapshot: SNAPSHOT });
    await owner('POST', '/api/files/fBoardMen1/share/invite', { email: 'ed@example.com', role: 'editor' });
    await owner('POST', '/api/files/fBoardMen1/share/invite', { email: 'viewer@example.com', role: 'viewer' });
    const people = (await ed('GET', '/api/files/fBoardMen1/people')).body!.people as { id: string; name: string }[];
    const id = (name: string) => people.find((p) => p.name === name)!.id;
    const outsiderId = (await outsider('GET', '/api/me')).body!.user.id as string;

    const sent = await ed('POST', '/api/files/fBoardMen1/mentions', { userId: id('Оля'), nodeId: 'ab12cd34ef:7', text: 'Оля, @Оля посмотри  этот стикер' });
    assert.deepEqual(sent.body, { sent: true });
    const letter = letters.at(-1)!;
    assert.equal(letter.to, 'owner@example.com');
    assert.match(letter.subject, /^Эд упомянул\(а\) вас на доске «Ретро»/);
    assert.match(letter.text, /Оля, @Оля посмотри этот стикер/);
    assert.match(letter.text, /Открыть доску: .*\?file=fBoardMen1&node=ab12cd34ef%3A7/);

    const count = letters.length;
    assert.equal((await ed('POST', '/api/files/fBoardMen1/mentions', { userId: outsiderId, nodeId: 'n1', text: 'x' })).status, 400, 'someone without the file');
    assert.equal((await viewer('POST', '/api/files/fBoardMen1/mentions', { userId: id('Оля'), nodeId: 'n1', text: 'x' })).status, 403, 'a viewer does not edit the board');
    assert.equal((await owner('POST', '/api/files/fDesignMe1/mentions', { userId: id('Эд'), nodeId: 'n1', text: 'x' })).status, 400, 'a design is not a board');
    assert.equal((await ed('POST', '/api/files/fBoardMen1/mentions', { userId: id('Оля'), nodeId: '../x', text: 'x' })).status, 400, 'a bad object id');
    assert.deepEqual((await ed('POST', '/api/files/fBoardMen1/mentions', { userId: id('Эд'), nodeId: 'n1', text: 'x' })).body, { sent: false }, 'oneself — no letter');
    // «No letters» in the settings: nothing is sent.
    await owner('PUT', '/api/me/prefs', { prefs: { 'cs.mail-comments': 'none' } });
    assert.deepEqual((await ed('POST', '/api/files/fBoardMen1/mentions', { userId: id('Оля'), nodeId: 'n1', text: 'x' })).body, { sent: false });
    assert.equal(letters.length, count, 'no letter in any of these cases');
    // A guest without an account cannot call anyone.
    const on = (await owner('PUT', '/api/files/fBoardMen1/share/link', { mode: 'anyone', role: 'editor', guests: true })).body!.link;
    assert.equal((await client(base)('POST', '/api/files/fBoardMen1/mentions', { userId: id('Эд'), nodeId: 'n1', text: 'x' }, { 'X-CS-Link': on.token })).status, 401);
  } finally {
    await stop();
  }
});

test('emotes: passed on to the others in the file at once, only from the list, a few at a time, never kept', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    const boris = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    await signUp(boris, letters, 'boris@example.com', '12345678', 'Борис');
    const { Document, serialize } = await import('../../core/src/index.ts');
    await anna('PUT', '/api/files/fEmote0001', { name: 'Доска', snapshot: serialize(Document.createEmpty('Доска')) });
    await anna('POST', '/api/files/fEmote0001/share/invite', { email: 'boris@example.com', role: 'viewer' });
    const login = async (email: string) => {
      const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email, password: '12345678' }) });
      return res.headers.get('set-cookie')!.split(';')[0]!;
    };
    const a = await liveClient(base, 'fEmote0001', await login('anna@example.com'), { version: 1, since: null });
    const b = await liveClient(base, 'fEmote0001', await login('boris@example.com'), { version: 1, since: null });
    const peers = await a.until((m) => m.type === 'peers' && m.peers.length === 2);
    const borisId = peers.peers.find((p: { name: string }) => p.name === 'Борис').id;
    a.ws.send(JSON.stringify({ type: 'emote', emoji: '✋', x: 10, y: 20, page: 'p:1', to: borisId }));
    const got = await b.until((m) => m.type === 'emote');
    assert.deepEqual({ ...got, from: undefined }, { type: 'emote', from: undefined, emoji: '✋', x: 10, y: 20, page: 'p:1', to: borisId });
    assert.equal(a.got.some((m) => m.type === 'emote'), false, 'no echo to the sender');
    // A viewer may react too; not from the list — dropped; too many at once — dropped.
    b.ws.send(JSON.stringify({ type: 'emote', emoji: '<img src=x>', x: 0, y: 0, page: 'p:1' }));
    b.ws.send(JSON.stringify({ type: 'emote', emoji: '👍', x: 'a', y: 0, page: 'p:1' }));
    for (let i = 0; i < 12; i++) b.ws.send(JSON.stringify({ type: 'emote', emoji: '🎉', x: i, y: 0, page: 'p:1' }));
    await a.until((m) => m.type === 'emote' && m.emoji === '🎉' && m.x === 7);
    await new Promise((r) => setTimeout(r, 200));
    const atAnna = a.got.filter((m) => m.type === 'emote');
    assert.equal(atAnna.length, 8, 'eight in two seconds, the rest dropped');
    assert.ok(atAnna.every((m) => m.emoji === '🎉'));
    // Nothing of it in the file.
    const saved = (await anna('GET', '/api/files/fEmote0001')).body!.snapshot as string;
    assert.equal(saved.includes('🎉') || saved.includes('✋'), false);
    for (const c of [a, b]) c.ws.close();
  } finally {
    await stop();
  }
});

test('own board templates are kept with the account: up to 300 000 characters, more is refused', async () => {
  const { base, stop, letters } = await start();
  try {
    const api = client(base);
    await signUp(api, letters, 'tpl@example.com', '12345678', 'Тим');
    const big = JSON.stringify([{ id: 't1', name: 'Ретро', at: 1, width: 10, height: 10, clip: 'x'.repeat(250_000) }]);
    assert.equal((await api('PUT', '/api/me/prefs', { prefs: { 'cs.board-templates': big } })).status, 200);
    assert.equal((await api('GET', '/api/me')).body!.prefs['cs.board-templates'], big);
    assert.equal((await api('PUT', '/api/me/prefs', { prefs: { 'cs.board-templates': 'y'.repeat(300_001) } })).status, 400);
  } finally {
    await stop();
  }
});

test('a file in two lines (?format=lines): its record, then the document as it is — the same as the JSON answer', async () => {
  const { base, stop, letters } = await start();
  try {
    const api = client(base);
    await signUp(api, letters, 'lines@example.com', '12345678', 'Лина');
    await api('PUT', '/api/files/fLines0001', { name: 'Макет', snapshot: SNAPSHOT });
    const cookie = (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email: 'lines@example.com', password: '12345678' }) })).headers.get('set-cookie')!.split(';')[0]!;
    const res = await fetch(`${base}/api/files/fLines0001?format=lines`, { headers: { Cookie: cookie } });
    assert.match(res.headers.get('content-type') ?? '', /^application\/x-ndjson/);
    const text = await res.text();
    const cut = text.indexOf('\n');
    const head = JSON.parse(text.slice(0, cut));
    const plain = (await api('GET', '/api/files/fLines0001')).body!;
    assert.equal(text.slice(cut + 1), plain.snapshot, 'the document as it is');
    const { snapshot: _, ...record } = plain;
    assert.deepEqual(head, record, 'the same record');
    assert.equal((await fetch(`${base}/api/files/fNoSuch001?format=lines`, { headers: { Cookie: cookie } })).status, 404);
  } finally {
    await stop();
  }
});

test('the index of files follows every write: owners, members, invitations, projects, branches; the store lists without reading the directory again', async () => {
  const { FileIndex } = await import('../src/api.ts');
  const dir = await mkdtemp(join(tmpdir(), 'cs-index-'));
  const store = new JsonStore<{ id: string; ownerId: string; members?: { userId: string }[]; invites?: { email: string }[]; projectId?: string | null; branch?: { of: string } }>(dir);
  const index = new FileIndex();
  store.onWrite = (_id, before, after) => index.update(before as never, after as never);
  await store.put('fAAAAAA1', { id: 'fAAAAAA1', ownerId: 'u1', members: [{ userId: 'u2' }], invites: [{ email: 'x@example.com' }], projectId: 'p1' });
  await store.put('fAAAAAA2', { id: 'fAAAAAA2', ownerId: 'u2', branch: { of: 'fAAAAAA1' }, projectId: 'p1' });
  assert.deepEqual([...index.forPerson('u2', 'none')].sort(), ['fAAAAAA1', 'fAAAAAA2']);
  assert.deepEqual([...index.forPerson('u9', 'x@example.com')], ['fAAAAAA1']);
  assert.deepEqual([...index.inProjects(['p1'])].sort(), ['fAAAAAA1', 'fAAAAAA2']);
  assert.deepEqual(index.branchesOf('fAAAAAA1'), ['fAAAAAA2']);
  await store.update('fAAAAAA1', (cur) => (cur ? { ...cur, members: [], projectId: null } : undefined));
  assert.deepEqual([...index.forPerson('u2', 'none')], ['fAAAAAA2'], 'a member taken out');
  assert.deepEqual([...index.inProjects(['p1'])], ['fAAAAAA2'], 'moved to Drafts');
  await store.delete('fAAAAAA2');
  assert.deepEqual(index.branchesOf('fAAAAAA1'), [], 'a deleted branch');
  assert.deepEqual(await store.ids(), ['fAAAAAA1']);
  await store.put('fAAAAAA3', { id: 'fAAAAAA3', ownerId: 'u3' });
  assert.deepEqual((await store.ids()).sort(), ['fAAAAAA1', 'fAAAAAA3'], 'the list follows writes without the directory');
  await rm(dir, { recursive: true, force: true });
});

test('account settings: kept with the account, only known keys, the same on another computer', async () => {
  const { base, stop, letters } = await start();
  try {
    const pc1 = client(base);
    await signUp(pc1, letters, 'pref@example.com', '12345678', 'Пётр');
    assert.deepEqual((await pc1('GET', '/api/me')).body!.prefs, {});
    assert.equal((await pc1('PUT', '/api/me/prefs', { prefs: { 'cs-dock-place': 'left', 'cs-theme': 'dark' } })).status, 200);
    assert.equal((await pc1('PUT', '/api/me/prefs', { prefs: { secret: 'x' } })).status, 400, 'unknown keys are refused');
    assert.equal((await pc1('PUT', '/api/me/prefs', { prefs: { 'cs-theme': 5 } })).status, 400);
    assert.deepEqual((await pc1('PUT', '/api/me/prefs', { prefs: { 'cs-theme': null } })).body!.prefs, { 'cs-dock-place': 'left' }, 'null removes a setting');
    const pc2 = client(base);
    await pc2('POST', '/api/auth/login', { email: 'pref@example.com', password: '12345678' });
    assert.deepEqual((await pc2('GET', '/api/me')).body!.prefs, { 'cs-dock-place': 'left' });
    assert.equal((await client(base)('PUT', '/api/me/prefs', { prefs: {} })).status, 401);
  } finally {
    await stop();
  }
});

test('versions: the first save, named versions, a version when everyone leaves; viewers read, editors save', async () => {
  const { base, stop, letters } = await start();
  try {
    const anna = client(base);
    const vera = client(base);
    await signUp(anna, letters, 'anna@example.com', '12345678', 'Анна');
    await signUp(vera, letters, 'vera@example.com', '12345678', 'Вера');
    const { Document, serialize } = await import('../../core/src/index.ts');
    const doc = Document.createEmpty('Макет');
    await anna('PUT', '/api/files/fVers00001', { name: 'Макет', snapshot: serialize(doc) });
    await anna('POST', '/api/files/fVers00001/share/invite', { email: 'vera@example.com', role: 'viewer' });
    let list = (await anna('GET', '/api/files/fVers00001/versions')).body!.versions;
    assert.equal(list.length, 1, 'the file as created');
    assert.deepEqual(list[0].authors, ['Анна']);

    // Named: by editors only, kept with a name.
    assert.equal((await vera('POST', '/api/files/fVers00001/versions', { name: 'x' })).status, 403);
    assert.equal((await anna('POST', '/api/files/fVers00001/versions', { name: '  ' })).status, 400);
    const named = await anna('POST', '/api/files/fVers00001/versions', { name: 'Перед показом', description: 'Согласовано' });
    assert.equal(named.status, 200, JSON.stringify(named.body));
    list = (await vera('GET', '/api/files/fVers00001/versions')).body!.versions;
    assert.deepEqual([list[0].name, list[0].description, list[0].by], ['Перед показом', 'Согласовано', 'Анна']);
    assert.match((await vera('GET', `/api/files/fVers00001/versions/${list[0].id}`)).body!.snapshot, /Макет/);
    assert.equal((await vera('GET', '/api/files/fVers00001/versions/vzzzzzzzzzzzz')).status, 404);
    assert.equal((await anna('PATCH', `/api/files/fVers00001/versions/${list[1].id}`, { name: 'Начало' })).body!.version.name, 'Начало');

    // Live work, then everyone leaves: an automatic version with who changed the file.
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email: 'anna@example.com', password: '12345678' }) });
    const a = await liveClient(base, 'fVers00001', res.headers.get('set-cookie')!.split(';')[0]!, { version: 1, since: null });
    const welcome = await a.until((m) => m.type === 'welcome');
    assert.equal(typeof welcome.clock, 'number', 'the room clock comes with the welcome');
    const ops: unknown[] = [];
    doc.onLocalOps((o) => ops.push(...o));
    doc.transact((tx) => tx.set(doc.rootId, 'name', 'Вечер'));
    a.ws.send(JSON.stringify({ type: 'ops', id: 1, ops }));
    await a.until((m) => m.type === 'ack');
    a.ws.close();
    for (let i = 0; i < 40 && list.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      list = (await anna('GET', '/api/files/fVers00001/versions')).body!.versions;
    }
    assert.equal(list.length, 3);
    assert.deepEqual([list[0].name, list[0].authors], [null, ['Анна']]);
    assert.match((await anna('GET', `/api/files/fVers00001/versions/${list[0].id}`)).body!.snapshot, /Вечер/);
  } finally {
    await stop();
  }
});

test('versions: old automatic versions are thinned, named ones are kept', async () => {
  const { thin } = await import('../src/versions.ts');
  const day = 86_400_000;
  const now = 100 * day;
  const list = [
    { id: 'v1', at: now - 50 * day, authors: [] },
    { id: 'v2', at: now - 50 * day + 1000, authors: [] },
    { id: 'v3', at: now - 50 * day + 2000, authors: [], name: 'Релиз' },
    { id: 'v4', at: now - 1000, authors: [] },
  ];
  assert.deepEqual(thin(list, now).map((v) => v.id), ['v2', 'v3', 'v4'], 'one automatic version per old day, the last one');
});

test('versions storage: pictures once for all versions, documents compressed, old versions converted, unused pictures removed', async () => {
  const { Versions } = await import('../src/versions.ts');
  const { FileBlobs } = await import('../src/storage.ts');
  const { randomBytes, createHash } = await import('node:crypto');
  const dir = await mkdtemp(join(tmpdir(), 'cs-versions-'));
  try {
    const files = new FileBlobs(dir);
    const versions = new Versions(files);
    const picture = (seed: number) => {
      const bytes = randomBytes(200_000 + seed);
      return [createHash('sha256').update(bytes).digest('hex'), { mime: 'image/png', data: bytes.toString('base64') }] as const;
    };
    const [h1, b1] = picture(1);
    const nodes = Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, type: 'RECTANGLE', parent: 'root', index: `a${i}`, props: { name: `Прямоугольник ${i}`, width: 100, height: 40 } }));
    const snap = (extra: Record<string, { mime: string; data: string }> = {}) => JSON.stringify({ format: 'canvas-studio', schemaVersion: 1, savedAt: 'x', nodes, blobs: { [h1]: b1, ...extra } });
    const day = 86_400_000;
    const t0 = 100 * day;

    // An old whole-snapshot version, as written before.
    await files.write('fFile00001', 'vaaaaaaaaaaaa.json', snap());
    await files.write('fFile00001', 'versions.json', JSON.stringify([{ id: 'vaaaaaaaaaaaa', at: t0 - 2 * day, authors: ['u1'] }]));

    const v1 = (await versions.add('fFile00001', snap(), { authors: ['u1'], force: true }, t0 - day))!;
    const v2 = (await versions.add('fFile00001', snap(), { authors: [], name: 'Релиз' }, t0))!;
    const names = await files.list('fFile00001');
    assert.equal(names.filter((n) => n.startsWith('b')).length, 1, 'one picture for three versions');
    assert.ok(!names.includes('vaaaaaaaaaaaa.json') && names.includes('vaaaaaaaaaaaa.gz'), 'the old version is converted');
    const total = await versions.size('fFile00001');
    assert.ok(total < 200_000 + 3 * 20_000, `three versions take about one picture (${total} bytes)`);
    for (const id of ['vaaaaaaaaaaaa', v1.id, v2.id]) assert.deepEqual(JSON.parse((await versions.snapshot('fFile00001', id))!), JSON.parse(snap()), `${id} opens as it was`);

    // A version with its own picture, then thinned away (two automatic ones on one old day): its picture goes.
    const [h2, b2] = picture(2);
    await versions.add('fFile00001', snap({ [h2]: b2 }), { authors: ['u1'], force: true }, t0 - 60 * day + 2000);
    await versions.add('fFile00001', snap(), { authors: ['u1'], force: true }, t0 - 60 * day + 3000);
    assert.equal((await files.list('fFile00001')).some((n) => n === `b${h2}`), true, 'kept while a version uses it');
    // The next version (today) thins the old day down to its last version.
    await versions.add('fFile00001', snap(), { authors: ['u1'], force: true }, t0 + 1000);
    assert.equal((await files.list('fFile00001')).some((n) => n === `b${h2}`), false, 'a picture no version uses is removed');
    assert.equal((await files.list('fFile00001')).some((n) => n === `b${h1}`), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('link previews: public addresses only, title, description and picture from the page, redirects checked', async () => {
  const { isPublicAddress, previewTarget, fetchPreview, parsePage } = await import('../src/link-preview.ts');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '159.194.250.13', '2a00:1450:4010::64', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
  for (const bad of ['file:///etc/passwd', 'ftp://a.ru', 'http://user:pw@a.ru', 'http://a.ru:8080/', 'javascript:alert(1)', 'не ссылка']) assert.equal(previewTarget(bad), null, bad);
  assert.equal(previewTarget('https://a.ru/x#y')?.href, 'https://a.ru/x');

  const page = '<html><head><meta charset="utf-8"><title>Запасной</title><meta property="og:title" content="Итоги &laquo;квартала&raquo;"><meta name="description" content="Коротко о главном"><meta content="/pic.png" property="og:image"><meta property="og:site_name" content="Журнал"></head><body>…</body></html>';
  assert.deepEqual(parsePage(page, new URL('https://www.example.com/a')), { title: 'Итоги «квартала»', description: 'Коротко о главном', site: 'Журнал', image: 'https://www.example.com/pic.png' });
  assert.equal(parsePage('<title>Только заголовок</title>', new URL('https://www.example.com/')).site, 'example.com');

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  const asked: string[] = [];
  const get = async (url: URL) => {
    asked.push(url.href);
    if (url.pathname === '/old') return { status: 301, type: '', location: '/a', body: new Uint8Array() };
    if (url.pathname === '/a') return { status: 200, type: 'text/html; charset=utf-8', location: null, body: new TextEncoder().encode(page) };
    if (url.pathname === '/pic.png') return { status: 200, type: 'application/octet-stream', location: null, body: png };
    if (url.pathname === '/inside') return { status: 302, type: '', location: 'http://localhost:8080/admin', body: new Uint8Array() };
    return { status: 404, type: 'text/html', location: null, body: new Uint8Array() };
  };
  const preview = await fetchPreview(new URL('https://example.com/old'), get);
  assert.equal(preview.title, 'Итоги «квартала»');
  assert.equal(preview.url, 'https://example.com/old', 'the card keeps the link that was pasted');
  assert.deepEqual(preview.image, { mime: 'image/png', data: Buffer.from(png).toString('base64') });
  assert.deepEqual(asked, ['https://example.com/old', 'https://example.com/a', 'https://example.com/pic.png']);
  await assert.rejects(fetchPreview(new URL('https://example.com/inside'), get), /bad redirect/, 'a redirect to another port is refused');
  await assert.rejects(fetchPreview(new URL('https://example.com/missing'), get), /status 404/);

  const { netGet } = await import('../src/link-preview.ts');
  await assert.rejects(netGet(new URL('http://127.0.0.1/'), 1000, '*/*'), /not a public address/);
  await assert.rejects(netGet(new URL('http://localhost/'), 1000, '*/*'), /not a public address/);
});

test('API: link previews only for the signed in', async () => {
  const { base, stop } = await start();
  try {
    const res = await fetch(`${base}/api/link-preview?url=${encodeURIComponent('https://example.com/')}`);
    assert.equal(res.status, 401);
  } finally {
    await stop();
  }
});

test('small model requests: texts, notes, names — checked JSON cut to what was asked, never a chat', async () => {
  const asked: Record<string, any>[] = [];
  let content = '';
  const aiFetch = (async (_url: unknown, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-test-'));
  const letters: Letter[] = [];
  const { server } = await createCanvasServer({ dataDir, root: dataDir, dev: null, secure: false, trustProxy: false, openRegistration: true, mailer: async (l) => void letters.push(l), ai: { url: 'https://gw.test/v1/', key: 'test-key', model: 'm' }, aiFetch });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await client(base)('POST', '/api/ai/text', { task: 'notes', slide: ['Итоги'] })).status, 401);
    const api = client(base);
    await signUp(api, letters, 'ait@example.com', 'long password 1', 'Ти');
    assert.equal((await api('POST', '/api/ai/text', { task: 'chat', text: 'привет' })).status, 400, 'only the three tasks');
    // Texts: unknown ids and extra keys are dropped; the model gets the layers, not a page.
    content = 'Вот: {"texts":{"0":"Капучино","9":"лишнее"},"essay":"Лето — это…"}';
    const texts = await api('POST', '/api/ai/text', { task: 'texts', hint: 'для кофейни', items: [{ id: '0', text: 'Title', size: 24, where: 'Шапка' }] });
    assert.equal(texts.status, 200);
    assert.deepEqual(texts.body, { texts: { '0': 'Капучино' } });
    assert.equal(asked.at(-1)!.stream, false);
    assert.match(asked.at(-1)!.messages[1].content, /Wish: для кофейни[\s\S]*"text":"Title"/);
    content = '{"notes":"Сначала скажите о главном."}';
    assert.deepEqual((await api('POST', '/api/ai/text', { task: 'notes', slide: ['Итоги года'], deck: ['Итоги года'] })).body, { notes: 'Сначала скажите о главном.' });
    content = '{"names":{"0":"Шапка"}}';
    assert.deepEqual((await api('POST', '/api/ai/text', { task: 'names', lang: 'ru', items: [{ id: '0', type: 'FRAME', w: 390, h: 64, texts: ['Меню'], children: [], parent: '' }] })).body, { names: { '0': 'Шапка' } });
    // Prose instead of the JSON: an error, the prose does not go out.
    content = 'Конечно! Вот сочинение про лето.';
    const prose = await api('POST', '/api/ai/text', { task: 'notes', slide: ['Итоги'] });
    assert.equal(prose.status, 502);
    assert.doesNotMatch(JSON.stringify(prose.body), /сочинение/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('layout from a description: only signed in, off without a key, the model page passed on as it comes', async () => {
  const sse = (pieces: string[]) => pieces.map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  const asked: Record<string, any>[] = [];
  let answer: () => Response = () => new Response(sse(['Вот: <!DOCTYPE html><html><body>', '<h1>Кофе</h1>', '</body></html>']), { headers: { 'Content-Type': 'text/event-stream' } });
  const aiFetch = (async (_url: unknown, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    return answer();
  }) as typeof fetch;
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-test-'));
  const letters: Letter[] = [];
  const { server } = await createCanvasServer({ dataDir, root: dataDir, dev: null, secure: false, trustProxy: false, openRegistration: true, mailer: async (l) => void letters.push(l), ai: { url: 'https://gw.test/v1/', key: 'test-key', model: 'm' }, aiFetch });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const anon = client(base);
    assert.equal((await anon('POST', '/api/ai/layout', { prompt: 'Лендинг кофейни' })).status, 401);
    const api = client(base);
    await signUp(api, letters, 'ai@example.com', 'long password 1', 'Ая');
    assert.equal((await api('POST', '/api/ai/layout', { prompt: 'a' })).status, 400, 'too short');
    // The text comes through as the model wrote it; width and instructions reach the model.
    const raw = async (body: unknown) => {
      // The client above parses JSON; the answer here is plain text.
      const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1' }, body: JSON.stringify({ email: 'ai@example.com', password: 'long password 1' }) });
      const c = login.headers.get('set-cookie')!.split(';')[0]!;
      return fetch(`${base}/api/ai/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CS': '1', Cookie: c }, body: JSON.stringify(body) });
    };
    const ok = await raw({ prompt: 'Лендинг кофейни', width: 390 });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'Вот: <!DOCTYPE html><html><body><h1>Кофе</h1></body></html>');
    const sent = asked.at(-1)!;
    assert.equal(sent.model, 'm');
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.reasoning, { enabled: false });
    assert.match(sent.messages[0].content, /390px wide/);
    assert.equal(sent.messages[1].content, 'Лендинг кофейни');
    // In a presentation: one slide of the slide's exact size, not a website page to be fitted into it.
    const slide = await raw({ prompt: 'Итоги квартала', width: 1440, slide: { w: 1080, h: 1350 } });
    assert.equal(slide.status, 200);
    await slide.text();
    const asSlide = asked.at(-1)!.messages[0].content as string;
    assert.match(asSlide, /ONE presentation slide of exactly 1080 × 1350 px \(portrait\)/);
    assert.match(asSlide, /height: 1350px; overflow: hidden/);
    assert.doesNotMatch(asSlide, /1440px wide|header with navigation, content in sections/);
    // A change of a page with a file: the page, the request and the file's rows reach the model.
    const changed = await raw({ prompt: 'Добавь цены', width: 390, base: '<html><body><h1>Кофе</h1></body></html>', files: [{ name: 'menu.xlsx', text: 'Капучино\t220' }] });
    assert.equal(changed.status, 200);
    await changed.text();
    const edit = asked.at(-1)!;
    assert.match(edit.messages[0].content, /change request/i);
    assert.match(edit.messages[1].content, /Current page:[\s\S]*<h1>Кофе<\/h1>[\s\S]*Change request: Добавь цены[\s\S]*### menu\.xlsx[\s\S]*Капучино\t220/);
    assert.equal((await raw({ prompt: 'Добавь цены', files: [{ name: 'big.csv', text: 'x'.repeat(90_000) }] })).status, 413);
    // Only layouts: the model's refusal of another request, or prose instead of a page, does not go out.
    assert.match(sent.messages[0].content, /answer exactly OFF_TOPIC/);
    answer = () => new Response(sse(['OFF', '_TOPIC']), { headers: { 'Content-Type': 'text/event-stream' } });
    const offTopic = await raw({ prompt: 'Напиши сочинение про лето' });
    assert.equal(offTopic.status, 422);
    assert.match(((await offTopic.json()) as { message: string }).message, /только с макетами и презентациями/);
    answer = () => new Response(sse(['Конечно! Вот сочинение про лето. ', 'Лето — это '.repeat(60)]), { headers: { 'Content-Type': 'text/event-stream' } });
    const prose = await raw({ prompt: 'Лендинг кофейни' });
    assert.equal(prose.status, 422);
    assert.doesNotMatch(await prose.text(), /сочинение/);
    // Edit blocks are a layout too.
    answer = () => new Response(sse(['<<<<<<< SEARCH\n<h1>Кофе</h1>\n=======\n<h1>Чай</h1>\n>>>>>>> REPLACE']), { headers: { 'Content-Type': 'text/event-stream' } });
    const blocks = await raw({ prompt: 'Замени Кофе на Чай', base: '<html><body><h1>Кофе</h1></body></html>' });
    assert.equal(blocks.status, 200);
    assert.match(await blocks.text(), /REPLACE/);
    // The gateway refuses: an error status with words for the person, not a broken page.
    answer = () => new Response('{"error":"bad key"}', { status: 401 });
    const bad = await raw({ prompt: 'Лендинг кофейни' });
    assert.equal(bad.status, 502);
    assert.match(((await bad.json()) as { message: string }).message, /Нейросеть не ответила/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }

  // No key: the feature is off.
  const off = await start();
  try {
    const api = client(off.base);
    await signUp(api, off.letters, 'off@example.com', 'long password 1', 'Бо');
    const res = await api('POST', '/api/ai/layout', { prompt: 'Лендинг кофейни' });
    assert.equal(res.status, 503);
    assert.equal(res.body?.error, 'ai_off');
  } finally {
    await off.stop();
  }
});

test('behind HTTPS every answer tells the browser to use HTTPS only (HSTS); without it, none', async () => {
  for (const secure of [true, false]) {
    const dataDir = await mkdtemp(join(tmpdir(), 'cs-test-'));
    const { server } = await createCanvasServer({ dataDir, root: dataDir, dev: null, secure, trustProxy: false, openRegistration: true, mailer: async () => {} });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const path of ['/api/me', '/nowhere']) {
        const res = await fetch(base + path, { headers: { 'X-CS': '1' } });
        await res.arrayBuffer();
        assert.equal(res.headers.get('strict-transport-security'), secure ? 'max-age=31536000' : null, path);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

test('heavy files (the neural network): served from their own folder, cached for a year, never outside it; the app may compile WebAssembly', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dataDir = await mkdtemp(join(tmpdir(), 'cs-test-'));
  const heavy = join(dataDir, 'heavy');
  await mkdir(join(heavy, 'ort-1'), { recursive: true });
  await writeFile(join(heavy, 'ort-1', 'x.wasm'), new Uint8Array([0, 97, 115, 109]));
  await writeFile(join(dataDir, 'secret.txt'), 'nope');
  await mkdir(join(dataDir, 'dist'), { recursive: true });
  await writeFile(join(dataDir, 'dist', 'index.html'), '<!doctype html><script>1</script>');
  const { server } = await createCanvasServer({ dataDir: join(dataDir, 'data'), root: dataDir, dev: null, secure: false, trustProxy: false, openRegistration: true, mailer: async () => {}, heavy });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/heavy/ort-1/x.wasm`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/wasm');
    assert.match(ok.headers.get('cache-control')!, /max-age=31536000, immutable/);
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [0, 97, 115, 109]);
    for (const path of ['/heavy/../secret.txt', '/heavy/%2e%2e/secret.txt', '/heavy/ort-1/missing.onnx']) {
      const res = await fetch(base + path);
      assert.notEqual(res.status, 200, path);
      assert.doesNotMatch(await res.text(), /nope/);
    }
    const page = await fetch(`${base}/`);
    await page.text();
    assert.match(page.headers.get('content-security-policy')!, /script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
