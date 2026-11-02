// «Клякса» window (as the Blobs plugin): the shape is previewed as the settings
// change; «Другая форма» rolls a new seed. What was chosen last is remembered.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { blobPath, DEFAULT_BLOB, insertBlob, pathData, randomSeed, type BlobPaint, type BlobSettings } from '../generators/blob.ts';
import { openDialog } from './dialog.ts';
import { h } from './dom.ts';

const KEY = 'cs-blob';
const SVG = 'http://www.w3.org/2000/svg';
const PREVIEW = 220;

function saved(): BlobSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<BlobSettings> | null;
    return { ...DEFAULT_BLOB, ...(v ?? {}) };
  } catch {
    return { ...DEFAULT_BLOB };
  }
}

/** Opens the window; «Вставить» puts the shape on the canvas. */
export async function openBlobDialog(editor: Editor): Promise<void> {
  if (editor.doc.readOnly) return void editor.toast(tr('Только просмотр: изменения не сохраняются.'));
  const s = saved();

  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${PREVIEW} ${PREVIEW}`);
  svg.setAttribute('width', String(PREVIEW));
  svg.setAttribute('height', String(PREVIEW));
  const defs = document.createElementNS(SVG, 'defs');
  const grad = document.createElementNS(SVG, 'linearGradient');
  grad.id = 'blob-preview-gradient';
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '1');
  grad.setAttribute('y2', '1');
  const stop1 = document.createElementNS(SVG, 'stop');
  stop1.setAttribute('offset', '0');
  const stop2 = document.createElementNS(SVG, 'stop');
  stop2.setAttribute('offset', '1');
  grad.append(stop1, stop2);
  defs.append(grad);
  const shape = document.createElementNS(SVG, 'path');
  svg.append(defs, shape);

  const range = (label: string, min: number, max: number, get: () => number, set: (v: number) => void) => {
    const value = h('span', { class: 'gen-value' }, String(get()));
    const input = h('input', { type: 'range', min: String(min), max: String(max), value: String(get()), 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('input', () => {
      set(Number(input.value));
      value.textContent = input.value;
      draw();
    });
    return h('label', { class: 'dialog-field' }, h('span', { class: 'gen-label' }, h('span', {}, label), value), input);
  };

  const seed = h('input', { class: 'dialog-input blob-seed', type: 'number', min: '1', max: '999999', step: '1', value: String(s.seed), 'aria-label': tr('Номер формы') }) as HTMLInputElement;
  seed.addEventListener('input', () => {
    const v = Math.round(Number(seed.value));
    if (Number.isFinite(v) && v > 0) s.seed = v;
    draw();
  });
  const roll = h('button', { class: 'text-button', type: 'button', title: tr('Новая случайная форма с теми же настройками') }, tr('Другая форма'));
  roll.addEventListener('click', () => {
    s.seed = randomSeed();
    seed.value = String(s.seed);
    draw();
  });

  const size = h('input', { class: 'dialog-input', type: 'number', min: '8', max: '4000', step: '1', value: String(s.size), 'aria-label': tr('Размер') }) as HTMLInputElement;
  size.addEventListener('input', () => {
    const v = Number(size.value);
    if (Number.isFinite(v) && v >= 8 && v <= 4000) s.size = Math.round(v);
  });

  const paint = h(
    'select',
    { class: 'dialog-input', 'aria-label': tr('Заливка') },
    ...([['solid', tr('Цвет')], ['gradient', tr('Градиент')], ['outline', tr('Контур')]] as const).map(([v, label]) => h('option', { value: v, selected: s.paint === v }, label)),
  ) as HTMLSelectElement;
  const color = h('input', { type: 'color', value: s.color, 'aria-label': tr('Цвет') }) as HTMLInputElement;
  const color2 = h('input', { type: 'color', value: s.color2, 'aria-label': tr('Второй цвет градиента') }) as HTMLInputElement;
  paint.addEventListener('change', () => {
    s.paint = paint.value as BlobPaint;
    draw();
  });
  color.addEventListener('input', () => {
    s.color = color.value.toUpperCase();
    draw();
  });
  color2.addEventListener('input', () => {
    s.color2 = color2.value.toUpperCase();
    draw();
  });

  function draw(): void {
    const pad = 12;
    const path = blobPath({ ...s, size: PREVIEW - pad * 2 });
    const w = Math.max(...path.points.map((p) => p.x));
    const hgt = Math.max(...path.points.map((p) => p.y));
    shape.setAttribute('d', pathData(path));
    // Centred in the preview (the contour starts at 0, 0).
    shape.setAttribute('transform', `translate(${(PREVIEW - w) / 2} ${(PREVIEW - hgt) / 2})`);
    stop1.setAttribute('stop-color', s.color);
    stop2.setAttribute('stop-color', s.color2);
    shape.setAttribute('fill', s.paint === 'outline' ? 'none' : s.paint === 'gradient' ? 'url(#blob-preview-gradient)' : s.color);
    shape.setAttribute('stroke', s.paint === 'outline' ? s.color : 'none');
    shape.setAttribute('stroke-width', '2');
    color2.hidden = s.paint !== 'gradient';
  }
  draw();

  const ok = await openDialog({
    title: tr('Клякса'),
    confirm: tr('Вставить'),
    cancel: tr('Отмена'),
    body: [
      h(
        'div',
        { class: 'gen-dialog' },
        h('div', { class: 'gen-preview' }, svg as unknown as HTMLElement),
        h(
          'div',
          { class: 'gen-controls' },
          range(tr('Сложность'), 3, 12, () => s.complexity, (v) => (s.complexity = v)),
          range(tr('Разброс'), 0, 100, () => s.spread, (v) => (s.spread = v)),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Номер формы')), h('span', { class: 'gen-row' }, seed, roll)),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Размер, px')), size),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Заливка')), h('span', { class: 'gen-row' }, paint, color, color2)),
        ),
      ),
      h('p', { class: 'dialog-hint' }, tr('Один и тот же номер — та же форма. Клякса — обычный вектор: точки можно править (Enter).')),
    ],
    focus: () => roll,
  });
  if (!ok) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not remembered — the next window starts from the defaults.
  }
  insertBlob(editor, s);
}
