import { expect, test, type Page } from '@playwright/test';
import type { Api } from '../../src/api/client';
import { login } from './helpers';

async function session(page: Page) {
  const value = await (await page.request.get('/api/session')).json() as Api['SessionState'];
  return { 'X-CSRF-Token': value.csrf_token, Origin: new URL(page.url()).origin };
}
async function seed(page: Page, name: string, text = 'MSISDN\r\n79000000011\r\n') {
  const response = await page.request.post('/api/intakes?partner=RTK%20HUB', {
    headers: { ...await session(page), 'X-Operation-ID': crypto.randomUUID() },
    multipart: { file: { name, mimeType: 'text/csv', buffer: Buffer.from(text) } },
  });
  expect(response.status()).toBe(200);
  return (await response.json() as Api['IntakeOperationState']).result!.intake.id;
}
async function post(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, { headers: await session(page), data });
  expect(response.status()).toBe(200);
  return response.json();
}

test('polling retains the next unseen intake cursor after advancing to page two', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1280, height: 240 });
  for (let i = 0; i < 11; i++) await seed(page, `cursor-${i}.csv`);
  // Five-record server pages overflow the archive list and expose three cursor boundaries.
  await page.route('**/api/intakes*', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/intakes') return route.continue();
    url.searchParams.set('limit', '5');
    await route.fulfill({ response: await route.fetch({ url: url.toString() }) });
  });
  const firstRead = page.waitForResponse(r => new URL(r.url()).pathname === '/api/intakes');
  await page.reload();
  const first = await (await firstRead).json() as Api['IntakePage'];
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  const secondRead = page.waitForResponse(r => new URL(r.url()).searchParams.get('after') === first.next_cursor);
  await page.getByRole('region', { name: 'Архив обработок', exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight; });
  const second = await (await secondRead).json() as Api['IntakePage'];
  expect(second.next_cursor).toBeTruthy();
  const poll = await page.waitForResponse(r => new URL(r.url()).pathname === '/api/intakes' && new URL(r.url()).searchParams.get('after') === first.next_cursor);
  await poll.finished();
  const next = page.waitForRequest(r => new URL(r.url()).pathname === '/api/intakes' && new URL(r.url()).searchParams.has('after'));
  await page.getByRole('region', { name: 'Архив обработок', exact: true }).evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(new URL((await next).url()).searchParams.get('after')).toBe(second.next_cursor);
});

for (const action of ['decisions', 'approval'] as const) for (const recovery of ['reload', 'same page'] as const) {
  test(`a ${action} request lost before reaching the server replays the exact command on ${recovery}`, async ({ page }) => {
    await login(page);
    const id = await seed(page, `recovery-${action}.csv`);
    await page.goto(`/?intake=${id}`);
    await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
    const intake = await (await page.request.get(`/api/intakes/${id}`)).json() as Api['IntakeDetail'];
    const path = action === 'decisions' ? `/api/intakes/${id}/decisions` : `/api/cases/${intake.intake.case_id}/approval`;
    let original = '';
    await page.route(`**${path}`, async route => {
      original = route.request().postData()!;
      await route.abort('failed');
    }, { times: 1 });
    if (action === 'decisions') {
      await page.getByRole('button', { name: 'Изменить партнёра или назначение', exact: true }).click();
      await page.getByTestId('intake-decisions').getByLabel('Партнёр', { exact: true }).selectOption('RTK HUB');
      await page.getByTestId('intake-decisions').getByRole('button', { name: 'Сохранить решения и продолжить', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
      await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
    }
    await expect(page.getByText('Проверяем сохранение операции', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Исход операции неизвестен');
    const body = JSON.parse(original);
    const lookup = await page.request.get(`/api/operations?operation_id=${body.operation_id}&action=${action === 'decisions' ? 'intake.decisions' : 'package.approve'}&case_id=${intake.intake.case_id}`);
    expect(lookup.status()).toBe(404);
    const replay = page.waitForRequest(r => new URL(r.url()).pathname === path && r.method() === 'POST');
    if (recovery === 'reload') { page.once('dialog', dialog => dialog.accept()); await page.reload(); }
    else await page.getByRole('button', { name: 'Проверить сохранённую операцию', exact: true }).click();
    expect(JSON.parse((await replay).postData()!)).toEqual(body);
    await expect(page.getByText('Проверяем сохранение операции', { exact: true })).toHaveCount(0);
    if (action === 'approval') await expect(page.getByTestId('preparation-status')).toContainText('Комплект подтверждён');
    else await expect.poll(async () => (await (await page.request.get(`/api/intakes/${id}`)).json() as Api['IntakeDetail']).version.sequence).toBe(intake.version.sequence + 1);
    await page.getByRole('button', { name: 'Архив', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Открыть реестр', exact: true })).toHaveCount(0);
    await page.reload();
    if (action === 'decisions') expect((await (await page.request.get(`/api/intakes/${id}`)).json() as Api['IntakeDetail']).version.sequence).toBe(intake.version.sequence + 1);
  });
}

async function twoAssessments(page: Page) {
  const source = await seed(page, 'race-source.csv');
  await page.goto(`/?intake=${source}`);
  await expect(page.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Перейти к подтверждению', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить комплект', exact: true }).click();
  await expect(page.getByTestId('preparation-status')).toContainText('Комплект подтверждён');
  const intake = await (await page.request.get(`/api/intakes/${source}`)).json() as Api['IntakeDetail'];
  const bundle = await (await page.request.get(`/api/cases/${intake.intake.case_id}/revisions/${intake.revision!.id}/artifacts`)).json() as Api['ArtifactSetState'];
  const artifact = bundle.artifacts.find(a => a.role === 'DELETE')!;
  const returnId = await seed(page, 'race-return.csv', 'MSISDN;STATUS\r\n79000000011;UNKNOWN_TEST\r\n');
  const assessments: string[] = [], attempts: string[] = [];
  for (const outcome of ['REJECTED', 'APPLIED']) {
    const attempt = await post(page, '/api/external-attempts', { operation_id: crypto.randomUUID(), artifact_id: artifact.id, artifact_set_id: bundle.artifact_set_id, manifest_hash: bundle.manifest_hash, reason: `Race ${outcome}` }) as Api['ExternalAttemptState'];
    await post(page, `/api/external-attempts/${attempt.id}/evidence`, { operation_id: crypto.randomUUID(), outcome, coverage: 'FILE', origin: 'MANUAL', reason: `Race ${outcome}` });
    await expect.poll(async () => (await (await page.request.get(`/api/intakes/${returnId}`)).json() as Api['IntakeDetail']).job?.state, { timeout: 90_000 }).not.toMatch(/QUEUED|RUNNING|LEASED/);
    const current = await (await page.request.get(`/api/intakes/${returnId}`)).json() as Api['IntakeDetail'];
    await post(page, `/api/intakes/${returnId}/decisions`, { operation_id: crypto.randomUUID(), expected_version_id: current.version.id, decisions: { operation: 'STATUS', return_attempt_id: attempt.id, reason: `Race link ${outcome}` } });
    await expect.poll(async () => (await (await page.request.get(`/api/returns/${returnId}`)).json() as Api['ReturnDetailWithRetryTarget']).assessment?.attempt_id, { timeout: 90_000 }).toBe(attempt.id);
    attempts.push(attempt.id);
    assessments.push((await (await page.request.get(`/api/returns/${returnId}`)).json() as Api['ReturnDetailWithRetryTarget']).assessment!.id);
  }
  return { returnId, rejectedAttempt: attempts[0], current: assessments[1] };
}

for (const delayed of ['detail', 'initial rows', 'manual rows'] as const) {
  test(`late ${delayed} cannot replace a refreshed STATUS assessment`, async ({ page }) => {
    await login(page);
    const ids = await twoAssessments(page);
    await page.goto(`/?intake=${ids.returnId}`);
    const panel = page.getByTestId('return-panel');
    const rows = panel.getByRole('region', { name: 'Строки возврата и точность сопоставления', exact: true });
    await expect(rows).toContainText('Применено');
    await expect(panel.getByText('История сверок и повторных версий', { exact: true })).toHaveCount(0);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = new Promise<void>(resolve => { started = resolve; });
    const path = `/api/returns/${ids.returnId}${delayed === 'detail' ? '' : '/rows'}`;
    let captured = false;
    await page.route(`**${path}*`, async route => {
      const url = new URL(route.request().url());
      if (captured || url.pathname !== path) return route.continue();
      captured = true;
      const response = await route.fetch(); expect(response.status()).toBe(200);
      started(); await gate; await route.fulfill({ response });
    });
    try {
      await panel.getByRole('button', { name: delayed === 'manual rows' ? 'Начало возврата' : 'Перечитать связь и внешние результаты', exact: true }).click();
      await held;
      const current = await (await page.request.get(`/api/intakes/${ids.returnId}`)).json() as Api['IntakeDetail'];
      await post(page, `/api/intakes/${ids.returnId}/decisions`, { operation_id: crypto.randomUUID(), expected_version_id: current.version.id, decisions: { operation: 'STATUS', return_attempt_id: ids.rejectedAttempt, reason: 'Refresh racing assessment' } });
      await expect.poll(async () => (await (await page.request.get(`/api/returns/${ids.returnId}`)).json() as Api['ReturnDetailWithRetryTarget']).assessment?.attempt_id, { timeout: 90_000 }).toBe(ids.rejectedAttempt);
      await panel.getByRole('button', { name: 'Перечитать связь и внешние результаты', exact: true }).click();
      await expect(rows).toContainText('Отказ');
      const oldResponse = page.waitForResponse(r => new URL(r.url()).pathname === path);
      release(); await (await oldResponse).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(rows).toContainText('Отказ');
      await expect(rows).not.toContainText('Применено');
      await expect(panel.getByText('Сверка заменена', { exact: true })).toHaveCount(0);
    } finally { release(); }
  });
}
