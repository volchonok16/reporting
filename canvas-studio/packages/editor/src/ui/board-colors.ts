// A board's own colours (roadmap step 10): the list everyone in the board is
// offered after the usual colours of stickies, shapes, sections and tape. Added
// with «+» on the bar over an object or here; removed here.

import { tr } from '#core';
import { addBoardColor, BOARD_COLORS_MAX, removeBoardColor } from '../board.ts';
import type { Editor } from '../editor.ts';
import { openDialog } from './dialog.ts';
import { h, icon } from './dom.ts';

export function openBoardColors(editor: Editor): void {
  const d = editor.doc;
  const list = h('div', { class: 'board-colors-list', role: 'list' });
  const fill = () => {
    list.replaceChildren();
    const colors = d.get(d.rootId, 'boardColors');
    for (const hex of colors) {
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Убрать {0} из палитры доски', hex), 'aria-label': tr('Убрать {0} из палитры доски', hex), disabled: d.readOnly }, icon('close', 12));
      remove.addEventListener('click', () => {
        removeBoardColor(editor, hex);
        fill();
      });
      list.append(h('div', { class: 'board-colors-item', role: 'listitem' }, h('span', { class: 'board-colors-chip', style: { background: hex } }), h('code', {}, hex), remove));
    }
    if (!colors.length) list.append(h('p', { class: 'share-muted' }, tr('Своих цветов пока нет. Добавьте цвета бренда или команды — они появятся у стикеров, фигур, разделов и скотча после обычных.')));
  };
  fill();
  const input = h('input', { type: 'color', value: '#4f5bd5', 'aria-label': tr('Цвет') }) as HTMLInputElement;
  const add = h('button', { class: 'text-button', type: 'button', disabled: d.readOnly }, tr('Добавить'));
  add.addEventListener('click', () => {
    addBoardColor(editor, input.value);
    fill();
  });
  void openDialog({
    title: tr('Свои цвета доски'),
    body: [h('p', { class: 'share-muted' }, tr('Их видят все, кто работает с этой доской; до {0} цветов.', BOARD_COLORS_MAX)), list, h('div', { class: 'board-colors-add' }, input, add)],
    confirm: tr('Готово'),
    cancel: null,
  });
}
