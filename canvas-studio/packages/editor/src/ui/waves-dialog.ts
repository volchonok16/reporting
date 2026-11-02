// «Волны» window (as the Get Waves plugin): the waves are previewed as the settings
// change; «Другие волны» rolls a new seed. What was chosen last is remembered.

import { isFrameLike, tr } from '#core';
import type { Editor } from '../editor.ts';
import { pathData, randomSeed } from '../generators/blob.ts';
import { DEFAULT_WAVES, insertWaves, waveHexColors, wavePaths, type WaveSettings, type WaveStyle } from '../generators/waves.ts';
import { openDialog } from './dialog.ts';
import { h } from './dom.ts';

const KEY = 'cs-waves';
const SVG = 'http://www.w3.org/2000/svg';
const PREVIEW_W = 300;
const PREVIEW_MAX_H = 220;

function saved(): WaveSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<WaveSettings> | null;
    return { ...DEFAULT_WAVES, ...(v ?? {}) };
  } catch {
    return { ...DEFAULT_WAVES };
  }
}

/** Opens the window; «Вставить» puts the waves on the canvas (into the selected frame, along its edge). */
export async function openWavesDialog(editor: Editor): Promise<void> {
  const d = editor.doc;
  if (d.readOnly) return void editor.toast(tr('Только просмотр: изменения не сохраняются.'));
  const s = saved();
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  const frameWidth = only && isFrameLike(d.type(only)) && d.type(only) !== 'INSTANCE' && !editor.isInstanceLayer(only) ? (d.get(only, 'width') as number) : null;

  const svg = document.createElementNS(SVG, 'svg');
  const layers = document.createElementNS(SVG, 'g');
  svg.append(layers);

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
  const number = (label: string, min: number, max: number, get: () => number, set: (v: number) => void, disabled = false) => {
    const input = h('input', { class: 'dialog-input', type: 'number', min: String(min), max: String(max), step: '1', value: String(get()), 'aria-label': label, disabled }) as HTMLInputElement;
    input.addEventListener('input', () => {
      const v = Math.round(Number(input.value));
      if (Number.isFinite(v) && v >= min && v <= max) set(v);
      draw();
    });
    return input;
  };

  const style = h(
    'select',
    { class: 'dialog-input', 'aria-label': tr('Вид') },
    ...([
      ['smooth', tr('Плавные')],
      ['peaks', tr('Острые')],
      ['steps', tr('Ступени')],
      ['zigzag', tr('Зигзаг')],
      ['arc', tr('Дуга')],
      ['slope', tr('Наклон')],
      ['torn', tr('Рваный край')],
      ['clouds', tr('Облака')],
    ] as const).map(([v, label]) => h('option', { value: v, selected: s.style === v }, label)),
  ) as HTMLSelectElement;
  style.addEventListener('change', () => {
    s.style = style.value as WaveStyle;
    draw();
  });

  const seed = number(tr('Номер формы'), 1, 999_999, () => s.seed, (v) => (s.seed = v));
  const roll = h('button', { class: 'text-button', type: 'button', title: tr('Новые случайные волны с теми же настройками') }, tr('Другие волны'));
  roll.addEventListener('click', () => {
    s.seed = randomSeed();
    seed.value = String(s.seed);
    draw();
  });

  const width = number(tr('Ширина'), 16, 10_000, () => frameWidth ?? s.width, (v) => (s.width = v), frameWidth !== null);
  const height = number(tr('Высота'), 16, 4000, () => s.areaHeight, (v) => (s.areaHeight = v));

  const color = h('input', { type: 'color', value: s.color, 'aria-label': tr('Цвет заднего слоя') }) as HTMLInputElement;
  const color2 = h('input', { type: 'color', value: s.color2, 'aria-label': tr('Цвет переднего слоя') }) as HTMLInputElement;
  color.addEventListener('input', () => {
    s.color = color.value.toUpperCase();
    draw();
  });
  color2.addEventListener('input', () => {
    s.color2 = color2.value.toUpperCase();
    draw();
  });
  const flip = h('input', { type: 'checkbox', checked: s.flip }) as HTMLInputElement;
  flip.addEventListener('change', () => {
    s.flip = flip.checked;
    draw();
  });

  function draw(): void {
    const w = frameWidth ?? s.width;
    const k = Math.min(PREVIEW_W / w, PREVIEW_MAX_H / s.areaHeight);
    const pw = Math.max(1, w * k);
    const ph = Math.max(1, s.areaHeight * k);
    svg.setAttribute('viewBox', `0 0 ${w} ${s.areaHeight}`);
    svg.setAttribute('width', String(Math.round(pw)));
    svg.setAttribute('height', String(Math.round(ph)));
    const colors = waveHexColors(s);
    layers.replaceChildren(
      ...wavePaths({ ...s, width: w }).map((path, i) => {
        const el = document.createElementNS(SVG, 'path');
        el.setAttribute('d', pathData(path));
        el.setAttribute('fill', colors[i]!);
        return el;
      }),
    );
    color.hidden = s.layers === 1;
  }
  draw();

  const ok = await openDialog({
    title: tr('Волны'),
    confirm: tr('Вставить'),
    cancel: tr('Отмена'),
    body: [
      h(
        'div',
        { class: 'gen-dialog gen-wide' },
        h('div', { class: 'gen-preview gen-preview-waves' }, svg as unknown as HTMLElement),
        h(
          'div',
          { class: 'gen-controls' },
          range(tr('Слои'), 1, 6, () => s.layers, (v) => (s.layers = v)),
          range(tr('Высота волн'), 0, 100, () => s.height, (v) => (s.height = v)),
          range(tr('Частота'), 2, 20, () => s.frequency, (v) => (s.frequency = v)),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Вид')), style),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Номер формы')), h('span', { class: 'gen-row' }, seed, roll)),
          h('div', { class: 'gen-row' }, h('label', { class: 'dialog-field' }, h('span', {}, tr('Ширина, px')), width), h('label', { class: 'dialog-field' }, h('span', {}, tr('Высота, px')), height)),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Цвета: сзади → спереди')), h('span', { class: 'gen-row' }, color, color2)),
          h('label', { class: 'dialog-check' }, flip, h('span', {}, tr('Волны сверху'))),
        ),
      ),
      h('p', { class: 'dialog-hint' }, frameWidth !== null ? tr('Выделен фрейм: волны встанут по его ширине к нижнему краю (с «Волны сверху» — к верхнему) и будут тянуться вместе с ним.') : tr('Выделите фрейм — волны встанут по его ширине к его краю. Каждый слой — обычный вектор.')),
    ],
    focus: () => roll,
  });
  if (!ok) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not remembered — the next window starts from the defaults.
  }
  insertWaves(editor, s);
}
