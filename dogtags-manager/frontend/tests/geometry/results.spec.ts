import { expect, test } from '@playwright/test';
import { login } from '../e2e/helpers';

test('archive source list stays compact without a heading or filter', async ({ page }) => {
  test.skip(!process.env.E2E_USERNAME, 'Requires the isolated acceptance API.');
  await login(page);
  await page.getByRole('button', { name: 'Архив', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Фильтр: Архив обработок', exact: true })).toHaveCount(0);
  await expect(page.locator('.archive-list thead')).toHaveCount(0);
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
