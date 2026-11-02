// SVG export (stage "Export and import"): our own serializer of the layer tree.
// Shapes, vectors and boolean results become <path>; text becomes <text> with
// one <tspan> per styled fragment placed by our own text layout, so the SVG
// matches the canvas line for line. Gradients, image fills, inside/outside
// strokes, shadows, blur and masks are expressed with SVG primitives.

import { safeLink, tr } from '#core';
import type { Document, Effect, GradientPaint, NodeId, Paint, VectorPath } from '#core';
import { gradientGrid, gradientPixels } from './gradients.ts';
import type { FontFile } from './font-file.ts';
import { capShape, isVariableStroke, multiply, nodeTransform, openEnds, pathsToSvg, shapePaths, sideStrokeRegion, type Matrix, type NetworkPart, type Rect } from '#geometry';
import { dashOf, rectRadii, sideWeights } from './stroke.ts';
import { decorationLookOf, decorationPath, lineOffset, nodePaths, pathTextGlyphs, textStyleOf, vectorDrawing, type DecorationLook, type RunFont, type TextMeasurer } from '#layout';
import { variableStrokeOf } from '#layout';
import type { ImageCache } from './images.ts';
import { needsPicture } from './export.ts';
import type { SceneGraph } from './scene.ts';

export interface SvgOptions {
  /** Embed images as data URIs (true) or leave image fills empty. */
  images?: boolean;
  /** Layer names as id attributes (off by default: a clean SVG for the web). */
  ids?: boolean;
  /** An icon of one colour: that colour becomes currentColor, so CSS can recolour it. */
  currentColor?: boolean;
  /** No width/height, only viewBox: the image fills whatever holds it. */
  responsive?: boolean;
  /**
   * Text as outlines: the font file of a text's font (loaded beforehand), or
   * null — that text stays text. Each letter becomes a path where the canvas puts it.
   */
  outlines?: (font: RunFont) => FontFile | null;
  /**
   * A layer SVG cannot express (a warp, glass, a pattern… — `needsPicture`) as a picture:
   * a PNG data URL and where it lies in the layer's own space (see `layerPicture`).
   */
  picture?: (id: NodeId) => { href: string; x: number; y: number; width: number; height: number } | null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 1000) / 1000);
const hex = (c: { r: number; g: number; b: number }) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
/** The shortest transform attribute: none, a shift, or a full matrix. */
const transformAttr = (m: Matrix) =>
  m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 ? (Math.abs(m.e) < 1e-6 && Math.abs(m.f) < 1e-6 ? '' : `transform="translate(${n(m.e)} ${n(m.f)})"`) : `transform="${matrix(m)}"`;
const matrix = (m: Matrix) => `matrix(${n(m.a)} ${n(m.b)} ${n(m.c)} ${n(m.d)} ${n(m.e)} ${n(m.f)})`;

const BLEND_CSS: Record<string, string> = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
  PLUS_DARKER: 'plus-darker',
  PLUS_LIGHTER: 'plus-lighter',
};

class SvgWriter {
  readonly defs: string[] = [];
  private counter = 0;
  /** Things the format cannot express; reported to the user. */
  readonly skipped = new Set<string>();
  readonly doc: Document;
  readonly measurer: TextMeasurer;
  readonly images: ImageCache | null;
  readonly options: SvgOptions;

  constructor(doc: Document, measurer: TextMeasurer, images: ImageCache | null, options: SvgOptions) {
    this.doc = doc;
    this.measurer = measurer;
    this.images = images;
    this.options = options;
  }

  id(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  /** `fill` attribute for one paint (gradients and images go to <defs>). */
  paint(p: Paint, w: number, h: number, kind: 'fill' | 'stroke'): string {
    if (p.type === 'SOLID') {
      const a = p.color.a * p.opacity;
      return `${kind}="${hex(p.color)}"${a < 1 ? ` ${kind}-opacity="${n(a)}"` : ''}`;
    }
    // A pattern lives only in the layer's picture (needsPicture).
    if (p.type === 'PATTERN') return `${kind}="none"`;
    if (p.type === 'IMAGE') {
      const blob = this.doc.store.blobs.get(p.imageHash);
      if (!blob || this.options.images === false) return `${kind}="none"`;
      const id = this.id('img');
      const href = `data:${blob.mime};base64,${blob.data}`;
      if (p.scaleMode === 'TILE') {
        const size = this.images?.size(p.imageHash) ?? { width: w, height: h };
        const tw = size.width * p.scale;
        const th = size.height * p.scale;
        this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(tw)}" height="${n(th)}"><image href="${href}" width="${n(tw)}" height="${n(th)}" preserveAspectRatio="none"/></pattern>`);
      } else {
        const par = p.scaleMode === 'FILL' ? 'xMidYMid slice' : p.scaleMode === 'FIT' ? 'xMidYMid meet' : 'none';
        this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(w)}" height="${n(h)}"><image href="${href}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="${par}"/></pattern>`);
      }
      return `${kind}="url(#${id})"${p.opacity < 1 ? ` ${kind}-opacity="${n(p.opacity)}"` : ''}`;
    }
    // Angular and diamond: SVG has no such gradient — a picture of it (the radial one when there is no canvas to draw it).
    if (p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
      const href = gradientPng(p, w, h);
      if (href) {
        const id = this.id('img');
        this.defs.push(`<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(w)}" height="${n(h)}"><image href="${href}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/></pattern>`);
        return `${kind}="url(#${id})"`;
      }
    }
    const id = this.id('grad');
    const stops = [...p.stops]
      .sort((a, b) => a.position - b.position)
      .map((s) => `<stop offset="${n(s.position)}" stop-color="${hex(s.color)}"${s.color.a < 1 ? ` stop-opacity="${n(s.color.a)}"` : ''}/>`)
      .join('');
    const fx = p.from.x * w;
    const fy = p.from.y * h;
    const tx = p.to.x * w;
    const ty = p.to.y * h;
    if (p.type === 'GRADIENT_LINEAR') this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(fx)}" y1="${n(fy)}" x2="${n(tx)}" y2="${n(ty)}">${stops}</linearGradient>`);
    else this.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${n(fx)}" cy="${n(fy)}" r="${n(Math.hypot(tx - fx, ty - fy))}">${stops}</radialGradient>`);
    return `${kind}="url(#${id})"${p.opacity < 1 ? ` ${kind}-opacity="${n(p.opacity)}"` : ''}`;
  }

  /** Filter for shadows and blurs; empty when there are none. */
  filter(effects: readonly Effect[], id: NodeId): string {
    const visible = effects.filter((e) => e.visible);
    if (visible.length === 0) return '';
    const parts: string[] = [];
    const layers: string[] = [];
    const inner: string[] = [];
    visible.forEach((e, i) => {
      if (e.type === 'DROP_SHADOW') {
        const spread = e.spread > 0 ? `<feMorphology in="SourceAlpha" operator="dilate" radius="${n(e.spread)}" result="sp${i}"/>` : '';
        parts.push(
          `${spread}<feOffset in="${e.spread > 0 ? `sp${i}` : 'SourceAlpha'}" dx="${n(e.offset.x)}" dy="${n(e.offset.y)}" result="o${i}"/><feGaussianBlur in="o${i}" stdDeviation="${n(e.radius / 2)}" result="b${i}"/><feFlood flood-color="${hex(e.color)}" flood-opacity="${n(e.color.a)}"/><feComposite in2="b${i}" operator="in" result="s${i}"/>`,
        );
        layers.push(`s${i}`);
      } else if (e.type === 'INNER_SHADOW') {
        // Inverted alpha, offset and blurred, kept only inside the shape.
        parts.push(
          `<feComponentTransfer in="SourceAlpha" result="inv${i}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer><feOffset in="inv${i}" dx="${n(e.offset.x)}" dy="${n(e.offset.y)}" result="io${i}"/><feGaussianBlur in="io${i}" stdDeviation="${n(e.radius / 2)}" result="ib${i}"/><feFlood flood-color="${hex(e.color)}" flood-opacity="${n(e.color.a)}"/><feComposite in2="ib${i}" operator="in" result="ic${i}"/><feComposite in="ic${i}" in2="SourceAlpha" operator="in" result="is${i}"/>`,
        );
        inner.push(`is${i}`);
      } else if (e.type === 'LAYER_BLUR') {
        // SVG filters cannot vary along the layer: a progressive blur goes out even.
        parts.push(`<feGaussianBlur in="SourceGraphic" stdDeviation="${n(e.radius / 2)}" result="lb"/>`);
      } else {
        this.skipped.add(e.type === 'BACKGROUND_BLUR' ? tr('размытие фона') : tr('шум'));
      }
    });
    if (parts.length === 0) return '';
    const fid = this.id('fx');
    const source = parts.some((p) => p.includes('result="lb"')) ? 'lb' : 'SourceGraphic';
    this.defs.push(
      `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${parts.join('')}<feMerge>${layers.map((l) => `<feMergeNode in="${l}"/>`).join('')}<feMergeNode in="${source}"/>${inner.map((l) => `<feMergeNode in="${l}"/>`).join('')}</feMerge></filter>`,
    );
    void id;
    return ` filter="url(#${fid})"`;
  }

  /** A shape: one <path> per paint (SVG has a single fill per element), then strokes. */
  /** A vector's contours; a board shape's open ones are details, stroked as lines and not filled (as on the canvas). */
  private vectorShape(id: NodeId, w: number, h: number, rule: 'nonzero' | 'evenodd'): string {
    const all = nodePaths(this.doc, id);
    if (this.doc.get(id, 'board')?.kind !== 'SHAPE_OUTLINE' || all.every((p) => p.closed)) return this.shape(id, all, w, h, rule);
    return this.shape(id, all.filter((p) => p.closed), w, h, rule) + this.shape(id, all.filter((p) => !p.closed), w, h, rule, true);
  }

  shape(id: NodeId, paths: VectorPath[], w: number, h: number, rule: 'nonzero' | 'evenodd', forceCenter = false, strokePaths: VectorPath[] = paths, parts: readonly NetworkPart[] = []): string {
    const d = this.doc;
    const data = pathsToSvg(paths);
    const strokeData = strokePaths === paths ? data : pathsToSvg(strokePaths);
    if (!data && !strokeData) return '';
    const out: string[] = [];
    const closed = paths.some((p) => p.closed);
    if (closed) {
      for (const p of d.get(id, 'fills')) if (p.visible) out.push(`<path d="${data}" ${this.paint(p, w, h, 'fill')}${rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/>`);
    }
    // Regions of a vector network with paints of their own.
    for (const part of parts) {
      const partData = pathsToSvg(part.fill);
      for (const p of part.fills) if (p.visible) out.push(`<path d="${partData}" ${this.paint(p, w, h, 'fill')}${part.evenOdd ? ' fill-rule="evenodd"' : ''}/>`);
    }
    const strokes = d.get(id, 'strokes').filter((p) => p.visible);
    const weight = d.get(id, 'strokeWeight');
    const sides = forceCenter ? null : sideWeights(d, id);
    if (strokes.length > 0 && weight > 0 && isVariableStroke(d.get(id, 'strokeProfile'), d.get(id, 'brush'))) {
      // A width profile or a brush: the stroke's own shape, filled (a brush's grain stays on the canvas).
      const shape = pathsToSvg(variableStrokeOf(d, id));
      for (const p of strokes) out.push(`<path d="${shape}" ${this.paint(p, w, h, 'fill')}/>`);
    } else if (strokes.length > 0 && sides && Math.max(...sides) > 0) {
      // Per-side weights: the stroke is the area between two contours (FR-DRW-060).
      const region = pathsToSvg(sideStrokeRegion(w, h, rectRadii(d, id, w, h), sides, d.get(id, 'strokeAlign')));
      for (const p of strokes) out.push(`<path d="${region}" fill-rule="evenodd" ${this.paint(p, w, h, 'fill')}/>`);
    } else if (strokes.length > 0 && weight > 0) {
      const align = forceCenter || !closed ? 'CENTER' : d.get(id, 'strokeAlign');
      const dash = dashOf(d, id);
      const cap = d.get(id, 'strokeCap');
      const join = d.get(id, 'strokeJoin');
      const dashAttr =
        (dash.length > 0 ? ` stroke-dasharray="${dash.map(n).join(' ')}"` : '') +
        (cap !== 'NONE' ? ` stroke-linecap="${cap === 'ROUND' ? 'round' : 'square'}"` : '') +
        (join !== 'MITER' ? ` stroke-linejoin="${join === 'ROUND' ? 'round' : 'bevel'}"` : ` stroke-miterlimit="${n(d.get(id, 'strokeMiterLimit'))}"`);
      const width = align === 'CENTER' ? weight : weight * 2;
      let wrapOpen = '';
      let wrapClose = '';
      if (align === 'INSIDE') {
        const cid = this.id('clip');
        this.defs.push(`<clipPath id="${cid}"><path d="${data}"/></clipPath>`);
        wrapOpen = `<g clip-path="url(#${cid})">`;
        wrapClose = '</g>';
      } else if (align === 'OUTSIDE') {
        const mid = this.id('mask');
        const pad = weight * 2 + 2;
        this.defs.push(`<mask id="${mid}" maskUnits="userSpaceOnUse" x="${n(-pad)}" y="${n(-pad)}" width="${n(w + pad * 2)}" height="${n(h + pad * 2)}"><rect x="${n(-pad)}" y="${n(-pad)}" width="${n(w + pad * 2)}" height="${n(h + pad * 2)}" fill="white"/><path d="${data}" fill="black"/></mask>`);
        wrapOpen = `<g mask="url(#${mid})">`;
        wrapClose = '</g>';
      }
      out.push(wrapOpen + strokes.map((p) => `<path d="${strokeData}" fill="none" ${this.paint(p, w, h, 'stroke')} stroke-width="${n(width)}"${dashAttr}/>`).join('') + wrapClose);
    }
    // Line ends of lines and open vectors (FR-DRW-062).
    const start = d.get(id, 'startCap');
    const end = d.get(id, 'endCap');
    if (strokes.length > 0 && weight > 0 && (start !== 'NONE' || end !== 'NONE')) {
      for (const e of openEnds(strokePaths)) {
        for (const [cap, at] of [
          [start, e.start],
          [end, e.end],
        ] as const) {
          const shape = capShape(cap, at.p, at.angle, weight);
          if (!shape) continue;
          const cd = pathsToSvg(shape.paths);
          for (const p of strokes) {
            out.push(shape.filled ? `<path d="${cd}" ${this.paint(p, w, 1, 'fill')}/>` : `<path d="${cd}" fill="none" ${this.paint(p, w, 1, 'stroke')} stroke-width="${n(weight)}" stroke-linecap="round" stroke-linejoin="round"/>`);
          }
        }
      }
    }
    return out.join('');
  }

  text(id: NodeId): string {
    const d = this.doc;
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const path = d.get(id, 'textPath');
    if (path) return this.pathText(id, path, w, h);
    const style = textStyleOf(d, id);
    const autoWidth = d.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT';
    const { layout } = this.measurer.measure(style, autoWidth ? null : w);
    const valign = d.get(id, 'textAlignV');
    const align = d.get(id, 'textAlignH');
    const top = valign === 'CENTER' ? (h - layout.height) / 2 : valign === 'BOTTOM' ? h - layout.height : 0;
    const spans: string[] = [];
    const shapes: string[] = [];
    // A styled underline (wavy, dotted, its own thickness or offset) is drawn as a shape: SVG viewers do not know these.
    const look = decorationLookOf(d, id);
    const custom = look.style !== 'SOLID' || look.thickness !== null || look.offset !== null;
    const nodeFill = d.get(id, 'fills').find((f) => f.visible);
    const fillAttr = (fills: Paint[] | null) => {
      const p = (fills ?? []).find((f) => f.visible) ?? nodeFill;
      return p ? this.paint(p, w, h, 'fill') : 'fill="none"';
    };
    for (const line of layout.lines) {
      const offset = lineOffset(line, w, align);
      const baseline = top + line.y + line.baseline;
      if (line.marker && line.markerFont) {
        spans.push(`<tspan x="${n(line.markerX ?? 0)}" y="${n(baseline)}" font-family="${esc(line.markerFont.fontFamily)}" font-size="${n(line.markerFont.fontSize)}" font-weight="${line.markerFont.fontWeight}" ${fillAttr(null)}>${esc(line.marker)}</tspan>`);
      }
      for (const f of line.fragments) {
        if (f.text.length === 0) continue;
        const ls = f.font.letterSpacing.unit === 'PX' ? f.font.letterSpacing.value : (f.font.fontSize * f.font.letterSpacing.value) / 100;
        const deco = custom ? '' : f.style.textDecoration === 'UNDERLINE' ? ' text-decoration="underline"' : f.style.textDecoration === 'STRIKETHROUGH' ? ' text-decoration="line-through"' : '';
        const x = line.x + offset + f.x;
        if (custom && f.style.textDecoration !== 'NONE') {
          const visible = f.text.replace(/\s+$/, '');
          const dw = visible.length === f.text.length ? f.width : this.measurer.width(visible, f.font);
          shapes.push(`<path d="${decorationPath(f.style.textDecoration, x, baseline + f.shift, dw, f.font.fontSize, look)}" ${fillAttr(f.style.fills)}/>`);
        }
        // Right to left stays text (outlines here put letters left to right, unjoined); its x is the right edge.
        const outlined = line.rtl ? null : this.outlined(f.text, f.font, x, baseline + f.shift, fillAttr(f.style.fills), f.style.textDecoration, f.width, look);
        if (outlined !== null) {
          shapes.push(outlined);
          continue;
        }
        // OpenType features and axes go as CSS (an SVG viewer with the font shows them).
        const css = [f.font.features ? `font-feature-settings:${f.font.features}` : '', f.font.variations ? `font-variation-settings:${f.font.variations}` : ''].filter(Boolean).join(';');
        const span = `<tspan x="${n(line.rtl ? x + f.width : x)}"${line.rtl ? ' direction="rtl"' : ''} y="${n(baseline + f.shift)}" font-family="${esc(f.font.fontFamily)}" font-size="${n(f.font.fontSize)}" font-weight="${f.font.fontWeight}"${f.font.italic ? ' font-style="italic"' : ''}${ls ? ` letter-spacing="${n(ls)}"` : ''}${css ? ` style="${esc(css)}"` : ''}${deco} ${fillAttr(f.style.fills)}>${esc(f.text)}</tspan>`;
        // A hyperlink stays clickable in the SVG (only web, mail and phone links reach here).
        const link = f.style.link && safeLink(f.style.link);
        spans.push(link ? `<a href="${esc(link)}">${span}</a>` : span);
      }
    }
    const text = spans.length ? `<text xml:space="preserve">${spans.join('')}</text>` : '';
    return shapes.join('') + text;
  }

  /** Text on a path: each letter where the canvas puts it, turned along the line (outlines when asked). */
  private pathText(id: NodeId, path: VectorPath[], w: number, h: number): string {
    const d = this.doc;
    const layout = this.measurer.measure(textStyleOf(d, id), null).layout;
    const nodeFill = d.get(id, 'fills').find((f) => f.visible);
    const out: string[] = [];
    for (const g of pathTextGlyphs(layout, path, d.get(id, 'textPathOffset'), d.get(id, 'textAlignH'), this.measurer)) {
      const p = (g.fragment.style.fills ?? []).find((f) => f.visible) ?? nodeFill;
      if (!p) continue;
      const fill = this.paint(p, w, h, 'fill');
      const turn = `translate(${n(g.x)} ${n(g.y)}) rotate(${n((g.angle * 180) / Math.PI)})`;
      const outlined = this.outlined(g.text, g.font, 0, g.fragment.shift, fill);
      if (outlined !== null) {
        out.push(`<g transform="${turn}">${outlined}</g>`);
        continue;
      }
      const css = [g.font.features ? `font-feature-settings:${g.font.features}` : '', g.font.variations ? `font-variation-settings:${g.font.variations}` : ''].filter(Boolean).join(';');
      out.push(`<text transform="${turn}" y="${n(g.fragment.shift)}" font-family="${esc(g.font.fontFamily)}" font-size="${n(g.font.fontSize)}" font-weight="${g.font.fontWeight}"${g.font.italic ? ' font-style="italic"' : ''}${css ? ` style="${esc(css)}"` : ''} ${fill}>${esc(g.text)}</text>`);
    }
    return out.join('');
  }

  /**
   * A run of text as letter outlines from its font file, each where the canvas
   * draws it (positions measured the same way); null — no font file, or a
   * character the font does not have (then the run stays text).
   */
  private outlined(text: string, font: RunFont, x: number, y: number, fill: string, decoration: string = 'NONE', width = 0, look?: DecorationLook): string | null {
    const file = this.options.outlines?.(font);
    if (!file) return null;
    const axes: Record<string, number> = {};
    if (file.info.axes.some((a) => a.tag === 'wght')) axes.wght = font.fontWeight;
  // Optical size follows the font size, as browsers do (font-optical-sizing: auto).
  const opsz = file.info.axes.find((a) => a.tag === 'opsz');
  if (opsz) axes.opsz = Math.min(opsz.max, Math.max(opsz.min, font.fontSize));
    for (const m of (font.variations ?? '').matchAll(/"(\w{4})"\s+(-?[\d.]+)/g)) axes[m[1]!] = Number(m[2]);
    const k = font.fontSize / file.info.unitsPerEm;
    const parts: string[] = [];
    let prefix = '';
    // Where the canvas puts a letter: after the text before it, kerned with it (and its letter spacing).
    for (const ch of text) {
      const at = x + (prefix ? this.measurer.width(prefix + ch, font) - this.measurer.width(ch, font) : 0);
      prefix += ch;
      if (/\s/.test(ch)) continue;
      const cp = ch.codePointAt(0)!;
      if (file.glyphId(cp) === 0) return null;
      const g = file.outline(cp, axes);
      if (!g) return null;
      if (g.path) parts.push(`<path transform="translate(${n(at)} ${n(y)}) scale(${n(k)} ${n(-k)})" d="${g.path}"/>`);
    }
    // Underline and strikethrough as the canvas draws them.
    if (decoration === 'UNDERLINE' || decoration === 'STRIKETHROUGH') {
      const visible = text.replace(/\s+$/, '');
      const w = visible.length === text.length ? width : this.measurer.width(visible, font);
      parts.push(`<path d="${decorationPath(decoration, x, y, w, font.fontSize, look)}"/>`);
    }
    return parts.length ? `<g ${fill}>${parts.join('')}</g>` : '';
  }

  /** Children in order, with masks (a mask layer hides itself and clips the siblings above it). */
  children(parent: NodeId): string {
    const d = this.doc;
    const kids = d.paintChildren(parent);
    let out = '';
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!;
      if (!d.get(c, 'isMask') || !d.get(c, 'visible')) {
        out += this.node(c);
        continue;
      }
      let masked = '';
      while (i + 1 < kids.length && !d.get(kids[i + 1]!, 'isMask')) masked += this.node(kids[++i]!);
      const mid = this.id('mask');
      this.defs.push(`<mask id="${mid}" style="mask-type:alpha">${this.node(c)}</mask>`);
      out += `<g mask="url(#${mid})">${masked}</g>`;
    }
    return out;
  }

  node(id: NodeId): string {
    const d = this.doc;
    if (!d.get(id, 'visible')) return '';
    const type = d.type(id);
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const m = nodeTransform(d.get(id, 'x'), d.get(id, 'y'), d.get(id, 'rotation'));
    const opacity = d.get(id, 'opacity');
    const blend = BLEND_CSS[d.get(id, 'blendMode')];
    if (needsPicture(d, id)) {
      // SVG cannot express it (a warp, glass, a pattern…): the layer's picture, as on the canvas.
      const pic = this.options.picture?.(id) ?? null;
      if (pic) {
        const at = [transformAttr(m), blend ? `style="mix-blend-mode:${blend}"` : ''].filter(Boolean).join(' ');
        const image = `<image href="${pic.href}" x="${n(pic.x)}" y="${n(pic.y)}" width="${n(pic.width)}" height="${n(pic.height)}" preserveAspectRatio="none"/>`;
        return at ? `<g ${at}>${image}</g>` : image;
      }
      this.skipped.add(tr('сложные эффекты слоя'));
    }
    const attrs = `${transformAttr(m)}${opacity < 1 ? ` opacity="${n(opacity)}"` : ''}${blend ? ` style="mix-blend-mode:${blend}"` : ''}${this.filter(d.get(id, 'effects'), id)}`;
    let body = '';
    switch (type) {
      case 'SECTION':
      case 'FRAME':
      case 'COMPONENT':
      case 'COMPONENT_SET':
      case 'INSTANCE': {
        const paths = shapePaths('RECTANGLE', { width: w, height: h, cornerRadius: d.get(id, 'cornerRadius'), cornerRadii: d.get(id, 'cornerRadii') });
        const own = this.shape(id, paths, w, h, 'nonzero');
        let kids = this.children(id);
        if (d.get(id, 'clipsContent') && kids) {
          const cid = this.id('clip');
          this.defs.push(`<clipPath id="${cid}"><path d="${pathsToSvg(paths)}"/></clipPath>`);
          kids = `<g clip-path="url(#${cid})">${kids}</g>`;
        }
        body = own + kids;
        break;
      }
      case 'GROUP':
        body = this.children(id);
        break;
      case 'TEXT':
        body = this.text(id);
        break;
      case 'LINE':
        body = this.shape(id, nodePaths(d, id), w, h, 'nonzero', true);
        break;
      default: {
        const drawing = vectorDrawing(d, id);
        body = drawing
          ? this.shape(id, drawing.fill, w, h, drawing.evenOdd ? 'evenodd' : 'nonzero', drawing.strokeCentered, drawing.stroke, drawing.parts)
          : this.vectorShape(id, w, h, type === 'VECTOR' && d.get(id, 'windingRule') === 'EVENODD' ? 'evenodd' : 'nonzero');
      }
    }
    if (!body) return '';
    const idAttr = this.options.ids ? `id="${esc(d.get(id, 'name').replace(/\s+/g, '_')).slice(0, 60)}"` : '';
    const all = [idAttr, attrs.trim()].filter(Boolean).join(' ');
    // A group that changes nothing is left out.
    return all ? `<g ${all}>${body}</g>` : body;
  }
}

/**
 * Serialises nodes as one SVG document sized to their render bounds. Returns the
 * markup and the list of effects that SVG could not express.
 */
export function exportSvg(scene: SceneGraph, measurer: TextMeasurer, ids: readonly NodeId[], images: ImageCache | null = null, options: SvgOptions = {}): { svg: string; skipped: string[] } {
  scene.ensure();
  const doc = scene.doc;
  const bounds = ids.map((id) => scene.renderBounds(id)).reduce<Rect | null>((u, b) => (u ? { x: Math.min(u.x, b.x), y: Math.min(u.y, b.y), width: Math.max(u.x + u.width, b.x + b.width) - Math.min(u.x, b.x), height: Math.max(u.y + u.height, b.y + b.height) - Math.min(u.y, b.y) } : b), null) ?? { x: 0, y: 0, width: 0, height: 0 };
  const writer = new SvgWriter(doc, measurer, images, options);
  let body = '';
  for (const id of ids) {
    // Place each node in world space through its parent's transform.
    const parent = doc.parent(id);
    const parentWorld = parent && doc.type(parent) !== 'PAGE' ? scene.world(parent) : null;
    const content = writer.node(id);
    const shift = parentWorld ? transformAttr(parentWorld) : '';
    body += shift ? `<g ${shift}>${content}</g>` : content;
  }
  const w = Math.max(1, Math.ceil(bounds.width));
  const h = Math.max(1, Math.ceil(bounds.height));
  // Fonts kept in the file travel inside the SVG, so it looks the same on a computer without them.
  const fonts = ((doc.get(doc.rootId, 'embeddedFonts') ?? []) as { family: string; weight: number; italic: boolean; hash: string }[])
    .filter((f) => body.includes(`font-family="${esc(f.family)}"`))
    .map((f) => {
      const blob = doc.store.blobs.get(f.hash);
      return blob ? `@font-face{font-family:"${esc(f.family)}";src:url(data:${blob.mime};base64,${blob.data});font-weight:${f.weight === 0 ? '1 1000' : f.weight};font-style:${f.italic ? 'italic' : 'normal'}}` : '';
    })
    .join('');
  if (fonts) writer.defs.unshift(`<style>${fonts}</style>`);
  // One colour throughout (an icon): it becomes currentColor when asked.
  if (options.currentColor) {
    const colours = new Set([...body.matchAll(/(?:fill|stroke)="(#[0-9a-f]{6})"/g)].map((m) => m[1]));
    if (colours.size === 1 && writer.defs.length === 0) body = body.replace(/((?:fill|stroke)=")#[0-9a-f]{6}"/g, '$1currentColor"');
  }
  const size = options.responsive ? '' : ` width="${w}" height="${h}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"${size} viewBox="${n(bounds.x)} ${n(bounds.y)} ${w} ${h}" fill="none">${writer.defs.length ? `<defs>${writer.defs.join('')}</defs>` : ''}${body}</svg>`;
  void multiply;
  return { svg, skipped: [...writer.skipped] };
}

/** A PNG (data URL) of an angular or diamond gradient over w × h; null without a canvas (outside a browser). */
function gradientPng(p: GradientPaint, w: number, h: number): string | null {
  if (typeof document === 'undefined') return null;
  const { cols, rows } = gradientGrid(w, h, 512);
  const canvas = Object.assign(document.createElement('canvas'), { width: cols, height: rows });
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(new ImageData(gradientPixels(p, w, h, cols, rows), cols, rows), 0, 0);
  return canvas.toDataURL('image/png');
}
