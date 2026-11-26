import { expect, test, type Page } from '@playwright/test';

const original = 'ООО Vosmerochka: zakaz taxi';
const corrected = 'OOO Vosmerochka: zakaz taxi';

async function marking(page: Page, bulk = false, historical = false) {
  const effective = { INN: '1234567894', MSISDN: '79000000011', MAV_LABEL_NAME: 'Восьмерочка', MAV_LABEL_LATIN: historical ? corrected : original, IS_MAV: '0', IS_KSS: '1' };
  const issue = { field: 'MAV_LABEL_LATIN', code: 'label_characters', scope: 'cell', message: 'В этикетке на латинице найдены недопустимые символы: ООО' };
  const record = { record_id: 'record', ordinal: 1, line_start: 2, line_end: 2, effective, raw_cells: Object.values(effective), issues: historical ? [] : [issue], disposition: 'excluded_error' };
  const intake = {
    intake: { id: 'labels', case_id: 'case', state: 'COMPLETED', created_at: '2026-10-28T08:00:00Z' },
    source: { id: 'source', filename: 'labels.csv' }, version: { id: 'version', decisions: { partner: 'RTK HUB', operation: 'ADD' } },
    assessment: { result: { operation: 'ADD' }, questions: [] },
    revision: { id: 'revision', case_id: 'case', state: 'PREPARED', settings: { operation: 'ADD' }, source: { id: 'source' }, profile_snapshot: {}, overrides: {}, correction_overlay: historical ? [{ record_id: 'record', field: 'MAV_LABEL_LATIN', before: original, after: corrected }] : [] },
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let json: unknown;
    if (path === '/api/session') json = { authenticated: true, csrf_token: 'fixture', user: { id: 'fixture', username: 'fixture', permissions: ['case.edit', 'package.approve'] } };
    else if (path === '/api/intakes') json = { items: [intake], next_cursor: null };
    else if (path === '/api/intakes/labels') json = intake;
    else if (path.endsWith('/approval')) json = { approved: false, current: true };
    else if (path.endsWith('/review')) json = { summary: { blocking: false, reconciliation: { complete: true }, counts: {} } };
    else if (path.endsWith('/records')) json = { items: bulk && new URL(route.request().url()).searchParams.get('after') === '1' ? [
      { ...record, record_id: 'second', ordinal: 2, effective: { ...effective, MAV_LABEL_NAME: 'ООО «Тест»', MAV_LABEL_LATIN: '"Test"!' } },
      { ...record, record_id: 'manual', ordinal: 3, effective: { ...effective, MAV_LABEL_LATIN: 'Ж Taxi' } },
    ] : [record], columns: Object.keys(effective), next_cursor: bulk && new URL(route.request().url()).searchParams.get('after') !== '1' ? 1 : null };
    else if (path.endsWith('/records/record')) json = { revision_id: 'revision', record, issues: [issue], corrections: [], normalizations: [] };
    else if (path.endsWith('/artifacts')) json = { available: true, artifacts: [] };
    else return route.fulfill({ status: 404, json: {} });
    await route.fulfill({ json });
  });
  await page.goto('/?intake=labels');
}

for (const width of [390, 1440]) test(`marking proposes a Latin correction and keeps the approved edit after reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await marking(page);
  const offer = page.getByTestId('label-correction-offer');
  await expect(offer).toContainText('Ошибок: 1; строк: 1. Можно исправить автоматически: 1.');
  await expect(page.getByRole('cell', { name: original, exact: true })).toBeVisible();
  await expect(page.locator('.record-errors button')).toHaveCount(0);
  await offer.getByRole('button', { name: 'Исправить все ошибки символов (1)', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Применить все замены', exact: true }).click();
  await expect(page.getByRole('cell', { name: corrected, exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Ошибка символов исправлена; сохранено в сессии', exact: true })).toBeVisible();
  await expect(offer.getByRole('button')).toHaveCount(0);
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dogtags.review-draft.v1.fixture.labels')!).corrections);
  expect(saved).toMatchObject([{ field: 'MAV_LABEL_LATIN', before: original, after: corrected }]);
  await page.reload();
  await expect(page.getByRole('cell', { name: corrected, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

for (const width of [390, 1440]) test(`bulk label replacements include unloaded pages, need confirmation and survive reload at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  await marking(page, true);
  await expect(page.getByTestId('label-correction-offer')).toContainText('Ошибок: 4; строк: 3. Можно исправить автоматически: 3.');
  await expect(page.locator('.record-errors button')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath(`automatic-label-offer-${width}.png`), fullPage: true });
  await page.getByRole('button', { name: 'Исправить все ошибки символов (3)', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Будет исправлено полей: 3; строк: 2.');
  await expect(dialog).toContainText('ООО «Тест»');
  await expect(page.getByRole('cell', { name: original, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`bulk-labels-${width}.png`), fullPage: true });
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page.getByRole('cell', { name: original, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Исправить все ошибки символов (3)', exact: true }).click();
  await dialog.getByRole('button', { name: 'Применить все замены', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('cell', { name: corrected, exact: true })).toBeVisible();
  const changes = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dogtags.review-draft.v1.fixture.labels')!).corrections);
  expect(changes).toHaveLength(3);
  await expect(page.getByTestId('label-correction-offer')).toContainText('Ошибок: 1; строк: 1. Можно исправить автоматически: 0.');
  await expect(page.getByRole('cell', { name: 'Ошибка символов исправлена; сохранено в сессии', exact: true })).toBeVisible();
  expect(changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ record_id: 'second', field: 'MAV_LABEL_NAME', after: 'ООО Тест' }),
    expect.objectContaining({ record_id: 'second', field: 'MAV_LABEL_LATIN', after: 'Test' }),
  ]));
  await page.reload();
  await expect(page.getByRole('cell', { name: corrected, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('record editor only changes the Latin label after accepting its proposal', async ({ page }) => {
  await marking(page);
  await page.getByRole('button', { name: 'Редактировать строку 1', exact: true }).click();
  const input = page.locator('#edit-MAV_LABEL_LATIN');
  await expect(input).toHaveValue(original);
  await page.getByRole('button', { name: 'Применить исправление этикетки', exact: true }).click();
  await expect(input).toHaveValue(corrected);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('cell', { name: corrected, exact: true })).toBeVisible();
});

test('corrected status remains visible in a processed revision without a browser draft', async ({ page }) => {
  await marking(page, false, true);
  await expect(page.getByRole('cell', { name: 'Ошибка символов исправлена', exact: true })).toBeVisible();
  await expect(page.getByTestId('label-correction-offer').getByRole('button')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('dogtags.review-draft.v1.fixture.labels'))).toBeNull();
});

for (const width of [390, 1440]) test(`bulk labels send one file-wide command at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await marking(page, true);
  await page.route('**/processing/save-and-start', route =>
    route.fulfill({ json: { status: 'SUCCEEDED', result: {} } }));
  await page.getByRole('button', { name: 'Задать этикетки для всех строк', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Задать этикетки для всех строк' });
  await dialog.getByRole('textbox', { name: 'Этикетка на русском', exact: true }).fill('Новая');
  await dialog.getByRole('textbox', { name: 'Этикетка латиницей', exact: true }).fill('New Label');
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  const write = page.waitForRequest('**/processing/save-and-start');
  await dialog.getByRole('button', { name: 'Применить ко всем строкам', exact: true }).click();
  expect((await write).postDataJSON()).toMatchObject({
    expected_revision_id: 'revision',
    source_asset_id: 'source',
    bulk_labels: { MAV_LABEL_NAME: 'Новая', MAV_LABEL_LATIN: 'New Label' },
  });
  await expect(dialog).toHaveCount(0);
});
