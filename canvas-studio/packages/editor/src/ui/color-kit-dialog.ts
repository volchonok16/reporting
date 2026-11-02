// «Набор цветов» window (as the Color Kit plugin): rows made from one colour —
// the 50–900 scale, lighter, darker, muted, harmonies. A click on a colour applies
// it: to the paint whose picker opened the window, else to the selected layers'
// fill (with nothing selected — copies its HEX). Each row goes into variables or
// onto the canvas as a palette card.

import { colorToHex, hexToColor, solid, tr, type Color, type NodeId } from '#core';
import { hueName } from '../color-math.ts';
import type { Editor } from '../editor.ts';
import { colorKit, readability, type KitRow } from '../generators/color-kit.ts';
import { freeGroup, paletteCollection } from '../smart-ops.ts';
import { h, icon } from './dom.ts';

const STEPS_KEY = 'cs-color-kit-steps';

export interface ColorKitOptions {
  color: Color;
  /** Opened from a colour picker: a click on a colour goes there. */
  onPick?: (color: Color) => void;
}

let current: { close: () => void } | null = null;

export function openColorKit(editor: Editor, options: ColorKitOptions): void {
  current?.close();
  let base: Color = { ...options.color, a: 1 };
  let steps = 6;
  try {
    const v = Number(localStorage.getItem(STEPS_KEY));
    if (v >= 3 && v <= 10) steps = v;
  } catch {
    // default
  }

  const picker = h('input', { type: 'color', value: colorToHex(base).slice(0, 7), 'aria-label': tr('Базовый цвет') }) as HTMLInputElement;
  const hex = h('input', { class: 'dialog-input ck-hex', type: 'text', value: colorToHex(base).slice(0, 7), spellcheck: false, maxLength: 7, 'aria-label': 'HEX' }) as HTMLInputElement;
  const name = h('span', { class: 'ck-name' });
  const stepsInput = h('input', { type: 'range', min: '3', max: '10', value: String(steps), 'aria-label': tr('Ступеней') }) as HTMLInputElement;
  const stepsValue = h('span', { class: 'gen-value' }, String(steps));
  const rows = h('div', { class: 'ck-rows' });

  const setBase = (c: Color) => {
    base = { ...c, a: 1 };
    const x = colorToHex(base).slice(0, 7);
    picker.value = x;
    if (document.activeElement !== hex) hex.value = x;
    draw();
  };
  picker.addEventListener('input', () => setBase(hexToColor(picker.value) ?? base));
  hex.addEventListener('input', () => {
    const c = hexToColor(hex.value.startsWith('#') ? hex.value : `#${hex.value}`);
    if (c && /^#?[0-9a-f]{6}$/i.test(hex.value)) setBase(c);
  });
  stepsInput.addEventListener('input', () => {
    steps = Number(stepsInput.value);
    stepsValue.textContent = stepsInput.value;
    try {
      localStorage.setItem(STEPS_KEY, String(steps));
    } catch {
      // not kept
    }
    draw();
  });

  const pick = (c: Color) => {
    if (options.onPick) return options.onPick(c);
    const ids = editor.selection.filter((id) => editor.doc.store.isAlive(id) && editor.doc.type(id) !== 'GROUP' && !editor.isInstanceLayer(id));
    if (ids.length === 0 || editor.doc.readOnly) {
      void navigator.clipboard?.writeText(colorToHex(c).slice(0, 7)).catch(() => undefined);
      return editor.toast(tr('Цвет {0} скопирован', colorToHex(c).slice(0, 7)));
    }
    applyToSelection(editor, ids, c);
  };

  function swatch(c: Color): HTMLElement {
    const x = colorToHex(c).slice(0, 7);
    const r = readability(c);
    const title = tr('{0} — контраст с белым {1}, с чёрным {2}. Щелчок — применить', x, r.onWhite.toFixed(1), r.onBlack.toFixed(1));
    const b = h(
      'button',
      { class: 'ck-swatch', type: 'button', title, style: { background: x, color: r.text === 'white' ? '#fff' : '#000' } },
      h('span', { class: 'ck-aa' }, r.level),
    );
    b.addEventListener('click', () => pick(c));
    return h('div', { class: 'ck-cell' }, b, h('span', { class: 'ck-code' }, x.toUpperCase()));
  }

  function draw(): void {
    name.textContent = hueName(base);
    rows.replaceChildren(
      ...colorKit(base, steps).map((row) => {
        const toVars = h('button', { class: 'icon-button', type: 'button', title: tr('В переменные: группа в коллекции «Палитра»'), 'aria-label': tr('В переменные') }, icon('variable', 14));
        const toCanvas = h('button', { class: 'icon-button', type: 'button', title: tr('На холст: карточка палитры'), 'aria-label': tr('На холст') }, icon('frame', 14));
        toVars.addEventListener('click', () => rowToVariables(editor, base, row));
        toCanvas.addEventListener('click', () => rowToCanvas(editor, base, row));
        return h(
          'section',
          { class: 'ck-row' },
          h('header', { class: 'ck-row-head' }, h('span', { class: 'ck-row-title', title: row.hint }, row.title), h('span', { class: 'ck-row-tools' }, toVars, toCanvas)),
          h('div', { class: 'ck-swatches' }, ...row.colors.map(swatch)),
        );
      }),
    );
  }

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (current?.close === close) current = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  const closeButton = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть') }, icon('close'));
  closeButton.addEventListener('click', close);
  const done = h('button', { class: 'text-button primary', type: 'button' }, tr('Готово'));
  done.addEventListener('click', close);
  const dialog = h(
    'div',
    { class: 'dialog color-kit', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Набор цветов') },
    h('header', { class: 'dialog-header' }, h('h2', {}, tr('Набор цветов')), closeButton),
    h(
      'div',
      { class: 'dialog-body' },
      h('div', { class: 'ck-base' }, picker, hex, name, h('label', { class: 'ck-steps' }, h('span', {}, tr('Ступеней')), stepsInput, stepsValue)),
      rows,
      h('p', { class: 'dialog-hint' }, options.onPick ? tr('Щелчок по цвету — в заливку, для которой открыт выбор цвета. AA и AAA — контраст текста по WCAG с белым или чёрным (надпись на квадрате — каким лучше).') : tr('Щелчок по цвету — в заливку выделенных слоёв (без выделения — скопировать HEX). AA и AAA — контраст текста по WCAG с белым или чёрным.')),
    ),
    h('footer', { class: 'dialog-footer' }, done),
  );
  const overlay = h('div', { class: 'dialog-overlay' }, dialog);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  dialog.addEventListener('keydown', (e) => e.stopPropagation());
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  current = { close };
  draw();
  hex.focus();
}

/** The colour into each layer's fill: its one plain fill recoloured, else a plain fill of it. */
export function applyToSelection(editor: Editor, ids: readonly NodeId[], c: Color): void {
  const d = editor.doc;
  editor.commit(tr('Цвет из набора'), (tx) => {
    for (const id of ids) {
      const fills = d.get(id, 'fills').slice();
      const i = fills.findIndex((p) => p.type === 'SOLID' && p.visible);
      if (i >= 0 && fills[i]!.type === 'SOLID') fills[i] = { ...fills[i]!, color: { ...c, a: 1 } };
      else fills.splice(0, fills.length, solid({ ...c, a: 1 }));
      tx.set(id, 'fills', fills);
    }
  });
}

/** A row → variables «Палитра / <Цвет> <ряд>/1…n» (the scale keeps its 50…900). */
export function rowToVariables(editor: Editor, base: Color, row: KitRow): void {
  if (editor.doc.readOnly) return;
  let group = '';
  editor.commit(tr('Набор цветов → переменные'), () => {
    const collection = paletteCollection(editor, tr('Палитра'));
    group = freeGroup(editor, collection, row.id === 'scale' ? hueName(base) : `${hueName(base)} — ${row.title.toLowerCase()}`);
    const stops = row.id === 'scale' ? [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] : null;
    row.colors.forEach((c, i) => editor.variables.createVariable(collection, 'COLOR', `${group}/${stops ? stops[i] : i + 1}`, c));
  });
  editor.toast(tr('В «Палитре» — группа «{0}», цветов: {1}', group, row.colors.length));
}

/** A row → a card on the canvas: squares with their HEX, in a row, in the middle of the view. */
export function rowToCanvas(editor: Editor, base: Color, row: KitRow): NodeId | null {
  if (editor.doc.readOnly) return null;
  const centre = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
  const parent = editor.containerAt(centre);
  const local = editor.toParentSpace(parent, centre);
  const ink = solid({ r: 0.12, g: 0.12, b: 0.12, a: 1 });
  let card: NodeId | null = null;
  editor.commit(tr('Набор цветов → холст'), (tx) => {
    card = tx.create('FRAME', parent, {
      name: `${tr('Палитра')} / ${hueName(base)} — ${row.title.toLowerCase()}`,
      x: Math.round(local.x - (row.colors.length * 104 + 24) / 2),
      y: Math.round(local.y - 70),
      width: row.colors.length * 104 + 24,
      height: 140,
      layoutMode: 'HORIZONTAL',
      sizingH: { mode: 'HUG' },
      sizingV: { mode: 'HUG' },
      itemSpacing: 8,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16,
      cornerRadius: 12,
      fills: [solid({ r: 1, g: 1, b: 1, a: 1 })],
    });
    for (const c of row.colors) {
      const x = colorToHex(c).slice(0, 7).toUpperCase();
      const cell = tx.create('FRAME', card, { name: x, width: 96, height: 100, layoutMode: 'VERTICAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, itemSpacing: 6, fills: [] });
      tx.create('RECTANGLE', cell, { name: x, width: 96, height: 72, cornerRadius: 8, fills: [solid({ ...c, a: 1 })] });
      tx.create('TEXT', cell, { name: x, characters: x, fontSize: 12, fills: [ink] });
    }
  }, () => (card ? [card] : []));
  if (card) editor.appear([card]);
  return card;
}
