// HTML import, last step: the tree of layers the sandboxed page reported
// (runtime.ts, in Figma's terms) becomes layers of our document — frames with
// fills, strokes, radii, shadows and auto layout, texts with mixed styles,
// images, SVG drawings. One edit: a single "Undo" removes the whole import.

import { safeLink, tr } from '#core';
import type { BlendMode, Color, Effect, GridTrack, NodeId, Paint, Sizing, TextRunStyle, Transaction } from '#core';
import type { Point } from '#geometry';
import type { Editor } from '../editor.ts';
import { buildSvgInto } from '../svg-import.ts';
import { bindSlideColors, createSlide, isSlides, slideIds, slideSize } from '../slides.ts';
import { scaleNode } from '#layout';

type Matrix2x3 = [[number, number, number], [number, number, number]];

/** A layer as runtime.ts describes it (the same object the Figma plugin received). */
export interface H2DNode {
  t: 'FRAME' | 'RECT' | 'TEXT' | 'SVG';
  name?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rt?: Matrix2x3;
  fills?: H2DPaint[];
  stroke?: { paint: H2DPaint; align?: 'INSIDE' | 'OUTSIDE' | 'CENTER'; w: [number, number, number, number]; dash?: number[] };
  radii?: [number, number, number, number];
  effects?: H2DEffect[];
  opacity?: number;
  blend?: string;
  clip?: boolean;
  al?: {
    mode: 'HORIZONTAL' | 'VERTICAL' | 'GRID';
    wrap?: boolean;
    cgap?: number;
    pad: [number, number, number, number];
    gap?: number;
    primary?: string;
    counter?: string;
    hugH?: boolean;
    hugV?: boolean;
    /** Wrapped rows spread apart (align-content: space-between). */
    acont?: string;
    /** GRID: tracks as the page computed them, and the gaps. */
    cols?: { type: string; value?: number }[];
    rows?: { type: string; value?: number }[];
    rowGap?: number;
    colGap?: number;
  } | null;
  /** A table of data (FEAT-169): column widths, the header row, the lines' colour; its children are the cells row by row. */
  tbl?: { cols: number[]; header: boolean; line: H2DPaint | null };
  /** A table's cell: spans, hidden (under a merged cell), padding [t, r, b, l], vertical alignment, least height. */
  cell?: { rs: number; cs: number; hidden: boolean; pad: [number, number, number, number]; va: string; minH: number };
  /** In a grid: row, column, spans, alignment in the cell. */
  grid?: { r: number; c: number; rs: number; cs: number; ha: string; va: string };
  abs?: boolean;
  fillH?: boolean;
  fillV?: boolean;
  /** A share of the row's free space (table cells: the column's width). */
  frH?: number;
  /** Max / min width while filling (CSS max-width; the min track of a responsive grid). */
  maxW?: number;
  minW?: number;
  children?: H2DNode[];
  // TEXT
  chars?: string;
  styles?: H2DTextStyle[];
  base?: number;
  ranges?: [number, number, number][];
  align?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  auto?: 'WIDTH_AND_HEIGHT' | 'HEIGHT';
  maxLines?: number;
  // SVG
  svg?: string;
  raster?: number | string;
}

interface H2DPaint {
  type: string;
  color?: { r: number; g: number; b: number; a?: number };
  opacity?: number;
  gradientStops?: { position: number; color: { r: number; g: number; b: number; a?: number } }[];
  gradientTransform?: Matrix2x3;
  imageId?: number | string;
  scaleMode?: string;
  scalingFactor?: number;
}

interface H2DEffect {
  type: string;
  color?: { r: number; g: number; b: number; a?: number };
  x?: number;
  y?: number;
  radius?: number;
  spread?: number;
}

interface H2DTextStyle {
  fam?: string[];
  w?: number;
  it?: boolean;
  size?: number;
  fills?: H2DPaint[];
  deco?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  ls?: number;
  lh?: number;
  tc?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  /** Address of the link the text is in (http/https only). */
  href?: string | null;
}

export interface H2DImage {
  id: number | string;
  bytes: Uint8Array;
}

const clamp01 = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};
const num = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const color = (c: H2DPaint['color'] | undefined): Color => ({ r: clamp01(c?.r), g: clamp01(c?.g), b: clamp01(c?.b), a: c?.a === undefined ? 1 : clamp01(c.a) });

const BLENDS = new Set(['MULTIPLY', 'SCREEN', 'OVERLAY', 'DARKEN', 'LIGHTEN', 'COLOR_DODGE', 'COLOR_BURN', 'HARD_LIGHT', 'SOFT_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']);
/** CSS generic families are not font names: the editor's own font stands in for them. */
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', '-apple-system', 'blinkmacsystemfont', 'emoji', 'math']);

function mimeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return 'image/png';
}

/** Inverse of an affine 2×3 matrix, applied to a point. */
function unapply(m: Matrix2x3, p: { x: number; y: number }): { x: number; y: number } {
  const [[a, c, e], [b, d, f]] = m;
  const det = a * d - b * c || 1;
  const x = p.x - e;
  const y = p.y - f;
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
}

export class HtmlImportBuilder {
  private readonly editor: Editor;
  private readonly tx: Transaction;
  private readonly hashes = new Map<string, string>();
  /** Font families that were not CSS names of real fonts (shown to the person). */
  readonly fonts = new Set<string>();
  count = 0;

  constructor(editor: Editor, tx: Transaction, images: H2DImage[]) {
    this.editor = editor;
    this.tx = tx;
    for (const im of images) {
      if (im.bytes?.length) this.hashes.set(String(im.id), tx.addBlob(im.bytes, mimeOf(im.bytes)));
    }
  }

  private paint(p: H2DPaint): Paint | null {
    const opacity = p.opacity === undefined ? 1 : clamp01(p.opacity);
    if (p.type === 'SOLID') return { type: 'SOLID', color: { ...color(p.color), a: 1 }, opacity: opacity * (p.color?.a ?? 1), visible: true };
    if (p.type.startsWith('GRADIENT_') && p.gradientStops?.length) {
      const stops = p.gradientStops.map((s) => ({ position: clamp01(s.position), color: color(s.color) })).sort((a, b) => a.position - b.position);
      if (stops.length === 1) stops.push({ position: 1, color: stops[0]!.color });
      const m = p.gradientTransform ?? [[1, 0, 0], [0, 1, 0]];
      // Figma's matrix maps the layer's unit square into gradient space; our handles are in the unit square.
      const linear = p.type === 'GRADIENT_LINEAR';
      const from = unapply(m, linear ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 });
      const to = unapply(m, { x: 1, y: 0.5 });
      const type = p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND' ? p.type : linear ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL';
      return { type, stops, from, to, opacity, visible: true };
    }
    if (p.type === 'IMAGE') {
      const hash = this.hashes.get(String(p.imageId));
      if (!hash) return { type: 'SOLID', color: { r: 0.86, g: 0.86, b: 0.88, a: 1 }, opacity: 1, visible: true };
      const mode = p.scaleMode === 'FIT' ? 'FIT' : p.scaleMode === 'TILE' ? 'TILE' : p.scaleMode === 'STRETCH' ? 'STRETCH' : 'FILL';
      return { type: 'IMAGE', imageHash: hash, scaleMode: mode, scale: Math.max(0.01, num(p.scalingFactor, 1)), opacity, visible: true };
    }
    return null;
  }

  private paints(list: H2DPaint[] | undefined): Paint[] {
    return (list ?? []).map((p) => this.paint(p)).filter((p): p is Paint => p !== null);
  }

  private effects(list: H2DEffect[] | undefined, isText: boolean): Effect[] {
    const out: Effect[] = [];
    for (const e of list ?? []) {
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        out.push({ type: e.type, color: color(e.color), offset: { x: num(e.x), y: num(e.y) }, radius: Math.max(0, num(e.radius)), spread: isText ? 0 : num(e.spread), visible: true });
      } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
        out.push({ type: e.type, radius: Math.max(0, num(e.radius)), visible: true });
      }
    }
    return out;
  }

  private family(fams: string[] | undefined): string {
    for (const f of fams ?? []) {
      const name = f.replace(/^["']|["']$/g, '').trim();
      if (name && !GENERIC.has(name.toLowerCase())) return name;
    }
    return 'Inter';
  }

  /** Position (and rotation) inside the parent; auto layout children are placed by the layout. */
  private place(n: H2DNode): { x: number; y: number; rotation: number } {
    if (n.rt) {
      const [[a, , e], [b, , f]] = n.rt;
      const rotation = (Math.atan2(num(b), num(a, 1)) * 180) / Math.PI;
      return { x: num(e), y: num(f), rotation: Math.abs(rotation) < 0.01 ? 0 : Math.round(rotation * 100) / 100 };
    }
    return { x: num(n.x), y: num(n.y), rotation: 0 };
  }

  /** Creates the layer and its children under `parent`; returns null for what cannot be shown. */
  build(n: H2DNode, parent: NodeId, parentAutoLayout = false): NodeId | null {
    const tx = this.tx;
    const pos = this.place(n);
    const w = Math.max(0.01, num(n.w, 1));
    const h = Math.max(0.01, num(n.h, 1));
    const common = {
      name: n.name || undefined,
      opacity: n.opacity === undefined ? 1 : clamp01(n.opacity),
      ...(n.blend && BLENDS.has(n.blend.toUpperCase().replace(/-/g, '_')) ? { blendMode: n.blend.toUpperCase().replace(/-/g, '_') as BlendMode } : {}),
      ...(parentAutoLayout && n.abs ? { positioning: 'ABSOLUTE' as const } : {}),
      ...(parentAutoLayout && !n.abs && n.grid ? this.gridPlace(n.grid) : {}),
    };
    let id: NodeId | null = null;
    if (n.t === 'TEXT') {
      if (!n.chars) return null;
      id = this.text(n, parent, pos, common);
    } else if (n.t === 'SVG') {
      id = n.svg ? buildSvgInto(tx, this.editor, n.svg, parent, { x: pos.x, y: pos.y, width: w, height: h }, n.name || 'SVG') : null;
      if (!id && n.raster !== undefined && this.hashes.has(String(n.raster))) {
        id = tx.create('RECTANGLE', parent, { ...common, x: pos.x, y: pos.y, width: w, height: h, fills: this.paints([{ type: 'IMAGE', imageId: n.raster, scaleMode: 'FIT' }]) });
      }
      if (id && common.opacity < 1) tx.set(id, 'opacity', common.opacity);
    } else if (n.t === 'FRAME' && n.tbl) {
      id = this.table(n, parent, pos, common);
    } else {
      const shape = {
        ...common,
        x: pos.x,
        y: pos.y,
        rotation: pos.rotation,
        width: w,
        height: h,
        fills: this.paints(n.fills),
        effects: this.effects(n.effects, false),
        ...this.stroke(n),
        ...this.radii(n),
      };
      if (n.t === 'RECT') id = tx.create('RECTANGLE', parent, shape);
      else {
        id = tx.create('FRAME', parent, { ...shape, clipsContent: !!n.clip, ...this.autoLayout(n) });
      }
    }
    if (!id) return null;
    this.count++;
    if (parentAutoLayout && !n.abs) {
      const sizing: { sizingH?: Sizing; sizingV?: Sizing } = {};
      if (n.frH) sizing.sizingH = { mode: 'FR', value: n.frH };
      else if (n.fillH) sizing.sizingH = { mode: 'FILL' };
      else if (n.al?.hugH) sizing.sizingH = { mode: 'HUG' };
      // A table's height is its rows'.
      if (n.fillV && !n.tbl) sizing.sizingV = { mode: 'FILL' };
      else if (n.al?.hugV) sizing.sizingV = { mode: 'HUG' };
      if (n.maxW) (sizing as Record<string, unknown>).maxWidth = { unit: 'PX', value: n.maxW };
      if (n.minW) (sizing as Record<string, unknown>).minWidth = { unit: 'PX', value: n.minW };
      // A text that fills its column wraps in it: its height follows the lines.
      if (n.t === 'TEXT' && sizing.sizingH && sizing.sizingH.mode !== 'HUG') (sizing as Record<string, unknown>).textAutoResize = 'HEIGHT';
      tx.update(id, sizing);
    }
    if (n.t === 'FRAME' && n.children?.length && !n.tbl) {
      for (const c of n.children) this.build(c, id, !!n.al);
    }
    return id;
  }

  /**
   * A table of the page as a real table (FEAT-169), the same as an inserted one (tables.ts):
   * a grid of cells whose rows grow with their texts, its lines its own fill between the cells.
   */
  private table(n: H2DNode, parent: NodeId, pos: { x: number; y: number }, common: Record<string, unknown>): NodeId {
    const t = n.tbl!;
    const kids = n.children ?? [];
    const cols = Math.max(1, t.cols.length);
    const line = t.line ? this.paint(t.line) : null;
    // Without lines the cells touch.
    const gap = line ? 1 : 0;
    const id = this.tx.create('FRAME', parent, {
      ...common,
      name: tr('Таблица'),
      table: { header: !!t.header },
      layoutMode: 'GRID',
      gridColumns: t.cols.map((w) => ({ kind: 'FR' as const, value: Math.max(1, Math.round(num(w, 1) * 100) / 100) })),
      gridRows: Array.from({ length: Math.ceil(kids.length / cols) }, () => ({ kind: 'HUG' as const })),
      gridColumnGap: gap,
      gridRowGap: gap,
      paddingTop: gap,
      paddingBottom: gap,
      paddingLeft: gap,
      paddingRight: gap,
      x: pos.x,
      y: pos.y,
      width: Math.max(1, num(n.w, 100)),
      height: Math.max(1, num(n.h, 100)),
      sizingH: { mode: 'FIXED' },
      sizingV: { mode: 'HUG' },
      fills: line ? [line] : [],
      clipsContent: true,
    });
    for (const k of kids) this.tableCell(k, id);
    return id;
  }

  /** One cell: a frame laying out its content, with one text the table edits (Tab, pasting, merging). */
  private tableCell(k: H2DNode, table: NodeId): void {
    const tx = this.tx;
    const c = k.cell ?? { rs: 1, cs: 1, hidden: false, pad: [0, 0, 0, 0], va: 'MIN', minH: 0 };
    const align = (v: string | undefined) => (v === 'CENTER' ? 'CENTER' : v === 'MAX' ? 'MAX' : 'MIN');
    let content = k.children ?? [];
    // A row of pieces (a badge and a name) is the cell's own row: its text stays a cell's text.
    const only = content.length === 1 ? content[0]! : null;
    const row = only && only.t === 'FRAME' && only.al?.mode === 'HORIZONTAL' && !only.fills?.length && !only.stroke && !only.effects?.length && only.children?.some((x) => x.t === 'TEXT') ? only : null;
    if (row) content = row.children ?? [];
    const cell = tx.create('FRAME', table, {
      name: tr('Ячейка'),
      layoutMode: row ? 'HORIZONTAL' : 'VERTICAL',
      itemSpacing: row ? num(row.al?.gap) : 0,
      primaryAlign: row ? align(row.al?.primary) : align(c.va),
      counterAlign: row ? align(c.va) : 'MIN',
      paddingTop: Math.max(0, num(c.pad[0])),
      paddingRight: Math.max(0, num(c.pad[1])),
      paddingBottom: Math.max(0, num(c.pad[2])),
      paddingLeft: Math.max(0, num(c.pad[3])),
      sizingH: { mode: 'FILL' },
      sizingV: { mode: 'FILL' },
      minHeight: c.minH > 0 ? { unit: 'PX', value: Math.round(c.minH) } : null,
      gridColumnSpan: Math.max(1, Math.round(num(c.cs, 1))),
      gridRowSpan: Math.max(1, Math.round(num(c.rs, 1))),
      visible: !c.hidden,
      clipsContent: false,
      fills: this.paints(k.fills),
    });
    let text = false;
    for (const x of content) {
      const made = this.build(x, cell, true);
      if (!made || x.t !== 'TEXT') continue;
      text = true;
      // In a column of blocks a text wraps in the cell's width.
      if (!row) tx.update(made, { sizingH: { mode: 'FILL' }, textAutoResize: 'HEIGHT' });
    }
    if (!text) tx.create('TEXT', cell, { name: tr('Текст'), characters: '', sizingH: { mode: 'FILL' }, textAutoResize: 'HEIGHT', width: 100 });
  }

  private stroke(n: H2DNode): Record<string, unknown> {
    const s = n.stroke;
    if (!s) return {};
    const strokes = this.paints([s.paint]);
    if (strokes.length === 0) return {};
    const ws = s.w.map((v) => Math.max(0, num(v))) as [number, number, number, number];
    const same = ws.every((v) => v === ws[0]);
    return {
      strokes,
      strokeWeight: Math.max(...ws),
      strokeWeights: same ? null : ws,
      strokeAlign: s.align ?? 'INSIDE',
      ...(s.dash?.length ? { dashPattern: s.dash.map((v) => Math.max(0, num(v))) } : {}),
    };
  }

  private radii(n: H2DNode): Record<string, unknown> {
    const r = n.radii;
    if (!r) return {};
    const rs = r.map((v) => Math.max(0, num(v))) as [number, number, number, number];
    return rs.every((v) => v === rs[0]) ? { cornerRadius: rs[0] } : { cornerRadius: rs[0], cornerRadii: rs };
  }

  /** A grid item's cell and alignment, as the page placed it. */
  private gridPlace(g: NonNullable<H2DNode['grid']>): Record<string, unknown> {
    const align = (v: string) => (v === 'CENTER' ? 'CENTER' : v === 'MAX' ? 'MAX' : 'MIN');
    return {
      gridColumn: Math.max(0, Math.round(num(g.c))),
      gridRow: Math.max(0, Math.round(num(g.r))),
      gridColumnSpan: Math.max(1, Math.round(num(g.cs, 1))),
      gridRowSpan: Math.max(1, Math.round(num(g.rs, 1))),
      gridAlignH: align(g.ha),
      gridAlignV: align(g.va),
    };
  }

  private autoLayout(n: H2DNode): Record<string, unknown> {
    const al = n.al;
    if (!al) return {};
    if (al.mode === 'GRID') {
      const track = (t: { type: string; value?: number }): GridTrack => (t.type === 'FIXED' ? { kind: 'FIXED', value: Math.max(0, num(t.value)) } : t.type === 'FLEX' ? { kind: 'FR', value: Math.max(0, num(t.value, 1)) } : { kind: 'HUG' });
      return {
        layoutMode: 'GRID',
        gridColumns: (al.cols ?? []).map(track),
        gridRows: (al.rows ?? []).map(track),
        gridColumnGap: Math.max(0, num(al.colGap)),
        gridRowGap: Math.max(0, num(al.rowGap)),
        paddingTop: Math.max(0, num(al.pad?.[0])),
        paddingRight: Math.max(0, num(al.pad?.[1])),
        paddingBottom: Math.max(0, num(al.pad?.[2])),
        paddingLeft: Math.max(0, num(al.pad?.[3])),
        sizingH: al.hugH ? { mode: 'HUG' } : { mode: 'FIXED' },
        sizingV: al.hugV ? { mode: 'HUG' } : { mode: 'FIXED' },
      };
    }
    const primary = al.primary === 'CENTER' ? 'CENTER' : al.primary === 'MAX' ? 'MAX' : 'MIN';
    const counter = al.counter === 'CENTER' ? 'CENTER' : al.counter === 'MAX' ? 'MAX' : al.counter === 'BASELINE' && al.mode !== 'VERTICAL' ? 'BASELINE' : 'MIN';
    return {
      layoutMode: al.mode === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL',
      layoutWrap: !!al.wrap && al.mode === 'HORIZONTAL',
      counterAxisSpacing: Math.max(0, num(al.cgap)),
      paddingTop: Math.max(0, num(al.pad?.[0])),
      paddingRight: Math.max(0, num(al.pad?.[1])),
      paddingBottom: Math.max(0, num(al.pad?.[2])),
      paddingLeft: Math.max(0, num(al.pad?.[3])),
      // Negative: the blocks overlap (negative margins), as Figma allows.
      itemSpacing: num(al.gap),
      counterAxisAlignContent: al.acont === 'SPACE_BETWEEN' ? 'SPACE_BETWEEN' : 'AUTO',
      spacingMode: al.primary === 'SPACE_BETWEEN' ? 'BETWEEN' : 'FIXED',
      primaryAlign: primary,
      counterAlign: counter,
      sizingH: al.hugH ? { mode: 'HUG' } : { mode: 'FIXED' },
      sizingV: al.hugV ? { mode: 'HUG' } : { mode: 'FIXED' },
    };
  }

  private text(n: H2DNode, parent: NodeId, pos: { x: number; y: number; rotation: number }, common: Record<string, unknown>): NodeId {
    const styles = n.styles ?? [];
    const baseIndex = n.base ?? 0;
    const base = styles[baseIndex] ?? {};
    const family = this.family(base.fam);
    const autoWidth = n.auto === 'WIDTH_AND_HEIGHT';
    const id = this.tx.create('TEXT', parent, {
      ...common,
      x: pos.x,
      y: pos.y,
      rotation: pos.rotation,
      width: Math.max(1, num(n.w, 10)),
      height: Math.max(1, num(n.h, 10)),
      characters: n.chars!,
      fontFamily: family,
      fontWeight: num(base.w, 400),
      italic: !!base.it,
      fontSize: Math.max(1, num(base.size, 16)),
      fills: base.fills ? this.paints(base.fills) : [],
      textDecoration: base.deco ?? 'NONE',
      letterSpacing: { unit: 'PX', value: num(base.ls) },
      lineHeight: base.lh ? { unit: 'PX', value: Math.max(1, num(base.lh)) } : { unit: 'AUTO' },
      textCase: base.tc ?? 'ORIGINAL',
      textAlignH: n.align ?? 'LEFT',
      textAutoResize: autoWidth ? 'WIDTH_AND_HEIGHT' : 'HEIGHT',
      maxLines: Math.max(0, num(n.maxLines)),
      effects: this.effects(n.effects, true),
      textRuns: (n.ranges ?? [])
        // Base-style parts carry nothing of their own — unless they are a link (a text node has no link).
        .filter((r) => styles[r[2]] && (r[2] !== baseIndex || styles[r[2]]!.href))
        .map(([start, end, i]) => ({ start, end: Math.min(end, n.chars!.length), style: this.runStyle(styles[i]!, base) }))
        .filter((r) => r.end > r.start && Object.keys(r.style).length > 0),
    });
    return id;
  }

  /** What a part of the text changes against the text's base style. */
  private runStyle(s: H2DTextStyle, base: H2DTextStyle): TextRunStyle {
    const out: TextRunStyle = {};
    const fam = this.family(s.fam);
    if (fam !== this.family(base.fam)) out.fontFamily = fam;
    if (num(s.w, 400) !== num(base.w, 400)) out.fontWeight = num(s.w, 400);
    if (!!s.it !== !!base.it) out.italic = !!s.it;
    if (num(s.size, 16) !== num(base.size, 16)) out.fontSize = Math.max(1, num(s.size, 16));
    if (JSON.stringify(s.fills) !== JSON.stringify(base.fills)) out.fills = this.paints(s.fills);
    if ((s.deco ?? 'NONE') !== (base.deco ?? 'NONE')) out.textDecoration = s.deco ?? 'NONE';
    if (num(s.ls) !== num(base.ls)) out.letterSpacing = { unit: 'PX', value: num(s.ls) };
    const link = s.href ? safeLink(s.href) : null;
    if (link) out.link = link;
    return out;
  }
}

/**
 * Puts an imported page on the current page to the right of everything there
 * (so nothing is covered) and selects it. Returns the new top frame.
 */
/**
 * What a frame's layers are made of — kinds, names, texts, fills, visibility, nesting — but not
 * their sizes, which layout works out again: unchanged, the frame still matches its page.
 */
export function layoutSignature(doc: Editor['doc'], id: NodeId): string {
  let h = 2166136261;
  const add = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    h = Math.imul(h ^ 31, 16777619);
  };
  doc.store.walk(id, (n) => {
    add(doc.type(n));
    add(String(doc.children(n).length));
    if (n !== id) add(String(doc.get(n, 'name')));
    if (doc.type(n) === 'TEXT') add(String(doc.get(n, 'characters')));
    add(JSON.stringify(doc.get(n, 'fills')));
    add(String(doc.get(n, 'visible')));
  });
  return (h >>> 0).toString(36);
}

/** A page kept on its frame for later changes in words: up to this long (pictures make pages big). */
const SOURCE_MAX = 300_000;

/** Keeps the model's page on the frame made of it (or forgets an old one). */
function keepSource(editor: Editor, tx: Transaction, id: NodeId, source: string | undefined): void {
  tx.set(id, 'aiSource', source && source.length <= SOURCE_MAX ? { html: source, sig: layoutSignature(editor.doc, id) } : null);
}

/** The page's body is the frame exported edge to edge: its one frame is the layout, not a wrapper around it. */
function unwrap(tree: H2DNode): H2DNode {
  const only = tree.children?.length === 1 ? tree.children[0]! : null;
  return only && only.t === 'FRAME' && Math.abs(num(only.w) - num(tree.w)) < 1 ? { ...only, x: tree.x, y: tree.y } : tree;
}

export function buildHtmlImport(editor: Editor, tree: H2DNode, images: H2DImage[], name: string, replace?: NodeId, source?: string): { id: NodeId; count: number } {
  if (replace && editor.doc.store.isAlive(replace)) return editor.isSlide(replace) ? buildHtmlSlideReplace(editor, tree, images, replace, source) : buildHtmlReplace(editor, tree, images, replace, source);
  if (isSlides(editor.doc)) return buildHtmlSlide(editor, tree, images, name, source);
  const page = editor.pageId;
  const bounds = editor.scene.contentBounds();
  const at: Point = bounds ? { x: Math.round(bounds.x + bounds.width + 120), y: Math.round(bounds.y) } : { x: 0, y: 0 };
  let id = '';
  let count = 0;
  editor.commit(
    tr('Импорт HTML'),
    (tx) => {
      const b = new HtmlImportBuilder(editor, tx, images);
      const root = b.build({ ...tree, t: 'FRAME', x: at.x, y: at.y, rt: undefined, name: name || tree.name || 'HTML' }, page);
      id = root ?? '';
      count = b.count;
      if (root && source) keepSource(editor, tx, root, source);
    },
    () => (id ? [id] : []),
  );
  return { id, count };
}

/**
 * A layout changed by a description (FEAT-172): the new page takes the old layer's place — the
 * same parent, position in it, spot and name — and the old layer goes. One step to undo.
 */
function buildHtmlReplace(editor: Editor, tree: H2DNode, images: H2DImage[], old: NodeId, source?: string): { id: NodeId; count: number } {
  const doc = editor.doc;
  const parent = doc.parent(old)!;
  const inLayout = doc.type(parent) !== 'PAGE' && doc.get(parent, 'layoutMode') !== 'NONE';
  let id = '';
  let count = 0;
  editor.commit(
    tr('Изменить по описанию'),
    (tx) => {
      const b = new HtmlImportBuilder(editor, tx, images);
      const made = b.build({ ...unwrap(tree), t: 'FRAME', x: doc.get(old, 'x'), y: doc.get(old, 'y'), rt: undefined, abs: undefined, name: String(doc.get(old, 'name')) }, parent, inLayout);
      count = b.count;
      if (!made) return;
      tx.move(made, parent, { before: old });
      tx.delete(old);
      keepSource(editor, tx, made, source);
      // In a presentation the new layout follows the theme too (its slide: the top-level frame above it).
      if (isSlides(doc)) {
        let slide: NodeId = made;
        while (doc.type(doc.parent(slide)!) !== 'PAGE') slide = doc.parent(slide)!;
        bindSlideColors(doc, tx, [slide]);
      }
      id = made;
    },
    () => (id ? [id] : []),
  );
  return { id, count };
}

/**
 * The block of the page drawn as a slide, or null: as wide as 40 % of the page or more, the nearest
 * to the format's proportions (within 3 %), of equals the largest — as the preview finds it (runtime.ts).
 */
function slideBlock(tree: H2DNode, aspect: number): H2DNode | null {
  type Pick = { n: H2DNode; off: number; area: number };
  let best = null as Pick | null;
  const minW = num(tree.w) * 0.4;
  const walk = (n: H2DNode) => {
    const w = num(n.w);
    const h = num(n.h);
    const off = h > 0 ? Math.abs(w / h / aspect - 1) : 1;
    if (n !== tree && n.t === 'FRAME' && !n.tbl && w >= minW && off < 0.03 && (!best || off < best.off - 0.005 || (Math.abs(off - best.off) <= 0.005 && w * h > best.area))) best = { n, off, area: w * h };
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return best?.n ?? null;
}

/**
 * An HTML page in a presentation (FEAT-169): a new slide of the presentation's format after
 * the one on show, the page (or its block drawn as a slide — «#slide» 1280 × 720) fitted in
 * it. The sheet keeps the format's size: an imported page never makes a slide of its own size.
 */
function buildHtmlSlide(editor: Editor, tree: H2DNode, images: H2DImage[], name: string, source?: string): { id: NodeId; count: number } {
  const doc = editor.doc;
  const page = editor.pageId;
  const after = editor.slideStage?.current() ?? slideIds(doc, page).at(-1) ?? null;
  let id = '';
  let count = 0;
  editor.commit(
    tr('Импорт HTML'),
    (tx) => {
      const slide = createSlide(doc, tx, page, 'blank', after);
      tx.set(slide, 'name', name || tree.name || 'HTML');
      ({ id, count } = fillSlide(editor, tx, slide, tree, images, name || tree.name || 'HTML', source));
    },
    () => (id ? [id] : []),
  );
  return { id, count };
}

/**
 * A slide changed by a description: its layers give way to the new page's, the slide itself
 * stays — its place among the slides, notes, format and theme. Any slide, made by the model
 * or by hand. One step to undo.
 */
function buildHtmlSlideReplace(editor: Editor, tree: H2DNode, images: H2DImage[], slide: NodeId, source?: string): { id: NodeId; count: number } {
  const doc = editor.doc;
  let id = '';
  let count = 0;
  editor.commit(
    tr('Изменить по описанию'),
    (tx) => {
      for (const child of [...doc.children(slide)]) tx.delete(child);
      ({ id, count } = fillSlide(editor, tx, slide, tree, images, String(doc.get(slide, 'name')), source));
    },
    () => (id ? [id] : []),
  );
  return { id, count };
}

/**
 * The page laid on a slide: its block drawn as a slide becomes the slide (its background the
 * slide's, its content on the slide), else the whole page fitted in and centred. Bound to the
 * theme's colours. Returns what to select: the slide's first new layer, or the fitted page.
 */
function fillSlide(editor: Editor, tx: Transaction, slide: NodeId, tree: H2DNode, images: H2DImage[], name: string, source: string | undefined): { id: NodeId; count: number } {
  const doc = editor.doc;
  const size = slideSize(doc, doc.parent(slide)!);
  const root = slideBlock(tree, size.w / size.h) ?? tree;
  const b = new HtmlImportBuilder(editor, tx, images);
  const made = b.build({ ...root, x: 0, y: 0, rt: undefined, abs: undefined, fillH: undefined, fillV: undefined, frH: undefined, grid: undefined, name: root === tree ? name : root.name }, slide);
  const count = b.count;
  if (!made) return { id: '', count };
  // Fitted whole and centred: a page of another shape leaves margins of the slide's background.
  const w = doc.get(made, 'width');
  const h = doc.get(made, 'height');
  const k = Math.min(size.w / w, size.h / h);
  const dx = (size.w - w * k) / 2;
  const dy = (size.h - h * k) / 2;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  let id: NodeId = made;
  if (root !== tree) {
    // The page's own slide is the slide: its background is the slide's, its content lies on the slide
    // (a frame over the whole sheet would look like the sheet and take its handles).
    const fills = doc.get(made, 'fills');
    if (fills.length) tx.update(slide, { fills, fillStyleId: null });
    const first = doc.children(made)[0];
    for (const child of [...doc.children(made)]) {
      const x = doc.get(child, 'x');
      const y = doc.get(child, 'y');
      scaleNode(doc, tx, child, k);
      tx.move(child, slide);
      const fixed = (m: Sizing): Sizing => (m.mode === 'FILL' || m.mode === 'FR' || m.mode === 'PERCENT' ? { mode: 'FIXED' } : m);
      tx.update(child, { x: r2(dx + x * k), y: r2(dy + y * k), positioning: 'AUTO', sizingH: fixed(doc.get(child, 'sizingH')), sizingV: fixed(doc.get(child, 'sizingV')) });
    }
    tx.delete(made);
    // The slide itself is never selected in a presentation: its first layer is, so the slide is on show.
    id = first ?? slide;
  } else {
    scaleNode(doc, tx, made, k);
    tx.update(made, { x: r2(dx), y: r2(dy) });
  }
  // Its colours become the theme's: «Тема/…» and the theme restyle it as they do the layouts.
  bindSlideColors(doc, tx, [slide]);
  // The model's page stays on the slide, to change it in words again without loss.
  keepSource(editor, tx, slide, source);
  return { id, count };
}
