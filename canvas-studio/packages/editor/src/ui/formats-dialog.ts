// «Подогнать под форматы…» (FEAT-224): a frame → copies in the ticked sizes past its row (formats.ts), then each is
// edited apart. The ticks are remembered in this browser.

import { tr, type NodeId } from '#core';
import { FORMATS, fitToFormats } from '#components';
import type { Editor } from '../editor.ts';
import { openDialog } from './dialog.ts';
import { h } from './dom.ts';

const KEY = 'cs-formats';

function remembered(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(v)) return new Set(v.map(String));
  } catch {
    /* defaults */
  }
  return new Set(['square', 'story', 'vk-cover']);
}

export async function openFormatsDialog(editor: Editor): Promise<void> {
  const d = editor.doc;
  if (d.readOnly) return;
  const frames = editor.topLevelSelection().filter((id) => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(d.type(id)));
  if (frames.length !== 1) {
    editor.toast(tr('Выделите один фрейм — баннер или пост.'));
    return;
  }
  const frame = frames[0]!;
  const on = remembered();
  const boxes = FORMATS.map((f) => {
    const box = h('input', { type: 'checkbox', checked: on.has(f.id) }) as HTMLInputElement;
    return { f, box, row: h('label', { class: 'formats-row' }, box, h('span', {}, tr(f.label)), h('span', { class: 'hint small' }, `${f.width} × ${f.height}`)) };
  });
  const own = h('input', { type: 'checkbox', checked: on.has('own') }) as HTMLInputElement;
  const ownW = h('input', { type: 'number', min: '16', max: '10000', value: '1200', class: 'formats-size', 'aria-label': tr('Ширина') }) as HTMLInputElement;
  const ownH = h('input', { type: 'number', min: '16', max: '10000', value: '628', class: 'formats-size', 'aria-label': tr('Высота') }) as HTMLInputElement;
  const ownRow = h('label', { class: 'formats-row' }, own, h('span', {}, tr('Свой размер')), h('span', { class: 'formats-own' }, ownW, '×', ownH));
  const ok = await openDialog({
    title: tr('Подогнать под форматы'),
    body: [
      h('p', { class: 'hint small' }, tr('Копии встанут справа, каждую можно править отдельно.')),
      h('div', { class: 'formats-list' }, ...boxes.map((b) => b.row), ownRow),
    ],
    confirm: tr('Создать'),
    cancel: tr('Отмена'),
    validate: () => (boxes.some((b) => b.box.checked) || own.checked ? null : tr('Отметьте хотя бы один формат')),
  });
  if (!ok) return;
  const chosen = boxes.filter((b) => b.box.checked).map((b) => ({ width: b.f.width, height: b.f.height, label: tr(b.f.label) }));
  if (own.checked) {
    const w = Math.min(10000, Math.max(16, Math.round(+ownW.value || 0)));
    const hgt = Math.min(10000, Math.max(16, Math.round(+ownH.value || 0)));
    chosen.push({ width: w, height: hgt, label: `${w}×${hgt}` });
  }
  try {
    localStorage.setItem(KEY, JSON.stringify([...boxes.filter((b) => b.box.checked).map((b) => b.f.id), ...(own.checked ? ['own'] : [])]));
  } catch {
    /* not remembered */
  }
  const made: NodeId[] = editor.commit(tr('Подогнать под форматы'), (tx) => fitToFormats(d, tx, frame, chosen));
  editor.setSelection(made);
  editor.zoomToSelection({ maxZoom: 1 });
  editor.toast(tr('Готово форматов: {0}. Каждый правится отдельно.', made.length));
}
