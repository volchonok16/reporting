import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const bytes = Buffer.from('MSISDN;INN\r\n79000000011;7701234567\r\n');
const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);

async function results(page: Page, options: { unsupported?: boolean; cancel?: boolean; corrupt?: boolean; writeError?: boolean; workflow?: boolean } = {}) {
  await page.addInitScript(({ unsupported, cancel, writeError }) => {
    const state = { names: [] as string[], saved: [] as number[], closed: false, aborted: false };
    Object.assign(window, { saveTest: state });
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: unsupported ? undefined : async ({ suggestedName }: { suggestedName: string }) => {
      state.names.push(suggestedName);
      if (cancel) throw new DOMException('Cancelled', 'AbortError');
      return { name: suggestedName, createWritable: async () => ({
        write: async (blob: Blob) => {
          if (writeError) throw new DOMException('Disk full', 'QuotaExceededError');
          state.saved = Array.from(new Uint8Array(await blob.arrayBuffer()));
        },
        close: async () => { state.closed = true; },
        abort: async () => { state.aborted = true; },
      }) };
    } });
  }, options);
  const intake = {
    intake: { id: 'download', case_id: 'case', created_at: '2026-10-27T08:00:00Z', state: 'COMPLETED' },
    source: { id: 'source', filename: 'source.csv' },
    version: { id: 'version', decisions: { partner: 'RTK HUB', operation: 'ADD' } },
    assessment: { result: { operation: 'ADD' }, questions: [] },
    revision: { id: 'revision', case_id: 'case', state: 'APPROVED', settings: { operation: 'ADD' }, profile_snapshot: {}, overrides: {} },
  };
  const downloads: string[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let json: unknown;
    if (path === '/api/session') json = { authenticated: true, csrf_token: 'fixture', user: { id: 'fixture', username: 'fixture', permissions: ['case.edit', 'package.approve'] } };
    else if (path === '/api/intakes') json = { items: [intake], next_cursor: null };
    else if (path === '/api/intakes/download') json = intake;
    else if (path.endsWith('/approval')) json = { current: true, approved: true };
    else if (path.endsWith('/review')) json = { summary: { blocking: false, reconciliation: { complete: true }, counts: {} } };
    else if (path.endsWith('/records')) json = { items: [], next_cursor: null };
    else if (path.endsWith('/artifacts')) json = { available: true, manifest_hash: 'f'.repeat(64), artifacts: ['NUMBERS', 'ZIP'].map(role => {
      const content = role === 'ZIP' ? zipBytes : bytes;
      return { id: role, role, download_filename: role === 'ZIP' ? 'package.zip' : 'NUMBERS.csv', size_bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), row_count: role === 'ZIP' ? null : 1 };
    }) };
    else if (path.endsWith('/download')) {
      downloads.push(path);
      return route.fulfill({ body: options.corrupt ? Buffer.alloc(bytes.length) : path.includes('/ZIP/') ? zipBytes : bytes });
    } else return route.fulfill({ status: 404, json: {} });
    await route.fulfill({ json });
  });
  await page.goto(options.workflow ? '/?intake=download' : '/?section=archive');
  if (!options.workflow) await page.getByRole('button', { name: /^Открыть обработку source.csv/ }).click();
  await expect(page.getByRole('button', { name: 'Скачать NUMBERS', exact: true })).toBeEnabled();
  return downloads;
}

for (const workflow of [false, true]) test(`Save As writes verified CSV and ZIP to the selected files (${workflow ? 'workflow' : 'archive'})`, async ({ page }) => {
  await results(page, { workflow });
  for (const [role, filename, content] of [['NUMBERS', 'NUMBERS.csv', bytes], ['ZIP', 'package.zip', zipBytes]] as const) {
    await page.getByRole('button', { name: `Сохранить ${role} как…`, exact: true }).click();
    await expect(page.getByText(`Файл «${filename}» сохранён в выбранном месте.`, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).saveTest)).toMatchObject({ saved: Array.from(content), closed: true });
  }
  expect(await page.evaluate(() => (window as any).saveTest.names)).toEqual(['NUMBERS.csv', 'package.zip']);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole('button', { name: 'Сохранить NUMBERS как…', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
});

test('cancelling Save As does not fetch or report a saved file', async ({ page }) => {
  const downloads = await results(page, { cancel: true });
  await page.getByRole('button', { name: 'Сохранить NUMBERS как…', exact: true }).click();
  await expect(page.getByText('Сохранение отменено.', { exact: true })).toBeVisible();
  expect(downloads).toEqual([]);
  expect(await page.evaluate(() => (window as any).saveTest.closed)).toBe(false);
});

test('failed integrity check leaves the chosen file untouched', async ({ page }) => {
  await results(page, { corrupt: true });
  await page.getByRole('button', { name: 'Сохранить NUMBERS как…', exact: true }).click();
  await expect(page.getByText(/Хеш полученного файла не совпадает с показанным комплектом/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).saveTest)).toMatchObject({ saved: [], closed: false });
});

test('failed disk write reports failure and aborts the unfinished write', async ({ page }) => {
  await results(page, { writeError: true });
  await page.getByRole('button', { name: 'Сохранить NUMBERS как…', exact: true }).click();
  await expect(page.getByText('Не удалось сохранить файл в выбранном месте. Проверьте доступ к папке и свободное место.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).saveTest)).toMatchObject({ saved: [], closed: false, aborted: true });
});

test('Safari users see Save As instructions before the browser downloads the file', async ({ page }) => {
  const downloads = await results(page, { unsupported: true });
  await page.getByRole('button', { name: 'Сохранить NUMBERS как…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Выбор папки для скачивания' });
  await expect(dialog).toContainText('Спрашивать при каждой загрузке');
  expect(downloads).toEqual([]);
  await expect(page.getByText(/Для выбора папки включите в настройках браузера/)).toBeVisible();
  const received = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать файл', exact: true }).click();
  const download = await received;
  expect(download.suggestedFilename()).toBe('NUMBERS.csv');
  expect(await download.failure()).toBeNull();
});

for (const width of [390, 1440]) test(`completion action is a fixed notification in the upper right at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  await results(page, { workflow: true });
  const toast = page.getByRole('complementary', { name: 'Обработка завершена' });
  await expect(toast.getByRole('button', { name: 'Завершить', exact: true })).toBeVisible();
  expect(await toast.evaluate(node => getComputedStyle(node).position)).toBe('fixed');
  const bounds = (await toast.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeLessThan(50);
  expect(width - bounds.x - bounds.width).toBeGreaterThanOrEqual(0);
  expect(width - bounds.x - bounds.width).toBeLessThan(50);
  await page.screenshot({ path: testInfo.outputPath(`completion-toast-${width}.png`), fullPage: true });
  await toast.getByRole('button', { name: 'Завершить', exact: true }).click();
  await expect(toast).toHaveCount(0);
});
