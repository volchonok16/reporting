import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { login, errorSource } from './helpers';
import type { Api } from '../../src/api/client';

test('archive preserves real preview, source/output downloads, repeat and final deletion', async ({ page }, info) => {
  await login(page);
  const session = await (await page.request.get('/api/session')).json() as Api['SessionState'];
  const upload = await page.request.post('/api/intakes?partner=RTK%20HUB', {
    headers: { 'X-CSRF-Token': session.csrf_token, 'X-Operation-ID': crypto.randomUUID(), Origin: new URL(page.url()).origin },
    multipart: { file: { name: 'archive-viewer-source.csv', mimeType: 'text/csv', buffer: await readFile(errorSource) } },
  });
  expect(upload.status()).toBe(200);
  const id = (await upload.json() as Api['IntakeOperationState']).result!.intake.id;
  await page.goto(`/?intake=${id}`);
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toContainText('Комплект подтверждён');
  const detail = await (await page.request.get(`/api/intakes/${id}`)).json() as Api['IntakeDetail'];
  const bundle = await (await page.request.get(`/api/cases/${detail.intake.case_id}/revisions/${detail.revision!.id}/artifacts`)).json() as Api['ArtifactSetState'];
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.locator(`[data-intake-id="${id}"]`).click();
  const pane = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
  await expect(pane.getByText('Выберите файл для просмотра.', { exact: true })).toBeVisible();
  await expect(pane.locator('.alert[data-tone="danger"]')).toContainText('В файле есть ошибки');
  for (const artifact of bundle.artifacts.filter(item => item.role !== 'ZIP')) {
    const label = artifact.role === 'ERRORS' ? 'Строки с ошибками' : artifact.role;
    await pane.getByRole('button', { name: `Предпросмотр ${label}`, exact: true }).click();
    await expect(pane.getByRole('table', { name: `Предпросмотр ${label}`, exact: true })).toBeVisible();
  }
  const errors = bundle.artifacts.find(item => item.role === 'ERRORS')!;
  const downloaded = page.waitForEvent('download');
  await pane.getByRole('button', { name: 'Скачать Строки с ошибками', exact: true }).click();
  const path = info.outputPath('errors.csv'); await (await downloaded).saveAs(path);
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(errors.sha256);
  const sourceDownload = page.waitForEvent('download');
  await pane.getByRole('link', { name: 'Скачать исходник', exact: true }).click();
  const sourcePath = info.outputPath('source.csv'); await (await sourceDownload).saveAs(sourcePath);
  expect(await readFile(sourcePath)).toEqual(await readFile(errorSource));
  await pane.getByRole('button', { name: 'Удалить archive-viewer-source.csv', exact: true }).click();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(pane.getByRole('table', { name: 'Предпросмотр Строки с ошибками', exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Повторить обработку archive-viewer-source.csv', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Маркировка', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.locator(`[data-intake-id="${id}"]`).click();
  await pane.getByRole('button', { name: 'Удалить archive-viewer-source.csv', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
  await expect(page.locator(`[data-intake-id="${id}"]`)).toHaveCount(0);
  expect((await page.request.get(`/api/intakes/${id}`)).status()).toBe(409);
  await expect(page.getByRole('button', { name: /Результат загрузки|Открыть реестр|Удалённые файлы/ })).toHaveCount(0);
});
