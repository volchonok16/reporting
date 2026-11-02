// «Заменить шрифты…» (as Figma's Replace fonts): every font of the file with
// how many texts use it — a missing one marked — and a new font for any of
// them; one press replaces them all in one step: the texts, parts of texts
// in another font, and text styles.

import { plural, tr, type Document, type NodeId } from '#core';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';
import { FontPicker, isFontAvailable } from './font-picker.ts';

/** Fonts of the file: family → how many texts and styles use it. */
export function fontsInFile(doc: Document): Map<string, number> {
  const used = new Map<string, number>();
  const add = (f: string | undefined) => {
    if (f) used.set(f, (used.get(f) ?? 0) + 1);
  };
  doc.store.walk(doc.rootId, (id) => {
    const type = doc.type(id);
    if (type === 'TEXT') {
      add(doc.get(id, 'fontFamily'));
      for (const r of doc.get(id, 'textRuns')) if (r.style.fontFamily && r.style.fontFamily !== doc.get(id, 'fontFamily')) add(r.style.fontFamily);
    } else if (type === 'STYLE' && doc.get(id, 'styleType') === 'TEXT') add(doc.get(id, 'fontFamily'));
  });
  return used;
}

/** Replaces fonts in the whole file in one step; returns how many layers and styles changed. */
export function replaceFonts(editor: Editor, map: ReadonlyMap<string, string>): number {
  const doc = editor.doc;
  const changes: { id: NodeId; family?: string; runs?: boolean }[] = [];
  doc.store.walk(doc.rootId, (id) => {
    const type = doc.type(id);
    if (type !== 'TEXT' && !(type === 'STYLE' && doc.get(id, 'styleType') === 'TEXT')) return;
    const family = map.get(doc.get(id, 'fontFamily'));
    const runs = type === 'TEXT' && doc.get(id, 'textRuns').some((r) => r.style.fontFamily && map.has(r.style.fontFamily));
    if (family || runs) changes.push({ id, family, runs });
  });
  if (!changes.length) return 0;
  editor.commit(tr('Заменить шрифты'), (tx) => {
    for (const c of changes) {
      if (c.family) tx.set(c.id, 'fontFamily', c.family);
      if (c.runs) {
        const next = doc.get(c.id, 'textRuns').map((r) => (r.style.fontFamily && map.has(r.style.fontFamily) ? { ...r, style: { ...r.style, fontFamily: map.get(r.style.fontFamily)! } } : r));
        tx.set(c.id, 'textRuns', next);
      }
    }
  });
  return changes.length;
}

export function openReplaceFonts(editor: Editor, toast: (message: string) => void): void {
  const used = [...fontsInFile(editor.doc)].sort((a, b) => Number(isFontAvailable(a[0])) - Number(isFontAvailable(b[0])) || a[0].localeCompare(b[0]));
  const chosen = new Map<string, string>();
  const close = () => overlay.remove();
  const apply = h('button', { class: 'text-button primary', type: 'button', disabled: true }, tr('Заменить'));
  const sync = () => {
    const n = [...chosen].filter(([a, b]) => a !== b).length;
    apply.disabled = n === 0 || editor.doc.readOnly;
    apply.textContent = n ? tr('Заменить: {0}', n) : tr('Заменить');
  };
  const rows = used.map(([family, count]) => {
    const missing = !isFontAvailable(family);
    const picker = new FontPicker(
      () => editor.doc,
      () => chosen.get(family) ?? family,
      (next) => {
        chosen.set(family, next);
        picker.refresh();
        sync();
      },
    );
    return h(
      'div',
      { class: 'rf-row' },
      h('div', { class: 'rf-old' }, h('strong', { style: { fontFamily: `"${family}", sans-serif` } }, family), h('span', { class: missing ? 'rf-missing' : '' }, `${count} ${plural(count, tr('слой'), tr('слоя'), tr('слоёв'))}${missing ? ` · ${tr('нет на этом компьютере')}` : ''}`)),
      h('span', { class: 'rf-arrow', 'aria-hidden': 'true' }, '→'),
      picker.el,
    );
  });
  apply.addEventListener('click', () => {
    const map = new Map([...chosen].filter(([a, b]) => a !== b));
    const n = replaceFonts(editor, map);
    close();
    toast(tr('Шрифты заменены: {0} {1}', n, plural(n, tr('слой'), tr('слоя'), tr('слоёв'))));
  });
  const closeButton = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: close }, icon('close'));
  const dialog = h(
    'div',
    { class: 'dialog rf-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Заменить шрифты') },
    h('header', { class: 'dialog-header' }, h('h2', {}, tr('Заменить шрифты')), closeButton),
    h('div', { class: 'dialog-body' }, used.length ? h('p', { class: 'hint small' }, tr('Выберите новый шрифт напротив старого — заменится во всём файле: в текстах, их частях и текстовых стилях.')) : h('p', {}, tr('В файле нет текстов.')), h('div', { class: 'rf-list' }, ...rows)),
    h('footer', { class: 'dialog-footer' }, h('button', { class: 'text-button', type: 'button', onclick: close }, tr('Отмена')), apply),
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
}
