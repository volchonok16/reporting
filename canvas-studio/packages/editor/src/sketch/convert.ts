// Import of Sketch files (step 9): a .sketch (Sketch 43 and later) is a ZIP of JSON — document.json, a JSON
// per page, pictures in images/. Read here, in the browser, by our own code. What comes over: pages, artboards
// (frames), groups, rectangles, ovals and paths (editable vectors), boolean groups, texts
// with styled parts, pictures, masks, slices, symbols (components) and their instances with text overrides and
// swapped nested symbols, fills (colour, gradient, picture), borders, shadows, blurs, opacity, blending, export
// settings and prototype links. Shared styles come as the layers' own look; Smart Layout is not carried.

import { canContain, Document, tr } from '#core';
import type { BlendMode, Color, Effect, ExportSetting, NodeId, NodeProps, Paint, PropKey, Reaction, StrokeAlign, StrokeCap, StrokeJoin, TextAlignH, TextAlignV, TextAutoResize, TextRun, TextRunStyle, Transaction, VectorPath, VectorPoint } from '#core';
import { markOverrides, sourceOf, syncComponents, wouldCreateCycle } from '#components';
import { parseFontStyle } from '../fig/convert.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sk = Record<string, any>;

export interface SketchArchive {
  document: Sk;
  pages: Sk[];
  /** Files by path inside the archive (pictures). */
  files: Map<string, Uint8Array>;
}

export interface SketchImportResult {
  doc: Document;
  count: number;
  components: number;
  instances: number;
  unlinked: number;
  skipped: Map<string, number>;
  fonts: Set<string>;
  missingImages: number;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

/** "{0.5, 0.25}" → { x: 0.5, y: 0.25 }. */
export function parsePoint(s: unknown): { x: number; y: number } {
  const m = /\{\s*(-?[\d.e+-]+)\s*,\s*(-?[\d.e+-]+)\s*\}/i.exec(String(s ?? ''));
  return m ? { x: Number(m[1]) || 0, y: Number(m[2]) || 0 } : { x: 0, y: 0 };
}

function color(c: Sk | undefined): Color {
  return { r: clamp01(num(c?.red)), g: clamp01(num(c?.green)), b: clamp01(num(c?.blue)), a: clamp01(num(c?.alpha, 1)) };
}

/** A PostScript name as a family and a style: "HelveticaNeue-MediumItalic" → Helvetica Neue, 500, italic. */
export function fontOf(postscript: string): { family: string; weight: number; italic: boolean } {
  const name = postscript.replace(/^\./, '');
  const [rawFamily, rawStyle = 'Regular'] = name.split('-');
  const spaced = (s: string) =>
    s
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .trim();
  // Apple's system font goes by its UI name.
  const family = /^SFNS|^SF\s?Pro/.test(rawFamily!) ? (/Display/.test(rawFamily!) ? 'SF Pro Display' : 'SF Pro Text') : spaced(rawFamily!);
  const style = parseFontStyle(spaced(rawStyle));
  return { family, ...style };
}

const BLEND: BlendMode[] = ['NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY', 'PLUS_DARKER', 'PLUS_LIGHTER'];

class Converter {
  readonly tx: Transaction;
  readonly files: Map<string, Uint8Array>;
  count = 0;
  components = 0;
  linked = 0;
  unlinked = 0;
  missingImages = 0;
  readonly skipped = new Map<string, number>();
  readonly fonts = new Set<string>();
  /** Sketch object ids → ours. */
  readonly ours = new Map<string, NodeId>();
  /** symbolID → the component made of its master. */
  readonly symbols = new Map<string, NodeId>();
  readonly instances: { id: NodeId; sk: Sk }[] = [];
  readonly flows: { id: NodeId; flow: Sk }[] = [];
  private readonly images = new Map<string, string | null>();

  constructor(tx: Transaction, files: Map<string, Uint8Array>) {
    this.tx = tx;
    this.files = files;
  }

  skip(what: string): void {
    this.skipped.set(what, (this.skipped.get(what) ?? 0) + 1);
  }

  /** A picture of the archive as a resource of the file (null — not in the archive). */
  private image(ref: unknown): string | null {
    const path = String(ref ?? '');
    if (!path) return null;
    if (this.images.has(path)) return this.images.get(path)!;
    const bytes = this.files.get(path) ?? this.files.get(`${path}.png`) ?? this.files.get(`${path}.jpg`) ?? null;
    let hash: string | null = null;
    if (bytes) {
      const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : bytes[0] === 0x52 ? 'image/webp' : null;
      if (mime) hash = this.tx.addBlob(bytes, mime);
    }
    if (!hash) this.missingImages++;
    this.images.set(path, hash);
    return hash;
  }

  private paint(f: Sk): Paint | null {
    const visible = f.isEnabled !== false;
    const opacity = clamp01(num(f.contextSettings?.opacity, 1));
    const type = num(f.fillType);
    if (type === 1 && f.gradient) {
      const g = f.gradient;
      const kind = num(g.gradientType) === 1 ? 'GRADIENT_RADIAL' : num(g.gradientType) === 2 ? 'GRADIENT_ANGULAR' : 'GRADIENT_LINEAR';
      const stops = ((g.stops ?? []) as Sk[]).map((s) => ({ position: clamp01(num(s.position)), color: color(s.color) }));
      if (stops.length === 0) return null;
      return { type: kind, stops, from: parsePoint(g.from), to: parsePoint(g.to), opacity, visible };
    }
    if (type === 4 && f.image) {
      const hash = this.image(f.image._ref);
      if (!hash) return { type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 }, opacity, visible };
      // patternFillType: 0 tile, 1 fill, 2 stretch, 3 fit.
      const mode = num(f.patternFillType, 1);
      return { type: 'IMAGE', imageHash: hash, scaleMode: mode === 0 ? 'TILE' : mode === 2 ? 'STRETCH' : mode === 3 ? 'FIT' : 'FILL', scale: Math.max(0.01, num(f.patternTileScale, 1)), opacity, visible };
    }
    return { type: 'SOLID', color: color(f.color), opacity, visible };
  }

  /** The look of a layer: fills, borders, shadows, blurs, opacity and blending. */
  private style(sk: Sk, withFills = true): Partial<NodeProps> {
    const st: Sk = sk.style ?? {};
    const out: Partial<NodeProps> = {};
    if (withFills) out.fills = ((st.fills ?? []) as Sk[]).map((f) => this.paint(f)).filter((p): p is Paint => !!p);
    const borders = (st.borders ?? []) as Sk[];
    out.strokes = borders.map((b) => this.paint(b)).filter((p): p is Paint => !!p);
    const on = borders.filter((b) => b.isEnabled !== false);
    if (borders.length) {
      out.strokeWeight = Math.max(0, ...(on.length ? on : borders).map((b) => num(b.thickness, 1)));
      const pos = num((on[0] ?? borders[0])!.position);
      out.strokeAlign = (pos === 1 ? 'INSIDE' : pos === 2 ? 'OUTSIDE' : 'CENTER') as StrokeAlign;
    }
    const opts: Sk = st.borderOptions ?? {};
    if (Array.isArray(opts.dashPattern) && opts.dashPattern.length) out.dashPattern = opts.dashPattern.map((v: unknown) => Math.max(0, num(v)));
    if (opts.lineCapStyle !== undefined) out.strokeCap = (['NONE', 'ROUND', 'SQUARE'] as StrokeCap[])[num(opts.lineCapStyle)] ?? 'NONE';
    if (opts.lineJoinStyle !== undefined) out.strokeJoin = (['MITER', 'ROUND', 'BEVEL'] as StrokeJoin[])[num(opts.lineJoinStyle)] ?? 'MITER';
    const effects: Effect[] = [];
    for (const [list, type] of [[st.shadows, 'DROP_SHADOW'], [st.innerShadows, 'INNER_SHADOW']] as const) {
      for (const s of (list ?? []) as Sk[]) effects.push({ type, color: color(s.color), offset: { x: num(s.offsetX), y: num(s.offsetY) }, radius: Math.max(0, num(s.blurRadius)), spread: num(s.spread), visible: s.isEnabled !== false });
    }
    if (st.blur && st.blur.isEnabled) effects.push({ type: num(st.blur.type) === 3 ? 'BACKGROUND_BLUR' : 'LAYER_BLUR', radius: Math.max(0, num(st.blur.radius)), visible: true });
    out.effects = effects;
    const ctx: Sk = st.contextSettings ?? {};
    out.opacity = clamp01(num(ctx.opacity, 1));
    const blend = BLEND[num(ctx.blendMode)];
    if (blend && blend !== 'NORMAL') out.blendMode = blend;
    return out;
  }

  /** Where a layer is: Sketch keeps the unturned frame and turns it about its centre (counter-clockwise). */
  private place(sk: Sk): Partial<NodeProps> {
    const f: Sk = sk.frame ?? {};
    const w = Math.max(0, num(f.width));
    const h = Math.max(0, num(f.height));
    const rotation = -num(sk.rotation);
    const cx = num(f.x) + w / 2;
    const cy = num(f.y) + h / 2;
    const r = (rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return {
      name: String(sk.name ?? ''),
      x: round(cx - (w / 2) * cos + (h / 2) * sin),
      y: round(cy - (w / 2) * sin - (h / 2) * cos),
      width: round(w),
      height: round(h),
      rotation: Math.abs(rotation) < 0.001 ? 0 : round(rotation),
      visible: sk.isVisible !== false,
      locked: !!sk.isLocked,
    };
  }

  private exports(sk: Sk): ExportSetting[] | undefined {
    const formats = (sk.exportOptions?.exportFormats ?? []) as Sk[];
    if (!formats.length) return undefined;
    const out: ExportSetting[] = [];
    for (const f of formats) {
      const ext = String(f.fileFormat ?? 'png').toUpperCase();
      const format = (ext === 'JPEG' ? 'JPG' : ext) as ExportSetting['format'];
      if (!['PNG', 'JPG', 'WEBP', 'SVG', 'PDF'].includes(format)) continue;
      const kind = num(f.visibleScaleType);
      const size = kind === 1 || kind === 2 ? { side: kind === 1 ? ('WIDTH' as const) : ('HEIGHT' as const), px: Math.max(1, num(f.absoluteSize)) } : undefined;
      out.push({ format, scale: Math.max(0.01, num(f.scale, 1)), suffix: String(f.name ?? ''), ...(size ? { size } : {}) });
    }
    return out.length ? out : undefined;
  }

  /** A path of normalised curve points (0..1 of the frame) in the layer's own pixels; flips mirror it. */
  private path(sk: Sk, w: number, h: number): VectorPath | null {
    const points = (sk.points ?? []) as Sk[];
    if (points.length < 2) return null;
    const fx = sk.isFlippedHorizontal ? (x: number) => w - x : (x: number) => x;
    const fy = sk.isFlippedVertical ? (y: number) => h - y : (y: number) => y;
    const at = (s: unknown) => {
      const p = parsePoint(s);
      return { x: round(fx(p.x * w)), y: round(fy(p.y * h)) };
    };
    const out: VectorPoint[] = points.map((p) => {
      const pt: VectorPoint = at(p.point);
      // Older files have no hasCurve flags: a handle away from its point is a curve.
      const from = at(p.curveFrom);
      const to = at(p.curveTo);
      const curveFrom = p.hasCurveFrom ?? (from.x !== pt.x || from.y !== pt.y);
      const curveTo = p.hasCurveTo ?? (to.x !== pt.x || to.y !== pt.y);
      if (curveTo) pt.in = to;
      if (curveFrom) pt.out = from;
      return pt;
    });
    return { points: out, closed: sk.isClosed !== false };
  }

  /** A shape: rectangle and oval as themselves, every other outline as an editable vector. */
  private shape(sk: Sk, parent: NodeId, base: Partial<NodeProps>, look: Partial<NodeProps>): NodeId | null {
    const cls = String(sk._class);
    const w = num(base.width);
    const h = num(base.height);
    if (cls === 'rectangle') {
      const radii = ((sk.points ?? []) as Sk[]).map((p) => Math.max(0, num(p.cornerRadius)));
      const fixed = Math.max(0, num(sk.fixedRadius));
      const props: Partial<NodeProps> = { ...base, ...look };
      if (radii.length === 4 && radii.some((r) => r !== radii[0])) props.cornerRadii = radii as [number, number, number, number];
      else props.cornerRadius = radii[0] || fixed;
      return this.tx.create('RECTANGLE', parent, props);
    }
    if (cls === 'oval') return this.tx.create('ELLIPSE', parent, { ...base, ...look });
    const path = this.path(sk, w, h);
    if (!path) {
      this.skip('empty path');
      return null;
    }
    return this.tx.create('VECTOR', parent, { ...base, ...look, vectorPaths: [path], windingRule: num(sk.style?.windingRule) === 1 ? 'EVENODD' : 'NONZERO' });
  }

  /** A text: its string, the first part's style for the layer, the parts that differ as runs. */
  private text(sk: Sk, parent: NodeId, base: Partial<NodeProps>, look: Partial<NodeProps>): NodeId {
    const as: Sk = sk.attributedString ?? {};
    const string = String(as.string ?? '');
    const runs = ((as.attributes ?? []) as Sk[]).filter((a) => a && a.attributes);
    const fallback: Sk = sk.style?.textStyle?.encodedAttributes ?? {};
    const styleOf = (attrs: Sk): TextRunStyle & { align?: TextAlignH; lineHeight?: number } => {
      const font = attrs.MSAttributedStringFontAttribute?.attributes ?? {};
      const f = fontOf(String(font.name ?? 'Inter-Regular'));
      this.fonts.add(f.family);
      const s: TextRunStyle & { align?: TextAlignH; lineHeight?: number } = { fontFamily: f.family, fontWeight: f.weight, italic: f.italic, fontSize: Math.max(1, num(font.size, 14)) };
      if (attrs.MSAttributedStringColorAttribute) s.fills = [{ type: 'SOLID', color: color(attrs.MSAttributedStringColorAttribute), opacity: 1, visible: true }];
      if (attrs.kerning !== undefined) s.letterSpacing = { unit: 'PX', value: num(attrs.kerning) };
      if (num(attrs.underlineStyle) > 0) s.textDecoration = 'UNDERLINE';
      else if (num(attrs.strikethroughStyle) > 0) s.textDecoration = 'STRIKETHROUGH';
      const para = attrs.paragraphStyle ?? {};
      const al = num(para.alignment, 0);
      s.align = al === 1 ? 'RIGHT' : al === 2 ? 'CENTER' : al === 3 ? 'JUSTIFIED' : 'LEFT';
      if (num(para.maximumLineHeight) > 0) s.lineHeight = num(para.maximumLineHeight);
      return s;
    };
    const first = styleOf(runs[0]?.attributes ?? fallback);
    const behaviour = num(sk.textBehaviour);
    const vAlign = num(sk.style?.textStyle?.verticalAlignment);
    const transform = num((runs[0]?.attributes ?? fallback).MSAttributedStringTextTransformAttribute);
    const props: Partial<NodeProps> = {
      ...base,
      ...look,
      characters: string,
      fontFamily: first.fontFamily!,
      fontWeight: first.fontWeight!,
      italic: !!first.italic,
      fontSize: first.fontSize!,
      fills: first.fills ?? look.fills ?? [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }],
      textAlignH: first.align ?? 'LEFT',
      textAlignV: (vAlign === 1 ? 'CENTER' : vAlign === 2 ? 'BOTTOM' : 'TOP') as TextAlignV,
      textAutoResize: (behaviour === 0 ? 'WIDTH_AND_HEIGHT' : behaviour === 1 ? 'HEIGHT' : 'NONE') as TextAutoResize,
      textCase: transform === 1 ? 'UPPER' : transform === 2 ? 'LOWER' : 'ORIGINAL',
    };
    if (first.letterSpacing) props.letterSpacing = first.letterSpacing;
    if (first.textDecoration) props.textDecoration = first.textDecoration;
    if (first.lineHeight) props.lineHeight = { unit: 'PX', value: first.lineHeight };
    // Parts styled otherwise than the first: runs of their differences.
    const textRuns: TextRun[] = [];
    for (const r of runs.slice(1)) {
      const s = styleOf(r.attributes);
      const diff: TextRunStyle = {};
      for (const k of ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'textDecoration'] as const) if (s[k] !== undefined && s[k] !== props[k]) (diff as Record<string, unknown>)[k] = s[k];
      if (s.fills && JSON.stringify(s.fills) !== JSON.stringify(props.fills)) diff.fills = s.fills;
      if (s.letterSpacing && JSON.stringify(s.letterSpacing) !== JSON.stringify(props.letterSpacing)) diff.letterSpacing = s.letterSpacing;
      const start = Math.max(0, num(r.location));
      const end = Math.min(string.length, start + Math.max(0, num(r.length)));
      if (end > start && Object.keys(diff).length) textRuns.push({ start, end, style: diff });
    }
    if (textRuns.length) props.textRuns = textRuns;
    return this.tx.create('TEXT', parent, props);
  }

  /** A layer and what it holds. */
  layer(sk: Sk, parent: NodeId): void {
    const cls = String(sk._class ?? '');
    const base = this.place(sk);
    const exportSettings = this.exports(sk);
    let id: NodeId | null = null;
    let kids: Sk[] = [];
    const want = (type: Parameters<typeof canContain>[1]) => canContain(this.tx.doc.type(parent), type);
    switch (cls) {
      case 'artboard':
      case 'symbolMaster': {
        const type = cls === 'symbolMaster' ? 'COMPONENT' : 'FRAME';
        if (!want(type)) {
          this.skip(cls);
          return;
        }
        const bg = sk.hasBackgroundColor ? [{ type: 'SOLID' as const, color: color(sk.backgroundColor), opacity: 1, visible: true }] : cls === 'artboard' ? [{ type: 'SOLID' as const, color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }] : [];
        id = this.tx.create(type, parent, { ...base, ...this.style(sk, false), fills: bg, clipsContent: true });
        if (cls === 'symbolMaster') {
          this.components++;
          if (sk.symbolID) this.symbols.set(String(sk.symbolID), id);
        }
        kids = sk.layers ?? [];
        break;
      }
      case 'group':
        id = this.tx.create('GROUP', parent, { ...base, ...this.style(sk, false) });
        kids = sk.layers ?? [];
        break;
      case 'shapeGroup': {
        const shapes = (sk.layers ?? []) as Sk[];
        const look = this.style(sk);
        // One shape: the shape itself with the group's look (older files wrap every shape so).
        if (shapes.length === 1) {
          const only = shapes[0]!;
          const inner = this.place(only);
          id = this.shape(only, parent, { ...base, width: inner.width, height: inner.height, x: num(base.x) + num(inner.x), y: num(base.y) + num(inner.y) }, look);
          break;
        }
        // The operation of the layers after the first (Sketch keeps one per layer): the one most of them use.
        const ops = shapes.slice(1).map((s) => num(s.booleanOperation, 0));
        const most = ops.sort((a, b) => ops.filter((x) => x === b).length - ops.filter((x) => x === a).length)[0] ?? 0;
        const booleanOp = most === 1 ? 'SUBTRACT' : most === 2 ? 'INTERSECT' : most === 3 ? 'EXCLUDE' : 'UNION';
        id = this.tx.create('BOOLEAN_OPERATION', parent, { ...base, ...look, booleanOp });
        for (const s of shapes) {
          const sid = this.shape(s, id, this.place(s), {});
          if (sid) this.count++;
        }
        break;
      }
      case 'rectangle':
      case 'oval':
      case 'shapePath':
      case 'triangle':
      case 'star':
      case 'polygon': {
        // A shape alone (Sketch 52+): a boolean operation with the next ones is not kept here.
        id = this.shape(sk, parent, base, this.style(sk));
        break;
      }
      case 'text':
        id = this.text(sk, parent, base, this.style(sk));
        break;
      case 'bitmap': {
        const hash = this.image(sk.image?._ref);
        const fill: Paint = hash ? { type: 'IMAGE', imageHash: hash, scaleMode: 'STRETCH', scale: 1, opacity: 1, visible: true } : { type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85, a: 1 }, opacity: 1, visible: true };
        id = this.tx.create('RECTANGLE', parent, { ...base, ...this.style(sk, false), fills: [fill] });
        break;
      }
      case 'slice':
        if (!want('SLICE')) return this.skip(cls);
        id = this.tx.create('SLICE', parent, base);
        break;
      case 'symbolInstance': {
        if (!want('INSTANCE')) return this.skip(cls);
        id = this.tx.create('INSTANCE', parent, { ...base, ...this.style(sk, false) });
        this.instances.push({ id, sk });
        break;
      }
      default:
        this.skip(cls || 'unknown');
        return;
    }
    if (!id) return;
    this.count++;
    if (sk.do_objectID) this.ours.set(String(sk.do_objectID), id);
    if (exportSettings) this.tx.set(id, 'exportSettings', exportSettings);
    // A clipping mask clips the layers after it in its group, as a mask of ours.
    if (sk.hasClippingMask) this.tx.set(id, 'isMask', true);
    if (sk.flow && (sk.flow.destinationArtboardID || sk.flow.isBackAction)) this.flows.push({ id, flow: sk.flow });
    for (const k of kids) this.layer(k, id);
  }

  /** Prototype links: a click goes to the artboard (or back), sliding as Sketch's animation says. */
  linkFlows(): void {
    const changed = new Map<NodeId, Set<PropKey>>();
    for (const { id, flow } of this.flows) {
      const back = flow.destinationArtboardID === 'back' || flow.isBackAction;
      const dest = back ? null : this.ours.get(String(flow.destinationArtboardID));
      if (!back && !dest) continue;
      const anim = num(flow.animationType, -1);
      const direction = anim === 0 ? 'LEFT' : anim === 1 ? 'RIGHT' : anim === 2 ? 'TOP' : anim === 3 ? 'BOTTOM' : null;
      const transition = direction ? { type: 'SLIDE_IN' as const, direction, duration: 300, easing: { type: 'EASE_OUT' as const } } : null;
      const reaction = { trigger: { type: 'ON_CLICK' }, actions: [back ? { type: 'BACK' } : { type: 'NAVIGATE', destinationId: dest, transition }] } as unknown as Reaction;
      this.tx.set(id, 'reactions', [reaction]);
      changed.set(id, new Set<PropKey>(['reactions']));
    }
    // An instance's own link: kept when its symbol changes.
    markOverrides(this.tx.doc, this.tx, changed);
  }

  /** The layer of an instance that shows `master` (a layer of its component, maybe through nested instances). */
  private mirrorIn(instance: NodeId, master: NodeId): NodeId | null {
    const doc = this.tx.doc;
    const shows = (x: NodeId): boolean => {
      const seen = new Set<NodeId>();
      let frontier = [x];
      for (let depth = 0; depth < 64 && frontier.length; depth++) {
        const next: NodeId[] = [];
        for (const n of frontier) {
          if (n === master) return true;
          if (seen.has(n)) continue;
          seen.add(n);
          const k = doc.get(n, 'componentKey');
          if (k && doc.store.isAlive(k)) next.push(k);
          const src = sourceOf(doc, n);
          if (src) next.push(src);
        }
        frontier = next;
      }
      return false;
    };
    let found: NodeId | null = null;
    doc.store.walk(instance, (n) => {
      if (found) return false;
      if (n !== instance && shows(n)) found = n;
      return !found;
    });
    return found;
  }

  /** "id1/id2_stringValue": the layer the override reaches, step by step through nested instances. */
  private resolve(instance: NodeId, path: string[]): NodeId | null {
    let at = instance;
    for (const objectId of path) {
      const master = this.ours.get(objectId);
      if (!master) return null;
      const hit = this.mirrorIn(at, master);
      if (!hit) return null;
      at = hit;
    }
    return at;
  }

  /** Instances get their components, then the overrides: nested symbols swapped first, then texts. */
  linkInstances(): void {
    const doc = this.tx.doc;
    const tx = this.tx;
    const live: { id: NodeId; sk: Sk }[] = [];
    for (const it of this.instances) {
      const main = this.symbols.get(String(it.sk.symbolID ?? ''));
      if (!main || wouldCreateCycle(doc, main, doc.parent(it.id)!)) {
        this.unlinked++;
        continue;
      }
      tx.set(it.id, 'mainComponent', main);
      live.push(it);
    }
    this.linked = live.length;
    if (!live.length) return;
    syncComponents(doc, tx, live.map((x) => x.id));
    const parse = (o: Sk) => {
      const m = /^(.*)_(stringValue|symbolID|image)$/.exec(String(o.overrideName ?? ''));
      return m ? { path: m[1]!.split('/'), kind: m[2]!, value: o.value } : null;
    };
    for (const pass of ['symbolID', 'stringValue'] as const) {
      const changed = new Map<NodeId, Set<PropKey>>();
      const set = (id: NodeId, key: PropKey, value: unknown) => {
        tx.set(id, key, value as never);
        let s = changed.get(id);
        if (!s) changed.set(id, (s = new Set()));
        s.add(key);
      };
      for (const { id, sk } of live) {
        for (const o of (sk.overrideValues ?? []) as Sk[]) {
          const ov = parse(o);
          if (!ov || ov.kind !== pass) continue;
          const target = this.resolve(id, ov.path);
          if (!target) continue;
          if (pass === 'symbolID') {
            const swap = ov.value ? this.symbols.get(String(ov.value)) : null;
            if (swap && doc.type(target) === 'INSTANCE') set(target, 'mainComponent', swap);
            else if (!ov.value) set(target, 'visible', false);
          } else if (doc.type(target) === 'TEXT') set(target, 'characters', String(ov.value ?? ''));
        }
      }
      markOverrides(doc, tx, changed);
      syncComponents(doc, tx, changed.keys());
    }
  }
}

export function convertSketch(archive: SketchArchive, name: string): SketchImportResult {
  const doc = new Document();
  let c!: Converter;
  doc.transact(
    (tx) => {
      const root = tx.createRoot(name);
      c = new Converter(tx, archive.files);
      for (const p of archive.pages) {
        const page = tx.create('PAGE', root, { name: String(p.name ?? tr('Страница')) });
        for (const l of (p.layers ?? []) as Sk[]) c.layer(l, page);
      }
      // Symbols of libraries the file uses: kept on a page of their own, as Sketch keeps them inside the file.
      const foreign = ((archive.document.foreignSymbols ?? []) as Sk[]).map((f) => f.symbolMaster).filter(Boolean) as Sk[];
      if (foreign.length) {
        const page = tx.create('PAGE', root, { name: tr('Символы библиотек') });
        let x = 0;
        for (const m of foreign) {
          c.layer({ ...m, frame: { ...m.frame, x, y: 0 } }, page);
          x += num(m.frame?.width) + 80;
        }
      }
      if (archive.pages.length === 0) tx.create('PAGE', root, { name: tr('Страница 1') });
      // Links after instances: synchronising an instance with its component would take its link away.
      c.linkInstances();
      c.linkFlows();
    },
    { undoable: false },
  );
  return { doc, count: c.count, components: c.components, instances: c.linked, unlinked: c.unlinked, skipped: c.skipped, fonts: c.fonts, missingImages: c.missingImages };
}
