import { expect, test } from '@playwright/test';
import { login, newCase, newSource, prepare, approve, revisionPath, validSource, forwardValidUpload } from './helpers';
import type { Api } from '../../src/api/client';

test('dirty draft blocks approval/download and explicit reread preserves unstaged record values', async ({ page }) => {
  await login(page); await newSource(page); await prepare(page); await approve(page);
  await page.getByRole('button', { name: 'Открыть запись 1', exact: true }).click();
  await page.locator('#edit-MAV_LABEL_NAME').fill('Новое');
  await expect(page.getByRole('button', { name: 'Скачать NUMBERS', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Перечитать сохранённую заявку', exact: true }).click();
  await expect(page.getByText(/Добавьте его в черновик или явно отмените перед перечитыванием/)).toBeVisible();
  await expect(page.locator('#edit-MAV_LABEL_NAME')).toHaveValue('Новое');
  await page.getByRole('button', { name: 'Добавить исправления в черновик', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Несохранённые исправления' })).toContainText('Новое');
  await page.getByRole('button', { name: 'Отменить несохранённый ввод', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Скачать комплект', exact: true })).toBeEnabled();
});

test('lost upload response recovers the real receipt with the original scoped operation key', async ({ page }) => {
  await login(page); const c = await newCase(page);
  let operationId = '', requests = 0;
  await page.route(`**/api/cases/${c}/sources?**`, async route => {
    requests++; operationId = route.request().headers()['x-operation-id'];
    await forwardValidUpload(page, route);
    await route.abort('failed');
  }, { times: 1 });
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles(validSource);
  await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click();
  await expect(page.locator('.alert-title').filter({ hasText: 'Исход операции неизвестен' })).toBeVisible();
  await expect(page.getByTestId('revision-id')).toHaveCount(0);
  await page.getByRole('button', { name: 'Проверить сохранённую операцию', exact: true }).click();
  await expect(page.getByTestId('revision-id')).toHaveText(/[0-9a-f-]{36}/);
  expect(requests).toBe(1);
  const receipt = await page.request.get(`/api/operations?operation_id=${operationId}&action=source.upload&case_id=${c}`);
  expect(receipt.status()).toBe(200); const saved = await receipt.json() as Api['OperationState'];
  expect(saved.status).toBe('SUCCEEDED'); expect(saved.result?.revision?.sequence).toBe(1);
  await prepare(page);
});

test('approval double click has one request/key and lost response is not success before recovery', async ({ page }) => {
  await login(page); await newSource(page); await prepare(page);
  const c = (await page.getByTestId('case-id').textContent())!;
  const keys: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/cases/${c}/approval`) {
      keys.push(request.postDataJSON().operation_id);
    }
  });
  await page.route(`**/api/cases/${c}/approval`, async route => {
    const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).dblclick();
  await expect(page.locator('.alert-title').filter({ hasText: 'Исход операции неизвестен' })).toBeVisible();
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены');
  await page.getByRole('button', { name: 'Проверить сохранённую операцию', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toContainText('Комплект подтверждён');
  expect(keys).toHaveLength(1); expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  const receipt = await page.request.get(`/api/operations?operation_id=${keys[0]}&action=package.approve&case_id=${c}`);
  expect(receipt.status()).toBe(200); expect((await receipt.json()).status).toBe('SUCCEEDED');
});

test('stale tab approval is rejected; old shown version and dirty settings stay available for explicit comparison', async ({ page, context }) => {
  await login(page); await newSource(page); await prepare(page);
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  const other = await context.newPage(); await other.goto(`/?case=${c}`); await expect(other.getByTestId('revision-id')).toHaveText(r);
  await other.locator('#profile-SPREADING').selectOption('1'); await other.getByLabel('Основание переопределения профиля', { exact: false }).fill('Разрешённое изменение для этой ревизии');
  await other.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(other.getByTestId('revision-id')).not.toHaveText(r);
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  await expect(page.getByText(/Версия изменилась:/)).toBeVisible(); await expect(page.getByTestId('revision-id')).toHaveText(r);
  await page.locator('#profile-INTERNAL_OPERATOR_NAME').fill('manualRTK');
  await page.getByLabel('Основание переопределения профиля', { exact: false }).fill('Мой сохранённый при конфликте ввод');
  await page.getByRole('button', { name: 'Открыть текущую ревизию для сверки', exact: true }).first().click();
  await expect(page.getByTestId('revision-id')).not.toHaveText(r); await expect(page.locator('#profile-INTERNAL_OPERATOR_NAME')).toHaveValue('manualRTK');
  await expect(page.getByLabel('Основание переопределения профиля', { exact: false })).toHaveValue('Мой сохранённый при конфликте ввод');
  await expect(page.locator('.alert-title').filter({ hasText: 'Черновик относится к предыдущей ревизии' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сохранить и пересчитать', exact: true })).toBeDisabled();
  await other.close();
});

test('401/session expiry and relogin retain the same user draft; a different account clears private case state', async ({ page }) => {
  await login(page); await newSource(page); await prepare(page);
  const c = (await page.getByTestId('case-id').textContent())!;
  await page.locator('#profile-SPREADING').selectOption('1'); await page.getByLabel('Основание переопределения профиля', { exact: false }).fill('Черновик до завершения сессии');
  const session = await (await page.request.get('/api/session')).json() as Api['SessionState'];
  const revoked = await page.request.post('/api/session/logout', { headers: { Origin: process.env.E2E_BASE_URL!, 'X-CSRF-Token': session.csrf_token }, data: {} }); expect(revoked.status()).toBe(200);
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page.getByText(/Требуется вход:/)).toBeVisible(); await expect(page.locator('#profile-SPREADING')).toHaveValue('1');
  await page.getByLabel('Имя пользователя', { exact: false }).fill(process.env.E2E_USERNAME!); await page.getByLabel('Пароль', { exact: false }).fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Войти', exact: true }).click(); await expect(page.getByTestId('session-user')).toHaveText(process.env.E2E_USERNAME!);
  await expect(page.getByTestId('case-id')).toHaveText(c); await expect(page.getByLabel('Основание переопределения профиля', { exact: false })).toHaveValue('Черновик до завершения сессии');
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByLabel('Имя пользователя', { exact: false }).fill(process.env.E2E_OTHER_USERNAME!); await page.getByLabel('Пароль', { exact: false }).fill(process.env.E2E_OTHER_PASSWORD!);
  await page.getByRole('button', { name: 'Войти', exact: true }).click(); await expect(page.getByTestId('session-user')).toHaveText(process.env.E2E_OTHER_USERNAME!);
  await expect(page.getByTestId('case-id')).toHaveCount(0); await expect(page.locator('#profile-SPREADING')).toHaveCount(0); expect(new URL(page.url()).searchParams.has('case')).toBe(false);
});

test('real ownership and read-only permissions; private foreign case is not rendered', async ({ browser }) => {
  const firstContext = await browser.newContext(), first = await firstContext.newPage(); await login(first); await newSource(first);
  const c = (await first.getByTestId('case-id').textContent())!;
  const otherContext = await browser.newContext(), other = await otherContext.newPage(); await login(other, process.env.E2E_OTHER_USERNAME!, process.env.E2E_OTHER_PASSWORD!);
  await other.goto(`/?case=${c}`); await expect(other.getByText(/Не найдено в доступной области:/)).toBeVisible(); await expect(other.getByTestId('case-id')).toHaveCount(0);
  const readerContext = await browser.newContext(), reader = await readerContext.newPage(); await login(reader, process.env.E2E_READONLY_USERNAME!, process.env.E2E_READONLY_PASSWORD!);
  await expect(reader.getByRole('button', { name: 'Новая заявка', exact: true })).toBeDisabled();
  const session = await (await reader.request.get('/api/session')).json() as Api['SessionState'];
  expect((await reader.request.post('/api/cases', { data: { operation_id: crypto.randomUUID(), title: 'Forbidden' }, headers: { Origin: process.env.E2E_BASE_URL!, 'X-CSRF-Token': session.csrf_token } })).status()).toBe(403);
  await firstContext.close(); await otherContext.close(); await readerContext.close();
});

test('client service 503 and aborted preview are distinct from an empty successful table; inputs survive', async ({ page }) => {
  await login(page); await newSource(page); await prepare(page);
  await page.route('**/api/cases?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_client_failure', message: 'Проверка отображения отказа сервиса', retryable: true }, trace_id: crypto.randomUUID() }) }), { times: 1 });
  await page.route('**/api/cases', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'synthetic_client_failure', message: 'Проверка отображения отказа сервиса', retryable: true }, trace_id: crypto.randomUUID() }) }), { times: 1 });
  await page.getByRole('button', { name: 'Обновить список заявок', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Сохранённые заявки — одна страница' })).toContainText('Сервис недоступен');
  await page.route('**/artifacts/*/preview?**', route => route.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'Предпросмотр NUMBERS', exact: true }).click();
  await expect(page.getByRole('table', { name: /CSV предпросмотр/ })).toContainText('Ответ сервиса не получен');
  await page.getByRole('button', { name: 'Повторить загрузку предпросмотра', exact: true }).click();
  await expect(page.getByRole('table', { name: 'CSV предпросмотр NUMBERS — одна страница' })).toContainText('00123456789');
  await page.locator('#profile-INTERNAL_OPERATOR_NAME').fill('мойЧерновик'); await expect(page.locator('#profile-INTERNAL_OPERATOR_NAME')).toHaveValue('мойЧерновик');
});

test('delayed old record response cannot overwrite the newer revision after save', async ({ page }) => {
  await login(page); await newSource(page); await prepare(page);
  const c = (await page.getByTestId('case-id').textContent())!, oldRevision = (await page.getByTestId('revision-id').textContent())!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void; const started = new Promise<void>(resolve => { held = resolve; });
  await page.route(`**${revisionPath(c, oldRevision)}/records?**`, async route => {
    const response = await route.fetch(); held(); await gate; await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Повторить загрузку записей и ошибок', exact: true }).click(); await started;
  await page.locator('#profile-SPREADING').selectOption('1'); await page.getByLabel('Основание переопределения профиля', { exact: false }).fill('Новая версия во время старого чтения');
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click(); await expect(page.getByTestId('revision-id')).not.toHaveText(oldRevision);
  const oldResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${revisionPath(c, oldRevision)}/records`);
  release();
  await oldResponse; await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('table', { name: 'Исходные записи и исход обработки — одна страница' })).toContainText('Ещё не определён');
  await expect(page.getByRole('table', { name: 'Исходные записи и исход обработки — одна страница' })).not.toContainText('Включена');
});
