// «Градиентный фон» window (FEAT-162): the background is previewed as the settings
// change; «Другой фон» rolls a new seed, ready palettes set all the colours at once.
// What was chosen last is remembered.

import { isFrameLike, tr } from '#core';
import type { Editor } from '../editor.ts';
import { auroraBlur, backdropSpots, DEFAULT_BACKDROP, insertBackdrop, spotPath, type BackdropSettings, type BackdropStyle } from '../generators/backdrop.ts';
import { pathData, randomSeed } from '../generators/blob.ts';
import { openDialog } from './dialog.ts';
import { h } from './dom.ts';

const KEY = 'cs-backdrop';
const SVG = 'http://www.w3.org/2000/svg';
const PREVIEW_W = 300;
const PREVIEW_MAX_H = 220;

/** Ready palettes: the base, then the spots. */
const PALETTES: { name: string; base: string; colors: string[] }[] = [
  { name: tr('Сирень'), base: '#F4F1FF', colors: ['#7C5CFF', '#FF7EB6', '#3CC6F0'] },
  { name: tr('Закат'), base: '#FFF3E6', colors: ['#FF6B4A', '#FFB84D', '#E8457C'] },
  { name: tr('Море'), base: '#E9F7FB', colors: ['#1FA2C7', '#4FD1A5', '#3B5BDB'] },
  { name: tr('Мята'), base: '#F0FBF5', colors: ['#38C98B', '#B8E86B', '#2BB5B5'] },
  { name: tr('Ночь'), base: '#0E1027', colors: ['#5B3CF0', '#E2409B', '#1F8FFF'] },
  { name: tr('Песок'), base: '#FAF5EC', colors: ['#D9A066', '#C97B63', '#E6C79C'] },
];

function saved(): BackdropSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<BackdropSettings> | null;
    const s = { ...DEFAULT_BACKDROP, ...(v ?? {}) };
    return { ...s, colors: Array.isArray(s.colors) && s.colors.length === 3 ? [...s.colors] : [...DEFAULT_BACKDROP.colors] };
  } catch {
    return { ...DEFAULT_BACKDROP, colors: [...DEFAULT_BACKDROP.colors] };
  }
}

/** Opens the window; «Вставить» puts the background on the canvas (into the selected frame, behind everything). */
export async function openBackdropDialog(editor: Editor): Promise<void> {
  const d = editor.doc;
  if (d.readOnly) return void editor.toast(tr('Только просмотр: изменения не сохраняются.'));
  const s = saved();
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  const frame = only && isFrameLike(d.type(only)) && d.type(only) !== 'INSTANCE' && !editor.isInstanceLayer(only) ? { width: d.get(only, 'width') as number, height: d.get(only, 'height') as number } : null;
  const uid = Math.random().toString(36).slice(2);

  const svg = document.createElementNS(SVG, 'svg');
  const defs = document.createElementNS(SVG, 'defs');
  const body = document.createElementNS(SVG, 'g');
  body.setAttribute('clip-path', `url(#bd-clip-${uid})`);
  svg.append(defs, body);

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
    ...([['mesh', tr('Сетка')], ['aurora', tr('Аврора')]] as const).map(([v, label]) => h('option', { value: v, selected: s.style === v }, label)),
  ) as HTMLSelectElement;
  style.addEventListener('change', () => {
    s.style = style.value as BackdropStyle;
    draw();
  });

  const seed = number(tr('Номер формы'), 1, 999_999, () => s.seed, (v) => (s.seed = v));
  const roll = h('button', { class: 'text-button', type: 'button', title: tr('Новый случайный фон с теми же настройками') }, tr('Другой фон'));
  roll.addEventListener('click', () => {
    s.seed = randomSeed();
    seed.value = String(s.seed);
    draw();
  });

  const width = number(tr('Ширина'), 16, 10_000, () => frame?.width ?? s.width, (v) => (s.width = v), frame !== null);
  const height = number(tr('Высота'), 16, 10_000, () => frame?.height ?? s.height, (v) => (s.height = v), frame !== null);

  const colorInput = (label: string, get: () => string, set: (v: string) => void) => {
    const input = h('input', { type: 'color', value: get(), 'aria-label': label }) as HTMLInputElement;
    input.addEventListener('input', () => {
      set(input.value.toUpperCase());
      draw();
    });
    return input;
  };
  const base = colorInput(tr('Цвет фона'), () => s.base, (v) => (s.base = v));
  const spotColors = [0, 1, 2].map((i) => colorInput(tr('Цвет пятна {0}', i + 1), () => s.colors[i]!, (v) => (s.colors[i] = v)));

  const palettes = h(
    'span',
    { class: 'gen-palettes' },
    ...PALETTES.map((p) => {
      const chip = h('button', { class: 'gen-palette', type: 'button', title: p.name, 'aria-label': p.name, style: `background: linear-gradient(135deg, ${p.colors.join(', ')}); box-shadow: inset 0 0 0 3px ${p.base}` });
      chip.addEventListener('click', () => {
        s.base = p.base;
        s.colors = [...p.colors];
        base.value = p.base;
        spotColors.forEach((input, i) => (input.value = p.colors[i]!));
        draw();
      });
      return chip;
    }),
  );

  function draw(): void {
    const w = frame?.width ?? s.width;
    const ht = frame?.height ?? s.height;
    const k = Math.min(PREVIEW_W / w, PREVIEW_MAX_H / ht);
    svg.setAttribute('viewBox', `0 0 ${w} ${ht}`);
    svg.setAttribute('width', String(Math.max(1, Math.round(w * k))));
    svg.setAttribute('height', String(Math.max(1, Math.round(ht * k))));
    const clip = document.createElementNS(SVG, 'clipPath');
    clip.id = `bd-clip-${uid}`;
    const clipRect = document.createElementNS(SVG, 'rect');
    clipRect.setAttribute('width', String(w));
    clipRect.setAttribute('height', String(ht));
    clip.append(clipRect);
    const blur = document.createElementNS(SVG, 'filter');
    blur.id = `bd-blur-${uid}`;
    for (const [a, v] of [['x', '-50%'], ['y', '-50%'], ['width', '200%'], ['height', '200%']]) blur.setAttribute(a!, v!);
    const gauss = document.createElementNS(SVG, 'feGaussianBlur');
    gauss.setAttribute('stdDeviation', String(auroraBlur({ ...s, width: w, height: ht })));
    blur.append(gauss);
    const nodes: SVGElement[] = [];
    const bg = document.createElementNS(SVG, 'rect');
    bg.setAttribute('width', String(w));
    bg.setAttribute('height', String(ht));
    bg.setAttribute('fill', s.base);
    nodes.push(bg);
    const grads: SVGElement[] = [];
    const solidPart = (1 - s.softness / 100) * 0.6;
    backdropSpots({ ...s, width: w, height: ht }).forEach((spot, i) => {
      const hex = `rgb(${Math.round(spot.color.r * 255)} ${Math.round(spot.color.g * 255)} ${Math.round(spot.color.b * 255)})`;
      const path = spotPath(spot);
      if (path) {
        const el = document.createElementNS(SVG, 'path');
        el.setAttribute('d', pathData(path));
        el.setAttribute('fill', hex);
        el.setAttribute('opacity', '0.9');
        el.setAttribute('filter', `url(#bd-blur-${uid})`);
        nodes.push(el);
        return;
      }
      const g = document.createElementNS(SVG, 'radialGradient');
      g.id = `bd-g-${uid}-${i}`;
      for (const [offset, opacity] of [[0, 1], [solidPart, 1], [1, 0]] as const) {
        const stop = document.createElementNS(SVG, 'stop');
        stop.setAttribute('offset', String(offset));
        stop.setAttribute('stop-color', hex);
        stop.setAttribute('stop-opacity', String(opacity));
        g.append(stop);
      }
      grads.push(g);
      const el = document.createElementNS(SVG, 'ellipse');
      el.setAttribute('cx', String(spot.x + spot.width / 2));
      el.setAttribute('cy', String(spot.y + spot.height / 2));
      el.setAttribute('rx', String(spot.width / 2));
      el.setAttribute('ry', String(spot.height / 2));
      el.setAttribute('fill', `url(#${g.id})`);
      nodes.push(el);
    });
    defs.replaceChildren(clip, blur, ...grads);
    body.replaceChildren(...nodes);
  }
  draw();

  const ok = await openDialog({
    title: tr('Градиентный фон'),
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
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Вид')), style),
          range(tr('Пятна'), 2, 8, () => s.spots, (v) => (s.spots = v)),
          range(tr('Мягкость'), 0, 100, () => s.softness, (v) => (s.softness = v)),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Номер формы')), h('span', { class: 'gen-row' }, seed, roll)),
          h('div', { class: 'dialog-field' }, h('span', {}, tr('Палитры')), palettes),
          h('label', { class: 'dialog-field' }, h('span', {}, tr('Фон и пятна')), h('span', { class: 'gen-row' }, base, ...spotColors)),
          h('div', { class: 'gen-row' }, h('label', { class: 'dialog-field' }, h('span', {}, tr('Ширина, px')), width), h('label', { class: 'dialog-field' }, h('span', {}, tr('Высота, px')), height)),
        ),
      ),
      h('p', { class: 'dialog-hint' }, frame ? tr('Выделен фрейм: фон заполнит его целиком, встанет под всё содержимое и будет тянуться вместе с ним.') : tr('Выделите фрейм или слайд — фон заполнит его целиком. Каждое пятно — обычный слой, его можно сдвинуть или перекрасить.')),
    ],
    focus: () => roll,
  });
  if (!ok) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Not remembered — the next window starts from the defaults.
  }
  insertBackdrop(editor, s);
}
