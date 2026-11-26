import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) test(`local workspace opens without credentials at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1000 });
  const credentialRequests: string[] = [];
  page.on('request', request => {
    if (/\/api\/session\/(login|logout)$/.test(new URL(request.url()).pathname)) credentialRequests.push(request.method());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Маркировка', exact: true })).toBeVisible();
  await expect(page.locator('#intake-files')).toBeEnabled();
  await expect(page.getByRole('form', { name: 'Вход', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toHaveCount(0);
  const initial = await (await page.request.get('/api/session')).json();
  expect(initial.authenticated).toBe(true);
  await page.reload();
  await expect(page.locator('#intake-files')).toBeEnabled();
  const renewed = await (await page.request.get('/api/session')).json();
  expect(renewed.user.id).toBe(initial.user.id);
  await page.screenshot({ path: testInfo.outputPath(`local-access-${width}.png`), fullPage: true });
  expect(credentialRequests).toEqual([]);
});
