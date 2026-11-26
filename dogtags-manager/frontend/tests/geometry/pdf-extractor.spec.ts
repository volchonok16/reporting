import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// A real, synthetic PDF: tests exercise PDF.js and its worker, not a text-reader mock.
function pdfFixture(pages: string[][]): Buffer {
  const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const references: string[] = [];
  for (const lines of pages) {
    const page = objects.length, stream = page + 1;
    references.push(`${page} 0 R`);
    const content = `BT /F1 12 Tf 72 740 Td ${lines.map((line, i) => `${i ? '0 -20 Td ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${references.join(' ')}] /Count ${pages.length} >>`;
  let result = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(result));
    result += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(result);
}

async function openExtractor(page: Page) {
  const mutations: string[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (route.request().method() !== 'GET') mutations.push(path);
    if (path === '/api/session') return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture', user: { id: 'fixture', username: 'fixture', permissions: ['case.read'] } } });
    if (path === '/api/intakes') return route.fulfill({ json: { items: [], next_cursor: null } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Экстрактор PDF', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Экстрактор данных из PDF', exact: true })).toBeVisible();
  return mutations;
}

const source = pdfFixture([
  ['First +7 (900) 000-00-11', 'Second 8 (800) 555-35-35', 'Repeated +7 (900) 000-00-11'],
  ['Third 999 123 45 67'], [],
]);

for (const width of [390, 1440]) test(`real PDF produces one downloadable list with optional duplicates at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const mutations = await openExtractor(page);
  await page.getByLabel('PDF-файл', { exact: true }).setInputFiles({ name: 'contacts.pdf', mimeType: 'application/pdf', buffer: source });
  await page.getByRole('button', { name: 'Извлечь номера', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Обработано страниц: 3. Найдено номеров: 4. Уникальных: 3.');
  await expect(page.getByText('Есть страницы без текста', { exact: false })).toBeVisible();
  await expect(page.locator('#pdf-result')).toHaveValue('79000000011\n88005553535\n9991234567');
  const received = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать список', exact: true }).click();
  const txt = await received;
  expect(txt.suggestedFilename()).toBe('contacts-numbers.txt');
  expect(await readFile((await txt.path())!, 'utf8')).toBe('79000000011\r\n88005553535\r\n9991234567\r\n');
  await page.getByLabel('Удалить повторяющиеся номера', { exact: true }).uncheck();
  await page.getByLabel('Формат списка', { exact: true }).selectOption('csv');
  const receivedCsv = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать список', exact: true }).click();
  const csv = await receivedCsv;
  expect(await readFile((await csv.path())!, 'utf8')).toBe('MSISDN\r\n79000000011\r\n88005553535\r\n79000000011\r\n9991234567\r\n');
  expect(mutations).toEqual([]);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Маркировка', exact: true }).click();
  await page.getByRole('button', { name: 'Экстрактор PDF', exact: true }).click();
  await expect(page.locator('#pdf-result')).toHaveValue('79000000011\n88005553535\n79000000011\n9991234567');
  await page.screenshot({ path: test.info().outputPath(`pdf-extractor-${width}.png`), fullPage: true });
});

test('a PDF without telephone numbers has no downloadable stale result', async ({ page }) => {
  await openExtractor(page);
  await page.getByLabel('PDF-файл', { exact: true }).setInputFiles({ name: 'empty.pdf', mimeType: 'application/pdf', buffer: pdfFixture([['No phone numbers here.']]) });
  await page.getByRole('button', { name: 'Извлечь номера', exact: true }).click();
  await expect(page.getByText('Номера не найдены', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Скачать список', exact: true })).toHaveCount(0);
});

test('an invalid PDF reports an error and a later valid PDF still works', async ({ page }) => {
  await openExtractor(page);
  const input = page.getByLabel('PDF-файл', { exact: true });
  await input.setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
  await page.getByRole('button', { name: 'Извлечь номера', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось прочитать PDF');
  await input.setInputFiles({ name: 'valid.pdf', mimeType: 'application/pdf', buffer: source });
  await page.getByRole('button', { name: 'Извлечь номера', exact: true }).click();
  await expect(page.locator('#pdf-result')).toHaveValue('79000000011\n88005553535\n9991234567');
});

test('extraction can be cancelled without returning a partial list', async ({ page }) => {
  await openExtractor(page);
  const buffer = pdfFixture(Array.from({ length: 300 }, () => ['Phone +7 (900) 000-00-11']));
  await page.getByLabel('PDF-файл', { exact: true }).setInputFiles({ name: 'many-pages.pdf', mimeType: 'application/pdf', buffer });
  await page.getByRole('button', { name: 'Извлечь номера', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить извлечение', exact: true }).click();
  await expect(page.getByText('Извлечение отменено.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Скачать список', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Извлечь номера', exact: true })).toBeEnabled();
});

test('Save As writes the complete extracted list through the selected file handle', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: async () => ({ createWritable: async () => ({
      write: async (blob: Blob) => { (window as any).savedList = await blob.text(); },
      close: async () => {}, abort: async () => {},
    }) }) });
  });
  await openExtractor(page);
  await page.getByLabel('PDF-файл', { exact: true }).setInputFiles({ name: 'contacts.pdf', mimeType: 'application/pdf', buffer: source });
  await page.getByRole('button', { name: 'Извлечь номера', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить список номеров как…', exact: true }).click();
  await expect(page.getByText('Список сохранён в выбранном месте.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).savedList)).toBe('79000000011\r\n88005553535\r\n9991234567\r\n');
});
