import { expect, test, type Page } from '@playwright/test';

async function preparedFile(page: Page, step: number) {
  page.on('pageerror', error => { throw error; });
  await page.addInitScript(value => sessionStorage.setItem('dogtags.workflow.v2.fixture.revision', String(value)), step);
  const intake = {
    intake: { id: 'workflow', case_id: 'case', state: 'COMPLETED', created_at: '2026-10-15T07:00:00Z' },
    source: { id: 'source', filename: 'example.csv' },
    version: { id: 'version', decisions: { partner: 'RTK HUB', operation: 'ADD' } },
    assessment: { result: { operation: 'ADD' }, questions: [] },
    revision: { id: 'revision', case_id: 'case', state: 'APPROVED', settings: { operation: 'ADD' },
      profile_snapshot: { SPREADING: '0', INTERNAL_OPERATOR_NAME: 'hubRTK' }, overrides: {} },
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let json: unknown;
    if (path === '/api/session') json = { authenticated: true, csrf_token: 'fixture', user: { id: 'fixture', username: 'fixture', permissions: ['case.edit', 'package.approve', 'profile.override'] } };
    else if (path === '/api/intakes') json = { items: [intake], next_cursor: null };
    else if (path === '/api/intakes/workflow') json = intake;
    else if (path.endsWith('/approval')) json = { approved: true, current: true };
    else if (path.endsWith('/review')) json = { summary: { blocking: false, reconciliation: { complete: true }, counts: {} } };
    else if (path.endsWith('/records')) json = { items: [], columns: [], next_cursor: null };
    else if (path.endsWith('/artifacts')) json = { available: true, artifacts: [{ id: 'numbers', role: 'NUMBERS', row_count: 1, download_filename: 'NUMBERS.csv' }] };
    else return route.fulfill({ status: 404, json: {} });
    await route.fulfill({ json });
  });
  await page.goto('/?intake=workflow');
}

test('workflow actions share a row, Back sits before steps and sidebar icons align', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await preparedFile(page, 1);
  const partner = page.getByRole('button', { name: 'Изменить партнёра или назначение', exact: true });
  const parameters = page.getByRole('button', { name: 'Изменить параметры обработки', exact: true });
  await expect(parameters).toBeEnabled();
  expect((await parameters.boundingBox())!.y).toBe((await partner.boundingBox())!.y);
  await parameters.click();
  await expect(page.getByLabel('Внутреннее имя оператора', { exact: true })).toBeVisible();
  await parameters.click();
  await page.getByRole('button', { name: 'Раскрыть меню', exact: true }).click();
  const icons = await page.locator('.sidebar nav button svg').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
  expect(new Set(icons).size).toBe(1);
  await page.getByRole('button', { name: 'Свернуть меню', exact: true }).click();
  const back = page.getByRole('button', { name: 'Вернуться назад', exact: true });
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(back).toBeVisible();
    const box = (await back.boundingBox())!;
    expect(box.width).toBe(box.height);
    expect(box.x + box.width).toBeLessThan((await page.getByRole('list', { name: 'Этапы обработки' }).boundingBox())!.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  await back.click();
  await expect(page.getByRole('heading', { name: 'Загрузите исходный файл', exact: true })).toBeVisible();
});

test('confirmed download stage offers Finish and Back preserves earlier stages', async ({ page }) => {
  await preparedFile(page, 3);
  const finish = page.getByRole('button', { name: 'Завершить', exact: true });
  await expect(finish).toBeEnabled();
  await page.getByRole('button', { name: 'Вернуться назад', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Подтверждение комплекта', exact: true })).toBeVisible();
  await expect(finish).toHaveCount(0);
  await page.getByRole('button', { name: 'Перейти к скачиванию', exact: true }).click();
  await finish.click();
  await expect(page.getByRole('heading', { name: 'Загрузите исходный файл', exact: true })).toBeVisible();
  await expect(page).toHaveURL('/');
  await expect(page.getByLabel('Новый исходный файл', { exact: true })).toBeChecked();
});
