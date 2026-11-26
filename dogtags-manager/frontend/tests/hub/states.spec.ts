import { expect, test } from '@playwright/test';
import { login, newCase, prepare, revisionPath, validSource, forwardValidUpload } from '../e2e/helpers';

const header = 'INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS';

test('first use and source parser states remain distinguishable, unknown count is never zero', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Подготовка комплекта HUB', exact: true })).toBeVisible();
  await expect(page.getByLabel('Файл HUB CSV', { exact: false })).toBeDisabled();
  await expect(page.getByText('Войдите и создайте или откройте заявку, затем выберите источник.', { exact: true })).toBeVisible();
  await login(page);
  for (const [name, body, expected] of [
    ['header-only.csv', `${header}\n`, 'В источнике нет записей'],
    ['unknown-parser.csv', `${header}\n1234567894;"unterminated`, 'Количество записей неизвестно'],
    ['unsupported.csv', `INN;INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n1234567894;duplicate-header;00123456789;Тест;Test;1;1;EXTRA-RAW-CELL\n`, 'Колонки не соответствуют HUB v1'],
  ] as const) {
    await newCase(page);
    await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(body) });
    await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click();
    await expect(page.locator('.alert-title').filter({ hasText: 'Требуется заменить исходный файл' })).toBeVisible();
    if (name === 'header-only.csv') await expect(page.getByText(/Записей: 0/)).toBeVisible();
    else await expect(page.getByText(new RegExp(expected, 'i'))).toBeVisible();
    await expect(page.getByRole('button', { name: 'Проверить файл', exact: true })).toBeDisabled();
    if (name === 'unknown-parser.csv') await expect(page.getByText(/Записей: Неизвестно/)).toBeVisible();
    if (name === 'unsupported.csv') {
      await page.getByRole('button', { name: 'Открыть запись 1', exact: true }).click();
      await expect(page.getByRole('table', { name: 'Исходное и действующее значения' })).toContainText('EXTRA-RAW-CELL');
      await expect(page.getByRole('table', { name: 'Исходное и действующее значения' })).toContainText('Колонка без заголовка 8');
      await expect(page.locator('#edit-INN')).toHaveAttribute('readonly', '');
    }
  }
});

test('shape mismatch blocks all artifacts and requires replacement rather than a cell correction', async ({ page }) => {
  await login(page); await newCase(page);
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles({ name: 'shape.csv', mimeType: 'text/csv', buffer: Buffer.from(`${header}\n1234567894;00123456789;Тест;Test;1;1;trailing-cell-must-survive\n`) });
  await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить файл', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toContainText('Выпуск заблокирован', { timeout: 60_000 });
  await expect(page.locator('.alert-title').filter({ hasText: 'Требуется заменить исходный файл' })).toBeVisible();
  await page.getByRole('button', { name: 'Открыть запись 1', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Исходное и действующее значения' })).toContainText('trailing-cell-must-survive');
  await expect(page.locator('#edit-INN')).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Добавить исправления в черновик', exact: true })).toBeDisabled();
});

test('record and CSV preview pagination is bounded and replaces pages', async ({ page }) => {
  await login(page); await newCase(page);
  const body = `${header}\n${Array.from({ length: 1001 }, (_, index) => `1234567894;00${String(index + 1).padStart(9, '0')};Тест;Test;1;1`).join('\n')}\n`;
  const requests: URL[] = [];
  page.on('request', request => { if (/\/(records|issues|preview)\?/.test(request.url())) requests.push(new URL(request.url())); });
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles({ name: 'pages.csv', mimeType: 'text/csv', buffer: Buffer.from(body) });
  await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click(); await prepare(page);
  const records = page.getByRole('table', { name: 'Исходные записи и исход обработки — одна страница' });
  const firstCount = await records.getByRole('row').count(); expect(firstCount).toBeLessThanOrEqual(502);
  await page.getByRole('region', { name: 'Исходные записи и исход обработки — одна страница', exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(records.getByRole('button', { name: 'Открыть запись 501', exact: true })).toBeVisible();
  await expect(records.getByRole('button', { name: 'Открыть запись 1', exact: true })).toHaveCount(0);
  expect(await records.getByRole('row').count()).toBeLessThanOrEqual(502);
  await page.getByRole('button', { name: 'Предпросмотр NUMBERS', exact: true }).click();
  const preview = page.getByRole('table', { name: 'CSV предпросмотр NUMBERS — одна страница' });
  expect(await preview.getByRole('row').count()).toBeLessThanOrEqual(502);
  await page.getByRole('region', { name: 'CSV предпросмотр NUMBERS — одна страница', exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(preview).not.toContainText('00000000001');
  expect(requests.every(url => !url.searchParams.has('limit'))).toBe(true);
  expect(requests.some(url => Number(url.searchParams.get('after')) > 0)).toBe(true);
});

test('processing uses compact job reads, and a real mutation loading button remains in place', async ({ page }, testInfo) => {
  await login(page); await newCase(page);
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles(validSource);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void; const started = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/sources?**', async route => { const response = await forwardValidUpload(page, route); arrived(); await gate; await route.fulfill({ response }); }, { times: 1 });
  const action = page.getByRole('button', { name: 'Сохранить источник', exact: true });
  await action.scrollIntoViewIfNeeded();
  const documentBox = () => action.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; });
  const before = await documentBox();
  try {
    await action.click(); await started; await expect(action).toHaveAttribute('aria-busy', 'true');
    const after = await documentBox();
    await testInfo.attach('loading-action-document-coordinates', { body: JSON.stringify({ before, after }, null, 2), contentType: 'application/json' });
    for (const dimension of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(after[dimension] - before[dimension])).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('real-upload-loading.png'), fullPage: true });
  } finally { release(); }
  await expect(page.getByTestId('revision-id')).toHaveText(/[0-9a-f-]{36}/);
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  const seen: string[] = []; page.on('request', request => { if (request.method() === 'GET') seen.push(request.url()); });
  await prepare(page);
  expect(seen.some(url => new URL(url).pathname.startsWith(`/api/cases/${c}/processing/`))).toBe(true);
  expect(seen.filter(url => new URL(url).pathname === revisionPath(c, r)).length).toBeLessThanOrEqual(1);
});
