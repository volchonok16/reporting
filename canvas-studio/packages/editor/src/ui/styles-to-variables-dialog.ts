// «Стили → переменные…» (FR-STY-003): a preview of what each style becomes —
// the variables with their values, and what stays in the style — with a tick
// per style and the collection to put them in; one press converts.

import { colorToHex, isColorValue, plural, tr, type VariableLiteral } from '#core';
import type { Editor } from '../editor.ts';
import { convertStylesToVariables, planStylesToVariables } from '../styles-to-variables.ts';
import { h, icon } from './dom.ts';
import { valuePreview } from './variable-ui.ts';

const TYPE_LABELS = { FILL: tr('Цвет'), TEXT: tr('Текст'), EFFECT: tr('Эффект'), GRID: tr('Сетка') } as const;

function shown(v: VariableLiteral): string {
  if (isColorValue(v)) return colorToHex(v, v.a < 1);
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  return String(v);
}

export function openStylesToVariables(editor: Editor, toast: (message: string) => void, done?: (collection: string) => void): void {
  const plan = planStylesToVariables(editor.doc);
  const ticked = new Set(plan.filter((p) => p.variables.length > 0).map((p) => p.style));
  const close = () => overlay.remove();
  const collection = h('input', { class: 'field-input', type: 'text', value: tr('Стили'), spellcheck: false, 'aria-label': tr('Коллекция') });
  const apply = h('button', { class: 'text-button primary', type: 'button' }, tr('Преобразовать'));
  const sync = () => {
    const n = plan.filter((p) => ticked.has(p.style)).reduce((s, p) => s + p.variables.length, 0);
    apply.disabled = n === 0 || editor.doc.readOnly;
    apply.textContent = n ? tr('Преобразовать: {0} {1}', n, plural(n, tr('переменная'), tr('переменные'), tr('переменных'))) : tr('Преобразовать');
  };
  const rows = plan.map((p) => {
    const box = h('input', { type: 'checkbox', checked: ticked.has(p.style), disabled: p.variables.length === 0, 'aria-label': p.styleName });
    box.addEventListener('change', () => {
      if (box.checked) ticked.add(p.style);
      else ticked.delete(p.style);
      sync();
    });
    return h(
      'div',
      { class: 'sv-row' },
      h('label', { class: 'sv-style' }, box, h('strong', {}, p.styleName), h('span', { class: 'vars-muted' }, TYPE_LABELS[p.styleType])),
      p.variables.length
        ? h(
            'ul',
            { class: 'sv-vars' },
            ...p.variables.map((v) => h('li', {}, v.type === 'COLOR' ? valuePreview(v.value) : icon('variable', 12), h('span', { class: 'sv-name' }, v.name), h('span', { class: 'vars-muted' }, shown(v.value)))),
          )
        : null,
      ...p.kept.map((k) => h('p', { class: 'hint small sv-kept' }, tr('Остаётся в стиле: {0}', k))),
    );
  });
  apply.addEventListener('click', () => {
    const chosen = plan.filter((p) => ticked.has(p.style));
    const r = convertStylesToVariables(editor, chosen, collection.value);
    close();
    toast(tr('Создано переменных: {0}; стили теперь берут значения из них — слои остались со своими стилями', r.created));
    done?.(r.collection);
  });
  collection.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') apply.click();
  });
  const closeButton = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: close }, icon('close'));
  const dialog = h(
    'div',
    { class: 'dialog sv-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Стили в переменные') },
    h('header', { class: 'dialog-header' }, h('h2', {}, tr('Стили в переменные')), closeButton),
    h(
      'div',
      { class: 'dialog-body' },
      plan.length
        ? h('p', { class: 'hint small' }, tr('Значения стилей станут переменными. Стили останутся, и слои — с ними: просто значения стиля начнут браться из переменных и смогут меняться по режимам.'))
        : h('p', {}, tr('В файле нет стилей. Создайте стиль цвета, текста или эффекта — и его можно будет превратить в переменные.')),
      plan.length ? h('label', { class: 'field text-field sv-collection' }, h('span', { class: 'field-label' }, tr('Коллекция')), collection) : null,
      h('div', { class: 'sv-list' }, ...rows),
    ),
    h('footer', { class: 'dialog-footer' }, h('button', { class: 'text-button', type: 'button', onclick: close }, tr('Отмена')), plan.length ? apply : null),
  );
  const overlay = h('div', { class: 'dialog-overlay' }, dialog);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  document.body.append(overlay);
  sync();
  collection.focus();
  collection.select();
}
