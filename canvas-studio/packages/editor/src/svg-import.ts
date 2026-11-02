// SVG import (stage "Export and import"): our own XML reader and path parser.
// Shapes become editable vectors (transforms are baked into the points), text
// becomes text layers, groups stay groups; fills and strokes (colours, linear and
// radial gradients, opacity, fill rule) and simple <style> rules are kept.

import { tr } from '#core';
import { rgba, solid, type Color, type NodeId, type Paint, type StrokeCap, type StrokeJoin, type Transaction, type VectorPath, type VectorPoint } from '#core';
import { apply, mapPaths, multiply, pathsBounds, shapePaths, type Matrix, type Point } from '#geometry';
import type { Editor } from './editor.ts';

// ---------- XML ----------

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** A small, forgiving XML reader: elements, attributes, text, CDATA; comments and declarations are skipped. */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? src.length : lt;
    if (textEnd > i) stack[stack.length - 1]!.text += decodeEntities(src.slice(i, textEnd));
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end < 0 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      stack[stack.length - 1]!.text += src.slice(lt + 9, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end + 3;
    } else if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      const name = src.slice(lt + 2, end).trim();
      // Pop to the matching element (tolerates small mistakes).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? src.length : end + 1;
    } else {
      let j = lt + 1;
      let quote = '';
      while (j < src.length) {
        const ch = src[j]!;
        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') break;
        j++;
      }
      const raw = src.slice(lt + 1, j);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const nameMatch = /^[^\s/>]+/.exec(body);
      const node: XmlNode = { name: nameMatch ? nameMatch[0] : '', attrs: {}, children: [], text: '' };
      const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body.slice(node.name.length)))) node.attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) stack.push(node);
      i = j + 1;
    }
  }
  return root;
}

// ---------- Path data ----------

/** Parses SVG path data into contours of points with cubic handles (quadratics and arcs converted). */
export function parsePathData(d: string): VectorPath[] {
  const tokens = d.match(/[a-df-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const paths: VectorPath[] = [];
  let current: VectorPath | null = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = '';
  let lastCtrl: Point | null = null;
  let lastQuad: Point | null = null;
  let i = 0;
  const num = () => Number(tokens[i++]);
  const flag = () => {
    // Arc flags may be written without separators ("a1 1 0 011 1").
    const t = tokens[i]!;
    if (t.length > 1 && (t[0] === '0' || t[0] === '1')) {
      tokens[i] = t.slice(1);
      return Number(t[0]);
    }
    i++;
    return Number(t);
  };
  const last = () => current!.points[current!.points.length - 1]!;
  const lineTo = (nx: number, ny: number) => {
    current!.points.push({ x: nx, y: ny });
    x = nx;
    y = ny;
  };
  const cubicTo = (c1: Point, c2: Point, p: Point) => {
    last().out = c1;
    current!.points.push({ x: p.x, y: p.y, in: c2 });
    x = p.x;
    y = p.y;
  };
  const start = () => {
    if (!current) {
      current = { closed: false, points: [{ x, y }] };
      paths.push(current);
    }
  };
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[a-z]$/i.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (current) {
          // A closing point equal to the start is merged into it.
          const first = current.points[0]!;
          const end = current.points[current.points.length - 1]!;
          if (current.points.length > 1 && Math.abs(end.x - first.x) < 1e-6 && Math.abs(end.y - first.y) < 1e-6) {
            if (end.in) first.in = end.in;
            current.points.pop();
          }
          current.closed = true;
        }
        x = sx;
        y = sy;
        current = null;
        lastCtrl = lastQuad = null;
        continue;
      }
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        const nx = num() + ox;
        const ny = num() + oy;
        current = { closed: false, points: [{ x: nx, y: ny }] };
        paths.push(current);
        x = sx = nx;
        y = sy = ny;
        cmd = rel ? 'l' : 'L';
        lastCtrl = lastQuad = null;
        break;
      }
      case 'L':
        start();
        lineTo(num() + ox, num() + oy);
        lastCtrl = lastQuad = null;
        break;
      case 'H':
        start();
        lineTo(num() + ox, y);
        lastCtrl = lastQuad = null;
        break;
      case 'V':
        start();
        lineTo(x, num() + oy);
        lastCtrl = lastQuad = null;
        break;
      case 'C': {
        start();
        const c1 = { x: num() + ox, y: num() + oy };
        const c2 = { x: num() + ox, y: num() + oy };
        const p = { x: num() + ox, y: num() + oy };
        cubicTo(c1, c2, p);
        lastCtrl = c2;
        lastQuad = null;
        break;
      }
      case 'S': {
        start();
        const c1 = lastCtrl ? { x: 2 * x - lastCtrl.x, y: 2 * y - lastCtrl.y } : { x, y };
        const c2 = { x: num() + ox, y: num() + oy };
        const p = { x: num() + ox, y: num() + oy };
        cubicTo(c1, c2, p);
        lastCtrl = c2;
        lastQuad = null;
        break;
      }
      case 'Q':
      case 'T': {
        start();
        const q: Point = cmd.toUpperCase() === 'Q' ? { x: num() + ox, y: num() + oy } : lastQuad ? { x: 2 * x - lastQuad.x, y: 2 * y - lastQuad.y } : { x, y };
        const p = { x: num() + ox, y: num() + oy };
        // Quadratic → cubic: control points at 2/3 of the way to the quadratic control.
        cubicTo({ x: x + ((q.x - x) * 2) / 3, y: y + ((q.y - y) * 2) / 3 }, { x: p.x + ((q.x - p.x) * 2) / 3, y: p.y + ((q.y - p.y) * 2) / 3 }, p);
        lastQuad = q;
        lastCtrl = null;
        break;
      }
      case 'A': {
        start();
        const rx = Math.abs(num());
        const ry = Math.abs(num());
        const rot = num();
        const large = flag();
        const sweep = flag();
        const p = { x: num() + ox, y: num() + oy };
        for (const [c1, c2, e] of arcToCubics(x, y, rx, ry, rot, large, sweep, p.x, p.y)) cubicTo(c1, c2, e);
        lastCtrl = lastQuad = null;
        break;
      }
      default:
        i++;
    }
  }
  return paths.filter((p) => p.points.length > 0);
}

/** Elliptical arc to cubic Béziers (SVG implementation notes, F.6). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, angle: number, large: number, sweep: number, x2: number, y2: number): [Point, Point, Point][] {
  if (rx === 0 || ry === 0) return [[{ x: x1, y: y1 }, { x: x2, y: y2 }, { x: x2, y: y2 }]];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= Math.PI * 2;
  else if (sweep && dt < 0) dt += Math.PI * 2;
  const segments = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: [Point, Point, Point][] = [];
  const pointAt = (t: number) => ({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
  const derivAt = (t: number) => ({ x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos });
  for (let s = 0; s < segments; s++) {
    const a = t1 + s * step;
    const b = a + step;
    const p0 = pointAt(a);
    const p3 = pointAt(b);
    const d0 = derivAt(a);
    const d3 = derivAt(b);
    out.push([{ x: p0.x + k * d0.x, y: p0.y + k * d0.y }, { x: p3.x - k * d3.x, y: p3.y - k * d3.y }, s === segments - 1 ? { x: x2, y: y2 } : p3]);
  }
  return out;
}

// ---------- Styles and transforms ----------

export function parseTransform(s: string | undefined): Matrix {
  let m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const v = (r[2]!.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    let t: Matrix;
    switch (r[1]) {
      case 'matrix':
        t = { a: v[0] ?? 1, b: v[1] ?? 0, c: v[2] ?? 0, d: v[3] ?? 1, e: v[4] ?? 0, f: v[5] ?? 0 };
        break;
      case 'translate':
        t = { a: 1, b: 0, c: 0, d: 1, e: v[0] ?? 0, f: v[1] ?? 0 };
        break;
      case 'scale':
        t = { a: v[0] ?? 1, b: 0, c: 0, d: v[1] ?? v[0] ?? 1, e: 0, f: 0 };
        break;
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const cx = v[1] ?? 0;
        const cy = v[2] ?? 0;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        t = { a: cos, b: sin, c: -sin, d: cos, e: cx - cos * cx + sin * cy, f: cy - sin * cx - cos * cy };
        break;
      }
      case 'skewX':
        t = { a: 1, b: 0, c: Math.tan(((v[0] ?? 0) * Math.PI) / 180), d: 1, e: 0, f: 0 };
        break;
      default:
        t = { a: 1, b: Math.tan(((v[0] ?? 0) * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
    }
    m = multiply(m, t);
  }
  return m;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', silver: '#c0c0c0', navy: '#000080', teal: '#008080', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', maroon: '#800000', olive: '#808000', brown: '#a52a2a',
};

export function parseColor(s: string): Color | null {
  const v = s.trim().toLowerCase();
  const hexv = NAMED[v] ?? v;
  let m = /^#([0-9a-f]{3,8})$/.exec(hexv);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
    const c = (p: string | undefined) => (p?.endsWith('%') ? Number(p.slice(0, -1)) / 100 : Number(p ?? 0) / 255);
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
    return { r: c(parts[0]), g: c(parts[1]), b: c(parts[2]), a };
  }
  return null;
}

type Style = Record<string, string>;
type Box = { x: number; y: number; w: number; h: number };
const INHERITED = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'font-family', 'font-size', 'font-weight', 'font-style', 'visibility', 'stroke-dasharray', 'text-anchor', 'dominant-baseline'];
const PRESENTATION = [...INHERITED, 'opacity', 'display'];

function parseCss(css: string): { selector: string; style: Style }[] {
  const out: { selector: string; style: Style }[] = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css.replace(/\/\*[\s\S]*?\*\//g, '')))) {
    const style = parseStyleAttr(m[2]!);
    for (const sel of m[1]!.split(',')) out.push({ selector: sel.trim(), style });
  }
  return out;
}

function parseStyleAttr(s: string): Style {
  const out: Style = {};
  for (const decl of s.split(';')) {
    const k = decl.indexOf(':');
    if (k > 0) out[decl.slice(0, k).trim()] = decl.slice(k + 1).trim();
  }
  return out;
}

// ---------- Conversion ----------

interface Ctx {
  m: Matrix;
  style: Style;
}

interface Built {
  kind: 'vector' | 'text' | 'group';
  name: string;
  paths?: VectorPath[];
  fills?: Paint[];
  strokes?: Paint[];
  strokeWeight?: number;
  evenodd?: boolean;
  opacity?: number;
  dash?: number[];
  cap?: StrokeCap;
  join?: StrokeJoin;
  text?: { x: number; y: number; characters: string; fontSize: number; fontFamily: string; fontWeight: number; italic: boolean; fill: Paint[]; anchor: string; baseline: string; lineHeight: number | null };
  children?: Built[];
}

class SvgReader {
  readonly ids = new Map<string, XmlNode>();
  readonly rules: { selector: string; style: Style }[] = [];

  constructor(root: XmlNode) {
    const walk = (n: XmlNode) => {
      if (n.attrs.id) this.ids.set(n.attrs.id, n);
      if (n.name === 'style') this.rules.push(...parseCss(n.text));
      n.children.forEach(walk);
    };
    walk(root);
  }

  styleOf(n: XmlNode, parent: Style): Style {
    const s: Style = {};
    for (const k of INHERITED) if (parent[k] !== undefined) s[k] = parent[k]!;
    // Specificity order: presentation attributes < CSS rules (tag, class, id) < style attribute.
    for (const k of PRESENTATION) if (n.attrs[k] !== undefined) s[k] = n.attrs[k]!;
    const classes = (n.attrs.class ?? '').split(/\s+/).filter(Boolean);
    for (const r of this.rules) {
      const sel = r.selector;
      if (sel === n.name || (sel.startsWith('.') && classes.includes(sel.slice(1))) || (sel.startsWith('#') && sel.slice(1) === n.attrs.id) || (sel.includes('.') && sel.split('.')[0] === n.name && classes.includes(sel.split('.')[1]!))) Object.assign(s, r.style);
    }
    if (n.attrs.style) Object.assign(s, parseStyleAttr(n.attrs.style));
    return s;
  }

  paint(value: string | undefined, opacity: string | undefined, bbox: Box, m: Matrix, target: Box = bbox): Paint | null {
    if (!value || value === 'none' || value === 'transparent') return null;
    const op = opacity === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(opacity)));
    const ref = /^url\(\s*#([^)\s]+)\s*\)/.exec(value);
    if (ref) {
      const g = this.ids.get(ref[1]!);
      if (g && (g.name === 'linearGradient' || g.name === 'radialGradient')) return this.gradient(g, bbox, m, op, target);
      return null;
    }
    const c = parseColor(value === 'currentColor' ? '#000' : value);
    return c ? { type: 'SOLID', color: { ...c, a: 1 }, opacity: c.a * op, visible: true } : null;
  }

  /**
   * Gradient end points as fractions of the resulting vector's box (`target`, world space).
   * objectBoundingBox gradients are relative to the shape's own box (`bbox`, before its transform).
   */
  gradient(g: XmlNode, bbox: Box, m: Matrix, opacity: number, target: Box): Paint | null {
    // Inherit stops from xlink:href chains.
    let stopsNode: XmlNode | undefined = g;
    for (let k = 0; k < 5 && stopsNode && stopsNode.children.filter((c) => c.name === 'stop').length === 0; k++) {
      const href: string | undefined = (stopsNode.attrs.href ?? stopsNode.attrs['xlink:href'])?.replace(/^#/, '');
      stopsNode = href ? this.ids.get(href) : undefined;
    }
    const stops = (stopsNode?.children ?? [])
      .filter((c) => c.name === 'stop')
      .map((c) => {
        const st = { ...c.attrs, ...parseStyleAttr(c.attrs.style ?? '') };
        const off = st.offset ?? '0';
        const position = off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off);
        const col = parseColor(st['stop-color'] ?? '#000') ?? rgba(0, 0, 0);
        const so = st['stop-opacity'] === undefined ? 1 : parseFloat(st['stop-opacity']);
        return { position: Math.max(0, Math.min(1, position || 0)), color: { ...col, a: col.a * so } };
      });
    if (stops.length === 0) return null;
    const user = g.attrs.gradientUnits === 'userSpaceOnUse';
    const gt = parseTransform(g.attrs.gradientTransform);
    const num = (v: string | undefined, def: number, size: number) => (v === undefined ? def : v.endsWith('%') ? (parseFloat(v) / 100) * (user ? size : 1) : parseFloat(v));
    const toUnit = (p: Point): Point => {
      const inShape = user ? apply(gt, p) : (() => {
        const q = apply(gt, p);
        return { x: bbox.x + q.x * bbox.w, y: bbox.y + q.y * bbox.h };
      })();
      const world = apply(m, inShape);
      return { x: target.w ? (world.x - target.x) / target.w : 0, y: target.h ? (world.y - target.y) / target.h : 0 };
    };
    if (g.name === 'linearGradient') {
      const from = toUnit({ x: num(g.attrs.x1, 0, bbox.w), y: num(g.attrs.y1, 0, bbox.h) });
      const to = toUnit({ x: num(g.attrs.x2, user ? bbox.w : 1, bbox.w), y: num(g.attrs.y2, 0, bbox.h) });
      return { type: 'GRADIENT_LINEAR', stops, from, to, opacity, visible: true };
    }
    const cx = num(g.attrs.cx, 0.5, bbox.w);
    const cy = num(g.attrs.cy, 0.5, bbox.h);
    const r = num(g.attrs.r, 0.5, Math.hypot(bbox.w, bbox.h) / Math.SQRT2);
    return { type: 'GRADIENT_RADIAL', stops, from: toUnit({ x: cx, y: cy }), to: toUnit({ x: cx + r, y: cy }), opacity, visible: true };
  }

  shapePaths(n: XmlNode): VectorPath[] | null {
    const f = (k: string, def = 0) => (n.attrs[k] === undefined ? def : parseFloat(n.attrs[k]!));
    switch (n.name) {
      case 'path':
        return parsePathData(n.attrs.d ?? '');
      case 'rect': {
        const w = f('width');
        const h = f('height');
        if (w <= 0 || h <= 0) return null;
        const rx = n.attrs.rx !== undefined ? f('rx') : f('ry');
        const p = shapePaths('RECTANGLE', { width: w, height: h, cornerRadius: rx });
        return mapPaths(p, (q) => ({ x: q.x + f('x'), y: q.y + f('y') }));
      }
      case 'circle':
      case 'ellipse': {
        const rx = n.name === 'circle' ? f('r') : f('rx');
        const ry = n.name === 'circle' ? f('r') : f('ry');
        if (rx <= 0 || ry <= 0) return null;
        return mapPaths(shapePaths('ELLIPSE', { width: rx * 2, height: ry * 2 }), (q) => ({ x: q.x + f('cx') - rx, y: q.y + f('cy') - ry }));
      }
      case 'line':
        return [{ closed: false, points: [{ x: f('x1'), y: f('y1') }, { x: f('x2'), y: f('y2') }] }];
      case 'polyline':
      case 'polygon': {
        const v = (n.attrs.points ?? '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
        const points: VectorPoint[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) points.push({ x: v[i]!, y: v[i + 1]! });
        return points.length >= 2 ? [{ closed: n.name === 'polygon', points }] : null;
      }
      default:
        return null;
    }
  }

  convert(n: XmlNode, ctx: Ctx, depth = 0): Built[] {
    if (depth > 64) return [];
    const style = this.styleOf(n, ctx.style);
    if (style.display === 'none' || style.visibility === 'hidden') return [];
    if (['defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'pattern', 'symbol', 'style', 'title', 'desc', 'metadata', 'filter', 'marker'].includes(n.name)) return [];
    const m = multiply(ctx.m, parseTransform(n.attrs.transform));
    const opacity = style.opacity !== undefined ? parseFloat(style.opacity) : 1;
    const name = n.attrs.id ?? n.attrs['inkscape:label'] ?? '';
    if (n.name === 'g' || n.name === 'svg' || n.name === 'a' || n.name === 'switch') {
      let inner = m;
      if (n.name === 'svg' && depth > 0) inner = multiply(m, { a: 1, b: 0, c: 0, d: 1, e: parseFloat(n.attrs.x ?? '0'), f: parseFloat(n.attrs.y ?? '0') });
      const children = n.children.flatMap((c) => this.convert(c, { m: inner, style }, depth + 1));
      if (children.length === 0) return [];
      if (children.length === 1 && n.name !== 'svg' && !name) return children.map((c) => ({ ...c, opacity: (c.opacity ?? 1) * opacity }));
      return [{ kind: 'group', name: name || 'Group', children, opacity }];
    }
    if (n.name === 'use') {
      const target = this.ids.get((n.attrs.href ?? n.attrs['xlink:href'] ?? '').replace(/^#/, ''));
      if (!target) return [];
      const shifted = multiply(m, { a: 1, b: 0, c: 0, d: 1, e: parseFloat(n.attrs.x ?? '0'), f: parseFloat(n.attrs.y ?? '0') });
      const t = target.name === 'symbol' ? { ...target, name: 'g' } : target;
      return this.convert(t, { m: shifted, style }, depth + 1);
    }
    if (n.name === 'text') {
      // Lines written as <tspan>s each with its own y (diagrams wrap their labels so) stay lines.
      const spans = n.children.filter((c) => c.name === 'tspan');
      const ys = spans.map((c) => parseFloat(c.attrs.y ?? 'NaN'));
      const lined = spans.length > 1 && ys.every((v) => Number.isFinite(v)) && new Set(ys).size === spans.length;
      const characters = lined ? spans.map((c) => c.text.replace(/\s+/g, ' ').trim()).join('\n') : (n.text + n.children.map((c) => c.text).join('')).replace(/\s+/g, ' ').trim();
      if (!characters.trim()) return [];
      const firstSpan = spans[0];
      const x = parseFloat(n.attrs.x ?? firstSpan?.attrs.x ?? '0');
      const y = parseFloat(lined ? firstSpan!.attrs.y! : (n.attrs.y ?? firstSpan?.attrs.y ?? '0'));
      const p = apply(m, { x, y });
      const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
      const fontSize = parseFloat(style['font-size'] ?? '16') * scale;
      const fill = this.paint(style.fill ?? '#000', style['fill-opacity'], { x: 0, y: 0, w: 1, h: 1 }, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      const weight = style['font-weight'] === 'bold' ? 700 : parseInt(style['font-weight'] ?? '400', 10) || 400;
      return [
        {
          kind: 'text',
          name: characters.slice(0, 32),
          opacity,
          text: {
            x: p.x,
            y: p.y,
            characters,
            fontSize,
            fontFamily: (style['font-family'] ?? 'Inter').split(',')[0]!.replace(/["']/g, '').trim(),
            fontWeight: weight,
            italic: style['font-style'] === 'italic',
            fill: fill ? [fill] : [],
            anchor: n.attrs['text-anchor'] ?? style['text-anchor'] ?? 'start',
            baseline: n.attrs['dominant-baseline'] ?? n.attrs['alignment-baseline'] ?? style['dominant-baseline'] ?? 'alphabetic',
            lineHeight: lined ? (ys[1]! - ys[0]!) * scale : null,
          },
        },
      ];
    }
    const raw = this.shapePaths(n);
    if (!raw || raw.length === 0) return [];
    const paths = mapPaths(raw, (q) => apply(m, q));
    const local = pathsBounds(raw);
    const bbox = local ? { x: local.x, y: local.y, w: local.width, h: local.height } : { x: 0, y: 0, w: 1, h: 1 };
    const world = pathsBounds(paths);
    const wbox = world ? { x: world.x, y: world.y, w: world.width, h: world.height } : bbox;
    const fillValue = style.fill ?? '#000000';
    const fill = n.name === 'line' || n.name === 'polyline' ? (style.fill && style.fill !== 'none' ? this.paint(style.fill, style['fill-opacity'], bbox, m, wbox) : null) : this.paint(fillValue, style['fill-opacity'], bbox, m, wbox);
    const stroke = this.paint(style.stroke, style['stroke-opacity'], bbox, m, wbox);
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    const dash = (style['stroke-dasharray'] ?? '').match(/[\d.]+/g)?.map((v) => Number(v) * scale) ?? [];
    return [
      {
        kind: 'vector',
        name: name || n.name,
        paths,
        fills: fill ? [fill] : [],
        strokes: stroke ? [stroke] : [],
        strokeWeight: parseFloat(style['stroke-width'] ?? '1') * scale,
        evenodd: style['fill-rule'] === 'evenodd',
        opacity,
        dash,
        cap: style['stroke-linecap'] === 'round' ? 'ROUND' : style['stroke-linecap'] === 'square' ? 'SQUARE' : 'NONE',
        join: style['stroke-linejoin'] === 'round' ? 'ROUND' : style['stroke-linejoin'] === 'bevel' ? 'BEVEL' : 'MITER',
      },
    ];
  }
}



/** Creates layers for an SVG document; returns the created top layer (or null when there was nothing to import). */
export function importSvg(editor: Editor, text: string, at?: Point, fileName?: string): NodeId | null {
  const root = parseXml(text);
  const svg = findSvg(root);
  if (!svg) throw new Error(tr('это не SVG'));
  const reader = new SvgReader(root);
  // viewBox → width/height scaling.
  const vb = (svg.attrs.viewBox ?? '').split(/[\s,]+/).map(Number);
  let base: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (vb.length === 4 && vb.every(Number.isFinite)) {
    const w = parseFloat(svg.attrs.width ?? '') || vb[2]!;
    const h = parseFloat(svg.attrs.height ?? '') || vb[3]!;
    base = { a: w / (vb[2]! || 1), b: 0, c: 0, d: h / (vb[3]! || 1), e: -vb[0]! * (w / (vb[2]! || 1)), f: -vb[1]! * (h / (vb[3]! || 1)) };
  }
  const built = svg.children.flatMap((c) => reader.convert(c, { m: base, style: reader.styleOf(svg, {}) }));
  if (built.length === 0) return null;
  // Place the import's box centre at `at` (or the view centre).
  const box = boundsOf(built);
  const center = at ?? editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
  const dx = Math.round(center.x - (box.x + box.w / 2));
  const dy = Math.round(center.y - (box.y + box.h / 2));
  const parent = editor.containerAt(center);
  const origin = editor.toParentSpace(parent, { x: 0, y: 0 });
  let top: NodeId = '';
  editor.commit(tr('Импорт SVG'), (tx) => {
    const ids = built.map((b) => createBuilt(tx, editor, b, parent, dx + origin.x, dy + origin.y));
    if (ids.length === 1) top = ids[0]!;
    else {
      top = tx.create('GROUP', parent, { name: fileName || 'SVG' });
      for (const id of ids) tx.move(id, top);
    }
    if (ids.length === 1 && fileName && editor.doc.type(top) === 'GROUP') tx.set(top, 'name', fileName);
  }, () => [top]);
  return top;
}

/**
 * Builds an SVG inside an edit already in progress (HTML import): the drawing is
 * scaled into the box `x, y, width × height` of `parent` and grouped under `name`.
 * Returns the layer, or null if the SVG has nothing to draw.
 */
export function buildSvgInto(tx: Transaction, editor: Editor, text: string, parent: NodeId, box: { x: number; y: number; width: number; height: number }, name: string): NodeId | null {
  const root = parseXml(text);
  const svg = findSvg(root);
  if (!svg) return null;
  const reader = new SvgReader(root);
  const vb = (svg.attrs.viewBox ?? '').split(/[\s,]+/).map(Number);
  const vw = vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 ? vb[2]! : parseFloat(svg.attrs.width ?? '') || box.width || 1;
  const vh = vb.length === 4 && vb.every(Number.isFinite) && vb[3]! > 0 ? vb[3]! : parseFloat(svg.attrs.height ?? '') || box.height || 1;
  const ox = vb.length === 4 && vb.every(Number.isFinite) ? vb[0]! : 0;
  const oy = vb.length === 4 && vb.every(Number.isFinite) ? vb[1]! : 0;
  const sx = (box.width || vw) / vw;
  const sy = (box.height || vh) / vh;
  const base: Matrix = { a: sx, b: 0, c: 0, d: sy, e: -ox * sx, f: -oy * sy };
  const built = svg.children.flatMap((c) => reader.convert(c, { m: base, style: reader.styleOf(svg, {}) }));
  if (built.length === 0) return null;
  const group = tx.create('GROUP', parent, { name });
  for (const b of built) createBuilt(tx, editor, b, group, box.x, box.y);
  return group;
}

function findSvg(n: XmlNode): XmlNode | null {
  if (n.name === 'svg' || n.name.endsWith(':svg')) return n;
  for (const c of n.children) {
    const f = findSvg(c);
    if (f) return f;
  }
  return null;
}

function boundsOf(items: Built[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (b: Built) => {
    if (b.paths) {
      const r = pathsBounds(b.paths);
      if (r) {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
      }
    }
    if (b.text) {
      minX = Math.min(minX, b.text.x);
      minY = Math.min(minY, b.text.y - b.text.fontSize);
      maxX = Math.max(maxX, b.text.x + b.text.fontSize * b.text.characters.length * 0.5);
      maxY = Math.max(maxY, b.text.y);
    }
    b.children?.forEach(walk);
  };
  items.forEach(walk);
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 };
}

function createBuilt(tx: Transaction, editor: Editor, b: Built, parent: NodeId, dx: number, dy: number): NodeId {
  const doc = editor.doc;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  if (b.kind === 'group') {
    const g = tx.create('GROUP', parent, { name: b.name, opacity: b.opacity ?? 1 });
    for (const c of b.children ?? []) createBuilt(tx, editor, c, g, dx, dy);
    return g;
  }
  if (b.kind === 'text' && b.text) {
    const t = b.text;
    // SVG text is placed by its baseline (or its middle: dominant-baseline central); ours by the top of the line.
    const line = t.lineHeight ?? t.fontSize * 1.2;
    const middle = /central|middle/.test(t.baseline);
    const top = middle ? t.y - line / 2 : /hanging|text-before-edge/.test(t.baseline) ? t.y : t.y - t.fontSize * 0.8 - (line - t.fontSize * 1.2) / 2;
    // Centred or right-aligned text is anchored at a point: a box wide enough, placed around it.
    const longest = Math.max(...t.characters.split('\n').map((l) => l.length));
    const width = round(Math.max(20, longest * t.fontSize * 0.62 + t.fontSize));
    const anchored = t.anchor === 'middle' || t.anchor === 'end';
    const left = t.anchor === 'middle' ? t.x - width / 2 : t.anchor === 'end' ? t.x - width : t.x;
    return tx.create('TEXT', parent, {
      name: b.name,
      characters: t.characters,
      x: round(left + dx),
      y: round(top + dy),
      ...(anchored ? { width, textAutoResize: 'HEIGHT' as const } : {}),
      ...(t.lineHeight ? { lineHeight: { unit: 'PX' as const, value: round(t.lineHeight) } } : {}),
      fontSize: round(t.fontSize),
      fontFamily: t.fontFamily,
      fontWeight: t.fontWeight,
      italic: t.italic,
      fills: t.fill,
      opacity: b.opacity ?? 1,
      textAlignH: t.anchor === 'middle' ? 'CENTER' : t.anchor === 'end' ? 'RIGHT' : 'LEFT',
    });
  }
  const paths = mapPaths(b.paths ?? [], (p) => ({ x: p.x + dx, y: p.y + dy }));
  const box = pathsBounds(paths) ?? { x: 0, y: 0, width: 0, height: 0 };
  const local = mapPaths(paths, (p) => ({ x: round(p.x - box.x), y: round(p.y - box.y) }));
  const open = paths.every((p) => !p.closed);
  void doc;
  return tx.create('VECTOR', parent, {
    name: b.name,
    x: round(box.x),
    y: round(box.y),
    width: round(box.width),
    height: round(box.height),
    vectorPaths: local,
    fills: open ? [] : (b.fills ?? []),
    strokes: b.strokes ?? [],
    strokeWeight: round(b.strokeWeight ?? 1),
    strokeAlign: 'CENTER',
    windingRule: b.evenodd ? 'EVENODD' : 'NONZERO',
    dashPattern: b.dash ?? [],
    opacity: b.opacity ?? 1,
    strokeCap: b.cap ?? 'NONE',
    strokeJoin: b.join ?? 'MITER',
  });
}

export { solid };
