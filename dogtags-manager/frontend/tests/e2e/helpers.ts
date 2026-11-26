import { expect, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Api } from '../../src/api/client';

export const validSource = fileURLToPath(new URL('./fixtures/valid.csv', import.meta.url));
export const errorSource = fileURLToPath(new URL('./fixtures/errors.csv', import.meta.url));

/** Forward this fixture explicitly: route.fetch can omit native file-input bytes. */
export async function forwardValidUpload(page: Page, route: Route) {
  const bytes = await readFile(validSource), headers = route.request().headers();
  const response = await page.request.post(route.request().url(), {
    headers: {
      'X-Operation-ID': headers['x-operation-id'],
      'X-CSRF-Token': headers['x-csrf-token'],
      Origin: headers.origin,
    },
    multipart: { file: { name: 'valid.csv', mimeType: 'text/csv', buffer: bytes } },
  });
  expect(response.status()).toBe(200);
  const receipt = await response.json() as Api['OperationState'];
  expect(receipt.operation_id).toBe(headers['x-operation-id']);
  expect(receipt.result?.source).toMatchObject({ size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  return response;
}

export async function login(page: Page, username = process.env.E2E_USERNAME!, password = process.env.E2E_PASSWORD!) {
  await page.goto('/');
  await expect(page.getByTestId('session-user').or(page.getByLabel('Имя пользователя', { exact: false }))).toBeAttached();
  if (await page.getByLabel('Имя пользователя', { exact: false }).isVisible()) {
    await page.getByLabel('Имя пользователя', { exact: false }).fill(username);
    await page.getByLabel('Пароль', { exact: false }).fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
  }
  await expect(page.getByTestId('session-user')).toHaveText(username);
}

/** Select the processing in the archive viewer. */
export async function openArchiveFile(page: Page, intakeId?: string) {
  const id = intakeId ?? new URL(page.url()).searchParams.get('intake');
  if (!id) throw new Error('An intake must be selected before opening its archive entry.');
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.locator(`[data-intake-id="${id}"]`).click();
}

export async function newCase(page: Page) {
  if (!await page.getByRole('button', { name: 'Новая заявка', exact: true }).count()) {
    await page.goto('/?view=legacy');
    await expect(page.getByRole('button', { name: 'Новая заявка', exact: true })).toBeVisible();
  }
  const caseId = page.getByTestId('case-id');
  const previous = await caseId.count() ? await caseId.textContent() : null;
  await page.getByRole('button', { name: 'Новая заявка', exact: true }).click();
  await expect(caseId).toHaveText(/^[0-9a-f-]{36}$/);
  if (previous) await expect(caseId).not.toHaveText(previous);
  await expect(page.getByLabel('Файл HUB CSV', { exact: false })).toBeEnabled();
  return (await caseId.textContent())!;
}

export async function newSource(page: Page, path = validSource) {
  await newCase(page);
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles(path);
  await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click();
  await expect(page.getByTestId('revision-id')).toHaveText(/[0-9a-f-]{36}/);
}

export async function prepare(page: Page) {
  await page.getByRole('button', { name: 'Проверить файл', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 60_000 });
  await expect(page.getByTestId('coverage')).toContainText('Покрытие полное');
}

export async function approve(page: Page) {
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toContainText('Комплект подтверждён');
}

export async function saveCorrection(page: Page, ordinal: number, field: string, value: string, reason: string) {
  await page.getByRole('button', { name: `Открыть запись ${ordinal}`, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: `Запись ${ordinal}`, exact: true })).toBeVisible();
  const control = page.locator(`#edit-${field}`);
  if (field === 'IS_MAV' || field === 'IS_KSS') await control.selectOption(value);
  else await control.fill(value);
  await page.getByRole('button', { name: 'Добавить исправления в черновик', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
  await expect(page.getByTestId('dirty-state')).toContainText('Сохранённая ревизия');
}

export function revisionPath(caseId: string, revisionId: string) {
  return `/api/cases/${caseId}/revisions/${revisionId}`;
}
