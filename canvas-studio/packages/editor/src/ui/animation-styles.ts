// «Стили анимации» (Motion, stage 3): the ready styles and the file's own, put on the selected layers at the
// playhead — together with what is there, or after each layer's last keyframe; a style of one's own is saved from
// the selected layer's keyframes, renamed and deleted here.

import { tr, type AnimationStyle } from '#core';
import type { Editor } from '../editor.ts';
import { BUILTIN_STYLES, ownStyles } from '../motion/styles.ts';
import { openDialog } from './dialog.ts';
import { h, icon } from './dom.ts';

const props = (s: AnimationStyle) =>
  Object.keys(s.tracks)
    .map((p) => ({ x: tr('сдвиг'), y: tr('сдвиг'), rotation: tr('поворот'), scale: tr('масштаб'), opacity: tr('прозрачность') })[p as 'x'])
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');

export function openAnimationStyles(editor: Editor): void {
  const tl = editor.timeline;
  const after = h('input', { type: 'checkbox', 'aria-label': tr('После предыдущего') });
  const list = h('div', { class: 'anim-styles', role: 'list' });
  const fill = () => {
    list.replaceChildren();
    const row = (s: AnimationStyle, own: boolean) => {
      const apply = h('button', { class: 'text-button', type: 'button', title: tr('Применить к выделенным слоям') }, tr('Применить'));
      apply.addEventListener('click', () => tl.applyStyle(s.id, after.checked));
      const name = own ? h('input', { class: 'proto-input anim-style-name', value: s.name, 'aria-label': tr('Имя стиля') }) : h('span', { class: 'anim-style-name' }, s.name);
      if (name instanceof HTMLInputElement) {
        name.addEventListener('keydown', (e) => e.stopPropagation());
        name.addEventListener('change', () => tl.renameStyle(s.id, name.value));
      }
      const remove = own ? h('button', { class: 'icon-button', type: 'button', title: tr('Удалить стиль «{0}»', s.name), 'aria-label': tr('Удалить стиль «{0}»', s.name) }, icon('close', 12)) : null;
      remove?.addEventListener('click', () => {
        tl.deleteStyle(s.id);
        fill();
      });
      list.append(h('div', { class: 'anim-style', role: 'listitem' }, h('div', { class: 'anim-style-text' }, name, h('span', { class: 'hint small' }, `${props(s)} · ${(s.duration / 1000).toFixed(1).replace('.', ',')} ${tr('с')}`)), apply, ...(remove ? [remove] : [])));
    };
    for (const s of BUILTIN_STYLES) row(s, false);
    const own = ownStyles(editor.doc);
    if (own.length) list.append(h('h3', { class: 'anim-styles-head' }, tr('Свои стили')));
    for (const s of own) row(s, true);
  };
  fill();
  const save = h('button', { class: 'text-button', type: 'button', title: tr('Ключевые кадры выделенного слоя станут стилем, который можно накладывать на другие слои') }, tr('Сохранить стиль из слоя'));
  save.addEventListener('click', () => {
    const id = tl.layersForStyles()[0];
    if (tl.saveStyleFromSelection(id ? tr('{0} — анимация', editor.doc.get(id, 'name')) : '')) fill();
  });
  void openDialog({
    title: tr('Стили анимации'),
    body: [
      h('p', { class: 'share-muted' }, tr('Стиль ложится на выделенные слои в месте бегунка; несколько стилей в одном месте играют вместе.')),
      h('label', { class: 'tl-field' }, after, h('span', {}, tr('После предыдущего: за последним ключевым кадром слоя'))),
      list,
      h('div', { class: 'button-row' }, save),
    ],
    confirm: tr('Готово'),
    cancel: null,
  });
}
