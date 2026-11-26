import { expect, test, type Page } from '@playwright/test';
import type { Api } from '../../src/api/client';
import { approve, login, newSource, prepare, revisionPath, validSource } from './helpers';

async function holdCaseRead(page: Page, caseId: string) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void;
  const started = new Promise<void>(resolve => { held = resolve; });
  await page.route(`**/api/cases/${caseId}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect((await response.json() as Api['CaseState']).id).toBe(caseId);
    held(); await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  return { started, release };
}

test('delayed real case reread holds draft controls and retains the selected source and profile reason', async ({ page }) => {
  await login(page); await newSource(page); await prepare(page); await approve(page);
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  await page.getByRole('button', { name: 'Открыть запись 1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Запись 1', exact: true })).toBeVisible();
  await page.locator('#profile-INTERNAL_OPERATOR_NAME').fill('manualRTK');
  await page.getByLabel('Основание переопределения профиля', { exact: false }).fill('Ввод до задержанного перечитывания');
  await page.getByLabel('Файл HUB CSV', { exact: false }).setInputFiles(validSource);
  const held = await holdCaseRead(page, c);
  try {
    await page.getByRole('button', { name: 'Перечитать сохранённую заявку', exact: true }).click();
    await held.started;
    await expect(page.getByText('Загрузка сохранённой заявки…', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Файл HUB CSV', { exact: false })).toBeDisabled();
    await expect(page.getByLabel('Кодировка источника', { exact: false })).toBeDisabled();
    await expect(page.locator('#profile-SPREADING')).toBeDisabled();
    await expect(page.locator('#profile-INTERNAL_OPERATOR_NAME')).not.toBeEditable();
    await expect(page.getByLabel('Основание переопределения профиля', { exact: false })).not.toBeEditable();
    await expect(page.locator('#edit-MAV_LABEL_NAME')).not.toBeEditable();
    for (const name of ['Добавить исправления в черновик', 'Отменить ввод этой записи', 'Отменить несохранённый ввод', 'Перечитать сохранённую заявку', 'Новая заявка', 'Сохранить источник', 'Скачать NUMBERS']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    }
    held.release();
    await expect(page.getByText('Загрузка сохранённой заявки…', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('revision-id')).toHaveText(r);
    await expect(page.locator('#profile-INTERNAL_OPERATOR_NAME')).toHaveValue('manualRTK');
    await expect(page.getByLabel('Основание переопределения профиля', { exact: false })).toHaveValue('Ввод до задержанного перечитывания');
    expect(await page.getByLabel('Файл HUB CSV', { exact: false }).evaluate(element => [...((element as HTMLInputElement).files ?? [])].map(file => file.name))).toEqual(['valid.csv']);
    await expect(page.getByTestId('dirty-state')).toContainText('Есть несохранённый ввод');
  } finally {
    held.release();
  }
});

test('a queued record input survives a delayed real case reread without being staged or saved', async ({ page }) => {
  await login(page); await newSource(page);
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  await page.getByRole('button', { name: 'Открыть запись 1', exact: true }).click();
  await expect(page.locator('#edit-MAV_LABEL_NAME')).toBeEditable();
  const held = await holdCaseRead(page, c);
  try {
    await page.getByRole('button', { name: 'Перечитать сохранённую заявку', exact: true }).click();
    await held.started;
    // Deliver a native input event that was already queued before the editor
    // became read-only. The held response is unchanged from the real service.
    await page.evaluate(() => {
      const label = document.querySelector<HTMLInputElement>('#edit-MAV_LABEL_NAME')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(label, 'Задержанный ввод');
      label.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.getByTestId('dirty-state')).toContainText('Есть несохранённый ввод');
    held.release();
    await expect(page.getByText('Загрузка сохранённой заявки…', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('case-id')).toHaveText(c);
    await expect(page.getByTestId('revision-id')).toHaveText(r);
    await expect(page.locator('#edit-MAV_LABEL_NAME')).toHaveValue('Задержанный ввод');
    await expect(page.getByRole('button', { name: 'Сохранить и пересчитать', exact: true })).toBeDisabled();
    await expect(page.getByText(/Добавьте его в черновик или явно отмените перед перечитыванием/)).toBeVisible();
    const persisted = await (await page.request.get(revisionPath(c, r))).json() as Api['RevisionState'];
    expect(persisted.correction_overlay).toEqual([]);
    await page.getByRole('button', { name: `HUB · ${c}`, exact: true }).click();
    await expect(page.locator('#edit-MAV_LABEL_NAME')).toHaveValue('Задержанный ввод');
  } finally {
    held.release();
  }
});

test('an older real evidence snapshot cannot replace a newer download receipt and refresh', async ({ page }) => {
  await login(page); await newSource(page); await prepare(page); await approve(page);
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  const bundle = await (await page.request.get(`${revisionPath(c, r)}/artifacts`)).json() as Api['ArtifactSetState'];
  const numbers = bundle.artifacts.find(item => item.role === 'NUMBERS')!;
  const path = `${revisionPath(c, r)}/artifacts/${numbers.id}/download-evidence`;
  const row = page.getByRole('table', { name: 'Сохранённые свидетельства передачи файлов' }).getByRole('row').filter({ has: page.getByRole('cell', { name: 'NUMBERS', exact: true }) });
  await page.getByRole('button', { name: 'Обновить свидетельства передачи', exact: true }).click();
  await expect(row).toContainText('Попыток передачи нет.');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void;
  const started = new Promise<void>(resolve => { held = resolve; });
  await page.route(`**${path}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect((await response.json() as Api['DownloadEvidenceState']).latest_attempt).toBeNull();
    held(); await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  try {
    await page.getByRole('button', { name: 'Обновить свидетельства передачи', exact: true }).click();
    await started;
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Скачать NUMBERS', exact: true }).click();
    expect(await (await downloaded).failure()).toBeNull();
    await expect(row).toContainText('Сервер завершил передачу:');
    const currentResponse = await page.request.get(path);
    expect(currentResponse.status()).toBe(200);
    const current = await currentResponse.json() as Api['DownloadEvidenceState'];
    expect(current.latest_attempt?.response_completed_at).toBeTruthy();
    expect(current.latest_attempt?.bytes_sent).toBe(numbers.size_bytes);
    const attemptId = current.latest_attempt!.attempt_id;
    await expect(row).toContainText(attemptId);
    const newer = Promise.all(bundle.artifacts.map(item => page.waitForResponse(response => new URL(response.url()).pathname === `${revisionPath(c, r)}/artifacts/${item.id}/download-evidence`)));
    await page.getByRole('button', { name: 'Обновить свидетельства передачи', exact: true }).click();
    for (const response of await newer) {
      expect(response.status()).toBe(200);
      await response.finished();
      if (new URL(response.url()).pathname === path) expect((await response.json() as Api['DownloadEvidenceState']).latest_attempt?.attempt_id).toBe(attemptId);
    }
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(row).toContainText(attemptId);
    const older = page.waitForResponse(response => new URL(response.url()).pathname === path);
    release();
    await (await older).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(row).toContainText(attemptId);
    await expect(row).toContainText('Сервер завершил передачу:');
    await expect(row).not.toContainText('Попыток передачи нет.');
  } finally {
    release();
  }
});
