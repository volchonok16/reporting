import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) test(`MSISDN cleanup popup reports rows across pages at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const revision = { id: 'revision', case_id: 'case', state: 'PREPARED', settings: { operation: 'ADD' }, source: { id: 'source' }, profile_snapshot: {}, overrides: {}, correction_overlay: [] };
  const intake = { intake: { id: 'clean', case_id: 'case', state: 'COMPLETED', created_at: '2026-11-26T08:00:00Z' }, source: { id: 'source', filename: 'clean.csv' }, version: { id: 'version', decisions: { operation: 'ADD', partner: 'RTK HUB' } }, assessment: { result: { operation: 'ADD' }, questions: [] }, revision };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let json: unknown;
    if (path === '/api/session') json = { authenticated: true, csrf_token: 'fixture', user: { id: 'fixture', username: 'fixture', permissions: ['case.edit', 'package.approve'] } };
    else if (path === '/api/intakes') json = { items: [intake], next_cursor: null };
    else if (path === '/api/intakes/clean') json = intake;
    else if (path.endsWith('/review')) json = { revision_id: 'revision', summary: { blocking: false, issue_counts: { msisdn_cleaned: 2 }, counts: {}, reconciliation: { complete: true } } };
    else if (path.endsWith('/approval')) json = { current: true, approved: false };
    else if (path.endsWith('/artifacts')) json = { available: true, artifacts: [] };
    else if (path.endsWith('/records')) json = { items: [], columns: ['INN', 'MSISDN'], next_cursor: null };
    else if (path.endsWith('/issues')) json = { items: [{ record_id: 'record', ordinal: url.searchParams.get('after') === '1' ? 501 : 1, code: 'msisdn_cleaned', scope: 'warning', field: 'MSISDN', message: 'Удалены символы: «+». MSISDN после обработки: 79878384919', page_index: url.searchParams.get('after') === '1' ? 2 : 1 }], next_cursor: url.searchParams.get('after') === '1' ? null : 1 };
    else return route.fulfill({ status: 404, json: {} });
    await route.fulfill({ json });
  });
  await page.goto('/?intake=clean');
  const dialog = page.getByRole('dialog', { name: 'MSISDN: удалены лишние символы' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Строка 1: Удалены символы: «+»');
  await dialog.getByRole('button', { name: 'Следующая страница' }).click();
  await expect(dialog).toContainText('Строка 501:');
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  await dialog.getByRole('button', { name: 'Понятно' }).click();
  await page.reload();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Показать удалённые символы' }).click();
  await expect(dialog).toContainText('Строка 1:');
});
