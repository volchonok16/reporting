// Canvas 2D rendering backend. It draws the scene for the editor viewport and
// for raster export with the same code, so the canvas and exported PNGs match
// (FR-CNV-005). A GPU backend (WebGL 2 / WebGPU) implements the same `Renderer`
// interface later.

import type { BlendMode, Color, Document, Effect, GlassEffect, GradientPaint, ImagePaint, MaskType, NodeId, NoiseEffect, Paint, PatternPaint, VectorPath, Warp } from '#core';
import { glassPixels, luminanceMask, noiseTile, plusDarker, roughen, vectorMask } from './pixels.ts';
import { capShape, cylinderShade, intersects, isVariableStroke, openEnds, sideStrokeRegion, warpGrid, warpMap, type Point, type Rect } from '#geometry';
import { decorationLookOf, decorationPath, lineOffset, nodePaths, pathTextGlyphs, textStyleOf, variableStrokeOf, vectorDrawing, type TextMeasurer } from '#layout';
import { applyFont } from './canvas-text.ts';
import { dashOf, RECT_LIKE, rectRadii } from './stroke.ts';
import { ImageCache } from './images.ts';
import type { SceneGraph } from './scene.ts';
import type { Viewport } from './viewport.ts';

import { drawBlurred } from './soft-blur.ts';
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
import { gradientGrid, gradientPixels } from './gradients.ts';

export interface RenderTarget {
  ctx: Ctx2D;
  /** Size in CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio. */
  dpr: number;
}

export interface Renderer {
  renderPage(target: RenderTarget, scene: SceneGraph, viewport: Viewport): RenderStats;
}

export interface RenderStats {
  drawn: number;
  culled: number;
  ms: number;
}

export function cssColor(c: Color, opacity = 1): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return `rgba(${r},${g},${b},${+(c.a * opacity).toFixed(4)})`;
}

const BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
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
  PLUS_LIGHTER: 'lighter',
  // Plus darker of a whole layer is exact (drawPlusDarker); for a fill or an effect, the nearest the canvas has.
  PLUS_DARKER: 'multiply',
};

/** A box on the device canvas (whole pixels). */
type Box = { x: number; y: number; w: number; h: number };

export class Canvas2DRenderer implements Renderer {
  /** Text nodes not to paint (e.g. the one being edited in an overlay). */
  readonly hiddenText = new Set<NodeId>();
  /** Layers lifted off the page while dragged: the page leaves them out, they are drawn apart (`renderLifted`). */
  lifted: ReadonlySet<NodeId> | null = null;
  private skipLifted = false;
  /** Layers with a moving fill drawn since the canvas last looked (it redraws them). */
  readonly animated = new Set<NodeId>();
  /** Decoded bitmaps for image fills; `images.onLoad` should trigger a redraw. */
  readonly images = new ImageCache();
  private readonly measurer: TextMeasurer;
  private visible: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private zoom = 1;
  private stats: RenderStats = { drawn: 0, culled: 0, ms: 0 };
  private culling = true;
  /**
   * Level of detail on the editor canvas (never in exports and previews):
   * layers smaller than half a pixel are skipped, text too small to read is
   * drawn as bars of its colour, shadows of tiny layers are left out. A whole
   * file zoomed out stays smooth; at a readable size nothing changes.
   */
  private lod = false;
  /** Maps the stored page background to the one painted (the editor makes theme defaults follow the theme). */
  pageBackground: ((stored: Color) => Color) | null = null;
  /** Drawn over the page background, under the content, in page coordinates (a board's dots). `zoom` — device pixels per unit. */
  pagePattern: ((ctx: Ctx2D, visible: Rect, zoom: number) => void) | null = null;
  /** How a layer's strokes, line ends and letters are coloured on screen (dark ink on the dark canvas), or null — as stored. Not in exports. */
  ink: ((id: NodeId) => ((c: Color) => Color) | null) | null = null;
  /** The mapping of the layer being drawn. */
  private inkNow: ((c: Color) => Color) | null = null;
  /** Export and thumbnails: stored colours. */
  private standalone = false;
  /**
   * Outline view (⇧⌘O, as in Figma): every layer as a thin line, without fills, effects, masks or
   * clipping; `hidden` — hidden layers too (fainter), `bounds` — every layer's box. Not in exports.
   */
  outlines: { hidden: boolean; bounds: boolean } | null = null;
  private dpr = 1;
  /** The outlines' colour: dark on a light page, light on a dark one. */
  private outlineColor: Color = { r: 0.25, g: 0.25, b: 0.25, a: 1 };

  constructor(measurer: TextMeasurer) {
    this.measurer = measurer;
  }

  renderPage(target: RenderTarget, scene: SceneGraph, viewport: Viewport): RenderStats {
    const started = performance.now();
    this.stats = { drawn: 0, culled: 0, ms: 0 };
    const { ctx, width, height, dpr } = target;
    scene.ensure();
    const doc = scene.doc;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const background = doc.get(scene.pageId, 'backgroundColor');
    const shown = this.pageBackground ? this.pageBackground(background) : background;
    ctx.fillStyle = cssColor(shown);
    const light = 0.299 * shown.r + 0.587 * shown.g + 0.114 * shown.b > 0.5;
    this.outlineColor = light ? { r: 0.25, g: 0.25, b: 0.25, a: 1 } : { r: 0.78, g: 0.78, b: 0.78, a: 1 };
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(dpr * viewport.zoom, 0, 0, dpr * viewport.zoom, dpr * viewport.offsetX, dpr * viewport.offsetY);
    this.visible = viewport.visibleRect(width, height);
    this.zoom = viewport.zoom * dpr;
    this.dpr = dpr;
    this.pagePattern?.(ctx, this.visible, this.zoom);
    this.lod = true;
    this.skipLifted = this.lifted !== null;
    this.drawChildren(ctx, scene, scene.pageId);
    this.skipLifted = false;
    this.lod = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.stats.ms = performance.now() - started;
    return this.stats;
  }

  /** Draws one node (and its subtree) with the context already set to its parent's space. Used by export and thumbnails. */
  /** While set, the children of this node are not drawn (vector PDF draws them itself). */
  private withoutChildren: NodeId | null = null;

  renderNode(ctx: Ctx2D, scene: SceneGraph, id: NodeId, visible: Rect, zoom: number, options: { children?: boolean } = {}): void {
    const previous = { visible: this.visible, zoom: this.zoom, culling: this.culling };
    this.withoutChildren = options.children === false ? id : null;
    this.visible = visible;
    this.zoom = zoom;
    // Off-page nodes have no cached render bounds, so culling is disabled for standalone renders.
    this.culling = false;
    this.standalone = true;
    this.drawNode(ctx, scene, id, true);
    this.standalone = false;
    this.withoutChildren = null;
    this.visible = previous.visible;
    this.zoom = previous.zoom;
    this.culling = previous.culling;
  }

  /**
   * Draws lifted layers (at their places now) into a picture of `area` (world
   * units) at `scale` device pixels per unit; the context is cleared by the caller.
   */
  renderLifted(ctx: Ctx2D, scene: SceneGraph, ids: readonly NodeId[], area: Rect, scale: number): void {
    for (const id of ids) {
      const parent = scene.doc.parent(id)!;
      ctx.setTransform(scale, 0, 0, scale, -area.x * scale, -area.y * scale);
      if (parent !== scene.pageId) {
        const m = scene.world(parent);
        ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
      }
      this.lod = true;
      this.renderNode(ctx, scene, id, area, scale);
      this.lod = false;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawNode(ctx: Ctx2D, scene: SceneGraph, id: NodeId, force = false): void {
    const d = scene.doc;
    if (this.outlines && !this.standalone) return this.drawOutline(ctx, scene, id, this.outlines);
    if (!d.get(id, 'visible')) return;
    if (this.skipLifted && this.lifted!.has(id)) return;
    if (!force && this.culling && !intersects(scene.renderBounds(id), this.visible)) {
      this.stats.culled++;
      return;
    }
    if (this.lod && !force) {
      const b = scene.renderBounds(id);
      if (b.width * this.zoom < 0.5 && b.height * this.zoom < 0.5) {
        this.stats.culled++;
        return;
      }
    }
    this.stats.drawn++;
    this.sceneNow = scene;
    // A video or an animated GIF in view: the canvas redraws this layer again soon.
    if (d.get(id, 'fills').some((p) => p.visible && p.type === 'IMAGE' && this.images.isAnimated(p.imageHash))) this.animated.add(id);
    if (this.drawWarped(ctx, scene, id)) return;
    if (this.drawTextured(ctx, scene, id)) return;
    if (this.drawPlusDarker(ctx, scene, id)) return;
    if (this.drawProgressive(ctx, scene, id)) return;
    if (this.drawLayerBlur(ctx, scene, id)) return;
    const outerInk = this.inkNow;
    this.inkNow = this.ink && !this.standalone ? this.ink(id) : null;
    const type = d.type(id);
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    ctx.save();
    ctx.translate(d.get(id, 'x'), d.get(id, 'y'));
    const rotation = d.get(id, 'rotation');
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);
    ctx.globalAlpha *= d.get(id, 'opacity');
    const blend = BLEND[d.get(id, 'blendMode')];
    if (blend) ctx.globalCompositeOperation = blend;
    this.applyLayerBlur(ctx, d, id);

    switch (type) {
      case 'SECTION':
      case 'FRAME':
      case 'COMPONENT':
      case 'COMPONENT_SET':
      case 'INSTANCE':
      case 'RECTANGLE': {
        const path = this.rectPath(d, id, w, h);
        const sticky = type === 'FRAME' && d.get(id, 'board')?.kind === 'STICKY';
        if (sticky) this.stickyCurl(ctx, w, h);
        this.drawShadows(ctx, d, id, path);
        this.drawBackgroundBlur(ctx, d, id, path);
        this.fillPath(ctx, d.get(id, 'fills'), path, w, h, d);
        if (sticky) this.stickyPaper(ctx, path, w, h);
        this.drawInnerEffects(ctx, d, id, path, w, h);
        if (type !== 'RECTANGLE') {
          ctx.save();
          if (d.get(id, 'clipsContent')) ctx.clip(path);
          this.drawChildren(ctx, scene, id);
          ctx.restore();
        }
        this.strokePath(ctx, d, id, path);
        break;
      }
      case 'ELLIPSE': {
        // An arc, pie or ring is its outline (arcPaths); a whole ellipse — the canvas's own.
        const path = d.get(id, 'arc') ? pathOf(nodePaths(d, id)) : new Path2D();
        if (!d.get(id, 'arc')) path.ellipse(w / 2, h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
        this.drawShadows(ctx, d, id, path);
        this.drawBackgroundBlur(ctx, d, id, path);
        this.fillPath(ctx, d.get(id, 'fills'), path, w, h, d);
        this.drawInnerEffects(ctx, d, id, path, w, h);
        this.strokePath(ctx, d, id, path);
        break;
      }
      case 'VECTOR':
      case 'BOOLEAN_OPERATION': {
        const drawing = vectorDrawing(d, id);
        if (drawing) {
          // A vector network: regions are filled, segments stroked (each once).
          const fillPath = pathOf(drawing.fill);
          const strokeP = drawing.stroke === drawing.fill ? fillPath : pathOf(drawing.stroke);
          this.drawShadows(ctx, d, id, drawing.fill.length ? fillPath : strokeP);
          if (drawing.fill.length) {
            this.drawBackgroundBlur(ctx, d, id, fillPath);
            this.fillPath(ctx, d.get(id, 'fills'), fillPath, w, h, d, drawing.evenOdd ? 'evenodd' : 'nonzero');
            this.drawInnerEffects(ctx, d, id, fillPath, w, h);
          }
          // Regions with paints of their own (a several-colour icon in one vector).
          for (const part of drawing.parts) this.fillPath(ctx, part.fills, pathOf(part.fill), w, h, d, part.evenOdd ? 'evenodd' : 'nonzero');
          this.strokePath(ctx, d, id, strokeP, drawing.strokeCentered);
          this.drawEnds(ctx, d, id, drawing.stroke);
          break;
        }
        const all = nodePaths(d, id);
        // A board shape's open contours are details (a cylinder's rim, a note's fold): not filled, stroked as lines.
        const details = d.get(id, 'board')?.kind === 'SHAPE_OUTLINE' ? all.filter((p) => !p.closed) : [];
        const paths = details.length ? all.filter((p) => p.closed) : all;
        const path = pathOf(paths);
        const rule: CanvasFillRule = type === 'VECTOR' && d.get(id, 'windingRule') === 'EVENODD' ? 'evenodd' : 'nonzero';
        const closed = paths.some((p) => p.closed);
        this.drawShadows(ctx, d, id, path);
        if (closed) {
          this.drawBackgroundBlur(ctx, d, id, path);
          this.fillPath(ctx, d.get(id, 'fills'), path, w, h, d, rule);
          this.drawInnerEffects(ctx, d, id, path, w, h);
        }
        // Open contours have no inside: their stroke is centred, like a line.
        this.strokePath(ctx, d, id, path, !closed);
        if (details.length) this.strokePath(ctx, d, id, pathOf(details), true);
        this.drawEnds(ctx, d, id, paths);
        break;
      }
      case 'POLYGON':
      case 'STAR': {
        // The outline with its corners rounded (cornerRadius), as in Figma.
        const path = pathOf(nodePaths(d, id));
        this.drawShadows(ctx, d, id, path);
        this.drawBackgroundBlur(ctx, d, id, path);
        this.fillPath(ctx, d.get(id, 'fills'), path, w, h, d);
        this.drawInnerEffects(ctx, d, id, path, w, h);
        this.strokePath(ctx, d, id, path);
        break;
      }
      case 'LINE':
      case 'TEXT':
      case 'GROUP':
        // No outline of their own: their effects follow what they draw (letters, the group's content).
        if (this.hasPixelEffects(d, id)) this.drawWithPixelEffects(ctx, d, id, (c) => this.drawBody(c, scene, id, w, h), this.deviceRect(ctx, scene, id, 2, 0, true));
        else this.drawBody(ctx, scene, id, w, h);
        break;
      default:
        break;
    }
    ctx.restore();
    this.inkNow = outerInk;
  }

  /** A layer in outline view: its outline (a text — its letters) in one thin colour, then its children unclipped. */
  private drawOutline(ctx: Ctx2D, scene: SceneGraph, id: NodeId, o: NonNullable<Canvas2DRenderer['outlines']>): void {
    const d = scene.doc;
    const shown = d.get(id, 'visible');
    if (!shown && !o.hidden) return;
    if (this.culling && !intersects(scene.renderBounds(id), this.visible)) {
      this.stats.culled++;
      return;
    }
    this.stats.drawn++;
    const type = d.type(id);
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    ctx.save();
    ctx.translate(d.get(id, 'x'), d.get(id, 'y'));
    const rotation = d.get(id, 'rotation');
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);
    if (!shown) ctx.globalAlpha *= 0.45;
    const color = cssColor(this.outlineColor);
    ctx.strokeStyle = color;
    ctx.lineWidth = this.dpr / this.zoom;
    ctx.setLineDash([]);
    let path: Path2D | null = null;
    if (RECT_LIKE.has(type)) path = this.rectPath(d, id, w, h);
    else if (type === 'ELLIPSE' && !d.get(id, 'arc')) {
      path = new Path2D();
      path.ellipse(w / 2, h / 2, Math.max(0, w / 2), Math.max(0, h / 2), 0, 0, Math.PI * 2);
    } else if (type === 'LINE') {
      path = new Path2D();
      path.moveTo(0, 0);
      path.lineTo(w, 0);
    } else if (type === 'TEXT') {
      const outerInk = this.inkNow;
      const c = this.outlineColor;
      this.inkNow = () => c;
      if (!this.hiddenText.has(id)) this.drawText(ctx, d, id, w, h);
      this.inkNow = outerInk;
    } else if (type !== 'GROUP') path = pathOf(nodePaths(d, id));
    if (path) ctx.stroke(path);
    // The box of every layer (groups and texts included), dashed.
    if (o.bounds && type !== 'SECTION' && w > 0 && h > 0) {
      ctx.save();
      ctx.globalAlpha *= 0.5;
      ctx.setLineDash([4 * this.dpr / this.zoom, 3 * this.dpr / this.zoom]);
      ctx.strokeRect(0, 0, w, h);
      ctx.restore();
    }
    // Children: every one, masks and what frames clip included; a boolean shows its parts too.
    if (id !== this.withoutChildren) for (const child of d.paintChildren(id)) this.drawOutline(ctx, scene, child, o);
    ctx.restore();
  }

  /** What a line, a text or a group draws itself (no effects). */
  private drawBody(ctx: Ctx2D, scene: SceneGraph, id: NodeId, w: number, h: number): void {
    const d = scene.doc;
    const type = d.type(id);
    if (type === 'LINE') {
      const path = new Path2D();
      path.moveTo(0, 0);
      path.lineTo(w, 0);
      this.strokePath(ctx, d, id, path, true);
      this.drawEnds(ctx, d, id, [{ closed: false, points: [{ x: 0, y: 0 }, { x: w, y: 0 }] }]);
    } else if (type === 'TEXT') {
      if (!this.hiddenText.has(id)) this.drawText(ctx, d, id, w, h);
    } else {
      this.drawChildren(ctx, scene, id);
    }
  }

  private hasPixelEffects(d: Document, id: NodeId): boolean {
    // Layer blur and texture work on the whole picture of the layer (applyLayerBlur, drawTextured).
    return d.get(id, 'effects').some((e) => e.visible && e.type !== 'LAYER_BLUR' && e.type !== 'TEXTURE');
  }

  /**
   * Effects of a layer without an outline (as in Figma for text and groups): the layer is drawn into
   * its own canvas, and shadows, inner shadows, background blur and noise come from its opaque pixels.
   */
  private drawWithPixelEffects(ctx: Ctx2D, d: Document, id: NodeId, body: (c: Ctx2D) => void, box: Box | null): void {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    if (typeof OffscreenCanvas === 'undefined' || W === 0 || H === 0) {
      body(ctx);
      return;
    }
    const m = ctx.getTransform();
    const layer = new OffscreenCanvas(W, H);
    const lctx = layer.getContext('2d');
    if (!lctx) {
      body(ctx);
      return;
    }
    lctx.setTransform(m);
    body(lctx);
    const scale = Math.hypot(m.a, m.b);
    const effects = d.get(id, 'effects').filter((e) => e.visible);
    const offsetOf = (x: number, y: number) => ({ x: x * m.a + y * m.c, y: x * m.b + y * m.d });
    // The layer's shape grown by `spread` (device px): copies of it shifted around a circle.
    const grown = (spread: number): OffscreenCanvas => {
      if (spread <= 0) return layer;
      const out = new OffscreenCanvas(W, H);
      const o = out.getContext('2d')!;
      const r = spread * scale;
      const steps = Math.max(8, Math.min(32, Math.ceil(r * 2)));
      for (let i = 0; i < steps; i++) o.drawImage(layer, Math.cos((i / steps) * Math.PI * 2) * r, Math.sin((i / steps) * Math.PI * 2) * r);
      o.drawImage(layer, 0, 0);
      return out;
    };
    const FAR = 100_000;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Frosted glass under the layer, only where it is opaque; or glass (the first of the two, as in Figma).
    const under = effects.find((e) => e.type === 'BACKGROUND_BLUR' || e.type === 'GLASS');
    if (under?.type === 'GLASS' && box) {
      const mask = new OffscreenCanvas(box.w, box.h);
      mask.getContext('2d')!.drawImage(layer, -box.x, -box.y);
      this.glassUnder(ctx, under, mask, box);
    }
    for (const e of effects) {
      if (e !== under || e.type !== 'BACKGROUND_BLUR' || e.radius <= 0) continue;
      const glass = new OffscreenCanvas(W, H);
      const g = glass.getContext('2d')!;
      drawBlurred(g, ctx.canvas, e.radius * this.zoom);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(layer, 0, 0);
      ctx.drawImage(glass, 0, 0);
    }
    // Drop shadows: only the shadow is drawn (the source far off-screen), then the layer over them.
    for (const e of effects) {
      if (e.type !== 'DROP_SHADOW') continue;
      if (this.lod && Math.max(d.get(id, 'width'), d.get(id, 'height')) * this.zoom < 16) break;
      const off = offsetOf(e.offset.x, e.offset.y);
      // The shadow on its own canvas: cut out under the layer unless it shows behind (Figma's default: not).
      const shade = new OffscreenCanvas(W, H);
      const sctx = shade.getContext('2d')!;
      sctx.shadowColor = cssColor(e.color);
      sctx.shadowBlur = e.radius * this.zoom;
      sctx.shadowOffsetX = off.x + FAR;
      sctx.shadowOffsetY = off.y;
      sctx.drawImage(grown(e.spread), -FAR, 0);
      if (!e.showBehind) {
        sctx.shadowColor = 'transparent';
        sctx.globalCompositeOperation = 'destination-out';
        sctx.drawImage(layer, 0, 0);
      }
      ctx.save();
      const blend = e.blendMode ? BLEND[e.blendMode] : undefined;
      if (blend) ctx.globalCompositeOperation = blend;
      ctx.drawImage(shade, 0, 0);
      ctx.restore();
    }
    ctx.drawImage(layer, 0, 0);
    // Inner shadows: the shadow of everything outside the layer, kept inside it.
    for (const e of effects) {
      if (e.type !== 'INNER_SHADOW') continue;
      const outside = new OffscreenCanvas(W, H);
      const o = outside.getContext('2d')!;
      o.fillStyle = '#000';
      o.fillRect(0, 0, W, H);
      o.globalCompositeOperation = 'destination-out';
      o.drawImage(e.spread > 0 ? this.shrunk(layer, e.spread * scale) : layer, 0, 0);
      const inner = new OffscreenCanvas(W, H);
      const i = inner.getContext('2d')!;
      const off = offsetOf(e.offset.x, e.offset.y);
      i.shadowColor = cssColor(e.color);
      i.shadowBlur = e.radius * this.zoom;
      i.shadowOffsetX = off.x + FAR;
      i.shadowOffsetY = off.y;
      i.drawImage(outside, -FAR, 0);
      i.shadowColor = 'transparent';
      i.globalCompositeOperation = 'destination-in';
      i.drawImage(layer, 0, 0);
      ctx.save();
      const blend = e.blendMode ? BLEND[e.blendMode] : undefined;
      if (blend) ctx.globalCompositeOperation = blend;
      ctx.drawImage(inner, 0, 0);
      ctx.restore();
    }
    // Noise: grain over the layer's pixels.
    for (const e of effects) {
      if (e.type !== 'NOISE' || (e.amount <= 0 && !e.noiseType)) continue;
      const pattern = e.noiseType ? this.colourNoise(ctx, e) : this.noisePattern(ctx);
      if (!pattern) continue;
      const grain = new OffscreenCanvas(W, H);
      const g = grain.getContext('2d')!;
      const k = Math.max(0.25, e.size) * scale;
      pattern.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
      g.fillStyle = pattern;
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(layer, 0, 0);
      ctx.save();
      if (e.noiseType) {
        const blend = e.blendMode ? BLEND[e.blendMode] : undefined;
        if (blend) ctx.globalCompositeOperation = blend;
      } else {
        ctx.globalAlpha *= Math.min(1, e.amount);
        ctx.globalCompositeOperation = 'overlay';
      }
      ctx.drawImage(grain, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  /** The layer's shape shrunk by `r` device px (for an inner shadow's spread): what survives every shift. */
  private shrunk(layer: OffscreenCanvas, r: number): OffscreenCanvas {
    const out = new OffscreenCanvas(layer.width, layer.height);
    const o = out.getContext('2d')!;
    o.drawImage(layer, 0, 0);
    o.globalCompositeOperation = 'destination-in';
    const steps = Math.max(8, Math.min(32, Math.ceil(r * 2)));
    for (let i = 0; i < steps; i++) o.drawImage(layer, Math.cos((i / steps) * Math.PI * 2) * r, Math.sin((i / steps) * Math.PI * 2) * r);
    return out;
  }

  private rectPath(d: Document, id: NodeId, w: number, h: number): Path2D {
    // (Corner radii are shared with per-side strokes through rectRadii.)
    const path = new Path2D();
    const radii = d.get(id, 'cornerRadii');
    const r = d.get(id, 'cornerRadius');
    const max = Math.min(w, h) / 2;
    if (radii) {
      path.roundRect(0, 0, w, h, radii.map((v) => Math.min(Math.max(0, v), max)));
    } else if (r > 0) {
      path.roundRect(0, 0, w, h, Math.min(r, max));
    } else {
      path.rect(0, 0, w, h);
    }
    return path;
  }

  /** A paint of a stroke, a line end or letters: as the layer's ink shows it. */
  private inked(paint: Paint): Paint {
    const map = this.inkNow;
    if (!map) return paint;
    if (paint.type === 'SOLID') return { ...paint, color: map(paint.color) };
    if ('stops' in paint) return { ...paint, stops: paint.stops.map((s) => ({ ...s, color: map(s.color) })) };
    return paint;
  }

  private inkStyle(ctx: Ctx2D, paint: Paint, w: number, h: number): string | CanvasGradient | CanvasPattern {
    return this.paintStyle(ctx, this.inked(paint), w, h);
  }

  private paintStyle(ctx: Ctx2D, paint: Paint, w: number, h: number): string | CanvasGradient | CanvasPattern {
    if (paint.type === 'SOLID') return cssColor(paint.color, paint.opacity);
    // Strokes and text with an image paint use a neutral tone (image strokes are not supported yet).
    if (paint.type === 'IMAGE') return `rgba(160,160,160,${paint.opacity})`;
    if (paint.type === 'PATTERN') return this.patternStyle(ctx, paint, w) ?? 'rgba(0,0,0,0)';
    if (paint.type === 'GRADIENT_DIAMOND') return this.diamond(ctx, paint, w, h) ?? cssColor(paint.stops[0]?.color ?? { r: 0, g: 0, b: 0, a: 0 }, paint.opacity);
    const from = { x: paint.from.x * w, y: paint.from.y * h };
    const to = { x: paint.to.x * w, y: paint.to.y * h };
    const gradient =
      paint.type === 'GRADIENT_LINEAR'
        ? ctx.createLinearGradient(from.x, from.y, to.x, to.y)
        : paint.type === 'GRADIENT_ANGULAR' && 'createConicGradient' in ctx
          ? ctx.createConicGradient(Math.atan2(to.y - from.y, to.x - from.x), from.x, from.y)
          : ctx.createRadialGradient(from.x, from.y, 0, from.x, from.y, Math.hypot(to.x - from.x, to.y - from.y));
    for (const stop of paint.stops) gradient.addColorStop(Math.min(1, Math.max(0, stop.position)), cssColor(stop.color, paint.opacity));
    return gradient;
  }

  /** Diamond gradients as a picture of the layer's size (no canvas gradient draws one); the last few are kept. */
  private readonly diamonds = new Map<string, CanvasPattern>();

  private diamond(ctx: Ctx2D, paint: GradientPaint, w: number, h: number): CanvasPattern | null {
    const key = `${JSON.stringify(paint)}|${Math.round(w)}|${Math.round(h)}`;
    const known = this.diamonds.get(key);
    if (known) return known;
    const { cols, rows } = gradientGrid(w, h);
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cols, rows) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: cols, height: rows }) : null;
    const pctx = canvas?.getContext('2d') as Ctx2D | null | undefined;
    if (!canvas || !pctx) return null;
    pctx.putImageData(new ImageData(gradientPixels(paint, w, h, cols, rows), cols, rows), 0, 0);
    const pattern = ctx.createPattern(canvas, 'no-repeat');
    if (!pattern) return null;
    pattern.setTransform(new DOMMatrix().scale(w / cols, h / rows));
    if (this.diamonds.size > 64) this.diamonds.delete(this.diamonds.keys().next().value!);
    this.diamonds.set(key, pattern);
    return pattern;
  }

  private fillPath(ctx: Ctx2D, fills: readonly Paint[], path: Path2D, w: number, h: number, doc?: Document, rule: CanvasFillRule = 'nonzero'): void {
    for (const paint of fills) {
      if (!paint.visible) continue;
      if (paint.type === 'IMAGE') {
        if (doc) this.fillImage(ctx, doc, paint, path, w, h);
        continue;
      }
      if (paint.type === 'PATTERN') {
        const pattern = this.patternStyle(ctx, paint, w);
        if (!pattern) continue;
        ctx.save();
        ctx.globalAlpha *= paint.opacity;
        const blend = paint.blendMode ? BLEND[paint.blendMode] : undefined;
        if (blend) ctx.globalCompositeOperation = blend;
        ctx.fillStyle = pattern;
        ctx.fill(path, rule);
        ctx.restore();
        continue;
      }
      ctx.fillStyle = this.paintStyle(ctx, paint, w, h);
      ctx.fill(path, rule);
    }
  }

  /**
   * Draws children in order. A child marked as a mask is not drawn itself: the
   * siblings above it (up to the next mask) are drawn into a layer and kept only
   * where the mask is opaque, as in Figma.
   */
  private drawChildren(ctx: Ctx2D, scene: SceneGraph, parent: NodeId): void {
    if (parent === this.withoutChildren) return;
    const d = scene.doc;
    const children = d.paintChildren(parent);
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (!d.get(child, 'isMask') || !d.get(child, 'visible')) {
        this.drawNode(ctx, scene, child);
        continue;
      }
      const masked: NodeId[] = [];
      while (i + 1 < children.length && !d.get(children[i + 1]!, 'isMask')) masked.push(children[++i]!);
      if (masked.length === 0) continue;
      const layer = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height);
      const lctx = layer.getContext('2d');
      if (!lctx) continue;
      lctx.setTransform(ctx.getTransform());
      for (const m of masked) this.drawNode(lctx, scene, m);
      lctx.globalCompositeOperation = 'destination-in';
      const type: MaskType = d.get(child, 'maskType');
      if (type === 'ALPHA') this.drawNode(lctx, scene, child, true);
      else {
        // The mask's picture is in device pixels: laid on without the layer's transform.
        const picture = this.maskPicture(ctx, scene, child, type);
        lctx.save();
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.drawImage(picture, 0, 0);
        lctx.restore();
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
    }
  }

  /** Image fill modes: cover (FILL), contain (FIT), stretch, and tiling at a scale. */
  private fillImage(ctx: Ctx2D, doc: Document, paint: ImagePaint, path: Path2D, w: number, h: number): void {
    ctx.save();
    ctx.clip(path);
    ctx.globalAlpha *= paint.opacity;
    const blend = paint.blendMode ? BLEND[paint.blendMode] : undefined;
    if (blend) ctx.globalCompositeOperation = blend;
    const decoded = this.images.adjusted(doc, paint.imageHash, paint.rotation ?? 0, paint.filters, paint.flipX, paint.flipY);
    if (!decoded) {
      // Placeholder while decoding (or when the image is missing): a light checkerboard.
      ctx.fillStyle = '#E8E8E8';
      ctx.fill(path);
      ctx.fillStyle = '#D6D6D6';
      const cell = Math.max(4, Math.min(w, h) / 8);
      for (let y = 0; y < h; y += cell) for (let x = (Math.floor(y / cell) % 2) * cell; x < w; x += cell * 2) ctx.fillRect(x, y, cell, cell);
      ctx.restore();
      return;
    }
    const { image, width: iw, height: ih } = decoded;
    if (iw > 0 && ih > 0) {
      if (paint.scaleMode === 'STRETCH') ctx.drawImage(image, 0, 0, w, h);
      else if (paint.scaleMode === 'TILE') {
        const pattern = ctx.createPattern(image, 'repeat');
        if (pattern) {
          const k = paint.scale > 0 ? paint.scale : 1;
          pattern.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
          ctx.fillStyle = pattern;
          ctx.fill(path);
        }
      } else {
        const k = paint.scaleMode === 'FIT' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
        const dw = iw * k;
        const dh = ih * k;
        ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }
    }
    ctx.restore();
  }

  private strokePath(ctx: Ctx2D, d: Document, id: NodeId, path: Path2D, forceCenter = false): void {
    const strokes = d.get(id, 'strokes').filter((s) => s.visible);
    const sides = d.get(id, 'strokeWeights');
    const weight = d.get(id, 'strokeWeight');
    if (strokes.length === 0 || (sides ? Math.max(...sides) : weight) <= 0) return;
    // A width profile or a brush: the stroke is a shape around the path (always centred on it).
    if (isVariableStroke(d.get(id, 'strokeProfile'), d.get(id, 'brush'))) {
      this.variableStroke(ctx, d, id, strokes);
      return;
    }
    const align = forceCenter ? 'CENTER' : d.get(id, 'strokeAlign');
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    ctx.save();
    ctx.lineCap = CAPS[d.get(id, 'strokeCap')];
    ctx.lineJoin = JOINS[d.get(id, 'strokeJoin')];
    ctx.miterLimit = Math.max(1, d.get(id, 'strokeMiterLimit'));
    // Different weights per side (FR-DRW-060): the stroke is the area between two contours.
    if (sides && !forceCenter && RECT_LIKE.has(d.type(id))) {
      const dash = dashOf(d, id);
      if (dash.length > 0) {
        this.strokeSidesDashed(ctx, strokes, sides, align, w, h, dash);
      } else {
        const region = pathOf(sideStrokeRegion(w, h, rectRadii(d, id, w, h), sides, align));
        for (const paint of strokes) {
          ctx.fillStyle = this.inkStyle(ctx, paint, w, h);
          ctx.fill(region, 'evenodd');
        }
      }
      ctx.restore();
      return;
    }
    ctx.setLineDash(dashOf(d, id));
    if (align === 'INSIDE') {
      ctx.clip(path);
      ctx.lineWidth = weight * 2;
    } else if (align === 'OUTSIDE') {
      const outside = new Path2D();
      const pad = weight * 2 + 2 + weight * ctx.miterLimit;
      outside.rect(-pad, -pad, w + pad * 2, h + pad * 2);
      outside.addPath(path);
      ctx.clip(outside, 'evenodd');
      ctx.lineWidth = weight * 2;
    } else {
      ctx.lineWidth = weight;
    }
    for (const paint of strokes) {
      ctx.strokeStyle = this.inkStyle(ctx, paint, w, h);
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /** A stroke of varying width: its shape filled with each stroke paint; pencil and chalk with grain. */
  private variableStroke(ctx: Ctx2D, d: Document, id: NodeId, strokes: readonly Paint[]): void {
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const brush = d.get(id, 'brush');
    const outline = pathOf(variableStrokeOf(d, id));
    for (const stored of strokes) {
      const paint = this.inked(stored);
      const grain = (brush === 'PENCIL' || brush === 'CHALK') && paint.type === 'SOLID' ? this.grain(ctx, paint.color, paint.opacity, brush === 'CHALK' ? 0.55 : 0.3) : null;
      ctx.fillStyle = grain ?? this.paintStyle(ctx, paint, w, h);
      ctx.fill(outline, 'nonzero');
    }
  }

  private readonly grains = new Map<string, CanvasPattern>();

  /** A tile of the stroke's colour with uneven transparency: paper showing through pencil or chalk. */
  private grain(ctx: Ctx2D, color: Color, opacity: number, amount: number): CanvasPattern | null {
    const key = `${cssColor(color, opacity)}|${amount}`;
    const known = this.grains.get(key);
    if (known) return known;
    if (typeof OffscreenCanvas === 'undefined') return null;
    const size = 64;
    const tile = new OffscreenCanvas(size, size);
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    const image = tctx.createImageData(size, size);
    let seed = 0x5bd1e995;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const r = (seed >>> 8) / 0xffffff;
      image.data[i] = color.r * 255;
      image.data[i + 1] = color.g * 255;
      image.data[i + 2] = color.b * 255;
      image.data[i + 3] = 255 * color.a * opacity * (1 - amount * r * r);
    }
    tctx.putImageData(image, 0, 0);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (pattern) this.grains.set(key, pattern);
    return pattern;
  }

  /** Dashed per-side strokes: each side is its own dashed line (corners are not rounded). */
  private strokeSidesDashed(ctx: Ctx2D, strokes: readonly Paint[], sides: readonly number[], align: string, w: number, h: number, dash: number[]): void {
    const k = align === 'INSIDE' ? 0.5 : align === 'CENTER' ? 0 : -0.5;
    const [t, r, b, l] = sides as [number, number, number, number];
    const lines: [number, number, number, number, number][] = [
      [0, t * k, w, t * k, t],
      [w - r * k, 0, w - r * k, h, r],
      [w, h - b * k, 0, h - b * k, b],
      [l * k, h, l * k, 0, l],
    ];
    ctx.setLineDash(dash);
    for (const paint of strokes) {
      ctx.strokeStyle = this.inkStyle(ctx, paint, w, h);
      for (const [x1, y1, x2, y2, lw] of lines) {
        if (lw <= 0) continue;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
  }

  /** Line ends of lines and open vectors (FR-DRW-062), in the stroke colour. */
  private drawEnds(ctx: Ctx2D, d: Document, id: NodeId, paths: readonly VectorPath[]): void {
    const strokes = d.get(id, 'strokes').filter((s) => s.visible);
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
        const path = pathOf(shape.paths);
        for (const paint of strokes) {
          const style = this.inkStyle(ctx, paint, w, 1);
          ctx.save();
          if (shape.filled) {
            ctx.fillStyle = style;
            ctx.fill(path);
          } else {
            ctx.strokeStyle = style;
            ctx.lineWidth = weight;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.stroke(path);
          }
          ctx.restore();
        }
      }
    }
  }

  /**
   * A sticky is a note of paper, not a plain square: under it, the shadow of
   * its lifted lower corners; on it, the darker band where it is glued and a
   * little shade toward the curling bottom. Drawn here, so every sticky — old
   * ones too — looks the same, without extra layers in the file.
   */
  private stickyCurl(ctx: Ctx2D, w: number, h: number): void {
    const m = ctx.getTransform();
    const k = Math.hypot(m.a, m.b);
    if (w * k < 24) return;
    ctx.save();
    // As a note in Miro: a soft shadow under the bottom edge, deeper at the corners (lifted paper).
    ctx.shadowColor = 'rgba(0, 0, 0, 0.36)';
    ctx.shadowBlur = 22 * k;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 14 * k;
    ctx.fillStyle = '#000';
    const curl = new Path2D();
    curl.moveTo(w * 0.03, h * 0.6);
    curl.lineTo(w * 0.97, h * 0.6);
    curl.lineTo(w * 0.985, h - 1);
    curl.quadraticCurveTo(w / 2, h - 7, w * 0.015, h - 1);
    curl.closePath();
    ctx.fill(curl);
    ctx.restore();
  }

  private stickyPaper(ctx: Ctx2D, path: Path2D, w: number, h: number): void {
    const m = ctx.getTransform();
    if (w * Math.hypot(m.a, m.b) < 24) return;
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.045)';
    ctx.fillRect(0, 0, w, Math.min(h * 0.13, 32));
    const shade = ctx.createLinearGradient(0, h * 0.6, 0, h);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0.05)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, h * 0.6, w, h * 0.4);
    ctx.restore();
  }

  private drawShadows(ctx: Ctx2D, d: Document, id: NodeId, path: Path2D): void {
    // A shadow of a layer a few pixels across is invisible, and blurs are what costs most.
    if (this.lod && Math.max(d.get(id, 'width'), d.get(id, 'height')) * this.zoom < 16) return;
    for (const effect of d.get(id, 'effects')) {
      if (!effect.visible || effect.type !== 'DROP_SHADOW') continue;
      ctx.save();
      // As in Figma, the shadow is not shown through the object's own transparent areas (unless asked to).
      if (!effect.showBehind) {
        const box = this.shapeBox(ctx);
        const outside = new Path2D();
        outside.rect(box.x, box.y, box.w, box.h);
        outside.addPath(path);
        ctx.clip(outside, 'evenodd');
      }
      const blend = effect.blendMode ? BLEND[effect.blendMode] : undefined;
      if (blend) ctx.globalCompositeOperation = blend;
      // Shadow parameters are in device pixels, unaffected by the transform.
      // The shape is drawn far off-screen and only its shadow is shifted back into
      // view, so semi-transparent fills never show a black silhouette.
      const FAR = 100_000;
      const m = ctx.getTransform();
      const det = m.a * m.d - m.b * m.c;
      if (Math.abs(det) < 1e-12) {
        ctx.restore();
        continue;
      }
      ctx.shadowColor = cssColor(effect.color);
      ctx.shadowBlur = effect.radius * this.zoom;
      ctx.shadowOffsetX = effect.offset.x * m.a + effect.offset.y * m.c + FAR;
      ctx.shadowOffsetY = effect.offset.x * m.b + effect.offset.y * m.d;
      ctx.translate((-FAR * m.d) / det, (FAR * m.b) / det);
      ctx.fillStyle = '#000';
      ctx.fill(path);
      // Spread grows the shadow's shape by stroking its outline.
      if (effect.spread > 0) {
        ctx.lineWidth = effect.spread * 2;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#000';
        ctx.stroke(path);
      }
      ctx.restore();
    }
  }

  /** A rectangle (in the current local space) that covers the whole visible area, for "everything but the shape" clips. */
  private shapeBox(ctx: Ctx2D): { x: number; y: number; w: number; h: number } {
    const inv = ctx.getTransform().inverse();
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const pts = [new DOMPoint(0, 0), new DOMPoint(W, 0), new DOMPoint(0, H), new DOMPoint(W, H)].map((p) => inv.transformPoint(p));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x = Math.min(...xs) - 10;
    const y = Math.min(...ys) - 10;
    return { x, y, w: Math.max(...xs) - x + 20, h: Math.max(...ys) - y + 20 };
  }

  /** "Frosted glass": blurs what is already drawn below the shape, inside the shape. */
  private drawBackgroundBlur(ctx: Ctx2D, d: Document, id: NodeId, path: Path2D): void {
    // Background blur and glass share one place under the layer: the first of them is drawn, as in Figma.
    const under = d.get(id, 'effects').find((e) => e.visible && (e.type === 'BACKGROUND_BLUR' || e.type === 'GLASS'));
    if (under?.type === 'GLASS') {
      // The whole lens, past the canvas edge too: a tile must see the shape its neighbours see.
      const scale = Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1;
      const box = this.sceneNow ? this.deviceRect(ctx, this.sceneNow, id, 2, Math.ceil(under.depth * scale * 2 + 4), true) : null;
      if (!box) return;
      const mask = new OffscreenCanvas(box.w, box.h);
      const mctx = mask.getContext('2d')!;
      const m = ctx.getTransform();
      mctx.setTransform(m.a, m.b, m.c, m.d, m.e - box.x, m.f - box.y);
      mctx.fillStyle = '#000';
      mctx.fill(path);
      this.glassUnder(ctx, under, mask, box);
      return;
    }
    const blur = under;
    if (!blur || blur.type !== 'BACKGROUND_BLUR' || (blur.radius <= 0 && !blur.progressive)) return;
    const source = ctx.canvas;
    if (blur.progressive) {
      // Progressive: the backdrop in bands from weak to strong, inside the shape.
      const w = d.get(id, 'width');
      const h = d.get(id, 'height');
      const m = ctx.getTransform();
      const a = m.transformPoint(new DOMPoint(blur.progressive.from.x * w, blur.progressive.from.y * h));
      const b = m.transformPoint(new DOMPoint(blur.progressive.to.x * w, blur.progressive.to.y * h));
      const copy = new OffscreenCanvas(source.width, source.height);
      copy.getContext('2d')?.drawImage(source, 0, 0);
      const out = this.blendBands(copy, a, b, blur.progressive.start, blur.radius);
      ctx.save();
      ctx.clip(path);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(out, 0, 0);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.clip(path);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Copy the backdrop first: drawing a canvas onto itself with a filter is not reliable everywhere.
    const copy = new OffscreenCanvas(source.width, source.height);
    copy.getContext('2d')?.drawImage(source, 0, 0);
    drawBlurred(ctx, copy, blur.radius * this.zoom);
    ctx.restore();
  }

  /** Inner shadows and noise: drawn over the fill, clipped to the shape. */
  private drawInnerEffects(ctx: Ctx2D, d: Document, id: NodeId, path: Path2D, w: number, h: number): void {
    for (const effect of d.get(id, 'effects')) {
      if (!effect.visible) continue;
      if (effect.type === 'INNER_SHADOW') {
        ctx.save();
        ctx.clip(path);
        const m = ctx.getTransform();
        // A frame around the shape (shape cut out) casts its shadow inwards.
        const pad = Math.max(w, h) + Math.abs(effect.offset.x) + Math.abs(effect.offset.y) + effect.radius * 3 + Math.abs(effect.spread) + 10;
        const ring = new Path2D();
        ring.rect(-pad, -pad, w + pad * 2, h + pad * 2);
        ring.addPath(path);
        ctx.shadowColor = cssColor(effect.color);
        ctx.shadowBlur = effect.radius * this.zoom;
        ctx.shadowOffsetX = effect.offset.x * m.a + effect.offset.y * m.c;
        ctx.shadowOffsetY = effect.offset.x * m.b + effect.offset.y * m.d;
        const blend = effect.blendMode ? BLEND[effect.blendMode] : undefined;
        if (blend) ctx.globalCompositeOperation = blend;
        ctx.fillStyle = '#000';
        ctx.fill(ring, 'evenodd');
        if (effect.spread > 0) {
          ctx.lineWidth = effect.spread * 2;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = '#000';
          ctx.stroke(path);
        }
        ctx.restore();
      } else if (effect.type === 'NOISE' && (effect.amount > 0 || effect.noiseType)) {
        const pattern = effect.noiseType ? this.colourNoise(ctx, effect) : this.noisePattern(ctx);
        if (!pattern) continue;
        ctx.save();
        ctx.clip(path);
        const k = Math.max(0.25, effect.size);
        pattern.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0]));
        if (effect.noiseType) {
          const blend = effect.blendMode ? BLEND[effect.blendMode] : undefined;
          if (blend) ctx.globalCompositeOperation = blend;
        } else {
          ctx.globalAlpha *= Math.min(1, effect.amount);
          ctx.globalCompositeOperation = 'overlay';
        }
        ctx.fillStyle = pattern;
        ctx.fill(path);
        ctx.restore();
      }
    }
  }

  private noise: CanvasPattern | null = null;

  /** A tile of random grey pixels, generated once (deterministic, so exports match the canvas). */
  private noisePattern(ctx: Ctx2D): CanvasPattern | null {
    if (this.noise) return this.noise;
    const size = 128;
    const tile = new OffscreenCanvas(size, size);
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    const image = tctx.createImageData(size, size);
    let seed = 0x2f6b3a1d;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = seed >>> 24;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = 255;
    }
    tctx.putImageData(image, 0, 0);
    this.noise = ctx.createPattern(tile, 'repeat');
    return this.noise;
  }

  private applyLayerBlur(ctx: Ctx2D, d: Document, id: NodeId): void {
    const blur = d.get(id, 'effects').find((e) => e.visible && e.type === 'LAYER_BLUR');
    // A progressive one is drawn by drawProgressive (the layer first, then blurred in bands), a plain one
    // by drawLayerBlur (sharp inside its picture); this is the fallback without offscreen canvases.
    if (typeof OffscreenCanvas !== 'undefined') return;
    if (blur && blur.type === 'LAYER_BLUR' && !blur.progressive) ctx.filter = `blur(${blur.radius * this.zoom}px)`;
  }

  /**
   * Layer blur (BUG-129): the layer is drawn sharp into its own picture reaching past
   * the tile by the blur's reach, then put on blurred — so a tile's edge does not show
   * as a seam, and Safari, whose canvas has no filters, blurs too. True when it handled the node.
   */
  private drawLayerBlur(ctx: Ctx2D, scene: SceneGraph, id: NodeId): boolean {
    const blur = scene.doc.get(id, 'effects').find((e) => e.visible && e.type === 'LAYER_BLUR');
    if (!blur || blur.type !== 'LAYER_BLUR' || blur.progressive || blur.radius <= 0) return false;
    const radius = blur.radius * this.zoom;
    const reach = Math.ceil(radius * 3) + 2;
    return this.drawIsolated(ctx, scene, id, 'layer-blur', reach, reach, (layer, box) => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawBlurred(ctx, layer, radius, box.x, box.y);
      ctx.restore();
    });
  }

  /** The layer drawn by drawWarped right now (drawn flat into its picture). */
  private warpNow: NodeId | null = null;

  /**
   * A warped layer (mockups): it is drawn flat into a picture of its own, with a
   * margin for strokes and shadows, and the picture is laid on through a mesh of
   * small triangles, each an affine piece of the warp. True when it handled the node.
   */
  private drawWarped(ctx: Ctx2D, scene: SceneGraph, id: NodeId): boolean {
    const d = scene.doc;
    const warp = d.get(id, 'warp');
    if (!warp || this.warpNow === id || typeof OffscreenCanvas === 'undefined') return false;
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    if (w <= 0 || h <= 0) return false;
    const m = ctx.getTransform();
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
    // Every tile and every copy of a repeat draws the layer: the picture is made once per change and zoom.
    // While a gesture goes on (`draft`) the picture is coarser: a resize makes it anew every frame.
    // A layer without layers inside is keyed by what it is, not by its id: the copies of a repeat share one picture.
    const key = d.children(id).length === 0 ? looksOf(d.store.record(id)?.props) : id;
    const version = key === id ? scene.paintVersion(id) : scene.allPaintVersion;
    let cached = this.warpCache.get(key);
    if (!cached || cached.version !== version || Math.abs(cached.scale - scale) > scale * 1e-3 || (cached.draft && !this.draft)) {
      const made = this.warpPicture(scene, id, warp, w, h, scale);
      if (!made) return false;
      if (this.warpCache.size > 256) this.warpCache.clear();
      cached = { version, scale, draft: this.draft, ...made };
      this.warpCache.set(key, cached);
    }
    if (cached.draft) this.drafted.add(id);
    ctx.save();
    ctx.translate(d.get(id, 'x'), d.get(id, 'y'));
    const rotation = d.get(id, 'rotation');
    if (rotation !== 0) ctx.rotate((rotation * Math.PI) / 180);
    // The layer's opacity is in the picture already; its blend mode mixes the picture with what is below.
    const blend = BLEND[d.get(id, 'blendMode')];
    if (blend) ctx.globalCompositeOperation = blend;
    if (cached.picture) {
      const { picture, box } = cached;
      ctx.drawImage(picture, box.x, box.y, box.width, box.height);
    } else {
      // Too big for one picture (zoomed far in): the mesh straight onto the canvas.
      drawMesh(ctx, cached.texture, cached.mesh, 0.6 / scale);
    }
    ctx.restore();
    return true;
  }

  /** A gesture is going on: warped pictures are made coarser, and again in full once it ends. */
  draft = false;
  /** Layers drawn coarser while `draft`: to be drawn again once the gesture ends. */
  readonly drafted = new Set<NodeId>();

  /** Warped pictures by layer: made for one version of the layer and zoom. */
  private readonly warpCache = new Map<string, { version: number; scale: number; draft: boolean; texture: OffscreenCanvas; mesh: WarpMesh; picture: OffscreenCanvas | null; box: Rect }>();

  /**
   * The layer drawn flat into a texture (with a margin for strokes and shadows), the mesh
   * that lays it on, and — when not too big — the warped result at `scale`, in layer units `box`.
   */
  private warpPicture(scene: SceneGraph, id: NodeId, warp: Warp, w: number, h: number, scale: number): { texture: OffscreenCanvas; mesh: WarpMesh; picture: OffscreenCanvas | null; box: Rect } | null {
    const d = scene.doc;
    const margin = scene.paintMargins(id);
    const fullW = w + margin.left + margin.right;
    const fullH = h + margin.top + margin.bottom;
    // Stretching enlarges parts of the picture: a little more detail than the screen shows, within limits.
    const S = Math.min(scale * (this.draft ? 0.75 : 1.5), WARP_SIDE / fullW, WARP_SIDE / fullH, Math.sqrt(WARP_AREA / (fullW * fullH)));
    const texture = new OffscreenCanvas(Math.max(1, Math.ceil(fullW * S)), Math.max(1, Math.ceil(fullH * S)));
    const tctx = texture.getContext('2d');
    if (!tctx) return null;
    // The layer's own space: undo the place drawNode puts it at.
    tctx.setTransform(S, 0, 0, S, margin.left * S, margin.top * S);
    const rotation = d.get(id, 'rotation');
    if (rotation !== 0) tctx.rotate((-rotation * Math.PI) / 180);
    tctx.translate(-d.get(id, 'x'), -d.get(id, 'y'));
    const previous = { zoom: this.zoom, culling: this.culling };
    this.zoom = S;
    this.culling = false;
    this.warpNow = id;
    try {
      this.drawNode(tctx, scene, id, true);
    } finally {
      this.warpNow = null;
      this.zoom = previous.zoom;
      this.culling = previous.culling;
    }
    if (warp.type === 'CYLINDER' && warp.shade > 0) {
      // The sides turn away from the light: darker over what is drawn.
      tctx.setTransform(S, 0, 0, S, margin.left * S, margin.top * S);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = 'source-atop';
      const vertical = warp.axis === 'VERTICAL';
      const g = vertical ? tctx.createLinearGradient(0, 0, w, 0) : tctx.createLinearGradient(0, 0, 0, h);
      for (let i = 0; i <= 16; i++) g.addColorStop(i / 16, `rgba(0,0,0,${(warp.shade * 0.85 * cylinderShade(warp, i / 16) ** 1.5).toFixed(3)})`);
      tctx.fillStyle = g;
      tctx.fillRect(-margin.left, -margin.top, fullW, fullH);
    }
    const map = warpMap(warp);
    const grid = warpGrid(warp);
    // During a gesture half as many triangles: each is a clip and a copy.
    const cols = this.draft ? Math.max(2, Math.ceil(grid.cols / 2)) : grid.cols;
    const rows = this.draft ? Math.max(2, Math.ceil(grid.rows / 2)) : grid.rows;
    // The mesh covers the margin too: the warp goes on a little beyond the box.
    const u0 = -margin.left / w;
    const u1 = 1 + margin.right / w;
    const v0 = -margin.top / h;
    const v1 = 1 + margin.bottom / h;
    const src: Point[] = [];
    const dst: Point[] = [];
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const u = u0 + ((u1 - u0) * i) / cols;
        const v = v0 + ((v1 - v0) * j) / rows;
        src.push({ x: (u * w + margin.left) * S, y: (v * h + margin.top) * S });
        const q = map(u, v);
        dst.push({ x: q.x * w, y: q.y * h });
      }
    }
    const mesh: WarpMesh = { src, dst, cols, rows };
    // The result's box in layer units, a pixel of room for the edges.
    const finite = dst.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const k = this.draft ? scale * 0.5 : scale;
    const pad = 2 / k;
    const minX = Math.min(...finite.map((p) => p.x)) - pad;
    const minY = Math.min(...finite.map((p) => p.y)) - pad;
    const pw = Math.ceil((Math.max(...finite.map((p) => p.x)) + pad - minX) * k);
    const ph = Math.ceil((Math.max(...finite.map((p) => p.y)) + pad - minY) * k);
    if (!finite.length || !(pw > 0 && ph > 0) || pw > WARP_SIDE || ph > WARP_SIDE || pw * ph > WARP_AREA) {
      return { texture, mesh, picture: null, box: { x: 0, y: 0, width: 0, height: 0 } };
    }
    const picture = new OffscreenCanvas(pw, ph);
    const pctx = picture.getContext('2d');
    if (!pctx) return { texture, mesh, picture: null, box: { x: 0, y: 0, width: 0, height: 0 } };
    pctx.setTransform(k, 0, 0, k, -minX * k, -minY * k);
    drawMesh(pctx, texture, mesh, 0.6 / k);
    return { texture, mesh, picture, box: { x: minX, y: minY, width: pw / k, height: ph / k } };
  }

  /** The scene being drawn (patterns and glass need it where only the document is passed). */
  private sceneNow: SceneGraph | null = null;

  /**
   * Where a layer paints on the device canvas: its render bounds through the current
   * transform (the context is in the layer's parent space), grown by `pad` device px and
   * cut to the canvas. Null — nothing of it on the canvas.
   */
  private deviceRect(ctx: Ctx2D, scene: SceneGraph, id: NodeId, pad = 0, beyond = 0, own = false): Box | null {
    // The context is in the layer's parent space, or (`own`) already in the layer's own.
    const space = own ? id : scene.doc.parent(id);
    let m = ctx.getTransform();
    if (space && scene.doc.type(space) !== 'PAGE') {
      const p = scene.world(space);
      m = m.multiply(new DOMMatrix([p.a, p.b, p.c, p.d, p.e, p.f]).inverse());
    }
    const r = scene.renderBounds(id);
    const pts = [m.transformPoint(new DOMPoint(r.x, r.y)), m.transformPoint(new DOMPoint(r.x + r.width, r.y)), m.transformPoint(new DOMPoint(r.x, r.y + r.height)), m.transformPoint(new DOMPoint(r.x + r.width, r.y + r.height))];
    // `beyond`: how far past the canvas the box may reach (what draws there is needed nearby).
    const x0 = Math.max(-beyond, Math.floor(Math.min(...pts.map((p) => p.x)) - pad));
    const y0 = Math.max(-beyond, Math.floor(Math.min(...pts.map((p) => p.y)) - pad));
    const x1 = Math.min(ctx.canvas.width + beyond, Math.ceil(Math.max(...pts.map((p) => p.x)) + pad));
    const y1 = Math.min(ctx.canvas.height + beyond, Math.ceil(Math.max(...pts.map((p) => p.y)) + pad));
    if (!(x1 > x0 && y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Layers drawn whole into a picture of their own right now (texture, plus darker): drawn plainly inside. */
  private readonly isolated = new Set<string>();

  /**
   * Draws the layer into a canvas of the device size, then hands it on with the box it
   * paints in. False — not done (already inside, or no offscreen canvases).
   */
  private drawIsolated(ctx: Ctx2D, scene: SceneGraph, id: NodeId, kind: string, pad: number, beyond: number, finish: (layer: OffscreenCanvas, box: Box) => void): boolean {
    const key = `${kind}:${id}`;
    if (this.isolated.has(key) || typeof OffscreenCanvas === 'undefined' || ctx.canvas.width === 0 || ctx.canvas.height === 0) return false;
    // The picture covers the box (past the canvas edge by `beyond`: a tile's texture needs its neighbours' pixels).
    const box = this.deviceRect(ctx, scene, id, pad, beyond);
    if (!box) return true;
    const layer = new OffscreenCanvas(box.w, box.h);
    const lctx = layer.getContext('2d');
    if (!lctx) return false;
    const m = ctx.getTransform();
    lctx.setTransform(m.a, m.b, m.c, m.d, m.e - box.x, m.f - box.y);
    this.isolated.add(key);
    // Its parts just past the canvas edge count too: no culling inside.
    const culling = this.culling;
    this.culling = false;
    try {
      this.drawNode(lctx, scene, id, true);
    } finally {
      this.isolated.delete(key);
      this.culling = culling;
    }
    finish(layer, box);
    return true;
  }

  /** Puts pixels of the box size onto the canvas at the box (under the context's clip and opacity). */
  private putBox(ctx: Ctx2D, pixels: ImageData, box: Box): void {
    const tmp = new OffscreenCanvas(box.w, box.h);
    tmp.getContext('2d')!.putImageData(pixels, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(tmp, box.x, box.y);
    ctx.restore();
  }

  /** Texture (Figma): the layer's edges roughened — its picture, each pixel taken from a little way off. */
  private drawTextured(ctx: Ctx2D, scene: SceneGraph, id: NodeId): boolean {
    const d = scene.doc;
    const tex = d.get(id, 'effects').find((e) => e.visible && e.type === 'TEXTURE');
    if (!tex || tex.type !== 'TEXTURE' || tex.radius <= 0) return false;
    const scale = Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1;
    const reach = tex.radius * scale;
    return this.drawIsolated(ctx, scene, id, 'texture', reach + 2, reach + 2, (layer, box) => {
      const lctx = layer.getContext('2d')!;
      const src = lctx.getImageData(0, 0, box.w, box.h);
      // The grain is tied to the layer: it moves with it, not with the screen.
      const origin = ctx.getTransform().transformPoint(new DOMPoint(d.get(id, 'x'), d.get(id, 'y')));
      const out = roughen(src, Math.max(0.5, tex.size * scale), reach, box.x - origin.x, box.y - origin.y);
      if (tex.clipToShape) {
        const o = out.data;
        const s2 = src.data;
        for (let i = 3; i < o.length; i += 4) o[i] = (o[i]! * s2[i]!) / 255;
      }
      this.putBox(ctx, out, box);
    });
  }

  /** Plus darker for a whole layer: exact, from the pixels already drawn under it. */
  private drawPlusDarker(ctx: Ctx2D, scene: SceneGraph, id: NodeId): boolean {
    if (scene.doc.get(id, 'blendMode') !== 'PLUS_DARKER') return false;
    return this.drawIsolated(ctx, scene, id, 'plus-darker', 1, 0, (layer, box) => {
      const base = ctx.getImageData(box.x, box.y, box.w, box.h);
      plusDarker(base, layer.getContext('2d')!.getImageData(0, 0, box.w, box.h));
      this.putBox(ctx, base, box);
    });
  }

  /** A mask by its outline or brightness: the mask layer drawn on its own and turned into opacity. */
  private maskPicture(ctx: Ctx2D, scene: SceneGraph, id: NodeId, type: MaskType): OffscreenCanvas {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const out = new OffscreenCanvas(W, H);
    const octx = out.getContext('2d')!;
    octx.setTransform(ctx.getTransform());
    this.drawNode(octx, scene, id, true);
    const box = this.deviceRect(ctx, scene, id, 2);
    if (!box) return out;
    const img = octx.getImageData(box.x, box.y, box.w, box.h);
    if (type === 'VECTOR') vectorMask(img);
    else luminanceMask(img);
    octx.putImageData(img, box.x, box.y);
    return out;
  }

  /**
   * Glass under a layer: what is already drawn in the box, frosted, bent along the
   * layer's edge and lit; `mask` (box size) — where the layer is.
   */
  private glassUnder(ctx: Ctx2D, e: GlassEffect, mask: OffscreenCanvas, box: Box): void {
    const scale = Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1;
    const depth = Math.max(1, e.depth * scale);
    const back = new OffscreenCanvas(box.w, box.h);
    const bctx = back.getContext('2d')!;
    drawBlurred(bctx, ctx.canvas, e.frost > 0 ? e.frost * scale : 0, -box.x, -box.y);
    const dome = new OffscreenCanvas(box.w, box.h);
    const dctx = dome.getContext('2d')!;
    drawBlurred(dctx, mask, depth / 2);
    const mctx = mask.getContext('2d')!;
    // Only the part of the box on the canvas has a backdrop to take from.
    const valid = { x0: Math.max(0, -box.x), y0: Math.max(0, -box.y), x1: Math.min(box.w, ctx.canvas.width - box.x), y1: Math.min(box.h, ctx.canvas.height - box.y) };
    if (valid.x1 <= valid.x0 || valid.y1 <= valid.y0) return;
    const out = glassPixels(bctx.getImageData(0, 0, box.w, box.h), dctx.getImageData(0, 0, box.w, box.h), mctx.getImageData(0, 0, box.w, box.h), {
      refraction: e.refraction,
      depth,
      dispersion: e.dispersion,
      lightAngle: e.lightAngle,
      lightIntensity: e.lightIntensity,
      splay: e.splay,
    }, valid);
    this.putBox(ctx, out, box);
  }

  /** Coloured noise tiles (one, two or many colours), the last few kept. */
  private readonly colourNoises = new Map<string, CanvasPattern>();

  private colourNoise(ctx: Ctx2D, e: NoiseEffect): CanvasPattern | null {
    const kind = e.noiseType ?? 'MONO';
    const color = e.color ?? { r: 0, g: 0, b: 0, a: 0.25 };
    const second = e.secondaryColor ?? { r: 1, g: 1, b: 1, a: 0.25 };
    const density = Math.min(1, Math.max(0, e.density ?? 0.5));
    const key = JSON.stringify([kind, color, second, density, e.amount]);
    const known = this.colourNoises.get(key);
    if (known) return known;
    const tile = new OffscreenCanvas(128, 128);
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    tctx.putImageData(noiseTile(kind, density, color, second, Math.min(1, Math.max(0, e.amount))), 0, 0);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return null;
    if (this.colourNoises.size > 32) this.colourNoises.delete(this.colourNoises.keys().next().value!);
    this.colourNoises.set(key, pattern);
    return pattern;
  }

  /** Sources of patterns being drawn right now (a pattern that contains itself is not drawn again). */
  private readonly patternNow = new Set<NodeId>();

  /**
   * A pattern fill: the source layer drawn into a tile (with the spacing round it; a
   * hexagonal tile holds two rows or columns, the second shifted by half), repeated in
   * the layer's own space at the paint's scale.
   */
  private patternStyle(ctx: Ctx2D, paint: PatternPaint, w: number): CanvasPattern | null {
    const scene = this.sceneNow;
    const src = paint.sourceId;
    if (!scene || !src || typeof OffscreenCanvas === 'undefined' || !scene.doc.store.isAlive(src) || this.patternNow.has(src)) return null;
    const d = scene.doc;
    const sw = d.get(src, 'width');
    const sh = d.get(src, 'height');
    if (sw <= 0 || sh <= 0) return null;
    const m = ctx.getTransform();
    const dev = Math.hypot(m.a, m.b) || 1;
    const scale = paint.scale > 0 ? paint.scale : 1;
    // Device px per unit of the source, within a tile of at most 2048 px.
    const k = Math.min(dev * scale, 2048 / Math.max(sw, sh));
    const cellW = sw * (1 + Math.max(0, paint.spacing.x));
    const cellH = sh * (1 + Math.max(0, paint.spacing.y));
    const hexH = paint.tileType === 'HORIZONTAL_HEXAGONAL';
    const hexV = paint.tileType === 'VERTICAL_HEXAGONAL';
    const tileW = cellW * (hexV ? 2 : 1);
    const tileH = cellH * (hexH ? 2 : 1);
    const tile = new OffscreenCanvas(Math.max(1, Math.ceil(tileW * k)), Math.max(1, Math.ceil(tileH * k)));
    const tctx = tile.getContext('2d');
    if (!tctx) return null;
    const place = (x: number, y: number) => {
      tctx.setTransform(k, 0, 0, k, x * k, y * k);
      // The source's own place in its parent is undone: the tile holds just the source.
      const r = d.get(src, 'rotation');
      if (r) tctx.rotate((-r * Math.PI) / 180);
      tctx.translate(-d.get(src, 'x'), -d.get(src, 'y'));
      const previous = this.standalone;
      this.renderNode(tctx, scene, src, { x: -1e9, y: -1e9, width: 2e9, height: 2e9 }, k);
      this.standalone = previous;
    };
    this.patternNow.add(src);
    try {
      place(0, 0);
      if (hexH) {
        place(cellW / 2, cellH);
        place(cellW / 2 - cellW, cellH);
      } else if (hexV) {
        place(cellW, cellH / 2);
        place(cellW, cellH / 2 - cellH);
      }
    } finally {
      this.patternNow.delete(src);
    }
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return null;
    // The tile in the layer's units (the source at the paint's scale), placed by the alignment.
    const across = tileW * scale;
    const shift = paint.horizontalAlignment === 'CENTER' ? ((w - across) / 2) % across : paint.horizontalAlignment === 'END' ? w % across : 0;
    pattern.setTransform(new DOMMatrix([scale / k, 0, 0, scale / k, shift, 0]));
    return pattern;
  }

  /** The layer drawn by drawProgressive right now (drawn plainly, without going round again). */
  private progressiveNow: NodeId | null = null;

  /**
   * Progressive layer blur: the layer is drawn sharp into its own canvas, then
   * put back as a few copies blurred more and more, each where its strength
   * belongs (they blend smoothly into each other). True when it handled the node.
   */
  private drawProgressive(ctx: Ctx2D, scene: SceneGraph, id: NodeId): boolean {
    const d = scene.doc;
    const blur = d.get(id, 'effects').find((e) => e.visible && e.type === 'LAYER_BLUR');
    if (!blur || blur.type !== 'LAYER_BLUR' || !blur.progressive || this.progressiveNow === id || typeof OffscreenCanvas === 'undefined') return false;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const layer = new OffscreenCanvas(W, H);
    const lctx = layer.getContext('2d');
    if (!lctx) return false;
    lctx.setTransform(ctx.getTransform());
    this.progressiveNow = id;
    try {
      this.drawNode(lctx, scene, id, true);
    } finally {
      this.progressiveNow = null;
    }
    // Where the blur's ends are on the screen: through the layer's own place.
    const m = ctx.getTransform().multiply(new DOMMatrix().translate(d.get(id, 'x'), d.get(id, 'y')).rotate(d.get(id, 'rotation')));
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const a = m.transformPoint(new DOMPoint(blur.progressive.from.x * w, blur.progressive.from.y * h));
    const b = m.transformPoint(new DOMPoint(blur.progressive.to.x * w, blur.progressive.to.y * h));
    const out = this.blendBands(layer, a, b, blur.progressive.start, blur.radius);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(out, 0, 0);
    ctx.restore();
    return true;
  }

  /**
   * A picture blurred `start` px at screen point `a` up to `end` px at `b`: six
   * copies blurred in steps, each kept around its own place along a → b with a
   * weight that fades into the neighbours' (the weights add up to one).
   */
  private blendBands(source: OffscreenCanvas, a: DOMPoint, b: DOMPoint, start: number, end: number): OffscreenCanvas {
    const W = source.width;
    const H = source.height;
    const bands = 6;
    const acc = new OffscreenCanvas(W, H);
    const actx = acc.getContext('2d')!;
    const tmp = new OffscreenCanvas(W, H);
    const tctx = tmp.getContext('2d')!;
    actx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < bands; k++) {
      const c = k / (bands - 1);
      const step = 1 / (bands - 1);
      const radius = (start + (end - start) * c) * this.zoom;
      tctx.globalCompositeOperation = 'copy';
      drawBlurred(tctx, source, radius);
      tctx.globalCompositeOperation = 'destination-in';
      const g = tctx.createLinearGradient(a.x, a.y, b.x, b.y);
      // A tent around this band's place; the ends hold beyond the handles.
      if (k > 0) g.addColorStop(c - step, 'rgba(0,0,0,0)');
      g.addColorStop(c, 'rgba(0,0,0,1)');
      if (k < bands - 1) g.addColorStop(c + step, 'rgba(0,0,0,0)');
      tctx.fillStyle = g;
      tctx.fillRect(0, 0, W, H);
      actx.drawImage(tmp, 0, 0);
    }
    return acc;
  }

  /** A text on a path drawn as a plain line (while it is being typed into: the caret follows the plain layout). */
  plainTextFor: NodeId | null = null;

  /** Text on a path: each letter along the line, turned with it. */
  private drawPathText(ctx: Ctx2D, d: Document, id: NodeId, w: number, h: number, path: VectorPath[]): void {
    const layout = this.measurer.measure(textStyleOf(d, id), null).layout;
    const nodeFills = d.get(id, 'fills');
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
    for (const g of pathTextGlyphs(layout, path, d.get(id, 'textPathOffset'), d.get(id, 'textAlignH'), this.measurer)) {
      const fills = (g.fragment.style.fills ?? nodeFills).filter((f) => f.visible);
      if (fills.length === 0) continue;
      applyFont(ctx, g.font);
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.angle);
      for (const paint of fills) {
        ctx.fillStyle = this.inkStyle(ctx, paint, w, h);
        ctx.fillText(g.text, 0, g.fragment.shift);
      }
      ctx.restore();
    }
  }

  private drawText(ctx: Ctx2D, d: Document, id: NodeId, w: number, h: number): void {
    const path = d.get(id, 'textPath');
    if (path && this.plainTextFor !== id) {
      this.drawPathText(ctx, d, id, w, h, path);
      return;
    }
    const style = textStyleOf(d, id);
    const autoWidth = d.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT';
    const { layout } = this.measurer.measure(style, autoWidth ? null : w);
    const align = d.get(id, 'textAlignH');
    const valign = d.get(id, 'textAlignV');
    const nodeFills = d.get(id, 'fills');
    const top = valign === 'CENTER' ? (h - layout.height) / 2 : valign === 'BOTTOM' ? h - layout.height : 0;
    // Too small to read: each line is a bar of the text's colour (as Figma does when zoomed out).
    if (this.lod && style.fontSize * this.zoom < 4) {
      const paint = nodeFills.find((f) => f.visible);
      if (!paint) return;
      ctx.save();
      ctx.globalAlpha *= 0.45;
      ctx.fillStyle = this.inkStyle(ctx, paint, w, h);
      for (const line of layout.lines) {
        const last = line.fragments[line.fragments.length - 1];
        const width = last ? last.x + last.width : 0;
        if (width <= 0) continue;
        const size = line.fragments[0]?.font.fontSize ?? style.fontSize;
        ctx.fillRect(line.x + lineOffset(line, w, align), top + line.y + line.baseline - size * 0.62, width, size * 0.62);
      }
      ctx.restore();
      return;
    }
    ctx.textBaseline = 'alphabetic';
    const decoration = decorationLookOf(d, id);
    for (const line of layout.lines) {
      const offset = lineOffset(line, w, align);
      const baseline = top + line.y + line.baseline;
      if (line.marker && line.markerFont) {
        applyFont(ctx, line.markerFont);
        for (const paint of nodeFills) {
          if (!paint.visible) continue;
          ctx.fillStyle = this.inkStyle(ctx, paint, w, h);
          ctx.fillText(line.marker, line.markerX ?? 0, baseline);
        }
      }
      for (const frag of line.fragments) {
        if (frag.text.length === 0) continue;
        const fills = (frag.style.fills ?? nodeFills).filter((f) => f.visible);
        if (fills.length === 0) continue;
        applyFont(ctx, frag.font);
        const spacing = frag.font.letterSpacing.unit === 'PX' ? frag.font.letterSpacing.value : (frag.font.fontSize * frag.font.letterSpacing.value) / 100;
        if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
        const x = line.x + offset + frag.x;
        const y = baseline + frag.shift;
        // Right to left: the browser orders and joins the letters; x stays the fragment's left edge.
        if (line.rtl) {
          ctx.direction = 'rtl';
          ctx.textAlign = 'left';
        }
        for (const paint of fills) {
          ctx.fillStyle = this.inkStyle(ctx, paint, w, h);
          ctx.fillText(frag.text, x, y);
          if (frag.style.textDecoration !== 'NONE') {
            const visible = frag.text.replace(/\s+$/, '');
            const width = visible.length === frag.text.length ? frag.width : this.measurer.width(visible, frag.font);
            ctx.fill(new Path2D(decorationPath(frag.style.textDecoration, x, y, width, frag.font.fontSize, decoration)));
          }
        }
        if (line.rtl) ctx.direction = 'ltr';
      }
    }
    if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
  }


}

/** Canvas path of vector contours (straight segments and cubic curves). */
export function pathOf(paths: readonly VectorPath[]): Path2D {
  const path = new Path2D();
  for (const contour of paths) {
    const pts = contour.points;
    if (pts.length === 0) continue;
    path.moveTo(pts[0]!.x, pts[0]!.y);
    const n = pts.length;
    const count = contour.closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      if (!a.out && !b.in) path.lineTo(b.x, b.y);
      else {
        const c1 = a.out ?? a;
        const c2 = b.in ?? b;
        path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
      }
    }
    if (contour.closed) path.closePath();
  }
  return path;
}

const CAPS: Record<'NONE' | 'ROUND' | 'SQUARE', CanvasLineCap> = { NONE: 'butt', ROUND: 'round', SQUARE: 'square' };
const JOINS: Record<'MITER' | 'ROUND' | 'BEVEL', CanvasLineJoin> = { MITER: 'miter', ROUND: 'round', BEVEL: 'bevel' };

/** What a layer looks like, without where it stands: equal for a layer and its repeat copies. */
function looksOf(props: Record<string, unknown> | undefined): string {
  if (!props) return '';
  const { x: _x, y: _y, rotation: _r, name: _n, repeatCopy: _c, ...rest } = props;
  return JSON.stringify(rest);
}

/** Largest side and area of a warped layer's picture, device pixels. */
const WARP_SIDE = 4096;
const WARP_AREA = 12_000_000;

/** A warp mesh: grid points in the flat texture (pixels) and where they land (layer units). */
interface WarpMesh {
  src: Point[];
  dst: Point[];
  cols: number;
  rows: number;
}

/** The texture laid on through the mesh; neighbouring triangles overlap by `grow`, or their anti-aliased edges show as thin seams. */
function drawMesh(ctx: Ctx2D, texture: OffscreenCanvas, mesh: WarpMesh, grow: number): void {
  const { src, dst, cols, rows } = mesh;
  const at = (i: number, j: number) => j * (cols + 1) + i;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const e = at(i, j + 1);
      drawTriangle(ctx, texture, src[a]!, src[b]!, src[c]!, dst[a]!, dst[b]!, dst[c]!, grow);
      drawTriangle(ctx, texture, src[a]!, src[c]!, src[e]!, dst[a]!, dst[c]!, dst[e]!, grow);
    }
  }
}

/**
 * One triangle of a warp mesh: the part of `image` under s0 s1 s2 drawn onto d0 d1 d2
 * (an affine map), clipped to the destination grown by `grow` against seams.
 */
function drawTriangle(ctx: Ctx2D, image: OffscreenCanvas, s0: Point, s1: Point, s2: Point, d0: Point, d1: Point, d2: Point, grow: number): void {
  const sx1 = s1.x - s0.x;
  const sy1 = s1.y - s0.y;
  const sx2 = s2.x - s0.x;
  const sy2 = s2.y - s0.y;
  const det = sx1 * sy2 - sx2 * sy1;
  if (Math.abs(det) < 1e-9) return;
  const dx1 = d1.x - d0.x;
  const dy1 = d1.y - d0.y;
  const dx2 = d2.x - d0.x;
  const dy2 = d2.y - d0.y;
  // Folded over itself (a corner dragged across): nothing sensible to draw.
  if (!Number.isFinite(dx1 + dy1 + dx2 + dy2)) return;
  const a = (dx1 * sy2 - dx2 * sy1) / det;
  const b = (dy1 * sy2 - dy2 * sy1) / det;
  const c = (dx2 * sx1 - dx1 * sx2) / det;
  const d = (dy2 * sx1 - dy1 * sx2) / det;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const out = (p: Point): Point => {
    const len = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / len) * grow, y: p.y + ((p.y - cy) / len) * grow };
  };
  const p0 = out(d0);
  const p1 = out(d1);
  const p2 = out(d2);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  // Only the source triangle's neighbourhood is copied, not the whole picture.
  const x0 = Math.max(0, Math.floor(Math.min(s0.x, s1.x, s2.x)) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(s0.y, s1.y, s2.y)) - 2);
  const x1 = Math.min(image.width, Math.ceil(Math.max(s0.x, s1.x, s2.x)) + 2);
  const y1 = Math.min(image.height, Math.ceil(Math.max(s0.y, s1.y, s2.y)) + 2);
  if (x1 > x0 && y1 > y0) ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  ctx.restore();
}
