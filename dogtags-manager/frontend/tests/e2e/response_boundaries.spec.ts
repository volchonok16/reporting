import { expect, test } from '@playwright/test';
import type { Api } from '../../src/api/client';
import { login, newCase, newSource, revisionPath, validSource } from './helpers';

test('client 413 mapping preserves the selected source and encoding; a retry still uses the real API', async ({ page }) => {
  await login(page); const c = await newCase(page);
  // This response exercises the browser's error presentation only. It does not
  // claim to prove the configured server upload limit or worker processing.
  await page.route(`**/api/cases/${c}/sources?**`, route => route.fulfill({
    status: 413,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'synthetic_client_upload_limit', message: 'Проверка отображения ограничения загрузки', retryable: false }, trace_id: crypto.randomUUID() }),
  }), { times: 1 });
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles(validSource);
  await page.getByLabel('Кодировка источника', { exact: false }).selectOption('cp1251');
  await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click();
  await expect(page.getByText(/Файл превышает допустимый размер:/)).toBeVisible();
  await expect(page.getByTestId('revision-id')).toHaveCount(0);
  await expect(page.getByLabel('Кодировка источника', { exact: false })).toHaveValue('cp1251');
  expect(await page.getByLabel('Файл HUB CSV', { exact: false }).evaluate(element => [...((element as HTMLInputElement).files ?? [])].map(file => file.name))).toEqual(['valid.csv']);
  await expect(page.locator('.alert-title').filter({ hasText: 'Исход операции неизвестен' })).toHaveCount(0);
  await page.getByLabel('Кодировка источника', { exact: false }).selectOption('utf-8');
  await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click();
  await expect(page.getByTestId('revision-id')).toHaveText(/^[0-9a-f-]{36}$/);
});

test('real 422 invalid profile override retains its value and reason without changing the current revision', async ({ page }) => {
  await login(page); await newSource(page);
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  await page.locator('#profile-INTERNAL_OPERATOR_NAME').fill('');
  await page.getByLabel('Основание переопределения профиля', { exact: false }).fill('Основание остаётся после отказа сервера');
  const rejected = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/cases/${c}/revisions`);
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  expect((await rejected).status()).toBe(422);
  await expect(page.getByText(/Данные не приняты:/)).toBeVisible();
  await expect(page.getByTestId('revision-id')).toHaveText(r);
  await expect(page.locator('#profile-INTERNAL_OPERATOR_NAME')).toHaveValue('');
  await expect(page.getByLabel('Основание переопределения профиля', { exact: false })).toHaveValue('Основание остаётся после отказа сервера');
  const current = await (await page.request.get(`/api/cases/${c}`)).json() as Api['CaseState'];
  expect(current.head_revision_id).toBe(r);
  await expect(page.locator('.alert-title').filter({ hasText: 'Исход операции неизвестен' })).toHaveCount(0);
});

test('a real terminal job response refreshes results while preserving unstaged record values and reason', async ({ page }) => {
  await login(page); await newSource(page);
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void; const started = new Promise<void>(resolve => { held = resolve; });
  let jobUrl = '';
  await page.route(new RegExp(`/api/cases/${c}/processing/[0-9a-f-]{36}$`), async route => {
    jobUrl = route.request().url(); held(); await gate;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect((await response.json() as Api['ProcessingState']).state).toBe('PREPARED');
    await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'Проверить файл', exact: true }).click();
    await started;
    await expect.poll(async () => (await (await page.request.get(jobUrl)).json() as Api['ProcessingState']).state, { timeout: 60_000, intervals: [500] }).toBe('PREPARED');
    await page.getByRole('button', { name: 'Открыть запись 1', exact: true }).click();
    await page.locator('#edit-MAV_LABEL_NAME').fill('Ввод во время обработки');
    release();
    await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены');
    await expect(page.getByTestId('coverage')).toContainText('Покрытие полное');
    await expect(page.getByTestId('revision-id')).toHaveText(r);
    await expect(page.locator('#edit-MAV_LABEL_NAME')).toHaveValue('Ввод во время обработки');
    await expect(page.getByRole('button', { name: 'Подтвердить комплект', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Сохранить и пересчитать', exact: true })).toBeDisabled();
    const persisted = await (await page.request.get(revisionPath(c, r))).json() as Api['RevisionState'];
    expect(persisted.correction_overlay).toEqual([]);
  } finally {
    release();
  }
});
