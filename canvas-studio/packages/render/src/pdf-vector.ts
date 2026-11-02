// Vector PDF export (stage "Export and import").
//
// Shapes, vectors, boolean results, solid and gradient fills, strokes, clipping
// frames and image fills are written as real PDF drawing operators, so they stay
// sharp at any zoom and can be edited in vector tools. Text is drawn exactly as
// on the canvas (a high-resolution image of the text layer) with an invisible,
// selectable and searchable text layer on top (Unicode, Cyrillic included).
// Layers whose look PDF cannot express — shadows, blurs, noise, masks and blend
// modes — are embedded as high-resolution images of the layer.

import { safeLink, type Document, type GradientPaint, type NodeId, type Paint, type VectorPath } from '#core';
import { gradientGrid, gradientPixels } from './gradients.ts';
import { apply, capShape, invert, isVariableStroke, multiply, nodeTransform, openEnds, shapePaths, sideStrokeRegion, type Matrix } from '#geometry';
import { dashOf, rectRadii, sideWeights } from './stroke.ts';
import { lineOffset, nodePaths, textStyleOf, vectorDrawing, type TextMeasurer } from '#layout';
import { variableStrokeOf } from '#layout';
import type { Canvas2DRenderer } from './canvas-renderer.ts';
import { needsPicture, rasterize } from './export.ts';
import { deflate, PdfWriter } from './pdf.ts';
import type { SceneGraph } from './scene.ts';

const n = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};
const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

interface PageResources {
  ext: Map<string, string>;
  shadings: Map<string, number>;
  images: Map<string, number>;
  fonts: Map<string, number>;
}

class PageWriter {
  readonly ops: string[] = [];
  readonly res: PageResources = { ext: new Map(), shadings: new Map(), images: new Map(), fonts: new Map() };
  private counter = 0;
  /** Current transform: our drawing space (y down, world units) at this point of the stream. */
  m: Matrix = IDENTITY;
  /** Clickable areas of hyperlinks in texts, in page coordinates. */
  readonly links: { rect: [number, number, number, number]; url: string }[] = [];
  /** The page's world space (after the y flip): where pictures of layers are placed. */
  base: Matrix = IDENTITY;
  readonly pdf: PdfWriter;
  readonly doc: Document;
  readonly scene: SceneGraph;
  readonly renderer: Canvas2DRenderer;
  readonly measurer: TextMeasurer;
  readonly scale: number;
  readonly font: () => number;
  readonly pending: Promise<void>[] = [];

  constructor(pdf: PdfWriter, scene: SceneGraph, renderer: Canvas2DRenderer, measurer: TextMeasurer, scale: number, font: () => number) {
    this.pdf = pdf;
    this.doc = scene.doc;
    this.scene = scene;
    this.renderer = renderer;
    this.measurer = measurer;
    this.scale = scale;
    this.font = font;
  }

  name(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  push(op: string): void {
    this.ops.push(op);
  }

  transform(m: Matrix): void {
    this.push(`${n(m.a)} ${n(m.b)} ${n(m.c)} ${n(m.d)} ${n(m.e)} ${n(m.f)} cm`);
    this.m = multiply(this.m, m);
  }

  save(): Matrix {
    this.push('q');
    return this.m;
  }

  restore(m: Matrix): void {
    this.push('Q');
    this.m = m;
  }

  /** Graphics state with fill/stroke alpha. */
  alpha(a: number): void {
    if (a >= 0.999) return;
    const key = n(a);
    let name = this.res.ext.get(key);
    if (!name) {
      name = this.name('GS');
      this.res.ext.set(key, name);
    }
    this.push(`/${name} gs`);
  }

  path(paths: readonly VectorPath[]): boolean {
    let any = false;
    for (const contour of paths) {
      const pts = contour.points;
      if (pts.length === 0) continue;
      any = true;
      this.push(`${n(pts[0]!.x)} ${n(pts[0]!.y)} m`);
      const count = contour.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < count; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        if (!a.out && !b.in) this.push(`${n(b.x)} ${n(b.y)} l`);
        else {
          const c1 = a.out ?? a;
          const c2 = b.in ?? b;
          this.push(`${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(b.x)} ${n(b.y)} c`);
        }
      }
      if (contour.closed) this.push('h');
    }
    return any;
  }

  /** Axial or radial shading for a gradient paint (in the current space). */
  shading(p: GradientPaint, w: number, h: number): string {
    if (p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') return this.sampledShading(p, w, h);
    const stops = [...p.stops].sort((a, b) => a.position - b.position);
    const c = (s: (typeof stops)[number]) => `[${n(s.color.r)} ${n(s.color.g)} ${n(s.color.b)}]`;
    let fn: string;
    if (stops.length === 1) fn = `<< /FunctionType 2 /Domain [0 1] /C0 ${c(stops[0]!)} /C1 ${c(stops[0]!)} /N 1 >>`;
    else {
      const parts = stops.slice(1).map((s, i) => `<< /FunctionType 2 /Domain [0 1] /C0 ${c(stops[i]!)} /C1 ${c(s)} /N 1 >>`);
      const bounds = stops.slice(1, -1).map((s) => n(Math.min(1, Math.max(0, s.position))));
      const first = Math.max(0, stops[0]!.position);
      const last = Math.min(1, stops[stops.length - 1]!.position);
      fn = `<< /FunctionType 3 /Domain [${n(first)} ${n(Math.max(first + 1e-6, last))}] /Functions [${parts.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${parts.map(() => '0 1').join(' ')}] >>`;
    }
    const fx = p.from.x * w;
    const fy = p.from.y * h;
    const tx = p.to.x * w;
    const ty = p.to.y * h;
    // Stops at 0 and 1 map to the gradient's ends; positions inside are linear along the axis.
    const first = Math.max(0, stops[0]!.position);
    const last = Math.min(1, stops[stops.length - 1]!.position);
    const coords =
      p.type === 'GRADIENT_LINEAR'
        ? `/ShadingType 2 /Coords [${n(fx)} ${n(fy)} ${n(tx)} ${n(ty)}] /Domain [${n(first)} ${n(Math.max(first + 1e-6, last))}]`
        : `/ShadingType 3 /Coords [${n(fx)} ${n(fy)} 0 ${n(fx)} ${n(fy)} ${n(Math.hypot(tx - fx, ty - fy))}] /Domain [${n(first)} ${n(Math.max(first + 1e-6, last))}]`;
    const ref = this.pdf.add(`<< ${coords} /ColorSpace /DeviceRGB /Function ${fn} /Extend [true true] >>`);
    const name = this.name('Sh');
    this.res.shadings.set(name, ref);
    return name;
  }

  /**
   * Angular and diamond gradients: PDF has no such shading, so a function-based
   * one (type 1) reads the colour from a grid of samples over the layer's box.
   */
  private sampledShading(p: GradientPaint, w: number, h: number): string {
    const { cols, rows } = gradientGrid(w, h, 128);
    const rgba = gradientPixels(p, w, h, cols, rows);
    const rgb = new Uint8Array(cols * rows * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i]!;
      rgb[j + 1] = rgba[i + 1]!;
      rgb[j + 2] = rgba[i + 2]!;
    }
    // Samples sit at the centres of the cells: the domain is the box, half a cell in from each side.
    const hx = w / cols / 2;
    const hy = h / rows / 2;
    const fn = this.pdf.add(`<< /FunctionType 0 /Domain [${n(hx)} ${n(w - hx)} ${n(hy)} ${n(h - hy)}] /Range [0 1 0 1 0 1] /Size [${cols} ${rows}] /BitsPerSample 8 /Length ${rgb.length} >>`, rgb);
    const ref = this.pdf.add(`<< /ShadingType 1 /Domain [${n(hx)} ${n(w - hx)} ${n(hy)} ${n(h - hy)}] /ColorSpace /DeviceRGB /Function ${fn} 0 R >>`);
    const name = this.name('Sh');
    this.res.shadings.set(name, ref);
    return name;
  }

  /** An image XObject from RGBA pixels. */
  async image(name: string, width: number, height: number, data: Uint8ClampedArray): Promise<void> {
    const rgb = new Uint8Array(width * height * 3);
    const alpha = new Uint8Array(width * height);
    let opaque = true;
    for (let i = 0, j = 0, k = 0; i < data.length; i += 4, j += 3, k++) {
      rgb[j] = data[i]!;
      rgb[j + 1] = data[i + 1]!;
      rgb[j + 2] = data[i + 2]!;
      alpha[k] = data[i + 3]!;
      if (data[i + 3] !== 255) opaque = false;
    }
    let smask = '';
    if (!opaque) {
      const mask = await deflate(alpha);
      const ref = this.pdf.add(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${mask.length} >>`, mask);
      smask = ` /SMask ${ref} 0 R`;
    }
    const body = await deflate(rgb);
    const ref = this.pdf.add(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask} /Length ${body.length} >>`, body);
    this.res.images.set(name, ref);
  }

  /** Places an image so that it covers rect (x, y, w, h) of the current y-down space. */
  placeImage(name: string, x: number, y: number, w: number, h: number): void {
    const m = this.save();
    this.transform({ a: w, b: 0, c: 0, d: -h, e: x, f: y + h });
    this.push(`/${name} Do`);
    this.restore(m);
  }

  /** Embeds a layer as a high-resolution picture (for looks PDF cannot express). */
  rasterNode(id: NodeId, children = true): void {
    const name = this.name('Im');
    const bounds = this.scene.renderBounds(id);
    // The picture is in world space; undo the current transform first.
    const inv = invert(this.m) ?? IDENTITY;
    const saved = this.save();
    this.transform(multiply(inv, this.base));
    this.placeImage(name, bounds.x, bounds.y, bounds.width, bounds.height);
    this.restore(saved);
    this.pending.push(
      rasterize(this.renderer, this.scene, id, this.scale, undefined, { children }).then(async ({ canvas }) => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        await this.image(name, img.width, img.height, img.data);
      }),
    );
  }

  fills(id: NodeId, paths: readonly VectorPath[], w: number, h: number, evenodd: boolean, paints: readonly Paint[] = this.doc.get(id, 'fills')): void {
    for (const p of paints) {
      if (!p.visible) continue;
      if (p.type === 'SOLID') {
        const m = this.save();
        this.alpha(p.color.a * p.opacity);
        this.push(`${n(p.color.r)} ${n(p.color.g)} ${n(p.color.b)} rg`);
        this.path(paths);
        this.push(evenodd ? 'f*' : 'f');
        this.restore(m);
      } else if (p.type === 'IMAGE') {
        this.imageFill(p, paths, w, h, evenodd);
      } else if (p.type !== 'PATTERN') {
        const m = this.save();
        this.alpha(p.opacity);
        this.path(paths);
        this.push(evenodd ? 'W* n' : 'W n');
        this.push(`/${this.shading(p, w, h)} sh`);
        this.restore(m);
      }
    }
  }

  imageFill(p: Extract<Paint, { type: 'IMAGE' }>, paths: readonly VectorPath[], w: number, h: number, evenodd: boolean): void {
    const decoded = this.renderer.images.get(this.doc, p.imageHash);
    if (!decoded) return;
    const name = this.name('Im');
    const m = this.save();
    this.alpha(p.opacity);
    this.path(paths);
    this.push(evenodd ? 'W* n' : 'W n');
    const iw = decoded.width;
    const ih = decoded.height;
    if (p.scaleMode === 'STRETCH') this.placeImage(name, 0, 0, w, h);
    else if (p.scaleMode === 'TILE') {
      const tw = iw * (p.scale || 1);
      const th = ih * (p.scale || 1);
      for (let y = 0; y < h && th > 0; y += th) for (let x = 0; x < w && tw > 0; x += tw) this.placeImage(name, x, y, tw, th);
    } else {
      const k = p.scaleMode === 'FIT' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
      this.placeImage(name, (w - iw * k) / 2, (h - ih * k) / 2, iw * k, ih * k);
    }
    this.restore(m);
    this.pending.push(
      (async () => {
        const canvas = new OffscreenCanvas(iw, ih);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(decoded.image, 0, 0);
        const img = ctx.getImageData(0, 0, iw, ih);
        await this.image(name, iw, ih, img.data);
      })(),
    );
  }

  strokes(id: NodeId, paths: readonly VectorPath[], forceCenter: boolean): void {
    const d = this.doc;
    const strokes = d.get(id, 'strokes').filter((p) => p.visible);
    const weight = d.get(id, 'strokeWeight');
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const sides = forceCenter ? null : sideWeights(d, id);
    if (strokes.length > 0 && weight > 0 && isVariableStroke(d.get(id, 'strokeProfile'), d.get(id, 'brush'))) {
      // A width profile or a brush: the stroke's own shape, filled.
      const shape = variableStrokeOf(d, id);
      for (const p of strokes) this.fillArea(shape, p, w, h, false);
      return;
    }
    if (strokes.length > 0 && sides && Math.max(...sides) > 0) {
      // Per-side weights: fill the area between the two contours (FR-DRW-060).
      const region = sideStrokeRegion(w, h, rectRadii(d, id, w, h), sides, d.get(id, 'strokeAlign'));
      for (const p of strokes) this.fillArea(region, p, w, h);
      return;
    }
    if (strokes.length === 0 || weight <= 0) return;
    const closed = paths.some((p) => p.closed);
    const align = forceCenter || !closed ? 'CENTER' : d.get(id, 'strokeAlign');
    const cap = d.get(id, 'strokeCap');
    const join = d.get(id, 'strokeJoin');
    for (const p of strokes) {
      const m = this.save();
      this.push(`${cap === 'ROUND' ? 1 : cap === 'SQUARE' ? 2 : 0} J ${join === 'ROUND' ? 1 : join === 'BEVEL' ? 2 : 0} j ${n(Math.max(1, d.get(id, 'strokeMiterLimit')))} M`);
      if (align === 'INSIDE') {
        this.path(paths);
        this.push('W n');
      } else if (align === 'OUTSIDE') {
        const pad = weight * 2 + 2;
        this.push(`${n(-pad)} ${n(-pad)} ${n(w + pad * 2)} ${n(h + pad * 2)} re`);
        this.path(paths);
        this.push('W* n');
      }
      const dash = dashOf(d, id);
      if (dash.length > 0) this.push(`[${dash.map(n).join(' ')}] 0 d`);
      this.push(`${n(align === 'CENTER' ? weight : weight * 2)} w`);
      if (p.type === 'SOLID') {
        this.alpha(p.color.a * p.opacity);
        this.push(`${n(p.color.r)} ${n(p.color.g)} ${n(p.color.b)} RG`);
        this.path(paths);
        this.push('S');
      } else if (p.type !== 'IMAGE' && p.type !== 'PATTERN') {
        // Gradient strokes: the stroke outline is used as a clip for the shading.
        this.alpha(p.opacity);
        this.path(paths);
        this.push('W n');
        this.push(`/${this.shading(p, w, h)} sh`);
      }
      this.restore(m);
    }
  }

  /** Fills an area (even-odd) with a paint: solid colour or a gradient through a clip. */
  private fillArea(paths: readonly VectorPath[], p: Paint, w: number, h: number, evenodd = true): void {
    const m = this.save();
    if (p.type === 'SOLID') {
      this.alpha(p.color.a * p.opacity);
      this.push(`${n(p.color.r)} ${n(p.color.g)} ${n(p.color.b)} rg`);
      this.path(paths);
      this.push(evenodd ? 'f*' : 'f');
    } else if (p.type !== 'IMAGE' && p.type !== 'PATTERN') {
      this.alpha(p.opacity);
      this.path(paths);
      this.push(evenodd ? 'W* n' : 'W n');
      this.push(`/${this.shading(p, w, h)} sh`);
    }
    this.restore(m);
  }

  /** Line ends of lines and open vectors (FR-DRW-062). */
  ends(id: NodeId, paths: readonly VectorPath[]): void {
    const d = this.doc;
    const strokes = d.get(id, 'strokes').filter((p) => p.visible);
    const weight = d.get(id, 'strokeWeight');
    const start = d.get(id, 'startCap');
    const end = d.get(id, 'endCap');
    if (strokes.length === 0 || weight <= 0 || (start === 'NONE' && end === 'NONE')) return;
    const w = d.get(id, 'width');
    for (const e of openEnds(paths)) {
      for (const [cap, at] of [
        [start, e.start],
        [end, e.end],
      ] as const) {
        const shape = capShape(cap, at.p, at.angle, weight);
        if (!shape) continue;
        for (const p of strokes) {
          if (shape.filled) this.fillArea(shape.paths, p, w, 1);
          else if (p.type === 'SOLID') {
            const m = this.save();
            this.alpha(p.color.a * p.opacity);
            this.push(`1 J 1 j ${n(weight)} w ${n(p.color.r)} ${n(p.color.g)} ${n(p.color.b)} RG`);
            this.path(shape.paths);
            this.push('S');
            this.restore(m);
          }
        }
      }
    }
  }

  /** Text: the exact picture of the layer plus an invisible text layer for selection and search. */
  text(id: NodeId): void {
    this.rasterNode(id);
    const d = this.doc;
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const style = textStyleOf(d, id);
    const autoWidth = d.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT';
    const { layout } = this.measurer.measure(style, autoWidth ? null : w);
    const valign = d.get(id, 'textAlignV');
    const align = d.get(id, 'textAlignH');
    const top = valign === 'CENTER' ? (h - layout.height) / 2 : valign === 'BOTTOM' ? h - layout.height : 0;
    const fontRef = this.font();
    this.res.fonts.set('FText', fontRef);
    const saved = this.save();
    this.transform(nodeTransform(d.get(id, 'x'), d.get(id, 'y'), d.get(id, 'rotation')));
    this.push('BT');
    this.push('3 Tr');
    for (const line of layout.lines) {
      const offset = lineOffset(line, w, align);
      for (const f of line.fragments) {
        const text = f.text;
        if (!text.trim()) continue;
        const size = f.font.fontSize;
        const units = [...text].length;
        // Glyphs of the invisible font are 1 em wide: horizontal scaling makes the run as wide as on the canvas.
        const tz = units > 0 ? (f.width / (units * size)) * 100 : 100;
        const x = line.x + offset + f.x;
        const y = top + line.y + line.baseline + f.shift;
        let hex = '';
        for (const ch of text) {
          const code = ch.codePointAt(0)!;
          hex += (code > 0xffff ? 0xfffd : code).toString(16).padStart(4, '0');
        }
        this.push(`/FText ${n(size)} Tf ${n(tz)} Tz 1 0 0 -1 ${n(x)} ${n(y)} Tm <${hex}> Tj`);
        const url = f.style.link ? safeLink(f.style.link) : null;
        if (url) {
          const y0 = top + line.y;
          const corners = [apply(this.m, { x, y: y0 }), apply(this.m, { x: x + f.width, y: y0 }), apply(this.m, { x, y: y0 + line.height }), apply(this.m, { x: x + f.width, y: y0 + line.height })];
          const xs = corners.map((c) => c.x);
          const ys = corners.map((c) => c.y);
          this.links.push({ rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], url });
        }
      }
    }
    this.push('ET');
    this.restore(saved);
  }

  node(id: NodeId): void {
    const d = this.doc;
    if (!d.get(id, 'visible')) return;
    const type = d.type(id);
    const effects = d.get(id, 'effects').some((e) => e.visible);
    const blend = d.get(id, 'blendMode');
    // Looks PDF cannot express directly become pictures of the layer.
    const masks = d.children(id).some((c) => d.get(c, 'isMask'));
    // A text on a path: each letter turned its own way — a picture (its letters are drawn as on the canvas).
    // A warped layer (mockups) is a stretched picture too.
    const special = (blend !== 'PASS_THROUGH' && blend !== 'NORMAL') || (type === 'TEXT' && d.get(id, 'textPath') !== null) || needsPicture(d, id);
    // A frame with a shadow or blur: its own look as a picture, its content still vector.
    const frameWithEffects = effects && !special && !masks && (type === 'FRAME' || type === 'COMPONENT' || type === 'INSTANCE' || type === 'COMPONENT_SET') && !d.get(id, 'effects').some((e) => e.visible && e.type === 'LAYER_BLUR');
    if ((effects && !frameWithEffects) || special || masks) {
      this.rasterNode(id);
      return;
    }
    if (frameWithEffects) {
      this.rasterNode(id, false);
      const saved = this.save();
      this.transform(nodeTransform(d.get(id, 'x'), d.get(id, 'y'), d.get(id, 'rotation')));
      this.alpha(d.get(id, 'opacity'));
      if (d.get(id, 'clipsContent')) {
        this.path(shapePaths('RECTANGLE', { width: d.get(id, 'width'), height: d.get(id, 'height'), cornerRadius: d.get(id, 'cornerRadius'), cornerRadii: d.get(id, 'cornerRadii') }));
        this.push('W n');
      }
      for (const c of d.paintChildren(id)) this.node(c);
      this.restore(saved);
      return;
    }
    const saved = this.save();
    this.transform(nodeTransform(d.get(id, 'x'), d.get(id, 'y'), d.get(id, 'rotation')));
    this.alpha(d.get(id, 'opacity'));
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    switch (type) {
      case 'SECTION':
      case 'FRAME':
      case 'COMPONENT':
      case 'COMPONENT_SET':
      case 'INSTANCE': {
        const paths = shapePaths('RECTANGLE', { width: w, height: h, cornerRadius: d.get(id, 'cornerRadius'), cornerRadii: d.get(id, 'cornerRadii') });
        this.fills(id, paths, w, h, false);
        const inner = this.save();
        if (d.get(id, 'clipsContent')) {
          this.path(paths);
          this.push('W n');
        }
        for (const c of d.paintChildren(id)) this.node(c);
        this.restore(inner);
        this.strokes(id, paths, false);
        break;
      }
      case 'GROUP':
        for (const c of d.paintChildren(id)) this.node(c);
        break;
      case 'TEXT':
        this.restore(saved);
        this.text(id);
        return;
      case 'LINE': {
        const paths = nodePaths(d, id);
        this.strokes(id, paths, true);
        this.ends(id, paths);
        break;
      }
      default: {
        const drawing = vectorDrawing(d, id);
        if (drawing) {
          if (drawing.fill.length) this.fills(id, drawing.fill, w, h, drawing.evenOdd);
          for (const part of drawing.parts) this.fills(id, part.fill, w, h, part.evenOdd, part.fills);
          this.strokes(id, drawing.stroke, drawing.strokeCentered);
          this.ends(id, drawing.stroke);
          break;
        }
        const all = nodePaths(d, id);
        // A board shape's open contours are details: not filled, stroked as lines (as on the canvas).
        const details = d.get(id, 'board')?.kind === 'SHAPE_OUTLINE' ? all.filter((p) => !p.closed) : [];
        const paths = details.length ? all.filter((p) => p.closed) : all;
        const evenodd = type === 'VECTOR' && d.get(id, 'windingRule') === 'EVENODD';
        if (paths.some((p) => p.closed)) this.fills(id, paths, w, h, evenodd);
        this.strokes(id, paths, false);
        if (details.length) this.strokes(id, details, true);
        if (type === 'VECTOR') this.ends(id, paths);
      }
    }
    this.restore(saved);
  }
}

/** Invisible Unicode font for the selectable text layer (glyphs are never drawn). */
function textFont(pdf: PdfWriter): number {
  // ToUnicode maps every 2-byte code to the same UTF-16 code unit, so copied text is exactly the original.
  const cmap = new TextEncoder().encode(
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n',
  );
  const toUnicode = pdf.add(`<< /Length ${cmap.length} >>`, cmap);
  const descriptor = pdf.add('<< /Type /FontDescriptor /FontName /CanvasStudioText /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>');
  const cid = pdf.add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CanvasStudioText /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /CIDToGIDMap /Identity >>`);
  return pdf.add(`<< /Type /Font /Subtype /Type0 /BaseFont /CanvasStudioText /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
}

/** Vector PDF with one page per node (page = the node's painted area, 1 px = 1 pt). */
export async function exportVectorPdf(renderer: Canvas2DRenderer, scene: SceneGraph, measurer: TextMeasurer, ids: readonly NodeId[], scale = 3): Promise<Blob> {
  scene.ensure();
  const pdf = new PdfWriter();
  const catalog = pdf.reserve();
  const pagesRef = pdf.reserve();
  let fontRef = 0;
  const font = () => (fontRef ||= textFont(pdf));
  const kids: number[] = [];
  for (const id of ids) {
    const b = scene.renderBounds(id);
    const page = new PageWriter(pdf, scene, renderer, measurer, scale, font);
    // PDF space is y-up: flip so that everything below works in canvas coordinates.
    page.transform({ a: 1, b: 0, c: 0, d: -1, e: -b.x, f: b.height + b.y });
    page.base = page.m;
    const parent = scene.doc.parent(id);
    if (parent && scene.doc.type(parent) !== 'PAGE') page.transform(scene.world(parent));
    page.node(id);
    await Promise.all(page.pending);
    const content = await deflate(new TextEncoder().encode(page.ops.join('\n')));
    const contentRef = pdf.add(`<< /Length ${content.length} /Filter /FlateDecode >>`, content);
    const ext = [...page.res.ext].map(([a, name]) => `/${name} << /Type /ExtGState /ca ${a} /CA ${a} >>`).join(' ');
    const shadings = [...page.res.shadings].map(([name, ref]) => `/${name} ${ref} 0 R`).join(' ');
    const images = [...page.res.images].map(([name, ref]) => `/${name} ${ref} 0 R`).join(' ');
    const fonts = [...page.res.fonts].map(([name, ref]) => `/${name} ${ref} 0 R`).join(' ');
    const resources = `<< ${ext ? `/ExtGState << ${ext} >> ` : ''}${shadings ? `/Shading << ${shadings} >> ` : ''}${images ? `/XObject << ${images} >> ` : ''}${fonts ? `/Font << ${fonts} >>` : ''} >>`;
    // Hyperlinks of texts: clickable areas opening the address.
    const annots = page.links.map((l) => pdf.add(`<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(n).join(' ')}] /Border [0 0 0] /A << /S /URI /URI (${l.url.replace(/[\\()]/g, '\\$&')}) >> >>`));
    kids.push(pdf.add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${n(b.width)} ${n(b.height)}] /Resources ${resources} /Contents ${contentRef} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`));
  }
  pdf.set(pagesRef, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);
  const title = ids.length === 1 ? scene.doc.get(ids[0]!, 'name') : scene.doc.get(scene.doc.rootId, 'name');
  return new Blob([pdf.build(catalog, title) as BlobPart], { type: 'application/pdf' });
}
