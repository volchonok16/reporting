// The report of «Проверка по дизайн-системе» over the canvas (step 6): the share of values from the system, then
// the findings by kind — the layer (a click selects and shows it), what is off, and suggestions as buttons (≈ —
// close but not the same, the look changes a little). «Исправить всё точное» puts every exact suggestion in, one
// undo step. The panel stays while layers are clicked; it checks again after each fix.

import { colorToHex, tr, type NodeId } from '#core';
import type { Editor } from '../editor.ts';
import { applyFix, checkDesign, fixAll, KIND_LABELS, type CheckKind, type Finding, type Report } from '../design-check.ts';
import { h, icon } from './dom.ts';

const ORDER: CheckKind[] = ['unbound', 'color', 'text', 'number', 'effect', 'orphan'];
/** Findings shown per kind before «ещё N». */
const SHOWN = 40;

export class DesignCheckPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private roots: NodeId[] = [];
  private report: Report | null = null;
  private expanded = new Set<CheckKind>();

  constructor(editor: Editor) {
    this.editor = editor;
    this.el = h('aside', { class: 'check-panel', hidden: true, 'aria-label': tr('Проверка по дизайн-системе') });
    editor.events.on('page', () => this.close());
  }

  /** Checks the selection (or the page, when nothing is selected) and shows the report. */
  open(): void {
    this.roots = this.editor.selection.length ? this.editor.topLevelSelection() : [];
    this.expanded.clear();
    this.run();
    this.el.hidden = false;
  }

  close(): void {
    this.el.hidden = true;
    this.report = null;
  }

  private run(): void {
    this.roots = this.roots.filter((id) => this.editor.doc.store.isAlive(id));
    this.report = checkDesign(this.editor, this.roots.length ? this.roots : undefined);
    this.render();
  }

  private render(): void {
    const r = this.report!;
    const d = this.editor.doc;
    const share = r.checked ? Math.round((r.fromSystem / r.checked) * 100) : 100;
    const exactCount = r.findings.filter((f) => f.suggestions[0]?.exact && (f.kind !== 'unbound' || f.suggestions.length === 1)).length;
    const head = h(
      'header',
      { class: 'check-head' },
      h('h2', {}, tr('Проверка по дизайн-системе')),
      h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close', 14)),
    );
    const scope = this.roots.length ? tr('Выделено слоёв: {0}', this.roots.length) : tr('Вся страница');
    const summary = h(
      'div',
      { class: 'check-summary' },
      h('div', { class: 'check-score' }, h('strong', {}, `${share}%`), h('span', {}, tr('значений из системы — {0} из {1}', r.fromSystem, r.checked))),
      h('div', { class: 'check-bar', role: 'meter', 'aria-valuenow': String(share), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': tr('Доля значений из системы') }, h('span', { style: `width:${share}%` })),
      h('p', { class: 'hint small' }, scope),
      h(
        'div',
        { class: 'button-row' },
        h('button', { class: 'text-button', type: 'button', onclick: () => this.run() }, icon('reset', 14), h('span', {}, tr('Проверить снова'))),
        ...(exactCount && !d.readOnly
          ? [h('button', { class: 'text-button primary', type: 'button', title: tr('Привязать точные совпадения. Близкие выбираются вручную'), onclick: () => this.fixEverything() }, tr('Исправить точное ({0})', exactCount))]
          : []),
      ),
    );
    const body = h('div', { class: 'check-body' });
    if (!r.hasSystem) body.append(h('p', { class: 'hint' }, tr('В файле нет переменных и стилей. Создайте их или подключите библиотеку.')));
    else if (r.findings.length === 0) body.append(h('p', { class: 'hint' }, tr('Всё из дизайн-системы, замечаний нет.')));
    for (const kind of ORDER) {
      const list = r.findings.filter((f) => f.kind === kind);
      if (!list.length) continue;
      const group = h('section', { class: 'check-group' }, h('h3', {}, `${KIND_LABELS[kind]} · ${list.length}`));
      const shown = this.expanded.has(kind) ? list : list.slice(0, SHOWN);
      for (const f of shown) group.append(this.row(f));
      if (shown.length < list.length) {
        group.append(h('button', { class: 'text-button', type: 'button', onclick: () => (this.expanded.add(kind), this.render()) }, tr('Ещё {0}', list.length - shown.length)));
      }
      body.append(group);
    }
    this.el.replaceChildren(head, summary, body);
  }

  private row(f: Finding): HTMLElement {
    const d = this.editor.doc;
    const alive = d.store.isAlive(f.id);
    const name = h('button', { class: 'check-layer', type: 'button', title: tr('Выделить и показать слой'), disabled: !alive, onclick: () => this.show(f.id) }, alive ? d.get(f.id, 'name') : tr('слой удалён'));
    const swatch = f.color ? h('span', { class: 'check-swatch', style: `background:${colorToHex(f.color, f.color.a < 1)}` }) : null;
    const fixes = h('div', { class: 'check-fixes' });
    for (const s of f.suggestions) {
      fixes.append(
        h('button', { class: `check-fix${s.exact ? '' : ' near'}`, type: 'button', disabled: d.readOnly || !alive, title: s.exact ? tr('Взять из системы — значение не изменится') : tr('Близкое значение из системы, вид немного изменится'), onclick: () => this.fix(f, s.fix) }, s.exact ? '→ ' : '≈ ', s.label),
      );
    }
    if (!f.suggestions.length) fixes.append(h('span', { class: 'hint small' }, tr('Нет подходящего')));
    return h('div', { class: 'check-row' }, h('div', { class: 'check-what' }, ...(swatch ? [swatch] : []), name, h('span', { class: 'check-value' }, `${f.what}: ${f.now}`)), fixes);
  }

  private show(id: NodeId): void {
    const page = this.editor.doc.pageOf(id);
    if (page && page !== this.editor.pageId) this.editor.setPage(page);
    this.editor.setSelection([id]);
    // Left of the panel, no closer than 200 % (a small layer is not blown up).
    const covered = this.el.offsetWidth ? this.el.offsetWidth + 24 : 0;
    this.editor.zoomToSelection({ maxZoom: 2, rightInset: covered });
  }

  private fix(f: Finding, fix: Finding['suggestions'][number]['fix']): void {
    this.editor.commit(tr('Исправить по дизайн-системе'), (tx) => applyFix(this.editor, tx, f, fix));
    this.run();
  }

  private fixEverything(): void {
    const n = fixAll(this.editor, this.report!.findings);
    this.editor.toast(tr('Исправлено: {0}', n));
    this.run();
  }
}
