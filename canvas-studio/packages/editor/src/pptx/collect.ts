// PPTX export (FEAT-038), the document side: frames become slides. Text stays
// text, rectangles and ellipses become PowerPoint shapes with their fills,
// gradients, strokes and shadows, image fills become pictures; what
// PowerPoint cannot express (vectors, icons, masks, blurs, blend modes) is
// inserted as a picture — PNG with an SVG copy where it helps. Ported from
// the "Layers to PPTX" Figma plugin.

import { colorToHex, type Color, type Document, type Effect, type GradientPaint, type NodeId, type NodeType, type Paint, type ShadowEffect } from '#core';
import { applyTextCase, letterSpacingPx, lineHeightOf, runStyleAt } from '#layout';
import type { Rect } from '#geometry';
import { needsPicture } from '#render';
import type { Clip, El, Fill, Image, Line, Para, PicEl, Run, Shadow, ShapeEl, Slide, TableCell, TableEl, TextEl } from './writer.ts';

export interface CollectOptions {
  /** Editable layers, or one picture per slide. */
  mode: 'editable' | 'image';
  /** Pixel density of pictures. */
  scale: number;
  /** Icons and vectors also as SVG. */
  svg: boolean;
  /** Frames and groups become groups in PowerPoint. */
  groups: boolean;
}

/** What only the browser can do: render a layer, serialise it as SVG, read an image. */
export interface CollectEnv {
  /** PNG of a layer with its children, effects and strokes; bounds in world space. */
  raster(id: NodeId, scale: number): Promise<{ bytes: Uint8Array; bounds: Rect } | null>;
  svg(id: NodeId): string | null;
  /** Bytes and natural size of an image fill. */
  image(hash: string): Promise<{ bytes: Uint8Array; ext: Image['ext']; width: number; height: number } | null>;
  /** World transform of a layer as [a, b, c, d, e, f] (x' = a·x + c·y + e). */
  world(id: NodeId): { a: number; b: number; c: number; d: number; e: number; f: number };
  bounds(id: NodeId): Rect;
}

export interface Collected {
  slides: Slide[];
  images: Image[];
  /** Layers inserted as pictures. */
  rasterized: number;
  fonts: string[];
}

const CONTAINERS: ReadonlySet<NodeType> = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
const VECTORISH: ReadonlySet<NodeType> = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'LINE']);
const SLIDE_TYPES: ReadonlySet<NodeType> = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP']);

// ---------------------------------------------------------------------------
// Which layers become slides
// ---------------------------------------------------------------------------

function framesIn(doc: Document, section: NodeId, out: NodeId[]): void {
  for (const c of doc.children(section)) {
    if (!doc.get(c, 'visible')) continue;
    if (doc.type(c) === 'SECTION') framesIn(doc, c, out);
    else if (SLIDE_TYPES.has(doc.type(c))) out.push(c);
  }
}

/** Reading order: rows from top to bottom, left to right within a row. */
function readingOrder(ids: NodeId[], bounds: (id: NodeId) => Rect): NodeId[] {
  const items = ids.map((id) => ({ id, ...bounds(id) })).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: { top: number; minH: number; items: typeof items }[] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && it.y < row.top + row.minH * 0.5) {
      row.items.push(it);
      row.minH = Math.min(row.minH, it.height);
    } else rows.push({ top: it.y, minH: it.height, items: [it] });
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x).map((it) => it.id));
}

/**
 * Layers that become slides: the selection (a section gives its frames), or —
 * with nothing selected — every top-level frame of the page and the frames in its sections.
 */
export function slideTargets(doc: Document, pageId: NodeId, selection: readonly NodeId[], bounds: (id: NodeId) => Rect): { ids: NodeId[]; scope: 'selection' | 'page' } {
  const out: NodeId[] = [];
  for (const id of selection) {
    if (doc.type(id) === 'SECTION') framesIn(doc, id, out);
    else if (doc.get(id, 'width') > 0 && doc.get(id, 'height') > 0) out.push(id);
  }
  if (out.length) return { ids: readingOrder(out, bounds), scope: 'selection' };
  for (const c of doc.children(pageId)) {
    if (!doc.get(c, 'visible')) continue;
    if (doc.type(c) === 'SECTION') framesIn(doc, c, out);
    else if (doc.type(c) === 'FRAME' || doc.type(c) === 'COMPONENT' || doc.type(c) === 'INSTANCE') out.push(c);
  }
  return { ids: readingOrder(out, bounds), scope: 'page' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hex = (c: Color) => colorToHex(c).slice(1);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const visiblePaints = (list: readonly Paint[]) => list.filter((p) => p.visible && p.opacity > 0);
const oddBlend = (mode: string | undefined) => !!mode && mode !== 'PASS_THROUGH' && mode !== 'NORMAL';

/** One colour where PowerPoint takes no gradient (text, strokes). */
function colorOfPaint(p: Paint | undefined): { color: string; alpha: number } | null {
  if (!p) return null;
  if (p.type === 'SOLID') return { color: hex(p.color), alpha: p.color.a * p.opacity };
  if (p.type !== 'IMAGE' && p.type !== 'PATTERN' && p.stops.length) return { color: hex(p.stops[0]!.color), alpha: p.stops[0]!.color.a * p.opacity };
  return null;
}

interface State {
  opacity: number;
  clip: Clip | null;
}

interface Ctx {
  doc: Document;
  env: CollectEnv;
  opts: CollectOptions;
  images: Image[];
  imageKeys: Map<string, string>;
  imageSizes: Map<string, { width: number; height: number }>;
  rasterized: number;
  ox: number;
  oy: number;
}

interface Xf {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipped: boolean;
}

/** Position, size and rotation of a layer relative to the slide. */
function xfrmOf(id: NodeId, ctx: Ctx): Xf {
  const m = ctx.env.world(id);
  const w = ctx.doc.get(id, 'width');
  const h = ctx.doc.get(id, 'height');
  const cx = (m.a * w) / 2 + (m.c * h) / 2 + m.e - ctx.ox;
  const cy = (m.b * w) / 2 + (m.d * h) / 2 + m.f - ctx.oy;
  let rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  if (Math.abs(rot) < 0.01) rot = 0;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot, flipped: m.a * m.d - m.c * m.b < 0 };
}

function intersect(r1: Clip | null, r2: Clip): Clip {
  if (!r1) return r2;
  const x = Math.max(r1.x, r2.x);
  const y = Math.max(r1.y, r2.y);
  return { x, y, w: Math.max(0, Math.min(r1.x + r1.w, r2.x + r2.w) - x), h: Math.max(0, Math.min(r1.y + r1.h, r2.y + r2.h) - y) };
}
const sameRect = (a: Clip, b: Clip) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
/** Clip frames intersect; radii stay when the result is one of the frames. */
function clipWith(outer: Clip | null, inner: Clip): Clip {
  const r = intersect(outer, inner);
  if (sameRect(r, inner)) r.radii = inner.radii;
  else if (outer && sameRect(r, outer)) r.radii = outer.radii;
  return r;
}

// ---------------------------------------------------------------------------
// Gradients and images
// ---------------------------------------------------------------------------

function gradientOf(p: GradientPaint, w: number, h: number): Fill | null {
  let stops = p.stops.map((s) => ({ pos: clamp01(s.position), color: hex(s.color), alpha: s.color.a * p.opacity })).sort((a, b) => a.pos - b.pos);
  if (!stops.length) return null;
  const sx = p.from.x * w;
  const sy = p.from.y * h;
  const ex = p.to.x * w;
  const ey = p.to.y * h;
  if (p.type === 'GRADIENT_LINEAR') {
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    // PowerPoint spreads a gradient over the whole box: stop positions are recomputed.
    const proj = [0, w * ux, h * uy, w * ux + h * uy];
    const pmin = Math.min(...proj);
    const span = Math.max(...proj) - pmin || 1;
    const ps = sx * ux + sy * uy;
    stops = stops.map((st) => ({ ...st, pos: clamp01((ps + st.pos * len - pmin) / span) }));
    let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (ang < 0) ang += 360;
    return { type: 'lin', ang, stops };
  }
  // Radial: a circle from the centre handle. PowerPoint has no angular or diamond gradient: they go radial too.
  const cx = clamp01(p.from.x);
  const cy = clamp01(p.from.y);
  const rf = Math.hypot(ex - sx, ey - sy) || 1;
  const rp = Math.hypot(Math.max(cx, 1 - cx) * w, Math.max(cy, 1 - cy) * h) || 1;
  return { type: 'rad', cx, cy, stops: stops.map((st) => ({ ...st, pos: clamp01((st.pos * rf) / rp) })) };
}

function addImage(ctx: Ctx, bytes: Uint8Array, ext: Image['ext'], key?: string): string {
  if (key) {
    const known = ctx.imageKeys.get(key);
    if (known) return known;
  }
  const id = `img${ctx.images.length + 1}`;
  ctx.images.push({ id, bytes, ext });
  if (key) ctx.imageKeys.set(key, id);
  return id;
}

async function imagePic(p: Extract<Paint, { type: 'IMAGE' }>, box: Xf, ctx: Ctx): Promise<{ img: string; crop: PicEl['crop']; alpha: number; fit?: { dx: number; dy: number; w: number; h: number } } | null> {
  const key = `hash:${p.imageHash}`;
  let id = ctx.imageKeys.get(key);
  let size = ctx.imageSizes.get(key);
  if (!id || !size) {
    const image = await ctx.env.image(p.imageHash);
    if (!image) return null;
    id = addImage(ctx, image.bytes, image.ext, key);
    size = { width: image.width, height: image.height };
    ctx.imageSizes.set(key, size);
  }
  const { w: bw, h: bh } = box;
  const { width: iw, height: ih } = size;
  if (p.scaleMode === 'FILL') {
    const s = Math.max(bw / iw, bh / ih);
    const vw = bw / (iw * s);
    const vh = bh / (ih * s);
    return { img: id, alpha: p.opacity, crop: { l: (1 - vw) / 2, r: (1 - vw) / 2, t: (1 - vh) / 2, b: (1 - vh) / 2 } };
  }
  if (p.scaleMode === 'FIT') {
    // The whole picture inside the box: the box itself shrinks (same centre).
    const s = Math.min(bw / iw, bh / ih);
    const fw = iw * s;
    const fh = ih * s;
    return { img: id, alpha: p.opacity, crop: { l: 0, t: 0, r: 0, b: 0 }, fit: { dx: (bw - fw) / 2, dy: (bh - fh) / 2, w: fw, h: fh } };
  }
  return { img: id, alpha: p.opacity, crop: { l: 0, t: 0, r: 0, b: 0 } };
}

function paintNeedsRaster(p: Paint): boolean {
  if (p.type === 'IMAGE' && p.scaleMode === 'TILE') return true;
  return oddBlend(p.blendMode);
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const visibleEffect = (effects: readonly Effect[], type: Effect['type']) => effects.some((e) => e.visible && e.type === type);

function nodeNeedsRaster(doc: Document, id: NodeId): boolean {
  if (oddBlend(doc.get(id, 'blendMode'))) return true;
  if (needsPicture(doc, id)) return true;
  const effects = doc.get(id, 'effects');
  if (visibleEffect(effects, 'LAYER_BLUR') || visibleEffect(effects, 'BACKGROUND_BLUR') || visibleEffect(effects, 'NOISE')) return true;
  if (doc.get(id, 'isMask')) return true;
  // An arc, pie or ring has no PowerPoint shape: its picture (with an SVG copy).
  if (doc.type(id) === 'ELLIPSE' && doc.get(id, 'arc')) return true;
  if (visiblePaints(doc.get(id, 'fills')).some(paintNeedsRaster)) return true;
  return doc.children(id).some((c) => doc.get(c, 'isMask') && doc.get(c, 'visible'));
}

/** Icons and illustrations: a container without text, built of vectors — one picture. */
function isIconLike(doc: Document, id: NodeId): boolean {
  let hasVector = false;
  let ok = true;
  const walk = (n: NodeId) => {
    if (!ok || !doc.get(n, 'visible')) return;
    const t = doc.type(n);
    if (t === 'TEXT') {
      ok = false;
      return;
    }
    if (VECTORISH.has(t)) hasVector = true;
    if (visiblePaints(doc.get(n, 'fills')).some((p) => p.type === 'IMAGE')) {
      ok = false;
      return;
    }
    for (const c of doc.children(n)) walk(c);
  };
  walk(id);
  return ok && hasVector;
}

function hasImageInside(doc: Document, id: NodeId): boolean {
  if (!doc.get(id, 'visible')) return false;
  if (visiblePaints(doc.get(id, 'fills')).some((p) => p.type === 'IMAGE')) return true;
  return doc.children(id).some((c) => hasImageInside(doc, c));
}

function shadowOf(doc: Document, id: NodeId): Shadow | null {
  const e = doc.get(id, 'effects').find((ef): ef is ShadowEffect => ef.visible && (ef.type === 'DROP_SHADOW' || ef.type === 'INNER_SHADOW'));
  if (!e) return null;
  return { inner: e.type === 'INNER_SHADOW', x: e.offset.x, y: e.offset.y, blur: Math.max(0, e.radius), color: hex(e.color), alpha: e.color.a };
}

function radiiOf(doc: Document, id: NodeId): number[] | null {
  if (doc.type(id) === 'ELLIPSE') return null;
  const per = doc.get(id, 'cornerRadii');
  if (per) return [...per];
  const r = doc.get(id, 'cornerRadius');
  return [r, r, r, r];
}

interface Stroke extends Line {
  align: 'INSIDE' | 'CENTER' | 'OUTSIDE';
  sides: { t: number; r: number; b: number; l: number } | null;
}

function strokeOf(doc: Document, id: NodeId): Stroke | null {
  const s = visiblePaints(doc.get(id, 'strokes'));
  const col = colorOfPaint(s[s.length - 1]);
  if (!col) return null;
  let w = doc.get(id, 'strokeWeight');
  let sides: Stroke['sides'] = null;
  const per = doc.get(id, 'strokeWeights');
  if (per) {
    const [t, r, b, l] = per;
    if (!(t === r && r === b && b === l)) sides = { t, r, b, l };
    w = Math.max(t, r, b, l);
  }
  if (w <= 0) return null;
  const dashes = doc.get(id, 'dashPattern');
  const dash = dashes.length ? (dashes[0]! <= w * 1.5 ? 'dot' : 'dash') : null;
  const align = doc.type(id) === 'LINE' ? 'CENTER' : doc.get(id, 'strokeAlign');
  return { color: col.color, alpha: col.alpha, w, align, dash, sides };
}

/** A rectangle, an ellipse or a frame's own box; null — it has to be a picture. */
async function shapeElements(id: NodeId, st: State, ctx: Ctx, isContainer: boolean): Promise<{ below: El[]; above: El[] } | null> {
  const doc = ctx.doc;
  const xf = xfrmOf(id, ctx);
  if (xf.flipped) return null;
  const fills = visiblePaints(doc.get(id, 'fills'));
  if (fills.some(paintNeedsRaster)) return null;
  const stroke = strokeOf(doc, id);
  const shadow = shadowOf(doc, id);
  const geom = doc.type(id) === 'ELLIPSE' ? 'ellipse' : 'rect';
  const maxR = Math.min(xf.w, xf.h) / 2;
  const radii = radiiOf(doc, id)?.map((r) => Math.max(0, Math.min(r, maxR))) ?? null;
  const name = doc.get(id, 'name');
  if (!fills.length && !stroke && !shadow) return { below: [], above: [] };

  const base = (): Omit<ShapeEl, 'k' | 'fill'> => ({ x: xf.x, y: xf.y, w: xf.w, h: xf.h, rot: xf.rot, geom, radii, name, clip: st.clip, opacity: st.opacity });
  const layers: (ShapeEl | PicEl)[] = [];
  for (const p of fills) {
    if (p.type === 'SOLID') layers.push({ ...base(), k: 'shape', fill: { type: 'solid', color: hex(p.color), alpha: p.color.a * p.opacity } });
    else if (p.type === 'IMAGE') {
      const pic = await imagePic(p, xf, ctx);
      if (!pic) return null;
      const el: PicEl = { ...base(), k: 'pic', img: pic.img, crop: pic.crop, alpha: pic.alpha };
      if (pic.fit) Object.assign(el, { x: el.x + pic.fit.dx, y: el.y + pic.fit.dy, w: pic.fit.w, h: pic.fit.h });
      layers.push(el);
    } else if (p.type !== 'PATTERN') {
      const g = gradientOf(p, xf.w, xf.h);
      if (g) layers.push({ ...base(), k: 'shape', fill: g });
    }
  }

  // A frame's stroke goes over its children, a shape's — on the shape itself.
  const strokeEls: El[] = [];
  if (stroke?.sides && !xf.rot) {
    const S = stroke.sides;
    const off = stroke.align === 'INSIDE' ? 1 : stroke.align === 'OUTSIDE' ? -1 : 0;
    const side = (wt: number, x1: number, y1: number, x2: number, y2: number) => {
      if (wt > 0) strokeEls.push({ k: 'line', x1, y1, x2, y2, line: { color: stroke.color, alpha: stroke.alpha, dash: stroke.dash, w: wt }, name: `${name} border`, opacity: st.opacity, clip: st.clip });
    };
    side(S.t, xf.x, xf.y + (off * S.t) / 2, xf.x + xf.w, xf.y + (off * S.t) / 2);
    side(S.b, xf.x, xf.y + xf.h - (off * S.b) / 2, xf.x + xf.w, xf.y + xf.h - (off * S.b) / 2);
    side(S.l, xf.x + (off * S.l) / 2, xf.y, xf.x + (off * S.l) / 2, xf.y + xf.h);
    side(S.r, xf.x + xf.w - (off * S.r) / 2, xf.y, xf.x + xf.w - (off * S.r) / 2, xf.y + xf.h);
  } else if (stroke) {
    const inset = stroke.align === 'INSIDE' ? stroke.w / 2 : stroke.align === 'OUTSIDE' ? -stroke.w / 2 : 0;
    const line: Line = { color: stroke.color, alpha: stroke.alpha, w: stroke.w, dash: stroke.dash };
    const last = layers[layers.length - 1];
    if (!isContainer && last?.k === 'shape' && !inset) last.line = line;
    else {
      const el: ShapeEl = { ...base(), k: 'shape', fill: null, line };
      el.x += inset;
      el.y += inset;
      el.w = Math.max(0.5, el.w - inset * 2);
      el.h = Math.max(0.5, el.h - inset * 2);
      if (el.radii) el.radii = el.radii.map((r) => Math.max(0, r - inset));
      strokeEls.push(el);
    }
  }

  if (shadow) {
    const first = layers[0] ?? strokeEls[0];
    if (first && (first.k === 'shape' || first.k === 'pic')) first.shadow = shadow;
  }
  return isContainer ? { below: layers, above: strokeEls } : { below: [...layers, ...strokeEls], above: [] };
}

function textElement(id: NodeId, st: State, ctx: Ctx): TextEl | null {
  const doc = ctx.doc;
  const xf = xfrmOf(id, ctx);
  const chars = doc.get(id, 'characters');
  if (!chars) return null;
  const runs = doc.get(id, 'textRuns');
  const textCase = doc.get(id, 'textCase');
  const caps = doc.get(id, 'fontVariantCaps');
  const list = doc.get(id, 'listType');
  const lineH = doc.get(id, 'lineHeight');
  const base = {
    fontFamily: doc.get(id, 'fontFamily'),
    fontWeight: doc.get(id, 'fontWeight'),
    italic: doc.get(id, 'italic'),
    fontSize: doc.get(id, 'fontSize'),
    fills: doc.get(id, 'fills'),
    textDecoration: doc.get(id, 'textDecoration'),
    letterSpacing: doc.get(id, 'letterSpacing'),
    baseline: 'NORMAL' as const,
  };

  // Segments of one style: cut at every run boundary.
  const cuts = new Set([0, chars.length]);
  for (const r of runs) {
    cuts.add(Math.max(0, Math.min(chars.length, r.start)));
    cuts.add(Math.max(0, Math.min(chars.length, r.end)));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const paras: Para[] = [];
  let cur: Para | null = null;
  const newPara = (size: number): Para => {
    const p: Para = { runs: [], lineH: null, list: list === 'BULLET' ? 'bullet' : list === 'NUMBER' ? 'number' : null, level: list === 'NONE' ? 0 : 1, size, indent: doc.get(id, 'paragraphIndent'), endRun: null };
    paras.push(p);
    return p;
  };
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;
    const s = { ...base, ...runStyleAt(runs, start) };
    const fill = colorOfPaint(visiblePaints(s.fills ?? [])[0]) ?? { color: '000000', alpha: 1 };
    const size = s.fontSize ?? 16;
    const run: Omit<Run, 'text'> = {
      font: s.fontFamily ?? 'Inter',
      w: s.fontWeight ?? 400,
      i: !!s.italic,
      size,
      color: fill.color,
      alpha: fill.alpha,
      u: s.textDecoration === 'UNDERLINE',
      strike: s.textDecoration === 'STRIKETHROUGH',
      spc: letterSpacingPx({ letterSpacing: s.letterSpacing ?? base.letterSpacing, fontSize: size }),
      cap: textCase === 'UPPER' || caps === 'ALL_SMALL_CAPS' ? (caps === 'ALL_SMALL_CAPS' ? 'small' : 'all') : caps === 'SMALL_CAPS' ? 'small' : null,
      baseline: s.baseline === 'SUPER' ? 30 : s.baseline === 'SUB' ? -25 : 0,
      link: null,
    };
    const text = textCase === 'LOWER' || textCase === 'TITLE' ? applyTextCase(chars.slice(start, end), textCase) : chars.slice(start, end);
    const lh = lineH.unit === 'AUTO' ? null : lineHeightOf(lineH, size);
    text.split('\n').forEach((part, k) => {
      if (k > 0 || !cur) cur = newPara(size);
      if (lh != null) cur.lineH = Math.max(cur.lineH ?? 0, lh);
      cur.size = Math.max(cur.size, size);
      if (part.length) cur.runs.push({ ...run, text: part });
      cur.endRun ??= run;
    });
  }
  if (!paras.length) return null;

  const firstLH = paras[0]!.lineH ?? paras[0]!.size * 1.25;
  // One line on the canvas: PowerPoint must not wrap it because of slightly different font metrics.
  const singleLine = !chars.includes('\n') && !chars.includes(' ') && xf.h < firstLH * 1.6;
  const alignH = doc.get(id, 'textAlignH');
  const alignV = doc.get(id, 'textAlignV');
  return {
    k: 'text',
    x: xf.x,
    y: xf.y,
    w: xf.w,
    h: xf.h,
    rot: xf.flipped ? 0 : xf.rot,
    name: doc.get(id, 'name'),
    clip: st.clip,
    opacity: st.opacity * doc.get(id, 'opacity'),
    wrap: doc.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT' || singleLine ? 'none' : 'square',
    align: alignH === 'CENTER' ? 'ctr' : alignH === 'RIGHT' ? 'r' : alignH === 'JUSTIFIED' ? 'just' : 'l',
    anchor: alignV === 'CENTER' ? 'ctr' : alignV === 'BOTTOM' ? 'b' : 't',
    paraSpacing: doc.get(id, 'paragraphSpacing'),
    paras,
    shadow: shadowOf(doc, id),
  };
}

const ALIGN_TO_ANCHOR = { MIN: 't', CENTER: 'ctr', MAX: 'b' } as const;

/**
 * What a cell holds: its texts, also those wrapped in frames that paint nothing (the <div>s and
 * <span>s of an HTML page), and what paints — a badge, an icon, a pill with its own text.
 */
function cellContent(cell: NodeId, ctx: Ctx): { texts: NodeId[]; others: NodeId[] } {
  const doc = ctx.doc;
  const texts: NodeId[] = [];
  const others: NodeId[] = [];
  const bare = (id: NodeId) =>
    CONTAINERS.has(doc.type(id)) &&
    !doc.get(id, 'table') &&
    doc.get(id, 'opacity') >= 1 &&
    !oddBlend(doc.get(id, 'blendMode')) &&
    !xfrmOf(id, ctx).rot &&
    !visiblePaints(doc.get(id, 'fills')).length &&
    !visiblePaints(doc.get(id, 'strokes')).length &&
    !doc.get(id, 'effects').some((e) => e.visible);
  const sort = (id: NodeId) => {
    for (const k of doc.paintChildren(id)) {
      if (!doc.get(k, 'visible')) continue;
      const own = doc.type(k) === 'TEXT' && !!doc.get(k, 'characters') && !xfrmOf(k, ctx).rot && !oddBlend(doc.get(k, 'blendMode')) && !visibleEffect(doc.get(k, 'effects'), 'LAYER_BLUR');
      if (own) texts.push(k);
      else if (bare(k)) sort(k);
      else others.push(k);
    }
  };
  sort(cell);
  return { texts, others };
}

/** The texts of a cell as one: in reading order, a line of texts side by side is one paragraph. */
function cellText(texts: readonly NodeId[], st: State, ctx: Ctx): Pick<TextEl, 'paras' | 'align' | 'x' | 'y' | 'w' | 'h'> | null {
  const els = texts.map((t) => textElement(t, st, ctx)).filter((e): e is TextEl => !!e && e.paras.length > 0);
  if (!els.length) return null;
  els.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextEl[][] = [];
  for (const e of els) {
    const line = lines.at(-1);
    const last = line?.at(-1);
    if (line && last && e.y < last.y + last.h / 2 && e.y + e.h / 2 > last.y) line.push(e);
    else lines.push([e]);
  }
  const paras: Para[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    line.forEach((e, i) => {
      const prev = paras.at(-1);
      if (i === 0 || !prev) return void paras.push(...e.paras.map((p) => ({ ...p, runs: [...p.runs] })));
      const [first, ...rest] = e.paras;
      const gap = prev.runs.at(-1) ?? first!.runs[0];
      if (gap) prev.runs.push({ ...gap, text: ' ', link: null });
      prev.runs.push(...first!.runs);
      paras.push(...rest);
    });
  }
  const x = Math.min(...els.map((e) => e.x));
  const y = Math.min(...els.map((e) => e.y));
  return { paras, align: els[0]!.align, x, y, w: Math.max(...els.map((e) => e.x + e.w)) - x, h: Math.max(...els.map((e) => e.y + e.h)) - y };
}

/**
 * A table (FEAT-169) as PowerPoint's own table, so that it stays a table to edit there:
 * columns and rows where its cells are, merged cells, fills, lines, the texts with their
 * styles. What a cell holds besides its text (a badge, an icon) goes over the table.
 * Null — not a grid PowerPoint can take (rotated, cells missing): it goes as layers.
 */
async function tableElements(id: NodeId, st: State, ctx: Ctx): Promise<El[] | null> {
  const doc = ctx.doc;
  const xf = xfrmOf(id, ctx);
  if (xf.rot || xf.flipped) return null;
  const nCols = Math.max(1, doc.get(id, 'gridColumns').length);
  const cells = [...doc.children(id)];
  const nRows = Math.ceil(cells.length / nCols);
  if (!cells.length || cells.length !== nRows * nCols || cells.some((c) => doc.type(c) !== 'FRAME')) return null;
  const at = (r: number, c: number) => cells[r * nCols + c]!;
  const rect = (c: NodeId) => {
    const b = ctx.env.bounds(c);
    return { x: b.x - ctx.ox, y: b.y - ctx.oy, w: b.width, h: b.height };
  };

  // Which merged cell covers each place.
  const cover: ({ r: number; c: number } | null)[] = cells.map(() => null);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const cell = at(r, c);
      if (!doc.get(cell, 'visible') || cover[r * nCols + c]) continue;
      const rs = Math.min(nRows - r, Math.max(1, doc.get(cell, 'gridRowSpan')));
      const cs = Math.min(nCols - c, Math.max(1, doc.get(cell, 'gridColumnSpan')));
      for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) if (i !== r || j !== c) cover[i * nCols + j] = { r, c };
      const b = rect(cell);
      xs[c] = Math.min(xs[c] ?? Infinity, b.x);
      ys[r] = Math.min(ys[r] ?? Infinity, b.y);
    }
  }
  // Column and row edges are where their cells begin; the outer ones are the table's.
  const edges = (starts: number[], n: number, from: number, to: number) => {
    const e = [from];
    for (let i = 1; i < n; i++) e.push(starts[i] ?? NaN);
    e.push(to);
    return e;
  };
  const ex = edges(xs, nCols, xf.x, xf.x + xf.w);
  const ey = edges(ys, nRows, xf.y, xf.y + xf.h);
  const cols = ex.slice(1).map((v, i) => v - ex[i]!);
  const rows = ey.slice(1).map((v, i) => v - ey[i]!);
  if (cols.some((v) => !(v > 0)) || rows.some((v) => !(v > 0))) return null;

  const opacity = st.opacity * doc.get(id, 'opacity');
  const gap = Math.max(doc.get(id, 'gridColumnGap'), doc.get(id, 'gridRowGap'));
  const lineColor = colorOfPaint(visiblePaints(doc.get(id, 'fills'))[0]);
  const line: Line | null = gap > 0 && lineColor ? { ...lineColor, w: gap, dash: null } : null;
  const inner: State = { opacity, clip: st.clip };
  const over: El[] = [];
  const grid: TableCell[][] = [];
  for (let r = 0; r < nRows; r++) {
    const row: TableCell[] = [];
    for (let c = 0; c < nCols; c++) {
      const cell = at(r, c);
      const covered = cover[r * nCols + c];
      const blank: TableCell = { paras: [], align: 'l', anchor: 't', fill: null, mar: [0, 0, 0, 0], span: 1, rowSpan: 1, hMerge: false, vMerge: false };
      if (covered) {
        row.push({ ...blank, hMerge: c > covered.c, vMerge: r > covered.r });
        continue;
      }
      if (!doc.get(cell, 'visible')) {
        row.push(blank);
        continue;
      }
      const b = rect(cell);
      const { texts, others } = cellContent(cell, ctx);
      const te = cellText(texts, inner, ctx);
      const text = texts.length === 1 && doc.parent(texts[0]!) === cell ? texts[0]! : null;
      const vertical = doc.get(cell, 'layoutMode') !== 'HORIZONTAL';
      const pad: [number, number, number, number] = [doc.get(cell, 'paddingTop'), doc.get(cell, 'paddingRight'), doc.get(cell, 'paddingBottom'), doc.get(cell, 'paddingLeft')];
      const v = vertical ? doc.get(cell, 'primaryAlign') : doc.get(cell, 'counterAlign');
      let align = te?.align ?? 'l';
      let mar = pad;
      if (te && others.length) {
        // Next to a badge the text keeps its own place: the margin on the badge's side is up to the text,
        // the other one is the cell's, so a wider font in PowerPoint does not wrap it.
        const boxes = others.map(rect);
        const before = boxes.some((o) => o.x + o.w <= te.x + 0.5);
        const after = boxes.some((o) => o.x >= te.x + te.w - 0.5);
        mar = [pad[0], after ? Math.max(0, b.x + b.w - te.x - te.w) : pad[1], pad[2], before ? Math.max(0, te.x - b.x) : pad[3]];
        if (before !== after) align = before ? 'l' : 'r';
      } else if (te && !text) {
        // Wrapped (a <div> of an HTML page) or several texts: they stay where they are in the cell.
        const left = Math.max(0, te.x - b.x);
        const right = Math.max(0, b.x + b.w - te.x - te.w);
        if (texts.every((t) => doc.get(t, 'textAutoResize') === 'WIDTH_AND_HEIGHT')) {
          align = Math.abs(left - right) < 2 ? 'ctr' : left < right ? 'l' : 'r';
          mar = [pad[0], align === 'r' ? right : pad[1], pad[2], align === 'l' ? left : pad[3]];
        } else mar = [pad[0], right, pad[2], left];
        if (v !== 'CENTER' && v !== 'MAX') mar[0] = Math.max(0, te.y - b.y);
        if (v === 'MAX') mar[2] = Math.max(0, b.y + b.h - te.y - te.h);
      } else if (text && doc.get(text, 'textAutoResize') === 'WIDTH_AND_HEIGHT') {
        // A text as wide as its words stands where the cell puts it.
        const h = vertical ? doc.get(cell, 'counterAlign') : doc.get(cell, 'primaryAlign');
        align = h === 'CENTER' ? 'ctr' : h === 'MAX' ? 'r' : 'l';
      }
      const paint = visiblePaints(doc.get(cell, 'fills')).at(-1);
      const fill: Fill | null = !paint ? null : paint.type === 'SOLID' ? { type: 'solid', color: hex(paint.color), alpha: paint.color.a * paint.opacity } : paint.type === 'IMAGE' || paint.type === 'PATTERN' ? null : gradientOf(paint, b.w, b.h);
      row.push({
        paras: te?.paras ?? [],
        align,
        anchor: v === 'CENTER' || v === 'MAX' ? ALIGN_TO_ANCHOR[v] : 't',
        fill,
        mar,
        span: Math.min(nCols - c, Math.max(1, doc.get(cell, 'gridColumnSpan'))),
        rowSpan: Math.min(nRows - r, Math.max(1, doc.get(cell, 'gridRowSpan'))),
        hMerge: false,
        vMerge: false,
      });
      for (const k of others) over.push(...(await walk(k, inner, ctx)));
    }
    grid.push(row);
  }
  const table: TableEl = {
    k: 'table',
    name: doc.get(id, 'name'),
    x: xf.x,
    y: xf.y,
    w: xf.w,
    h: xf.h,
    rot: 0,
    opacity,
    clip: st.clip,
    cols,
    rows,
    cells: grid,
    line,
    paraSpacing: 0,
  };
  return [table, ...over];
}

function lineElement(id: NodeId, st: State, ctx: Ctx): El[] {
  const stroke = strokeOf(ctx.doc, id);
  if (!stroke) return [];
  const m = ctx.env.world(id);
  const w = ctx.doc.get(id, 'width');
  const cap = ctx.doc.get(id, 'strokeCap');
  return [
    {
      k: 'line',
      x1: m.e - ctx.ox,
      y1: m.f - ctx.oy,
      x2: m.a * w + m.e - ctx.ox,
      y2: m.b * w + m.f - ctx.oy,
      name: ctx.doc.get(id, 'name'),
      opacity: st.opacity * ctx.doc.get(id, 'opacity'),
      clip: st.clip,
      line: { color: stroke.color, alpha: stroke.alpha, w: stroke.w, dash: stroke.dash, cap: cap === 'ROUND' ? 'rnd' : cap === 'SQUARE' ? 'sq' : null },
    },
  ];
}

async function rasterElement(id: NodeId, st: State, ctx: Ctx, preferSvg: boolean): Promise<El[]> {
  const b = ctx.env.bounds(id);
  if (b.width <= 0 && b.height <= 0) return [];
  let scale = ctx.opts.scale;
  if (Math.max(b.width, b.height) * scale > 4096) scale = 4096 / Math.max(b.width, b.height);
  const png = await ctx.env.raster(id, scale).catch(() => null);
  if (!png) return [];
  const r = png.bounds;
  const el: PicEl = {
    k: 'pic',
    x: r.x - ctx.ox,
    y: r.y - ctx.oy,
    w: r.width,
    h: r.height,
    rot: 0,
    name: ctx.doc.get(id, 'name'),
    img: addImage(ctx, png.bytes, 'png'),
    crop: { l: 0, t: 0, r: 0, b: 0 },
    alpha: 1,
    opacity: st.opacity,
    clip: st.clip,
    raster: true,
  };
  if (preferSvg && ctx.opts.svg) {
    const svg = ctx.env.svg(id);
    if (svg) el.svg = addImage(ctx, new TextEncoder().encode(svg), 'svg');
  }
  ctx.rasterized++;
  return [el];
}

async function walk(id: NodeId, st: State, ctx: Ctx): Promise<El[]> {
  const doc = ctx.doc;
  if (!doc.get(id, 'visible')) return [];
  const t = doc.type(id);
  // A warped layer (mockups): its stretched picture.
  if (doc.get(id, 'warp')) return rasterElement(id, st, ctx, false);

  if (t === 'TEXT') {
    if (oddBlend(doc.get(id, 'blendMode')) || visibleEffect(doc.get(id, 'effects'), 'LAYER_BLUR')) return rasterElement(id, st, ctx, false);
    const te = textElement(id, st, ctx);
    return te ? [te] : [];
  }

  if (CONTAINERS.has(t)) {
    if (t === 'FRAME' && doc.get(id, 'table')) {
      const table = await tableElements(id, st, ctx);
      if (table) return table;
    }
    if (nodeNeedsRaster(doc, id) || xfrmOf(id, ctx).flipped) return rasterElement(id, st, ctx, !hasImageInside(doc, id));
    if (doc.children(id).length && isIconLike(doc, id)) return rasterElement(id, st, ctx, true);
    const inner: State = { opacity: st.opacity * doc.get(id, 'opacity'), clip: st.clip };
    let own: { below: El[]; above: El[] } | null = { below: [], above: [] };
    if (t !== 'GROUP') {
      own = await shapeElements(id, inner, ctx, true);
      if (!own) return rasterElement(id, st, ctx, false);
    }
    if (t !== 'GROUP' && t !== 'SECTION' && doc.get(id, 'clipsContent')) {
      const xf = xfrmOf(id, ctx);
      if (!xf.rot) {
        const m2 = Math.min(xf.w, xf.h) / 2;
        const rr = (radiiOf(doc, id) ?? [0, 0, 0, 0]).map((v) => Math.min(v, m2));
        inner.clip = clipWith(st.clip, { x: xf.x, y: xf.y, w: xf.w, h: xf.h, radii: rr });
      }
    }
    const kids: El[] = [];
    for (const c of doc.paintChildren(id)) kids.push(...(await walk(c, inner, ctx)));
    const all = [...own.below, ...kids, ...own.above];
    // PowerPoint does not group a table with other shapes.
    if (ctx.opts.groups && all.length > 1 && !all.some((e) => e.k === 'table')) return [{ k: 'group', name: doc.get(id, 'name'), els: all }];
    return all;
  }

  if (t === 'RECTANGLE' || t === 'ELLIPSE') {
    if (nodeNeedsRaster(doc, id) || doc.get(id, 'cornerSmoothing') > 0) return rasterElement(id, st, ctx, !hasImageInside(doc, id));
    const o = await shapeElements(id, { opacity: st.opacity * doc.get(id, 'opacity'), clip: st.clip }, ctx, false);
    if (!o) return rasterElement(id, st, ctx, !hasImageInside(doc, id));
    return o.below;
  }

  if (t === 'LINE') {
    const plain = doc.get(id, 'startCap') === 'NONE' && doc.get(id, 'endCap') === 'NONE';
    if (plain && !oddBlend(doc.get(id, 'blendMode')) && !visibleEffect(doc.get(id, 'effects'), 'LAYER_BLUR')) return lineElement(id, st, ctx);
    return rasterElement(id, st, ctx, true);
  }

  return rasterElement(id, st, ctx, !hasImageInside(doc, id));
}

function collectFonts(els: readonly El[], out: Set<string>): void {
  for (const e of els) {
    if (e.k === 'group') collectFonts(e.els, out);
    else if (e.k === 'text') for (const p of e.paras) for (const r of p.runs) out.add(r.font);
    else if (e.k === 'table') for (const row of e.cells) for (const c of row) for (const p of c.paras) for (const r of p.runs) out.add(r.font);
  }
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

async function buildSlide(root: NodeId, ctx: Ctx): Promise<Slide> {
  const doc = ctx.doc;
  const bb = ctx.env.bounds(root);
  ctx.ox = bb.x;
  ctx.oy = bb.y;
  const slide: Slide = { name: doc.get(root, 'name'), w: bb.width, h: bb.height, bg: null, els: [] };
  const rotated = Math.abs(doc.get(root, 'rotation')) > 0.01;

  if (ctx.opts.mode === 'image' || rotated) {
    let scale = ctx.opts.scale;
    if (Math.max(bb.width, bb.height) * scale > 8192) scale = 8192 / Math.max(bb.width, bb.height);
    const png = await ctx.env.raster(root, scale);
    if (png) {
      // Shadows and outside strokes reach past the frame: the slide shows the frame itself.
      const r = png.bounds;
      slide.els.push({ k: 'pic', x: r.x - bb.x, y: r.y - bb.y, w: r.width, h: r.height, rot: 0, name: slide.name, img: addImage(ctx, png.bytes, 'png'), crop: { l: 0, t: 0, r: 0, b: 0 }, alpha: 1, opacity: 1, clip: { x: 0, y: 0, w: bb.width, h: bb.height }, raster: true });
    }
    return slide;
  }

  const st: State = { opacity: 1, clip: { x: 0, y: 0, w: bb.width, h: bb.height } };
  if (doc.type(root) === 'GROUP' || !CONTAINERS.has(doc.type(root))) {
    slide.els = await walk(root, st, ctx);
    if (slide.els.length === 1 && slide.els[0]!.k === 'group') slide.els = slide.els[0]!.els;
    return slide;
  }
  if (nodeNeedsRaster(doc, root)) {
    slide.els = await rasterElement(root, st, ctx, false);
    return slide;
  }

  // Background: one solid colour → the slide's background, otherwise a shape or picture over the whole slide.
  const fills = visiblePaints(doc.get(root, 'fills'));
  const only = fills[0];
  if (fills.length === 1 && only?.type === 'SOLID' && only.opacity * only.color.a >= 0.999) {
    slide.bg = hex(only.color);
  } else if (fills.length) {
    const own = await shapeElements(root, st, ctx, true);
    if (own) {
      for (const e of own.below) if (e.k === 'shape' || e.k === 'pic') Object.assign(e, { radii: [0, 0, 0, 0], shadow: null });
      slide.els.push(...own.below);
    } else slide.bg = 'FFFFFF';
  }
  const inner: State = { opacity: 1, clip: st.clip };
  for (const c of doc.children(root)) slide.els.push(...(await walk(c, inner, ctx)));
  return slide;
}

export async function collectSlides(doc: Document, ids: readonly NodeId[], env: CollectEnv, opts: CollectOptions, onProgress: (done: number, total: number) => void = () => {}): Promise<Collected> {
  const ctx: Ctx = { doc, env, opts, images: [], imageKeys: new Map(), imageSizes: new Map(), rasterized: 0, ox: 0, oy: 0 };
  const slides: Slide[] = [];
  const fonts = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    onProgress(i, ids.length);
    const slide = await buildSlide(ids[i]!, ctx);
    collectFonts(slide.els, fonts);
    slides.push(slide);
  }
  onProgress(ids.length, ids.length);
  return { slides, images: ctx.images, rasterized: ctx.rasterized, fonts: [...fonts].sort() };
}
