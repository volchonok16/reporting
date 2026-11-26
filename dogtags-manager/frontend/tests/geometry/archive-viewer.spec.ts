import { expect, test, type Page } from '@playwright/test';

async function archiveFixture(page: Page, archiveCount = 40, firstFilename?: string) {
  page.on('pageerror', error => { throw error; });
  const items = Array.from({ length: archiveCount }, (_, i) => ({
    intake: { id: `intake-${i}`, case_id: `case-${i}`, created_at: '2026-10-13T08:00:00Z', worked_at: '2026-10-13T08:00:00Z', state: 'COMPLETED', deleted_at: null },
    source: { id: `source-${i}`, filename: i === 0 && firstFilename ? firstFilename : `archive-${i}.csv` },
    version: { id: `version-${i}`, decisions: { partner: 'RTK HUB', operation: 'ADD' } },
    revision: { id: `revision-${i}`, case_id: `case-${i}`, state: 'APPROVED', profile_snapshot: { SPREADING: '0', INTERNAL_OPERATOR_NAME: 'hubRTK' }, overrides: {}, settings: { operation: 'ADD', SPREADING: 0, INTERNAL_OPERATOR_NAME: 'hubRTK' } },
  }));
  const reads: string[] = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let json: unknown;
    if (url.pathname === '/api/session') json = { authenticated: true, csrf_token: 'fixture', user: { id: 'fixture-user', username: 'fixture', permissions: ['case.edit', 'package.approve'] } };
    else if (url.pathname === '/api/intakes') {
      const after = Number((url.searchParams.get('after') ?? 'list-0').replace('list-', ''));
      json = { items: items.slice(after, after + 500), next_cursor: after + 500 < items.length ? `list-${after + 500}` : null };
    }
    else if (/\/api\/intakes\/intake-/.test(url.pathname)) json = items.find(item => url.pathname.endsWith(item.intake.id));
    else if (url.pathname.endsWith('/approval')) json = { current: true, approved: true };
    else if (url.pathname.endsWith('/artifacts')) json = { available: true, manifest_hash: 'fixture', artifacts: ['CLIENTS', 'NUMBERS', 'ERRORS', 'ZIP'].map(role => ({ id: role, role, row_count: 2001, download_filename: `${role}.csv` })) };
    else if (url.pathname.includes('/preview')) {
      reads.push(url.pathname + url.search);
      const role = url.pathname.split('/').at(-2)!;
      const after = Number(url.searchParams.get('after') ?? 0);
      json = { role, columns: ['INN', 'MSISDN', 'Комментарий', 'ERROR_FIELDS', 'ERROR_MESSAGES'], items: Array.from({ length: Math.min(500, 2001 - after) }, (_, i) => ['7701234567', '79000000011', `Строка ${after + i + 1}: длинный комментарий исходника для проверки переноса по словам\nВторая строка комментария`, 'INN', 'Некорректный ИНН']), next_cursor: after + 500 < 2001 ? after + 500 : null };
    } else return route.fulfill({ status: 404, json: {} });
    await route.fulfill({ json });
  });
  await page.goto('/?section=archive');
  return reads;
}

test('archive preview owns its table scroll, replaces files and preserves mobile list position', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reads = await archiveFixture(page);
  await page.getByRole('button', { name: /^Открыть обработку archive-0.csv/ }).click();
  const pane = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
  await expect(page.getByRole('button', { name: 'Фильтр: Архив обработок', exact: true })).toHaveCount(0);
  await expect(page.locator('.archive-list thead')).toHaveCount(0);
  await expect(pane.getByRole('region', { name: 'Выходные файлы', exact: true })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Содержимое файла', exact: true })).toHaveCount(0);
  await pane.getByRole('button', { name: 'Предпросмотр Строки с ошибками', exact: true }).click();
  const preview = pane.getByRole('table', { name: 'Предпросмотр Строки с ошибками', exact: true });
  await expect(preview).toContainText('Строка 1:');
  await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(pane.locator('.archive-preview-block .table-region')).toBeFocused();
  expect(await preview.evaluate(table => {
    let node = table.parentElement;
    let count = 0;
    while (node && node !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) count++;
      node = node.parentElement;
    }
    return count;
  })).toBe(2);
  await pane.locator('.archive-preview-block .table-region').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => reads.some(read => read.includes('after=500'))).toBe(true);
  await expect(preview).toContainText('Строка 501:');
  await pane.getByRole('button', { name: 'Предпросмотр CLIENTS', exact: true }).click();
  await expect(pane.getByRole('table', { name: 'Предпросмотр CLIENTS', exact: true })).toContainText('Строка 1:');
  await expect(preview).toHaveCount(0);
  await page.getByRole('button', { name: /^Открыть обработку archive-1.csv/ }).click();
  await expect(pane.getByRole('region', { name: 'Выходные файлы', exact: true })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Содержимое файла', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await pane.getByRole('button', { name: 'Назад к списку', exact: true }).click();
  const list = page.getByRole('region', { name: 'Архив обработок', exact: true });
  await list.evaluate(element => { element.scrollTop = 700; });
  const button = page.getByRole('button', { name: /^Открыть обработку archive-10.csv/ });
  await button.scrollIntoViewIfNeeded();
  const saved = await list.evaluate(element => element.scrollTop);
  await button.click();
  await expect(pane.getByRole('button', { name: 'Назад к списку', exact: true })).toBeFocused();
  await pane.getByRole('button', { name: 'Назад к списку', exact: true }).click();
  await expect(button).toBeFocused();
  expect(await list.evaluate(element => element.scrollTop)).toBeCloseTo(saved, 0);
});

for (const mode of ['500 строк', '1000 строк', 'Все строки']) test(`archive ${mode} keeps a bounded window and returns from a one-row final page`, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const reads = await archiveFixture(page);
  await page.getByRole('button', { name: /^Открыть обработку archive-0.csv/ }).click();
  const pane = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
  await pane.getByRole('button', { name: 'Предпросмотр Строки с ошибками', exact: true }).click();
  const preview = pane.getByRole('table', { name: 'Предпросмотр Строки с ошибками', exact: true });
  await expect(preview).toContainText('Строка 1:');
  await pane.getByRole('button', { name: 'Фильтр: Предпросмотр Строки с ошибками', exact: true }).click();
  await page.getByRole('radiogroup').getByLabel(mode, { exact: true }).check();
  for (const after of [500, 1000, 1500, 2000]) {
    await pane.locator('.archive-preview-block .table-region').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => reads.some(read => read.includes(`after=${after}`))).toBe(true);
    await expect(preview).toContainText(`Строка ${after + 1}:`);
    expect(await preview.locator('tbody tr[data-scroll-id]').count()).toBeLessThanOrEqual(1500);
  }
  await pane.locator('.archive-preview-block .table-region').evaluate(element => { element.scrollTop = 1; });
  await expect(preview).toContainText(mode === 'Все строки' ? 'Строка 501:' : mode === '1000 строк' ? 'Строка 1001:' : 'Строка 1501:');
});

test('late cursor response cannot replace another file and retry stays reachable', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await archiveFixture(page);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/artifacts/ERRORS/preview?after=500*', async route => {
    started(); await gate;
    await route.fulfill({ json: { role: 'ERRORS', columns: ['ERROR_MESSAGES'], items: [['OLD FILE ROW']], next_cursor: null } });
  }, { times: 1 });
  await page.getByRole('button', { name: /^Открыть обработку archive-0.csv/ }).click();
  const pane = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
  await pane.getByRole('button', { name: 'Предпросмотр Строки с ошибками', exact: true }).click();
  await expect(pane.getByRole('table', { name: 'Предпросмотр Строки с ошибками', exact: true })).toContainText('Строка 1:');
  await pane.locator('.archive-preview-block .table-region').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await held;
  await pane.getByRole('button', { name: 'Предпросмотр CLIENTS', exact: true }).click();
  release();
  const clients = pane.getByRole('table', { name: 'Предпросмотр CLIENTS', exact: true });
  await expect(clients).toContainText('Строка 1:');
  await expect(pane).not.toContainText('OLD FILE ROW');
  await page.route('**/artifacts/CLIENTS/preview?after=500*', route => route.fulfill({ status: 503, json: { error: { message: 'Cursor failed' } } }), { times: 1 });
  await pane.locator('.archive-preview-block .table-region').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(pane.getByRole('button', { name: 'Повторить загрузку', exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  await expect(clients).toContainText('Строка 501:');
});

test('archive headers, identifiers and filters remain usable with enlarged text and wheel or keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await archiveFixture(page);
  await page.getByRole('button', { name: /^Открыть обработку archive-0.csv/ }).click();
  const pane = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
  await pane.getByRole('button', { name: 'Предпросмотр Строки с ошибками', exact: true }).click();
  const preview = pane.getByRole('table', { name: 'Предпросмотр Строки с ошибками', exact: true });
  await expect(preview).toContainText('Строка 1:');
  expect(await preview.locator('.artifact-identifier').first().evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap');
  await expect(preview.getByRole('columnheader', { name: 'Причины ошибок', exact: true })).toHaveCount(0);
  await expect(preview.getByRole('columnheader', { name: 'Поля с ошибками', exact: true })).toHaveCount(0);
  await expect(preview.locator('.repair-field-error').first()).toHaveAttribute('title', 'Некорректный ИНН');
  await expect(preview.locator('.repair-field-error').first()).toHaveText('7701234567');
  const tableRegion = pane.locator('.archive-preview-block .table-region');
  await tableRegion.hover(); await page.mouse.wheel(0, 500);
  await expect.poll(() => tableRegion.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await tableRegion.focus(); const before = await tableRegion.evaluate(element => element.scrollTop); await page.keyboard.press('PageDown');
  await expect.poll(() => tableRegion.evaluate(element => element.scrollTop)).toBeGreaterThan(before);
  for (const width of [320, 768, 1440]) for (const percent of [100, 200]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(value => { document.documentElement.style.fontSize = `${value}%`; }, percent);
    await pane.locator('.archive-preview-block .table-region').evaluate(element => { element.scrollTop = 0; });
    await pane.getByRole('button', { name: 'Фильтр: Предпросмотр Строки с ошибками', exact: true }).click();
    const options = page.getByRole('radiogroup', { name: 'Количество строк', exact: true });
    await expect(options).toBeVisible();
    const rect = await options.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    expect(rect!.y).toBeGreaterThanOrEqual(0); expect(rect!.y + rect!.height).toBeLessThanOrEqual(1000);
    await page.keyboard.press('Escape');
  }
});

test('mobile Back preserves the list anchor when a cursor read finishes while hidden', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await archiveFixture(page, 1001);
  const list = page.getByRole('region', { name: 'Архив обработок', exact: true });
  const choice = page.getByRole('button', { name: /^Открыть обработку archive-400.csv/ });
  await choice.scrollIntoViewIfNeeded();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/intakes?after=list-500*', async route => { started(); await gate; await route.fallback(); }, { times: 1 });
  await list.getByRole('button', { name: 'Фильтр: Архив обработок', exact: true }).click();
  await page.getByRole('radiogroup').getByLabel('1000 строк', { exact: true }).check();
  await held;
  const saved = await list.evaluate(element => element.scrollTop);
  await choice.click(); release();
  const pane = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
  await expect(pane.getByRole('button', { name: 'Назад к списку', exact: true })).toBeFocused();
  await pane.getByRole('button', { name: 'Назад к списку', exact: true }).click();
  await expect(choice).toBeFocused();
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeCloseTo(saved, 0);
});

test('touch scrolling keeps mobile Back reachable', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 }, baseURL: 'http://127.0.0.1:5173' });
  const page = await context.newPage();
  try {
    await archiveFixture(page);
    await page.getByRole('button', { name: /^Открыть обработку archive-0.csv/ }).tap();
    const pane = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
    await pane.getByRole('button', { name: 'Предпросмотр Строки с ошибками', exact: true }).tap();
    await expect(pane.getByRole('table', { name: 'Предпросмотр Строки с ошибками', exact: true })).toContainText('Строка 1:');
    const box = await pane.locator('.archive-preview-block .table-region').boundingBox(), client = await context.newCDPSession(page);
    await client.send('Input.synthesizeScrollGesture', { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2, yDistance: -600, gestureSourceType: 'touch' });
    await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(pane.getByRole('button', { name: 'Назад к списку', exact: true })).toBeInViewport();
  } finally { await context.close(); }
});


test('long archive names expand downward and keep the viewer width', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const filename = 'Очень длинное имя исходного файла партнёра — заявка на обработку маркировки и исправление данных.csv';
  await archiveFixture(page, 40, filename);
  const choice = page.getByRole('button', { name: new RegExp(`^Открыть обработку ${filename}`) });
  const next = page.getByRole('button', { name: /^Открыть обработку archive-1.csv/ });
  const viewer = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
  const before = await choice.boundingBox(), nextBefore = await next.boundingBox(), viewerBefore = await viewer.boundingBox();
  expect(await choice.locator('.archive-name-short').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await choice.hover();
  await expect(choice).toHaveAttribute('data-name-expanded', 'true');
  await expect.poll(async () => (await choice.boundingBox())!.height).toBeGreaterThan(before!.height + 20);
  expect((await next.boundingBox())!.y).toBeGreaterThan(nextBefore!.y);
  const viewerAfter = await viewer.boundingBox();
  expect(viewerAfter!.width).toBe(viewerBefore!.width);
  expect(viewerAfter!.x).toBe(viewerBefore!.x);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await viewer.hover();
  await expect(choice).toHaveAttribute('data-name-expanded', 'false');
  await expect.poll(async () => (await choice.boundingBox())!.height).toBe(before!.height);
});
