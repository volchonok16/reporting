// Stickers and components on a board (roadmap step 10), one window over the dock:
// «Наклейки» — our own bright badges (board.ts STICKERS), a click puts one on a
// free place near the middle of the screen; «Компоненты» — the components of
// the file and of the libraries switched on for it, the design's assets panel.

import { tr } from '#core';
import { createSticker, STICKERS } from '../board.ts';
import type { Editor } from '../editor.ts';
import type { AssetsPanel } from './assets-panel.ts';
import { h } from './dom.ts';
import { popover } from './styles-ui.ts';

/** How a sticker looks in the window: the shape roughly, its colours and word. */
function preview(st: (typeof STICKERS)[number]): HTMLElement {
  const round = st.shape === 'ELLIPSE' ? '50%' : st.shape === 'TERMINATOR' ? '999px' : st.shape === 'ROUNDED' || st.shape === 'SPEECH' || st.shape === 'CLOUD' ? '14px' : '6px';
  const clip: Record<string, string> = {
    STAR: 'polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)',
    HEXAGON: 'polygon(25% 3%, 75% 3%, 98% 50%, 75% 97%, 25% 97%, 2% 50%)',
    DIAMOND: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
    ARROW: 'polygon(0 25%, 65% 25%, 65% 0, 100% 50%, 65% 100%, 65% 75%, 0 75%)',
  };
  const wide = st.w / st.h > 1.6;
  const badge = h('span', { class: 'bs-badge' }, tr(st.label));
  badge.style.background = st.fill;
  badge.style.color = st.ink;
  badge.style.borderRadius = round;
  badge.style.width = wide ? '100%' : '64px';
  badge.style.height = wide ? '30px' : '64px';
  if (clip[st.shape]) {
    // Pointed shapes leave little room inside: bigger, with a smaller word.
    badge.style.clipPath = clip[st.shape]!;
    badge.style.boxShadow = 'none';
    badge.style.width = st.shape === 'ARROW' ? '100%' : '76px';
    badge.style.height = st.shape === 'ARROW' ? '44px' : '76px';
    badge.style.fontSize = '9px';
    if (st.shape === 'ARROW') badge.style.paddingRight = '14px';
    if (st.shape === 'STAR') badge.style.paddingTop = '8px';
  }
  return badge;
}

export function openBoardStickers(editor: Editor, anchor: HTMLElement, assets: AssetsPanel, startWith: 'stickers' | 'components' = 'stickers'): void {
  if (editor.doc.readOnly) return void editor.toast(tr('Только просмотр: вставка недоступна.'));
  const stickersTab = h('button', { class: 'bs-tab', type: 'button', role: 'tab' }, tr('Наклейки'));
  const componentsTab = h('button', { class: 'bs-tab', type: 'button', role: 'tab' }, tr('Компоненты'));
  const grid = h('div', { class: 'bs-grid', role: 'list', 'aria-label': tr('Наклейки') });
  const middle = () => editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
  for (const st of STICKERS) {
    const item = h('button', { class: 'bs-item', type: 'button', role: 'listitem', title: tr('Наклейка «{0}»: щелчок ставит её на доску', tr(st.label)) }, preview(st));
    item.addEventListener('click', () => {
      const id = createSticker(editor, st.id, middle());
      editor.setSelection([id]);
      editor.appear([id]);
    });
    grid.append(item);
  }
  const hint = h('p', { class: 'bs-hint' }, tr('Надпись меняется двойным щелчком, как у фигуры.'));
  const stickersPane = h('div', { class: 'bs-pane' }, grid, hint);
  const componentsPane = h('div', { class: 'bs-pane bs-assets' });
  const body = h('div', { class: 'board-stickers' }, h('div', { class: 'bs-tabs', role: 'tablist' }, stickersTab, componentsTab), stickersPane, componentsPane);
  const show = (which: 'stickers' | 'components') => {
    stickersTab.classList.toggle('on', which === 'stickers');
    componentsTab.classList.toggle('on', which === 'components');
    stickersTab.setAttribute('aria-selected', String(which === 'stickers'));
    componentsTab.setAttribute('aria-selected', String(which === 'components'));
    stickersPane.hidden = which !== 'stickers';
    componentsPane.hidden = which !== 'components';
    if (which === 'components') {
      // The assets panel itself, lent from the hidden left panel of a board.
      componentsPane.append(assets.el);
      assets.setVisible(true);
    }
  };
  stickersTab.addEventListener('click', () => show('stickers'));
  componentsTab.addEventListener('click', () => show('components'));
  show(startWith);
  popover(anchor, body, 320);
}
