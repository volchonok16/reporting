// Our own colour picker (instead of the browser's system one), as in Figma:
// a saturation/brightness square, hue and opacity sliders, HEX and %, an
// eyedropper that takes a colour from the canvas, and the colours already
// used in the file. Opens under the swatch it belongs to; closes on Esc or a
// click outside.

import { tr } from '#core';
import { colorToHex, hexToColor, type Color } from '#core';
import { h, icon } from './dom.ts';

/** What the app gives the picker: the canvas eyedropper and the file's colours. */
export const colorPickerHost: {
  /** Starts the canvas eyedropper; the picked colour goes to `done`. */
  pick: ((done: (color: Color) => void) => void) | null;
  /** Colours used in the open file, most frequent first. */
  documentColors: (() => Color[]) | null;
  /** Opens «Набор цветов» for a colour; a colour picked there goes to `done`. */
  openKit: ((color: Color, done: (color: Color) => void) => void) | null;
} = { pick: null, documentColors: null, openKit: null };

interface Hsv {
  h: number;
  s: number;
  v: number;
}

function toHsv(c: Color): Hsv {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === c.r) hue = ((c.g - c.b) / d) % 6;
    else if (max === c.g) hue = (c.b - c.r) / d + 2;
    else hue = (c.r - c.g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max === 0 ? 0 : d / max, v: max };
}

/** Colour models of the value fields, as in Figma. */
type Model = 'HEX' | 'RGB' | 'HSL' | 'HSB' | 'CSS';
const MODELS: Model[] = ['HEX', 'RGB', 'HSL', 'HSB', 'CSS'];

function lastModel(): Model {
  try {
    const m = localStorage.getItem('cs.colorModel') as Model | null;
    return m && MODELS.includes(m) ? m : 'HEX';
  } catch {
    return 'HEX';
  }
}

function rememberModel(m: Model): void {
  try {
    localStorage.setItem('cs.colorModel', m);
  } catch {
    // Private mode: the choice lasts for this picker only.
  }
}

function toHsl(c: Color): { h: number; s: number; l: number } {
  const { h: hue, s, v } = toHsv(c);
  const l = v * (1 - s / 2);
  return { h: hue, s: l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l), l };
}

function fromHsl(hue: number, s: number, l: number): Color {
  const v = l + s * Math.min(l, 1 - l);
  return fromHsv({ h: hue, s: v === 0 ? 0 : 2 * (1 - l / v), v });
}

/** Any CSS colour («tomato», «rgb(…)», «hsl(…)», «#abc») through the browser's own parser; null — not a colour. */
function parseCss(text: string): { color: Color; alpha: number } | null {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.fillStyle = '#010203';
  probe.fillStyle = text.trim();
  const out = String(probe.fillStyle);
  if (out === '#010203' && !/^#?010203$/i.test(text.trim())) return null;
  if (out.startsWith('#')) return { color: hexToColor(out)!, alpha: 1 };
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(out);
  return m ? { color: { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255, a: 1 }, alpha: m[4] === undefined ? 1 : Number(m[4]) } : null;
}

function fromHsv({ h: hue, s, v }: Hsv): Color {
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5), g: f(3), b: f(1), a: 1 };
}

let open: { close: () => void } | null = null;

export interface ColorPickerOptions {
  anchor: HTMLElement;
  color: Color;
  opacity: number;
  /** Called while dragging and on every change. */
  onChange: (color: Color, opacity: number) => void;
  /** Hide the opacity controls (e.g. the page background). */
  noOpacity?: boolean;
}

/** Opens the picker under `anchor` (closing any other one). */
export function openColorPicker(options: ColorPickerOptions): void {
  open?.close();
  let hsv = toHsv(options.color);
  let opacity = options.opacity;
  const emit = () => options.onChange(fromHsv(hsv), opacity);

  const sv = h('div', { class: 'cp-sv', role: 'slider', 'aria-label': tr('Насыщенность и яркость'), tabindex: 0 }, h('div', { class: 'cp-sv-white' }), h('div', { class: 'cp-sv-black' }));
  const svKnob = h('div', { class: 'cp-knob' });
  sv.append(svKnob);
  const hue = h('div', { class: 'cp-slider cp-hue', role: 'slider', 'aria-label': tr('Оттенок'), tabindex: 0 });
  const hueKnob = h('div', { class: 'cp-slider-knob' });
  hue.append(hueKnob);
  const alpha = h('div', { class: 'cp-slider cp-alpha', role: 'slider', 'aria-label': tr('Непрозрачность'), tabindex: 0, hidden: !!options.noOpacity });
  const alphaFill = h('div', { class: 'cp-alpha-fill' });
  const alphaKnob = h('div', { class: 'cp-slider-knob' });
  alpha.append(alphaFill, alphaKnob);
  const hex = h('input', { class: 'field-input cp-hex', type: 'text', spellcheck: false, 'aria-label': 'HEX', maxLength: 7 });
  let model = lastModel();
  const modelSelect = h('select', { class: 'field-select cp-model', 'aria-label': tr('Цветовая модель'), title: tr('Цветовая модель') }, ...MODELS.map((m) => h('option', { value: m }, m)));
  modelSelect.value = model;
  // Three number fields (RGB, HSL, HSB) or one text (HEX, CSS).
  const parts = [0, 1, 2].map((i) => h('input', { class: 'field-input cp-part', type: 'text', inputmode: 'decimal', 'aria-label': String(i) }));
  const css = h('input', { class: 'field-input cp-css', type: 'text', spellcheck: false, 'aria-label': 'CSS' });
  const values = h('div', { class: 'cp-values' });
  const pct = h('input', { class: 'field-input cp-pct', type: 'text', inputmode: 'decimal', 'aria-label': tr('Непрозрачность, %'), hidden: !!options.noOpacity });
  const dropper = h('button', { class: 'icon-button cp-dropper', type: 'button', title: tr('Пипетка: взять цвет с холста (I)'), 'aria-label': tr('Пипетка') }, icon('eyedropper', 16));
  dropper.hidden = !colorPickerHost.pick;
  const kit = h('button', { class: 'icon-button cp-kit', type: 'button', title: tr('Набор цветов: оттенки, гармонии, контраст'), 'aria-label': tr('Набор цветов') }, icon('palette', 16));
  kit.hidden = !colorPickerHost.openKit;
  const swatches = h('div', { class: 'cp-swatches' });

  const render = () => {
    const c = fromHsv(hsv);
    const pure = colorToHex(fromHsv({ h: hsv.h, s: 1, v: 1 }));
    sv.style.background = pure;
    svKnob.style.left = `${hsv.s * 100}%`;
    svKnob.style.top = `${(1 - hsv.v) * 100}%`;
    svKnob.style.background = colorToHex(c);
    hueKnob.style.left = `${(hsv.h / 360) * 100}%`;
    alphaFill.style.background = `linear-gradient(to right, transparent, ${colorToHex(c)})`;
    alphaKnob.style.left = `${opacity * 100}%`;
    if (document.activeElement !== hex) hex.value = colorToHex(c).slice(1);
    if (document.activeElement !== pct) pct.value = String(Math.round(opacity * 100));
    const shown = model === 'RGB' ? [c.r * 255, c.g * 255, c.b * 255] : model === 'HSL' ? (() => { const x = toHsl(c); return [x.h, x.s * 100, x.l * 100]; })() : [hsv.h, hsv.s * 100, hsv.v * 100];
    parts.forEach((p, i) => {
      if (document.activeElement !== p) p.value = String(Math.round(shown[i]!));
    });
    if (document.activeElement !== css) {
      const [r, g, b] = [c.r, c.g, c.b].map((v) => Math.round(v * 255));
      css.value = opacity < 1 ? `rgb(${r} ${g} ${b} / ${Math.round(opacity * 100)}%)` : `rgb(${r} ${g} ${b})`;
    }
  };

  /** The value fields of the chosen model. */
  const layout = () => {
    const names = model === 'RGB' ? ['R', 'G', 'B'] : model === 'HSL' ? ['H', 'S', 'L'] : ['H', 'S', 'B'];
    parts.forEach((p, i) => p.setAttribute('aria-label', names[i]!));
    values.replaceChildren(...(model === 'HEX' ? [hex] : model === 'CSS' ? [css] : parts));
    pct.hidden = !!options.noOpacity || model === 'CSS';
    suffix.hidden = pct.hidden;
  };
  modelSelect.addEventListener('change', () => {
    model = modelSelect.value as Model;
    rememberModel(model);
    layout();
    render();
  });
  modelSelect.addEventListener('keydown', (e) => e.stopPropagation());
  const fromParts = () => {
    const n = parts.map((p) => Number(p.value.replace(',', '.')));
    if (n.some((v) => !Number.isFinite(v))) return;
    const k = (v: number, max: number) => Math.max(0, Math.min(max, v));
    if (model === 'RGB') hsv = toHsv({ r: k(n[0]!, 255) / 255, g: k(n[1]!, 255) / 255, b: k(n[2]!, 255) / 255, a: 1 });
    else if (model === 'HSL') hsv = toHsv(fromHsl(k(n[0]!, 360) % 360, k(n[1]!, 100) / 100, k(n[2]!, 100) / 100));
    else hsv = { h: k(n[0]!, 360) % 360, s: k(n[1]!, 100) / 100, v: k(n[2]!, 100) / 100 };
    emit();
  };
  for (const p of parts) p.addEventListener('change', () => {
    fromParts();
    render();
  });
  css.addEventListener('change', () => {
    const parsed = parseCss(css.value);
    if (parsed) {
      hsv = toHsv(parsed.color);
      if (!options.noOpacity) opacity = Math.round(parsed.alpha * 100) / 100;
      emit();
    }
    render();
  });

  /** Pointer drag on an element: `at` gets the position as 0..1 fractions. */
  const drag = (el: HTMLElement, at: (x: number, y: number) => void) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        at(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
        render();
        emit();
      };
      move(e);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
    });
  };
  drag(sv, (x, y) => {
    hsv = { ...hsv, s: x, v: 1 - y };
  });
  drag(hue, (x) => {
    hsv = { ...hsv, h: Math.min(359.9, x * 360) };
  });
  drag(alpha, (x) => {
    opacity = Math.round(x * 100) / 100;
  });
  // Arrow keys on the sliders.
  const keys = (el: HTMLElement, step: (d: number) => void) =>
    el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      step(d * (e.shiftKey ? 10 : 1));
      render();
      emit();
    });
  keys(hue, (d) => (hsv = { ...hsv, h: (hsv.h + d + 360) % 360 }));
  keys(alpha, (d) => (opacity = Math.max(0, Math.min(1, Math.round(opacity * 100 + d) / 100))));
  keys(sv, (d) => (hsv = { ...hsv, v: Math.max(0, Math.min(1, hsv.v + d / 100)) }));

  hex.addEventListener('change', () => {
    const c = hexToColor(hex.value);
    if (c) {
      hsv = toHsv(c);
      emit();
    }
    render();
  });
  pct.addEventListener('change', () => {
    const n = Number(pct.value.replace('%', '').replace(',', '.'));
    if (Number.isFinite(n)) {
      opacity = Math.max(0, Math.min(100, n)) / 100;
      emit();
    }
    render();
  });
  for (const input of [hex, pct, css, ...parts]) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
  }

  const suffix = h('span', { class: 'field-suffix' }, '%');
  suffix.hidden = !!options.noOpacity;
  const pop = h(
    'div',
    { class: 'color-picker', role: 'dialog', 'aria-label': tr('Выбор цвета') },
    sv,
    h('div', { class: 'cp-row' }, dropper, h('div', { class: 'cp-sliders' }, hue, alpha), kit),
    h('div', { class: 'cp-row cp-inputs' }, modelSelect, values, pct, suffix),
    swatches,
  );

  const colors = colorPickerHost.documentColors?.() ?? [];
  if (colors.length > 0) {
    swatches.append(h('div', { class: 'cp-swatches-title' }, tr('Цвета в файле')));
    const grid = h('div', { class: 'cp-swatch-grid' });
    for (const c of colors.slice(0, 24)) {
      const b = h('button', { class: 'cp-swatch', type: 'button', title: colorToHex(c), style: { background: colorToHex(c) } });
      b.addEventListener('click', () => {
        hsv = toHsv(c);
        render();
        emit();
      });
      grid.append(b);
    }
    swatches.append(grid);
  }

  const onDown = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node) && !options.anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (open?.close === close) open = null;
  };
  dropper.addEventListener('click', () => {
    // The picker steps aside while a colour is taken from the canvas.
    close();
    colorPickerHost.pick?.((c) => {
      hsv = toHsv(c);
      emit();
    });
  });
  kit.addEventListener('click', () => {
    // The kit takes over: the picker closes, colours picked there go to the same paint.
    close();
    colorPickerHost.openKit?.(fromHsv(hsv), (c) => {
      hsv = toHsv(c);
      emit();
    });
  });
  pop.addEventListener('keydown', (e) => e.stopPropagation());

  layout();
  document.body.append(pop);
  const r = options.anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - pr.width - 8, r.right - pr.width))}px`;
  pop.style.top = `${r.bottom + 6 + pr.height > innerHeight - 8 ? Math.max(8, r.top - pr.height - 6) : r.bottom + 6}px`;
  render();
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  open = { close };
}
