import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { login, openArchiveFile, validSource } from './helpers';
import type { Api } from '../../src/api/client';

async function upload(page: Page, name: string, bytes: Buffer) {
  await page.getByRole('button', { name: 'Маркировка', exact: true }).click();
  if (await page.getByRole('button', { name: 'Новая обработка', exact: true }).count()) await page.getByRole('button', { name: 'Новая обработка', exact: true }).click();
  await page.getByLabel('Партнёр', { exact: false }).selectOption('RTK HUB');
  const received = page.waitForResponse(r => r.url().includes('/api/intakes') && r.request().method() === 'POST');
  await page.getByLabel('Исходный файл', { exact: true }).setInputFiles({ name, mimeType: 'text/csv', buffer: bytes });
  await page.getByRole('button', { name: 'Обработать файл', exact: true }).click();
  const receipt = await (await received).json() as Api['IntakeOperationState'];
  expect(receipt.status).toBe('SUCCEEDED');
  return receipt.result!.intake.id;
}
async function bundle(page: Page, id: string) {
  const intake = await (await page.request.get(`/api/intakes/${id}`)).json() as Api['IntakeDetail'];
  return await (await page.request.get(`/api/cases/${intake.intake.case_id}/revisions/${intake.revision!.id}/artifacts`)).json() as Api['ArtifactSetState'];
}
async function recordAttempt(page: Page, role: string, reason: string) {
  const id = new URL(page.url()).searchParams.get('intake')!;
  const intake = await (await page.request.get(`/api/intakes/${id}`)).json() as Api['IntakeDetail'];
  const files = await bundle(page, id);
  const artifact = files.artifacts.find(file => file.role === role)!;
  const session = await (await page.request.get('/api/session')).json() as Api['SessionState'];
  const response = await page.request.post('/api/external-attempts', { headers: { 'X-CSRF-Token': session.csrf_token, Origin: new URL(page.url()).origin }, data: { operation_id: crypto.randomUUID(), artifact_id: artifact.id, artifact_set_id: files.artifact_set_id, manifest_hash: files.manifest_hash, predecessor_ids: [], reason } });
  expect(response.status()).toBe(200);
  expect(intake.revision).not.toBeNull();
  return await response.json() as Api['ExternalAttemptState'];
}

test('DELETE preserves exact bytes, archive has no database status columns and removal is permanent', async ({ page }, testInfo) => {
  await login(page);
  const name = 'lifecycle-delete.csv';
  const intakeId = await upload(page, name, Buffer.from('MSISDN\r\n79000000000\r\n79000000000\r\n'));
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  const received = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать DELETE', exact: true }).click();
  const target = testInfo.outputPath('delete.csv'); await (await received).saveAs(target);
  expect((await readFile(target)).toString('ascii')).toBe('MSISDN\r\n79000000000\r\n');
  await openArchiveFile(page);
  await expect(page.getByRole('columnheader', { name: 'Статус в БД', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Результат загрузки|Открыть реестр|Удалённые файлы/ })).toHaveCount(0);
  await page.getByRole('button', { name: `Удалить ${name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
  await expect(page.getByRole('button', { name: `Удалить ${name}`, exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/intakes/${intakeId}`)).status()).toBe(409);
});

test('CHANGE confirms independent old number scope and exposes ordered stages', async ({ page }) => {
  await login(page);
  const oldId = await upload(page, 'old-scope.csv', Buffer.from('MSISDN\r\n79000000009\r\n'));
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  const old = await bundle(page, oldId), oldFile = old.artifacts.find(a => a.role === 'DELETE')!;
  await upload(page, 'replacement.csv', await readFile(validSource));
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Изменить партнёра или назначение', exact: true }).click();
  await page.getByLabel('Назначение файла', { exact: true }).selectOption('CHANGE');
  const candidates = page.getByRole('region', { name: 'Источники старых номеров', exact: true });
  await candidates.locator(`[data-scroll-id$=":${oldFile.id}"]`).getByRole('button').click();
  await expect(page.getByRole('region', { name: 'Точный состав старого CSV', exact: true })).toContainText('79000000009');
  await page.getByRole('button', { name: 'Подтвердить этот состав удаления', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить решения и продолжить', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await expect(page.getByTestId('application-order')).toContainText('DELETE');
  await openArchiveFile(page);
  for (const role of ['DELETE', 'CLIENTS', 'DOGTAGS', 'NUMBERS']) await expect(page.getByRole('button', { name: `Предпросмотр ${role}`, exact: true })).toBeVisible();
});

test('unknown STATUS requires exact manual evidence; rejected rows produce a reloadable corrected retry without STATUS', async ({ page }, testInfo) => {
  await login(page);
  const originalBytes = await readFile(validSource);
  const originalId = await upload(page, 'return-original.csv', Buffer.from(originalBytes.toString('utf8').split(/\r?\n/).slice(0, 2).join('\r\n') + '\r\n'));
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  const originalBundle = await bundle(page, originalId);
  const submission = await recordAttempt(page, 'CLIENTS', 'Lifecycle STATUS source');
  const clientFile = originalBundle.artifacts.find(a => a.role === 'CLIENTS')!;
  // Read verified serialized preview to construct a synthetic exact return, not approximate source values.
  const intake = await (await page.request.get(`/api/intakes/${originalId}`)).json() as Api['IntakeDetail'];
  const preview = await (await page.request.get(`/api/cases/${intake.intake.case_id}/revisions/${intake.revision!.id}/artifacts/${clientFile.id}/preview`)).json() as Api['ArtifactPreview'];
  const csv = [preview.columns.concat('STATUS'), ...preview.items.map(row => row.concat('UNPUBLISHED_TEST_FAILURE'))].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(';')).join('\r\n') + '\r\n';
  const returnId = await upload(page, 'external-return.csv', Buffer.from(csv));
  const decisions = page.getByTestId('intake-decisions');
  await expect(decisions).toContainText('Выберите выданный CSV', { timeout: 90_000 });
  const candidates = decisions.getByRole('region', { name: 'Сохранённые внешние отправки', exact: true });
  await candidates.getByRole('row').filter({ hasText: submission.reason }).getByRole('button').click();
  await decisions.getByLabel('Основание связи или пересмотра возврата', { exact: false }).fill('Возврат именно этой тестовой отправки');
  await decisions.getByRole('button', { name: 'Сохранить решения и продолжить', exact: true }).click();
  const returns = page.getByTestId('return-panel');
  await expect(returns.getByRole('region', { name: 'Строки возврата и точность сопоставления', exact: true })).toContainText('Результат неизвестен', { timeout: 90_000 });
  await returns.getByRole('button', { name: 'Сверить неизвестные результаты', exact: true }).click();
  const external = returns.getByTestId('external-panel');
  await external.getByLabel('Известный результат', { exact: true }).selectOption('REJECTED');
  await external.getByLabel('К каким строкам относится', { exact: true }).selectOption('ROWS');
  await external.getByRole('button', { name: 'Выбрать строку', exact: true }).first().click();
  await external.getByLabel('Основание внешнего результата', { exact: false }).fill('Точная строка отклонена по ручной сверке');
  await external.getByRole('button', { name: 'Записать результат загрузки', exact: true }).click();
  await expect(returns.getByRole('region', { name: 'Строки возврата и точность сопоставления', exact: true })).toContainText('Отказ');
  await returns.getByText('Исправления исходных записей', { exact: true }).click();
  await returns.getByRole('button', { name: /Исправить исходную запись/ }).first().click();
  await returns.locator('#edit-MAV_LABEL_NAME').fill('Повтор');
  await returns.locator('#edit-MAV_LABEL_LATIN').fill('Povtor');
  await returns.getByRole('button', { name: 'Добавить исправления в черновик', exact: true }).click();
  await returns.getByLabel('Основание повторной подготовки', { exact: false }).fill('Повторить только подтверждённый отказ');
  let lostRevision = '';
  await page.route(`**/api/returns/${returnId}/retries`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200);
    const receipt = await response.json() as Api['OperationState']; lostRevision = receipt.result!.revision!.id;
    await route.abort('failed');
  });
  await returns.getByRole('button', { name: 'Исправить и подготовить повторно', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Исход операции неизвестен');
  await page.unroute(`**/api/returns/${returnId}/retries`);
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`retry=${lostRevision}`));
  await expect(page).toHaveURL(new RegExp(`intake=${returnId}`));
  await expect(page.getByTestId('return-panel').getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  await page.getByTestId('return-panel').getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  const received = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать CLIENTS', exact: true }).click();
  const path = testInfo.outputPath('retry-clients.csv'); await (await received).saveAs(path);
  expect((await readFile(path)).includes(Buffer.from('STATUS'))).toBe(false);
});

test('mixed DELETE return excludes confirmed success and corrects only the rejected source row', async ({ page }, testInfo) => {
  await login(page);
  await upload(page, 'mixed-delete.csv', Buffer.from('MSISDN\r\n79000000011\r\n79000000012\r\n'));
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  const submission = await recordAttempt(page, 'DELETE', 'Mixed DELETE lifecycle');
  await upload(page, 'mixed-delete-return.csv', Buffer.from('MSISDN;STATUS\r\n79000000011;UNKNOWN_TEST\r\n79000000012;UNKNOWN_TEST\r\n'));
  const decisions = page.getByTestId('intake-decisions');
  await expect(decisions).toContainText('Выберите выданный CSV', { timeout: 90_000 });
  const candidates = decisions.getByRole('region', { name: 'Сохранённые внешние отправки', exact: true });
  await candidates.getByRole('row').filter({ hasText: submission.reason }).getByRole('button').click();
  await decisions.getByLabel('Основание связи или пересмотра возврата', { exact: false }).fill('Возврат двух выданных номеров DELETE');
  await decisions.getByRole('button', { name: 'Сохранить решения и продолжить', exact: true }).click();
  const returns = page.getByTestId('return-panel');
  await expect(returns.getByRole('region', { name: 'Строки возврата и точность сопоставления', exact: true })).toContainText('UNKNOWN_TEST', { timeout: 90_000 });
  await returns.getByRole('button', { name: 'Сверить неизвестные результаты', exact: true }).click();
  const external = returns.getByTestId('external-panel');
  for (const [number, outcome] of [['79000000011', 'APPLIED'], ['79000000012', 'REJECTED']]) {
    await external.getByLabel('Известный результат', { exact: true }).selectOption(outcome);
    await external.getByLabel('К каким строкам относится', { exact: true }).selectOption('ROWS');
    await external.getByRole('region', { name: 'Точные строки DELETE', exact: true }).getByRole('row').filter({ hasText: number }).getByRole('button', { name: 'Выбрать строку', exact: true }).click();
    await external.getByLabel('Основание внешнего результата', { exact: false }).fill(`Ручная сверка ${number}: ${outcome}`);
    const saved = page.waitForResponse(r => r.url().includes('/evidence') && r.request().method() === 'POST');
    await external.getByRole('button', { name: 'Записать результат загрузки', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(external.getByLabel('Основание внешнего результата', { exact: false })).toHaveValue('');
  }
  await returns.getByText('Исправления исходных записей', { exact: true }).click();
  await returns.getByRole('region', { name: 'Записи исходной версии для повтора', exact: true }).getByRole('row').filter({ hasText: '79000000012' }).getByRole('button').click();
  await returns.locator('#edit-MSISDN').fill('79000000013');
  await returns.getByRole('button', { name: 'Добавить исправления в черновик', exact: true }).click();
  await returns.getByLabel('Основание повторной подготовки', { exact: false }).fill('Повтор только отклонённого удаления');
  await returns.getByRole('button', { name: 'Исправить и подготовить повторно', exact: true }).click();
  await expect(returns.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  const ledger = returns.getByRole('region', { name: 'Состав повтора — решение по каждой строке', exact: true });
  await expect(ledger.getByRole('row').filter({ hasText: '79000000011' })).toContainText('Исключена');
  await returns.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await returns.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  const received = page.waitForEvent('download');
  await returns.getByRole('button', { name: 'Скачать DELETE', exact: true }).click();
  const path = testInfo.outputPath('mixed-retry.csv'); await (await received).saveAs(path);
  expect((await readFile(path)).toString('ascii')).toBe('MSISDN\r\n79000000013\r\n');
});
