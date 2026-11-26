import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) test(`external filter and sort retain table mode at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/?view=catalog');
  const table = page.getByRole('table', { name: 'Пример фильтра и сортировки', exact: true });
  const block = page.locator('.table-block').filter({ has: table });
  const filter = block.getByRole('button', { name: 'Фильтр: Пример фильтра и сортировки', exact: true });
  const sort = block.getByRole('combobox', { name: 'Сортировка примера', exact: true });
  await expect(sort).toBeVisible();
  await expect(table.getByRole('button', { name: /Фильтр/ })).toHaveCount(0);
  expect(await block.evaluate(element => {
    const toolbar = element.querySelector('.progressive-toolbar')!, region = element.querySelector('.table-region')!;
    return toolbar.getBoundingClientRect().bottom <= region.getBoundingClientRect().top;
  })).toBe(true);
  await filter.click();
  await block.getByRole('radio', { name: '1000 строк', exact: true }).check();
  await expect(table.locator('tbody tr')).toHaveCount(1000);
  await block.getByRole('radio', { name: '1000 строк', exact: true }).press('Escape');
  await expect(filter).toHaveAttribute('aria-expanded', 'false');
  await expect(filter).toBeFocused();
  await expect(sort).toBeVisible();
  await filter.click();
  await expect(block.getByRole('radio', { name: '1000 строк', exact: true })).toBeChecked();
  await sort.selectOption('true');
  await expect(table.locator('tbody tr').first()).toContainText('1200');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('expanded filter stays within the table block with enlarged text at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?view=catalog');
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  const table = page.getByRole('table', { name: 'Пример фильтра и сортировки', exact: true });
  const block = page.locator('.table-block').filter({ has: table });
  await block.getByRole('button', { name: 'Фильтр: Пример фильтра и сортировки', exact: true }).click();
  await expect(block.getByRole('radio', { name: 'Все строки', exact: true })).toBeVisible();
  await expect.poll(() => block.evaluate(element => {
    const panel = element.querySelector('.progressive-filter')!;
    return panel.getBoundingClientRect().right <= element.getBoundingClientRect().right + 1;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
