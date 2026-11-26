import { expect, test } from '@playwright/test';

// Presentation fixture only: these checks do not claim persistence or backend authorization.
for (const width of [390, 1440]) test(`legacy HUB separates titles, actions and its table at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/session', route => route.fulfill({ json: {
    authenticated: true, csrf_token: 'geometry-only',
    user: { id: 'geometry-reader', username: 'geometry-reader', permissions: ['case.read'] },
  } }));
  await page.route('**/api/cases?*', route => route.fulfill({ json: { items: [], next_cursor: null } }));
  await page.route('**/api/cases', route => route.fulfill({ json: { items: [{
    id: 'geometry-case', title: 'Заявка с длинным именем '.repeat(8), head_revision_id: null,
    external_state: 'UNKNOWN', created_at: '2026-10-14T12:00:00Z', revision: null,
  }], next_cursor: null } }));
  await page.goto('/?view=legacy');
  await expect(page.getByRole('table', { name: 'Сохранённые заявки', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Новая заявка', exact: true })).toBeDisabled();
  const geometry = await page.evaluate(() => {
    const source = document.querySelector<HTMLElement>('[data-form="source"]')!;
    const heading = document.getElementById(source.getAttribute('aria-labelledby')!)!;
    const table = document.querySelector<HTMLElement>('table[aria-label="Сохранённые заявки"]')!;
    const tableRegion = table.closest<HTMLElement>('.table-region')!;
    const tableTitle = [...document.querySelectorAll<HTMLElement>('.table-title')].find(node => node.textContent === 'Сохранённые заявки')!;
    const toolbar = document.querySelector<HTMLElement>('.progressive-toolbar')!;
    const actions = document.querySelector<HTMLElement>('[aria-labelledby="case-title"] > .action-strip')!;
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      sourceContainer: getComputedStyle(source).containerType,
      externalHeading: !source.contains(heading) && heading.getBoundingClientRect().bottom <= source.getBoundingClientRect().top,
      externalTableTitle: !tableRegion.contains(tableTitle) && tableTitle.getBoundingClientRect().bottom <= toolbar.getBoundingClientRect().top,
      externalFilter: !tableRegion.contains(toolbar) && toolbar.getBoundingClientRect().bottom <= tableRegion.getBoundingClientRect().top,
      nestedSurface: !!table.closest('.form-section'),
      internalScroll: getComputedStyle(tableRegion).overflowY,
      separateActions: !tableRegion.contains(actions) && !actions.contains(table),
    };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.sourceContainer).toBe('inline-size');
  expect(geometry.externalHeading).toBe(true);
  expect(geometry.externalTableTitle).toBe(true);
  expect(geometry.externalFilter).toBe(true);
  expect(geometry.nestedSurface).toBe(false);
  expect(geometry.internalScroll).toBe('auto');
  expect(geometry.separateActions).toBe(true);
});
