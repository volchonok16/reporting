// One fill or stroke in the properties panel (BUG-009, FEAT-008): a type switch
// (colour, linear / radial gradient, image) and the controls of that type.

import { tr } from '#core';
import { removeBackgroundFromBytes } from '../remove-bg.ts';
import { base64ToBytes, isGradient, rgba, type Color, type Document, type GradientPaint, type ImageFilters, type ImagePaint, type ImageScaleMode, type Paint, type PatternPaint, type Transaction } from '#core';
import { pickImageFiles, readImageFile } from '../images.ts';
import { h, icon } from './dom.ts';
import { ColorField, MIXED, NumberField, SelectField, type Field } from './fields.ts';

type PaintType = Paint['type'];

export interface PaintHost {
  doc: Document;
  add<F extends Field>(field: F): F;
  /** The paint as it is now (on the first selected object), or null if it is gone. */
  read(): Paint | null;
  /** Replaces the paint (null removes it); `extra` runs in the same transaction (e.g. storing an image). */
  write(next: Paint | null, extra?: (tx: Transaction) => Paint): void;
  toast(message: string): void;
  /** Continuous edit (dragging a gradient stop) as one undo step. */
  live(next: Paint | null, phase: 'start' | 'update' | 'end'): void;
  /** Which gradient stop is selected (shared with the canvas handles). */
  gradient: { selected(): number | null; select(stop: number): void };
  /** Wraps the colour field of a solid paint (e.g. with a "bind variable" control). */
  wrapColor?(field: Field): HTMLElement;
  /** The same for the colour of a gradient stop. */
  wrapStop?(field: Field, stop: number): HTMLElement;
  /** Opens "Crop picture" (layers only). */
  crop?(): void;
  /** Opens "Erase with a brush" (layers only). */
  erase?(): void;
  /** Removes the background, with the brushes' window for a photo (layers only). */
  removeBg?(): void;
  /** Layers a pattern can repeat (not the painted layers themselves). */
  sources?(): { value: string; label: string }[];
}

const TYPE_CHOICES: { value: PaintType; label: string }[] = [
  { value: 'SOLID', label: tr('Сплошной цвет') },
  { value: 'GRADIENT_LINEAR', label: tr('Линейный градиент') },
  { value: 'GRADIENT_RADIAL', label: tr('Радиальный градиент') },
  { value: 'GRADIENT_ANGULAR', label: tr('Угловой градиент') },
  { value: 'GRADIENT_DIAMOND', label: tr('Ромбовидный градиент') },
  { value: 'IMAGE', label: tr('Изображение или видео') },
  { value: 'PATTERN', label: tr('Узор') },
];

const SCALE_CHOICES: { value: ImageScaleMode; label: string }[] = [
  { value: 'FILL', label: tr('Заполнить') },
  { value: 'FIT', label: tr('Вписать') },
  { value: 'STRETCH', label: tr('Растянуть') },
  { value: 'TILE', label: tr('Плиткой') },
];

/** Main colour of any paint: used when switching types so the look carries over. */
function mainColor(paint: Paint): Color {
  if (paint.type === 'SOLID') return paint.color;
  if (paint.type === 'IMAGE' || paint.type === 'PATTERN') return rgba(0.85, 0.85, 0.85);
  return paint.stops[0]?.color ?? rgba(0, 0, 0);
}

export function convertPaint(paint: Paint, type: Exclude<PaintType, 'IMAGE'>): Paint {
  const base = { opacity: paint.opacity, visible: paint.visible, ...(paint.blendMode ? { blendMode: paint.blendMode } : {}) };
  if (type === 'SOLID') return { type: 'SOLID', color: { ...mainColor(paint), a: 1 }, ...base };
  if (type === 'PATTERN') return { type: 'PATTERN', sourceId: null, tileType: 'RECTANGULAR', scale: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START', ...base };
  const stops =
    isGradient(paint)
      ? paint.stops
      : [
          { position: 0, color: { ...mainColor(paint), a: 1 } },
          { position: 1, color: { ...mainColor(paint), a: 0 } },
        ];
  return type === 'GRADIENT_LINEAR'
    ? { type, stops, from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 }, ...base }
    : { type, stops, from: { x: 0.5, y: 0.5 }, to: { x: 1, y: 0.5 }, ...base };
}

export function gradientCss(paint: GradientPaint, angle = 90): string {
  const stops = [...paint.stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => `rgba(${Math.round(s.color.r * 255)},${Math.round(s.color.g * 255)},${Math.round(s.color.b * 255)},${s.color.a}) ${Math.round(s.position * 100)}%`)
    .join(', ');
  if (paint.type === 'GRADIENT_LINEAR') return `linear-gradient(${angle}deg, ${stops})`;
  // A swatch: the angular one turns from its start; a diamond looks closest to a radial one this small.
  if (paint.type === 'GRADIENT_ANGULAR') return `conic-gradient(from ${gradientAngle(paint) + 90}deg, ${stops})`;
  return `radial-gradient(circle, ${stops})`;
}

/** Angle of a linear gradient in degrees, 0 = left→right, clockwise (screen y down). */
export function gradientAngle(paint: GradientPaint): number {
  const a = (Math.atan2(paint.to.y - paint.from.y, paint.to.x - paint.from.x) * 180) / Math.PI;
  return Math.round(((a % 360) + 360) % 360);
}

export function withAngle(paint: GradientPaint, degrees: number): GradientPaint {
  const r = (degrees * Math.PI) / 180;
  // An angular gradient turns round its centre: the second handle moves on the circle.
  if (paint.type === 'GRADIENT_ANGULAR') {
    const len = Math.max(0.05, Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y));
    const round = (v: number) => Math.round(v * 10000) / 10000;
    return { ...paint, to: { x: round(paint.from.x + Math.cos(r) * len), y: round(paint.from.y + Math.sin(r) * len) } };
  }
  const half = Math.max(0.05, Math.hypot(paint.to.x - paint.from.x, paint.to.y - paint.from.y) / 2);
  const cx = (paint.from.x + paint.to.x) / 2;
  const cy = (paint.from.y + paint.to.y) / 2;
  const dx = Math.cos(r) * half;
  const dy = Math.sin(r) * half;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return { ...paint, from: { x: round(cx - dx), y: round(cy - dy) }, to: { x: round(cx + dx), y: round(cy + dy) } };
}

const urls = new Map<string, string>();
/** Object URL for an image resource, for previews in the panel. */
export function imageUrl(doc: Document, hash: string): string | null {
  const cached = urls.get(hash);
  if (cached) return cached;
  const blob = doc.store.blobs.get(hash);
  if (!blob) return null;
  const url = URL.createObjectURL(new Blob([base64ToBytes(blob.data) as BlobPart], { type: blob.mime }));
  urls.set(hash, url);
  return url;
}

/** Asks for an image file and returns a paint that stores it (or null if cancelled). */
/** Clears a plain background of the image fill (no model: colour flood fill from the edges). */
async function removeBackground(host: PaintHost, button: HTMLButtonElement): Promise<void> {
  const p = host.read();
  if (!p || p.type !== 'IMAGE') return;
  const blob = host.doc.store.blobs.get(p.imageHash);
  if (!blob) return;
  button.disabled = true;
  try {
    const res = await removeBackgroundFromBytes(base64ToBytes(blob.data), blob.mime);
    if ('error' in res) {
      host.toast(res.error);
      return;
    }
    // The cut-out is a new picture: an earlier crop no longer applies to it.
    host.write(null, (tx) => ({ ...p, imageHash: tx.addBlob(res.png, 'image/png'), crop: undefined }));
    host.toast(tr('Фон удалён ({0}% картинки). Отменить — Mod+Z.', Math.round(res.removed * 100)).replace('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'));
  } finally {
    button.disabled = false;
  }
}

async function chooseImage(host: PaintHost, previous: Paint, given?: File): Promise<void> {
  const file = given ?? (await pickImageFiles())[0];
  if (!file) return;
  let image;
  try {
    image = await readImageFile(file);
  } catch (err) {
    host.toast(file.type.startsWith('video/') && err instanceof Error ? err.message : tr('Не удалось открыть изображение: формат не поддерживается браузером'));
    return;
  }
  host.write(null, (tx) => {
    const imageHash = tx.addBlob(image.bytes, image.mime);
    const keep = previous.type === 'IMAGE' ? { scaleMode: previous.scaleMode, scale: previous.scale } : { scaleMode: 'FILL' as const, scale: 1 };
    return { type: 'IMAGE', imageHash, ...keep, opacity: previous.opacity, visible: previous.visible };
  });
}

/** "Choose a file" (or drop one here) for a paint switched to an image. */
function imagePrompt(host: PaintHost, previous: Paint, cancel: () => void): HTMLElement {
  const choose = h('button', { class: 'text-button primary', type: 'button', onclick: () => void chooseImage(host, previous) }, tr('Выбрать файл…'));
  const back = h('button', { class: 'text-button', type: 'button', onclick: cancel }, tr('Отмена'));
  const zone = h('div', { class: 'image-prompt' }, h('span', {}, tr('Выберите файл или перетащите картинку сюда')), h('div', { class: 'image-prompt-actions' }, choose, back));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (file) void chooseImage(host, previous, file);
  });
  queueMicrotask(() => choose.focus());
  return zone;
}

/**
 * Builds the controls of one paint: a header row (type, visibility, remove) and
 * the body for that type. Returns the elements to append.
 */
export function buildPaintItem(host: PaintHost, paint: Paint, title: string): HTMLElement {
  const read = () => host.read();
  const typeField = host.add(
    new SelectField<PaintType>(
      tr('{0}: тип', title),
      TYPE_CHOICES,
      () => read()?.type ?? null,
      (type) => {
        const current = read();
        if (!current || type === current.type) return;
        if (type === 'IMAGE') {
          // A file dialog opened from a list's change event is blocked by browsers (not a click):
          // ask for the file with a real button instead.
          content.replaceChildren(imagePrompt(host, current, () => {
            typeField.refresh();
            content.replaceChildren(...shown);
          }));
          return;
        }
        host.write(convertPaint(current, type));
      },
    ),
  );
  const visible = h('button', { class: 'icon-button', type: 'button', title: paint.visible ? tr('Скрыть') : tr('Показать'), 'aria-label': paint.visible ? tr('Скрыть') : tr('Показать'), onclick: () => { const p = read(); if (p) host.write({ ...p, visible: !p.visible }); } }, icon(paint.visible ? 'eye' : 'eyeOff'));
  const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить'), 'aria-label': tr('Удалить'), onclick: () => host.write(null) }, icon('minus'));
  const item = h('div', { class: `paint-item${paint.visible ? '' : ' muted'}` }, h('div', { class: 'paint-row' }, typeField.el, visible, remove));
  // The body of the paint; replaced by the file prompt while an image is being chosen.
  const content = h('div', { class: 'paint-body' });
  item.append(content);

  if (paint.type === 'SOLID') {
    const color = host.add(
      new ColorField({
        title,
        read: () => {
          const p = read();
          return p && p.type === 'SOLID' ? { color: p.color, opacity: p.opacity } : null;
        },
        write: (c, opacity) => {
          const p = read();
          if (p && p.type === 'SOLID') host.write({ ...p, color: { ...c, a: 1 }, opacity });
        },
      }),
    );
    content.append(host.wrapColor ? host.wrapColor(color) : color.el);
  } else if (paint.type === 'IMAGE') {
    content.append(buildImage(host, paint, title));
  } else if (paint.type === 'PATTERN') {
    content.append(buildPattern(host, title));
  } else {
    content.append(buildGradient(host, paint, title));
  }
  const shown = [...content.childNodes];
  return item;
}

function buildGradient(host: PaintHost, paint: GradientPaint, title: string): HTMLElement {
  const read = () => {
    const p = host.read();
    return p && isGradient(p) ? p : null;
  };
  const body = h('div', { class: 'gradient-editor' });
  body.append(buildGradientBar(host, read, paint.stops.length));
  // Show the gradient's handles on the canvas as soon as its controls are open.
  if (host.gradient.selected() === null) queueMicrotask(() => host.gradient.select(0));
  const controls = h('div', { class: 'grid-2' });
  if (paint.type === 'GRADIENT_LINEAR' || paint.type === 'GRADIENT_ANGULAR') {
    controls.append(
      host.add(
        new NumberField({
          label: tr('Угол'),
          title: paint.type === 'GRADIENT_ANGULAR' ? tr('Откуда начинается круг, в градусах (0 — вправо, 90 — вниз)') : tr('Направление градиента в градусах (0 — слева направо, 90 — сверху вниз)'),
          suffix: '°',
          read: () => {
            const p = read();
            return p ? gradientAngle(p) : null;
          },
          scrubAsCommits: true,
          write: (compute, phase) => {
            const p = read();
            if (!p || phase === 'start' || phase === 'update') return;
            host.write(withAngle(p, compute(gradientAngle(p))));
          },
        }),
      ).el,
    );
  }
  controls.append(
    h(
      'button',
      {
        class: 'text-button',
        type: 'button',
        title: tr('Поменять цвета местами'),
        onclick: () => {
          const p = read();
          if (p) host.write({ ...p, stops: p.stops.map((s) => ({ ...s, position: Math.round((1 - s.position) * 1000) / 1000 })).reverse() });
        },
      },
      h('span', {}, tr('Развернуть')),
    ),
  );
  body.append(controls);

  body.append(h('div', { class: 'subsection-title' }, tr('Точки')));
  // Listed by position, so the rows read left to right like the preview strip.
  const order = paint.stops.map((stop, index) => ({ stop, index })).sort((a, b) => a.stop.position - b.stop.position);
  order.forEach(({ index }) => {
    const position = host.add(
      new NumberField({
        label: '',
        title: tr('Положение точки, %'),
        suffix: '%',
        min: 0,
        max: 100,
        read: () => {
          const s = read()?.stops[index];
          return s ? Math.round(s.position * 100) : null;
        },
        scrubAsCommits: true,
        write: (compute, phase) => {
          const p = read();
          const s = p?.stops[index];
          if (!p || !s || phase === 'start' || phase === 'update') return;
          const stops = [...p.stops];
          stops[index] = { ...s, position: Math.max(0, Math.min(100, compute(s.position * 100))) / 100 };
          host.write({ ...p, stops });
        },
      }),
    );
    const color = host.add(
      new ColorField({
        title: tr('{0}: цвет точки', title),
        read: () => {
          const s = read()?.stops[index];
          return s ? { color: { ...s.color, a: 1 }, opacity: s.color.a } : null;
        },
        write: (c, opacity) => {
          const p = read();
          const s = p?.stops[index];
          if (!p || !s) return;
          const stops = [...p.stops];
          stops[index] = { ...s, color: { r: c.r, g: c.g, b: c.b, a: opacity } };
          host.write({ ...p, stops });
        },
      }),
    );
    const remove = h(
      'button',
      {
        class: 'icon-button',
        type: 'button',
        title: tr('Удалить точку'),
        'aria-label': tr('Удалить точку'),
        disabled: paint.stops.length <= 2,
        onclick: () => {
          const p = read();
          if (p && p.stops.length > 2) host.write({ ...p, stops: p.stops.filter((__, i) => i !== index) });
        },
      },
      icon('minus'),
    );
    const row = h('div', { class: 'stop-row' }, position.el, host.wrapStop ? host.wrapStop(color, index) : color.el, remove);
    row.addEventListener('pointerdown', () => host.gradient.select(index));
    host.add({ el: row, refresh: () => row.classList.toggle('selected', host.gradient.selected() === index) }).refresh();
    body.append(row);
  });
  body.append(
    h(
      'button',
      {
        class: 'text-button wide',
        type: 'button',
        onclick: () => {
          const p = read();
          if (!p) return;
          // New stop in the middle of the widest gap, with the colour between its neighbours.
          const sorted = [...p.stops].sort((a, b) => a.position - b.position);
          let best = 0;
          for (let i = 1; i < sorted.length - 1; i++) if (sorted[i + 1]!.position - sorted[i]!.position > sorted[best + 1]!.position - sorted[best]!.position) best = i;
          const a = sorted[best]!;
          const b = sorted[best + 1] ?? a;
          const mix = (x: number, y: number) => Math.round(((x + y) / 2) * 1000) / 1000;
          host.write({ ...p, stops: [...p.stops, { position: mix(a.position, b.position), color: { r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b), a: mix(a.color.a, b.color.a) } }] });
        },
      },
      icon('plus', 14),
      h('span', {}, tr('Добавить точку')),
    ),
  );
  body.append(
    host.add(
      new NumberField({
        label: tr('Непрозр.'),
        title: tr('Непрозрачность всего градиента'),
        suffix: '%',
        min: 0,
        max: 100,
        read: () => {
          const p = read();
          return p ? Math.round(p.opacity * 100) : null;
        },
        scrubAsCommits: true,
        write: (compute, phase) => {
          const p = read();
          if (!p || phase === 'start' || phase === 'update') return;
          host.write({ ...p, opacity: Math.max(0, Math.min(100, compute(p.opacity * 100))) / 100 });
        },
      }),
    ).el,
  );
  return body;
}

/** Interpolated colour of a gradient at `t` (0..1). */
export function colorAt(paint: GradientPaint, t: number): { r: number; g: number; b: number; a: number } {
  const stops = [...paint.stops].sort((a, b) => a.position - b.position);
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 1 };
  if (t <= stops[0]!.position) return { ...stops[0]!.color };
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (t <= b.position) {
      const k = b.position === a.position ? 0 : (t - a.position) / (b.position - a.position);
      const mix = (x: number, y: number) => Math.round((x + (y - x) * k) * 1000) / 1000;
      return { r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b), a: mix(a.color.a, b.color.a) };
    }
  }
  return { ...stops[stops.length - 1]!.color };
}

/** Adds a stop at `t` with the colour the gradient already has there. */
export function addStop(paint: GradientPaint, t: number): GradientPaint {
  const position = Math.round(Math.min(1, Math.max(0, t)) * 1000) / 1000;
  return { ...paint, stops: [...paint.stops, { position, color: colorAt(paint, position) }] };
}

/**
 * The gradient strip with draggable stop markers (BUG-015). Markers are built
 * once; their positions and colours refresh in place, so a drag is never
 * interrupted by a rebuild of the panel.
 */
function buildGradientBar(host: PaintHost, read: () => GradientPaint | null, count: number): HTMLElement {
  const strip = h('div', { class: 'gradient-strip', title: tr('Щелчок — добавить точку') });
  const bar = h('div', { class: 'gradient-bar' }, strip);
  const markers: HTMLElement[] = [];
  const toT = (clientX: number) => {
    const r = strip.getBoundingClientRect();
    return r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  strip.addEventListener('pointerdown', (e) => {
    const p = read();
    if (!p) return;
    e.preventDefault();
    host.write(addStop(p, toT(e.clientX)));
    host.gradient.select(p.stops.length);
  });
  for (let index = 0; index < count; index++) {
    const marker = h('button', { class: 'gradient-stop', type: 'button', title: tr('Точка градиента: тяните, Delete — удалить'), 'aria-label': tr('Точка {0}', index + 1) }, h('span', { class: 'gradient-stop-color' }));
    marker.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      marker.focus();
      host.gradient.select(index);
      marker.setPointerCapture(e.pointerId);
      let started = false;
      const move = (ev: PointerEvent) => {
        const p = read();
        const stop = p?.stops[index];
        if (!p || !stop) return;
        if (!started) {
          started = true;
          host.live(null, 'start');
        }
        const stops = [...p.stops];
        stops[index] = { ...stop, position: Math.round(toT(ev.clientX) * 1000) / 1000 };
        host.live({ ...p, stops }, 'update');
      };
      const up = () => {
        marker.removeEventListener('pointermove', move);
        marker.removeEventListener('pointerup', up);
        marker.removeEventListener('pointercancel', up);
        if (started) host.live(null, 'end');
      };
      marker.addEventListener('pointermove', move);
      marker.addEventListener('pointerup', up);
      marker.addEventListener('pointercancel', up);
    });
    marker.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const p = read();
      if (!p) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && p.stops.length > 2) {
        host.write({ ...p, stops: p.stops.filter((_, i) => i !== index) });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const stop = p.stops[index];
        if (!stop) return;
        const step = (e.shiftKey ? 0.1 : 0.01) * (e.key === 'ArrowLeft' ? -1 : 1);
        const stops = [...p.stops];
        stops[index] = { ...stop, position: Math.round(Math.min(1, Math.max(0, stop.position + step)) * 1000) / 1000 };
        host.write({ ...p, stops });
      }
    });
    markers.push(marker);
    bar.append(marker);
  }
  host.add({
    el: bar,
    refresh: () => {
      const p = read();
      if (!p) return;
      strip.style.background = `${gradientCss({ ...p, type: 'GRADIENT_LINEAR' }, 90)}, repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0 / 8px 8px`;
      const selected = host.gradient.selected();
      markers.forEach((marker, i) => {
        const stop = p.stops[i];
        marker.hidden = !stop;
        if (!stop) return;
        marker.style.left = `${stop.position * 100}%`;
        (marker.firstElementChild as HTMLElement).style.background = `rgba(${Math.round(stop.color.r * 255)},${Math.round(stop.color.g * 255)},${Math.round(stop.color.b * 255)},${stop.color.a})`;
        marker.classList.toggle('selected', selected === i);
      });
    },
  }).refresh();
  return bar;
}

function buildImage(host: PaintHost, paint: ImagePaint, title: string): HTMLElement {
  const read = () => {
    const p = host.read();
    return p && p.type === 'IMAGE' ? p : null;
  };
  const body = h('div', { class: 'image-editor' });
  const thumb = h('div', { class: 'image-thumb', title: tr('Заменить изображение'), role: 'button', tabindex: 0 });
  host.add({
    el: thumb,
    refresh: () => {
      const p = read();
      const url = p ? imageUrl(host.doc, p.imageHash) : null;
      // A video has no picture for CSS: its first frame plays in a small video instead.
      const video = p ? host.doc.store.blobs.get(p.imageHash)?.mime.startsWith('video/') : false;
      thumb.style.backgroundImage = url && !video ? `url("${url}")` : '';
      thumb.classList.toggle('missing', !url);
      thumb.replaceChildren(url ? (video ? h('video', { src: url, muted: true, loop: true, autoplay: true, playsinline: true, class: 'image-thumb-video' }) : '') : tr('Нет файла'));
    },
  }).refresh();
  const replace = () => {
    const p = read();
    if (p) void chooseImage(host, p);
  };
  thumb.addEventListener('click', replace);
  thumb.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') replace();
    e.stopPropagation();
  });
  const mode = host.add(
    new SelectField<ImageScaleMode>(
      tr('{0}: размещение изображения', title),
      SCALE_CHOICES,
      () => read()?.scaleMode ?? null,
      (scaleMode) => {
        const p = read();
        if (p) host.write({ ...p, scaleMode });
      },
    ),
  );
  const opacity = host.add(
    new NumberField({
      label: tr('Непрозр.'),
      title: tr('Непрозрачность изображения'),
      suffix: '%',
      min: 0,
      max: 100,
      read: () => {
        const p = read();
        return p ? Math.round(p.opacity * 100) : null;
      },
      scrubAsCommits: true,
      write: (compute, phase) => {
        const p = read();
        if (!p || phase === 'start' || phase === 'update') return;
        host.write({ ...p, opacity: Math.max(0, Math.min(100, compute(p.opacity * 100))) / 100 });
      },
    }),
  );
  const side = h('div', { class: 'image-controls' }, mode.el, opacity.el);
  if (paint.scaleMode === 'TILE') {
    side.append(
      host.add(
        new NumberField({
          label: tr('Масштаб'),
          title: tr('Размер плитки относительно исходного размера картинки'),
          suffix: '%',
          min: 1,
          read: () => {
            const p = read();
            return p ? Math.round(p.scale * 100) : null;
          },
          scrubAsCommits: true,
          write: (compute, phase) => {
            const p = read();
            if (!p || phase === 'start' || phase === 'update') return;
            host.write({ ...p, scale: Math.max(1, compute(p.scale * 100)) / 100 });
          },
        }),
      ).el,
    );
  }
  // Rotate 90° (as in Figma): the picture turns inside the fill, the layer stays.
  const rotate = h(
    'button',
    {
      class: 'icon-button',
      type: 'button',
      title: tr('Повернуть изображение на 90° по часовой'),
      'aria-label': tr('Повернуть изображение на 90° по часовой'),
      onclick: () => {
        const p = read();
        // A mirrored picture turns the other way inside: still clockwise on the screen.
        const step = !!p?.flipX !== !!p?.flipY ? 270 : 90;
        if (p) host.write({ ...p, rotation: (((p.rotation ?? 0) + step) % 360) as 0 | 90 | 180 | 270 });
      },
    },
    icon('rotate'),
  );
  side.append(rotate);
  const removeBg = h('button', { class: 'text-button wide', type: 'button', title: tr('Однотонный фон уходит сразу; у фото — окно, где можно поправить вырезку кистями «Оставить» и «Убрать». Картинка никуда не загружается.') }, h('span', {}, tr('Удалить фон')));
  removeBg.addEventListener('click', () => (host.removeBg ? host.removeBg() : void removeBackground(host, removeBg)));
  const crop = host.crop ? h('button', { class: 'text-button wide', type: 'button', onclick: () => host.crop?.() }, h('span', {}, tr('Обрезать…'))) : null;
  const erase = host.erase ? h('button', { class: 'text-button wide', type: 'button', title: tr('Стереть часть картинки кистью — мягкой или рваной; стёртое можно вернуть'), onclick: () => host.erase?.() }, h('span', {}, tr('Стереть кистью…'))) : null;
  body.append(h('div', { class: 'image-row' }, thumb, side), h('div', { class: 'image-actions' }, h('button', { class: 'text-button wide', type: 'button', onclick: replace }, h('span', {}, tr('Заменить изображение…'))), crop, erase, removeBg), buildAdjustments(host, read));
  return body;
}

const NO_FILTERS: ImageFilters = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 };

/** Photo adjustments of an image fill (Figma's sliders): −100…100, 0 — as it is. */
function buildAdjustments(host: PaintHost, read: () => ImagePaint | null): HTMLElement {
  const rows: [keyof ImageFilters, string, string][] = [
    ['exposure', tr('Экспозиция'), tr('Светлее или темнее вся картинка')],
    ['contrast', tr('Контраст'), tr('Разница между светлым и тёмным')],
    ['saturation', tr('Насыщенность'), tr('Яркость цветов; −100 — чёрно-белая')],
    ['temperature', tr('Температура'), tr('Меньше — холоднее (синее), больше — теплее (янтарнее)')],
    ['tint', tr('Оттенок'), tr('Меньше — зеленее, больше — пурпурнее')],
    ['highlights', tr('Света'), tr('Только светлые места: темнее или ярче')],
    ['shadows', tr('Тени'), tr('Только тёмные места: глубже или светлее')],
  ];
  // One full-width field per adjustment: the names are long; drag the name to change the value.
  const fields = rows.map(([key, label, title]) =>
    h('div', { class: 'image-adjust-row' }, host.add(
      new NumberField({
        label,
        title,
        min: -100,
        max: 100,
        read: () => {
          const p = read();
          return p ? Math.round((p.filters?.[key] ?? 0) * 100) : null;
        },
        scrubAsCommits: true,
        write: (compute, phase) => {
          const p = read();
          if (!p || phase === 'start' || phase === 'update') return;
          const value = Math.max(-100, Math.min(100, Math.round(compute((p.filters?.[key] ?? 0) * 100)))) / 100;
          host.write({ ...p, filters: { ...NO_FILTERS, ...p.filters, [key]: value } });
        },
      }),
    ).el),
  );
  const reset = h('button', { class: 'text-button wide', type: 'button', onclick: () => { const p = read(); if (p) host.write({ ...p, filters: undefined }); } }, h('span', {}, tr('Сбросить настройки')));
  const box = h('details', { class: 'image-adjust' }, h('summary', {}, tr('Настройки изображения')), ...fields, reset);
  const p = read();
  if (p?.filters && Object.values(p.filters).some((v) => v !== 0)) box.open = true;
  return box;
}

const TILE_CHOICES: { value: PatternPaint['tileType']; label: string }[] = [
  { value: 'RECTANGULAR', label: tr('Сеткой') },
  { value: 'HORIZONTAL_HEXAGONAL', label: tr('Рядами со сдвигом') },
  { value: 'VERTICAL_HEXAGONAL', label: tr('Столбцами со сдвигом') },
];

const ALIGN_CHOICES: { value: PatternPaint['horizontalAlignment']; label: string }[] = [
  { value: 'START', label: tr('С левого края') },
  { value: 'CENTER', label: tr('По центру') },
  { value: 'END', label: tr('С правого края') },
];

/** A pattern fill: which layer repeats, how the tiles are laid, their size and spacing. */
function buildPattern(host: PaintHost, title: string): HTMLElement {
  const read = () => {
    const p = host.read();
    return p && p.type === 'PATTERN' ? p : null;
  };
  const sources = host.sources?.() ?? [];
  const source = host.add(
    new SelectField<string>(
      tr('{0}: источник узора', title),
      [{ value: '', label: tr('Выберите слой…') }, ...sources],
      () => read()?.sourceId ?? '',
      (v) => {
        const p = read();
        if (p) host.write({ ...p, sourceId: v || null });
      },
    ),
  );
  const tile = host.add(new SelectField(tr('{0}: раскладка плиток', title), TILE_CHOICES, () => read()?.tileType ?? null, (v) => { const p = read(); if (p) host.write({ ...p, tileType: v }); }));
  const align = host.add(new SelectField(tr('{0}: выравнивание узора', title), ALIGN_CHOICES, () => read()?.horizontalAlignment ?? null, (v) => { const p = read(); if (p) host.write({ ...p, horizontalAlignment: v }); }));
  const num = (label: string, hint: string, get: (p: PatternPaint) => number, set: (p: PatternPaint, v: number) => PatternPaint, min: number) =>
    host.add(
      new NumberField({
        label,
        title: hint,
        suffix: '%',
        min,
        read: () => {
          const p = read();
          return p ? Math.round(get(p) * 100) : null;
        },
        scrubAsCommits: true,
        write: (compute, phase) => {
          const p = read();
          if (!p || phase === 'start' || phase === 'update') return;
          host.write(set(p, Math.max(min, Math.round(compute(get(p) * 100))) / 100));
        },
      }),
    ).el;
  const empty = sources.length === 0 ? h('p', { class: 'hint' }, tr('Узор повторяет другой слой этой страницы или компонент: нарисуйте его и выберите здесь.')) : null;
  return h(
    'div',
    { class: 'pattern-editor' },
    source.el,
    empty,
    h('div', { class: 'grid-2' }, tile.el, align.el),
    h(
      'div',
      { class: 'grid-2' },
      num(tr('Масштаб'), tr('Размер плитки относительно источника'), (p) => p.scale, (p, v) => ({ ...p, scale: v }), 1),
      num(tr('Непрозр.'), tr('Непрозрачность узора'), (p) => p.opacity, (p, v) => ({ ...p, opacity: Math.min(1, v) }), 0),
      num(tr('Промежуток X'), tr('Расстояние между плитками по горизонтали, доля ширины плитки'), (p) => p.spacing.x, (p, v) => ({ ...p, spacing: { ...p.spacing, x: v } }), 0),
      num(tr('Промежуток Y'), tr('Расстояние между плитками по вертикали, доля высоты плитки'), (p) => p.spacing.y, (p, v) => ({ ...p, spacing: { ...p.spacing, y: v } }), 0),
    ),
  );
}

export { MIXED };
