// «Проверка доступности» over the canvas (FEAT-222): findings by kind — the layer (a click selects and shows it)
// and what is off; low contrast is fixed one by one or all at once (one undo step). Below — the reading order of a
// frame for a screen reader, numbered on the canvas while the panel is open, and a switch of how the canvas looks
// to a person with colour blindness. Checks again after each fix and on «Проверить снова».

import { plural, tr, type NodeId } from '#core';
import type { Editor } from '../editor.ts';
import { A11Y_KIND_LABELS, checkAccessibility, readingSteps, TARGET_SIZES, type A11yCheckKind, type A11yFinding, type A11yReport } from '../a11y-check.ts';
import { fixContrastIssues } from '../smart-ops.ts';
import { VISIONS, type Vision } from '../vision.ts';
import { h, icon } from './dom.ts';

const ORDER: A11yCheckKind[] = ['contrast', 'small', 'target', 'image'];
const SHOWN = 40;
const TARGET_KEY = 'cs-a11y-target';

function savedTarget(): number {
  try {
    const v = Number(localStorage.getItem(TARGET_KEY));
    return TARGET_SIZES.some(([s]) => s === v) ? v : 44;
  } catch {
    return 44;
  }
}

export class A11yPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private roots: NodeId[] = [];
  private report: A11yReport | null = null;
  private expanded = new Set<A11yCheckKind>();
  private target = savedTarget();
  /** The frame whose reading order is shown. */
  private frame: NodeId | null = null;

  constructor(editor: Editor) {
    this.editor = editor;
    this.el = h('aside', { class: 'check-panel', hidden: true, 'aria-label': tr('Проверка доступности') });
    editor.events.on('page', () => this.close());
    // The way of seeing switched from the canvas bar or the menu: the panel's list follows.
    editor.events.on('view', () => {
      const sel = this.el.querySelector<HTMLSelectElement>('.check-vision');
      if (sel && !this.el.hidden) sel.value = editor.view.vision;
    });
  }

  /** Checks the selection (or the page, when nothing is selected) and shows the report. */
  open(): void {
    this.roots = this.editor.selection.length ? this.editor.topLevelSelection() : [];
    this.frame = this.pickFrame();
    this.expanded.clear();
    this.el.hidden = false;
    this.run();
  }

  close(): void {
    this.el.hidden = true;
    this.report = null;
    this.editor.setReadingMarks([]);
  }

  /** A top-level frame of the selection, else the first frame of the page. */
  private pickFrame(): NodeId | null {
    const d = this.editor.doc;
    const top = (id: NodeId) => {
      let n = id;
      for (let p = d.parent(n); p && p !== this.editor.pageId && d.type(p) !== 'SECTION'; p = d.parent(n)) n = p;
      return n;
    };
    const frames = (this.roots.length ? this.roots.map(top) : [...d.children(this.editor.pageId)]).filter((id) => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(d.type(id)));
    return frames[0] ?? null;
  }

  private run(): void {
    const d = this.editor.doc;
    this.roots = this.roots.filter((id) => d.store.isAlive(id));
    if (this.frame && !d.store.isAlive(this.frame)) this.frame = this.pickFrame();
    this.report = checkAccessibility(this.editor, this.roots.length ? this.roots : undefined, this.target);
    this.render();
  }

  private render(): void {
    const r = this.report!;
    const d = this.editor.doc;
    const fixable = r.findings.filter((f) => f.contrast?.fix);
    const head = h(
      'header',
      { class: 'check-head' },
      h('h2', {}, tr('Проверка доступности')),
      h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close', 14)),
    );
    const sizes = h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-label': tr('Область нажатия не меньше') },
      ...TARGET_SIZES.map(([s, who]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(s === this.target), class: s === this.target ? 'segment active' : 'segment', title: who, onclick: () => this.setTarget(s) }, String(s)),
      ),
    );
    const summary = h(
      'div',
      { class: 'check-summary' },
      h('div', { class: 'check-score' }, h('strong', {}, String(r.findings.length)), h('span', {}, r.findings.length ? plural(r.findings.length, 'замечание', 'замечания', 'замечаний') : tr('замечаний нет'))),
      h('p', { class: 'hint small' }, this.roots.length ? tr('Выделено слоёв: {0}', this.roots.length) : tr('Вся страница')),
      h('div', { class: 'check-option' }, h('span', { class: 'hint small' }, tr('Нажатие, px')), sizes),
      h(
        'div',
        { class: 'button-row' },
        h('button', { class: 'text-button', type: 'button', onclick: () => this.run() }, icon('reset', 14), h('span', {}, tr('Проверить снова'))),
        ...(fixable.length && !d.readOnly ? [h('button', { class: 'text-button primary', type: 'button', onclick: () => this.fixContrast(fixable) }, tr('Исправить контраст ({0})', fixable.length))] : []),
      ),
    );
    const body = h('div', { class: 'check-body' });
    for (const kind of ORDER) {
      const list = r.findings.filter((f) => f.kind === kind);
      if (!list.length) continue;
      const group = h('section', { class: 'check-group' }, h('h3', {}, `${A11Y_KIND_LABELS[kind]} · ${list.length}`));
      const shown = this.expanded.has(kind) ? list : list.slice(0, SHOWN);
      for (const f of shown) group.append(this.row(f));
      if (shown.length < list.length) group.append(h('button', { class: 'text-button', type: 'button', onclick: () => (this.expanded.add(kind), this.render()) }, tr('Ещё {0}', list.length - shown.length)));
      body.append(group);
    }
    body.append(this.readingSection(), this.visionSection());
    this.el.replaceChildren(head, summary, body);
  }

  private row(f: A11yFinding): HTMLElement {
    const d = this.editor.doc;
    const alive = d.store.isAlive(f.id);
    const name = h('button', { class: 'check-layer', type: 'button', title: tr('Выделить и показать слой'), disabled: !alive, onclick: () => this.show(f.id) }, alive ? d.get(f.id, 'name') : tr('слой удалён'));
    const fixes = h('div', { class: 'check-fixes' });
    if (f.contrast?.fix) fixes.append(h('button', { class: 'check-fix', type: 'button', disabled: d.readOnly || !alive, onclick: () => this.fixContrast([f]) }, tr('Исправить')));
    else if (f.kind === 'contrast') fixes.append(h('span', { class: 'hint small' }, tr('Цвет из переменной или стиля')));
    return h('div', { class: 'check-row' }, h('div', { class: 'check-what' }, name, h('span', { class: 'check-value' }, f.now)), fixes);
  }

  private readingSection(): HTMLElement {
    const d = this.editor.doc;
    const section = h('section', { class: 'check-group' });
    const frames = [...d.children(this.editor.pageId)].filter((id) => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(d.type(id)));
    if (!this.frame) {
      this.editor.setReadingMarks([]);
      section.append(h('h3', {}, tr('Порядок чтения')), h('p', { class: 'hint small' }, tr('Нет фреймов на странице')));
      return section;
    }
    const steps = readingSteps(this.editor, this.frame);
    this.editor.setReadingMarks(steps.map((s) => s.item.id));
    const pick = h(
      'select',
      { class: 'check-frame', 'aria-label': tr('Фрейм'), onchange: (ev: Event) => ((this.frame = (ev.target as HTMLSelectElement).value as NodeId), this.render()) },
      ...frames.map((id) => h('option', { value: id, selected: id === this.frame }, d.get(id, 'name'))),
    );
    section.append(h('h3', {}, `${tr('Порядок чтения')} · ${steps.length}`), pick);
    if (!steps.length) section.append(h('p', { class: 'hint small' }, tr('Диктору нечего читать')));
    const list = h('ol', { class: 'check-order' });
    for (const s of steps.slice(0, 200)) {
      list.append(h('li', {}, h('button', { class: 'check-layer', type: 'button', onclick: () => this.show(s.item.id) }, s.said || d.get(s.item.id, 'name'))));
    }
    section.append(list, h('p', { class: 'hint small' }, tr('Порядок меняется на вкладке «Прототип»: роль слоя, «Не читать», адаптивная раскладка')));
    return section;
  }

  private visionSection(): HTMLElement {
    const v = this.editor.view.vision;
    return h(
      'section',
      { class: 'check-group' },
      h('h3', {}, tr('Как видит человек')),
      h(
        'select',
        { class: 'check-frame check-vision', 'aria-label': tr('Как видит человек'), onchange: (ev: Event) => this.editor.setView({ vision: (ev.target as HTMLSelectElement).value as Vision }) },
        ...VISIONS.map(([k, label]) => h('option', { value: k, selected: k === v }, label)),
      ),
    );
  }

  private setTarget(size: number): void {
    this.target = size;
    try {
      localStorage.setItem(TARGET_KEY, String(size));
    } catch {
      /* the choice lasts this session */
    }
    this.run();
  }

  private show(id: NodeId): void {
    const page = this.editor.doc.pageOf(id);
    if (page && page !== this.editor.pageId) this.editor.setPage(page);
    this.editor.setSelection([id]);
    const covered = this.el.offsetWidth ? this.el.offsetWidth + 24 : 0;
    this.editor.zoomToSelection({ maxZoom: 2, rightInset: covered });
  }

  private fixContrast(list: readonly A11yFinding[]): void {
    const n = fixContrastIssues(this.editor, list.map((f) => f.contrast!));
    if (n) this.editor.toast(tr('Исправлено: {0}', n));
    this.run();
  }
}
