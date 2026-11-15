// «Сайт дизайн-системы…» (FEAT-226): the page from ds-site.ts in a full-window view; it is rebuilt after edits
// while open (half a second after the last one), and «Скачать HTML» gives the same page as one file.

import { tr, type NodeId } from '#core';
import { renderThumbnail, type Canvas2DRenderer } from '#render';
import type { Editor } from '../editor.ts';
import { buildDsSite } from '../ds-site.ts';
import { download, h, icon } from './dom.ts';

function picture(editor: Editor, renderer: Canvas2DRenderer, id: NodeId): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    renderThumbnail(renderer, editor.scene, id, canvas, 240, 200);
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

export function openDsSite(editor: Editor, renderer: Canvas2DRenderer): void {
  const frame = h('iframe', { class: 'ds-site-frame', title: tr('Сайт дизайн-системы'), sandbox: 'allow-scripts' }) as HTMLIFrameElement;
  let html = '';
  const build = () => {
    const site = buildDsSite({ doc: editor.doc, picture: (id) => picture(editor, renderer, id) });
    html = site.html;
    frame.srcdoc = html;
  };
  let timer = 0;
  const off = editor.events.on('change', () => {
    clearTimeout(timer);
    timer = window.setTimeout(build, 500);
  });
  const close = () => {
    clearTimeout(timer);
    off();
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const name = String(editor.doc.get(editor.doc.rootId, 'name') || tr('Дизайн-система'));
  const overlay = h(
    'div',
    { class: 'ds-site', role: 'dialog', 'aria-label': tr('Сайт дизайн-системы') },
    h(
      'header',
      { class: 'ds-site-head' },
      h('b', {}, tr('Сайт дизайн-системы')),
      h('span', { class: 'hint small' }, tr('Обновляется при правках')),
      h('span', { class: 'ds-site-gap' }),
      h('button', { class: 'text-button', type: 'button', onclick: () => download(new Blob([html], { type: 'text/html' }), `${name}.html`) }, tr('Скачать HTML')),
      h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть'), 'aria-label': tr('Закрыть'), onclick: close }, icon('close', 14)),
    ),
    frame,
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  build();
}
