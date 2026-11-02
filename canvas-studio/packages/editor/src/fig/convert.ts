// .fig → our document. Figma keeps a file as a flat list of node changes
// ("nodeChanges"): each node has a guid, its parent's guid and a position
// string that orders siblings. The tree is rebuilt from them and every node
// becomes our layer with the same meaning: pages, frames (groups are frames
// that fit their children), shapes, vectors, texts with mixed styles,
// fills, strokes, effects, auto layout. Nothing of Figma's types is assumed
// beyond the field names: unknown things are counted and skipped.

import { canContain, Document, tr, valueEquals } from '#core';
import { TEXT_STYLE_KEYS } from '#core';
import type { BlendMode, Color, ComponentPropDef, GridTrack, ConstraintType, Effect, LayoutGrid, LetterSpacing, LineCap, LineHeight, NodeId, NodeProps, NodeType, Paint, PropBinding, PropKey, Sizing, StrokeCap, TextRun, TextRunStyle, Transaction, VectorNetwork, VectorPath, VectorPoint } from '#core';
import { networkPaths, ringLoops, strokeChains } from '#geometry';
import { ensureLayerKeys, markOverrides, sourceOf, syncComponents, wouldCreateCycle } from '#components';
import type { FigArchive } from './archive.ts';

type Fig = Record<string, any>;

export interface FigImportResult {
  /** A FigJam board: how many of its objects came over. */
  board?: { stickies: number; shapes: number; connectors: number };
  doc: Document;
  /** Layers made. */
  count: number;
  /** Figma layer kinds not carried over, with how many of each. */
  skipped: Map<string, number>;
  /** Font families the file uses (the editor checks which are missing). */
  fonts: Set<string>;
  /** Pictures the file refers to but does not contain. */
  missingImages: number;
  /** Components made, and instances linked to them (or left as frames: their component is not in the file). */
  components: number;
  instances: number;
  unlinked: number;
  /** Styles of colour, text, effects and grids. */
  styles: number;
}

const key = (g: { sessionID?: number; localID?: number } | undefined) => (g ? `${g.sessionID}:${g.localID}` : '');
/** '#RRGGBB' as Figma's colour object. */
const hexToFig = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255, a: 1 };
};

/** FigJam's shapes with text → the closest of the board's shapes. */
const JAM_SHAPES: Record<string, import('#core').BoardShape> = {
  SQUARE: 'RECTANGLE',
  ROUNDED_RECTANGLE: 'ROUNDED',
  ELLIPSE: 'ELLIPSE',
  DIAMOND: 'DIAMOND',
  TRIANGLE_UP: 'TRIANGLE',
  TRIANGLE_DOWN: 'TRIANGLE',
  PARALLELOGRAM_RIGHT: 'PARALLELOGRAM',
  PARALLELOGRAM_LEFT: 'PARALLELOGRAM',
  ENG_DATABASE: 'CYLINDER',
  DOCUMENT_SINGLE: 'DOCUMENT',
  DOCUMENT_MULTIPLE: 'MULTI_DOCUMENT',
  PREDEFINED_PROCESS: 'SUBPROCESS',
  TRAPEZOID: 'TRAPEZOID',
  ENG_QUEUE: 'QUEUE',
  HEXAGON: 'HEXAGON',
  STAR: 'STAR',
  ARROW_RIGHT: 'ARROW',
  ARROW_LEFT: 'ARROW',
  SPEECH_BUBBLE: 'SPEECH',
};
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v: unknown) => Math.min(1, Math.max(0, num(v)));
const round = (v: number) => Math.round(v * 1000) / 1000;
const color = (c: Fig | undefined): Color => ({ r: clamp01(c?.r), g: clamp01(c?.g), b: clamp01(c?.b), a: c?.a === undefined ? 1 : clamp01(c.a) });

const BLENDS = new Set<string>(['PASS_THROUGH', 'NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY']);
// Figma calls Plus darker and Plus lighter «linear burn» and «linear dodge» inside its files.
const PLUS: Record<string, BlendMode> = { LINEAR_BURN: 'PLUS_DARKER', LINEAR_DODGE: 'PLUS_LIGHTER', PLUS_DARKER: 'PLUS_DARKER', PLUS_LIGHTER: 'PLUS_LIGHTER' };
const blend = (v: unknown): BlendMode | undefined => (typeof v === 'string' ? (BLENDS.has(v) ? (v as BlendMode) : PLUS[v]) : undefined);

/** Font style name → weight and italic ("Semi Bold Italic" → 600, true). */
export function parseFontStyle(style: string | undefined): { weight: number; italic: boolean } {
  const s = (style ?? 'Regular').toLowerCase().replace(/[\s_-]+/g, '');
  const italic = /italic|oblique/.test(s);
  const table: [RegExp, number][] = [
    [/hairline|thin/, 100],
    [/extralight|ultralight/, 200],
    [/semibold|demibold/, 600],
    [/extrabold|ultrabold/, 800],
    [/black|heavy/, 900],
    [/light/, 300],
    [/medium/, 500],
    [/bold/, 700],
  ];
  const found = table.find(([re]) => re.test(s));
  const numeric = /(\d{3})/.exec(s);
  return { weight: found ? found[1] : numeric ? Number(numeric[1]) : 400, italic };
}

function mimeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes[0] === 0x3c) return 'image/svg+xml';
  return 'image/png';
}

function hex(bytes: unknown): string {
  if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) return '';
  return Array.from(bytes as ArrayLike<number>, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Inverse of a 2×3 matrix applied to a point (gradient handles). */
function unapply(m: Fig, p: { x: number; y: number }): { x: number; y: number } {
  const a = num(m.m00, 1);
  const c = num(m.m01);
  const e = num(m.m02);
  const b = num(m.m10);
  const d = num(m.m11, 1);
  const f = num(m.m12);
  const det = a * d - b * c || 1;
  const x = p.x - e;
  const y = p.y - f;
  return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det };
}

// ---------- geometry ----------

/** Path commands of fillGeometry blobs: 0 close, 1 move, 2 line, 3 quad, 4 cubic; float32 coordinates. */
export function commandsToPaths(bytes: Uint8Array): VectorPath[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const paths: VectorPath[] = [];
  let current: VectorPath | null = null;
  let p = 0;
  const f = () => {
    const v = dv.getFloat32(p, true);
    p += 4;
    return round(v);
  };
  const last = () => current!.points[current!.points.length - 1]!;
  while (p < bytes.length) {
    const cmd = bytes[p++]!;
    if (cmd === 0) {
      if (current) {
        current.closed = true;
        // A closing segment ending on the first point: the points are the same.
        const pts = current.points;
        if (pts.length > 1) {
          const a = pts[0]!;
          const z = pts[pts.length - 1]!;
          if (Math.abs(a.x - z.x) < 0.001 && Math.abs(a.y - z.y) < 0.001) {
            if (z.in) a.in = z.in;
            pts.pop();
          }
        }
      }
      current = null;
    } else if (cmd === 1) {
      current = { points: [{ x: f(), y: f() }], closed: false };
      paths.push(current);
    } else if (cmd === 2) {
      if (!current) throw new Error('path without a start');
      current.points.push({ x: f(), y: f() });
    } else if (cmd === 3) {
      if (!current) throw new Error('path without a start');
      const from = last();
      const cx = f();
      const cy = f();
      const x = f();
      const y = f();
      from.out = { x: round(from.x + (2 / 3) * (cx - from.x)), y: round(from.y + (2 / 3) * (cy - from.y)) };
      current.points.push({ x, y, in: { x: round(x + (2 / 3) * (cx - x)), y: round(y + (2 / 3) * (cy - y)) } });
    } else if (cmd === 4) {
      if (!current) throw new Error('path without a start');
      const from = last();
      from.out = { x: f(), y: f() };
      const inH = { x: f(), y: f() };
      current.points.push({ x: f(), y: f(), in: inH });
    } else {
      throw new Error(`unknown path command ${cmd}`);
    }
  }
  return paths.filter((x) => x.points.length > 0);
}

/**
 * The editable vector network (vectorData.vectorNetworkBlob): vertices,
 * segments with tangents relative to their ends, and regions (loops of
 * segments with a fill rule). Coordinates are in `normalizedSize`, scaled
 * by sx, sy to the node's size.
 */
export function networkFromFig(bytes: Uint8Array, sx: number, sy: number, regionFills?: (styleId: number) => Paint[] | undefined): VectorNetwork {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const u = () => {
    const v = dv.getUint32(p, true);
    p += 4;
    return v;
  };
  const f = () => {
    const v = dv.getFloat32(p, true);
    p += 4;
    return v;
  };
  const vertexCount = u();
  const segmentCount = u();
  const regionCount = u();
  if (vertexCount > 1e6 || segmentCount > 1e6 || regionCount > 1e6) throw new Error('bad vector network');
  const vertices: { x: number; y: number }[] = [];
  for (let i = 0; i < vertexCount; i++) {
    u();
    vertices.push({ x: round(f() * sx), y: round(f() * sy) });
  }
  const segments: VectorNetwork['segments'] = [];
  for (let i = 0; i < segmentCount; i++) {
    u();
    const a = u();
    const ta = { x: f() * sx, y: f() * sy };
    const b = u();
    const tb = { x: f() * sx, y: f() * sy };
    if (!vertices[a] || !vertices[b]) throw new Error('bad vector network');
    const s: VectorNetwork['segments'][number] = { a, b };
    if (ta.x !== 0 || ta.y !== 0) s.ca = { x: round(vertices[a]!.x + ta.x), y: round(vertices[a]!.y + ta.y) };
    if (tb.x !== 0 || tb.y !== 0) s.cb = { x: round(vertices[b]!.x + tb.x), y: round(vertices[b]!.y + tb.y) };
    segments.push(s);
  }
  const regions: VectorNetwork['regions'] = [];
  for (let i = 0; i < regionCount; i++) {
    const style = u();
    const n = u();
    const loops: number[][] = [];
    for (let j = 0; j < n; j++) {
      const m = u();
      const loop: number[] = [];
      for (let k = 0; k < m; k++) loop.push(u());
      if (loop.every((si) => segments[si])) loops.push(loop);
    }
    // The low bit is the winding rule, the rest a style (own paints of the region, vectorData.styleOverrideTable).
    const fills = style >> 1 ? regionFills?.(style >> 1) : undefined;
    if (loops.length) regions.push({ loops, windingRule: style & 1 ? 'NONZERO' : 'EVENODD', ...(fills ? { fills } : {}) });
  }
  return { vertices, segments, regions };
}

/** The same network as contours: regions closed, the segments outside them as chains. */
export function networkToPaths(bytes: Uint8Array, sx: number, sy: number): { paths: VectorPath[]; evenOdd: boolean } {
  const net = networkFromFig(bytes, sx, sy);
  const { fill, evenOdd } = networkPaths(net);
  const inRegions = new Set(net.regions.flatMap((r) => r.loops.flat()));
  const loose = strokeChains({ vertices: net.vertices, segments: net.segments.filter((_, i) => !inRegions.has(i)), regions: [] });
  return { paths: [...fill, ...loose], evenOdd };
}

// ---------- the converter ----------

class Converter {
  private readonly message: Fig;
  private readonly archive: FigArchive;
  private readonly tx: Transaction;
  private readonly children = new Map<string, Fig[]>();
  private readonly images = new Map<string, string>();
  private readonly byGuid = new Map<string, Fig>();
  /** Our layer made from each Figma node, by guid. */
  private readonly ours = new Map<string, NodeId>();
  /**
   * Layers of components copied from libraries keep the guid they had there
   * ("overrideKey"); overrides in instances point at layers by it.
   */
  private readonly byOverrideKey = new Map<string, NodeId[]>();
  /** Styles of the file by Figma guid, and the layers that use them (bound at the end). */
  private readonly styles = new Map<string, NodeId>();
  private readonly styleUsers: { id: NodeId; binding: 'fillStyleId' | 'strokeStyleId' | 'textStyleId' | 'effectStyleId' | 'gridStyleId'; guid: string }[] = [];
  /** The document node: styles live next to the pages. */
  rootId: NodeId = '';
  styleCount = 0;
  /** Instances made empty; they are linked once every component exists. */
  private readonly instances: { id: NodeId; fig: Fig }[] = [];
  components = 0;
  linked = 0;
  unlinked = 0;
  readonly skipped = new Map<string, number>();
  readonly fonts = new Set<string>();
  missingImages = 0;
  count = 0;
  /** A FigJam board (FEAT-086): stickies, shapes with text and connectors become the board's own objects. */
  board = false;
  /** Board objects made, for the note. */
  stickies = 0;
  shapes = 0;
  connectors = 0;
  /** Connectors made before every layer existed: their ends are attached at the end. */
  private readonly pendingConnectors: { id: NodeId; fig: Fig }[] = [];

  constructor(archive: FigArchive, tx: Transaction) {
    this.archive = archive;
    this.message = archive.message;
    this.tx = tx;
    const nodes = (this.message.nodeChanges ?? []) as Fig[];
    for (const n of nodes) {
      if (n.phase === 'REMOVED') continue;
      this.byGuid.set(key(n.guid), n);
      const parent = key(n.parentIndex?.guid);
      if (!parent) continue;
      let list = this.children.get(parent);
      if (!list) this.children.set(parent, (list = []));
      list.push(n);
    }
    // Siblings are ordered by their position strings, bottom to top.
    for (const list of this.children.values()) list.sort((a, b) => (a.parentIndex.position < b.parentIndex.position ? -1 : a.parentIndex.position > b.parentIndex.position ? 1 : 0));
  }

  private skip(kind: string): void {
    this.skipped.set(kind, (this.skipped.get(kind) ?? 0) + 1);
  }

  /** The document node of the file (the root of everything). */
  root(): Fig | undefined {
    return ((this.message.nodeChanges ?? []) as Fig[]).find((n) => n.type === 'DOCUMENT');
  }

  pagesOf(doc: Fig): Fig[] {
    return (this.children.get(key(doc.guid)) ?? []).filter((n) => n.type === 'CANVAS' && !n.internalOnly);
  }

  /** Hidden pages: Figma keeps the library components a file uses there. */
  internalPagesOf(doc: Fig): Fig[] {
    return (this.children.get(key(doc.guid)) ?? []).filter((n) => n.type === 'CANVAS' && n.internalOnly && (this.children.get(key(n.guid))?.length ?? 0) > 0);
  }

  /** Library components go to our hidden page of library components. */
  libraryPage(list: Fig[], root: NodeId): void {
    const id = this.tx.create('PAGE', root, { name: tr('Компоненты библиотек'), libraryPage: true });
    for (const n of list) for (const c of this.children.get(key(n.guid)) ?? []) this.node(c, id, null);
    // Only styles were there: no page needed.
    if (this.tx.doc.children(id).length === 0) this.tx.delete(id);
  }

  page(n: Fig, root: NodeId): void {
    const bg = n.backgroundColor ? color(n.backgroundColor) : null;
    const id = this.tx.create('PAGE', root, { name: n.name || tr('Страница'), ...(bg ? { backgroundColor: { ...bg, a: 1 } } : {}) });
    for (const c of this.children.get(key(n.guid)) ?? []) this.node(c, id, null);
  }

  private blob(index: unknown): Uint8Array | null {
    const b = (this.message.blobs as Fig[] | undefined)?.[num(index, -1)];
    return b?.bytes instanceof Uint8Array ? b.bytes : null;
  }

  private image(hash: unknown): string | null {
    const h = hex(hash);
    if (!h) return null;
    const known = this.images.get(h);
    if (known) return known;
    const bytes = this.archive.images.get(h);
    if (!bytes) return null;
    const id = this.tx.addBlob(bytes, mimeOf(bytes));
    this.images.set(h, id);
    return id;
  }

  private paint(p: Fig): Paint | null {
    const visible = p.visible !== false;
    const opacity = p.opacity === undefined ? 1 : clamp01(p.opacity);
    const mode = blend(p.blendMode);
    const extra = mode && mode !== 'NORMAL' && mode !== 'PASS_THROUGH' ? { blendMode: mode } : {};
    if (p.type === 'SOLID') {
      const c = color(p.color);
      return { type: 'SOLID', color: { ...c, a: 1 }, opacity: round(opacity * c.a), visible, ...extra };
    }
    if (typeof p.type === 'string' && p.type.startsWith('GRADIENT_')) {
      const stops = ((p.stops ?? []) as Fig[]).map((s) => ({ position: clamp01(s.position), color: color(s.color) })).sort((a, b) => a.position - b.position);
      if (stops.length === 0) return null;
      if (stops.length === 1) stops.push({ position: 1, color: stops[0]!.color });
      const m = p.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
      const linear = p.type === 'GRADIENT_LINEAR';
      const from = unapply(m, linear ? { x: 0, y: 0.5 } : { x: 0.5, y: 0.5 });
      const to = unapply(m, { x: 1, y: 0.5 });
      // Figma's angular and diamond gradients share the radial one's handles: centre and the point on its edge.
      const type = p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND' ? p.type : linear ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL';
      return { type, stops, from: { x: round(from.x), y: round(from.y) }, to: { x: round(to.x), y: round(to.y) }, opacity, visible, ...extra };
    }
    if (p.type === 'IMAGE') {
      const hash = this.image(p.image?.hash);
      if (!hash) {
        this.missingImages++;
        return { type: 'SOLID', color: { r: 0.86, g: 0.86, b: 0.88, a: 1 }, opacity: 1, visible };
      }
      const scaleMode = p.imageScaleMode === 'FIT' ? 'FIT' : p.imageScaleMode === 'TILE' ? 'TILE' : p.imageScaleMode === 'STRETCH' ? 'STRETCH' : 'FILL';
      return { type: 'IMAGE', imageHash: hash, scaleMode, scale: Math.max(0.01, num(p.scale, 1)), opacity, visible, ...extra };
    }
    this.skip(`paint ${String(p.type)}`);
    return null;
  }

  private paints(list: unknown): Paint[] {
    return Array.isArray(list) ? list.map((p) => this.paint(p as Fig)).filter((p): p is Paint => p !== null) : [];
  }

  private effects(list: unknown, isText: boolean): Effect[] {
    const out: Effect[] = [];
    for (const e of (Array.isArray(list) ? list : []) as Fig[]) {
      const visible = e.visible !== false;
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        out.push({ type: e.type, color: color(e.color), offset: { x: num(e.offset?.x), y: num(e.offset?.y) }, radius: Math.max(0, num(e.radius)), spread: isText ? 0 : num(e.spread), visible });
      } else if (e.type === 'FOREGROUND_BLUR' || e.type === 'BACKGROUND_BLUR') {
        out.push({ type: e.type === 'FOREGROUND_BLUR' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR', radius: Math.max(0, num(e.radius)), visible });
      } else {
        this.skip(`effect ${String(e.type)}`);
      }
    }
    return out;
  }

  /** Figma's arc data (radians, clockwise) as an ellipse's arc; a whole ellipse — nothing. */
  private arcOf(n: Fig): Partial<NodeProps> {
    const a = (n as { arcData?: { startingAngle?: number; endingAngle?: number; innerRadius?: number } }).arcData;
    if (!a) return {};
    const start = (num(a.startingAngle) * 180) / Math.PI;
    const sweep = ((num(a.endingAngle, Math.PI * 2) - num(a.startingAngle)) * 180) / Math.PI;
    const inner = clamp01(num(a.innerRadius));
    if (Math.abs(sweep) >= 359.999 && inner === 0) return {};
    return { arc: { start: round(start), sweep: round(sweep), inner } };
  }

  private common(n: Fig): Partial<NodeProps> {
    const t = n.transform ?? {};
    const rotation = (Math.atan2(num(t.m10), num(t.m00, 1)) * 180) / Math.PI;
    const props: Partial<NodeProps> = {
      name: n.name ?? '',
      visible: n.visible !== false,
      locked: n.locked === true,
      opacity: n.opacity === undefined ? 1 : clamp01(n.opacity),
      x: round(num(t.m02)),
      y: round(num(t.m12)),
      rotation: Math.abs(rotation) < 0.001 ? 0 : round(rotation),
      width: round(Math.max(0, num(n.size?.x))),
      height: round(Math.max(0, num(n.size?.y))),
    };
    const mode = blend(n.blendMode);
    if (mode && mode !== 'PASS_THROUGH') props.blendMode = mode;
    if (n.mask === true) {
      props.isMask = true;
      // Masks by outline and by brightness (the file may name them either way).
      const kind = (n as { maskType?: unknown }).maskType;
      if (kind === 'OUTLINE' || kind === 'VECTOR') props.maskType = 'VECTOR';
      else if (kind === 'LUMINANCE') props.maskType = 'LUMINANCE';
    }
    const h = constraint(n.horizontalConstraint);
    const v = constraint(n.verticalConstraint);
    if (h || v) props.constraints = { horizontal: h ?? 'MIN', vertical: v ?? 'MIN' };
    return props;
  }

  private strokes(n: Fig, perSide: boolean): Partial<NodeProps> {
    const strokes = this.paints(n.strokePaints);
    // Said outright: a new vector of ours has a stroke by default.
    if (strokes.length === 0) return { strokes: [] };
    const props: Partial<NodeProps> = {
      strokes,
      strokeWeight: Math.max(0, num(n.strokeWeight, 1)),
      strokeAlign: n.strokeAlign === 'INSIDE' || n.strokeAlign === 'OUTSIDE' ? n.strokeAlign : 'CENTER',
    };
    if (n.strokeJoin === 'MITER' || n.strokeJoin === 'ROUND' || n.strokeJoin === 'BEVEL') props.strokeJoin = n.strokeJoin;
    const cap = strokeCap(n.strokeCap);
    if (cap) props.strokeCap = cap;
    if (Array.isArray(n.dashPattern) && n.dashPattern.length) props.dashPattern = (n.dashPattern as number[]).map((d) => Math.max(0, num(d)));
    if (n.miterLimit !== undefined) props.strokeMiterLimit = Math.max(1, num(n.miterLimit, 4));
    if (perSide && n.borderStrokeWeightsIndependent) {
      const ws: [number, number, number, number] = [num(n.borderTopWeight), num(n.borderRightWeight), num(n.borderBottomWeight), num(n.borderLeftWeight)];
      if (!ws.every((w) => w === ws[0])) {
        props.strokeWeights = ws;
        props.strokeWeight = Math.max(...ws);
      }
    }
    return props;
  }

  private corners(n: Fig): Partial<NodeProps> {
    const props: Partial<NodeProps> = {};
    if (n.rectangleCornerRadiiIndependent) {
      const r: [number, number, number, number] = [num(n.rectangleTopLeftCornerRadius), num(n.rectangleTopRightCornerRadius), num(n.rectangleBottomRightCornerRadius), num(n.rectangleBottomLeftCornerRadius)];
      if (r.every((v) => v === r[0])) props.cornerRadius = r[0];
      else {
        props.cornerRadius = r[0];
        props.cornerRadii = r;
      }
    } else props.cornerRadius = Math.max(0, num(n.cornerRadius));
    if (n.cornerSmoothing) props.cornerSmoothing = clamp01(n.cornerSmoothing);
    if (n.proportionsConstrained) props.lockAspect = true;
    return props;
  }

  /** Auto layout of a frame (Figma's "stack"); grids keep exact places of their items. */
  /** Grid tracks in their order, each with its id (layers point at tracks by id) and size. */
  private tracks(list: Fig | undefined, sizing: Fig | undefined): { id: string; track: GridTrack }[] {
    const sizes = new Map<string, Fig>(((sizing?.entries ?? []) as Fig[]).map((e) => [key(e.id), e.trackSize]));
    const entries = [...((list?.entries ?? []) as Fig[])].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    return entries.map((e) => {
      const min = sizes.get(key(e.id))?.minSizing;
      const track: GridTrack = min?.type === 'FIXED' ? { kind: 'FIXED', value: Math.max(0, num(min.value)) } : min?.type === 'FLEX' ? { kind: 'FR', value: Math.max(0, num(min.value, 1)) } : { kind: 'HUG' };
      return { id: key(e.id), track };
    });
  }

  private autoLayout(n: Fig): Partial<NodeProps> {
    if (n.stackMode === 'GRID') {
      const hug = (v: unknown): Sizing => (v === 'RESIZE_TO_FIT' || v === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' ? { mode: 'HUG' } : { mode: 'FIXED' });
      return {
        layoutMode: 'GRID',
        gridColumns: this.tracks(n.gridColumns, n.gridColumnsSizing).map((t) => t.track),
        gridRows: this.tracks(n.gridRows, n.gridRowsSizing).map((t) => t.track),
        gridColumnGap: Math.max(0, num(n.gridColumnGap)),
        gridRowGap: Math.max(0, num(n.gridRowGap)),
        paddingLeft: num(n.stackHorizontalPadding),
        paddingTop: num(n.stackVerticalPadding),
        paddingRight: num(n.stackPaddingRight),
        paddingBottom: num(n.stackPaddingBottom),
        strokesIncludedInLayout: n.bordersTakeSpace === true,
        sizingH: hug(n.stackPrimarySizing),
        sizingV: hug(n.stackCounterSizing),
      };
    }
    if (n.stackMode !== 'HORIZONTAL' && n.stackMode !== 'VERTICAL') return {};
    const horizontal = n.stackMode === 'HORIZONTAL';
    const justify = n.stackPrimaryAlignItems as string | undefined;
    const align = (v: unknown) => (v === 'CENTER' ? 'CENTER' : v === 'MAX' ? 'MAX' : 'MIN');
    const hug = (v: unknown): Sizing => (v === 'RESIZE_TO_FIT' || v === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' ? { mode: 'HUG' } : { mode: 'FIXED' });
    const primary = hug(n.stackPrimarySizing);
    const counter = hug(n.stackCounterSizing);
    return {
      layoutMode: horizontal ? 'HORIZONTAL' : 'VERTICAL',
      layoutWrap: horizontal && n.stackWrap === 'WRAP',
      itemSpacing: num(n.stackSpacing),
      counterAxisSpacing: Math.max(0, num(n.stackCounterSpacing)),
      paddingLeft: num(n.stackHorizontalPadding),
      paddingTop: num(n.stackVerticalPadding),
      paddingRight: num(n.stackPaddingRight),
      paddingBottom: num(n.stackPaddingBottom),
      spacingMode: justify === 'SPACE_EVENLY' || justify === 'SPACE_BETWEEN' ? 'BETWEEN' : justify === 'SPACE_AROUND' ? 'AROUND' : justify === 'SPACE_EVENLY_CSS' ? 'EVENLY' : 'FIXED',
      primaryAlign: align(justify),
      counterAlign: horizontal && n.stackCounterAlignItems === 'BASELINE' ? 'BASELINE' : align(n.stackCounterAlignItems),
      counterAxisAlignContent: n.stackCounterAlignContent === 'SPACE_BETWEEN' ? 'SPACE_BETWEEN' : 'AUTO',
      itemReverseZIndex: n.stackReverseZIndex === true,
      strokesIncludedInLayout: n.bordersTakeSpace === true,
      sizingH: horizontal ? primary : counter,
      sizingV: horizontal ? counter : primary,
    };
  }

  /** How a child of an auto layout frame sizes and places itself. */
  private childLayout(n: Fig, parent: Fig): Partial<NodeProps> {
    if (n.stackPositioning === 'ABSOLUTE') return { positioning: 'ABSOLUTE' };
    if (parent.stackMode === 'GRID') {
      const cols = this.tracks(parent.gridColumns, parent.gridColumnsSizing).map((t) => t.id);
      const rows = this.tracks(parent.gridRows, parent.gridRowsSizing).map((t) => t.id);
      const col = n.gridColumnAnchor ? cols.indexOf(key(n.gridColumnAnchor)) : -1;
      const row = n.gridRowAnchor ? rows.indexOf(key(n.gridRowAnchor)) : -1;
      const align = (v: unknown) => (v === 'CENTER' ? 'CENTER' : v === 'MAX' ? 'MAX' : 'MIN');
      const props: Partial<NodeProps> = {
        gridColumn: col >= 0 ? col : null,
        gridRow: row >= 0 ? row : null,
        gridColumnSpan: Math.max(1, Math.round(num(n.gridColumnSpan, 1))),
        gridRowSpan: Math.max(1, Math.round(num(n.gridRowSpan, 1))),
        gridAlignH: align(n.gridChildHorizontalAlign),
        gridAlignV: align(n.gridChildVerticalAlign),
      };
      // In a grid the "primary" axis is the row (horizontal), as for a horizontal stack.
      if (num(n.stackChildPrimaryGrow) > 0) props.sizingH = { mode: 'FILL' };
      if (n.stackChildAlignSelf === 'STRETCH') props.sizingV = { mode: 'FILL' };
      return props;
    }
    const horizontal = parent.stackMode === 'HORIZONTAL';
    const props: Partial<NodeProps> = {};
    const grow = num(n.stackChildPrimaryGrow) > 0;
    const stretch = n.stackChildAlignSelf === 'STRETCH';
    if (grow) props[horizontal ? 'sizingH' : 'sizingV'] = { mode: 'FILL' };
    if (stretch) props[horizontal ? 'sizingV' : 'sizingH'] = { mode: 'FILL' };
    return props;
  }

  private grids(list: unknown): LayoutGrid[] {
    const out: LayoutGrid[] = [];
    for (const g of (Array.isArray(list) ? list : []) as Fig[]) {
      const c = color(g.color);
      const visible = g.visible !== false;
      if (g.pattern === 'GRID') {
        out.push({ pattern: 'GRID', sectionSize: Math.max(1, num(g.sectionSize, 10)), color: c, visible });
        continue;
      }
      const alignment = g.type === 'CENTER' ? 'CENTER' : g.type === 'MAX' ? 'MAX' : g.type === 'MIN' ? 'MIN' : 'STRETCH';
      out.push({ pattern: g.axis === 'Y' ? 'ROWS' : 'COLUMNS', count: Math.max(0, Math.round(num(g.numSections, 0))), alignment, sectionSize: Math.max(1, num(g.sectionSize, 10)), offset: num(g.offset), gutterSize: num(g.gutterSize), color: c, visible });
    }
    return out;
  }

  /** Builds a layer and what is inside; `parentFig` — the Figma parent when it is a frame. */
  private node(n: Fig, parent: NodeId, parentFig: Fig | null): void {
    if (n.phase === 'REMOVED') return;
    // Figma keeps a style as a hidden layer carrying its values: ours is a style of the file.
    if (n.styleType && this.rootId) {
      this.style(n);
      return;
    }
    const inStack = !!parentFig && (parentFig.stackMode === 'HORIZONTAL' || parentFig.stackMode === 'VERTICAL' || parentFig.stackMode === 'GRID');
    const base = { ...this.common(n), ...(inStack ? this.childLayout(n, parentFig!) : {}) };
    const fills = this.paints(n.fillPaints);
    const effects = this.effects(n.effects, n.type === 'TEXT');
    let id: NodeId | null = null;
    let type: NodeType | null = null;
    let descend = false;
    switch (n.type) {
      case 'FRAME':
      case 'SYMBOL':
      case 'INSTANCE':
      case 'SECTION': {
        const group = n.type === 'FRAME' && n.resizeToFit === true;
        const parentType = this.tx.doc.type(parent);
        const allowed = (t: NodeType) => canContain(parentType, t);
        if (n.type === 'SECTION') type = 'SECTION';
        else if (n.type === 'SYMBOL' && allowed('COMPONENT')) type = 'COMPONENT';
        else if (n.type === 'INSTANCE' && allowed('INSTANCE')) type = 'INSTANCE';
        else if (n.type === 'FRAME' && n.isStateGroup === true && allowed('COMPONENT_SET')) type = 'COMPONENT_SET';
        else if (group) type = 'GROUP';
        else type = 'FRAME';
        // A frame where we take only shapes and groups (inside a boolean operation): its layers, as a group.
        if (!allowed(type) && allowed('GROUP')) type = 'GROUP';
        if (!allowed(type)) {
          this.skip(String(n.type));
          return;
        }
        const props: Partial<NodeProps> =
          type === 'GROUP'
            ? { ...base, effects }
            : {
                ...base,
                fills,
                effects,
                ...this.strokes(n, true),
                ...this.corners(n),
                ...(type !== 'SECTION' ? { clipsContent: n.frameMaskDisabled !== true, ...this.autoLayout(n), layoutGrids: this.grids(n.layoutGrids) } : {}),
              };
        if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
          const defs = this.propDefs(n);
          if (defs.length) props.componentProps = defs;
          if (n.symbolDescription || n.description) props.description = String(n.symbolDescription ?? n.description);
        }
        // The frame's own sizing comes from its auto layout; a child setting (FILL) wins.
        if (type !== 'SECTION' && type !== 'GROUP' && inStack) {
          const child = this.childLayout(n, parentFig!);
          if (child.sizingH) props.sizingH = child.sizingH;
          if (child.sizingV) props.sizingV = child.sizingV;
        }
        // An instance shows its component's layers: made empty now, filled when linked.
        if (type === 'INSTANCE') {
          id = this.tx.create('INSTANCE', parent, { ...base, ...(props.sizingH ? { sizingH: props.sizingH } : {}), ...(props.sizingV ? { sizingV: props.sizingV } : {}) });
          this.instances.push({ id, fig: n });
          break;
        }
        id = this.tx.create(type, parent, props);
        if (type === 'COMPONENT') this.components++;
        descend = true;
        break;
      }
      case 'RECTANGLE':
      case 'ROUNDED_RECTANGLE':
        id = this.tx.create('RECTANGLE', parent, { ...base, fills, effects, ...this.strokes(n, true), ...this.corners(n) });
        break;
      case 'ELLIPSE':
        id = this.tx.create('ELLIPSE', parent, { ...base, fills, effects, ...this.strokes(n, false), ...this.arcOf(n) });
        break;
      case 'LINE':
        id = this.tx.create('LINE', parent, { ...base, height: 0, effects, ...this.strokes(n, false), ...this.lineEnds(n) });
        break;
      case 'REGULAR_POLYGON':
        id = this.tx.create('POLYGON', parent, { ...base, fills, effects, ...this.strokes(n, false), ...this.corners(n), pointCount: Math.max(3, Math.round(num(n.count, 3))) });
        break;
      case 'STAR':
        id = this.tx.create('STAR', parent, { ...base, fills, effects, ...this.strokes(n, false), ...this.corners(n), pointCount: Math.max(3, Math.round(num(n.count, 5))), innerRadius: clamp01(n.starInnerScale ?? 0.38) });
        break;
      case 'VECTOR':
        id = this.vector(n, parent, { ...base, fills, effects, ...this.strokes(n, false), ...this.lineEnds(n) });
        break;
      case 'BOOLEAN_OPERATION': {
        const op = n.booleanOperation === 'INTERSECT' ? 'INTERSECT' : n.booleanOperation === 'SUBTRACT' ? 'SUBTRACT' : n.booleanOperation === 'XOR' ? 'EXCLUDE' : 'UNION';
        id = this.tx.create('BOOLEAN_OPERATION', parent, { ...base, fills, effects, ...this.strokes(n, false), booleanOp: op });
        descend = true;
        break;
      }
      case 'TEXT':
        id = this.text(n, parent, { ...base, fills, effects });
        break;
      case 'SHAPE_WITH_TEXT':
        id = this.board ? this.boardShape(n, parent, base) : this.shapeWithText(n, parent, base);
        break;
      // FigJam's own objects come over on a board only (a design file keeps skipping them, as before).
      case 'STICKY':
        if (!this.board) {
          this.skip('STICKY');
          return;
        }
        id = this.sticky(n, parent, base);
        break;
      case 'CONNECTOR':
        if (!this.board) {
          this.skip('CONNECTOR');
          return;
        }
        id = this.connector(n, parent, base);
        break;
      default:
        this.skip(String(n.type));
        return;
    }
    if (!id) return;
    this.count++;
    if (n.guid && n.guid.sessionID >= 0) this.ours.set(key(n.guid), id);
    this.noteStyles(n, id);
    if (n.overrideKey) {
      const list = this.byOverrideKey.get(key(n.overrideKey)) ?? [];
      list.push(id);
      this.byOverrideKey.set(key(n.overrideKey), list);
    }
    const refs = this.propRefs(n);
    if (refs) this.tx.set(id, 'propRefs', refs);
    if (!descend) return;
    const frameLike = n.type === 'FRAME' || n.type === 'SYMBOL' ? n : null;
    for (const c of this.children.get(key(n.guid)) ?? []) this.node(c, id, frameLike);
    if (n.type === 'SYMBOL' && this.tx.doc.type(id) === 'COMPONENT') ensureLayerKeys(this.tx.doc, this.tx, id);
  }

  // ---------- styles ----------

  private style(n: Fig): void {
    const type = n.styleType === 'FILL' || n.styleType === 'TEXT' || n.styleType === 'EFFECT' || n.styleType === 'GRID' ? n.styleType : null;
    if (!type || !n.guid) {
      this.skip(`style ${String(n.styleType)}`);
      return;
    }
    const props: Partial<NodeProps> = { name: String(n.name ?? ''), styleType: type };
    if (n.styleDescription || n.description) props.description = String(n.styleDescription ?? n.description);
    if (type === 'FILL') props.fills = this.paints(n.fillPaints);
    else if (type === 'EFFECT') props.effects = this.effects(n.effects, false);
    else if (type === 'GRID') props.layoutGrids = this.grids(n.layoutGrids);
    else {
      const text: Partial<NodeProps> = {};
      this.textBase(n, text);
      for (const k of TEXT_STYLE_KEYS) if (text[k] !== undefined) (props as Record<string, unknown>)[k] = text[k];
    }
    this.styles.set(key(n.guid), this.tx.create('STYLE', this.rootId, props));
    this.styleCount++;
  }

  /** Remembers which styles a layer uses (old files: inherit…StyleID; newer: styleIdFor…). */
  private noteStyles(n: Fig, id: NodeId): void {
    const guidOf = (old: Fig | undefined, ref: Fig | undefined) => {
      const g = ref?.guid ?? old;
      if (!g || g.sessionID === 4294967295 || g.sessionID === undefined) return '';
      return key(g);
    };
    const pairs = [
      ['fillStyleId', guidOf(n.inheritFillStyleID, n.styleIdForFill)],
      ['strokeStyleId', guidOf(n.inheritFillStyleIDForStroke, n.styleIdForStrokeFill)],
      ['textStyleId', guidOf(n.inheritTextStyleID, n.styleIdForText)],
      ['effectStyleId', guidOf(n.inheritEffectStyleID, n.styleIdForEffect)],
      ['gridStyleId', guidOf(n.inheritGridStyleID, n.styleIdForGrid)],
    ] as const;
    for (const [binding, guid] of pairs) if (guid) this.styleUsers.push({ id, binding, guid });
  }

  /** Binds layers to the styles of the file (their values are already the style's). */
  bindStyles(): void {
    const doc = this.tx.doc;
    for (const u of this.styleUsers) {
      const style = this.styles.get(u.guid);
      if (!style || !doc.store.isAlive(u.id)) continue;
      if (u.binding === 'textStyleId' && doc.type(u.id) !== 'TEXT') continue;
      this.tx.set(u.id, u.binding, style);
    }
  }

  // ---------- components ----------

  /** Component properties a component (or a set of variants) declares: text, visibility, swap. */
  private propDefs(n: Fig): ComponentPropDef[] {
    const out: ComponentPropDef[] = [];
    for (const d of (n.componentPropDefs ?? []) as Fig[]) {
      if (d.isDeleted || !d.id) continue;
      const type = d.type === 'TEXT' ? 'TEXT' : d.type === 'BOOL' ? 'BOOLEAN' : d.type === 'INSTANCE_SWAP' ? 'INSTANCE_SWAP' : null;
      if (!type) continue;
      out.push({ id: key(d.id), name: String(d.name ?? ''), type, ...(d.description ? { description: String(d.description) } : {}) });
    }
    return out;
  }

  /** Which of a layer's properties are driven by component properties. */
  private propRefs(n: Fig): Partial<Record<PropBinding, string>> | null {
    const out: Partial<Record<PropBinding, string>> = {};
    for (const r of (n.componentPropRefs ?? []) as Fig[]) {
      if (r.isDeleted || !r.defID) continue;
      const field = r.componentPropNodeField;
      if (field === 'TEXT_DATA') out.characters = key(r.defID);
      else if (field === 'VISIBLE') out.visible = key(r.defID);
      else if (field === 'OVERRIDDEN_SYMBOL_ID') out.mainComponent = key(r.defID);
    }
    return Object.keys(out).length ? out : null;
  }

  /** Values an instance (or an override of a nested one) gives to component properties. */
  private propValues(list: unknown): Record<string, string | boolean> | null {
    const out: Record<string, string | boolean> = {};
    for (const a of (Array.isArray(list) ? list : []) as Fig[]) {
      if (!a.defID || !a.value) continue;
      const v = a.value;
      if (typeof v.boolValue === 'boolean') out[key(a.defID)] = v.boolValue;
      else if (v.textValue && typeof v.textValue.characters === 'string') out[key(a.defID)] = v.textValue.characters;
      else if (v.guidValue) {
        const target = this.ours.get(key(v.guidValue));
        if (target) out[key(a.defID)] = target;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /** The component a Figma guid stands for, if we made it. */
  private component(guid: Fig | undefined): NodeId | null {
    const id = guid ? this.ours.get(key(guid)) : undefined;
    return id && this.tx.doc.type(id) === 'COMPONENT' ? id : null;
  }

  /**
   * The layer of an instance a Figma override path points at: each guid is a
   * layer of the component (or of a nested component); the instance's layer
   * mirrors it through its chain of sources.
   */
  private resolvePath(instance: NodeId, guids: Fig[]): NodeId | null {
    const doc = this.tx.doc;
    let current = instance;
    for (const g of guids) {
      const wanted = new Set<NodeId>(this.byOverrideKey.get(key(g)) ?? []);
      const direct = this.ours.get(key(g));
      if (direct) wanted.add(direct);
      if (wanted.size === 0) return null;
      const mirrors = (id: NodeId) => {
        const seen = new Set<NodeId>();
        let frontier: NodeId[] = [id];
        for (let depth = 0; depth < 64 && frontier.length; depth++) {
          const next: NodeId[] = [];
          for (const x of frontier) {
            if (wanted.has(x)) return true;
            if (seen.has(x)) continue;
            seen.add(x);
            const k = doc.get(x, 'componentKey');
            if (k && doc.store.isAlive(k)) next.push(k);
            const src = sourceOf(doc, x);
            if (src) next.push(src);
          }
          frontier = next;
        }
        return false;
      };
      let found: NodeId | null = null;
      let level: NodeId[] = [...doc.children(current)];
      while (!found && level.length) {
        found = level.find(mirrors) ?? null;
        level = level.flatMap((x) => [...doc.children(x)]);
      }
      if (!found) return null;
      current = found;
    }
    return current;
  }

  /** What a Figma override changes on a layer, in our properties. */
  private overrideProps(o: Fig, target: NodeId): Partial<NodeProps> {
    const doc = this.tx.doc;
    const type = doc.type(target);
    const p: Partial<NodeProps> = {};
    if (o.visible !== undefined) p.visible = o.visible !== false;
    if (o.opacity !== undefined) p.opacity = clamp01(o.opacity);
    if (Array.isArray(o.fillPaints)) p.fills = this.paints(o.fillPaints);
    if (Array.isArray(o.strokePaints)) p.strokes = this.paints(o.strokePaints);
    if (o.strokeWeight !== undefined) p.strokeWeight = Math.max(0, num(o.strokeWeight));
    if (Array.isArray(o.effects)) p.effects = this.effects(o.effects, type === 'TEXT');
    if (o.cornerRadius !== undefined && type !== 'TEXT') p.cornerRadius = Math.max(0, num(o.cornerRadius));
    if (type === 'TEXT') {
      this.textBase(o, p);
      const data = o.textData;
      if (data && typeof data.characters === 'string') {
        p.characters = data.characters;
        const own = doc.store.record(target)!.props as Partial<NodeProps>;
        const base = { ...own, ...p } as Partial<NodeProps>;
        p.textRuns = this.textRuns(data, data.characters, base);
        // A style over the whole text changed the base: that is part of the override too.
        for (const [k, v] of Object.entries(base) as [PropKey, unknown][]) if (!(k in p) && !valueEquals(v, own[k])) (p as Record<string, unknown>)[k] = v;
      }
    }
    if (type === 'INSTANCE') {
      const swap = this.component(o.overriddenSymbolID ?? o.symbolData?.symbolID);
      if (swap) p.mainComponent = swap;
      const values = this.propValues(o.componentPropAssignments);
      if (values) p.propValues = { ...(doc.get(target, 'propValues') ?? {}), ...values };
    }
    return p;
  }

  /** Sets what differs; returns the keys set (they become overrides). */
  private apply(id: NodeId, props: Partial<NodeProps>, changed: Map<NodeId, Set<PropKey>>): void {
    const doc = this.tx.doc;
    for (const [k, v] of Object.entries(props) as [PropKey, unknown][]) {
      if (v === undefined || valueEquals(doc.get(id, k), v)) continue;
      this.tx.set(id, k, v as never);
      let set = changed.get(id);
      if (!set) changed.set(id, (set = new Set()));
      set.add(k);
    }
  }

  /**
   * Links every instance to its component, lets synchronisation fill it in,
   * then applies what Figma overrides: the instance's own look and size,
   * component property values, swaps of nested instances, and changes of
   * layers inside. Overrides are marked, so updating the component keeps them.
   */
  linkInstances(): void {
    const doc = this.tx.doc;
    const tx = this.tx;
    const live: { id: NodeId; fig: Fig }[] = [];
    for (const it of this.instances) {
      const main = this.component(it.fig.symbolData?.symbolID);
      if (!main || wouldCreateCycle(doc, main, doc.parent(it.id)!)) {
        // The component is not in the file: the instance stays as an empty frame of its size.
        this.unlinked++;
        const parent = doc.parent(it.id)!;
        const props = structuredClone(doc.store.record(it.id)!.props) as Partial<NodeProps>;
        const frame = tx.create('FRAME', parent, { ...props, fills: this.paints(it.fig.fillPaints), strokes: [], clipsContent: false }, { after: it.id });
        tx.delete(it.id);
        if (it.fig.guid) this.ours.set(key(it.fig.guid), frame);
        continue;
      }
      tx.set(it.id, 'mainComponent', main);
      live.push(it);
    }
    this.linked = live.length;
    if (live.length === 0) return;
    const ids = live.map((x) => x.id);
    syncComponents(doc, tx, [...ids, ...this.ours.values()].filter((id) => doc.store.isAlive(id)));
    // Round 1: the instance itself — look, size, property values; swaps of nested instances.
    const changed = new Map<NodeId, Set<PropKey>>();
    for (const { id, fig } of live) {
      const own: Partial<NodeProps> = {
        name: fig.name ?? doc.get(id, 'name'),
        visible: fig.visible !== false,
        opacity: fig.opacity === undefined ? 1 : clamp01(fig.opacity),
        width: round(Math.max(0, num(fig.size?.x))),
        height: round(Math.max(0, num(fig.size?.y))),
      };
      if (Array.isArray(fig.fillPaints)) own.fills = this.paints(fig.fillPaints);
      if (Array.isArray(fig.strokePaints)) own.strokes = this.paints(fig.strokePaints);
      if (Array.isArray(fig.effects)) own.effects = this.effects(fig.effects, false);
      const values = this.propValues(fig.componentPropAssignments);
      if (values) own.propValues = values;
      this.apply(id, own, changed);
      for (const o of (fig.symbolData?.symbolOverrides ?? []) as Fig[]) {
        const swap = this.component(o.overriddenSymbolID ?? o.symbolData?.symbolID);
        if (!swap) continue;
        const target = this.resolvePath(id, o.guidPath?.guids ?? []);
        if (target && doc.type(target) === 'INSTANCE') this.apply(target, { mainComponent: swap }, changed);
      }
    }
    markOverrides(doc, tx, changed);
    syncComponents(doc, tx, changed.keys());
    // Round 2: layers inside, now that swapped instances show their new components.
    const inner = new Map<NodeId, Set<PropKey>>();
    for (const { id, fig } of live) {
      for (const o of (fig.symbolData?.symbolOverrides ?? []) as Fig[]) {
        const target = this.resolvePath(id, o.guidPath?.guids ?? []);
        if (!target) continue;
        const props = this.overrideProps(o, target);
        delete props.mainComponent;
        this.apply(target, props, inner);
      }
    }
    markOverrides(doc, tx, inner);
    syncComponents(doc, tx, inner.keys());
  }

  /**
   * A FigJam shape with text (also pasted into design files): its shape and
   * text are not nodes but "generated" descriptions, with their places and
   * outlines computed apart. Becomes a group of the shape and the text.
   */
  private shapeWithText(n: Fig, parent: NodeId, base: Partial<NodeProps>): NodeId | null {
    const generated = (n.nodeGenerationData?.overrides ?? []) as Fig[];
    const derived = (n.derivedImmutableFrameData?.overrides ?? []) as Fig[];
    const part = (localID: number): Fig | null => {
      const match = (o: Fig) => o.guidPath?.guids?.length === 1 && o.guidPath.guids[0].localID === localID;
      const g = generated.find(match);
      if (!g) return null;
      return { ...g, ...(derived.find(match) ?? {}), guid: { sessionID: -1, localID }, name: '' };
    };
    const shape = part(0);
    const text = part(1);
    if (!shape && !text) {
      this.skip('SHAPE_WITH_TEXT');
      return null;
    }
    // A group, as the shape and its text are one thing (and a group has no title on the canvas).
    const id = this.tx.create('GROUP', parent, base);
    const kind = String(n.shapeWithTextType ?? 'SQUARE');
    if (shape) {
      const type = kind === 'SQUARE' || kind === 'ROUNDED_RECTANGLE' ? 'ROUNDED_RECTANGLE' : kind === 'ELLIPSE' ? 'ELLIPSE' : 'VECTOR';
      this.node({ ...shape, type, name: tr('Фигура') }, id, null);
    }
    if (text && String(text.textData?.characters ?? '').trim()) {
      this.node({ ...text, type: 'TEXT', name: String(text.textData.characters).slice(0, 40), textAutoResize: 'HEIGHT' }, id, null);
    }
    return id;
  }

  /** Text of a FigJam object: its own, or the generated text part (as shapes with text keep it). */
  private jamText(n: Fig): { characters: string; fig: Fig | null } {
    const own = String(n.textData?.characters ?? '');
    if (own) return { characters: own, fig: n };
    const generated = (n.nodeGenerationData?.overrides ?? []) as Fig[];
    const t = generated.find((o) => o.textData?.characters);
    return { characters: String(t?.textData?.characters ?? ''), fig: t ?? null };
  }

  private solidHex(paints: unknown, fallback: string): string {
    const p = ((paints ?? []) as Fig[]).find((x) => x.type === 'SOLID' && x.visible !== false);
    if (!p) return fallback;
    const c = color(p.color);
    const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
  }

  /** A FigJam sticky: a sticky of ours with its colour, text and author. */
  private sticky(n: Fig, parent: NodeId, base: Partial<NodeProps>): NodeId | null {
    const fill = this.solidHex(n.fillPaints, '#FFE27A');
    const text = this.jamText(n);
    const id = this.tx.create('FRAME', parent, {
      ...base,
      name: text.characters.split('\n')[0]?.slice(0, 60) || tr('Стикер'),
      cornerRadius: 4,
      clipsContent: false,
      fills: [{ type: 'SOLID', color: { ...color(hexToFig(fill)), a: 1 }, opacity: 1, visible: true }],
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.12 }, offset: { x: 0, y: 2 }, radius: 6, spread: 0, visible: true }],
      board: { kind: 'STICKY', author: n.authorVisible === false ? '' : String(n.authorName ?? '') },
    });
    this.tx.create('TEXT', id, { name: 'Text', board: { kind: 'STICKY_TEXT' }, characters: text.characters, fontSize: 24, textAutoResize: 'HEIGHT', fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1, a: 1 }, opacity: 1, visible: true }] });
    this.stickies++;
    return id;
  }

  /** A FigJam shape with text: a shape of ours (the closest outline), its fill, stroke and text. */
  private boardShape(n: Fig, parent: NodeId, base: Partial<NodeProps>): NodeId | null {
    const generated = (n.nodeGenerationData?.overrides ?? []) as Fig[];
    const shapePart = generated.find((o) => o.guidPath?.guids?.length === 1 && o.guidPath.guids[0].localID === 0) ?? null;
    const text = this.jamText(n);
    const kind = JAM_SHAPES[String(n.shapeWithTextType ?? 'SQUARE')] ?? 'RECTANGLE';
    const fill = this.solidHex(shapePart?.fillPaints ?? n.fillPaints, '#FFFFFF');
    const stroke = this.solidHex(shapePart?.strokePaints ?? n.strokePaints, '');
    const id = this.tx.create('FRAME', parent, { ...base, name: text.characters.split('\n')[0]?.slice(0, 60) || tr('Фигура'), fills: [], clipsContent: false, board: { kind: 'SHAPE', shape: kind } });
    const paint = (hex: string) => ({ type: 'SOLID' as const, color: { ...color(hexToFig(hex)), a: 1 }, opacity: 1, visible: true });
    this.tx.create('VECTOR', id, { name: tr('Фигура'), board: { kind: 'SHAPE_OUTLINE' }, fills: [paint(fill)], strokes: stroke ? [paint(stroke)] : [], strokeWeight: Math.max(1, num(shapePart?.strokeWeight, 2)), strokeAlign: 'INSIDE', strokeJoin: 'ROUND' });
    const size = num(text.fig?.fontSize, 16);
    const ink = (() => {
      const c = color(hexToFig(fill));
      return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 0.5 ? '#FFFFFF' : '#1E1E1E';
    })();
    this.tx.create('TEXT', id, { name: 'Text', board: { kind: 'SHAPE_TEXT' }, characters: text.characters, fontSize: size, textAlignH: 'CENTER', textAutoResize: 'HEIGHT', fills: [paint(this.solidHex(text.fig?.fillPaints, ink))] });
    this.shapes++;
    return id;
  }

  /** A FigJam connector: ours, attached once every layer exists (linkConnectors). */
  private connector(n: Fig, parent: NodeId, base: Partial<NodeProps>): NodeId | null {
    const style = String(n.connectorLineStyle ?? n.connectorLineType ?? 'ELBOWED');
    const route = style === 'STRAIGHT' ? 'STRAIGHT' : style === 'CURVED' ? 'CURVE' : 'ELBOW';
    const cap = (v: unknown) => (v === undefined || v === null || v === 'NONE' ? 'NONE' : 'ARROW');
    const free = (end: Fig | undefined) => {
      const p = end?.position ?? {};
      return { node: null, side: 'AUTO' as const, x: num(base.x) + num(p.x), y: num(base.y) + num(p.y) };
    };
    const id = this.tx.create('VECTOR', parent, {
      ...base,
      name: tr('Связь'),
      fills: [],
      strokes: [{ type: 'SOLID', color: { ...color(hexToFig(this.solidHex(n.strokePaints, '#1E1E1E'))), a: 1 }, opacity: 1, visible: true }],
      strokeWeight: Math.max(1, num(n.strokeWeight, 2)),
      strokeAlign: 'CENTER',
      strokeJoin: 'ROUND',
      strokeCap: 'ROUND',
      startCap: cap(n.connectorStartCap ?? n.connectorStartStrokeCap),
      endCap: n.connectorEndCap === undefined && n.connectorEndStrokeCap === undefined ? 'ARROW' : cap(n.connectorEndCap ?? n.connectorEndStrokeCap),
      board: { kind: 'CONNECTOR', route, start: free(n.connectorStart), end: free(n.connectorEnd) },
    });
    this.pendingConnectors.push({ id, fig: n });
    this.connectors++;
    return id;
  }

  /** Ends of FigJam connectors onto the layers made from the objects they were attached to; labels from their text. */
  linkConnectors(): void {
    const side = (m: unknown) => (m === 'TOP' || m === 'BOTTOM' || m === 'LEFT' || m === 'RIGHT' ? m : 'AUTO');
    for (const { id, fig } of this.pendingConnectors) {
      const role = this.tx.doc.get(id, 'board');
      if (role?.kind !== 'CONNECTOR') continue;
      const end = (e: Fig | undefined, current: typeof role.start) => {
        const node = e?.endpointNodeID ? this.ours.get(key(e.endpointNodeID)) : undefined;
        return node ? { ...current, node, side: side(e?.magnet) as typeof current.side } : current;
      };
      this.tx.set(id, 'board', { ...role, start: end(fig.connectorStart, role.start), end: end(fig.connectorEnd, role.end) });
      const label = this.jamText(fig).characters.trim();
      if (label) {
        const l = this.tx.create('FRAME', this.tx.doc.parent(id)!, { name: tr('Подпись'), fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }], cornerRadius: 4, layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, clipsContent: false, board: { kind: 'CONNECTOR_LABEL', connector: id } });
        this.tx.create('TEXT', l, { name: 'Text', characters: label, fontSize: 14, fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1, a: 1 }, opacity: 1, visible: true }] });
      }
    }
  }

  private lineEnds(n: Fig): Partial<NodeProps> {
    // Arrow heads of a line (one cap for both ends in Figma's simple case).
    const cap = lineCap(n.strokeCap);
    return cap ? { endCap: cap } : {};
  }

  private vector(n: Fig, parent: NodeId, props: Partial<NodeProps>): NodeId | null {
    const sx = num(n.size?.x, 1);
    const sy = num(n.size?.y, 1);
    let paths: VectorPath[] = [];
    let evenOdd = false;
    const data = n.vectorData;
    const blob = data ? this.blob(data.vectorNetworkBlob) : null;
    if (blob) {
      // The network itself: points, segments and filled regions stay editable as in Figma.
      try {
        const norm = data.normalizedSize ?? { x: sx, y: sy };
        const table = new Map<number, Fig>(((data.styleOverrideTable ?? []) as Fig[]).map((o) => [num(o.styleID), o]));
        const regionFills = (styleId: number) => {
          const o = table.get(styleId);
          return o && Array.isArray(o.fillPaints) ? this.paints(o.fillPaints) : undefined;
        };
        let net: VectorNetwork | null = networkFromFig(blob, num(norm.x) ? sx / num(norm.x) : 1, num(norm.y) ? sy / num(norm.y) : 1, regionFills);
        // Figma fills the closed loops of a network without regions: the same here (simple rings), or its own outline below.
        const filled = ((n.fillPaints ?? []) as Fig[]).some((x) => x.visible !== false);
        if (net.regions.length === 0 && filled) {
          const rings = ringLoops(net);
          const odd = ((n.fillGeometry ?? []) as Fig[]).some((g) => g.windingRule === 'ODD');
          net = rings ? { ...net, regions: [{ loops: rings, windingRule: odd ? 'EVENODD' : 'NONZERO' }] } : null;
        }
        if (net && net.segments.length > 0) return this.tx.create('VECTOR', parent, { ...props, vectorPaths: [], vectorNetwork: net, windingRule: net.regions.some((r) => r.windingRule === 'EVENODD') ? 'EVENODD' : 'NONZERO' });
      } catch {
        // a broken network: the outline of its fill below
      }
    }
    if (paths.length === 0) {
      for (const g of (n.fillGeometry ?? []) as Fig[]) {
        const bytes = this.blob(g.commandsBlob);
        if (!bytes) continue;
        try {
          paths.push(...commandsToPaths(bytes));
        } catch {
          // a broken path is left out
        }
        if (g.windingRule === 'ODD') evenOdd = true;
      }
    }
    if (paths.length === 0) {
      this.skip('empty vector');
      return null;
    }
    return this.tx.create('VECTOR', parent, { ...props, vectorPaths: paths, windingRule: evenOdd ? 'EVENODD' : 'NONZERO' });
  }

  private textBase(style: Fig, into: Partial<NodeProps>): void {
    if (style.fontName?.family) {
      const family = String(style.fontName.family);
      const { weight, italic } = parseFontStyle(style.fontName.style);
      this.fonts.add(family);
      into.fontFamily = family;
      into.fontWeight = weight;
      into.italic = italic;
    }
    if (style.fontSize !== undefined) into.fontSize = Math.max(1, num(style.fontSize, 12));
    const lh = lineHeight(style.lineHeight);
    if (lh) into.lineHeight = lh;
    const ls = letterSpacing(style.letterSpacing);
    if (ls) into.letterSpacing = ls;
    if (style.textCase === 'UPPER' || style.textCase === 'LOWER' || style.textCase === 'TITLE' || style.textCase === 'ORIGINAL') into.textCase = style.textCase;
    if (style.textCase === 'SMALL_CAPS' || style.textCase === 'SMALL_CAPS_FORCED') into.fontVariantCaps = style.textCase === 'SMALL_CAPS' ? 'SMALL_CAPS' : 'ALL_SMALL_CAPS';
    if (style.textDecoration === 'UNDERLINE' || style.textDecoration === 'STRIKETHROUGH' || style.textDecoration === 'NONE') into.textDecoration = style.textDecoration;
    if (style.paragraphSpacing !== undefined) into.paragraphSpacing = Math.max(0, num(style.paragraphSpacing));
    if (style.paragraphIndent !== undefined) into.paragraphIndent = Math.max(0, num(style.paragraphIndent));
    // OpenType features (Figma keeps them as enum names, "TNUM"), variation axes (tags as numbers) and vertical trim.
    const features: Record<string, boolean> = {};
    for (const f of (style.toggledOnOTFeatures ?? []) as unknown[]) if (typeof f === 'string' && /^[A-Z0-9]{4}$/.test(f)) features[f.toLowerCase()] = true;
    for (const f of (style.toggledOffOTFeatures ?? []) as unknown[]) if (typeof f === 'string' && /^[A-Z0-9]{4}$/.test(f)) features[f.toLowerCase()] = false;
    if (Object.keys(features).length) into.fontFeatures = features;
    const axes: Record<string, number> = {};
    for (const a of (style.fontVariations ?? []) as Fig[]) {
      const t = typeof a.axisTag === 'number' ? String.fromCharCode((a.axisTag >>> 24) & 255, (a.axisTag >>> 16) & 255, (a.axisTag >>> 8) & 255, a.axisTag & 255) : String(a.axisTag ?? '');
      if (/^[\w ]{4}$/.test(t) && t !== 'wght' && Number.isFinite(a.value)) axes[t] = Number(a.value);
    }
    if (Object.keys(axes).length) into.fontVariations = axes;
    if (style.leadingTrim === 'CAP_HEIGHT') into.leadingTrim = 'CAP_HEIGHT';
    if (style.hangingPunctuation === true) into.hangingPunctuation = true;
    if (style.hangingList === true) into.hangingList = true;
  }

  /** What an override of the style table changes against the text's base. */
  private runStyle(o: Fig, base: Partial<NodeProps>): TextRunStyle {
    const out: TextRunStyle = {};
    if (o.fontName?.family) {
      const family = String(o.fontName.family);
      const { weight, italic } = parseFontStyle(o.fontName.style);
      this.fonts.add(family);
      if (family !== base.fontFamily) out.fontFamily = family;
      if (weight !== base.fontWeight) out.fontWeight = weight;
      if (italic !== base.italic) out.italic = italic;
    }
    if (o.fontSize !== undefined && num(o.fontSize) !== base.fontSize) out.fontSize = Math.max(1, num(o.fontSize, 12));
    if (Array.isArray(o.fillPaints)) out.fills = this.paints(o.fillPaints);
    if (o.textDecoration === 'UNDERLINE' || o.textDecoration === 'STRIKETHROUGH' || o.textDecoration === 'NONE') {
      if (o.textDecoration !== (base.textDecoration ?? 'NONE')) out.textDecoration = o.textDecoration;
    }
    const ls = letterSpacing(o.letterSpacing);
    if (ls && JSON.stringify(ls) !== JSON.stringify(base.letterSpacing)) out.letterSpacing = ls;
    const url = o.hyperlink?.url;
    if (typeof url === 'string' && /^(https?:|mailto:|tel:)/i.test(url)) out.link = url;
    return out;
  }

  private text(n: Fig, parent: NodeId, common: Partial<NodeProps>): NodeId | null {
    const data = n.textData ?? {};
    const characters = String(data.characters ?? '');
    if (!characters) {
      this.skip('empty text');
      return null;
    }
    const props: Partial<NodeProps> = { ...common, characters };
    this.textBase(n, props);
    props.textAlignH = n.textAlignHorizontal === 'CENTER' || n.textAlignHorizontal === 'RIGHT' || n.textAlignHorizontal === 'JUSTIFIED' ? n.textAlignHorizontal : 'LEFT';
    props.textAlignV = n.textAlignVertical === 'CENTER' || n.textAlignVertical === 'BOTTOM' ? n.textAlignVertical : 'TOP';
    props.textAutoResize = n.textAutoResize === 'WIDTH_AND_HEIGHT' || n.textAutoResize === 'HEIGHT' ? n.textAutoResize : 'NONE';
    if (n.maxLines) props.maxLines = Math.max(0, Math.round(num(n.maxLines)));
    const lines = (data.lines ?? []) as Fig[];
    if (lines.length && lines.every((l) => l.lineType === 'UNORDERED_LIST')) props.listType = 'BULLET';
    else if (lines.length && lines.every((l) => l.lineType === 'ORDERED_LIST')) props.listType = 'NUMBER';
    const runs = this.textRuns(data, characters, props);
    if (runs.length) props.textRuns = runs;
    return this.tx.create('TEXT', parent, props);
  }

  /** Mixed styles: a style id per character (missing — the base, 0); one style over all the text becomes the base. */
  private textRuns(data: Fig, characters: string, props: Partial<NodeProps>): TextRun[] {
    const ids = (data.characterStyleIDs ?? []) as number[];
    const table = new Map<number, Fig>(((data.styleOverrideTable ?? []) as Fig[]).map((o) => [num(o.styleID), o]));
    const idAt = (i: number) => (i < ids.length ? num(ids[i]) : 0);
    // One override over the whole text is its base style.
    if (ids.length >= characters.length && ids.every((x) => x === ids[0]) && table.has(ids[0]!)) {
      const o = table.get(ids[0]!)!;
      this.textBase(o, props);
      if (Array.isArray(o.fillPaints)) props.fills = this.paints(o.fillPaints);
      table.delete(ids[0]!);
    }
    const runs: TextRun[] = [];
    let start = 0;
    for (let i = 1; i <= characters.length; i++) {
      if (i < characters.length && idAt(i) === idAt(start)) continue;
      const o = table.get(idAt(start));
      if (o) {
        const style = this.runStyle(o, props);
        if (Object.keys(style).length) runs.push({ start, end: i, style });
      }
      start = i;
    }
    return runs;
  }
}

function constraint(v: unknown): ConstraintType | null {
  if (v === 'MIN' || v === 'FIXED_MIN') return 'MIN';
  if (v === 'MAX' || v === 'FIXED_MAX') return 'MAX';
  if (v === 'CENTER' || v === 'STRETCH' || v === 'SCALE') return v;
  return null;
}

function strokeCap(v: unknown): StrokeCap | null {
  return v === 'ROUND' || v === 'SQUARE' || v === 'NONE' ? v : null;
}

function lineCap(v: unknown): LineCap | null {
  switch (v) {
    case 'ARROW_LINES':
      return 'LINE_ARROW';
    case 'ARROW_EQUILATERAL':
    case 'TRIANGLE_FILLED':
      return 'ARROW';
    case 'CIRCLE_FILLED':
      return 'CIRCLE';
    case 'DIAMOND_FILLED':
      return 'DIAMOND';
    default:
      return null;
  }
}

function lineHeight(v: Fig | undefined): LineHeight | null {
  if (!v || v.value === undefined) return null;
  const value = num(v.value);
  if (v.units === 'PIXELS') return { unit: 'PX', value: Math.max(0, value) };
  // Figma's "Auto" is 100 percent.
  if (v.units === 'PERCENT') return Math.abs(value - 100) < 0.001 ? { unit: 'AUTO' } : { unit: 'PERCENT', value };
  if (v.units === 'RAW') return { unit: 'MULTIPLIER', value };
  return null;
}

function letterSpacing(v: Fig | undefined): LetterSpacing | null {
  if (!v || v.value === undefined) return null;
  return { unit: v.units === 'PERCENT' ? 'PERCENT' : 'PX', value: round(num(v.value)) };
}

/** Builds our document from a read .fig. */
export function convertFig(archive: FigArchive, name: string, board = false): FigImportResult {
  const doc = new Document();
  const out: Omit<FigImportResult, 'doc'> = { count: 0, skipped: new Map(), fonts: new Set(), missingImages: 0, components: 0, instances: 0, unlinked: 0, styles: 0 };
  doc.transact(
    (tx) => {
      const root = tx.createRoot(name);
      const c = new Converter(archive, tx);
      c.rootId = root;
      c.board = board;
      if (board) tx.update(root, { fileKind: 'BOARD', boardAuthors: true });
      const figRoot = c.root();
      const pages = figRoot ? c.pagesOf(figRoot) : [];
      if (pages.length === 0) tx.create('PAGE', root, { name: tr('Страница 1') });
      for (const p of pages) c.page(p, root);
      const hidden = figRoot ? c.internalPagesOf(figRoot) : [];
      if (hidden.length) c.libraryPage(hidden, root);
      // Styles first: instances then take the bindings from their components.
      c.bindStyles();
      c.linkInstances();
      c.linkConnectors();
      out.board = { stickies: c.stickies, shapes: c.shapes, connectors: c.connectors };
      out.count = c.count;
      out.styles = c.styleCount;
      out.components = c.components;
      out.instances = c.linked;
      out.unlinked = c.unlinked;
      out.skipped = c.skipped;
      out.fonts = c.fonts;
      out.missingImages = c.missingImages;
    },
    { undoable: false },
  );
  return { doc, ...out };
}
