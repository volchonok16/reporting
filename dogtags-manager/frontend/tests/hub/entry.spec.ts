import { expect, test } from '@playwright/test';

test('default URL opens the real HUB source selector', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Подготовка комплекта HUB', exact: true })).toBeVisible();
  await expect(page.getByLabel('Файл HUB CSV', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Каталог общих компонентов', exact: true })).toHaveCount(0);
});
