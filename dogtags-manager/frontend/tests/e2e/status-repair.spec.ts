import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { login } from './helpers';
import type { Api } from '../../src/api/client';

const file = (name: string, content: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(`\ufeff${content}`) });
const dogtags = file('repair-dogtags.csv', `INN;MAV_LABEL;MAV_LABEL_LATIN;IS_ACTIVE;STATUS\n1234567894;Тест;${'A'.repeat(34)};1;\n`);
const numbers = file('repair-numbers.csv', [
  'INN;MAV_LABEL_NAME;MSISDN;IS_MAV;IS_KSS;SPREADING;INTERNAL_OPERATOR_NAME;STATUS',
  '1234567894;Тест;00123456789;0;1;0;Исходный оператор;',
  `1234567894;${'А'.repeat(34)};00123456788;1;0;1;Другой оператор;Номер телефона уже есть в таблице MAV номеров`,
  `1234567894;${'А'.repeat(34)};00123456787;0;1;0;Исходный оператор;ИНН отсутствует в таблице MAV клиентов`,
  '1234567894;Тест;00123456786;1;1;1;Исходный оператор;Неизвестная ошибка',
  '1234567894;Тест;00123456785;1;0;0;Исходный оператор;MAV_LABEL_NAME отсутствует в таблице этикеток',
  `1234567894;${'А'.repeat(34)};00123456784;1;1;1;Исходный оператор;`,
].join('\n') + '\n');

async function uploadRepair(page: Page, source: ReturnType<typeof file>) {
  await page.getByLabel('Файл с ошибками из базы', { exact: true }).check();
  await page.locator('#upload-partner').selectOption('RTK HUB');
  await page.getByLabel('Исходный файл', { exact: true }).setInputFiles(source);
  const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/intakes');
  await page.getByRole('button', { name: 'Обработать файл', exact: true }).click();
  const result = await response;
  expect(new URL(result.url()).searchParams.get('operation')).toBe('REPAIR');
  const receipt = await result.json() as Api['IntakeOperationState'];
  await expect(page.getByTestId('preparation-status')).toHaveText('Файлы подготовлены', { timeout: 90_000 });
  return receipt.result!.intake.id;
}
async function bundle(page: Page, id: string) {
  const intake = await (await page.request.get(`/api/intakes/${id}`)).json() as Api['IntakeDetail'];
  const path = `/api/cases/${intake.intake.case_id}/revisions/${intake.revision!.id}`;
  const outputs = await (await page.request.get(`${path}/artifacts`)).json() as Api['ArtifactSetState'];
  return { intake, path, outputs };
}

test('returned NUMBERS preserves source flags, separates recovery keys and diagnostics, gates download and archive evidence', async ({ page }, info) => {
  await login(page);
  await expect(page.getByLabel('Новый исходный файл', { exact: true })).toBeChecked();
  const id = await uploadRepair(page, numbers);
  const { intake, path, outputs } = await bundle(page, id);
  expect(intake.revision!.settings).toMatchObject({ operation: 'REPAIR', repair_role: 'NUMBERS' });
  expect(Object.fromEntries(outputs.artifacts.filter(value => value.role !== 'ZIP').map(value => [value.role, value.row_count]))).toEqual({ CLIENTS: 1, NUMBERS: 1, DELETE: 1, ERRORS: 4 });
  for (const [role, expected] of Object.entries({
    NUMBERS: [['1234567894', 'Тест', '00123456789', '0', '1', '0', 'Исходный оператор']],
    CLIENTS: [['', '', '', '1234567894']], DELETE: [['00123456788']],
  })) {
    const artifact = outputs.artifacts.find(value => value.role === role)!;
    const preview = await (await page.request.get(`${path}/artifacts/${artifact.id}/preview`)).json() as Api['ArtifactPreview'];
    expect(preview.items).toEqual(expected); expect(preview.columns).not.toContain('STATUS');
  }
  await expect(page.getByRole('button', { name: 'Скачать NUMBERS', exact: true })).toHaveCount(0);
  const badRow = page.getByRole('table', { name: 'Результаты обработки данных', exact: true }).getByRole('row').filter({ hasText: '00123456784' });
  await expect(badRow).toHaveAttribute('data-tone', 'danger');
  await expect(badRow.locator('.repair-field-error')).toContainText('А'.repeat(34));
  await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await expect(page.getByTestId('application-order')).toHaveText('Порядок загрузки: DELETE → CLIENTS → NUMBERS.');
  await expect(page.getByText('Строки с ошибками — диагностический CSV в UTF-8. Не загружайте его в базу.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Предпросмотр Строки с ошибками', exact: true }).click();
  const errorPreview = page.getByRole('table', { name: 'Предпросмотр Строки с ошибками', exact: true });
  await expect(errorPreview.locator('.repair-field-error')).toContainText(['А'.repeat(34), 'А'.repeat(34), 'Неизвестная ошибка', 'А'.repeat(34)]);
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  const saved = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать Строки с ошибками', exact: true }).click();
  const download = await saved; const target = info.outputPath('repair-errors.csv'); await download.saveAs(target);
  expect((await readFile(target, 'utf8'))).toContain('Неизвестная ошибка');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Скачайте готовые файлы', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await page.getByRole('button', { name: /^Открыть обработку repair-numbers\.csv от / }).first().click();
  const archive = page.getByRole('region', { name: 'Просмотр обработки', exact: true });
  await expect(archive.getByRole('button', { name: 'Предпросмотр NUMBERS', exact: true })).toBeVisible();
  await expect(archive.getByRole('button', { name: /Результат загрузки (ERRORS|Строки с ошибками)/ })).toHaveCount(0);
  await archive.getByRole('button', { name: 'Предпросмотр Строки с ошибками', exact: true }).click();
  await expect(archive.getByRole('table', { name: 'Предпросмотр Строки с ошибками', exact: true })).toContainText('Неизвестная ошибка');
});

test('blank STATUS does not bypass DOGTAGS validation and inline repair is rechecked before approval', async ({ page }) => {
  await login(page);
  const id = await uploadRepair(page, dogtags);
  await page.getByRole('button', { name: 'Редактировать строку 1', exact: true }).click();
  await expect(page.locator('#edit-MAV_LABEL_LATIN')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#edit-STATUS')).toHaveValue('');
  await expect(page.locator('#edit-IS_ACTIVE')).toHaveValue('1');
  await expect(page.locator('#override-SPREADING')).toHaveCount(0);
  const previousRevision = (await bundle(page, id)).intake.revision!.id;
  await page.locator('#edit-MAV_LABEL_LATIN').fill('Test');
  await expect(page.getByRole('button', { name: 'Перейти к подтверждению', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toHaveText('Файлы подготовлены', { timeout: 90_000 });
  await expect.poll(async () => {
    const current = await (await page.request.get(`/api/intakes/${id}`)).json() as Api['IntakeDetail'];
    return current.revision?.id !== previousRevision && current.revision?.state === 'PREPARED';
  }, { timeout: 90_000 }).toBe(true);
  const { path, outputs } = await bundle(page, id);
  expect(outputs.artifacts.some(value => value.role === 'ERRORS')).toBe(false);
  const output = outputs.artifacts.find(value => value.role === 'DOGTAGS')!;
  const preview = await (await page.request.get(`${path}/artifacts/${output.id}/preview`)).json() as Api['ArtifactPreview'];
  expect(preview.items).toEqual([['1234567894', 'Тест', 'Test', '1']]);
  await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Скачать DOGTAGS', exact: true })).toBeEnabled();
});

test('pending returned upload survives reload and replays the saved operation and partner', async ({ page }) => {
  await login(page);
  let firstOperation = '';
  await page.route('**/api/intakes?*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    firstOperation = route.request().headers()['x-operation-id']; await route.abort('failed');
  });
  await page.getByLabel('Файл с ошибками из базы', { exact: true }).check();
  await page.locator('#upload-partner').selectOption('RTK ABC');
  await page.getByLabel('Исходный файл', { exact: true }).setInputFiles(dogtags);
  await page.getByRole('button', { name: 'Обработать файл', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Исход операции неизвестен');
  await page.unroute('**/api/intakes?*'); await page.reload();
  const retry = page.getByLabel('Повторно выбрать тот же файл', { exact: true });
  await expect(retry).toBeVisible();
  const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/intakes');
  await retry.setInputFiles(dogtags);
  const replay = await response;
  expect(replay.request().headers()['x-operation-id']).toBe(firstOperation);
  expect(new URL(replay.url()).searchParams.get('operation')).toBe('REPAIR');
  expect(new URL(replay.url()).searchParams.get('partner')).toBe('RTK ABC');
  await expect(page.getByTestId('preparation-status')).toHaveText('Файлы подготовлены', { timeout: 90_000 });
});

test('manual CLIENTS mapping preserves present optional columns and permits absent optional headers', async ({ page }) => {
  await login(page);
  for (const withCompany of [true, false]) {
    if (!withCompany) await page.getByRole('button', { name: 'Новая обработка', exact: true }).click();
    await page.getByLabel('Файл с ошибками из базы', { exact: true }).check();
    await page.locator('#upload-partner').selectOption('RTK HUB');
    const source = file(`manual-repair-clients-${withCompany}.csv`, withCompany
      ? 'tax;company;contract;operator;feedback\n1234567894;Компания;Договор;Оператор;\n'
      : 'tax;feedback\n1234567894;\n');
    await page.getByLabel('Исходный файл', { exact: true }).setInputFiles(source);
    const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === '/api/intakes');
    await page.getByRole('button', { name: 'Обработать файл', exact: true }).click();
    const receipt = await (await response).json() as Api['IntakeOperationState'];
    const form = page.getByTestId('intake-decisions');
    await expect(form).toBeVisible({ timeout: 90_000 });
    await form.locator('#decision-repair-role').selectOption('CLIENTS');
    await form.locator('#mapping-INN').selectOption('0');
    await form.locator('#mapping-STATUS').selectOption(withCompany ? '4' : '1');
    if (withCompany) {
      for (const [index, field] of ['COMPANY_NAME', 'COMPANY_CONTRACT', 'MAV_OPERATOR_NAME'].entries()) {
        await form.locator(`#mapping-${field}`).selectOption(String(index + 1));
      }
    }
    await form.getByRole('button', { name: 'Сохранить решения и продолжить', exact: true }).click();
    await expect(page.getByTestId('preparation-status')).toHaveText('Файлы подготовлены', { timeout: 90_000 });
    const { intake, path, outputs } = await bundle(page, receipt.result!.intake.id);
    expect(intake.revision!.settings.repair_role).toBe('CLIENTS');
    const artifact = outputs.artifacts.find(value => value.role === 'CLIENTS')!;
    const preview = await (await page.request.get(`${path}/artifacts/${artifact.id}/preview`)).json() as Api['ArtifactPreview'];
    expect(preview.items).toEqual([withCompany ? ['Компания', 'Договор', 'Оператор', '1234567894'] : ['', '', '', '1234567894']]);
    await expect(page.getByRole('button', { name: 'Выбрать сохранённую отправку', exact: false })).toHaveCount(0);
  }
});
