// The window for renaming several layers (⌘R with more than one selected):
// a pattern, find and replace, the first number — and a preview of the first
// names as they will become, updated while typing.

import { tr } from '#core';
import { panelOrder, regexError, renameAll, renameSelection, type RenameRule } from '../batch-rename.ts';
import type { Editor } from '../editor.ts';
import { h } from './dom.ts';
import { openDialog } from './dialog.ts';

const PREVIEW = 6;

export async function openBatchRename(editor: Editor): Promise<void> {
  const ids = panelOrder(editor, editor.selection);
  if (ids.length < 2) return;
  const names = ids.map((id) => editor.doc.get(id, 'name'));
  const field = (label: string, input: HTMLInputElement) => h('label', { class: 'dialog-field' }, h('span', {}, label), input);
  const pattern = h('input', { class: 'dialog-input', type: 'text', value: '$&', spellcheck: false, maxLength: 200 });
  const find = h('input', { class: 'dialog-input', type: 'text', value: '', spellcheck: false, maxLength: 200, placeholder: tr('необязательно') });
  const replace = h('input', { class: 'dialog-input', type: 'text', value: '', spellcheck: false, maxLength: 200 });
  const start = h('input', { class: 'dialog-input', type: 'number', value: '1', min: '0', step: '1' });
  const regex = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const regexNote = h('p', { class: 'dialog-hint' });
  const preview = h('ol', { class: 'rename-preview', 'aria-live': 'polite' });
  const rule = (): RenameRule => ({ pattern: pattern.value, find: find.value, replace: replace.value, regex: regex.checked, start: Math.max(0, Math.floor(Number(start.value) || 0)) });
  const update = () => {
    const error = regexError(rule());
    regexNote.textContent = error ? tr('Ошибка в выражении: {0}', error) : regex.checked ? tr('Например: (\\d+) — число, ^ — начало имени, $ — конец; в замене $1 — первая скобка.') : '';
    regexNote.classList.toggle('error', !!error);
    regexNote.hidden = !regexNote.textContent;
    const next = renameAll(names, rule());
    preview.replaceChildren(
      ...names.slice(0, PREVIEW).map((name, i) => h('li', {}, h('span', { class: 'rename-old' }, name), ' → ', h('span', { class: 'rename-new' }, next[i]!.trim() || tr('(без изменений)')))),
      ...(names.length > PREVIEW ? [h('li', { class: 'rename-more' }, tr('…и ещё {0}', names.length - PREVIEW))] : []),
    );
  };
  for (const input of [pattern, find, replace, start, regex]) input.addEventListener('input', update);
  update();
  const ok = await openDialog({
    title: tr('Переименовать слои: {0}', ids.length),
    body: [
      field(tr('Новое имя'), pattern),
      h('p', { class: 'dialog-hint' }, tr('$& — прежнее имя, $n — номер (1, 2, 3), $nn — с нулём (01, 02), $N — номер в обратном порядке. Номера идут сверху вниз, как в панели слоёв.')),
      h('div', { class: 'rename-row' }, field(tr('Найти'), find), field(tr('Заменить на'), replace)),
      h('label', { class: 'dialog-check' }, regex, h('span', {}, tr('Регулярное выражение'))),
      regexNote,
      field(tr('Начать с номера'), start),
      preview,
    ],
    confirm: tr('Переименовать'),
    cancel: tr('Отмена'),
    validate: () => (regexError(rule()) ? tr('Исправьте выражение в поле «Найти»') : renameAll(names, rule()).every((n, i) => n.trim() === '' || n === names[i]) ? tr('Имена не изменятся — впишите новое имя или что заменить') : null),
    focus: () => {
      requestAnimationFrame(() => pattern.select());
      return pattern;
    },
  });
  if (!ok) return;
  const n = renameSelection(editor, rule());
  editor.toast(tr('Переименовано слоёв: {0}', n));
}
