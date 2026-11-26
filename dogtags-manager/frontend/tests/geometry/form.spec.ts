import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const widths = [320, 390, 768, 1024, 1440, 1920];

async function measure(page: Page, testInfo: TestInfo, name: string, form = 'catalog') {
  const section = page.locator(`[data-form="${form}"]`);
  await expect(section).toBeVisible();
  const layout = await section.evaluate((element) => {
    const grid = element.querySelector('.form-grid')!;
    const fields = [...grid.querySelectorAll<HTMLElement>('[data-field]')];
    const boxes = fields.map((field) => {
      const control = field.querySelector<HTMLElement>('[data-control]')!;
      const label = field.querySelector<HTMLElement>('.field-label')!;
      const support = field.querySelector<HTMLElement>('.field-support')!;
      const rect = control.getBoundingClientRect();
      return {
        id: control.id, top: rect.top, bottom: rect.bottom, left: rect.left,
        right: rect.right, height: rect.height, labelBottom: label.getBoundingClientRect().bottom,
        supportTop: support.getBoundingClientRect().top,
        supportBottom: support.getBoundingClientRect().bottom,
        fieldTop: field.getBoundingClientRect().top,
        rows: getComputedStyle(field).gridTemplateRows,
        containment: getComputedStyle(field).containerType,
      };
    });
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const rowDeltas = [];
    const leftDeltas = [];
    for (let index = 0; index < boxes.length; index += columns) {
      const row = boxes.slice(index, index + columns);
      rowDeltas.push({
        top: Math.max(...row.map((box) => box.top)) - Math.min(...row.map((box) => box.top)),
        bottom: Math.max(...row.map((box) => box.bottom)) - Math.min(...row.map((box) => box.bottom)),
      });
      for (let column = 0; column < row.length; column++) {
        if (index > 0) leftDeltas.push(Math.abs(row[column].left - boxes[column].left));
      }
    }
    return {
      browser: navigator.userAgent, viewport: innerWidth, deviceScale: devicePixelRatio,
      rootFont: getComputedStyle(document.documentElement).fontSize,
      columns, boxes, rowDeltas, leftDeltas,
      sectionContainment: getComputedStyle(element).containerType,
      gridContainment: getComputedStyle(grid).containerType,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  const evidencePath = testInfo.outputPath(`${name}.json`);
  await writeFile(evidencePath, JSON.stringify(layout, null, 2));
  await testInfo.attach(name, { path: evidencePath, contentType: 'application/json' });
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  expect(layout.sectionContainment).toBe('inline-size');
  expect(layout.gridContainment).toBe('normal');
  for (const delta of layout.rowDeltas) {
    expect(delta.top).toBeLessThanOrEqual(1);
    expect(delta.bottom).toBeLessThanOrEqual(1);
  }
  for (const delta of layout.leftDeltas) expect(delta).toBeLessThanOrEqual(1);
  for (const box of layout.boxes) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.top).toBeGreaterThanOrEqual(box.labelBottom);
    expect(box.supportTop).toBeGreaterThanOrEqual(box.bottom);
    expect(box.containment).toBe('normal');
    if (layout.columns === 2) expect(box.rows).toMatch(/^subgrid/);
  }
  for (let index = layout.columns; index < layout.boxes.length; index += layout.columns) {
    const prior = layout.boxes.slice(index - layout.columns, index);
    expect(layout.boxes[index].fieldTop).toBeGreaterThanOrEqual(Math.max(...prior.map((box) => box.supportBottom)));
  }
  return layout;
}

async function catalog(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto('/?view=catalog');
  await expect(page.getByRole('heading', { name: 'Каталог общих компонентов', exact: true })).toBeVisible();
}

for (const width of widths) {
  test(`form tracks, errors and control states at ${width}px`, async ({ page }, testInfo) => {
    await catalog(page, width);
    const initial = await measure(page, testInfo, 'errors');
    await page.locator('[data-form="catalog"]').screenshot({ path: testInfo.outputPath(`form-errors-${width}.png`) });
    await expect(page.locator('#inn')).toHaveValue('7,84201E+11');
    await expect(page.locator('#inn')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#inn')).toHaveAccessibleDescription(/Научная запись/);
    await expect(page.locator('#label-32-value')).toHaveText('А'.repeat(32));
    await expect(page.locator('#label-33-value')).toHaveText('Б'.repeat(33));
    await page.getByRole('button', { name: 'Скрыть ошибки в примере', exact: true }).click();
    await expect(page.locator('#inn')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#inn')).not.toHaveAttribute('aria-describedby', /inn-error/);
    await measure(page, testInfo, 'errors-removed');
    await page.getByRole('checkbox', { name: 'Текстовые поля только для чтения' }).check();
    await expect(page.locator('#inn')).toHaveAttribute('readonly', '');
    const readOnly = await measure(page, testInfo, 'readonly');
    for (let index = 0; index < initial.boxes.length; index++) {
      expect(readOnly.boxes[index].height).toBe(initial.boxes[index].height);
    }
    await page.getByRole('checkbox', { name: 'Поля недоступны' }).check();
    await expect(page.locator('#profile')).toBeDisabled();
    await measure(page, testInfo, 'disabled');
    const button = page.getByRole('button', { name: 'Проверить пример', exact: true });
    const before = await button.boundingBox();
    await page.getByRole('checkbox', { name: 'Показать ожидание кнопки' }).check();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    const busy = await button.boundingBox();
    expect(busy).toEqual(before);
    await page.locator('[data-form="catalog"] form').evaluate((form) => {
      form.addEventListener('submit', () => form.setAttribute('data-submit-observed', 'true'));
    });
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('[data-form="catalog"] form')).not.toHaveAttribute('data-submit-observed', 'true');
    await expect(page.getByText('Идёт проверка примера. Дождитесь завершения демонстрации.', { exact: true })).toBeVisible();
    await measure(page, testInfo, 'busy');
    await page.screenshot({ path: testInfo.outputPath(`catalog-${width}.png`), fullPage: true });
  });

  test(`200% root text and specified spacing at ${width}px`, async ({ page }, testInfo) => {
    await catalog(page, width);
    await page.addStyleTag({ content: `html { font-size: 200%; } * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-block-end: 2em !important; }` });
    await measure(page, testInfo, 'root-font-200-and-text-spacing');
    await expect(page.locator('#date')).toHaveAccessibleDescription(/2026-10-10/);
    await expect(page.locator('#encoding')).toHaveAccessibleDescription(/Windows-1251/);
    const content = page.locator('.field-label, .field-support, .button');
    expect(await content.evaluateAll((elements) => elements.every((element) => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1))).toBe(true);
    await page.getByRole('button', { name: 'Проверить пример', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Проверить пример', exact: true })).toBeInViewport();
    if (width === 320) await page.locator('[data-field="date"]').screenshot({ path: testInfo.outputPath('date-text-200.png') });
    await page.screenshot({ path: testInfo.outputPath(`text-200-${width}.png`), fullPage: true });
  });
}

test('narrow container at wide viewport', async ({ page }, testInfo) => {
  await catalog(page, 1920);
  const wide = await measure(page, testInfo, 'wide');
  expect(wide.columns).toBe(2);
  const narrow = await measure(page, testInfo, 'narrow', 'narrow');
  expect(narrow.columns).toBe(1);
});

test('single-column fallback without subgrid enhancement', async ({ page }, testInfo) => {
  await catalog(page, 1440);
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
        const rule = sheet.cssRules[index];
        if (rule instanceof CSSSupportsRule && rule.conditionText.includes('subgrid')) sheet.deleteRule(index);
      }
    }
  });
  const layout = await measure(page, testInfo, 'fallback');
  expect(layout.columns).toBe(1);
  expect(layout.boxes.every((box) => !box.rows.startsWith('subgrid'))).toBe(true);
});

test('keyboard order, visible focus and linked error summary', async ({ page }) => {
  await catalog(page, 1024);
  await page.locator('#profile').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#operator')).toBeFocused();
  const outline = await page.locator('#operator').evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).toBe('solid');
  await page.keyboard.press('Tab');
  await expect(page.locator('#inn')).toBeFocused();
  await page.getByRole('button', { name: 'Проверить пример', exact: true }).click();
  await expect(page.locator('#catalog-errors')).toBeFocused();
  await page.getByRole('link', { name: 'ИНН: научная запись вместо полных цифр' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#inn')).toBeFocused();
  await expect(page.locator('#inn')).toHaveAccessibleName('ИНН клиента (обязательно)');
  expect(await page.locator('[tabindex]').evaluateAll((elements) => elements.every((element) => Number(element.getAttribute('tabindex')) <= 0))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.locator('#spreading')).toBeFocused();
  await expect(page.locator('#spreading')).toHaveAccessibleName('Значение SPREADING');
  await expect(page.locator('#encoding')).toHaveAttribute('list', 'encoding-options');
  await page.locator('#encoding').fill('UTF-8');
  await expect(page.locator('#encoding')).toHaveValue('UTF-8');
  await expect(page.locator('#encoding')).toHaveAccessibleDescription(/Полное текущее значение: UTF-8/);
  await expect(page.locator('#date')).toHaveAttribute('type', 'date');
});

test('persistent alerts, semantic statuses and table states', async ({ page }) => {
  await catalog(page, 390);
  await expect(page.locator('#catalog-errors')).toBeVisible();
  await expect(page.locator('.status-badge').filter({ hasText: 'Файлы подготовлены' })).toHaveAttribute('data-tone', 'info');
  await expect(page.locator('.status-badge').filter({ hasText: 'Внешняя загрузка не подтверждена' })).toHaveAttribute('data-tone', 'neutral');
  await expect(page.locator('table')).toHaveCount(6);
  await expect(page.getByRole('columnheader', { name: /Столбец CSV/ }).first()).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.getByRole('row', { selected: true })).toHaveCount(1);
  await expect(page.getByText('Загрузка данных…', { exact: true })).toBeVisible();
  await expect(page.getByText('Записей пока нет.', { exact: true })).toBeVisible();
  await expect(page.getByText('По этому фильтру записей нет.', { exact: true })).toBeVisible();
  await expect(page.getByText('Сервис недоступен. Повторите загрузку данных.', { exact: true })).toBeVisible();
  await expect(page.getByText('Фильтр: строки с ошибками', { exact: true })).toBeVisible();
  await expect(page.locator('[role="grid"]')).toHaveCount(0);
});
