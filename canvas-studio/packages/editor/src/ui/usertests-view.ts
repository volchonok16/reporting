// «Прототип → Тестирование на людях…» (as Maze, Lyssna): tests of the file on the left; on the right either
// a new test (tasks: what to do, the start screen, the goal screen) or a test's results — its link, how many
// reached the goal, the usual time, taps that hit nothing, where people stopped, the common ways through and
// a heat map of taps over each screen. The prototype of a test is the file as it was when the test was made.

import { apply } from '#geometry';
import { deserialize, locale, plural, tr, type Document, type NodeId } from '#core';
import { SceneGraph, type Canvas2DRenderer } from '#render';
import { CloudError, userTests, type TestSession, type UserTestInfo } from '../cloud.ts';
import { shownPageBackground, type Editor } from '../editor.ts';
import { screens } from '../prototype/model.ts';
import { taskStats, tapsOn } from '../prototype/test-stats.ts';
import { askConfirm } from './dialog.ts';
import { h, icon, skeletonRows } from './dom.ts';

export interface UserTestsHost {
  editor: Editor;
  renderer: Canvas2DRenderer;
  fileId: string;
  toast(text: string, kind?: 'error'): void;
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)} %` : '—');
const seconds = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? tr('{0} с', (ms / 1000).toLocaleString(locale(), { maximumFractionDigits: ms < 10_000 ? 1 : 0 })) : tr('{0} мин {1} с', Math.floor(ms / 60_000), Math.round((ms % 60_000) / 1000)));
const answers = (n: number) => `${n} ${plural(n, tr('ответ'), tr('ответа'), tr('ответов'))}`;
const message = (error: unknown) => (error instanceof CloudError || error instanceof Error ? error.message : String(error));

/** Heat colours from cold to hot; the alpha of the sum picks one. */
const RAMP: [number, number, number][] = [
  [37, 99, 235],
  [16, 185, 129],
  [250, 204, 21],
  [249, 115, 22],
  [220, 38, 38],
];

function rampAt(v: number): [number, number, number] {
  const p = Math.min(1, Math.max(0, v)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(p));
  const f = p - i;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** The screen fitted into the canvas with the heat of `taps` over it (points in the screen's own units). */
export function drawHeat(canvas: HTMLCanvasElement, doc: Document, pageId: NodeId, screen: NodeId, renderer: Canvas2DRenderer, taps: readonly { x: number; y: number }[]): void {
  const width = canvas.clientWidth || 400;
  const height = canvas.clientHeight || 400;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx || !doc.store.isAlive(screen)) return;
  const bg = shownPageBackground(doc.get(pageId, 'backgroundColor'));
  ctx.fillStyle = `rgb(${bg.r * 255} ${bg.g * 255} ${bg.b * 255})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scene = new SceneGraph(doc, pageId);
  const origin = apply(scene.world(screen), { x: 0, y: 0 });
  const w = Number(doc.get(screen, 'width')) || 1;
  const hh = Number(doc.get(screen, 'height')) || 1;
  const pad = 16;
  const k = Math.min((width - pad * 2) / w, (height - pad * 2) / hh, 2);
  const left = (width - w * k) / 2;
  const top = (height - hh * k) / 2;
  ctx.save();
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (left - origin.x * k), dpr * (top - origin.y * k));
  ctx.beginPath();
  ctx.rect(origin.x, origin.y, w, hh);
  ctx.clip();
  renderer.renderNode(ctx, scene, screen, { x: origin.x, y: origin.y, width: w, height: hh }, k * dpr);
  ctx.restore();
  if (taps.length === 0) return;
  // The sum of soft spots, then coloured by how much piled up at each pixel.
  const heat = document.createElement('canvas');
  heat.width = canvas.width;
  heat.height = canvas.height;
  const hc = heat.getContext('2d', { willReadFrequently: true });
  if (!hc) return;
  const r = Math.max(14, 28 * k) * dpr;
  const strength = Math.min(0.5, Math.max(0.08, 3 / Math.sqrt(taps.length)));
  for (const t of taps) {
    const x = (left + t.x * k) * dpr;
    const y = (top + t.y * k) * dpr;
    const g = hc.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(0,0,0,${strength})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    hc.fillStyle = g;
    hc.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const img = hc.getImageData(0, 0, heat.width, heat.height);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]! / 255;
    if (a === 0) continue;
    const [cr, cg, cb] = rampAt(a);
    px[i] = cr;
    px[i + 1] = cg;
    px[i + 2] = cb;
    px[i + 3] = Math.min(220, 60 + a * 200);
  }
  hc.putImageData(img, 0, 0);
  ctx.drawImage(heat, 0, 0);
}

export class UserTestsView {
  private readonly host: UserTestsHost;
  private readonly overlay: HTMLElement;
  private readonly list: HTMLElement;
  private readonly main: HTMLElement;
  private tests: UserTestInfo[] = [];
  private selected: string | null = null;
  private readonly previousOnLoad: (hash: string) => void;
  private redraw: (() => void) | null = null;
  private readonly resize = new ResizeObserver(() => this.redraw?.());

  constructor(host: UserTestsHost) {
    this.host = host;
    this.list = h('div', { class: 'versions-list', 'aria-label': tr('Тесты') });
    this.main = h('div', { class: 'versions-main utests-main' });
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    this.overlay = h(
      'div',
      { class: 'versions-view utests-view', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Тестирование на людях') },
      h('header', { class: 'versions-header' }, h('h2', {}, tr('Тестирование на людях')), h('span', { class: 'crop-spacer' }), close),
      h('div', { class: 'versions-body' }, this.list, this.main),
    );
    this.overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !(e.target instanceof HTMLSelectElement)) this.close();
    });
    this.previousOnLoad = host.renderer.images.onLoad;
    host.renderer.images.onLoad = (hash) => {
      this.previousOnLoad(hash);
      this.redraw?.();
    };
    document.body.append(this.overlay);
    close.focus();
    this.list.append(skeletonRows(tr('Загружаю тесты'), 3));
    void this.load();
  }

  close(): void {
    this.host.renderer.images.onLoad = this.previousOnLoad;
    this.resize.disconnect();
    this.overlay.remove();
  }

  private async load(): Promise<void> {
    try {
      this.tests = await userTests.list(this.host.fileId);
    } catch (error) {
      this.list.replaceChildren(h('p', { class: 'hint' }, message(error)));
      return;
    }
    this.fillList();
    if (this.tests[0]) void this.show(this.tests[0].id);
    else this.compose();
  }

  private fillList(): void {
    const add = h('button', { class: 'text-button utests-new', type: 'button', onclick: () => this.compose() }, icon('plus'), tr('Новый тест'));
    const rows = this.tests.map((t) =>
      h(
        'button',
        { class: `versions-row named${t.id === this.selected ? ' active' : ''}`, type: 'button', onclick: () => void this.show(t.id) },
        h('span', { class: 'versions-name' }, t.name),
        h('span', { class: 'versions-meta' }, `${answers(t.sessions)}${t.open ? '' : ` · ${tr('закрыт')}`}`),
      ),
    );
    this.list.replaceChildren(add, ...rows);
  }

  // ---------- a new test ----------

  private compose(): void {
    this.selected = null;
    this.redraw = null;
    this.fillList();
    const editor = this.host.editor;
    const doc = editor.doc;
    const pageId = editor.pageId;
    const list = screens(doc, pageId);
    if (list.length < 2) {
      this.main.replaceChildren(h('p', { class: 'hint' }, tr('Нужны хотя бы два экрана на странице: начало и цель.')));
      return;
    }
    const screenSelect = (value: NodeId | undefined) => {
      const s = h('select', { class: 'field-select' }, ...list.map((id) => h('option', { value: id }, String(doc.get(id, 'name')))));
      if (value) s.value = value;
      return s;
    };
    const start = editor.prototype.startScreen() ?? list[0]!;
    const name = h('input', { class: 'dialog-input', type: 'text', value: tr('Тест {0}', this.tests.length + 1), maxLength: 120 });
    const rows = h('div', { class: 'utests-tasks' });
    const addRow = () => {
      const text = h('textarea', { class: 'dialog-input utests-text', rows: 2, maxLength: 500, placeholder: tr('Например: найдите, где оплатить заказ') });
      const from = screenSelect(start);
      const goal = screenSelect(list.find((id) => id !== start));
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить задание'), 'aria-label': tr('Удалить задание') }, icon('close'));
      const row = h(
        'div',
        { class: 'utests-task' },
        h('span', { class: 'utests-num' }),
        h('div', { class: 'utests-task-body' }, text, h('div', { class: 'utests-screens' }, h('label', {}, h('span', {}, tr('Начало')), from), h('label', {}, h('span', {}, tr('Цель')), goal))),
        remove,
      );
      remove.addEventListener('click', () => {
        if (rows.children.length > 1) row.remove();
        number();
      });
      rows.append(row);
      number();
      text.focus();
    };
    const number = () => [...rows.children].forEach((r, i) => ((r.querySelector('.utests-num') as HTMLElement).textContent = String(i + 1)));
    const error = h('p', { class: 'dialog-error', role: 'alert' });
    const create = h('button', { class: 'text-button primary', type: 'button' }, tr('Создать'));
    create.addEventListener('click', async () => {
      const tasks = [...rows.children].map((r) => {
        const [from, goal] = [...r.querySelectorAll('select')];
        return { text: (r.querySelector('textarea') as HTMLTextAreaElement).value.trim(), start: from!.value, goals: [goal!.value] };
      });
      const empty = tasks.findIndex((t) => !t.text);
      if (empty >= 0) return void (error.textContent = tr('Задание {0}: напишите, что нужно сделать', empty + 1));
      const same = tasks.findIndex((t) => t.goals[0] === t.start);
      if (same >= 0) return void (error.textContent = tr('Задание {0}: цель совпадает с началом', same + 1));
      create.disabled = true;
      try {
        const test = await userTests.create(this.host.fileId, { name: name.value.trim() || tr('Тест'), pageId, tasks });
        this.tests.unshift(test);
        await this.show(test.id);
      } catch (e) {
        error.textContent = message(e);
        create.disabled = false;
      }
    });
    this.main.replaceChildren(
      h('h3', { class: 'utests-heading' }, tr('Новый тест')),
      h('label', { class: 'dialog-field' }, h('span', {}, tr('Название')), name),
      rows,
      h('button', { class: 'text-button utests-add', type: 'button', onclick: () => addRow() }, icon('plus'), tr('Задание')),
      h('p', { class: 'hint' }, tr('Прототип сохранится таким, как сейчас: правки файла тест не изменят.')),
      error,
      h('div', { class: 'utests-actions' }, create),
    );
    addRow();
    name.focus();
    name.select();
  }

  // ---------- results ----------

  private async show(id: string): Promise<void> {
    this.selected = id;
    this.redraw = null;
    this.fillList();
    this.main.replaceChildren(skeletonRows(tr('Загружаю ответы'), 4, true));
    let data: { test: UserTestInfo; sessions: TestSession[]; snapshot: string };
    try {
      data = await userTests.results(this.host.fileId, id);
    } catch (error) {
      if (this.selected === id) this.main.replaceChildren(h('p', { class: 'hint' }, message(error)));
      return;
    }
    if (this.selected !== id) return;
    this.replaceTest(data.test);
    const doc = deserialize(data.snapshot);
    this.renderResults(data.test, data.sessions, doc);
  }

  private replaceTest(test: UserTestInfo): void {
    this.tests = this.tests.map((t) => (t.id === test.id ? test : t));
    this.fillList();
  }

  private renderResults(test: UserTestInfo, sessions: TestSession[], doc: Document): void {
    const nameOf = (id: string) => (doc.store.isAlive(id) ? String(doc.get(id, 'name')) : '?');
    const url = userTests.link(this.host.fileId, test.token);
    const link = h('input', { class: 'dialog-input utests-link', type: 'text', value: url, readOnly: true, 'aria-label': tr('Ссылка на тест') });
    link.addEventListener('focus', () => link.select());
    const copy = h('button', { class: 'text-button', type: 'button' }, tr('Копировать'));
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(url).then(
        () => this.host.toast(tr('Ссылка скопирована')),
        () => link.select(),
      );
    });
    const open = h('input', { type: 'checkbox', checked: test.open });
    open.addEventListener('change', async () => {
      try {
        this.replaceTest(await userTests.change(this.host.fileId, test.id, { open: open.checked }));
      } catch (error) {
        open.checked = !open.checked;
        this.host.toast(message(error), 'error');
      }
    });
    const remove = h('button', { class: 'text-button', type: 'button' }, tr('Удалить'));
    remove.addEventListener('click', async () => {
      if (!(await askConfirm({ title: tr('Удалить тест «{0}»?', test.name), message: tr('Ответы удалятся вместе с ним.'), confirm: tr('Удалить'), danger: true }))) return;
      try {
        await userTests.remove(this.host.fileId, test.id);
        this.tests = this.tests.filter((t) => t.id !== test.id);
        if (this.tests[0]) void this.show(this.tests[0].id);
        else this.compose();
      } catch (error) {
        this.host.toast(message(error), 'error');
      }
    });
    const head = h(
      'div',
      { class: 'utests-head' },
      h('h3', { class: 'utests-heading' }, test.name),
      h('span', { class: 'versions-summary' }, answers(test.sessions)),
      h('span', { class: 'crop-spacer' }),
      h('label', { class: 'checkbox' }, open, h('span', {}, tr('Принимать ответы'))),
      remove,
    );
    const body = h('div', { class: 'utests-result' });
    const tabs = h('div', { class: 'segmented utests-tabs', role: 'tablist', 'aria-label': tr('Задания') });
    const pick = (i: number) => {
      [...tabs.children].forEach((b, j) => {
        b.classList.toggle('active', i === j);
        b.setAttribute('aria-selected', String(i === j));
      });
      this.renderTask(body, test, sessions, doc, i, nameOf);
    };
    test.tasks.forEach((_t, i) => tabs.append(h('button', { class: 'segment', type: 'button', role: 'tab', onclick: () => pick(i) }, tr('Задание {0}', i + 1))));
    this.main.replaceChildren(head, h('div', { class: 'utests-share' }, link, copy), ...(test.tasks.length > 1 ? [tabs] : []), body);
    pick(0);
  }

  private renderTask(body: HTMLElement, test: UserTestInfo, sessions: TestSession[], doc: Document, index: number, nameOf: (id: string) => string): void {
    const task = test.tasks[index]!;
    const s = taskStats(sessions, task.id);
    const tile = (value: string, label: string) => h('div', { class: 'utests-tile' }, h('strong', {}, value), h('span', {}, label));
    const tiles = h(
      'div',
      { class: 'utests-tiles' },
      tile(percent(s.done, s.total), tr('дошли до цели')),
      tile(seconds(s.medianMs), tr('обычное время')),
      tile(s.misses === null ? '—' : percent(s.misses, 1), tr('нажатий мимо')),
      tile(`${s.gaveup} / ${s.left}`, tr('сдались / ушли')),
    );
    const route = (path: string[]) => path.map(nameOf).join(' → ');
    const facts: HTMLElement[] = [];
    if (s.stops.length) facts.push(h('div', { class: 'utests-fact' }, h('span', { class: 'utests-label' }, tr('Где бросили')), h('span', {}, s.stops.map((x) => `«${nameOf(x.screen)}» — ${x.n}`).join(', '))));
    if (s.paths.length)
      facts.push(
        h(
          'div',
          { class: 'utests-fact' },
          h('span', { class: 'utests-label' }, tr('Пути')),
          h('ol', { class: 'utests-paths' }, ...s.paths.map((p) => h('li', {}, h('span', { class: 'utests-path' }, route(p.path)), h('span', { class: 'utests-count' }, `${p.n}${p.done === p.n ? ' ✓' : ''}`)))),
        ),
      );
    // The heat map: the screens tapped on in this task (the start first when nobody tapped yet).
    const shown = [...new Set([...s.screens.map((x) => x.screen), task.start, ...task.goals])].filter((id) => doc.store.isAlive(id));
    const select = h('select', { class: 'field-select', 'aria-label': tr('Экран') }, ...shown.map((id) => h('option', { value: id }, nameOf(id))));
    const missesOnly = h('input', { type: 'checkbox' });
    const canvas = h('canvas', { class: 'versions-canvas utests-heat', 'aria-label': tr('Тепловая карта нажатий') });
    const count = h('span', { class: 'versions-summary' });
    const draw = () => {
      const all = tapsOn(sessions, task.id, select.value);
      const taps = missesOnly.checked ? all.filter((t) => !t.hit) : all;
      count.textContent = `${taps.length} ${plural(taps.length, tr('нажатие'), tr('нажатия'), tr('нажатий'))}`;
      drawHeat(canvas, doc, test.pageId, select.value, this.host.renderer, taps);
    };
    select.addEventListener('change', draw);
    missesOnly.addEventListener('change', draw);
    body.replaceChildren(
      h('p', { class: 'utests-task-text' }, task.text, h('span', { class: 'utests-goal' }, ` · «${nameOf(task.start)}» → «${task.goals.map(nameOf).join('», «')}»`)),
      s.total ? tiles : h('p', { class: 'hint' }, tr('Ответов пока нет. Отправьте ссылку людям.')),
      ...facts,
      h('div', { class: 'versions-tools' }, select, h('label', { class: 'checkbox' }, missesOnly, h('span', {}, tr('Только мимо'))), h('span', { class: 'crop-spacer' }), count),
      canvas,
    );
    this.redraw = draw;
    this.resize.disconnect();
    this.resize.observe(canvas);
    requestAnimationFrame(draw);
  }
}
