import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { Api } from '../../src/api/client';
import { approve, login, newSource, prepare, revisionPath } from './helpers';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const schema = process.env.E2E_SCHEMA, override = process.env.E2E_COMPOSE_OVERRIDE;
const project = process.env.E2E_COMPOSE_PROJECT;
const restartEnabled = !!schema && /^test_[a-f0-9]{32}$/.test(schema) && !!override && isAbsolute(override) && project === 'dogtags-manager'
  && !!process.env.DOGTAGS_ACCEPTANCE_DATABASE_URL && new URL(process.env.DOGTAGS_ACCEPTANCE_DATABASE_URL).searchParams.get('options') === `-c search_path=${schema}`;
async function compose(args: string[]) {
  if (!restartEnabled) throw new Error('Restart requires the root-owned isolated test schema/Compose override.');
  await execute('docker', ['compose', '-p', project!, '-f', `${root}/compose.yaml`, '-f', override!, ...args], { cwd: root, env: process.env, timeout: 60_000, maxBuffer: 1024 * 1024 });
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('retained whole-platform restart preserves exact approved kit/raw/decision and resumes an unfinished queued revision', async ({ page, context }) => {
  test.skip(!restartEnabled, 'Whole-platform restart runs only inside the explicitly scoped acceptance harness.');
  test.setTimeout(240_000);
  await login(page); await newSource(page); await prepare(page); await approve(page);
  const c = (await page.getByTestId('case-id').textContent())!, r = (await page.getByTestId('revision-id').textContent())!;
  const before = await (await page.request.get(`/api/cases/${c}`)).json() as Api['CaseState'];
  const bundle = await (await page.request.get(`${revisionPath(c, r)}/artifacts`)).json() as Api['ArtifactSetState'];
  const decision = await (await page.request.get(`${revisionPath(c, r)}/approval`)).json() as Api['RevisionApprovalState'];
  const raw = await (await page.request.get(`/api/cases/${c}/sources/${before.revision!.source.id}/raw`)).body();
  expect(hash(raw)).toBe(before.revision!.source.sha256);
  const zip = bundle.artifacts.find(item => item.role === 'ZIP')!;
  const url = `${revisionPath(c, r)}/artifacts/${zip.id}/download?expected_revision_id=${r}&manifest_hash=${bundle.manifest_hash}`;
  const zipBefore = await (await page.request.get(url)).body(); expect(hash(zipBefore)).toBe(zip.sha256);
  const unfinished = await context.newPage(); let platformStopped = false;
  try {
    await compose(['stop', 'worker']); platformStopped = true;
    await unfinished.goto('/'); await newSource(unfinished);
    const queuedCase = (await unfinished.getByTestId('case-id').textContent())!, queuedRevision = (await unfinished.getByTestId('revision-id').textContent())!;
    await unfinished.getByRole('button', { name: 'Проверить файл', exact: true }).click();
    await expect(unfinished.getByTestId('preparation-status')).toContainText('В очереди');
    const queued = await (await unfinished.request.get(`/api/cases/${queuedCase}`)).json() as Api['CaseState'];
    expect(queued.revision!.state).toBe('QUEUED'); expect(queued.revision!.run_id).toMatch(/[0-9a-f-]{36}/);
    await compose(['stop', 'api', 'worker', 'dispatcher', 'rabbitmq', 'postgres']);
    await compose(['up', '-d', 'postgres', 'rabbitmq', 'api', 'dispatcher', 'worker']); platformStopped = false;
    await expect.poll(async () => { try { return (await page.request.get('/api/health', { timeout: 2000 })).status(); } catch { return 0; } }, { timeout: 60_000, intervals: [1000] }).toBe(200);
    await page.reload(); await expect(page.getByTestId('revision-id')).toHaveText(r); await expect(page.getByTestId('preparation-status')).toContainText('Комплект подтверждён');
    const restored = await (await page.request.get(`/api/cases/${c}`)).json() as Api['CaseState'];
    expect(restored.head_revision_id).toBe(r); expect(restored.external_state).toBe('NOT_SUBMITTED');
    const restoredDecision = await (await page.request.get(`${revisionPath(c, r)}/approval`)).json() as Api['RevisionApprovalState'];
    expect(restoredDecision.approval).toEqual(decision.approval); expect(restoredDecision.approved).toBe(true);
    expect(await (await page.request.get(`/api/cases/${c}/sources/${restored.revision!.source.id}/raw`)).body()).toEqual(raw);
    const restoredBundle = await (await page.request.get(`${revisionPath(c, r)}/artifacts`)).json() as Api['ArtifactSetState'];
    expect(restoredBundle.manifest_hash).toBe(bundle.manifest_hash); expect(restoredBundle.manifest).toEqual(bundle.manifest); expect(restoredBundle.artifacts).toEqual(bundle.artifacts);
    expect(await (await page.request.get(url)).body()).toEqual(zipBefore);
    await unfinished.reload(); await expect(unfinished.getByTestId('revision-id')).toHaveText(queuedRevision);
    await expect(unfinished.getByTestId('preparation-status')).toContainText('Файлы подготовлены', { timeout: 60_000 });
    const resumed = await (await unfinished.request.get(`/api/cases/${queuedCase}`)).json() as Api['CaseState'];
    expect(resumed.revision!.run_id).toBe(queued.revision!.run_id); expect(resumed.revision!.source.sha256).toBe(queued.revision!.source.sha256);
  } finally {
    if (platformStopped) await compose(['up', '-d', 'postgres', 'rabbitmq', 'api', 'dispatcher', 'worker']);
    await unfinished.close();
  }
});
