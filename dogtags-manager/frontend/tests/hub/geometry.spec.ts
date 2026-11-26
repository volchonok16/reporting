import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { errorSource, login, newSource } from '../e2e/helpers';

const widths = [320, 390, 768, 1024, 1440, 1920];
async function measure(page: Page, testInfo: TestInfo, form: string, name: string) {
  const section = page.locator(`[data-form="${form}"]`); await expect(section).toBeVisible();
  const result = await section.evaluate(element => {
    const grid = element.querySelector('.form-grid')!, columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const boxes = [...grid.querySelectorAll<HTMLElement>('[data-field]')].map(field => {
      const control = field.querySelector<HTMLElement>('[data-control]')!, box = control.getBoundingClientRect();
      const label = field.querySelector('.field-label')!.getBoundingClientRect(), support = field.querySelector('.field-support')!.getBoundingClientRect();
      return { id: control.id, top: box.top, bottom: box.bottom, left: box.left, height: box.height, labelBottom: label.bottom, supportTop: support.top, supportBottom: support.bottom, fieldTop: field.getBoundingClientRect().top };
    });
    const rows = [], leftDeltas: number[] = [];
    for (let index = 0; index < boxes.length; index += columns) {
      const row = boxes.slice(index, index + columns);
      rows.push({ top: Math.max(...row.map(box => box.top)) - Math.min(...row.map(box => box.top)), bottom: Math.max(...row.map(box => box.bottom)) - Math.min(...row.map(box => box.bottom)) });
      if (index > 0) row.forEach((box, column) => leftDeltas.push(Math.abs(box.left - boxes[column].left)));
    }
    const actions = [...document.querySelectorAll<HTMLElement>('.button')].filter(button => button.getClientRects().length).map(button => ({ height: button.getBoundingClientRect().height, width: button.getBoundingClientRect().width }));
    return { browser: navigator.userAgent, viewport: innerWidth, deviceScale: devicePixelRatio, rootFont: getComputedStyle(document.documentElement).fontSize, container: getComputedStyle(element).containerType, columns, boxes, rows, leftDeltas, actions, bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  const path = testInfo.outputPath(`${name}-${form}.json`); await writeFile(path, JSON.stringify(result, null, 2)); await testInfo.attach(`${name}-${form}`, { path, contentType: 'application/json' });
  expect(result.bodyOverflow).toBeLessThanOrEqual(1); expect(result.container).toBe('inline-size');
  result.rows.forEach(row => { expect(row.top).toBeLessThanOrEqual(1); expect(row.bottom).toBeLessThanOrEqual(1); });
  result.leftDeltas.forEach(delta => expect(delta).toBeLessThanOrEqual(1));
  result.boxes.forEach(box => { expect(box.height).toBeGreaterThanOrEqual(44); expect(box.top).toBeGreaterThanOrEqual(box.labelBottom); expect(box.supportTop).toBeGreaterThanOrEqual(box.bottom); });
  result.actions.forEach(action => { expect(action.height).toBeGreaterThanOrEqual(44); expect(action.width).toBeGreaterThanOrEqual(44); });
  for (let index = result.columns; index < result.boxes.length; index += result.columns) expect(result.boxes[index].fieldTop).toBeGreaterThanOrEqual(Math.max(...result.boxes.slice(index - result.columns, index).map(box => box.supportBottom)));
  return result;
}

for (const width of widths) test(`real HUB blocked, readonly, root-font 200% and text spacing at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 }); await login(page); await newSource(page, errorSource);
  await page.getByRole('button', { name: 'Проверить файл', exact: true }).click(); await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Открыть запись 1', exact: true }).click();
  for (const form of ['source', 'profile', 'record']) await measure(page, testInfo, form, 'blocked');
  await expect(page.locator('#edit-INN')).toHaveAccessibleDescription(/Научная запись/);
  await expect(page.locator('#edit-MAV_LABEL_NAME')).toHaveValue('Б'.repeat(33));
  await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await expect(page.locator('#edit-INN')).toHaveAttribute('readonly', '');
  for (const form of ['source', 'profile', 'record']) await measure(page, testInfo, form, 'readonly');
  await page.addStyleTag({ content: 'html { font-size: 200%; } * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-block-end: 2em !important; }' });
  for (const form of ['source', 'profile', 'record']) await measure(page, testInfo, form, 'root-font-200-text-spacing');
  expect(await page.locator('.field-label, .field-support, .button').evaluateAll(elements => elements.every(element => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1))).toBe(true);
  await page.getByRole('button', { name: 'Перечитать сохранённую заявку', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Перечитать сохранённую заявку', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath(`hub-${width}-root-font-200.png`), fullPage: true });
});

test('real HUB form follows a narrow query container at a wide viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1000 }); await login(page); await newSource(page);
  const wide = await measure(page, testInfo, 'profile', 'wide'); expect(wide.columns).toBe(2);
  await page.locator('[data-form="profile"]').evaluate(element => { (element as HTMLElement).style.maxInlineSize = 'var(--assistant)'; });
  const narrow = await measure(page, testInfo, 'profile', 'narrow'); expect(narrow.columns).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('hub-narrow-container.png'), fullPage: true });
});
