// The «Слайд» section of the right panel in a presentation (FEAT-157): how the
// slide the selection is on comes in during the show, and whether the show skips
// it. Its speaker's notes are under the slide (slide-notes.ts).

import { tr, type NodeId, type SlideTransition } from '#core';
import type { Editor } from '../editor.ts';
import { slideInfo } from '../slides.ts';
import { h } from './dom.ts';

const TRANSITIONS = (): [SlideTransition['type'], string][] => [
  ['NONE', tr('Без перехода')],
  ['DISSOLVE', tr('Растворение')],
  ['MOVE_IN', tr('Наплыв справа')],
  ['PUSH', tr('Сдвиг')],
  ['SLIDE_UP', tr('Снизу вверх')],
];

export function buildSlideSection(editor: Editor, section: (title: string, ...actions: HTMLElement[]) => HTMLElement, slide: NodeId, onPresent: () => void): void {
  const d = editor.doc;
  const info = slideInfo(d, slide);
  const ro = d.readOnly;
  const write = (label: string, patch: Partial<typeof info>) => editor.commit(label, (tx) => tx.set(slide, 'slide', { ...slideInfo(d, slide), ...patch }));
  const play = h('button', { class: 'icon-button', type: 'button', title: tr('Показ с этого слайда'), 'aria-label': tr('Показ с этого слайда'), onclick: onPresent }, '▶');
  const body = section(tr('Слайд'), play);
  const t = info.transition ?? { type: 'NONE', duration: 400 };
  const kind = h('select', { class: 'field-select', disabled: ro, 'aria-label': tr('Переход') }, ...TRANSITIONS().map(([v, label]) => h('option', { value: v, selected: v === t.type }, label))) as HTMLSelectElement;
  const duration = h('select', { class: 'field-select', disabled: ro || t.type === 'NONE', 'aria-label': tr('Длительность перехода') }, ...[200, 300, 400, 600, 800, 1000].map((ms) => h('option', { value: String(ms), selected: ms === t.duration }, tr('{0} мс', ms)))) as HTMLSelectElement;
  const setTransition = () => write(tr('Переход слайда'), { transition: { type: kind.value as SlideTransition['type'], duration: Number(duration.value) } });
  kind.addEventListener('change', () => {
    duration.disabled = kind.value === 'NONE';
    setTransition();
  });
  duration.addEventListener('change', setTransition);
  const skip = h('input', { type: 'checkbox', checked: !!info.skip, disabled: ro }) as HTMLInputElement;
  skip.addEventListener('change', () => write(skip.checked ? tr('Пропускать слайд') : tr('Показывать слайд'), { skip: skip.checked }));
  // The notes are under the slide (FEAT-166), as in Figma Slides.
  body.append(
    h('div', { class: 'slide-row' }, h('span', { class: 'field-label' }, tr('Переход')), kind, duration),
    h('label', { class: 'slide-check' }, skip, h('span', {}, tr('Пропускать при показе'))),
  );
}
