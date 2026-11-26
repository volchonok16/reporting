import { expect, test, type Page } from '@playwright/test';

async function dictionaryFixture(page: Page, canManage: boolean) {
  const state = {
      token: 'fixture-settings', can_manage: canManage, rules_ready: true,
      profiles: {
        'RTK HUB': { INTERNAL_OPERATOR_NAME: 'hubRTK', SPREADING: '0' },
        'RTK ABC': { INTERNAL_OPERATOR_NAME: 'fRTK', SPREADING: '0' },
        'RTK MVNO': { INTERNAL_OPERATOR_NAME: '', SPREADING: '1' },
        'ГПБМ': { INTERNAL_OPERATOR_NAME: '', SPREADING: '1' },
      },
      mnemonics: [
        { id: 'hub', code: 'hubRTK', description: 'Мнемоника партнёра RTK HUB', used_by: ['RTK HUB'] },
        { id: 'abc', code: 'fRTK', description: 'Мнемоника партнёра RTK ABC', used_by: ['RTK ABC'] },
        { id: 'unused', code: 'unusedOperator', description: 'Длинное описание внутреннего оператора для проверки переноса текста на узком экране', used_by: [] },
      ],
  };
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: { authenticated: true, csrf_token: 'fixture', user: { id: 'dictionary-fixture', username: 'fixture', permissions: canManage ? ['case.read', 'case.edit', 'rules.publish'] : ['case.read'] } } });
    if (path === '/api/intakes') return route.fulfill({ json: { items: [], next_cursor: null } });
    if (path === '/api/processing-settings') return route.fulfill({ json: state });
    if (path === '/api/processing-settings/partners') {
      state.profiles = route.request().postDataJSON().profiles;
      return route.fulfill({ json: state });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('/?section=dictionary');
}

for (const width of [390, 1440]) for (const canManage of [false, true]) test(`dictionary external headings and actions at ${width}px, manage=${canManage}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await dictionaryFixture(page, canManage);
  const forms = page.locator('[data-form="partner-settings"]');
  await expect(forms).toHaveCount(4);
  for (const partner of ['RTK HUB', 'RTK ABC', 'RTK MVNO', 'ГПБМ']) {
    const form = page.getByRole('region', { name: partner, exact: true });
    await expect(form).toBeVisible();
    expect(await form.evaluate(element => {
      const title = element.parentElement!.querySelector('h3')!;
      return !element.contains(title) && title.getBoundingClientRect().bottom <= element.getBoundingClientRect().top;
    })).toBe(true);
    expect(await form.getByRole('combobox').first().isDisabled()).toBe(!canManage);
  }
  if (width === 390) expect(await forms.evaluateAll(elements => new Set(elements.map(element => Math.round(element.getBoundingClientRect().left))).size)).toBe(1);
  await expect(page.getByRole('button', { name: 'Сохранить настройки партнёров', exact: true })).toHaveCount(canManage ? 1 : 0);
  await page.getByRole('navigation', { name: 'Разделы справочника' }).getByRole('button', { name: 'Мнемоника', exact: true }).click();
  await expect(forms).toHaveCount(0);
  const table = page.getByRole('table', { name: 'Мнемоника', exact: true });
  await expect(table).toBeVisible();
  await expect(table.getByRole('button', { name: /Фильтр/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Фильтр: Мнемоника', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Количество строк', exact: true })).toBeVisible();
  await page.getByRole('radio', { name: '500 строк', exact: true }).press('Escape');
  await expect(page.getByRole('button', { name: 'Фильтр: Мнемоника', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Добавить мнемонику', exact: true })).toHaveCount(canManage ? 1 : 0);
  await expect(page.getByRole('button', { name: 'Сохранить настройки партнёров', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (canManage) {
    expect(await page.getByRole('button', { name: 'Добавить мнемонику', exact: true }).evaluate(element => {
      const strip = element.closest('.action-strip')!;
      return !!strip && !strip.querySelector('table') && !strip.querySelector('h2');
    })).toBe(true);
    await expect(page.getByRole('button', { name: 'Удалить мнемонику hubRTK', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Редактировать мнемонику hubRTK', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Мнемоника (обязательно)', exact: true })).toHaveAttribute('readonly', '');
    expect(await page.getByRole('textbox', { name: 'Мнемоника (обязательно)', exact: true }).evaluate(element => !!element.closest('.table-expansion'))).toBe(true);
    await page.getByRole('navigation', { name: 'Разделы справочника' }).getByRole('button', { name: 'Настройки партнёров', exact: true }).click();
    await expect(page.getByRole('region', { name: 'RTK HUB', exact: true }).getByRole('combobox').first()).toBeEnabled();
  }
});

for (const width of [390, 1440]) test(`company names can be added and edited in the INN section at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const entries = [{ inn: '7743895280', company_name: '' }, { inn: '7707083893', company_name: '' }];
  await dictionaryFixture(page, true);
  await page.route('**/api/whitemav/inns**', async route => {
    const request = route.request();
    if (request.method() === 'POST') entries.push(request.postDataJSON());
    if (request.method() === 'PUT') entries.find(item => item.inn === new URL(request.url()).pathname.split('/').at(-1))!.company_name = request.postDataJSON().company_name;
    return route.fulfill({ json: { items: entries.map(item => item.inn), entries } });
  });
  const sections = page.getByRole('navigation', { name: 'Разделы справочника' });
  await sections.getByRole('button', { name: 'ИНН', exact: true }).click();
  await expect(page.getByRole('table', { name: 'ИНН компаний' })).toBeVisible();
  await page.getByRole('button', { name: 'Редактировать ИНН 7707083893' }).click();
  await page.getByRole('textbox', { name: 'Название компании', exact: true }).fill('Тестовая компания');
  await expect(sections.getByRole('button', { name: 'Мнемоника', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Тестовая компания', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить ИНН', exact: true }).click();
  await page.getByRole('textbox', { name: 'ИНН (обязательно)', exact: true }).fill('7805406976');
  await page.getByRole('textbox', { name: 'Название компании', exact: true }).fill('ООО Пример');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'ООО Пример', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: 'Мнемоника', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Мнемоника', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: 'ИНН', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'ООО Пример', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'Маркировка', exact: true }).click();
  await page.getByRole('radio', { name: 'Исключения из МАВ', exact: true }).check();
  const choice = page.getByRole('combobox', { name: 'ИНН для исключений (обязательно)', exact: true });
  await expect(choice.getByRole('option', { name: '7805406976 — ООО Пример', exact: true })).toHaveCount(1);
  await choice.selectOption('7805406976');
  await expect(choice).toHaveValue('7805406976');
});

test('INN deletion confirms or cancels and removed defaults stay out of new processing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  let entries = [{ inn: '7743895280', company_name: 'Первая компания' }, { inn: '7707083893', company_name: 'Вторая компания' }];
  let deletions = 0;
  await dictionaryFixture(page, true);
  await page.route('**/api/whitemav/inns**', async route => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      deletions++;
      entries = entries.filter(item => item.inn !== new URL(request.url()).pathname.split('/').at(-1));
    }
    return route.fulfill({ json: { items: entries.map(item => item.inn), entries } });
  });
  await page.getByRole('navigation', { name: 'Разделы справочника' }).getByRole('button', { name: 'ИНН', exact: true }).click();
  await page.getByRole('button', { name: 'Удалить ИНН 7743895280', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить ИНН 7743895280?', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Первая компания');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(deletions).toBe(0);
  await expect(page.getByRole('cell', { name: '7743895280', exact: true })).toBeVisible();
  for (const inn of ['7743895280', '7707083893']) {
    await page.getByRole('button', { name: `Удалить ИНН ${inn}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить удаление', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('cell', { name: inn, exact: true })).toHaveCount(0);
  }
  expect(deletions).toBe(2);
  await page.getByRole('button', { name: 'Маркировка', exact: true }).click();
  await page.getByRole('radio', { name: 'Исключения из МАВ', exact: true }).check();
  const choice = page.getByRole('combobox', { name: 'ИНН для исключений (обязательно)', exact: true });
  await expect(choice).toHaveValue('');
  await expect(choice.getByRole('option', { name: /7743895280|7707083893/ })).toHaveCount(0);
  await page.locator('#intake-files').setInputFiles({ name: 'test.csv', mimeType: 'text/csv', buffer: Buffer.from('MSISDN\n79937967877\n') });
  await expect(page.getByRole('button', { name: 'Обработать файл', exact: true })).toBeDisabled();
});

for (const width of [390, 1440]) test(`custom partner flags can be saved and selected at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await dictionaryFixture(page, true);
  await page.getByRole('textbox', { name: 'Название нового партнёра' }).fill('Новый партнёр');
  await page.getByRole('button', { name: 'Добавить партнёра', exact: true }).click();
  const form = page.getByRole('region', { name: 'Новый партнёр', exact: true });
  await form.getByLabel('IS_MAV', { exact: true }).selectOption('0');
  await form.getByLabel(/^SPREADING/).selectOption('1');
  await form.getByLabel('IS_KSS', { exact: true }).selectOption('1');
  const write = page.waitForRequest('**/api/processing-settings/partners');
  await page.getByRole('button', { name: 'Сохранить настройки партнёров', exact: true }).click();
  expect((await write).postDataJSON().profiles['Новый партнёр']).toEqual({
    INTERNAL_OPERATOR_NAME: '', IS_MAV: '0', SPREADING: '1', IS_KSS: '1',
  });
  await expect(page.getByText('Настройки партнёров сохранены. Они применятся к новым исходным файлам.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'Маркировка', exact: true }).click();
  await expect(page.locator('#upload-partner option', { hasText: 'Новый партнёр' })).toHaveCount(1);
});
