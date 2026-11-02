// «Каракули» window (FEAT-164): pick a kind from the drawn tiles, see it in the
// preview; «Другой штрих» rolls a new seed. What was chosen last is remembered.

import { tr } from '#core';
import type { Editor } from '../editor.ts';
import { pathData, randomSeed } from '../generators/blob.ts';
import { DEFAULT_DOODLE, DOODLE_KINDS, doodle, doodleBox, doodleName, doodlePaints, insertDoodle, type DoodleKind, type DoodleSettings } from '../generators/doodles.ts';
import { pathsBounds } from '#geometry';
import { openDialog } from './dialog.ts';
import { h } from './dom.ts';

const KEY = 'cs-doodle';
const SVG = 'http://www.w3.org/2000/svg';

function saved(): DoodleSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<DoodleSettings> | null;
    const s = { ...DEFAULT_DOODLE, ...(v ?? {}) };
    return DOODLE_KINDS.includes(s.kind) ? s : { ...s, kind: DEFAULT_DOODLE.kind };
  } catch {
    return { ...DEFAULT_DOODLE };
  }
}

/** Draws the doodle into `svg`, fitted with room for the line. */
function paint(svg: SVGSVGElement, s: DoodleSettings, size: number, weight: number): void {
  const box = doodleBox(s.kind);
  const { paths, filled } = doodle(s, box.width, box.height);
  const { strokeWeight } = doodlePaints(s, box, filled);
  const w = s.kind === 'marker' ? strokeWeight : weight;
  const b = pathsBounds(paths)!;
  const pad = w / 2 + 2;
  svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.width + pad * 2} ${b.height + pad * 2}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.replaceChildren(
    ...paths.map((path) => {
      const el = document.createElementNS(SVG, 'path');
      el.setAttribute('d', pathData(path));
      if (filled) {
        el.setAttribute('fill', s.color);
      } else {
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', s.color);
        el.setAttribute('stroke-width', String(w));
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
        if (s.kind === 'marker') el.setAttribute('stroke-opacity', '0.4');
      }
      return el;
    }),
  );
}

/** Opens the window; «Вставить» puts the doodle round the selection or in the middle of the view. */
export async function openDoodleDialog(editor: Editor): Promise<void> {
  if (editor.doc.readOnly) return void editor.toast(tr('Только просмотр: изменения не сохраняются.'));
  const s = saved();
  const hasSelection = editor.topLevelSelection().length > 0;

  const preview = document.createElementNS(SVG, 'svg');
  const tiles = DOODLE_KINDS.map((kind) => {
    const pic = document.createElementNS(SVG, 'svg');
    const tile = h('button', { class: 'gen-tile', type: 'button', title: doodleName(kind), 'aria-label': doodleName(kind) }, pic as unknown as HTMLElement);
    tile.addEventListener('click', () => {
      s.kind = kind as DoodleKind;
      draw();
    });
    return { kind, tile, pic };
  });

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

  const seed = h('input', { class: 'dialog-input', type: 'number', min: '1', max: '999999', step: '1', value: String(s.seed), 'aria-label': tr('Номер формы') }) as HTMLInputElement;
  seed.addEventListener('input', () => {
    const v = Math.round(Number(seed.value));
    if (Number.isFinite(v) && v >= 1 && v <= 999_999) s.seed = v;
    draw();
  });
  const roll = h('button', { class: 'text-button', type: 'button', title: tr('Тот же вид, другой штрих') }, tr('Другой штрих'));
  roll.addEventListener('click', () => {
    s.seed = randomSeed();
    seed.value = String(s.seed);
    draw();
  });
  const color = h('input', { type: 'color', value: s.color, 'aria-label': tr('Цвет') }) as HTMLInputElement;
  color.addEventListener('input', () => {
    s.color = color.value.toUpperCase();
    draw();
  });

  function draw(): void {
    paint(preview, s, 220, s.weight);
    for (const t of tiles) {
      paint(t.pic, { ...s, kind: t.kind }, 36, 3);
      t.tile.classList.toggle('active', t.kind === s.kind);
      t.tile.setAttribute('aria-pressed', String(t.kind === s.kind));
    }
  }
  draw();

  const ok = await openDialog({
    title: tr('Каракули'),
    confirm: tr('Вставить'),
    cancel: tr('Отмена'),
    body: [
      h(
        'div',
        { class: 'gen-dialog' },
        h('div', { class: 'gen-preview gen-preview-doodle' }, preview as unknown as HTMLElement),
        h(
          'div',
          { class: 'gen-controls' },
          h('div', { class: 'gen-tiles', role: 'group', 'aria-label': tr('Вид') }, ...tiles.map((t) => t.tile)),
          range(tr('Дрожание руки'), 0, 100, () => s.wobble, (v) => (s.wobble = v)),
          range(tr('Толщина'), 1, 24, () => s.weight, (v) => (s.weight = v)),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Номер формы')), h('span', { class: 'gen-row' }, seed, roll)),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Цвет')), h('span', { class: 'gen-row' }, color)),
        ),
      ),
      h('p', { class: 'dialog-hint' }, hasSelection ? tr('Подчёркивание, обводка и маркер встанут по выделенному, остальное — рядом с ним.') : tr('Выделите текст или объект — подчёркивание, обводка и маркер встанут точно по нему.')),
    ],
    focus: () => roll,
  });
  if (!ok) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not remembered — the next window starts from the defaults.
  }
  insertDoodle(editor, s);
}
