import { expect, test } from '@playwright/test';
import { login } from '../e2e/helpers';

test('automatic decision form geometry, keyboard and 200 percent text use real API state', async ({ page }, testInfo) => {
  test.skip(!process.env.E2E_USERNAME, 'Run against the isolated acceptance API with a published rule snapshot.');
  await login(page);
  await page.getByLabel('Исходный файл', { exact: false }).setInputFiles({ name: 'geometry.csv', mimeType: 'text/csv', buffer: Buffer.from('\ufeffДлинное исходное название колонки клиента;Номер телефона;Этикетка;Латиница;Первый флаг;Второй флаг\n1234567894;00123456789;Тест;Test;1;1\n') });
  await page.getByLabel('Партнёр', { exact: true }).selectOption('RTK HUB');
  await page.getByRole('button', { name: 'Обработать файл', exact: true }).click();
  const form = page.getByTestId('intake-decisions'); await expect(form).toBeVisible({ timeout: 60_000 });
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const zoom of [100, 200]) {
      await page.evaluate(value => { document.documentElement.style.fontSize = `${value}%`; }, zoom);
      const boxes = await form.evaluate(element => {
        const fields = [...element.querySelectorAll<HTMLElement>('.form-grid [data-field]')];
        return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          fields: fields.map(field => { const control = field.querySelector<HTMLElement>('[data-control]')!; const rect = control.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height, labelBottom: field.querySelector('.field-label')!.getBoundingClientRect().bottom, supportTop: field.querySelector('.field-support')!.getBoundingClientRect().top }; }) };
      });
      expect(boxes.overflow).toBeLessThanOrEqual(1);
      for (const box of boxes.fields) { expect(box.height).toBeGreaterThanOrEqual(44); expect(box.top).toBeGreaterThanOrEqual(box.labelBottom); expect(box.supportTop).toBeGreaterThanOrEqual(box.bottom); }
      await testInfo.attach(`intake-${width}-${zoom}`, { body: JSON.stringify(boxes), contentType: 'application/json' });
    }
  }
  await form.getByLabel('Партнёр', { exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(form.getByLabel('Назначение файла', { exact: true })).toBeFocused();
  await form.getByLabel('Партнёр', { exact: true }).selectOption('');
  await form.getByRole('button', { name: 'Сохранить решения и продолжить', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Выберите партнёра');
});
