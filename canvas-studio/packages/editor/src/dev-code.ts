// Code for developers (section 14, FR-DEV): what a layer looks like as CSS,
// SwiftUI or Jetpack Compose, and the file's variables as CSS custom
// properties. Pure functions over the document, without the editor: the "Code"
// tab of the right panel shows them and tests check them.
//
// Values bound to a variable come as the variable (with the value as a
// fallback in CSS); the variable's name in code is its "code syntax" for the
// platform when set, else its name made into an identifier. Styles are named
// in comments, as in Figma's Dev Mode.

import { colorToHex, isAlias, isGradient, type Color, type Document, type Effect, type GridTrack, type NodeId, type Paint, type Sizing, type VariableLiteral } from '#core';
import { resolveInMode } from '#components';
import { featureString, variationString } from '#layout';

export type CodeLang = 'css' | 'swiftui' | 'compose';

export interface CodeOptions {
  /** CSS lengths in px or rem (borders and shadows stay in px). */
  unit: 'px' | 'rem';
  remBase: number;
}

export const DEFAULT_CODE_OPTIONS: CodeOptions = { unit: 'px', remBase: 16 };

export interface Decl {
  prop: string;
  value: string;
}

const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  const v = Math.round(n * f) / f;
  return Object.is(v, -0) ? 0 : v;
};

/** A name made into an identifier piece: "Brand/Primary 500" → "brand-primary-500". */
export function slug(name: string): string {
  return name
    .trim()
    .replace(/[/\s.]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function camel(name: string): string {
  const parts = slug(name).split(/[-_]+/).filter(Boolean);
  const s = parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join('');
  return /^\p{N}/u.test(s) ? `_${s}` : s || 'value';
}

/** The CSS custom property of a variable: its WEB code syntax, else from its name. */
export function cssVarName(doc: Document, variable: NodeId): string {
  const web = doc.get(variable, 'codeSyntax').WEB?.trim();
  if (web) {
    const inner = /^var\(\s*(--[^,\s)]+)/.exec(web)?.[1];
    return inner ?? (web.startsWith('--') ? web : `--${web}`);
  }
  return `--${slug(doc.get(variable, 'name')) || 'var'}`;
}

/** The name of a variable in Swift or Kotlin code: its code syntax, else camelCase of the name. */
export function platformVarName(doc: Document, variable: NodeId, platform: 'IOS' | 'ANDROID'): string {
  return doc.get(variable, 'codeSyntax')[platform]?.trim() || camel(doc.get(variable, 'name'));
}

/** The variable bound to a field of a layer (alive), or null. */
function bound(doc: Document, id: NodeId, field: string): NodeId | null {
  const v = doc.get(id, 'boundVariables')?.[field];
  return v && doc.store.isAlive(v) && doc.type(v) === 'VARIABLE' ? v : null;
}

// ---------- values ----------

export function cssColor(c: Color, opacity = 1): string {
  const a = round(c.a * opacity, 3);
  if (a >= 1) return colorToHex(c);
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${a})`;
}

function lengthCss(v: number, o: CodeOptions): string {
  if (round(v) === 0) return '0';
  return o.unit === 'rem' ? `${round(v / o.remBase, 4)}rem` : `${round(v)}px`;
}

const pxCss = (v: number) => (round(v) === 0 ? '0' : `${round(v)}px`);

/** A number field as CSS, through its variable when bound. */
function numberCss(doc: Document, id: NodeId, field: string, v: number, o: CodeOptions, toCss = (n: number) => lengthCss(n, o)): string {
  const variable = bound(doc, id, field);
  return variable ? `var(${cssVarName(doc, variable)}, ${toCss(v)})` : toCss(v);
}

function gradientAngle(p: { from: { x: number; y: number }; to: { x: number; y: number } }, w: number, h: number): number {
  const dx = (p.to.x - p.from.x) * w;
  const dy = (p.to.y - p.from.y) * h;
  // CSS: 0deg points up, angles go clockwise.
  return round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360, 1);
}

/** File name of a layer's picture (an image fill, a vector exported as SVG): from its name. */
export function assetName(doc: Document, id: NodeId): string {
  return slug(String(doc.get(id, 'name'))) || 'image';
}

/**
 * A standalone HTML file (html-export.ts) carries its pictures inside it: while
 * set, image fills become data URLs and vectors inline SVG instead of file names.
 */
let inline: { image(hash: string): string | null; vector(id: NodeId): string } | null = null;

export function withInlineAssets<T>(hooks: NonNullable<typeof inline>, fn: () => T): T {
  inline = hooks;
  try {
    return fn();
  } finally {
    inline = null;
  }
}

/** One paint as a CSS image or colour (null — hidden). */
export function paintCss(doc: Document, id: NodeId, field: string, p: Paint, w: number, h: number): string | null {
  if (!p.visible) return null;
  if (p.type === 'SOLID') {
    const variable = bound(doc, id, field);
    const value = cssColor(p.color, p.opacity);
    return variable ? `var(${cssVarName(doc, variable)}, ${value})` : value;
  }
  if (isGradient(p)) {
    const stops = p.stops.map((s) => `${cssColor(s.color, p.opacity)} ${round(s.position * 100, 1)}%`).join(', ');
    if (p.type === 'GRADIENT_LINEAR') return `linear-gradient(${gradientAngle(p, w, h)}deg, ${stops})`;
    // CSS turns from the top; ours starts toward the second handle.
    if (p.type === 'GRADIENT_ANGULAR') return `conic-gradient(from ${round(((Math.atan2((p.to.y - p.from.y) * h, (p.to.x - p.from.x) * w) * 180) / Math.PI + 90 + 360) % 360, 1)}deg at ${round(p.from.x * 100, 1)}% ${round(p.from.y * 100, 1)}%, ${stops})`;
    // A diamond has no CSS counterpart: the closest is a radial one.
    const rx = round(Math.hypot((p.to.x - p.from.x) * w, (p.to.y - p.from.y) * h));
    return `radial-gradient(${rx}px at ${round(p.from.x * 100, 1)}% ${round(p.from.y * 100, 1)}%, ${stops})`;
  }
  if (p.type !== 'IMAGE') return null;
  const size = { FILL: 'cover', FIT: 'contain', STRETCH: '100% 100%', TILE: 'auto' }[p.scaleMode];
  const src = inline?.image(p.imageHash) ?? `${assetName(doc, id)}.png`;
  return `url(${inline ? `"${src}"` : src}) center / ${size} ${p.scaleMode === 'TILE' ? 'repeat' : 'no-repeat'}`;
}

/** Visible paints, top first (the document keeps them bottom first, as they are drawn). */
function visiblePaints(doc: Document, id: NodeId, key: 'fills' | 'strokes'): { paint: Paint; field: string }[] {
  return doc
    .get(id, key)
    .map((paint, i) => ({ paint, field: `${key}/${i}` }))
    .filter((x) => x.paint.visible)
    .reverse();
}

const BLEND: Record<string, string> = {
  DARKEN: 'darken', MULTIPLY: 'multiply', COLOR_BURN: 'color-burn', LIGHTEN: 'lighten', SCREEN: 'screen', COLOR_DODGE: 'color-dodge', OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light', HARD_LIGHT: 'hard-light', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity',
  PLUS_DARKER: 'plus-darker', PLUS_LIGHTER: 'plus-lighter',
};

const ALIGN: Record<string, string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' };

function lineHeightCss(doc: Document, id: NodeId): string | null {
  const lh = doc.get(id, 'lineHeight');
  if (lh.unit === 'AUTO') return null;
  if (lh.unit === 'PX') return numberCss(doc, id, 'lineHeight', lh.value, DEFAULT_CODE_OPTIONS, pxCss);
  if (lh.unit === 'PERCENT') return `${round(lh.value / 100, 3)}`;
  return `${round(lh.value, 3)}`;
}

function shadowCss(e: Effect, text: boolean): string | null {
  if (!e.visible || (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW')) return null;
  if (text && e.type === 'INNER_SHADOW') return null;
  const parts = [pxCss(e.offset.x), pxCss(e.offset.y), pxCss(e.radius)];
  if (!text && e.spread) parts.push(pxCss(e.spread));
  return `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${parts.join(' ')} ${cssColor(e.color)}`;
}

/** Whether a layer is placed by its parent's auto layout. */
function inFlow(doc: Document, id: NodeId): { parent: NodeId; horizontal: boolean; grid: boolean } | null {
  const parent = doc.parent(id);
  if (!parent) return null;
  const mode = doc.get(parent, 'layoutMode');
  if (mode === 'NONE' || doc.get(id, 'positioning') === 'ABSOLUTE') return null;
  return { parent, horizontal: mode === 'HORIZONTAL', grid: mode === 'GRID' };
}

/** A grid track as CSS: px, fr, or auto (as large as its content). */
function trackCss(t: GridTrack): string {
  return t.kind === 'FIXED' ? `${round(t.value)}px` : t.kind === 'FR' ? `${round(t.value)}fr` : 'auto';
}

/** "repeat(3, 1fr)" for equal tracks, the list otherwise. */
function tracksCss(list: readonly GridTrack[]): string {
  const parts = list.map(trackCss);
  return parts.length > 1 && parts.every((p) => p === parts[0]) ? `repeat(${parts.length}, ${parts[0]})` : parts.join(' ');
}

/** Whether a layer sits at an exact place in a parent frame or group (not on the page, not in auto layout). */
function placed(doc: Document, id: NodeId): boolean {
  const parent = doc.parent(id);
  if (!parent) return false;
  const t = doc.type(parent);
  if (t === 'PAGE' || t === 'DOCUMENT' || t === 'SECTION') return false;
  return inFlow(doc, id) === null;
}

function sizeDecls(doc: Document, id: NodeId, o: CodeOptions): Decl[] {
  const out: Decl[] = [];
  const flow = inFlow(doc, id);
  const isText = doc.type(id) === 'TEXT';
  const autoText = isText ? doc.get(id, 'textAutoResize') : 'NONE';
  const axis = (key: 'width' | 'height', sizing: Sizing) => {
    const main = flow && !flow.grid && (key === 'width') === flow.horizontal;
    // In a grid a filling layer stretches over its cell (the default of a grid item); others keep their size.
    if (flow?.grid && (sizing.mode === 'FILL' || sizing.mode === 'FR')) return;
    if (sizing.mode === 'FILL') {
      // Filling a parent that hugs its content, CSS has nothing to fill: an empty dot in a hugging row came out
      // 0 px high and was lost. The size the editor gave it is the size.
      if (flow && doc.get(flow.parent, key === 'width' ? 'sizingH' : 'sizingV').mode === 'HUG') return void out.push({ prop: key, value: numberCss(doc, id, key, doc.get(id, key), o) });
      if (main) out.push({ prop: 'flex', value: '1 0 0' });
      else if (flow) out.push({ prop: 'align-self', value: 'stretch' });
      else out.push({ prop: key, value: '100%' });
      return;
    }
    if (sizing.mode === 'PERCENT') return void out.push({ prop: key, value: `${round(sizing.value)}%` });
    if (sizing.mode === 'FR') return void out.push({ prop: main ? 'flex' : key, value: main ? `${round(sizing.value)} 0 0` : '100%' });
    if (sizing.mode === 'HUG') return;
    // Text that grows with its content has no fixed width (or height).
    if (isText && (autoText === 'WIDTH_AND_HEIGHT' || (autoText === 'HEIGHT' && key === 'height'))) return;
    out.push({ prop: key, value: numberCss(doc, id, key, doc.get(id, key), o) });
  };
  axis('width', doc.get(id, 'sizingH'));
  axis('height', doc.get(id, 'sizingV'));
  for (const [key, prop] of [['minWidth', 'min-width'], ['maxWidth', 'max-width'], ['minHeight', 'min-height'], ['maxHeight', 'max-height']] as const) {
    const v = doc.get(id, key);
    if (v) out.push({ prop, value: v.unit === 'PERCENT' ? `${round(v.value)}%` : numberCss(doc, id, key, v.value, o) });
  }
  return out;
}

/**
 * CSS declarations of a layer: layout, size, place, look and, for text,
 * typography. Comments name the styles in use.
 */
export function cssDecls(doc: Document, id: NodeId, o: CodeOptions = DEFAULT_CODE_OPTIONS, tree = false): { decls: Decl[]; comments: string[] } {
  const d = doc;
  const type = d.type(id);
  const isText = type === 'TEXT';
  const w = d.get(id, 'width');
  const h = d.get(id, 'height');
  const out: Decl[] = [];
  const comments: string[] = [];
  const styleName = (sid: string | null) => (sid && d.store.isAlive(sid) ? String(d.get(sid, 'name')) : null);

  // Auto layout container.
  const mode = d.get(id, 'layoutMode');
  if (mode === 'GRID') {
    out.push({ prop: 'display', value: 'grid' });
    out.push({ prop: 'grid-template-columns', value: tracksCss(d.get(id, 'gridColumns')) });
    const rows = d.get(id, 'gridRows');
    if (rows.length) out.push({ prop: 'grid-template-rows', value: tracksCss(rows) });
    const cg = d.get(id, 'gridColumnGap');
    const rg = d.get(id, 'gridRowGap');
    if (cg || rg) out.push({ prop: 'gap', value: cg === rg ? `${round(rg)}px` : `${round(rg)}px ${round(cg)}px` });
    const pads = (['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const).map((k) => numberCss(d, id, k, d.get(id, k), o));
    if (pads.some((p) => p !== '0')) out.push({ prop: 'padding', value: pads[0] === pads[2] && pads[1] === pads[3] ? (pads[0] === pads[1] ? pads[0]! : `${pads[0]} ${pads[1]}`) : pads.join(' ') });
  } else if (mode !== 'NONE') {
    out.push({ prop: 'display', value: 'flex' });
    if (mode === 'VERTICAL') out.push({ prop: 'flex-direction', value: 'column' });
    const spacing = d.get(id, 'spacingMode');
    const justify = spacing === 'BETWEEN' ? 'space-between' : spacing === 'AROUND' ? 'space-around' : spacing === 'EVENLY' ? 'space-evenly' : ALIGN[d.get(id, 'primaryAlign')]!;
    if (justify !== 'flex-start') out.push({ prop: 'justify-content', value: justify });
    out.push({ prop: 'align-items', value: ALIGN[d.get(id, 'counterAlign')]! });
    if (d.get(id, 'layoutWrap')) out.push({ prop: 'flex-wrap', value: 'wrap' });
    // A negative gap (layers overlap) has no CSS form: the layers get a negative margin instead.
    if (spacing === 'FIXED' && d.get(id, 'itemSpacing') > 0) out.push({ prop: 'gap', value: numberCss(d, id, 'itemSpacing', d.get(id, 'itemSpacing'), o) });
    if (d.get(id, 'layoutWrap') && d.get(id, 'counterAxisSpacing')) out.push({ prop: 'row-gap', value: numberCss(d, id, 'counterAxisSpacing', d.get(id, 'counterAxisSpacing'), o) });
    if (d.get(id, 'layoutWrap') && d.get(id, 'counterAxisAlignContent') === 'SPACE_BETWEEN') out.push({ prop: 'align-content', value: 'space-between' });
    const pads = (['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const).map((k) => numberCss(d, id, k, d.get(id, k), o));
    if (pads.some((p) => p !== '0')) out.push({ prop: 'padding', value: pads[0] === pads[2] && pads[1] === pads[3] ? (pads[0] === pads[1] ? pads[0]! : `${pads[0]} ${pads[1]}`) : pads.join(' ') });
  }

  // Place in the parent's grid.
  const flow = inFlow(d, id);
  if (flow && !flow.grid) {
    const siblings = d.children(flow.parent).filter((c) => d.get(c, 'visible') !== false && d.get(c, 'positioning') !== 'ABSOLUTE');
    const index = siblings.indexOf(id);
    const gap = d.get(flow.parent, 'itemSpacing');
    if (gap < 0 && index > 0 && d.get(flow.parent, 'spacingMode') === 'FIXED') out.push({ prop: flow.horizontal ? 'margin-left' : 'margin-top', value: `${round(gap)}px` });
    // "First on top": the earlier layers are drawn over the later ones.
    if (d.get(flow.parent, 'itemReverseZIndex')) out.push({ prop: 'position', value: 'relative' }, { prop: 'z-index', value: String(siblings.length - index) });
  }
  if (flow?.grid) {
    const col = d.get(id, 'gridColumn');
    const row = d.get(id, 'gridRow');
    const cs = d.get(id, 'gridColumnSpan');
    const rs = d.get(id, 'gridRowSpan');
    if (col !== null) out.push({ prop: 'grid-column', value: cs > 1 ? `${col + 1} / span ${cs}` : String(col + 1) });
    else if (cs > 1) out.push({ prop: 'grid-column', value: `span ${cs}` });
    if (row !== null) out.push({ prop: 'grid-row', value: rs > 1 ? `${row + 1} / span ${rs}` : String(row + 1) });
    else if (rs > 1) out.push({ prop: 'grid-row', value: `span ${rs}` });
    const css = { MIN: 'start', CENTER: 'center', MAX: 'end' } as const;
    if (d.get(id, 'sizingH').mode !== 'FILL' && d.get(id, 'sizingH').mode !== 'FR') out.push({ prop: 'justify-self', value: css[d.get(id, 'gridAlignH')] });
    if (d.get(id, 'sizingV').mode !== 'FILL' && d.get(id, 'sizingV').mode !== 'FR') out.push({ prop: 'align-self', value: css[d.get(id, 'gridAlignV')] });
  }

  // Place in the parent.
  if (placed(d, id)) {
    out.push({ prop: 'position', value: 'absolute' });
    out.push({ prop: 'left', value: lengthCss(d.get(id, 'x'), o) });
    out.push({ prop: 'top', value: lengthCss(d.get(id, 'y'), o) });
  } else if (tree && d.children(id).some((c) => d.get(c, 'visible') !== false && placed(d, c))) {
    // Children placed exactly are placed against this box ("first on top" may have made it relative already).
    if (!out.some((x) => x.prop === 'position')) out.push({ prop: 'position', value: 'relative' });
  }
  out.push(...sizeDecls(d, id, o));
  const rotation = d.get(id, 'rotation');
  if (round(rotation, 2) !== 0) {
    out.push({ prop: 'transform', value: `rotate(${round(rotation, 2)}deg)` });
    out.push({ prop: 'transform-origin', value: 'top left' });
  }

  // Look.
  const fills = visiblePaints(d, id, 'fills');
  const fillStyle = styleName(d.get(id, 'fillStyleId'));
  if (isText) {
    const solidFill = fills.find((f) => f.paint.type === 'SOLID');
    if (solidFill) out.push({ prop: 'color', value: paintCss(d, id, solidFill.field, solidFill.paint, w, h)! });
    if (fillStyle) comments.push(`Цвет: ${fillStyle}`);
  } else if (fills.length > 0 && type !== 'GROUP' && type !== 'VECTOR' && type !== 'BOOLEAN_OPERATION' && type !== 'LINE') {
    const layers = fills.map((f) => paintCss(d, id, f.field, f.paint, w, h)!);
    // Only the bottom layer may be a plain colour in a CSS background list.
    const value = layers.length === 1 ? layers[0]! : layers.map((l, i) => (i < layers.length - 1 && !/gradient|url\(/.test(l) ? `linear-gradient(0deg, ${l}, ${l})` : l)).join(', ');
    out.push({ prop: 'background', value });
    if (fillStyle) comments.push(`Заливка: ${fillStyle}`);
  }
  const strokes = visiblePaints(d, id, 'strokes').filter((s) => s.paint.type === 'SOLID');
  const weight = d.get(id, 'strokeWeight');
  if (strokes.length > 0 && type !== 'VECTOR' && type !== 'LINE' && type !== 'BOOLEAN_OPERATION') {
    const stroke = strokes[0]!;
    const color = paintCss(d, id, stroke.field, stroke.paint, w, h)!;
    const dashed = d.get(id, 'dashPattern').length > 0 ? 'dashed' : 'solid';
    const weights = d.get(id, 'strokeWeights');
    if (isText) out.push({ prop: '-webkit-text-stroke', value: `${pxCss(weight)} ${color}` });
    else if (d.get(id, 'strokeAlign') === 'OUTSIDE' && !weights) out.push({ prop: 'outline', value: `${numberCss(d, id, 'strokeWeight', weight, o, pxCss)} ${dashed} ${color}` });
    else if (weights) {
      (['top', 'right', 'bottom', 'left'] as const).forEach((side, i) => weights[i]! > 0 && out.push({ prop: `border-${side}`, value: `${pxCss(weights[i]!)} ${dashed} ${color}` }));
    } else if (weight > 0) out.push({ prop: 'border', value: `${numberCss(d, id, 'strokeWeight', weight, o, pxCss)} ${dashed} ${color}` });
    const strokeStyle = styleName(d.get(id, 'strokeStyleId'));
    if (strokeStyle) comments.push(`Обводка: ${strokeStyle}`);
  }
  if (type === 'ELLIPSE') out.push({ prop: 'border-radius', value: '50%' });
  else if (!isText) {
    const radii = d.get(id, 'cornerRadii');
    if (radii && radii.some((r) => r > 0)) out.push({ prop: 'border-radius', value: radii.every((r) => r === radii[0]) ? lengthCss(radii[0], o) : radii.map((r) => lengthCss(r, o)).join(' ') });
    else if (!radii && d.get(id, 'cornerRadius') > 0) out.push({ prop: 'border-radius', value: numberCss(d, id, 'cornerRadius', d.get(id, 'cornerRadius'), o) });
  }
  const effects = d.get(id, 'effects');
  const shadows = effects.map((e) => shadowCss(e, isText)).filter((s): s is string => !!s);
  if (shadows.length) out.push({ prop: isText ? 'text-shadow' : 'box-shadow', value: shadows.join(', ') });
  for (const e of effects) {
    if (!e.visible) continue;
    if (e.type === 'LAYER_BLUR') out.push({ prop: 'filter', value: `blur(${pxCss(e.radius)})` });
    if (e.type === 'BACKGROUND_BLUR') out.push({ prop: 'backdrop-filter', value: `blur(${pxCss(e.radius)})` });
    // Progressive: CSS has no such blur; the usual way is the full blur faded by a mask along the same direction.
    if ((e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') && e.progressive && e.radius > 0) {
      const p = e.progressive;
      const deg = round(((Math.atan2((p.to.x - p.from.x) * w, -(p.to.y - p.from.y) * h) * 180) / Math.PI + 360) % 360, 1);
      out.push({ prop: 'mask-image', value: `linear-gradient(${deg}deg, rgba(0, 0, 0, ${round(Math.min(1, p.start / e.radius), 2)}), #000)` });
    }
  }
  const effectStyle = styleName(d.get(id, 'effectStyleId'));
  if (effectStyle) comments.push(`Эффекты: ${effectStyle}`);
  const opacity = d.get(id, 'opacity');
  if (opacity < 1) out.push({ prop: 'opacity', value: numberCss(d, id, 'opacity', round(opacity, 3), o, (n) => String(round(n, 3))) });
  const blend = BLEND[d.get(id, 'blendMode')];
  if (blend) out.push({ prop: 'mix-blend-mode', value: blend });
  if (d.get(id, 'clipsContent') && type !== 'TEXT' && mode !== undefined && (type === 'FRAME' || type === 'COMPONENT' || type === 'INSTANCE')) out.push({ prop: 'overflow', value: 'hidden' });

  // Typography.
  if (isText) {
    // A paragraph in HTML has margins of its own.
    if (tree) out.push({ prop: 'margin', value: '0' });
    const textStyle = styleName(d.get(id, 'textStyleId'));
    if (textStyle) comments.push(`Текст: ${textStyle}`);
    out.push({ prop: 'font-family', value: `"${d.get(id, 'fontFamily')}", sans-serif` });
    out.push({ prop: 'font-size', value: numberCss(d, id, 'fontSize', d.get(id, 'fontSize'), o) });
    if (d.get(id, 'italic')) out.push({ prop: 'font-style', value: 'italic' });
    out.push({ prop: 'font-weight', value: numberCss(d, id, 'fontWeight', d.get(id, 'fontWeight'), o, (n) => String(n)) });
    const lh = lineHeightCss(d, id);
    if (lh) out.push({ prop: 'line-height', value: lh });
    const ls = d.get(id, 'letterSpacing');
    if (ls.value) out.push({ prop: 'letter-spacing', value: ls.unit === 'PERCENT' ? `${round(ls.value / 100, 4)}em` : numberCss(d, id, 'letterSpacing', ls.value, o, pxCss) });
    const align = { LEFT: null, CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[d.get(id, 'textAlignH')];
    if (align) out.push({ prop: 'text-align', value: align });
    const textCase = { ORIGINAL: null, UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }[d.get(id, 'textCase')];
    if (textCase) out.push({ prop: 'text-transform', value: textCase });
    const deco = { NONE: null, UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }[d.get(id, 'textDecoration')];
    if (deco) out.push({ prop: 'text-decoration', value: deco });
    const caps = { NORMAL: null, SMALL_CAPS: 'small-caps', ALL_SMALL_CAPS: 'all-small-caps' }[d.get(id, 'fontVariantCaps')];
    if (caps) out.push({ prop: 'font-variant-caps', value: caps });
    const features = featureString(d.get(id, 'fontFeatures'));
    if (features) out.push({ prop: 'font-feature-settings', value: features });
    const variations = variationString(d.get(id, 'fontVariations'));
    if (variations) out.push({ prop: 'font-variation-settings', value: variations });
    // Vertical trim, as CSS writes it (text-box-trim, newest browsers).
    if (d.get(id, 'leadingTrim') === 'CAP_HEIGHT') out.push({ prop: 'text-box', value: 'trim-both cap alphabetic' });
    if (d.get(id, 'textDirection') !== 'AUTO') out.push({ prop: 'direction', value: d.get(id, 'textDirection') === 'RTL' ? 'rtl' : 'ltr' });
    if (d.get(id, 'textWrap') !== 'AUTO') out.push({ prop: 'text-wrap', value: d.get(id, 'textWrap') === 'BALANCE' ? 'balance' : 'pretty' });
    if (d.get(id, 'hangingPunctuation')) out.push({ prop: 'hanging-punctuation', value: 'first allow-end' });
    if (d.get(id, 'hangingList') && d.get(id, 'listType') !== 'NONE') out.push({ prop: 'list-style-position', value: 'outside' });
    if (d.get(id, 'paragraphIndent')) out.push({ prop: 'text-indent', value: lengthCss(d.get(id, 'paragraphIndent'), o) });
    const lines = d.get(id, 'maxLines');
    if (lines > 0) {
      out.push({ prop: 'display', value: '-webkit-box' }, { prop: '-webkit-box-orient', value: 'vertical' }, { prop: '-webkit-line-clamp', value: String(lines) }, { prop: 'overflow', value: 'hidden' });
    } else if (d.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT') out.push({ prop: 'white-space', value: 'nowrap' });
  }
  return { decls: out, comments };
}

/** The declarations as a CSS block body (comments first). */
export function formatCss(decls: readonly Decl[], comments: readonly string[] = []): string {
  return [...comments.map((c) => `/* ${c.replace(/\*\//g, '* /')} */`), ...decls.map((x) => `${x.prop}: ${x.value};`)].join('\n');
}

// ---------- SwiftUI and Compose ----------

const swiftColor = (c: Color, opacity = 1) => {
  const a = round(c.a * opacity, 3);
  return `Color(red: ${round(c.r, 3)}, green: ${round(c.g, 3)}, blue: ${round(c.b, 3)}${a < 1 ? `, opacity: ${a}` : ''})`;
};
const composeColor = (c: Color, opacity = 1) => {
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `Color(0x${(ch(c.a * opacity) + ch(c.r) + ch(c.g) + ch(c.b)).toUpperCase()})`;
};
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/** The first visible solid fill (or stroke) with its variable, for the platforms (no gradients there yet). */
function solidOf(doc: Document, id: NodeId, key: 'fills' | 'strokes'): { color: Color; opacity: number; variable: NodeId | null } | null {
  const top = visiblePaints(doc, id, key).find((x) => x.paint.type === 'SOLID');
  if (!top || top.paint.type !== 'SOLID') return null;
  return { color: top.paint.color, opacity: top.paint.opacity, variable: bound(doc, id, top.field) };
}

const SWIFT_WEIGHT: Record<number, string> = { 100: 'ultraLight', 200: 'thin', 300: 'light', 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold', 800: 'heavy', 900: 'black' };

/** Visible children in paint order (bottom first). */
function shownChildren(doc: Document, id: NodeId): NodeId[] {
  return doc.children(id).filter((c) => doc.get(c, 'visible') !== false && !doc.get(c, 'isMask'));
}

const indent = (code: string, by = '    ') => code.split('\n').map((l) => (l ? by + l : l)).join('\n');

/** The inside of a container: the children's code (tree) or a note how many there are. */
function childrenNote(doc: Document, id: NodeId, comment: string, tree?: (child: NodeId) => string): string[] {
  const kids = shownChildren(doc, id);
  if (tree && kids.length) return kids.map((c) => indent(tree(c)));
  const n = kids.length;
  return n > 0 ? [`    ${comment} ${n} ${n === 1 ? 'вложенный слой' : n < 5 ? 'вложенных слоя' : 'вложенных слоёв'}`] : [];
}

/** How deep and how many layers a tree of code takes: a whole page would be unreadable. */
export const TREE_LIMIT = { depth: 12, layers: 300 };

export function swiftUI(doc: Document, id: NodeId, tree = false, budget = { left: TREE_LIMIT.layers }, depth = 0): string {
  const d = doc;
  const name = String(d.get(id, 'name'));
  budget.left--;
  const sub = tree && depth < TREE_LIMIT.depth && budget.left > 0 ? (c: NodeId) => swiftUI(d, c, true, budget, depth + 1) : undefined;
  const lines: string[] = [`// ${name}`];
  const mods: string[] = [];
  const fill = solidOf(d, id, 'fills');
  const fillCode = fill && (fill.variable ? `Color.${platformVarName(d, fill.variable, 'IOS')}` : swiftColor(fill.color, fill.opacity));
  if (d.type(id) === 'TEXT') {
    lines.push(`Text(${quote(d.get(id, 'characters'))})`);
    const weight = SWIFT_WEIGHT[Math.round(d.get(id, 'fontWeight') / 100) * 100] ?? 'regular';
    mods.push(`.font(.custom(${quote(d.get(id, 'fontFamily'))}, size: ${round(d.get(id, 'fontSize'))}).weight(.${weight}))`);
    if (d.get(id, 'italic')) mods.push('.italic()');
    if (fillCode) mods.push(`.foregroundStyle(${fillCode})`);
    const lh = d.get(id, 'lineHeight');
    const px = lh.unit === 'PX' ? lh.value : lh.unit === 'PERCENT' ? (lh.value / 100) * d.get(id, 'fontSize') : lh.unit === 'MULTIPLIER' ? lh.value * d.get(id, 'fontSize') : 0;
    if (px > d.get(id, 'fontSize')) mods.push(`.lineSpacing(${round(px - d.get(id, 'fontSize'))})`);
    const ls = d.get(id, 'letterSpacing');
    if (ls.value) mods.push(`.tracking(${round(ls.unit === 'PERCENT' ? (ls.value / 100) * d.get(id, 'fontSize') : ls.value)})`);
    const align = { LEFT: null, CENTER: '.center', RIGHT: '.trailing', JUSTIFIED: null }[d.get(id, 'textAlignH')];
    if (align) mods.push(`.multilineTextAlignment(${align})`);
    if (d.get(id, 'maxLines') > 0) mods.push(`.lineLimit(${d.get(id, 'maxLines')})`);
  } else {
    const mode = d.get(id, 'layoutMode');
    if (mode === 'GRID') {
      // A lazy grid with a column per track: fixed, flexible (shares), or sized by content.
      const cols = d.get(id, 'gridColumns').map((t) => (t.kind === 'FIXED' ? `GridItem(.fixed(${round(t.value)}), spacing: ${round(d.get(id, 'gridColumnGap'))})` : t.kind === 'FR' ? `GridItem(.flexible(), spacing: ${round(d.get(id, 'gridColumnGap'))})` : `GridItem(.adaptive(minimum: 0), spacing: ${round(d.get(id, 'gridColumnGap'))})`));
      lines.push(`LazyVGrid(columns: [${cols.join(', ')}], alignment: .leading, spacing: ${round(d.get(id, 'gridRowGap'))}) {`, ...childrenNote(d, id, '//', sub), '}');
      const p = (['paddingTop', 'paddingLeft', 'paddingBottom', 'paddingRight'] as const).map((k) => round(d.get(id, k)));
      if (p.some(Boolean)) mods.push(p.every((v) => v === p[0]) ? `.padding(${p[0]})` : `.padding(EdgeInsets(top: ${p[0]}, leading: ${p[1]}, bottom: ${p[2]}, trailing: ${p[3]}))`);
    } else if (mode !== 'NONE') {
      const stack = mode === 'HORIZONTAL' ? 'HStack' : 'VStack';
      const a = d.get(id, 'counterAlign');
      const align = mode === 'HORIZONTAL' ? { MIN: '.top', CENTER: '.center', MAX: '.bottom', BASELINE: '.firstTextBaseline' }[a] : { MIN: '.leading', CENTER: '.center', MAX: '.trailing', BASELINE: '.leading' }[a];
      lines.push(`${stack}(alignment: ${align}, spacing: ${round(d.get(id, 'itemSpacing'))}) {`, ...childrenNote(d, id, '//', sub), '}');
      const p = (['paddingTop', 'paddingLeft', 'paddingBottom', 'paddingRight'] as const).map((k) => round(d.get(id, k)));
      if (p.some(Boolean)) mods.push(p.every((v) => v === p[0]) ? `.padding(${p[0]})` : `.padding(EdgeInsets(top: ${p[0]}, leading: ${p[1]}, bottom: ${p[2]}, trailing: ${p[3]}))`);
    } else if (d.type(id) === 'ELLIPSE') lines.push(fillCode ? `Ellipse()\n    .fill(${fillCode})` : 'Ellipse()');
    else if (d.children(id).length > 0) lines.push('ZStack(alignment: .topLeading) {', ...childrenNote(d, id, '//', sub), '}');
    else if (d.type(id) === 'VECTOR' || d.type(id) === 'BOOLEAN_OPERATION' || d.type(id) === 'STAR' || d.type(id) === 'POLYGON' || d.type(id) === 'LINE') lines.push(`Image(${quote(assetName(d, id))}) // векторная фигура: добавьте SVG в Assets`);
    else lines.push(fillCode ? `Rectangle()\n    .fill(${fillCode})` : 'Rectangle()');
    const sizing = (s: Sizing, v: number) => (s.mode === 'FIXED' ? round(v) : null);
    const fw = sizing(d.get(id, 'sizingH'), d.get(id, 'width'));
    const fh = sizing(d.get(id, 'sizingV'), d.get(id, 'height'));
    if (fw !== null || fh !== null) mods.push(`.frame(${[fw !== null ? `width: ${fw}` : '', fh !== null ? `height: ${fh}` : ''].filter(Boolean).join(', ')})`);
    if (d.get(id, 'sizingH').mode === 'FILL') mods.push('.frame(maxWidth: .infinity)');
    if (d.get(id, 'sizingV').mode === 'FILL') mods.push('.frame(maxHeight: .infinity)');
    const r = d.get(id, 'cornerRadii')?.[0] ?? d.get(id, 'cornerRadius');
    if (fillCode && (mode !== 'NONE' || d.children(id).length > 0)) mods.push(r > 0 ? `.background(${fillCode}, in: RoundedRectangle(cornerRadius: ${round(r)}))` : `.background(${fillCode})`);
    else if (r > 0 && d.type(id) !== 'ELLIPSE') mods.push(`.clipShape(RoundedRectangle(cornerRadius: ${round(r)}))`);
    const stroke = solidOf(d, id, 'strokes');
    if (stroke && d.get(id, 'strokeWeight') > 0) {
      const sc = stroke.variable ? `Color.${platformVarName(d, stroke.variable, 'IOS')}` : swiftColor(stroke.color, stroke.opacity);
      mods.push(`.overlay(RoundedRectangle(cornerRadius: ${round(r)}).stroke(${sc}, lineWidth: ${round(d.get(id, 'strokeWeight'))}))`);
    }
  }
  for (const e of d.get(id, 'effects')) {
    if (e.visible && e.type === 'DROP_SHADOW') mods.push(`.shadow(color: ${swiftColor(e.color)}, radius: ${round(e.radius / 2)}, x: ${round(e.offset.x)}, y: ${round(e.offset.y)})`);
    if (e.visible && e.type === 'LAYER_BLUR') mods.push(`.blur(radius: ${round(e.radius / 2)})`);
  }
  if (d.get(id, 'opacity') < 1) mods.push(`.opacity(${round(d.get(id, 'opacity'), 3)})`);
  // In a tree, a layer placed exactly in its parent is moved there.
  if (tree && depth > 0 && placed(d, id) && (d.get(id, 'x') || d.get(id, 'y'))) mods.push(`.offset(x: ${round(d.get(id, 'x'))}, y: ${round(d.get(id, 'y'))})`);
  return [...lines, ...mods.map((m) => `    ${m}`)].join('\n');
}

export function compose(doc: Document, id: NodeId, tree = false, budget = { left: TREE_LIMIT.layers }, depth = 0): string {
  const d = doc;
  const name = String(d.get(id, 'name'));
  budget.left--;
  const sub = tree && depth < TREE_LIMIT.depth && budget.left > 0 ? (c: NodeId) => compose(d, c, true, budget, depth + 1) : undefined;
  const modifiers: string[] = [];
  if (tree && depth > 0 && placed(d, id) && (d.get(id, 'x') || d.get(id, 'y'))) modifiers.push(`.offset(${round(d.get(id, 'x'))}.dp, ${round(d.get(id, 'y'))}.dp)`);
  const fill = solidOf(d, id, 'fills');
  const fillCode = fill && (fill.variable ? platformVarName(d, fill.variable, 'ANDROID') : composeColor(fill.color, fill.opacity));
  const size = (s: Sizing, key: 'width' | 'height') => {
    if (s.mode === 'FIXED') modifiers.push(`.${key}(${round(d.get(id, key))}.dp)`);
    else if (s.mode === 'FILL') modifiers.push(key === 'width' ? '.fillMaxWidth()' : '.fillMaxHeight()');
  };
  const isText = d.type(id) === 'TEXT';
  if (!isText || d.get(id, 'textAutoResize') === 'NONE') size(d.get(id, 'sizingH'), 'width');
  if (!isText || d.get(id, 'textAutoResize') !== 'WIDTH_AND_HEIGHT' && d.get(id, 'textAutoResize') !== 'HEIGHT') size(d.get(id, 'sizingV'), 'height');
  const r = isText ? 0 : d.type(id) === 'ELLIPSE' ? -1 : (d.get(id, 'cornerRadii')?.[0] ?? d.get(id, 'cornerRadius'));
  const shape = r === -1 ? 'CircleShape' : r > 0 ? `RoundedCornerShape(${round(r)}.dp)` : null;
  for (const e of d.get(id, 'effects')) if (e.visible && e.type === 'DROP_SHADOW' && !isText) modifiers.push(`.shadow(${round(e.radius / 2)}.dp${shape ? `, ${shape}` : ''})`);
  if (!isText && fillCode) modifiers.push(`.background(${fillCode}${shape ? `, ${shape}` : ''})`);
  else if (shape && !isText) modifiers.push(`.clip(${shape})`);
  const stroke = solidOf(d, id, 'strokes');
  if (!isText && stroke && d.get(id, 'strokeWeight') > 0) {
    modifiers.push(`.border(${round(d.get(id, 'strokeWeight'))}.dp, ${stroke.variable ? platformVarName(d, stroke.variable, 'ANDROID') : composeColor(stroke.color, stroke.opacity)}${shape ? `, ${shape}` : ''})`);
  }
  const p = (['paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom'] as const).map((k) => round(d.get(id, k)));
  if (d.get(id, 'layoutMode') !== 'NONE' && p.some(Boolean)) modifiers.push(p.every((v) => v === p[0]) ? `.padding(${p[0]}.dp)` : `.padding(start = ${p[0]}.dp, top = ${p[1]}.dp, end = ${p[2]}.dp, bottom = ${p[3]}.dp)`);
  if (d.get(id, 'opacity') < 1) modifiers.push(`.alpha(${round(d.get(id, 'opacity'), 3)}f)`);
  const modifier = modifiers.length ? `Modifier\n        ${modifiers.join('\n        ')}` : 'Modifier';
  const lines = [`// ${name}`];
  if (isText) {
    const args = [`text = ${quote(d.get(id, 'characters'))}`, `modifier = ${modifier}`, `fontFamily = FontFamily.Default /* ${d.get(id, 'fontFamily')} */`, `fontSize = ${round(d.get(id, 'fontSize'))}.sp`, `fontWeight = FontWeight(${d.get(id, 'fontWeight')})`];
    if (d.get(id, 'italic')) args.push('fontStyle = FontStyle.Italic');
    if (fillCode) args.push(`color = ${fillCode}`);
    const lh = d.get(id, 'lineHeight');
    if (lh.unit !== 'AUTO') args.push(`lineHeight = ${lh.unit === 'PX' ? `${round(lh.value)}.sp` : `${round(lh.unit === 'PERCENT' ? lh.value / 100 : lh.value, 3)}.em`}`);
    const ls = d.get(id, 'letterSpacing');
    if (ls.value) args.push(`letterSpacing = ${ls.unit === 'PERCENT' ? `${round(ls.value / 100, 4)}.em` : `${round(ls.value)}.sp`}`);
    const align = { LEFT: null, CENTER: 'TextAlign.Center', RIGHT: 'TextAlign.End', JUSTIFIED: 'TextAlign.Justify' }[d.get(id, 'textAlignH')];
    if (align) args.push(`textAlign = ${align}`);
    if (d.get(id, 'maxLines') > 0) args.push(`maxLines = ${d.get(id, 'maxLines')}`, 'overflow = TextOverflow.Ellipsis');
    lines.push('Text(', ...args.map((a) => `    ${a},`), ')');
    return lines.join('\n');
  }
  const mode = d.get(id, 'layoutMode');
  if (mode === 'GRID') {
    const n = d.get(id, 'gridColumns').length;
    const args = [`columns = GridCells.Fixed(${n})`, `modifier = ${modifier}`, `horizontalArrangement = Arrangement.spacedBy(${round(d.get(id, 'gridColumnGap'))}.dp)`, `verticalArrangement = Arrangement.spacedBy(${round(d.get(id, 'gridRowGap'))}.dp)`];
    lines.push('LazyVerticalGrid(', ...args.map((x) => `    ${x},`), ') {', ...childrenNote(d, id, '//', sub), '}');
  } else if (mode !== 'NONE') {
    const row = mode === 'HORIZONTAL';
    const gap = round(d.get(id, 'itemSpacing'));
    const spacing = d.get(id, 'spacingMode') === 'BETWEEN' ? 'Arrangement.SpaceBetween' : gap ? `Arrangement.spacedBy(${gap}.dp)` : null;
    const a = d.get(id, 'counterAlign');
    // By baseline: Compose sets it on each child (Modifier.alignByBaseline()), the row itself stays at the top.
    const cross = row ? `verticalAlignment = Alignment.${{ MIN: 'Top', CENTER: 'CenterVertically', MAX: 'Bottom', BASELINE: 'Top' }[a]}` : `horizontalAlignment = Alignment.${{ MIN: 'Start', CENTER: 'CenterHorizontally', MAX: 'End', BASELINE: 'Start' }[a]}`;
    const args = [`modifier = ${modifier}`, ...(spacing ? [`${row ? 'horizontalArrangement' : 'verticalArrangement'} = ${spacing}`] : []), cross];
    lines.push(`${row ? 'Row' : 'Column'}(`, ...args.map((x) => `    ${x},`), ') {', ...childrenNote(d, id, '//', sub), '}');
  } else if (d.children(id).length > 0) lines.push(`Box(modifier = ${modifier}) {`, ...childrenNote(d, id, '//', sub), '}');
  else if (d.type(id) === 'VECTOR' || d.type(id) === 'BOOLEAN_OPERATION' || d.type(id) === 'STAR' || d.type(id) === 'POLYGON' || d.type(id) === 'LINE') lines.push(`Image(painterResource(R.drawable.${assetName(d, id).replace(/-/g, '_')}), contentDescription = null, modifier = ${modifier})`);
  else lines.push(`Box(modifier = ${modifier})`);
  return lines.join('\n');
}

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE']);

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/**
 * A layer with everything inside it as HTML and CSS: an element per visible
 * layer with a class from its name, texts as paragraphs, vectors as <img> of
 * an SVG file named after the layer (download it with "SVG"), the CSS of each
 * class in one <style>. Deep trees are cut (TREE_LIMIT) with a note.
 */
export function htmlTree(doc: Document, id: NodeId, o: CodeOptions = DEFAULT_CODE_OPTIONS, limit = TREE_LIMIT, names = false): string {
  const d = doc;
  const used = new Map<string, number>();
  const rules: string[] = [];
  let left = limit.layers;
  const className = (n: NodeId) => {
    const base = slug(String(d.get(n, 'name'))).replace(/^(\d)/, 'l-$1') || d.type(n).toLowerCase();
    const k = (used.get(base) ?? 0) + 1;
    used.set(base, k);
    return k === 1 ? base : `${base}-${k}`;
  };
  const element = (n: NodeId, depth: number): string => {
    left--;
    const cls = className(n);
    let { decls, comments } = cssDecls(d, n, o, true);
    // The top element is where the code starts: not placed against anything outside it.
    if (depth === 0) {
      const hasPlaced = d.children(n).some((c) => d.get(c, 'visible') !== false && placed(d, c));
      decls = decls.filter((x) => x.prop !== 'left' && x.prop !== 'top' && x.prop !== 'position');
      if (hasPlaced) decls.unshift({ prop: 'position', value: 'relative' });
    }
    const type = d.type(n);
    // A warped layer (mockups) has no CSS: its stretched picture, like a vector's SVG.
    const drawing = VECTOR_TYPES.has(type) || d.get(n, 'warp') !== null || (type === 'ELLIPSE' && d.get(n, 'arc') !== null);
    // A vector's look is its SVG: the element only places it (its fill as a background made a box).
    if (drawing) decls = decls.filter((x) => !/^(background|border|border-radius|box-shadow|outline|filter)$/.test(x.prop));
    if (decls.length || comments.length) rules.push(`.${cls} {\n${indent(formatCss(decls, comments), '  ')}\n}`);
    // With `names` the layer's own name goes along (a page changed by a description comes back with its names, not «div.шапка»).
    const attrs = names && depth > 0 ? `class="${cls}" data-name="${escapeHtml(String(d.get(n, 'name')))}"` : `class="${cls}"`;
    if (type === 'TEXT') return `<p ${attrs}>${richText(d, n)}</p>`;
    if (drawing) return inline ? `<div ${attrs}>${inline.vector(n)}</div>` : `<img ${attrs} src="${assetName(d, n)}.svg" alt="">`;
    const kids = shownChildren(d, n);
    if (kids.length === 0) return `<div ${attrs}></div>`;
    if (depth >= limit.depth || left <= 0) return `<div ${attrs}><!-- ${kids.length} вложенных слоёв не показаны: выделите этот слой --></div>`;
    const inner = kids.map((c) => (left > 0 ? element(c, depth + 1) : '')).filter(Boolean);
    return `<div ${attrs}>\n${indent(inner.join('\n'), '  ')}\n</div>`;
  };
  const html = element(id, 0);
  return `${html}\n\n<style>\n${rules.join('\n\n')}\n</style>`;
}

/** A text's characters as HTML: parts styled apart (bold, a colour, a link…) as spans. */
function richText(d: Document, id: NodeId): string {
  const chars = d.get(id, 'characters');
  const runs = [...d.get(id, 'textRuns')].sort((a, b) => a.start - b.start);
  const piece = (s: string) => escapeHtml(s).replace(/\n/g, '<br>');
  if (runs.length === 0) return piece(chars);
  let out = '';
  let at = 0;
  for (const r of runs) {
    if (r.start > at) out += piece(chars.slice(at, r.start));
    const st = r.style;
    const css: string[] = [];
    if (st.fontFamily) css.push(`font-family: "${st.fontFamily}", sans-serif`);
    if (st.fontWeight) css.push(`font-weight: ${st.fontWeight}`);
    if (st.italic) css.push('font-style: italic');
    if (st.fontSize) css.push(`font-size: ${round(st.fontSize)}px`);
    const fill = st.fills?.find((f) => f.visible && f.type === 'SOLID');
    if (fill && fill.type === 'SOLID') css.push(`color: ${cssColor(fill.color, fill.opacity)}`);
    if (st.textDecoration === 'UNDERLINE') css.push('text-decoration: underline');
    if (st.textDecoration === 'STRIKETHROUGH') css.push('text-decoration: line-through');
    const text = piece(chars.slice(Math.max(at, r.start), r.end));
    const span = css.length ? `<span style="${css.join('; ')}">${text}</span>` : text;
    out += st.link ? `<a href="${escapeHtml(st.link)}">${span}</a>` : span;
    at = Math.max(at, r.end);
  }
  if (at < chars.length) out += piece(chars.slice(at));
  return out;
}

/** Code of a layer in a language; `tree` — with everything inside it. */
export function layerCode(doc: Document, id: NodeId, lang: CodeLang, o: CodeOptions = DEFAULT_CODE_OPTIONS, tree = false): string {
  if (lang === 'swiftui') return swiftUI(doc, id, tree);
  if (lang === 'compose') return compose(doc, id, tree);
  if (tree) return htmlTree(doc, id, o);
  const { decls, comments } = cssDecls(doc, id, o);
  return formatCss(decls, comments);
}

// ---------- variables as CSS ----------

function literalCss(doc: Document, value: VariableLiteral | undefined, raw: unknown, type: string): string | null {
  if (isAlias(raw) && doc.store.isAlive(raw.id) && raw.opacity === undefined) return `var(${cssVarName(doc, raw.id)})`;
  if (value === undefined) return null;
  if (type === 'COLOR' && typeof value === 'object') return cssColor(value);
  if (type === 'FLOAT' && typeof value === 'number') return String(round(value, 4));
  if (type === 'STRING' && typeof value === 'string') return quote(value);
  if (type === 'BOOLEAN' && typeof value === 'boolean') return value ? '1' : '0';
  return null;
}

/**
 * Every variable of the file as CSS custom properties: the default mode of
 * each collection in `:root`, other modes in `[data-<collection>="<mode>"]`
 * blocks (only values that differ). Numbers stay unitless: a variable may be
 * a size, a weight or an opacity.
 */
export function variablesCss(doc: Document): string {
  const d = doc;
  const root: string[] = [];
  const blocks: string[] = [];
  for (const collection of d.collections()) {
    const modes = d.get(collection, 'modes');
    const vars = d.children(collection).filter((v) => d.type(v) === 'VARIABLE');
    if (vars.length === 0 || modes.length === 0) continue;
    root.push(`  /* ${d.get(collection, 'name')} */`);
    const base = modes[0]!.id;
    const values = (mode: string) =>
      vars.map((v) => ({ name: cssVarName(d, v), value: literalCss(d, resolveInMode(d, v, mode), d.get(v, 'varValues')[mode], d.get(v, 'varType')) }));
    const first = values(base);
    for (const x of first) if (x.value !== null) root.push(`  ${x.name}: ${x.value};`);
    for (const m of modes.slice(1)) {
      const lines = values(m.id)
        .filter((x, i) => x.value !== null && x.value !== first[i]!.value)
        .map((x) => `  ${x.name}: ${x.value};`);
      if (lines.length) blocks.push(`[data-${slug(d.get(collection, 'name')) || 'mode'}="${slug(m.name) || m.id}"] {\n${lines.join('\n')}\n}`);
    }
  }
  if (root.length === 0) return '';
  return [`:root {\n${root.join('\n')}\n}`, ...blocks].join('\n\n');
}
