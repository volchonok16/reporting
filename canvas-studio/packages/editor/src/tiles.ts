// The page as tiles on the GPU (ТЗ 6.1–6.2, FR-CNV-001/002). The page is cut
// into squares of TILE device pixels; each square is drawn once by the
// Canvas 2D renderer — the same code as before — and kept as a WebGL
// texture. A frame is then only textured quads: panning and zooming stay
// smooth however heavy the page.
//
// Tiles come in families of one scale. While the zoom changes, families a
// quarter of an octave apart are used (a tile is never shrunk more than
// 1.19×, and tiles drawn before keep being useful); once the view rests, the
// visible tiles are drawn again exactly at the screen's scale (placed on whole
// screen pixels, at most half a pixel from where a direct drawing would put
// them) — the picture at rest is the one Canvas 2D draws. What is
// missing is drawn a few tiles per frame (meanwhile pieces of other families
// stand in); an edit redraws only the tiles under what changed, in the same
// frame — a tile under an edit is never shown, nor stands in for another.
//
// Underneath there is always a base: the whole page at a small scale (at most
// BASE_SIDE pixels across), drawn when the view and the page rest and a frame
// has time to spare, and never evicted. A square nobody drew yet shows this blurred picture instead of the
// bare page background (fast pinches and zooming out uncovered dark holes).

import type { Color, NodeId } from '#core';
import { intersects, unionAll, type Rect } from '#geometry';
import { Viewport, type Canvas2DRenderer, type SceneGraph } from '#render';

/** Side of a tile in device pixels. */
const TILE = 256;
/** Quantized families per doubling of the scale (used while zooming). */
const STEPS = 4;
/** Time a frame may spend drawing tiles that are only missing (edits are drawn at once). */
const BUDGET_MS = 8;
/** How long the zoom must rest before tiles are drawn exactly at the screen's scale. */
const REST_MS = 180;
/** Longest side of the base (the whole page at a small scale), device pixels. */
const BASE_SIDE = 2048;
/** Longest side of a lifted selection's picture, device pixels; a bigger one is not lifted. */
const LIFT_SIDE = 4096;

/** A grid of tiles: scale (device px per world unit) and where it starts on the device pixel grid. */
interface Family {
  key: string;
  scale: number;
  /** Device-pixel phase of the grid (0…1): tiles land on whole screen pixels. */
  px: number;
  py: number;
}

interface Tile {
  family: Family;
  i: number;
  j: number;
  tex: WebGLTexture;
  /** Shown but outdated: redrawn when there is time. */
  stale: boolean;
  /** Under an edit: redrawn before it is shown again. */
  edited: boolean;
  /** What the edits changed on it (world areas): only that part is drawn again; 'all' — the whole tile. */
  dirty: Rect[] | 'all';
  used: number;
}

const VERT = `#version 300 es
in vec2 corner;
uniform vec4 dest;
uniform vec4 src;
out vec2 uv;
void main() {
  vec2 p = dest.xy + corner * dest.zw;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  uv = src.xy + corner * src.zw;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D tex;
out vec4 color;
void main() { color = texture(tex, uv); }`;

export class TileLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly uDest: WebGLUniformLocation;
  private readonly uSrc: WebGLUniformLocation;
  private readonly renderer: Canvas2DRenderer;
  private readonly tiles = new Map<string, Tile>();
  private readonly families = new Map<string, Family>();
  private readonly scratch: OffscreenCanvas | HTMLCanvasElement;
  private readonly scratchCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private frame = 0;
  private lost = false;
  private lastZoom = 0;
  private zoomChanged = 0;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  /** The base family and its tiles over the page content; null — to be found again (content changed). */
  private base: { family: Family; cells: { i: number; j: number }[] } | null = null;
  private baseKnown = false;
  /** When the page last changed: the base is redrawn only once edits and the zoom rest. */
  private lastEdit = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A selection being dragged, lifted off the page: drawn once into its own
   * texture, then only moved — a drag costs the same however heavy the layers.
   */
  private lift: { tex: WebGLTexture; area: Rect; width: number; height: number; scale: number } | null = null;
  /** Asks for a frame (the view came to rest: time for exact tiles). Set by the canvas. */
  onNeedFrame: () => void = () => {};
  /** Statistics of the last frame, for measuring. */
  stats = { drawn: 0, missing: 0, rendered: 0, ms: 0 };

  /** A tile layer, or null when the browser has no WebGL 2 (the canvas then draws as before). */
  static create(renderer: Canvas2DRenderer): TileLayer | null {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
      if (!gl) return null;
      return new TileLayer(canvas, gl, renderer);
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, renderer: Canvas2DRenderer) {
    this.canvas = canvas;
    this.gl = gl;
    this.renderer = renderer;
    canvas.className = 'canvas-tiles';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.tiles.clear();
      this.families.clear();
      this.base = null;
      this.baseKnown = false;
      this.lift = null;
    });
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program');
    this.uDest = gl.getUniformLocation(program, 'dest')!;
    this.uSrc = gl.getUniformLocation(program, 'src')!;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'corner');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);
    if (typeof OffscreenCanvas !== 'undefined') {
      this.scratch = new OffscreenCanvas(TILE, TILE);
      this.scratchCtx = this.scratch.getContext('2d', { alpha: false })!;
    } else {
      const c = document.createElement('canvas');
      c.width = c.height = TILE;
      this.scratch = c;
      this.scratchCtx = c.getContext('2d', { alpha: false })!;
    }
  }

  get usable(): boolean {
    return !this.lost && !this.gl.isContextLost();
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Forgets every tile drawn (another page or file): nothing old may show through. */
  clear(): void {
    this.clearLift();
    for (const t of this.tiles.values()) this.gl.deleteTexture(t.tex);
    this.tiles.clear();
    this.families.clear();
    this.base = null;
    this.baseKnown = false;
  }

  /** Scale (device pixels per unit) the lifted picture was drawn at; null — nothing lifted. */
  get liftScale(): number | null {
    return this.lift?.scale ?? null;
  }

  /**
   * Draws the lifted layers (at their places now) into their own texture.
   * False — too big to lift at this scale: the caller keeps them on the page.
   */
  setLift(scene: SceneGraph, ids: readonly NodeId[], scale: number): boolean {
    this.clearLift();
    const area = unionAll(ids.map((id) => scene.renderBounds(id)));
    if (!area || area.width <= 0 || area.height <= 0) return false;
    const gl = this.gl;
    const side = Math.min(LIFT_SIDE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    // A pixel of margin: antialiased edges are not cut.
    const box = { x: area.x - 1 / scale, y: area.y - 1 / scale, width: area.width + 2 / scale, height: area.height + 2 / scale };
    const width = Math.ceil(box.width * scale);
    const height = Math.ceil(box.height * scale);
    if (width > side || height > side) return false;
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!ctx) return false;
    this.renderer.renderLifted(ctx, scene, ids, box, scale);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas as TexImageSource);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lift = { tex, area: box, width, height, scale };
    return true;
  }

  clearLift(): void {
    if (!this.lift) return;
    this.gl.deleteTexture(this.lift.tex);
    this.lift = null;
  }

  /** Set by a change of the whole page: the next frame redraws every outdated tile in view at once. */
  private renewView = false;

  /** What changed: tiles under these areas are redrawn; `all` — every tile becomes outdated. */
  damage(all: boolean, rects: readonly Rect[]): void {
    // The content may have grown or shrunk: the base is measured again.
    if (all || rects.length) {
      this.baseKnown = false;
      this.lastEdit = performance.now();
      if (this.editTimer) clearTimeout(this.editTimer);
      this.editTimer = setTimeout(() => {
        this.editTimer = null;
        this.onNeedFrame();
      }, REST_MS + 20);
    }
    if (all) {
      for (const t of this.tiles.values()) t.stale = true;
      // The whole page looks different (fonts arrived, the theme changed): the view is renewed in one frame.
      this.renewView = true;
      return;
    }
    if (rects.length === 0) return;
    for (const t of this.tiles.values()) {
      const area = this.tileRect(t.family, t.i, t.j);
      for (const r of rects) {
        if (!intersects(r, area)) continue;
        if (!t.edited) t.dirty = [];
        t.edited = true;
        if (t.dirty !== 'all') {
          t.dirty.push(r);
          if (t.dirty.length > 8) t.dirty = 'all';
        }
      }
    }
  }

  private family(scale: number, px: number, py: number): Family {
    // Rounded so that the same view finds its tiles again.
    const s = +scale.toPrecision(10);
    const x = Math.round(px * 1000) / 1000;
    const y = Math.round(py * 1000) / 1000;
    const key = `${s}:${x}:${y}`;
    let f = this.families.get(key);
    if (!f) this.families.set(key, (f = { key, scale: s, px: x, py: y }));
    return f;
  }

  /** World area of a tile: device pixels [i·TILE − px, (i+1)·TILE − px) at the family's scale. */
  private tileRect(f: Family, i: number, j: number): Rect {
    const size = TILE / f.scale;
    return { x: (i * TILE - f.px) / f.scale, y: (j * TILE - f.py) / f.scale, width: size, height: size };
  }

  /** Draws one tile with the Canvas 2D renderer and keeps it as a texture. */
  private draw(scene: SceneGraph, f: Family, i: number, j: number): Tile {
    const gl = this.gl;
    const k = `${f.key}|${i}:${j}`;
    let tile = this.tiles.get(k);
    const view = new Viewport();
    view.zoom = f.scale;
    view.offsetX = -(i * TILE - f.px);
    view.offsetY = -(j * TILE - f.py);
    this.renderer.renderPage({ ctx: this.scratchCtx as CanvasRenderingContext2D, width: TILE, height: TILE, dpr: 1 }, scene, view);
    const tex = tile?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    if (!tile) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      tile = { family: f, i, j, tex, stale: false, edited: false, dirty: 'all', used: this.frame };
      this.tiles.set(k, tile);
    }
    tile.stale = false;
    tile.edited = false;
    tile.dirty = 'all';
    tile.used = this.frame;
    this.stats.rendered++;
    return tile;
  }

  /** A small canvas for parts of tiles (PERF-002). */
  private part: OffscreenCanvas | HTMLCanvasElement | null = null;
  private partCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;

  /**
   * A tile under an edit: only the part the edit changed is drawn again and sent to
   * the GPU (typing in a sticky redrew whole 256 px squares). The part is drawn
   * with the tile's own transform shifted by whole device pixels, so its pixels
   * are the ones a whole redraw gives. A large change — the whole tile, as before.
   */
  private redraw(scene: SceneGraph, f: Family, i: number, j: number, tile: Tile): Tile {
    if (tile.dirty === 'all' || tile.stale || !tile.dirty.length) return this.draw(scene, f, i, j);
    const ox = i * TILE - f.px;
    const oy = j * TILE - f.py;
    let x0 = TILE;
    let y0 = TILE;
    let x1 = 0;
    let y1 = 0;
    for (const r of tile.dirty) {
      // Two pixels around: antialiased edges and hairline strokes of the change are inside.
      x0 = Math.min(x0, Math.floor(r.x * f.scale - ox) - 2);
      y0 = Math.min(y0, Math.floor(r.y * f.scale - oy) - 2);
      x1 = Math.max(x1, Math.ceil((r.x + r.width) * f.scale - ox) + 2);
      y1 = Math.max(y1, Math.ceil((r.y + r.height) * f.scale - oy) + 2);
    }
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(TILE, x1);
    y1 = Math.min(TILE, y1);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) {
      tile.edited = false;
      tile.dirty = 'all';
      return tile;
    }
    if (w * h > TILE * TILE * 0.5) return this.draw(scene, f, i, j);
    if (!this.part) {
      this.part = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      this.partCtx = this.part.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    }
    if (!this.partCtx) return this.draw(scene, f, i, j);
    this.part.width = w;
    this.part.height = h;
    const view = new Viewport();
    view.zoom = f.scale;
    view.offsetX = -ox - x0;
    view.offsetY = -oy - y0;
    this.renderer.renderPage({ ctx: this.partCtx as CanvasRenderingContext2D, width: w, height: h, dpr: 1 }, scene, view);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tile.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, gl.RGBA, gl.UNSIGNED_BYTE, this.part as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    tile.edited = false;
    tile.dirty = 'all';
    tile.used = this.frame;
    this.stats.rendered++;
    return tile;
  }

  /**
   * Composes the page for the view. Returns false when some tiles are still
   * to be drawn: the caller asks for another frame.
   */
  render(scene: SceneGraph, viewport: Viewport, cssWidth: number, cssHeight: number, dpr: number, background: Color, liftOffset: { dx: number; dy: number; scale?: number } | null = null): boolean {
    const started = performance.now();
    this.frame++;
    this.stats = { drawn: 0, missing: 0, rendered: 0, ms: 0 };
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(background.r, background.g, background.b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    scene.ensure();

    // While zooming: the nearest quantized family; at rest: exactly the screen's scale and pixel grid.
    const deviceZoom = viewport.zoom * dpr;
    if (viewport.zoom !== this.lastZoom) {
      // The first frame (a file just opened) is drawn exactly at once.
      this.zoomChanged = this.lastZoom === 0 ? -Infinity : started;
      this.lastZoom = viewport.zoom;
      if (this.restTimer) clearTimeout(this.restTimer);
      this.restTimer = setTimeout(() => {
        this.restTimer = null;
        this.onNeedFrame();
      }, REST_MS);
    }
    const resting = started - this.zoomChanged >= REST_MS;
    const level = Math.ceil(Math.log2(deviceZoom) * STEPS - 1e-6);
    const f = this.family(resting ? deviceZoom : 2 ** (level / STEPS), 0, 0);

    const toDevice = (x: number, y: number) => ({ x: (x * viewport.zoom + viewport.offsetX) * dpr, y: (y * viewport.zoom + viewport.offsetY) * dpr });
    // Edges on whole device pixels: no blur from a fractional pan, and neighbours share their edges exactly.
    const quad = (tile: Tile, dest: Rect, src: Rect) => {
      const a = toDevice(dest.x, dest.y);
      const b = toDevice(dest.x + dest.width, dest.y + dest.height);
      const x = Math.round(a.x);
      const y = Math.round(a.y);
      gl.bindTexture(gl.TEXTURE_2D, tile.tex);
      gl.uniform4f(this.uDest, x / W, y / H, (Math.round(b.x) - x) / W, (Math.round(b.y) - y) / H);
      gl.uniform4f(this.uSrc, src.x, src.y, src.width, src.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      tile.used = this.frame;
      this.stats.drawn++;
    };
    const whole = { x: 0, y: 0, width: 1, height: 1 };

    // Tiles of the family that cover the view.
    const view = viewport.visibleRect(cssWidth, cssHeight);
    const i0 = Math.floor((view.x * f.scale + f.px) / TILE);
    const j0 = Math.floor((view.y * f.scale + f.py) / TILE);
    const i1 = Math.floor(((view.x + view.width) * f.scale + f.px) / TILE);
    const j1 = Math.floor(((view.y + view.height) * f.scale + f.py) / TILE);
    const center = { x: (i0 + i1) / 2, y: (j0 + j1) / 2 };
    const wanted: { i: number; j: number; d: number }[] = [];
    // Squares nothing can stand in for (a file just opened, a page just switched to): all in this
    // frame — a longer first frame beats a page appearing square by square (BUG-084).
    const bare: { i: number; j: number }[] = [];
    let done = true;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const area = this.tileRect(f, i, j);
        let tile = this.tiles.get(`${f.key}|${i}:${j}`);
        // Under an edit: drawn now, all of them — an outdated square would show a moved layer
        // where it was (BUG-069: pieces of frames left behind while dragging a big selection).
        if (tile?.edited) tile = this.redraw(scene, f, i, j, tile);
        if (tile) {
          quad(tile, area, whole);
          if (tile.stale) wanted.push({ i, j, d: Math.hypot(i - center.x, j - center.y) });
          continue;
        }
        this.stats.missing++;
        // While the zoom moves, a square covered by pieces of other tiles waits: drawing it now would hold the gesture up.
        const covered = this.standIn(f, area, quad);
        if (!covered) bare.push({ i, j });
        else if (resting) wanted.push({ i, j, d: Math.hypot(i - center.x, j - center.y) });
        else done = false;
      }
    }
    for (const b of bare) quad(this.draw(scene, f, b.i, b.j), this.tileRect(f, b.i, b.j), whole);
    // After a change of the whole page the view is renewed at once (not square by square), at rest only.
    if (this.renewView && resting) {
      for (const w of wanted.splice(0)) quad(this.draw(scene, f, w.i, w.j), this.tileRect(f, w.i, w.j), whole);
      this.renewView = false;
    }
    // Missing tiles nearest the middle first, as long as the frame has time.
    wanted.sort((x, y) => x.d - y.d);
    for (const w of wanted) {
      if (performance.now() - started > BUDGET_MS && this.stats.rendered > 0) {
        done = false;
        break;
      }
      quad(this.draw(scene, f, w.i, w.j), this.tileRect(f, w.i, w.j), whole);
    }
    // The lifted selection over the page, moved by how far it went since it was drawn.
    if (this.lift && liftOffset) {
      const l = this.lift;
      // Scaled about its centre (the bounce of something just inserted).
      const s = liftOffset.scale ?? 1;
      const a = toDevice(l.area.x + liftOffset.dx + (l.area.width * (1 - s)) / 2, l.area.y + liftOffset.dy + (l.area.height * (1 - s)) / 2);
      const k = ((viewport.zoom * dpr) / l.scale) * s;
      const x = Math.round(a.x);
      const y = Math.round(a.y);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindTexture(gl.TEXTURE_2D, l.tex);
      gl.uniform4f(this.uDest, x / W, y / H, Math.round(l.width * k) / W, Math.round(l.height * k) / H);
      gl.uniform4f(this.uSrc, 0, 0, 1, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disable(gl.BLEND);
    }
    // The base, with the time left: what a later frame may need when nothing else covers a square.
    // Only at rest: during a drag or a pinch it would take the gesture's time; the old base stands in meanwhile.
    const calm = resting && started - this.lastEdit >= REST_MS;
    const base = calm ? this.baseFor(scene) : this.base;
    if (base && calm) {
      for (const c of base.cells) {
        const t = this.tiles.get(`${base.family.key}|${c.i}:${c.j}`);
        if (t && !t.edited && !t.stale) {
          t.used = this.frame;
          continue;
        }
        if (performance.now() - started > BUDGET_MS) {
          done = false;
          break;
        }
        this.draw(scene, base.family, c.i, c.j);
      }
    }
    this.evict(Math.max(96, (i1 - i0 + 3) * (j1 - j0 + 3) * 3) + (base?.cells.length ?? 0));
    this.stats.ms = performance.now() - started;
    return done;
  }

  /** The base for the page as it is now (null — an empty page). */
  private baseFor(scene: SceneGraph): { family: Family; cells: { i: number; j: number }[] } | null {
    if (this.baseKnown) return this.base;
    this.baseKnown = true;
    const r = scene.contentBounds();
    if (!r || r.width <= 0 || r.height <= 0) return (this.base = null);
    // A quantized scale (as the zoom families), so it does not change with every small edit.
    const level = Math.floor(Math.log2(Math.min(2, BASE_SIDE / Math.max(r.width, r.height))) * STEPS);
    const family = this.family(2 ** (level / STEPS), 0, 0);
    const i0 = Math.floor((r.x * family.scale) / TILE);
    const j0 = Math.floor((r.y * family.scale) / TILE);
    const i1 = Math.floor(((r.x + r.width) * family.scale) / TILE);
    const j1 = Math.floor(((r.y + r.height) * family.scale) / TILE);
    const cells: { i: number; j: number }[] = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells.push({ i, j });
    // Old base tiles of an outdated base (or ones under an edit) keep standing in until replaced.
    return (this.base = { family, cells });
  }

  /**
   * Shows a missing tile with what there is: pieces of ready tiles of other
   * families (any scale — a piece is cut by world coordinates), the closest
   * scale that covers the whole square first.
   */
  private standIn(target: Family, area: Rect, quad: (t: Tile, dest: Rect, src: Rect) => void): boolean {
    const families = [...this.families.values()].filter((x) => x !== target).sort((x, y) => Math.abs(Math.log2(x.scale / target.scale)) - Math.abs(Math.log2(y.scale / target.scale)));
    // The base last of all: blurred, perhaps a little old, but never a hole.
    const baseFamily = this.base?.family;
    const tried = families.slice(0, 12).filter((x) => x !== baseFamily);
    if (baseFamily && baseFamily !== target) tried.push(baseFamily);
    let partial: { tile: Tile; dest: Rect; src: Rect }[] = [];
    for (const fam of tried) {
      const size = TILE / fam.scale;
      const i0 = Math.floor((area.x * fam.scale + fam.px) / TILE);
      const j0 = Math.floor((area.y * fam.scale + fam.py) / TILE);
      const i1 = Math.floor(((area.x + area.width) * fam.scale + fam.px - 1e-6) / TILE);
      const j1 = Math.floor(((area.y + area.height) * fam.scale + fam.py - 1e-6) / TILE);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 64) continue;
      const pieces: { tile: Tile; dest: Rect; src: Rect }[] = [];
      let covered = true;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const t = this.tiles.get(`${fam.key}|${i}:${j}`);
          // A piece under an edit shows what was there before it (the base too): better the page background.
          if (!t || t.edited) {
            covered = false;
            continue;
          }
          const r = this.tileRect(fam, i, j);
          const x0 = Math.max(area.x, r.x);
          const y0 = Math.max(area.y, r.y);
          const x1 = Math.min(area.x + area.width, r.x + size);
          const y1 = Math.min(area.y + area.height, r.y + size);
          if (x1 <= x0 || y1 <= y0) continue;
          pieces.push({ tile: t, dest: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, src: { x: (x0 - r.x) / size, y: (y0 - r.y) / size, width: (x1 - x0) / size, height: (y1 - y0) / size } });
        }
      }
      if (covered && pieces.length) {
        for (const p of pieces) quad(p.tile, p.dest, p.src);
        return true;
      }
      if (pieces.length > partial.length) partial = pieces;
    }
    for (const p of partial) quad(p.tile, p.dest, p.src);
    return false;
  }

  /** Keeps the most recently used tiles (and forgets families with none left). */
  private evict(max: number): void {
    if (this.tiles.size <= max) return;
    const baseKey = this.base?.family.key;
    const old = [...this.tiles.entries()].filter(([, t]) => t.family.key !== baseKey).sort((x, y) => x[1].used - y[1].used);
    for (const [k, t] of old.slice(0, Math.max(0, this.tiles.size - max))) {
      this.gl.deleteTexture(t.tex);
      this.tiles.delete(k);
    }
    const alive = new Set([...this.tiles.values()].map((t) => t.family.key));
    for (const k of [...this.families.keys()]) if (!alive.has(k)) this.families.delete(k);
  }
}
