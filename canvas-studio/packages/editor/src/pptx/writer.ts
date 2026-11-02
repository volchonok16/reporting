// PPTX export (FEAT-038), the file side: a model of slides (text, shapes,
// pictures, lines, groups; coordinates in px relative to the slide's frame)
// becomes PresentationML parts. Own code, no libraries — ported from the
// "Layers to PPTX" Figma plugin. Packing into a ZIP is done by `#render`'s zip.

import { tr } from '#core';
export interface Stop {
  pos: number;
  color: string;
  alpha: number;
}

export type Fill = { type: 'solid'; color: string; alpha: number } | { type: 'lin'; ang: number; stops: Stop[] } | { type: 'rad'; cx: number; cy: number; stops: Stop[] };

export interface Line {
  color: string;
  alpha: number;
  w: number;
  dash: 'dot' | 'dash' | null;
  cap?: 'rnd' | 'sq' | null;
}

export interface Shadow {
  inner: boolean;
  x: number;
  y: number;
  blur: number;
  color: string;
  alpha: number;
}

/** Clip rectangle of a parent that clips its content; radii [tl, tr, br, bl]. */
export interface Clip {
  x: number;
  y: number;
  w: number;
  h: number;
  radii?: number[];
}

export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface Run {
  text: string;
  font: string;
  w: number;
  /** PowerPoint's Bold, when the font's names say otherwise than the weight (pptx/fonts.ts). */
  bold?: boolean;
  i: boolean;
  size: number;
  color: string;
  alpha: number;
  u: boolean;
  strike: boolean;
  spc: number;
  cap: 'all' | 'small' | null;
  baseline: number;
  link: string | null;
}

export interface Para {
  runs: Run[];
  lineH: number | null;
  list: 'bullet' | 'number' | null;
  level: number;
  size: number;
  indent: number;
  endRun: Omit<Run, 'text'> | null;
}

interface Base {
  name: string;
  opacity: number;
  clip: Clip | null;
}

interface Boxed extends Base {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

export interface ShapeEl extends Boxed {
  k: 'shape';
  geom: 'rect' | 'ellipse';
  radii: number[] | null;
  fill: Fill | null;
  line?: Line | null;
  shadow?: Shadow | null;
}

export interface PicEl extends Boxed {
  k: 'pic';
  img: string;
  /** SVG version of the same picture (PowerPoint 2016+ shows it, older ones the PNG). */
  svg?: string;
  crop: Crop;
  alpha: number;
  geom?: 'rect' | 'ellipse';
  radii?: number[] | null;
  line?: Line | null;
  shadow?: Shadow | null;
  /** A rendered layer: never rounded or re-shaped. */
  raster?: boolean;
}

export interface TextEl extends Boxed {
  k: 'text';
  wrap: 'none' | 'square';
  align: 'l' | 'ctr' | 'r' | 'just';
  anchor: 't' | 'ctr' | 'b';
  paraSpacing: number;
  paras: Para[];
  shadow: Shadow | null;
}

/** A cell of a table: its text, fill and margins; a merged one spans, the places under it are `merged`. */
export interface TableCell {
  paras: Para[];
  align: TextEl['align'];
  anchor: TextEl['anchor'];
  fill: Fill | null;
  /** Margins around the text [t, r, b, l], px. */
  mar: [number, number, number, number];
  span: number;
  rowSpan: number;
  /** Under a merged cell: covered from the left (h) and/or from above (v). */
  hMerge: boolean;
  vMerge: boolean;
}

/** A real PowerPoint table (FEAT-169): columns, rows (least heights — they grow with the text), cells row by row. */
export interface TableEl extends Boxed {
  k: 'table';
  cols: number[];
  rows: number[];
  cells: TableCell[][];
  /** The lines between and around the cells. */
  line: Line | null;
  paraSpacing: number;
}

export interface LineEl extends Base {
  k: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  line: Line;
}

export interface GroupEl {
  k: 'group';
  name: string;
  els: El[];
}

export type El = ShapeEl | PicEl | TextEl | TableEl | LineEl | GroupEl;

export interface Slide {
  name: string;
  w: number;
  h: number;
  /** Solid background colour (hex without #) or null. */
  bg: string | null;
  els: El[];
}

export interface Image {
  id: string;
  bytes: Uint8Array;
  ext: 'png' | 'jpeg' | 'gif' | 'svg';
}

export interface BuildOptions {
  /** 'standard': 13.333 in wide (PowerPoint's 16:9 width); 'px': 1 px = 1 px at 96 dpi. */
  size?: 'standard' | 'px';
  title?: string;
}

export interface PackFile {
  name: string;
  data: Uint8Array;
}

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const CT = 'application/vnd.openxmlformats-officedocument.';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const EMU_PER_PX = 9525;
const EMU_PER_PT = 12700;
const MIN_SLIDE = 914400;
const MAX_SLIDE = 51206400;
const APP = 'Simmetrika';

export const PPTX_MIME = `${CT}presentationml.presentation`;

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function int(v: number): number {
  const r = Math.round(Number(v));
  return Number.isFinite(r) ? r : 0;
}
function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
function pct(v: number): number {
  return int(clamp(v, 0, 1) * 100000);
}
function angle(deg: number): number {
  const d = ((Number(deg) % 360) + 360) % 360;
  return int(d * 60000) % 21600000;
}
function shortName(s: string): string {
  return s.length > 120 ? s.slice(0, 120) : s;
}

function clr(color: string, alpha = 1): string {
  const a = clamp(alpha, 0, 1);
  return `<a:srgbClr val="${esc(color || '000000')}">${a < 0.999 ? `<a:alpha val="${pct(a)}"/>` : ''}</a:srgbClr>`;
}

// ---------------------------------------------------------------- geometry

function geometry(el: { geom?: 'rect' | 'ellipse'; radii?: number[] | null }, cx: number, cy: number, k: number): string {
  if (el.geom === 'ellipse') return '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>';
  const m = Math.min(cx, cy) / 2;
  const r = (el.radii ?? [0, 0, 0, 0]).map((v) => Math.min(Math.max(0, v * k), m));
  if (r.every((v) => v < 0.5)) return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  if (r.every((v) => Math.abs(v - r[0]!) < 1)) {
    const adj = Math.min(50000, int((r[0]! / Math.max(1, Math.min(cx, cy))) * 100000));
    return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`;
  }
  // Different corner radii: an own outline.
  const [tl, tr, br, bl] = r.map(int) as [number, number, number, number];
  const W = int(cx);
  const H = int(cy);
  const arc = (rad: number, st: number) => (rad ? `<a:arcTo wR="${rad}" hR="${rad}" stAng="${st}" swAng="5400000"/>` : '');
  const pt = (x: number, y: number) => `<a:pt x="${x}" y="${y}"/>`;
  const path =
    `<a:moveTo>${pt(tl, 0)}</a:moveTo>` +
    `<a:lnTo>${pt(W - tr, 0)}</a:lnTo>${arc(tr, 16200000)}` +
    `<a:lnTo>${pt(W, H - br)}</a:lnTo>${arc(br, 0)}` +
    `<a:lnTo>${pt(bl, H)}</a:lnTo>${arc(bl, 5400000)}` +
    `<a:lnTo>${pt(0, tl)}</a:lnTo>${arc(tl, 10800000)}<a:close/>`;
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}">${path}</a:path></a:pathLst></a:custGeom>`;
}

function fillXml(f: Fill | null, opacity = 1): string {
  if (!f) return '<a:noFill/>';
  if (f.type === 'solid') return `<a:solidFill>${clr(f.color, f.alpha * opacity)}</a:solidFill>`;
  const stops = f.stops.slice();
  if (!stops.length) return '<a:noFill/>';
  if (stops.length === 1) stops.push({ ...stops[0]!, pos: 1 });
  const gs = stops.map((s) => `<a:gs pos="${pct(s.pos)}">${clr(s.color, s.alpha * opacity)}</a:gs>`).join('');
  const shade =
    f.type === 'lin'
      ? `<a:lin ang="${angle(f.ang)}" scaled="0"/>`
      : `<a:path path="circle"><a:fillToRect l="${pct(f.cx)}" t="${pct(f.cy)}" r="${pct(1 - f.cx)}" b="${pct(1 - f.cy)}"/></a:path>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst>${shade}</a:gradFill>`;
}

function lineXml(l: Line | null | undefined, k: number, opacity = 1): string {
  if (!l) return '<a:ln><a:noFill/></a:ln>';
  const w = Math.max(1, int(l.w * k));
  const dash = l.dash === 'dot' ? '<a:prstDash val="sysDot"/>' : l.dash === 'dash' ? '<a:prstDash val="dash"/>' : '';
  return `<a:ln w="${w}"${l.cap ? ` cap="${l.cap}"` : ''}><a:solidFill>${clr(l.color, l.alpha * opacity)}</a:solidFill>${dash}</a:ln>`;
}

function shadowXml(s: Shadow | null | undefined, k: number, opacity = 1): string {
  if (!s) return '';
  const dist = int(Math.hypot(s.x, s.y) * k);
  const dir = angle((Math.atan2(s.y, s.x) * 180) / Math.PI);
  const blur = int(s.blur * k);
  const c = clr(s.color, s.alpha * opacity);
  if (s.inner) return `<a:effectLst><a:innerShdw blurRad="${blur}" dist="${dist}" dir="${dir}">${c}</a:innerShdw></a:effectLst>`;
  return `<a:effectLst><a:outerShdw blurRad="${blur}" dist="${dist}" dir="${dir}" algn="ctr" rotWithShape="0">${c}</a:outerShdw></a:effectLst>`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function xfrmXml(b: Box, rot: number, flipH = false, flipV = false): string {
  return `<a:xfrm${rot ? ` rot="${angle(rot)}"` : ''}${flipH ? ' flipH="1"' : ''}${flipV ? ' flipV="1"' : ''}><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.w}" cy="${b.h}"/></a:xfrm>`;
}

// ---------------------------------------------------------------- clipping

function rectIntersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y };
}
function outside(box: Box, clip: Clip | null): boolean {
  if (!clip) return false;
  const i = rectIntersect(box, clip);
  return i.w <= 0.01 || i.h <= 0.01;
}
function rotatedBounds(el: Boxed): Box {
  if (!el.rot) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const a = (el.rot * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const w = el.w * c + el.h * s;
  const h = el.w * s + el.h * c;
  return { x: el.x + el.w / 2 - w / 2, y: el.y + el.h / 2 - h / 2, w, h };
}

/** Pictures and rectangles are cut by the frame of a parent that clips its content. */
function applyClip<T extends Exclude<El, GroupEl>>(el: T): T | null {
  const clip = el.clip;
  if (!clip) return el;
  if (el.k === 'line') {
    const lb = { x: Math.min(el.x1, el.x2) - 0.5, y: Math.min(el.y1, el.y2) - 0.5, w: Math.abs(el.x2 - el.x1) + 1, h: Math.abs(el.y2 - el.y1) + 1 };
    return outside(lb, clip) ? null : el;
  }
  const b = el as unknown as Boxed;
  if (outside(rotatedBounds(b), clip)) return null;
  if (b.rot || el.k === 'text' || el.k === 'table') return el;
  const box = { x: b.x, y: b.y, w: b.w, h: b.h };
  const vis = rectIntersect(box, clip);
  const out = { ...el } as T & Boxed & { radii?: number[] | null; geom?: string; raster?: boolean; crop?: Crop };
  // Corners that sit on the parent's rounded corners are rounded the same way.
  const roundCorners = (o: typeof out) => {
    if (!clip.radii || o.geom === 'ellipse' || o.raster) return;
    const cr = clip.radii;
    const r = (o.radii ?? [0, 0, 0, 0]).slice();
    const near = (p: number, q: number) => Math.abs(p - q) < 0.75;
    const L = near(o.x, clip.x);
    const T = near(o.y, clip.y);
    const R = near(o.x + o.w, clip.x + clip.w);
    const B = near(o.y + o.h, clip.y + clip.h);
    if (L && T) r[0] = Math.max(r[0]!, cr[0]!);
    if (R && T) r[1] = Math.max(r[1]!, cr[1]!);
    if (R && B) r[2] = Math.max(r[2]!, cr[2]!);
    if (L && B) r[3] = Math.max(r[3]!, cr[3]!);
    o.radii = r;
  };
  if (vis.x <= box.x + 0.01 && vis.y <= box.y + 0.01 && vis.x + vis.w >= box.x + box.w - 0.01 && vis.y + vis.h >= box.y + box.h - 0.01) {
    roundCorners(out);
    return out;
  }
  if (el.k === 'pic') {
    const c = el.crop;
    const sw = 1 - c.l - c.r;
    const sh = 1 - c.t - c.b;
    const a0 = (vis.x - box.x) / box.w;
    const a1 = (vis.x + vis.w - box.x) / box.w;
    const b0 = (vis.y - box.y) / box.h;
    const b1 = (vis.y + vis.h - box.y) / box.h;
    out.crop = { l: c.l + a0 * sw, r: c.r + (1 - a1) * sw, t: c.t + b0 * sh, b: c.b + (1 - b1) * sh };
  } else if (el.k === 'shape' && el.geom === 'ellipse') {
    return el;
  }
  out.x = vis.x;
  out.y = vis.y;
  out.w = vis.w;
  out.h = vis.h;
  roundCorners(out);
  return out;
}

// ---------------------------------------------------------------- text

const hasCyr = (s: string) => /[Ѐ-ӿ]/.test(s);

function runProps(r: Omit<Run, 'text'> & { text?: string; linkRid?: string }, k: number, opacity: number, tag: 'rPr' | 'endParaRPr', shadow: string): string {
  const sz = clamp(int(((r.size * k) / EMU_PER_PT) * 100), 100, 400000);
  let a = ` lang="${hasCyr(r.text ?? '') ? 'ru-RU' : 'en-US'}" sz="${sz}"`;
  if (r.bold ?? r.w >= 600) a += ' b="1"';
  if (r.i) a += ' i="1"';
  if (r.u) a += ' u="sng"';
  if (r.strike) a += ' strike="sngStrike"';
  if (r.cap) a += ` cap="${r.cap}"`;
  if (r.spc) a += ` spc="${clamp(int(((r.spc * k) / EMU_PER_PT) * 100), -400000, 400000)}"`;
  if (r.baseline) a += ` baseline="${int(r.baseline * 1000)}"`;
  a += ' dirty="0"';
  const font = esc(r.font || 'Arial');
  const inner =
    `<a:solidFill>${clr(r.color, r.alpha * opacity)}</a:solidFill>${shadow}` +
    `<a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/>` +
    (r.linkRid ? `<a:hlinkClick r:id="${r.linkRid}"/>` : '');
  return `<a:${tag}${a}>${inner}</a:${tag}>`;
}

interface Rels {
  media(name: string): string;
  link(url: string): string;
}

function textBody(el: TextEl, k: number, rels: Rels): string {
  const paras = parasXml(el, el.shadow ? shadowXml(el.shadow, k, el.opacity) : '', k, rels);
  return `<p:txBody><a:bodyPr wrap="${el.wrap}" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="${el.anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody>`;
}

/** The paragraphs of a text box or a table cell. */
function parasXml(el: { paras: Para[]; align: TextEl['align']; paraSpacing: number; opacity: number }, shadow: string, k: number, rels: Rels): string {
  const opacity = el.opacity;
  return el.paras
    .map((p, idx) => {
      let ppr = ` algn="${el.align}"`;
      let inner = '';
      if (p.lineH) inner += `<a:lnSpc><a:spcPts val="${clamp(int(((p.lineH * k) / EMU_PER_PT) * 100), 0, 158400)}"/></a:lnSpc>`;
      if (el.paraSpacing && idx < el.paras.length - 1) inner += `<a:spcAft><a:spcPts val="${clamp(int(((el.paraSpacing * k) / EMU_PER_PT) * 100), 0, 158400)}"/></a:spcAft>`;
      if (p.list) {
        const step = int(p.size * 1.5 * k);
        ppr += ` marL="${step * p.level}" indent="${-step}"`;
        inner += p.list === 'number' ? '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>' : '<a:buFont typeface="Arial"/><a:buChar char="•"/>';
      } else {
        if (p.indent) ppr += ` indent="${int(p.indent * k)}"`;
        inner += '<a:buNone/>';
      }
      const runs = p.runs
        .map((r) => {
          const linkRid = r.link ? rels.link(r.link) : undefined;
          const props = runProps({ ...r, linkRid }, k, opacity, 'rPr', shadow);
          // Line breaks inside a paragraph (Shift+Enter) become <a:br/>.
          return r.text
            .split(' ')
            .map((piece, i) => (i > 0 ? `<a:br>${props}</a:br>` : '') + (piece.length ? `<a:r>${props}<a:t>${esc(piece)}</a:t></a:r>` : ''))
            .join('');
        })
        .join('');
      const end = p.endRun ?? p.runs[p.runs.length - 1] ?? null;
      const endXml = end ? runProps({ ...end, text: '', u: false, strike: false, spc: 0, cap: null, baseline: 0, link: null }, k, opacity, 'endParaRPr', '') : '';
      return `<a:p><a:pPr${ppr}>${inner}</a:pPr>${runs}${endXml}</a:p>`;
    })
    .join('');
}

const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table';

/** A table's grid of cells (`a:tbl`); PowerPoint wants every place of the grid, merged ones too. */
function tableXml(el: TableEl, k: number, rels: Rels): string {
  const op = el.opacity;
  const border = (tag: string) => {
    if (!el.line) return `<a:${tag} w="0"><a:noFill/></a:${tag}>`;
    const l = el.line;
    return `<a:${tag} w="${Math.max(1, int(l.w * k))}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill>${clr(l.color, l.alpha * op)}</a:solidFill><a:prstDash val="solid"/><a:round/></a:${tag}>`;
  };
  const lines = border('lnL') + border('lnR') + border('lnT') + border('lnB');
  const grid = el.cols.map((w) => `<a:gridCol w="${Math.max(1, int(w * k))}"/>`).join('');
  const rows = el.cells
    .map((row, r) => {
      const tcs = row
        .map((c) => {
          let attrs = '';
          if (c.span > 1) attrs += ` gridSpan="${c.span}"`;
          if (c.rowSpan > 1) attrs += ` rowSpan="${c.rowSpan}"`;
          if (c.hMerge) attrs += ' hMerge="1"';
          if (c.vMerge) attrs += ' vMerge="1"';
          // An empty cell still has a paragraph (PowerPoint refuses a cell without one).
          const paras = c.paras.length ? parasXml({ paras: c.paras, align: c.align, paraSpacing: el.paraSpacing, opacity: op }, '', k, rels) : '<a:p><a:endParaRPr lang="ru-RU" dirty="0"/></a:p>';
          const [t, rr, b, l] = c.mar.map((v) => Math.max(0, int(v * k)));
          return (
            `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${paras}</a:txBody>` +
            `<a:tcPr marL="${l}" marR="${rr}" marT="${t}" marB="${b}" anchor="${c.anchor}">${lines}${fillXml(c.fill, op)}</a:tcPr></a:tc>`
          );
        })
        .join('');
      return `<a:tr h="${Math.max(1, int((el.rows[r] ?? 0) * k))}">${tcs}</a:tr>`;
    })
    .join('');
  return `<a:graphic><a:graphicData uri="${TABLE_URI}"><a:tbl><a:tblPr/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic>`;
}

// ---------------------------------------------------------------- slide

interface Placement {
  k: number;
  ox: number;
  oy: number;
}

function renderSlide(slide: Slide, geo: Placement, media: { ref(id: string): string }, rels: Rels): string {
  const { k, ox, oy } = geo;
  let nextId = 2;
  const box = (x: number, y: number, w: number, h: number): Box => ({ x: int(ox + x * k), y: int(oy + y * k), w: Math.max(0, int(w * k)), h: Math.max(0, int(h * k)) });
  const nv = (name: string) => `<p:cNvPr id="${nextId++}" name="${esc(shortName(name))}"/>`;

  const emit = (source: El): { xml: string; b: Box } | null => {
    if (source.k === 'group') {
      const parts = source.els.map(emit).filter((p): p is { xml: string; b: Box } => !!p);
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0]!;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of parts) {
        x0 = Math.min(x0, p.b.x);
        y0 = Math.min(y0, p.b.y);
        x1 = Math.max(x1, p.b.x + p.b.w);
        y1 = Math.max(y1, p.b.y + p.b.h);
      }
      const g = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
      const off = `<a:off x="${g.x}" y="${g.y}"/><a:ext cx="${g.w}" cy="${g.h}"/>`;
      const xml =
        `<p:grpSp><p:nvGrpSpPr>${nv(source.name)}<p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr><a:xfrm>${off}<a:chOff x="${g.x}" y="${g.y}"/><a:chExt cx="${g.w}" cy="${g.h}"/></a:xfrm></p:grpSpPr>` +
        `${parts.map((p) => p.xml).join('')}</p:grpSp>`;
      return { xml, b: g };
    }
    const el = applyClip(source);
    if (!el) return null;
    const op = el.opacity;

    if (el.k === 'line') {
      const lb = box(Math.min(el.x1, el.x2), Math.min(el.y1, el.y2), Math.abs(el.x2 - el.x1), Math.abs(el.y2 - el.y1));
      const xml =
        `<p:cxnSp><p:nvCxnSpPr>${nv(el.name)}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>` +
        `${xfrmXml(lb, 0, el.x2 < el.x1, el.y2 < el.y1)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:noFill/>${lineXml(el.line, k, op)}</p:spPr></p:cxnSp>`;
      return { xml, b: lb };
    }

    const b = box(el.x, el.y, el.w, el.h);
    b.w = Math.max(1, b.w);
    b.h = Math.max(1, b.h);

    if (el.k === 'table') {
      const xml =
        `<p:graphicFrame><p:nvGraphicFramePr>${nv(el.name)}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="${b.x}" y="${b.y}"/><a:ext cx="${b.w}" cy="${b.h}"/></p:xfrm>${tableXml(el, k, rels)}</p:graphicFrame>`;
      return { xml, b };
    }

    if (el.k === 'shape') {
      const xml =
        `<p:sp><p:nvSpPr>${nv(el.name)}<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>` +
        `${xfrmXml(b, el.rot)}${geometry(el, b.w, b.h, k)}${fillXml(el.fill, op)}${lineXml(el.line, k, op)}${shadowXml(el.shadow, k, op)}</p:spPr></p:sp>`;
      return { xml, b };
    }

    if (el.k === 'pic') {
      const rid = rels.media(media.ref(el.img));
      const svgRid = el.svg ? rels.media(media.ref(el.svg)) : null;
      const alpha = clamp(el.alpha * op, 0, 1);
      const blip =
        `<a:blip r:embed="${rid}">${alpha < 0.999 ? `<a:alphaModFix amt="${pct(alpha)}"/>` : ''}` +
        (svgRid ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${svgRid}"/></a:ext></a:extLst>` : '') +
        '</a:blip>';
      let crop = '';
      for (const s of ['l', 't', 'r', 'b'] as const) {
        const v = int((el.crop[s] || 0) * 100000);
        if (v) crop += ` ${s}="${v}"`;
      }
      const xml =
        `<p:pic><p:nvPicPr>${nv(el.name)}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill>${blip}${crop ? `<a:srcRect${crop}/>` : ''}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        `<p:spPr>${xfrmXml(b, el.rot)}${el.raster ? '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' : geometry(el, b.w, b.h, k)}` +
        `${el.line ? lineXml(el.line, k, op) : ''}${shadowXml(el.shadow, k, op)}</p:spPr></p:pic>`;
      return { xml, b };
    }

    const xml =
      `<p:sp><p:nvSpPr>${nv(el.name)}<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>` +
      `${xfrmXml(b, el.rot)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${textBody(el, k, rels)}</p:sp>`;
    return { xml, b };
  };

  const body = slide.els.map((e) => emit(e)?.xml ?? '').join('');
  const bg = slide.bg ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${esc(slide.bg)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : '';
  return (
    `${XML_HEAD}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    `<p:cSld name="${esc(shortName(slide.name))}">${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    `${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

// ---------------------------------------------------------------- package

function relsXml(list: { id: string; type: string; target: string; external?: boolean }[]): string {
  return (
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    list.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
    '</Relationships>'
  );
}

const THEME =
  `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="Office Theme"><a:themeElements><a:clrScheme name="Office">` +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>' +
  '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>' +
  '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office">' +
  '<a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
  '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

const DEF_LVL = '<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>';
function lvls(count = 9): string {
  let s = '';
  for (let i = 1; i <= count; i++) s += `<a:lvl${i}pPr marL="${(i - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">${DEF_LVL}</a:lvl${i}pPr>`;
  return s;
}
const EMPTY_TREE =
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
const MASTER =
  `${XML_HEAD}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  `<p:txStyles><p:titleStyle>${lvls(1)}</p:titleStyle><p:bodyStyle>${lvls()}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${lvls()}</p:otherStyle></p:txStyles></p:sldMaster>`;
const LAYOUT = `${XML_HEAD}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

/** Slide size from the first slide; each slide is fitted and centred in it. */
export function slideGeometry(slides: readonly Slide[], size: 'standard' | 'px' = 'standard'): { cx: number; cy: number; per: Placement[] } {
  const w0 = slides[0]!.w;
  const h0 = slides[0]!.h;
  let CX = size === 'px' ? w0 * EMU_PER_PX : 12192000;
  let CY = size === 'px' ? h0 * EMU_PER_PX : (CX * h0) / w0;
  const s = Math.min(1, MAX_SLIDE / Math.max(CX, CY));
  CX = clamp(int(CX * s), MIN_SLIDE, MAX_SLIDE);
  CY = clamp(int(CY * s), MIN_SLIDE, MAX_SLIDE);
  return {
    cx: CX,
    cy: CY,
    per: slides.map((sl) => {
      const k = Math.min(CX / sl.w, CY / sl.h);
      return { k, ox: (CX - sl.w * k) / 2, oy: (CY - sl.h * k) / 2 };
    }),
  };
}

/** All parts of the presentation, in package order ([Content_Types].xml first). */
export function buildPptx(slides: readonly Slide[], images: readonly Image[], opts: BuildOptions = {}): PackFile[] {
  if (!slides.length) throw new Error(tr('Нет слайдов'));
  const enc = new TextEncoder();
  const files: PackFile[] = [];
  const add = (name: string, data: string | Uint8Array) => files.push({ name, data: typeof data === 'string' ? enc.encode(data) : data });

  const imgById = new Map(images.map((im) => [im.id, im]));
  const mediaNames = new Map<string, string>();
  const media = {
    ref(id: string): string {
      let name = mediaNames.get(id);
      if (!name) {
        const im = imgById.get(id);
        if (!im) throw new Error(tr('Нет картинки {0}', id));
        name = `image${mediaNames.size + 1}.${im.ext}`;
        mediaNames.set(id, name);
        add(`ppt/media/${name}`, im.bytes);
      }
      return name;
    },
  };

  const geo = slideGeometry(slides, opts.size);
  const slideXml: string[] = [];
  slides.forEach((sl, i) => {
    const list: { id: string; type: string; target: string; external?: boolean }[] = [{ id: 'rId1', type: `${REL}slideLayout`, target: '../slideLayouts/slideLayout1.xml' }];
    const byMedia = new Map<string, string>();
    const byLink = new Map<string, string>();
    const rels: Rels = {
      media(name) {
        let id = byMedia.get(name);
        if (!id) {
          id = `rId${list.length + 1}`;
          list.push({ id, type: `${REL}image`, target: `../media/${name}` });
          byMedia.set(name, id);
        }
        return id;
      },
      link(url) {
        let id = byLink.get(url);
        if (!id) {
          id = `rId${list.length + 1}`;
          list.push({ id, type: `${REL}hyperlink`, target: url, external: true });
          byLink.set(url, id);
        }
        return id;
      },
    };
    slideXml.push(renderSlide(sl, geo.per[i]!, media, rels));
    add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, relsXml(list));
  });
  slideXml.forEach((x, i) => add(`ppt/slides/slide${i + 1}.xml`, x));

  const n = slides.length;
  let ctypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="svg" ContentType="image/svg+xml"/>' +
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}presentationml.slideLayout+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT}theme+xml"/>` +
    `<Override PartName="/ppt/presProps.xml" ContentType="${CT}presentationml.presProps+xml"/>` +
    `<Override PartName="/ppt/viewProps.xml" ContentType="${CT}presentationml.viewProps+xml"/>` +
    `<Override PartName="/ppt/tableStyles.xml" ContentType="${CT}presentationml.tableStyles+xml"/>` +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    `<Override PartName="/docProps/app.xml" ContentType="${CT}extended-properties+xml"/>`;
  for (let i = 1; i <= n; i++) ctypes += `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="${CT}presentationml.slide+xml"/>`;
  ctypes += '</Types>';

  const presRels = [{ id: 'rId1', type: `${REL}slideMaster`, target: 'slideMasters/slideMaster1.xml' }];
  let sldIds = '';
  for (let s = 1; s <= n; s++) {
    presRels.push({ id: `rId${s + 1}`, type: `${REL}slide`, target: `slides/slide${s}.xml` });
    sldIds += `<p:sldId id="${255 + s}" r:id="rId${s + 1}"/>`;
  }
  presRels.push({ id: `rId${n + 2}`, type: `${REL}presProps`, target: 'presProps.xml' });
  presRels.push({ id: `rId${n + 3}`, type: `${REL}viewProps`, target: 'viewProps.xml' });
  presRels.push({ id: `rId${n + 4}`, type: `${REL}theme`, target: 'theme/theme1.xml' });
  presRels.push({ id: `rId${n + 5}`, type: `${REL}tableStyles`, target: 'tableStyles.xml' });

  const pres =
    `${XML_HEAD}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${geo.cx}" cy="${geo.cy}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle>${lvls()}</p:defaultTextStyle></p:presentation>`;

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(opts.title || tr('Презентация'))}</dc:title><dc:creator>${APP}</dc:creator><cp:revision>1</cp:revision>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app =
    `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<TotalTime>0</TotalTime><Application>${APP}</Application><PresentationFormat>Custom</PresentationFormat><Slides>${n}</Slides><AppVersion>16.0000</AppVersion></Properties>`;

  const head: PackFile[] = [];
  const put = (name: string, data: string) => head.push({ name, data: enc.encode(data) });
  put('[Content_Types].xml', ctypes);
  put(
    '_rels/.rels',
    relsXml([
      { id: 'rId1', type: `${REL}officeDocument`, target: 'ppt/presentation.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: `${REL}extended-properties`, target: 'docProps/app.xml' },
    ]),
  );
  put('docProps/core.xml', core);
  put('docProps/app.xml', app);
  put('ppt/presentation.xml', pres);
  put('ppt/_rels/presentation.xml.rels', relsXml(presRels));
  put('ppt/presProps.xml', `${XML_HEAD}<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>`);
  put('ppt/viewProps.xml', `${XML_HEAD}<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`);
  put('ppt/tableStyles.xml', `${XML_HEAD}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  put('ppt/theme/theme1.xml', THEME);
  put('ppt/slideMasters/slideMaster1.xml', MASTER);
  put(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    relsXml([
      { id: 'rId1', type: `${REL}slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: `${REL}theme`, target: '../theme/theme1.xml' },
    ]),
  );
  put('ppt/slideLayouts/slideLayout1.xml', LAYOUT);
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relsXml([{ id: 'rId1', type: `${REL}slideMaster`, target: '../slideMasters/slideMaster1.xml' }]));
  return head.concat(files);
}
