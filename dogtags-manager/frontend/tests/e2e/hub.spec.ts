import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Api } from '../../src/api/client';
import { approve, errorSource, login, newCase, newSource, prepare, revisionPath, saveCorrection } from './helpers';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const russianLabel = Buffer.from([0xd2, 0xe5, 0xf1, 0xf2]);
const expected = {
  CLIENTS: Buffer.from('COMPANY_NAME;COMPANY_CONTRACT;MAV_OPERATOR_NAME;INN\r\n;;;1234567894\r\n', 'ascii'),
  DOGTAGS: Buffer.concat([Buffer.from('INN;MAV_LABEL;MAV_LABEL_LATIN;IS_ACTIVE\r\n1234567894;', 'ascii'), russianLabel, Buffer.from(';Test;1\r\n', 'ascii')]),
  NUMBERS: Buffer.concat([Buffer.from('INN;MAV_LABEL_NAME;MSISDN;IS_MAV;IS_KSS;SPREADING;INTERNAL_OPERATOR_NAME\r\n1234567894;', 'ascii'), russianLabel, Buffer.from(';00123456789;1;1;0;hubRTK\r\n1234567894;', 'ascii'), russianLabel, Buffer.from(';00987654321;0;0;0;hubRTK\r\n', 'ascii')]),
};

test('real F1: upload, complete coverage, approval, exact CSV and three-file ZIP, reload', async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_PYTHON, 'ZIP inspection requires the explicit Python runtime supplied by the acceptance harness.');
  await login(page); await newSource(page); await prepare(page);
  await expect(page.getByTestId('count-CLIENTS')).toHaveText('1');
  await expect(page.getByTestId('count-DOGTAGS')).toHaveText('1');
  await expect(page.getByTestId('count-NUMBERS')).toHaveText('2');
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  const response = await page.request.get(`${revisionPath(c, r)}/artifacts`);
  expect(response.status()).toBe(200);
  const bundle = await response.json() as Api['ArtifactSetState'];
  expect(bundle.artifacts.map(item => item.role)).toEqual(['CLIENTS', 'DOGTAGS', 'NUMBERS', 'ZIP']);
  expect(bundle.manifest_hash).toBe(sha(JSON.stringify(canonical(bundle.manifest))));
  await page.getByRole('button', { name: 'Предпросмотр NUMBERS', exact: true }).click();
  const preview = page.getByRole('table', { name: 'CSV предпросмотр NUMBERS — одна страница' });
  await expect(preview.getByRole('columnheader')).toHaveText(['INN', 'MAV_LABEL_NAME', 'MSISDN', 'IS_MAV', 'IS_KSS', 'SPREADING', 'INTERNAL_OPERATOR_NAME']);
  await expect(preview).toContainText('00123456789'); await expect(preview).toContainText('00987654321');
  await approve(page);
  const decision = await (await page.request.get(`${revisionPath(c, r)}/approval`)).json() as Api['RevisionApprovalState'];
  expect(decision.current).toBe(true); expect(decision.approved).toBe(true); expect(decision.approval?.manifest_hash).toBe(bundle.manifest_hash);
  for (const role of ['CLIENTS', 'DOGTAGS', 'NUMBERS'] as const) {
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: `Скачать ${role}`, exact: true }).click();
    const download = await downloadEvent, target = testInfo.outputPath(`${role}.csv`);
    await download.saveAs(target);
    const bytes = await readFile(target), artifact = bundle.artifacts.find(item => item.role === role)!;
    expect(bytes).toEqual(expected[role]); expect(sha(bytes)).toBe(artifact.sha256); expect(bytes.length).toBe(artifact.size_bytes);
    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  }
  const zipEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать комплект', exact: true }).click();
  const zipDownload = await zipEvent, zipPath = testInfo.outputPath('kit.zip'); await zipDownload.saveAs(zipPath);
  const zipArtifact = bundle.artifacts.find(item => item.role === 'ZIP')!;
  expect(sha(await readFile(zipPath))).toBe(zipArtifact.sha256);
  const entries = JSON.parse(execFileSync(process.env.E2E_PYTHON!, [fileURLToPath(new URL('./verify_zip.py', import.meta.url)), zipPath], { encoding: 'utf8' })) as { name: string; bytes: string }[];
  expect(entries.map(entry => entry.name)).toEqual(bundle.artifacts.filter(item => item.role !== 'ZIP').map(item => item.download_filename));
  entries.forEach((entry, index) => expect(Buffer.from(entry.bytes, 'base64')).toEqual(expected[(['CLIENTS', 'DOGTAGS', 'NUMBERS'] as const)[index]]));
  await expect(page.getByText(/Браузер получил файл .*Сохранение на локальном диске неизвестно/)).toBeVisible();
  await page.reload(); await expect(page.getByTestId('revision-id')).toHaveText(r);
  await expect(page.getByTestId('preparation-status')).toContainText('Комплект подтверждён');
  await expect(page.getByRole('table', { name: 'Сохранённые свидетельства передачи файлов' })).toContainText('Сервер завершил передачу');
  await expect(page.getByTestId('external-state')).toContainText('Внешняя загрузка не подтверждена');
});

test('real F2: full 33-character label, scientific INN, empty independent flag, cumulative reasoned revisions', async ({ page }) => {
  await login(page); await newSource(page, errorSource);
  await page.getByRole('button', { name: 'Проверить файл', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 60_000 });
  await expect(page.getByRole('table', { name: 'Ошибки — одна страница' })).toContainText('inn_scientific');
  await page.getByRole('button', { name: 'Открыть запись 1 · INN', exact: true }).click();
  await expect(page.locator('#edit-INN')).toBeFocused(); await expect(page.locator('#edit-INN')).toHaveValue('1.234567894E+9');
  await expect(page.locator('#edit-MAV_LABEL_NAME')).toHaveValue('Б'.repeat(33));
  await expect(page.locator('#edit-MAV_LABEL_NAME')).not.toHaveAttribute('maxlength');
  await expect(page.locator('#edit-IS_MAV')).toHaveValue(''); await expect(page.locator('#edit-IS_KSS')).toHaveValue('1');
  const firstRevision = (await page.getByTestId('revision-id').textContent())!;
  const corrections: [string, string, string][] = [['INN', '1234567894', 'Подтверждённый синтетический ИНН'], ['MAV_LABEL_NAME', 'Тест', 'Согласовано единое название клиента'], ['IS_MAV', '1', 'Подтверждён независимый флаг']];
  for (let index = 0; index < corrections.length; index++) {
    const [field, value, reason] = corrections[index];
    await saveCorrection(page, 1, field, value, reason);
    const r = (await page.getByTestId('revision-id').textContent())!, c = (await page.getByTestId('case-id').textContent())!;
    expect(r).not.toBe(firstRevision);
    const saved = await (await page.request.get(revisionPath(c, r))).json() as Api['RevisionState'];
    expect(saved.correction_overlay).toHaveLength(index + 1);
    expect(saved.correction_overlay[index]).toMatchObject({ field, after: value, reason });
    expect(saved.correction_overlay[index].author_id).toMatch(/[0-9a-f-]{36}/);
    expect(saved.correction_overlay[index].created_at).toMatch(/(?:Z|\+00:00)$/);
    await page.getByRole('button', { name: 'Проверить файл', exact: true }).click();
    await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 60_000 });
    if (index === 0) await expect(page.getByRole('table', { name: 'Ошибки — одна страница' })).toContainText('label_length');
  }
  await expect(page.getByTestId('count-NUMBERS')).toHaveText('2'); await expect(page.getByTestId('coverage')).toContainText('Покрытие полное');
  await page.getByRole('button', { name: 'Открыть запись 1', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Исходное и действующее значения' })).toContainText('1.234567894E+9');
  await expect(page.getByRole('table', { name: 'Исходное и действующее значения' })).toContainText('Б'.repeat(33));
  await expect(page.getByRole('table', { name: 'Сохранённая история исправлений записи' })).toContainText(corrections[2][2]);
  await approve(page);
});

test('exact duplicates retain one representative and every parsed source record has an outcome', async ({ page }) => {
  await login(page); await newCase(page);
  const source = Buffer.from('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n1234567894;00123456789;Тест;Test;1;1\n1234567894;00987654321;Тест;Test;0;0\n1234567894;00123456789;Тест;Test;1;1\n');
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles({ name: 'duplicate.csv', mimeType: 'text/csv', buffer: source });
  await page.getByRole('button', { name: 'Сохранить источник', exact: true }).click(); await prepare(page);
  await expect(page.getByRole('table', { name: 'Исходные записи и исход обработки — одна страница' }).getByRole('row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Открыть запись 3', exact: true }).click();
  await expect(page.getByText('Точный дубль', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Открыть представителя дубля 1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Запись 1', exact: true })).toBeVisible();
  await expect(page.getByTestId('count-NUMBERS')).toHaveText('2'); await expect(page.getByTestId('coverage')).toContainText('Покрытие полное');
});
