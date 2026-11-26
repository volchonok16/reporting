import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { login, validSource } from './helpers';
import type { Api } from '../../src/api/client';

test('automatic upload prepares independent output, confirms bytes and restores on reload', async ({ page }, testInfo) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Маркировка', exact: true })).toBeVisible();
  await page.getByLabel('Партнёр', { exact: false }).selectOption('RTK HUB');
  const receiptPromise = page.waitForResponse(response => response.url().includes('/api/intakes') && response.request().method() === 'POST');
  await page.getByLabel('Исходный файл', { exact: true }).setInputFiles(validSource);
  await page.getByRole('button', { name: 'Обработать файл', exact: true }).click();
  const receipt = await (await receiptPromise).json() as Api['IntakeOperationState'];
  expect(receipt.status).toBe('SUCCEEDED');
  await expect(page.getByTestId('intake-result')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  await expect(page.getByTestId('intake-result')).toContainText('Все строки исходного файла учтены');
  await expect(page.getByRole('button', { name: 'Скачать NUMBERS', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Результат загрузки NUMBERS', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать NUMBERS', exact: true }).click();
  const download = await downloadPromise, target = testInfo.outputPath('numbers.csv'); await download.saveAs(target);
  const intake = await (await page.request.get(`/api/intakes/${receipt.result!.intake.id}`)).json() as Api['IntakeDetail'];
  const bundle = await (await page.request.get(`/api/cases/${intake.intake.case_id}/revisions/${intake.revision!.id}/artifacts`)).json() as Api['ArtifactSetState'];
  expect(createHash('sha256').update(await readFile(target)).digest('hex')).toBe(bundle.artifacts.find(item => item.role === 'NUMBERS')!.sha256);
  await page.reload();
  await expect(page.getByTestId('intake-result')).toContainText('Комплект подтверждён');
  await expect(page.getByRole('button', { name: 'Результат загрузки NUMBERS', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByRole('button', { name: /^Открыть обработку valid\.csv от / }).first().click();
  await expect(page.getByRole('button', { name: 'Предпросмотр NUMBERS', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Повторить обработку valid.csv', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Архив', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Новая обработка', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Загрузите исходный файл', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Архив файлов', exact: true })).toHaveCount(0);
});

test('mapping and partner questions share one form; unsaved choice survives polling and blocks file switch', async ({ page }) => {
  await login(page);
  await page.getByLabel('Партнёр', { exact: false }).selectOption('RTK HUB');
  await page.getByLabel('Исходный файл', { exact: true }).setInputFiles([
    { name: 'unknown-columns.csv', mimeType: 'text/csv', buffer: Buffer.from('\ufefftax;phone;label;latin;mav;kss\n1234567894;00123456789;Тест;Test;1;1\n') },
    { name: 'other.csv', mimeType: 'text/csv', buffer: await readFile(validSource) },
  ]);
  await page.getByRole('button', { name: 'Обработать файлы', exact: true }).click();
  await page.getByRole('button', { name: 'unknown-columns.csv', exact: true }).click();
  const form = page.getByTestId('intake-decisions');
  await expect(form).toContainText('Партнёр');
  await form.getByLabel('Партнёр', { exact: false }).selectOption('RTK HUB');
  await form.getByLabel('Назначение файла', { exact: true }).selectOption('ADD');
  for (const [index, field] of ['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS'].entries()) {
    await form.locator(`#mapping-${field}`).selectOption(String(index));
  }
  await page.getByRole('button', { name: 'other.csv', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Несохранённый ввод');
  await expect(form.getByLabel('Партнёр', { exact: false })).toHaveValue('RTK HUB');
  await form.getByRole('button', { name: 'Сохранить решения и продолжить', exact: true }).click();
  await expect(page.getByTestId('intake-result')).toContainText('Файлы подготовлены', { timeout: 90_000 });
});

test('lost upload response restores the receipt after reload without another intake', async ({ page }) => {
  await login(page);
  await page.getByLabel('Партнёр', { exact: false }).selectOption('RTK HUB');
  let intakeId = '';
  await page.route('**/api/intakes?*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const headers = route.request().headers();
    const response = await page.request.post(route.request().url(), {
      headers: { 'X-CSRF-Token': headers['x-csrf-token'], 'X-Operation-ID': headers['x-operation-id'], Origin: headers.origin },
      multipart: { file: { name: 'valid.csv', mimeType: 'text/csv', buffer: await readFile(validSource) } },
    });
    expect(response.status()).toBe(200);
    const receipt = await response.json() as Api['IntakeOperationState']; intakeId = receipt.result!.intake.id;
    await route.abort('failed');
  });
  await page.getByLabel('Исходный файл', { exact: true }).setInputFiles(validSource);
  await page.getByRole('button', { name: 'Обработать файл', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Исход операции неизвестен');
  await page.unroute('**/api/intakes?*');
  await page.reload();
  await expect(page.getByTestId('intake-result')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  await expect(page).toHaveURL(new RegExp(`intake=${intakeId}`));
  const result = await (await page.request.get(`/api/intakes/${intakeId}`)).json() as Api['IntakeDetail'];
  expect(result.version.sequence).toBe(1);
});

test('invalid data is corrected, confirmed and rechecked before package approval', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('button', { name: 'Обработать файл', exact: true })).toBeDisabled();
  await page.getByLabel('Исходный файл', { exact: true }).setInputFiles({ name: 'wizard-correction.csv', mimeType: 'text/csv', buffer: Buffer.from('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n1234567894;00123456789;Тест;Test;1;1\nbad;00123456788;Тест;Test;1;1\n') });
  await expect(page.getByRole('button', { name: 'Обработать файл', exact: true })).toBeDisabled();
  await page.getByLabel('Партнёр', { exact: false }).selectOption('RTK HUB');
  await page.getByRole('button', { name: 'Обработать файл', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Редактировать строку 2', exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Перейти к подтверждению', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Редактировать строку 2', exact: true }).click();
  await page.locator('#edit-INN').fill('1234567894');
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await expect(page.getByText('Сохраните или отмените ввод перед переходом в другой раздел.', { exact: true })).toBeVisible();
  await expect(page.locator('#edit-INN')).toHaveValue('1234567894');
  await expect(page.getByRole('button', { name: 'Перейти к подтверждению', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toHaveText('Файлы подготовлены', { timeout: 90_000 });
  await expect(page.getByRole('region', { name: 'Результаты обработки данных', exact: true })).not.toContainText('bad');
  await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Скачать NUMBERS', exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Скачайте готовые файлы', exact: true })).toBeVisible();
});
