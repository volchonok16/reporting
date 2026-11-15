// «Экспорт для печати (PDF)…» (FEAT-225): bleed, crop marks, CMYK, 300 dpi for what is drawn as a picture, and the
// check before printing (print-check.ts) for the frames being exported. A selected layer is shown by a click.

import { plural, tr, type NodeId } from '#core';
import type { Canvas2DRenderer } from '#render';
import type { TextMeasurer } from '#layout';
import type { Editor } from '../editor.ts';
import { checkPrint, MM, PRINT_LABELS, type PrintIssue } from '../print-check.ts';
import { openDialog } from './dialog.ts';
import { download, h } from './dom.ts';

const KEY = 'cs-print';

function saved(): { bleed: number; marks: boolean; cmyk: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (v && typeof v === 'object') return { bleed: Number(v.bleed) >= 0 ? Number(v.bleed) : 3, marks: v.marks !== false, cmyk: v.cmyk !== false };
  } catch {
    /* defaults */
  }
  return { bleed: 3, marks: true, cmyk: true };
}

export async function openPrintDialog(editor: Editor, renderer: Canvas2DRenderer, measurer: TextMeasurer): Promise<void> {
  const d = editor.doc;
  const frames = (editor.selection.length ? editor.topLevelSelection() : [...d.children(editor.pageId)]).filter((id) => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(d.type(id)));
  if (!frames.length) {
    editor.toast(tr('Выделите фрейм — страницу для печати.'));
    return;
  }
  const o = saved();
  const bleed = h('input', { type: 'number', min: '0', max: '20', step: '0.5', value: String(o.bleed), class: 'formats-size', 'aria-label': tr('Вылет, мм') }) as HTMLInputElement;
  const marks = h('input', { type: 'checkbox', checked: o.marks }) as HTMLInputElement;
  const cmyk = h('input', { type: 'checkbox', checked: o.cmyk }) as HTMLInputElement;
  const list = h('div', { class: 'print-issues' });
  const sizeOf = (hash: string) => renderer.images.get(d, hash);
  const show = (id: NodeId) => {
    editor.setSelection([id]);
    editor.zoomToSelection({ maxZoom: 2 });
  };
  const refresh = () => {
    const issues: PrintIssue[] = frames.flatMap((f) => checkPrint(editor, f, Math.max(0, +bleed.value || 0), sizeOf));
    if (!issues.length) {
      list.replaceChildren(h('p', { class: 'hint small' }, tr('Замечаний нет.')));
      return;
    }
    const groups = (Object.keys(PRINT_LABELS) as (keyof typeof PRINT_LABELS)[]).map((kind) => {
      const of = issues.filter((i) => i.kind === kind);
      if (!of.length) return null;
      return h(
        'section',
        { class: 'check-group' },
        h('h3', {}, `${tr(PRINT_LABELS[kind])} · ${of.length}`),
        ...of.slice(0, 30).map((i) =>
          h('div', { class: 'check-what' }, h('button', { class: 'check-layer', type: 'button', onclick: () => show(i.id) }, d.get(i.id, 'name')), h('span', { class: `check-value${i.bad ? ' bad' : ''}` }, i.now)),
        ),
      );
    });
    list.replaceChildren(h('p', { class: 'hint small' }, `${issues.length} ${plural(issues.length, tr('замечание'), tr('замечания'), tr('замечаний'))}`), ...groups.filter((g): g is HTMLElement => g !== null));
  };
  bleed.addEventListener('input', refresh);
  refresh();
  const ok = await openDialog({
    title: tr('Экспорт для печати'),
    body: [
      h('div', { class: 'formats-list' },
        h('label', { class: 'formats-row' }, h('span', {}, tr('Вылет')), h('span', {}), h('span', { class: 'formats-own' }, bleed, tr('мм'))),
        h('label', { class: 'formats-row' }, marks, h('span', {}, tr('Метки реза')), h('span', {})),
        h('label', { class: 'formats-row' }, cmyk, h('span', {}, tr('CMYK')), h('span', { class: 'hint small' }, tr('без профиля типографии'))),
      ),
      h('p', { class: 'hint small' }, tr('1 px = 1 pt. Картинки эффектов — 300 dpi.')),
      list,
    ],
    confirm: tr('Экспортировать'),
    cancel: tr('Отмена'),
  });
  if (!ok) return;
  const opts = { bleed: Math.min(20, Math.max(0, +bleed.value || 0)), marks: marks.checked, cmyk: cmyk.checked };
  try {
    localStorage.setItem(KEY, JSON.stringify(opts));
  } catch {
    /* not remembered */
  }
  editor.toast(tr('Собираю PDF…'));
  const { exportVectorPdf } = await import('#render');
  const blob = await exportVectorPdf(renderer, editor.scene, measurer, frames, 300 / 72, { bleed: opts.bleed * MM, marks: opts.marks, cmyk: opts.cmyk });
  const name = frames.length === 1 ? d.get(frames[0]!, 'name') : d.get(d.rootId, 'name');
  download(blob, `${name || tr('Печать')}.pdf`);
}
