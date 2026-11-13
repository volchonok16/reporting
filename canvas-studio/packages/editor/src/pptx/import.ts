// PowerPoint import (FEAT-158), the reading side: a .pptx (a ZIP of
// PresentationML parts) becomes a model of slides — shapes, text with its
// styles, pictures, lines, groups, tables, backgrounds, notes, transitions —
// in pixels of a slide 1920 wide. What a slide inherits is resolved here: its
// layout and master (placeholders' places and text styles, their own shapes,
// backgrounds), the theme (colours, fonts). Own code, no libraries; the build
// into a document is in import-build.ts.

import type { Color, LineCap, LineHeight, SlideTransition, TextAlignH, TextAlignV, VectorPoint } from '#core';
import { parseXml, type XmlNode } from '../svg-import.ts';
import { emfPicture, emfToSvg } from './emf.ts';

export const TARGET_WIDTH = 1920;

export type ImFill = { type: 'solid'; color: Color } | { type: 'gradient'; angle: number; stops: { pos: number; color: Color }[]; radial: boolean } | { type: 'image'; path: string; crop: Crop | null } | null;

export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface ImStroke {
  color: Color;
  width: number;
  dash: boolean;
  /** PowerPoint tailEnd → начало линии. */
  startCap: LineCap;
  /** PowerPoint headEnd → конец линии. */
  endCap: LineCap;
}

export interface ImRun {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: Color;
  font: string;
  link?: string;
}

export interface ImParagraph {
  align: TextAlignH;
  bullet: 'none' | 'char' | 'num';
  level: number;
  runs: ImRun[];
  lineHeight: LineHeight;
  spaceBefore: number;
}

export interface ImText {
  /** «Не переносить» in PowerPoint: the text keeps its lines however long. */
  noWrap?: boolean;
  /** PowerPoint bodyPr vert: the text runs along the tall side of the box. */
  vert?: 'vert' | 'vert270';
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: TextAlignV;
  paragraphs: ImParagraph[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export type ImElement =
  | ({ k: 'shape'; name: string; geom: string; radius: number; fill: ImFill; stroke: ImStroke | null; text: ImText | null; path: string | null } & Box)
  | ({ k: 'pic'; name: string; path: string; crop: Crop | null; geom: string; stroke: ImStroke | null } & Box)
  | ({ k: 'line'; name: string; x1: number; y1: number; x2: number; y2: number; stroke: ImStroke })
  /** Elbow/curve connectors: open path in slide pixels (not a diagonal through the box). */
  | { k: 'polyline'; name: string; points: VectorPoint[]; stroke: ImStroke }
  | { k: 'group'; name: string; children: ImElement[] }
  | { k: 'table'; name: string; x: number; y: number; cols: number[]; rows: { h: number; cells: ({ fill: ImFill | undefined; stroke: ImStroke | null; text: ImText; span: number; rowSpan: number } | null)[] }[] }
  | ({ k: 'missing'; name: string; what: string } & Box)
  /** A Windows metafile read as vectors (emf.ts). */
  | ({ k: 'vector'; name: string; svg: string } & Box);

export interface ImSlide {
  name: string;
  background: ImFill;
  elements: ImElement[];
  notes: string;
  transition: SlideTransition | null;
  hidden: boolean;
}

export interface ImDeck {
  title: string;
  width: number;
  height: number;
  slides: ImSlide[];
  /** Media by path in the package: bytes and type. */
  media: Map<string, { bytes: Uint8Array; mime: string }>;
  /** Fonts the slides ask for. */
  fonts: Set<string>;
  /** What could not be brought over, counted by kind: «диаграмма» → 2. */
  skipped: Map<string, number>;
}

// ---------- XML helpers ----------

/** The element's name without its namespace prefix. */
const local = (n: XmlNode) => n.name.slice(n.name.indexOf(':') + 1);
const kids = (n: XmlNode | undefined, name?: string) => (n ? n.children.filter((c) => !name || local(c) === name) : []);
const kid = (n: XmlNode | undefined, name: string) => n?.children.find((c) => local(c) === name);
/** A descendant by a path of local names: path(sp, 'spPr', 'xfrm', 'off'). */
function path(n: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  let at = n;
  for (const name of names) at = kid(at, name);
  return at;
}
/** Elements inside `mc:AlternateContent`: the fallback is what a reader without extensions uses. */
function unwrap(n: XmlNode): XmlNode[] {
  if (local(n) !== 'AlternateContent') return [n];
  const pick = kid(n, 'Fallback') ?? kid(n, 'Choice');
  return pick ? pick.children : [];
}
const num = (v: string | undefined, d = 0) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const decoder = new TextDecoder();

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf('/') + 1);
}
/** «../media/image1.png» against «ppt/slides/» → «ppt/media/image1.png». */
function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (base + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

interface Rel {
  type: string;
  target: string;
  external: boolean;
}

// ---------- colours ----------

const PRESET: Record<string, string> = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', navy: '000080' };

function hex(h: string): Color {
  const v = h.replace('#', '').padStart(6, '0');
  return { r: parseInt(v.slice(0, 2), 16) / 255, g: parseInt(v.slice(2, 4), 16) / 255, b: parseInt(v.slice(4, 6), 16) / 255, a: 1 };
}

function toHsl(c: Color): [number, number, number] {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === c.r ? (c.g - c.b) / d + (c.g < c.b ? 6 : 0) : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number, a: number): Color {
  if (s === 0) return { r: l, g: l, b: l, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
  };
  return { r: f(h + 1 / 3), g: f(h), b: f(h - 1 / 3), a };
}

/** The colour modifiers PowerPoint writes most: lumMod/lumOff (theme tints), tint, shade, alpha. */
function modify(c: Color, n: XmlNode): Color {
  let out = { ...c };
  for (const m of n.children) {
    const v = num(m.attrs.val) / 100000;
    switch (local(m)) {
      case 'alpha':
        out.a = v;
        break;
      case 'lumMod': {
        const [h, s, l] = toHsl(out);
        out = fromHsl(h, s, Math.min(1, l * v), out.a);
        break;
      }
      case 'lumOff': {
        const [h, s, l] = toHsl(out);
        out = fromHsl(h, s, Math.min(1, l + v), out.a);
        break;
      }
      case 'tint':
        out = { r: out.r + (1 - out.r) * (1 - v), g: out.g + (1 - out.g) * (1 - v), b: out.b + (1 - out.b) * (1 - v), a: out.a };
        break;
      case 'shade':
        out = { r: out.r * v, g: out.g * v, b: out.b * v, a: out.a };
        break;
    }
  }
  return out;
}

// ---------- the package ----------

interface Theme {
  colors: Record<string, Color>;
  major: string;
  minor: string;
}

interface Part {
  path: string;
  xml: XmlNode;
  rels: Map<string, Rel>;
}

interface Ctx {
  files: Map<string, Uint8Array>;
  theme: Theme;
  /** bg1 → lt1, tx1 → dk1… from the master. */
  clrMap: Record<string, string>;
  /** px per EMU on the target slide. */
  k: number;
  deck: ImDeck;
  part: Part;
  /** Text styles by kind from the master and the presentation's defaults. */
  txStyles: { title: XmlNode[]; body: XmlNode[]; other: XmlNode[] };
  layout: Part | null;
  master: Part | null;
  /** The slide's number in the show, for slide-number fields. */
  slideNumber: number;
}

function readPart(files: Map<string, Uint8Array>, p: string): Part | null {
  const bytes = files.get(p);
  if (!bytes) return null;
  const xml = parseXml(decoder.decode(bytes));
  const relsPath = `${dirOf(p)}_rels/${p.slice(p.lastIndexOf('/') + 1)}.rels`;
  const rels = new Map<string, Rel>();
  const relBytes = files.get(relsPath);
  if (relBytes) {
    for (const r of kids(kid(parseXml(decoder.decode(relBytes)), 'Relationships'), 'Relationship')) {
      const external = r.attrs.TargetMode === 'External';
      rels.set(r.attrs.Id!, { type: r.attrs.Type ?? '', target: external ? (r.attrs.Target ?? '') : resolvePath(dirOf(p), r.attrs.Target ?? ''), external });
    }
  }
  return { path: p, xml, rels };
}

const relOf = (part: Part, type: string) => [...part.rels.values()].find((r) => r.type.endsWith(`/${type}`));

function readTheme(files: Map<string, Uint8Array>, master: Part | null): Theme {
  const theme: Theme = { colors: {}, major: 'Arial', minor: 'Arial' };
  const rel = master && relOf(master, 'theme');
  const part = rel ? readPart(files, rel.target) : null;
  const elements = path(part?.xml, 'theme', 'themeElements');
  for (const c of kids(path(elements, 'clrScheme'))) {
    const v = c.children[0];
    if (!v) continue;
    theme.colors[local(c)] = local(v) === 'sysClr' ? hex(v.attrs.lastClr ?? '000000') : hex(v.attrs.val ?? '000000');
  }
  theme.major = path(elements, 'fontScheme', 'majorFont', 'latin')?.attrs.typeface || theme.major;
  theme.minor = path(elements, 'fontScheme', 'minorFont', 'latin')?.attrs.typeface || theme.minor;
  return theme;
}

/** A colour element (srgbClr, schemeClr, sysClr, prstClr) with its modifiers. */
function color(ctx: Ctx, holder: XmlNode | undefined, placeholderColor?: Color): Color | null {
  const n = holder?.children.find((c) => /Clr$/.test(local(c)));
  if (!n) return null;
  let base: Color;
  switch (local(n)) {
    case 'srgbClr':
      base = hex(n.attrs.val ?? '000000');
      break;
    case 'sysClr':
      base = hex(n.attrs.lastClr ?? (n.attrs.val === 'window' ? 'FFFFFF' : '000000'));
      break;
    case 'prstClr':
      base = hex(PRESET[n.attrs.val ?? ''] ?? '000000');
      break;
    case 'schemeClr': {
      const v = n.attrs.val ?? 'tx1';
      if (v === 'phClr') {
        base = placeholderColor ?? hex('000000');
        break;
      }
      const mapped = ctx.clrMap[v] ?? v;
      base = ctx.theme.colors[mapped] ?? hex('000000');
      break;
    }
    default:
      return null;
  }
  return modify(base, n);
}

function fill(ctx: Ctx, holder: XmlNode | undefined, part: Part): ImFill | undefined {
  if (!holder) return undefined;
  for (const n of holder.children) {
    switch (local(n)) {
      case 'noFill':
        return null;
      case 'solidFill': {
        const c = color(ctx, n);
        return c ? { type: 'solid', color: c } : null;
      }
      case 'gradFill': {
        const stops = kids(kid(n, 'gsLst'), 'gs')
          .map((gs) => ({ pos: num(gs.attrs.pos) / 100000, color: color(ctx, gs) ?? hex('000000') }))
          .sort((a, b) => a.pos - b.pos);
        if (!stops.length) return null;
        const lin = kid(n, 'lin');
        return { type: 'gradient', angle: num(lin?.attrs.ang) / 60000, stops, radial: !!kid(n, 'path') };
      }
      case 'blipFill': {
        const blip = kid(n, 'blip');
        const rel = blip && part.rels.get(blip.attrs['r:embed'] ?? '');
        if (!rel) return null;
        return { type: 'image', path: rel.target, crop: crop(kid(n, 'srcRect')) };
      }
      case 'grpFill':
        return null;
    }
  }
  return undefined;
}

function crop(n: XmlNode | undefined): Crop | null {
  if (!n) return null;
  const c = { l: num(n.attrs.l) / 100000, t: num(n.attrs.t) / 100000, r: num(n.attrs.r) / 100000, b: num(n.attrs.b) / 100000 };
  return c.l || c.t || c.r || c.b ? c : null;
}

/** PowerPoint a:headEnd / a:tailEnd type → our line ends. */
function lineCapOf(type: string | undefined): LineCap {
  switch ((type ?? 'none').toLowerCase()) {
    case 'triangle':
      return 'ARROW';
    case 'stealth':
      return 'REVERSED_TRIANGLE';
    case 'diamond':
      return 'DIAMOND';
    case 'oval':
      return 'CIRCLE';
    case 'arrow':
      return 'LINE_ARROW';
    default:
      return 'NONE';
  }
}

function stroke(ctx: Ctx, ln: XmlNode | undefined, styleRef?: XmlNode): ImStroke | null {
  if (ln && kid(ln, 'noFill')) return null;
  const solid = kid(ln, 'solidFill');
  const c = solid ? color(ctx, solid) : styleRef && num(styleRef.attrs.idx) > 0 ? color(ctx, styleRef) : null;
  if (!c) return null;
  const w = ln?.attrs.w ? num(ln.attrs.w) : 9525 * Math.max(1, num(styleRef?.attrs.idx, 1));
  const dash = kid(ln, 'prstDash')?.attrs.val;
  return {
    color: c,
    width: Math.max(0.5, w * ctx.k),
    dash: !!dash && dash !== 'solid',
    // headEnd sits at the path's end; tailEnd at the start.
    startCap: lineCapOf(kid(ln, 'tailEnd')?.attrs.type),
    endCap: lineCapOf(kid(ln, 'headEnd')?.attrs.type),
  };
}

// ---------- placement ----------

interface Xform {
  map: (x: number, y: number) => { x: number; y: number };
  sx: number;
  sy: number;
}

const IDENTITY = (k: number): Xform => ({ map: (x, y) => ({ x: x * k, y: y * k }), sx: k, sy: k });

function box(xfrm: XmlNode | undefined, t: Xform): Box | null {
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  if (!off || !ext) return null;
  const p = t.map(num(off.attrs.x), num(off.attrs.y));
  return { x: p.x, y: p.y, w: num(ext.attrs.cx) * t.sx, h: num(ext.attrs.cy) * t.sy, rot: num(xfrm!.attrs.rot) / 60000, flipH: xfrm!.attrs.flipH === '1', flipV: xfrm!.attrs.flipV === '1' };
}

// ---------- placeholders and text styles ----------

interface Ph {
  type: string;
  idx: string | null;
}

function phOf(sp: XmlNode): Ph | null {
  const ph = path(sp, 'nvSpPr', 'nvPr', 'ph') ?? path(sp, 'nvPicPr', 'nvPr', 'ph') ?? path(sp, 'nvGraphicFramePr', 'nvPr', 'ph');
  return ph ? { type: ph.attrs.type ?? 'obj', idx: ph.attrs.idx ?? null } : null;
}

const sameKind = (a: string, b: string) => {
  const norm = (t: string) => (t === 'ctrTitle' ? 'title' : t === 'obj' || t === 'subTitle' ? 'body' : t);
  return norm(a) === norm(b);
};

/** The shape in a layout or master that a placeholder takes its place and styles from. */
function findPh(part: Part | null, ph: Ph): XmlNode | undefined {
  if (!part) return undefined;
  const shapes = spTreeOf(part.xml).filter((n) => phOf(n));
  if (ph.idx !== null) {
    const byIdx = shapes.find((n) => phOf(n)!.idx === ph.idx);
    if (byIdx) return byIdx;
  }
  return shapes.find((n) => phOf(n)!.type === ph.type) ?? shapes.find((n) => sameKind(phOf(n)!.type, ph.type));
}

function spTreeOf(root: XmlNode): XmlNode[] {
  const cSld = path(root.children.find((c) => ['sld', 'sldLayout', 'sldMaster', 'notes'].includes(local(c))), 'cSld');
  return kids(path(cSld, 'spTree')).flatMap(unwrap);
}

interface Level {
  algn?: string;
  bullet?: 'none' | 'char' | 'num';
  lnPct?: number;
  lnPts?: number;
  spcBef?: number;
  sz?: number;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  color?: Color;
  font?: string;
}

/** Level props from a pPr-like element (lvlNpPr or pPr) and its defRPr / rPr. */
function levelOf(ctx: Ctx, p: XmlNode | undefined, rpr?: XmlNode): Level {
  const out: Level = {};
  if (p) {
    if (p.attrs.algn) out.algn = p.attrs.algn;
    if (kid(p, 'buNone')) out.bullet = 'none';
    else if (kid(p, 'buAutoNum')) out.bullet = 'num';
    else if (kid(p, 'buChar') || kid(p, 'buBlip')) out.bullet = 'char';
    const ln = kid(p, 'lnSpc');
    if (kid(ln, 'spcPct')) out.lnPct = num(kid(ln, 'spcPct')!.attrs.val) / 1000;
    if (kid(ln, 'spcPts')) out.lnPts = num(kid(ln, 'spcPts')!.attrs.val) / 100;
    const bef = kid(kid(p, 'spcBef'), 'spcPts');
    if (bef) out.spcBef = num(bef.attrs.val) / 100;
  }
  const r = rpr ?? kid(p, 'defRPr');
  if (r) {
    if (r.attrs.sz) out.sz = num(r.attrs.sz) / 100;
    if (r.attrs.b !== undefined) out.b = r.attrs.b === '1' || r.attrs.b === 'true';
    if (r.attrs.i !== undefined) out.i = r.attrs.i === '1' || r.attrs.i === 'true';
    if (r.attrs.u !== undefined) out.u = r.attrs.u !== 'none';
    if (r.attrs.strike !== undefined) out.strike = r.attrs.strike !== 'noStrike';
    const c = color(ctx, kid(r, 'solidFill'));
    if (c) out.color = c;
    const latin = kid(r, 'latin')?.attrs.typeface;
    if (latin) out.font = latin;
  }
  return out;
}

const merge = (...levels: Level[]): Level => Object.assign({}, ...levels.map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined))));

function fontName(ctx: Ctx, f: string | undefined): string {
  if (!f || f === '+mn-lt' || f === '+mn-ea' || f === '+mn-cs') return ctx.theme.minor;
  if (f === '+mj-lt' || f === '+mj-ea' || f === '+mj-cs') return ctx.theme.major;
  return f;
}

/** A text body as paragraphs with resolved styles; null when it holds no text. */
function textOf(ctx: Ctx, txBody: XmlNode | undefined, chain: XmlNode[], b: Box, defaultColor: Color): ImText | null {
  if (!txBody) return null;
  const paras = kids(txBody, 'p');
  if (!paras.some((p) => kids(p).some((r) => (local(r) === 'r' || local(r) === 'fld') && (kid(r, 't')?.text ?? '') !== ''))) return null;
  const body = kid(txBody, 'bodyPr');
  const autofit = kid(body, 'normAutofit');
  const scale = autofit?.attrs.fontScale ? num(autofit.attrs.fontScale) / 100000 : 1;
  const lnReduce = autofit?.attrs.lnSpcReduction ? num(autofit.attrs.lnSpcReduction) / 100000 : 0;
  const ins = (key: string, d: number) => num(body?.attrs[key], d) * ctx.k;
  // Points on the slide → pixels of the target slide (1 pt = 12 700 EMU).
  const pt = (sz: number) => sz * 12700 * ctx.k;
  const local0 = kid(txBody, 'lstStyle');
  const paragraphs: ImParagraph[] = paras.map((p) => {
    const pPr = kid(p, 'pPr');
    const level = Math.min(8, num(pPr?.attrs.lvl));
    const lv = `lvl${level + 1}pPr`;
    const inherited = merge(...chain.map((c) => levelOf(ctx, kid(c, lv))), levelOf(ctx, kid(local0, lv)), levelOf(ctx, pPr));
    const runs: ImRun[] = [];
    for (const r of kids(p)) {
      const name = local(r);
      if (name === 'br') {
        if (runs.length) runs[runs.length - 1]!.text += '\n';
        continue;
      }
      if (name !== 'r' && name !== 'fld') continue;
      const rPr = kid(r, 'rPr');
      // «‹#›» in a slide-number field is the number itself.
      const fieldText = name === 'fld' && r.attrs.type === 'slidenum' ? String(ctx.slideNumber) : null;
      const s = merge(inherited, levelOf(ctx, undefined, rPr ?? { name: 'rPr', attrs: {}, children: [], text: '' }));
      const rel = rPr && path(rPr, 'hlinkClick');
      const link = rel ? ctx.part.rels.get(rel.attrs['r:id'] ?? '') : undefined;
      runs.push({
        text: fieldText ?? (kid(r, 't')?.text ?? '').replace(/\r?\n/g, ' '),
        size: Math.max(1, pt((s.sz ?? 18) * scale)),
        bold: !!s.b,
        italic: !!s.i,
        underline: !!s.u,
        strike: !!s.strike,
        color: s.color ?? defaultColor,
        font: fontName(ctx, s.font),
        ...(link?.external ? { link: link.target } : {}),
      });
    }
    const algn = inherited.algn;
    const lineHeight: LineHeight = inherited.lnPts ? { unit: 'PX', value: pt(inherited.lnPts) } : inherited.lnPct ? { unit: 'PERCENT', value: Math.round(inherited.lnPct * (1 - lnReduce) * 1.2) } : { unit: 'AUTO' };
    return {
      align: algn === 'ctr' ? 'CENTER' : algn === 'r' ? 'RIGHT' : algn === 'just' || algn === 'dist' ? 'JUSTIFIED' : 'LEFT',
      bullet: runs.some((r) => r.text.trim()) ? (inherited.bullet ?? 'none') : 'none',
      level,
      runs,
      lineHeight,
      spaceBefore: inherited.spcBef ? pt(inherited.spcBef) : 0,
    };
  });
  const anchor = body?.attrs.anchor;
  const vert = body?.attrs.vert === 'vert' || body?.attrs.vert === 'vert270' ? body.attrs.vert : undefined;
  const l = ins('lIns', 91440);
  const t = ins('tIns', 45720);
  return {
    x: b.x + l,
    y: b.y + t,
    w: Math.max(1, b.w - l - ins('rIns', 91440)),
    h: Math.max(1, b.h - t - ins('bIns', 45720)),
    anchor: anchor === 'ctr' ? 'CENTER' : anchor === 'b' ? 'BOTTOM' : 'TOP',
    paragraphs,
    ...(body?.attrs.wrap === 'none' ? { noWrap: true } : {}),
    ...(vert ? { vert } : {}),
  };
}

// ---------- shapes ----------

function skip(ctx: Ctx, what: string): void {
  ctx.deck.skipped.set(what, (ctx.deck.skipped.get(what) ?? 0) + 1);
}

/** Custom geometry as SVG path data in the shape's own box (w × h px). */
function customPath(geom: XmlNode, w: number, h: number): string | null {
  const parts: string[] = [];
  for (const p of kids(kid(geom, 'pathLst'), 'path')) {
    const pw = num(p.attrs.w, 0) || 1;
    const phh = num(p.attrs.h, 0) || 1;
    const sx = p.attrs.w ? w / pw : 1;
    const sy = p.attrs.h ? h / phh : 1;
    const pt = (n: XmlNode | undefined) => `${(num(n?.attrs.x) * sx).toFixed(2)} ${(num(n?.attrs.y) * sy).toFixed(2)}`;
    for (const c of p.children) {
      const pts = kids(c, 'pt');
      switch (local(c)) {
        case 'moveTo':
          parts.push(`M${pt(pts[0])}`);
          break;
        case 'lnTo':
          parts.push(`L${pt(pts[0])}`);
          break;
        case 'cubicBezTo':
          parts.push(`C${pts.map(pt).join(' ')}`);
          break;
        case 'quadBezTo':
          parts.push(`Q${pts.map(pt).join(' ')}`);
          break;
        case 'close':
          parts.push('Z');
          break;
      }
    }
  }
  return parts.length ? parts.join(' ') : null;
}

function txStyleFor(ctx: Ctx, ph: Ph | null): XmlNode[] {
  if (!ph) return ctx.txStyles.other;
  if (ph.type === 'title' || ph.type === 'ctrTitle') return ctx.txStyles.title;
  if (ph.type === 'body' || ph.type === 'obj' || ph.type === 'subTitle') return ctx.txStyles.body;
  return ctx.txStyles.other;
}

function readShape(ctx: Ctx, sp: XmlNode, t: Xform, inherited: boolean): ImElement | null {
  const name = path(sp, 'nvSpPr', 'cNvPr')?.attrs.name ?? '';
  const ph = phOf(sp);
  // Placeholders of a layout or master show only through a slide's own.
  if (inherited && ph) return null;
  const layoutPh = ph ? findPh(ctx.layout, ph) : undefined;
  const masterPh = ph ? findPh(ctx.master, ph) : undefined;
  const spPr = kid(sp, 'spPr');
  const b = box(kid(spPr, 'xfrm'), t) ?? box(path(layoutPh, 'spPr', 'xfrm'), t) ?? box(path(masterPh, 'spPr', 'xfrm'), t);
  if (!b) return null;
  const style = kid(sp, 'style');
  let f = fill(ctx, spPr, ctx.part);
  if (f === undefined) f = style && num(kid(style, 'fillRef')?.attrs.idx) > 0 ? (() => {
    const c = color(ctx, kid(style, 'fillRef'));
    return c ? ({ type: 'solid', color: c } as const) : null;
  })() : null;
  const s = stroke(ctx, kid(spPr, 'ln'), kid(style, 'lnRef'));
  const prst = path(spPr, 'prstGeom')?.attrs.prst ?? (kid(spPr, 'custGeom') ? 'cust' : 'rect');
  const adj = num(kids(path(spPr, 'prstGeom', 'avLst'), 'gd').find((g) => g.attrs.name === 'adj')?.attrs.fmla?.replace('val ', ''), 16667);
  const fontColor = color(ctx, kid(style, 'fontRef'));
  const chain = [...txStyleFor(ctx, ph), ...(masterPh ? [kid(kid(masterPh, 'txBody'), 'lstStyle')!].filter(Boolean) : []), ...(layoutPh ? [kid(kid(layoutPh, 'txBody'), 'lstStyle')!].filter(Boolean) : [])];
  const defaultColor = fontColor ?? ctx.theme.colors[ctx.clrMap.tx1 ?? 'dk1'] ?? hex('000000');
  const text = textOf(ctx, kid(sp, 'txBody'), chain, b, defaultColor);
  for (const r of text?.paragraphs ?? []) for (const run of r.runs) ctx.deck.fonts.add(run.font);
  if (prst === 'line' || prst.startsWith('straightConnector') || /^(bent|curved)Connector/i.test(prst) || prst.endsWith('Connector')) {
    if (!s) return null;
    return connectorOf(name, b, s, prst, path(spPr, 'prstGeom', 'avLst'));
  }
  if (!f && !s && !text) return null;
  return {
    k: 'shape',
    name: name || (text ? text.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').slice(0, 40) : 'Shape'),
    ...b,
    geom: prst,
    radius: prst === 'roundRect' ? (Math.min(b.w, b.h) * adj) / 100000 : 0,
    fill: f ?? null,
    stroke: s,
    text,
    path: prst === 'cust' ? customPath(kid(spPr, 'custGeom')!, b.w, b.h) : null,
  };
}

/** Adjustment values from a:avLst (adj / adj1 / adj2 / …), default 50000. */
function adjOf(avLst: XmlNode | undefined, name: string, fallback = 50000): number {
  const gd = kids(avLst, 'gd').find((g) => g.attrs.name === name);
  const raw = gd?.attrs.fmla?.replace(/^val\s+/i, '');
  return num(raw, fallback);
}

/**
 * Local path of a DrawingML connector preset inside a w×h box (OOXML
 * presetShapeDefinitions: start at top-left, first segment horizontal).
 */
function connectorLocal(prst: string, w: number, h: number, avLst: XmlNode | undefined): VectorPoint[] | null {
  const W = Math.max(0, w);
  const H = Math.max(0, h);
  if (prst === 'line' || prst.startsWith('straightConnector')) return [{ x: 0, y: 0 }, { x: W, y: H }];
  if (prst === 'bentConnector2') return [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }];
  if (prst === 'bentConnector3') {
    const x1 = (W * adjOf(avLst, 'adj1')) / 100000;
    return [{ x: 0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: H }, { x: W, y: H }];
  }
  if (prst === 'bentConnector4') {
    const x1 = (W * adjOf(avLst, 'adj1')) / 100000;
    const y2 = (H * adjOf(avLst, 'adj2')) / 100000;
    return [{ x: 0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: y2 }, { x: W, y: y2 }, { x: W, y: H }];
  }
  if (prst === 'bentConnector5') {
    const x1 = (W * adjOf(avLst, 'adj1')) / 100000;
    const y2 = (H * adjOf(avLst, 'adj2')) / 100000;
    const x3 = (W * adjOf(avLst, 'adj3')) / 100000;
    return [{ x: 0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: y2 }, { x: x3, y: y2 }, { x: x3, y: H }, { x: W, y: H }];
  }
  if (prst === 'curvedConnector2') {
    // cubicBezTo wd2 t, r hd2, r b
    const c1 = { x: W / 2, y: 0 };
    const c2 = { x: W, y: H / 2 };
    const end = { x: W, y: H };
    return [{ x: 0, y: 0, out: c1 }, { ...end, in: c2 }];
  }
  if (prst === 'curvedConnector3') {
    const x2 = (W * adjOf(avLst, 'adj1')) / 100000;
    const x1 = x2 / 2;
    const x3 = (W + x2) / 2;
    const y3 = (H * 3) / 4;
    const mid = { x: x2, y: H / 2 };
    const end = { x: W, y: H };
    return [
      { x: 0, y: 0, out: { x: x1, y: 0 } },
      { ...mid, in: { x: x2, y: H / 4 }, out: { x: x2, y: y3 } },
      { ...end, in: { x: x3, y: H } },
    ];
  }
  if (prst.startsWith('curvedConnector')) {
    // bent* fallback for curved 4/5: same elbows look better than a diagonal.
    const bent = connectorLocal(prst.replace('curved', 'bent'), W, H, avLst);
    return bent;
  }
  if (prst.endsWith('Connector') || prst.startsWith('bentConnector')) {
    const x1 = (W * adjOf(avLst, 'adj1')) / 100000;
    return [{ x: 0, y: 0 }, { x: x1, y: 0 }, { x: x1, y: H }, { x: W, y: H }];
  }
  return null;
}

/** Map a local point through flipH/flipV then rotation around the box centre. */
function mapBoxPoint(p: VectorPoint, b: Box): VectorPoint {
  let x = p.x;
  let y = p.y;
  if (b.flipH) x = b.w - x;
  if (b.flipV) y = b.h - y;
  x += b.x;
  y += b.y;
  const mapHandle = (h: { x: number; y: number } | undefined) => {
    if (!h) return undefined;
    let hx = h.x;
    let hy = h.y;
    if (b.flipH) hx = b.w - hx;
    if (b.flipV) hy = b.h - hy;
    return { x: hx + b.x, y: hy + b.y };
  };
  let out = mapHandle(p.out);
  let inn = mapHandle(p.in);
  if (b.rot) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const a = (b.rot * Math.PI) / 180;
    const turn = (qx: number, qy: number) => ({
      x: cx + (qx - cx) * Math.cos(a) - (qy - cy) * Math.sin(a),
      y: cy + (qx - cx) * Math.sin(a) + (qy - cy) * Math.cos(a),
    });
    ({ x, y } = turn(x, y));
    if (out) out = turn(out.x, out.y);
    if (inn) inn = turn(inn.x, inn.y);
  }
  return { x, y, ...(out ? { out } : {}), ...(inn ? { in: inn } : {}) };
}

function connectorOf(name: string, b: Box, s: ImStroke, prst: string, avLst: XmlNode | undefined): ImElement {
  const local = connectorLocal(prst, b.w, b.h, avLst) ?? [{ x: 0, y: 0 }, { x: b.w, y: b.h }];
  const points = local.map((p) => mapBoxPoint(p, b));
  const bent = points.length > 2 || points.some((p) => p.in || p.out);
  if (!bent && points.length >= 2) {
    const a = points[0]!;
    const z = points[points.length - 1]!;
    return { k: 'line', name: name || 'Line', x1: a.x, y1: a.y, x2: z.x, y2: z.y, stroke: s };
  }
  return { k: 'polyline', name: name || 'Connector', points, stroke: s };
}

function readPic(ctx: Ctx, pic: XmlNode, t: Xform): ImElement | null {
  const name = path(pic, 'nvPicPr', 'cNvPr')?.attrs.name ?? 'Picture';
  const spPr = kid(pic, 'spPr');
  const ph = phOf(pic);
  const b = box(kid(spPr, 'xfrm'), t) ?? (ph ? (box(path(findPh(ctx.layout, ph), 'spPr', 'xfrm'), t) ?? box(path(findPh(ctx.master, ph), 'spPr', 'xfrm'), t)) : null);
  const blipFill = kid(pic, 'blipFill');
  const blip = kid(blipFill, 'blip');
  const rel = blip && ctx.part.rels.get(blip.attrs['r:embed'] ?? '');
  if (!b) return null;
  if (path(pic, 'nvPicPr', 'nvPr', 'videoFile') || path(pic, 'nvPicPr', 'nvPr', 'audioFile')) skip(ctx, 'video');
  // An EMF icon: its vector drawing becomes editable vectors.
  if (rel && /\.emf$/i.test(rel.target) && ctx.files.has(rel.target)) {
    const svg = emfToSvg(ctx.files.get(rel.target)!);
    if (svg) return { k: 'vector', name, svg, ...b };
    // Or a PNG/JPEG wrapped in EMF+: taken out as an ordinary picture.
    const inner = emfPicture(ctx.files.get(rel.target)!);
    if (inner) {
      const key = `${rel.target}#picture`;
      ctx.deck.media.set(key, inner);
      return { k: 'pic', name, path: key, crop: crop(kid(blipFill, 'srcRect')), ...b, geom: path(spPr, 'prstGeom')?.attrs.prst ?? 'rect', stroke: stroke(ctx, kid(spPr, 'ln')) };
    }
  }
  if (!rel || !ctx.files.has(rel.target) || /\.(emf|wmf)$/i.test(rel.target)) {
    skip(ctx, 'picture');
    return { k: 'missing', name, what: 'picture', ...b };
  }
  return { k: 'pic', name, path: rel.target, crop: crop(kid(blipFill, 'srcRect')), ...b, geom: path(spPr, 'prstGeom')?.attrs.prst ?? 'rect', stroke: stroke(ctx, kid(spPr, 'ln')) };
}

function readGraphicFrame(ctx: Ctx, gf: XmlNode, t: Xform): ImElement | null {
  const name = path(gf, 'nvGraphicFramePr', 'cNvPr')?.attrs.name ?? '';
  const b = box(kid(gf, 'xfrm'), t);
  const data = path(gf, 'graphic', 'graphicData');
  if (!b || !data) return null;
  const tbl = kid(data, 'tbl');
  if (tbl) {
    const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => num(c.attrs.w) * t.sx);
    const rows = kids(tbl, 'tr').map((tr) => {
      const hgt = num(tr.attrs.h) * t.sy;
      let x = b.x;
      const cells = kids(tr, 'tc').map((tc, i) => {
        const w = cols[i] ?? 0;
        const cx = x;
        x += w;
        if (tc.attrs.hMerge === '1' || tc.attrs.vMerge === '1') return null;
        const span = Math.max(1, num(tc.attrs.gridSpan, 1));
        const width = cols.slice(i, i + span).reduce((a, v) => a + v, 0);
        const tcPr = kid(tc, 'tcPr');
        const cellBox: Box = { x: cx, y: 0, w: width, h: hgt, rot: 0, flipH: false, flipV: false };
        const text = textOf(ctx, kid(tc, 'txBody'), ctx.txStyles.other, cellBox, ctx.theme.colors[ctx.clrMap.tx1 ?? 'dk1'] ?? hex('000000')) ?? { x: cx, y: 0, w: width, h: hgt, anchor: 'TOP' as const, paragraphs: [] };
        const border = ['lnB', 'lnT', 'lnL', 'lnR'].map((k) => stroke(ctx, kid(tcPr, k))).find(Boolean) ?? null;
        // undefined: PowerPoint's default white cell. null: an explicit noFill, which must stay transparent.
        return { fill: fill(ctx, tcPr, ctx.part), stroke: border, text, span, rowSpan: Math.max(1, num(tc.attrs.rowSpan, 1)) };
      });
      return { h: hgt, cells };
    });
    return { k: 'table', name: name || 'Table', x: b.x, y: b.y, cols, rows };
  }
  const uri = data.attrs.uri ?? '';
  const what = uri.includes('chart') ? 'chart' : uri.includes('diagram') ? 'smartart' : uri.includes('ole') ? 'object' : 'object';
  skip(ctx, what);
  return { k: 'missing', name: name || what, what, ...b };
}

function readTree(ctx: Ctx, nodes: XmlNode[], t: Xform, inherited: boolean): ImElement[] {
  const out: ImElement[] = [];
  for (const n of nodes.flatMap(unwrap)) {
    let el: ImElement | null = null;
    switch (local(n)) {
      case 'sp':
        el = readShape(ctx, n, t, inherited);
        break;
      case 'cxnSp': {
        const spPr = kid(n, 'spPr');
        const b = box(kid(spPr, 'xfrm'), t);
        const s = stroke(ctx, kid(spPr, 'ln'), path(n, 'style', 'lnRef'));
        const prst = path(spPr, 'prstGeom')?.attrs.prst ?? 'straightConnector1';
        if (b && s) el = connectorOf(path(n, 'nvCxnSpPr', 'cNvPr')?.attrs.name ?? 'Line', b, s, prst, path(spPr, 'prstGeom', 'avLst'));
        break;
      }
      case 'pic':
        el = readPic(ctx, n, t);
        break;
      case 'graphicFrame':
        el = inherited ? null : readGraphicFrame(ctx, n, t);
        break;
      case 'grpSp': {
        const xfrm = path(n, 'grpSpPr', 'xfrm');
        const off = kid(xfrm, 'off');
        const ext = kid(xfrm, 'ext');
        const chOff = kid(xfrm, 'chOff');
        const chExt = kid(xfrm, 'chExt');
        let inner = t;
        if (off && ext && chOff && chExt) {
          const fx = num(chExt.attrs.cx) ? num(ext.attrs.cx) / num(chExt.attrs.cx) : 1;
          const fy = num(chExt.attrs.cy) ? num(ext.attrs.cy) / num(chExt.attrs.cy) : 1;
          const [ox, oy, cx, cy] = [num(off.attrs.x), num(off.attrs.y), num(chOff.attrs.x), num(chOff.attrs.y)];
          inner = { map: (x, y) => t.map(ox + (x - cx) * fx, oy + (y - cy) * fy), sx: t.sx * fx, sy: t.sy * fy };
        }
        const children = readTree(ctx, n.children.filter((c) => !['nvGrpSpPr', 'grpSpPr'].includes(local(c))), inner, inherited);
        if (children.length) el = { k: 'group', name: path(n, 'nvGrpSpPr', 'cNvPr')?.attrs.name ?? 'Group', children };
        break;
      }
    }
    if (el) out.push(el);
  }
  return out;
}

function background(ctx: Ctx, part: Part | null): ImFill | undefined {
  const bg = path(part?.xml.children.find((c) => ['sld', 'sldLayout', 'sldMaster'].includes(local(c))), 'cSld', 'bg');
  if (!bg || !part) return undefined;
  const pr = kid(bg, 'bgPr');
  if (pr) return fill(ctx, pr, part);
  const ref = kid(bg, 'bgRef');
  const c = ref ? color(ctx, ref) : null;
  return c ? { type: 'solid', color: c } : undefined;
}

function textOfNotes(files: Map<string, Uint8Array>, slide: Part): string {
  const rel = relOf(slide, 'notesSlide');
  const notes = rel ? readPart(files, rel.target) : null;
  if (!notes) return '';
  const body = spTreeOf(notes.xml).find((n) => phOf(n)?.type === 'body');
  return kids(kid(body, 'txBody'), 'p')
    .map((p) => kids(p).map((r) => (local(r) === 'br' ? '\n' : (kid(r, 't')?.text ?? ''))).join(''))
    .join('\n')
    .trim();
}

function transitionOf(slideXml: XmlNode): SlideTransition | null {
  const root = slideXml.children.find((c) => local(c) === 'sld');
  const nodes = (root?.children ?? []).flatMap(unwrap);
  const tr = nodes.find((n) => local(n) === 'transition');
  if (!tr) return null;
  const spd = tr.attrs.spd;
  const duration = num(tr.attrs['p14:dur'] ?? tr.attrs.dur, spd === 'slow' ? 1000 : spd === 'fast' ? 400 : 700);
  const effect = tr.children[0];
  if (!effect) return null;
  const dir = effect.attrs.dir;
  switch (local(effect)) {
    case 'fade':
    case 'dissolve':
      return { type: 'DISSOLVE', duration };
    case 'push':
      return { type: dir === 'u' ? 'SLIDE_UP' : 'PUSH', duration };
    case 'cover':
    case 'wipe':
    case 'split':
    case 'pull':
      return { type: dir === 'u' ? 'SLIDE_UP' : 'MOVE_IN', duration };
    default:
      return { type: 'DISSOLVE', duration };
  }
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };

/** Reads the unpacked package: every slide in the order of the presentation. */
export function readPptx(files: Map<string, Uint8Array>): ImDeck {
  const pres = readPart(files, 'ppt/presentation.xml') ?? readPart(files, 'clipboard/presentation.xml');
  if (!pres) throw new Error('not a presentation');
  const presRoot = kid(pres.xml, 'presentation');
  const size = kid(presRoot, 'sldSz');
  const cx = num(size?.attrs.cx, 12192000);
  const cy = num(size?.attrs.cy, 6858000);
  const k = TARGET_WIDTH / cx;
  const title = (() => {
    const core = files.get('docProps/core.xml');
    const t = core ? kid(kid(parseXml(decoder.decode(core)), 'coreProperties'), 'title')?.text : '';
    return (t ?? '').trim();
  })();
  const deck: ImDeck = { title, width: TARGET_WIDTH, height: Math.round(cy * k), slides: [], media: new Map(), fonts: new Set(), skipped: new Map() };
  const defaults = kid(presRoot, 'defaultTextStyle');
  for (const rid of kids(kid(presRoot, 'sldIdLst'), 'sldId').map((s) => s.attrs['r:id'] ?? '')) {
    const rel = pres.rels.get(rid);
    const slide = rel ? readPart(files, rel.target) : null;
    if (!slide) continue;
    const layoutRel = relOf(slide, 'slideLayout');
    const layout = layoutRel ? readPart(files, layoutRel.target) : null;
    const masterRel = layout ? relOf(layout, 'slideMaster') : null;
    const master = masterRel ? readPart(files, masterRel.target) : null;
    const masterRoot = master ? kid(master.xml, 'sldMaster') : undefined;
    const theme = readTheme(files, master);
    const clrMap = { ...(kid(masterRoot, 'clrMap')?.attrs ?? { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }) };
    const over = path(slide.xml.children.find((c) => local(c) === 'sld'), 'clrMapOvr', 'overrideClrMapping');
    if (over) Object.assign(clrMap, over.attrs);
    const tx = kid(masterRoot, 'txStyles');
    const ctx: Ctx = {
      files,
      theme,
      clrMap,
      k,
      deck,
      part: slide,
      txStyles: { title: [defaults, kid(tx, 'titleStyle')].filter((n): n is XmlNode => !!n), body: [defaults, kid(tx, 'bodyStyle')].filter((n): n is XmlNode => !!n), other: [defaults, kid(tx, 'otherStyle')].filter((n): n is XmlNode => !!n) },
      layout,
      master,
      slideNumber: deck.slides.length + 1,
    };
    const t = IDENTITY(k);
    const sld = slide.xml.children.find((c) => local(c) === 'sld');
    const layoutRoot = layout?.xml.children.find((c) => local(c) === 'sldLayout');
    const elements: ImElement[] = [];
    // What the master and the layout draw themselves (logos, bars), unless a slide or layout hides it.
    if (master && sld?.attrs.showMasterSp !== '0' && layoutRoot?.attrs.showMasterSp !== '0') elements.push(...readTree({ ...ctx, part: master }, spTreeOf(master.xml), t, true));
    if (layout && sld?.attrs.showMasterSp !== '0') elements.push(...readTree({ ...ctx, part: layout }, spTreeOf(layout.xml), t, true));
    elements.push(...readTree(ctx, spTreeOf(slide.xml), t, false));
    let bg = background(ctx, slide);
    if (bg === undefined) bg = background({ ...ctx, part: layout! }, layout);
    if (bg === undefined) bg = background({ ...ctx, part: master! }, master);
    const name = (() => {
      const titleEl = elements.find((e) => e.k === 'shape' && e.text && /title|заголов/i.test(e.name));
      const text = titleEl && titleEl.k === 'shape' ? titleEl.text!.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').trim() : '';
      return text.replace(/\s+/g, ' ').slice(0, 60);
    })();
    deck.slides.push({ name, background: bg ?? { type: 'solid', color: hex('FFFFFF') }, elements, notes: textOfNotes(files, slide), transition: transitionOf(slide.xml), hidden: sld?.attrs.show === '0' });
  }
  // The pictures the slides use.
  const used = new Set<string>();
  const collect = (els: ImElement[]) => {
    for (const e of els) {
      if (e.k === 'pic') used.add(e.path);
      if (e.k === 'shape' && e.fill?.type === 'image') used.add(e.fill.path);
      if (e.k === 'group') collect(e.children);
    }
  };
  for (const s of deck.slides) {
    collect(s.elements);
    if (s.background?.type === 'image') used.add(s.background.path);
  }
  for (const p of used) {
    if (deck.media.has(p)) continue;
    const bytes = files.get(p);
    const mime = MIME[p.split('.').pop()!.toLowerCase()];
    if (bytes && mime) deck.media.set(p, { bytes, mime });
  }
  return deck;
}

/** The whole way from the file's bytes. */
export async function readPptxFile(bytes: Uint8Array): Promise<ImDeck> {
  const { unzip } = await import('../fig/archive.ts');
  return readPptx(await unzip(bytes));
}

export function isPptx(name: string): boolean {
  return /\.pptx$/i.test(name);
}

