import { expect, test } from '@playwright/test';
import { login, newSource, prepare, forwardValidUpload, newCase, validSource } from './helpers';

test('accepted approval with no browser response times out and recovers the original key', async ({ page }) => {
  await login(page); await newSource(page); await prepare(page);
  const c = (await page.getByTestId('case-id').textContent())!;
  let key = '', accepted!: () => void, release!: () => void;
  const committed = new Promise<void>(resolve => { accepted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const keys: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/cases/${c}/approval`) keys.push(request.postDataJSON().operation_id);
  });
  await page.route(`**/api/cases/${c}/approval`, async route => {
    key = route.request().postDataJSON().operation_id;
    const response = await route.fetch(); expect(response.status()).toBe(200);
    accepted(); await gate; await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await page.clock.install(); await page.clock.pauseAt(new Date());
  try {
    await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click(); await committed;
    await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены');
    await page.clock.fastForward(30_001);
    await expect(page.getByText(/Время ожидания ответа истекло/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Проверить сохранённую операцию', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Проверить сохранённую операцию', exact: true }).click();
    await expect(page.getByTestId('preparation-status')).toContainText('Комплект подтверждён');
    expect(keys).toEqual([key]);
    const receipt = await page.request.get(`/api/operations?operation_id=${key}&action=package.approve&case_id=${c}`);
    expect(receipt.status()).toBe(200); expect((await receipt.json()).status).toBe('SUCCEEDED');
  } finally { release(); await page.clock.resume(); }
});

test('upload waits beyond the normal deadline, then times out and keeps its recoverable key', async ({ page }) => {
  await login(page); const c = await newCase(page);
  let key = '', accepted!: () => void, release!: () => void;
  const committed = new Promise<void>(resolve => { accepted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/cases/${c}/sources?**`, async route => {
    key = route.request().headers()['x-operation-id'];
    const response = await forwardValidUpload(page, route); accepted(); await gate;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles(validSource);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  try {
    await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click(); await committed;
    await page.clock.fastForward(30_001);
    await expect(page.getByText(/Время ожидания ответа истекло/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Перечитать сохранённую заявку', exact: true })).toBeDisabled();
    await page.clock.fastForward(270_001);
    await expect(page.getByText(/Время ожидания ответа истекло/)).toBeVisible();
    await page.getByRole('button', { name: 'Проверить сохранённую операцию', exact: true }).click();
    await expect(page.getByTestId('revision-id')).toHaveText(/[0-9a-f-]{36}/);
    const receipt = await page.request.get(`/api/operations?operation_id=${key}&action=source.upload&case_id=${c}`);
    expect(receipt.status()).toBe(200); expect((await receipt.json()).status).toBe('SUCCEEDED');
  } finally { release(); await page.clock.resume(); }
});
