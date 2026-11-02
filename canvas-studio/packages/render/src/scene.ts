// Scene graph: render-side caches for one page — world transforms, bounds,
// paint order and a spatial index for culling and hit-testing.
// It never mutates the document; it only listens to change sets.

import type { ChangeSet, Document, NodeId, PropKey } from '#core';
import { nodePaths } from '#layout';
import {
  IDENTITY,
  apply,
  distanceToSegment,
  ellipseContains,
  polygonContains,
  flattenPaths,
  insideRegion,
  invert,
  multiply,
  nodeTransform,
  transformRect,
  union,
  warpExtent,
  warpOutline,
  SpatialIndex,
  type Matrix,
  type Point,
  type Rect,
} from '#geometry';

/** Where a layer is, not what it looks like. */
const PLACEMENT_KEYS: ReadonlySet<PropKey> = new Set<PropKey>(['x', 'y', 'rotation']);
const GEOMETRY_KEYS: ReadonlySet<PropKey> = new Set<PropKey>(['x', 'y', 'width', 'height', 'rotation', 'strokeWeight', 'strokeWeights', 'strokeAlign', 'strokeJoin', 'strokeMiterLimit', 'effects', 'strokes', 'startCap', 'endCap', 'vectorPaths', 'vectorNetwork', 'booleanOp', 'warp', 'hangingPunctuation', 'hangingList', 'decorationStyle', 'decorationThickness', 'underlineOffset']);
const CLIP_KEYS: ReadonlySet<PropKey> = new Set<PropKey>(['clipsContent', 'visible']);

export interface HitOptions {
  /** Extra hit tolerance in world units (for thin lines). */
  tolerance?: number;
  includeLocked?: boolean;
  includeHidden?: boolean;
}

export class SceneGraph {
  readonly doc: Document;
  pageId: NodeId;

  private readonly worldCache = new Map<NodeId, Matrix>();
  private readonly boundsCache = new Map<NodeId, Rect>();
  private readonly renderBoundsCache = new Map<NodeId, Rect>();
  private readonly order = new Map<NodeId, number>();
  private readonly index = new SpatialIndex<NodeId>(512);
  private structureDirty = true;
  private readonly dirtyGeometry = new Set<NodeId>();
  version = 0;
  /**
   * Damage: world areas whose picture changed since the last `takeDamage()`
   * (old places of changed layers now, their new places once recomputed).
   * A cache of drawn tiles redraws only what is under them.
   */
  private damage: Rect[] = [];
  private damageNew = new Set<NodeId>();
  private damageAll = true;
  /**
   * Layers lifted off the page while they are dragged (drawn apart, moved as
   * one picture): their changes are not damage — the tiles do not hold them.
   */
  readonly quiet = new Set<NodeId>();
  /**
   * Boolean operations "entered" (selected, or with something inside selected): their shapes can be
   * clicked anywhere, the cut-away part too, to move or edit them (as in Figma).
   */
  readonly openBooleans = new Set<NodeId>();
  /**
   * Outline view (as in Figma): a click near a drawn outline takes that layer first — one under others,
   * cut off by its frame or (with `hidden`) hidden; elsewhere clicks work as usual.
   */
  outlines: { hidden: boolean } | null = null;

  /** Switches outline view: what frames clip (and hidden layers) then count in render bounds — they are drawn. */
  setOutlines(outlines: { hidden: boolean } | null): void {
    if (JSON.stringify(outlines) === JSON.stringify(this.outlines)) return;
    this.outlines = outlines;
    this.structureDirty = true;
  }

  constructor(doc: Document, pageId: NodeId) {
    this.doc = doc;
    this.pageId = pageId;
  }

  setPage(pageId: NodeId): void {
    if (pageId === this.pageId) return;
    this.pageId = pageId;
    this.structureDirty = true;
    this.damageAll = true;
    this.version++;
  }

  /** When a layer or anything inside it last changed (scene version); stamps by layer. */
  private readonly painted = new Map<NodeId, number>();
  private paintedAll = 0;

  /** The scene version everything was last to be drawn anew at (pictures and fonts loaded, theme). */
  get allPaintVersion(): number {
    return this.paintedAll;
  }

  /** The scene version a layer's own picture was last changed at: moving its parents does not count. */
  paintVersion(id: NodeId): number {
    return Math.max(this.painted.get(id) ?? 0, this.paintedAll);
  }

  /** Invalidates caches affected by a change set. */
  invalidate(changes: ChangeSet): void {
    this.version++;
    for (const id of changes.touched()) {
      // Moved or turned as a whole: the layer's own picture stays, its parents' changes.
      const keys = changes.updated.get(id);
      if (!keys || [...keys].some((k) => !PLACEMENT_KEYS.has(k))) this.painted.set(id, this.version);
      for (const a of this.doc.store.ancestors(id)) this.painted.set(a, this.version);
    }
    this.noteDamage(changes);
    if (changes.structural) {
      this.structureDirty = true;
      return;
    }
    // Stacking order flipped or the layout gone: paint order changes (hit-testing follows it).
    for (const keys of changes.updated.values()) {
      if (keys.has('itemReverseZIndex') || keys.has('layoutMode')) {
        this.structureDirty = true;
        return;
      }
    }
    for (const [id, keys] of changes.updated) {
      for (const key of keys) {
        if (GEOMETRY_KEYS.has(key) || CLIP_KEYS.has(key)) {
          this.dirtyGeometry.add(id);
          break;
        }
      }
    }
  }

  /** Where the changed layers were painted (and, through masks, what they cropped), before the change. */
  private noteDamage(changes: ChangeSet): void {
    if (this.damageAll) return;
    // The page's background is under everything: it has no bounds of its own.
    if (changes.updated.get(this.pageId)?.has('backgroundColor')) {
      this.damageAll = true;
      return;
    }
    for (const id of changes.touched()) {
      if (this.quiet.size && this.isQuiet(id)) continue;
      const old = this.renderBoundsCache.get(id);
      if (old) this.damage.push(old);
      // A mask crops the layers above it: their whole parent may look different.
      const parent = this.doc.store.record(id)?.parent;
      if (parent && this.renderBoundsCache.has(parent) && this.doc.children(parent).some((c) => this.doc.get(c, 'isMask'))) {
        this.damage.push(this.renderBoundsCache.get(parent)!);
        this.damageNew.add(parent);
      }
      this.damageNew.add(id);
    }
    if (this.damage.length > 4000) this.damageAll = true;
  }

  private isQuiet(id: NodeId): boolean {
    if (this.quiet.has(id)) return true;
    for (const a of this.doc.store.ancestors(id)) if (this.quiet.has(a)) return true;
    return false;
  }

  /** Marks areas as painted differently (a layer lifted off the page or put back). */
  damageAreas(rects: readonly Rect[]): void {
    if (!this.damageAll) this.damage.push(...rects);
  }

  /** Marks the whole page as changed (theme, fonts, pictures loaded, view settings). */
  damageEverything(): void {
    // Pictures drawn from the page (warps) are made again too.
    this.version++;
    this.paintedAll = this.version;
    this.damageAll = true;
  }

  /** Areas painted differently since the last call; `all` — anything may have changed. */
  takeDamage(): { all: boolean; rects: Rect[] } {
    this.ensure();
    const all = this.damageAll;
    const rects = this.damage;
    if (!all) {
      for (const id of this.damageNew) {
        const now = this.renderBoundsCache.get(id);
        if (now && this.doc.store.isAlive(id)) rects.push(now);
      }
    }
    this.damage = [];
    this.damageNew = new Set();
    this.damageAll = false;
    return { all, rects: all ? [] : rects };
  }

  /** Brings caches up to date. Called once per frame before rendering or hit-testing. */
  ensure(): void {
    if (this.structureDirty) {
      this.rebuild();
      return;
    }
    if (this.dirtyGeometry.size === 0) return;
    const roots = [...this.dirtyGeometry].filter((id) => this.doc.store.isAlive(id) && this.order.has(id));
    this.dirtyGeometry.clear();
    for (const id of roots) {
      const parent = this.doc.parent(id);
      const parentWorld = parent && parent !== this.pageId ? this.world(parent) : IDENTITY;
      this.computeSubtree(id, parentWorld);
      // Ancestors' render bounds may have grown or shrunk.
      for (const ancestor of this.doc.store.ancestors(id)) {
        if (ancestor === this.pageId) break;
        this.renderBoundsCache.set(ancestor, this.computeRenderBounds(ancestor));
      }
    }
  }

  private rebuild(): void {
    this.worldCache.clear();
    this.boundsCache.clear();
    this.renderBoundsCache.clear();
    this.order.clear();
    this.index.clear();
    this.dirtyGeometry.clear();
    this.structureDirty = false;
    if (!this.doc.store.isAlive(this.pageId)) return;
    let n = 0;
    // Paint order: a row or column with "first on top" draws its children backwards.
    const walk = (parent: NodeId) => {
      for (const id of this.doc.paintChildren(parent)) {
        this.order.set(id, n++);
        walk(id);
      }
    };
    walk(this.pageId);
    for (const child of this.doc.children(this.pageId)) this.computeSubtree(child, IDENTITY);
  }

  /** Recomputes transforms and bounds for `id` and its descendants; returns its render bounds. */
  private computeSubtree(id: NodeId, parentWorld: Matrix): Rect {
    const d = this.doc;
    const world = multiply(parentWorld, nodeTransform(d.get(id, 'x'), d.get(id, 'y'), d.get(id, 'rotation')));
    this.worldCache.set(id, world);
    const bounds = transformRect(world, { x: 0, y: 0, width: d.get(id, 'width'), height: d.get(id, 'height') });
    this.boundsCache.set(id, bounds);
    // A warped layer can be clicked where its picture is (corners dragged beyond the box).
    this.index.set(id, this.warpedBox(id, world) ?? bounds);
    let render = this.outset(id, bounds);
    const clips = d.get(id, 'clipsContent');
    for (const child of d.children(id)) {
      const childRender = this.computeSubtree(child, world);
      const o = this.outlines;
      if ((!clips || o) && (d.get(child, 'visible') || o?.hidden)) render = union(render, childRender);
    }
    this.renderBoundsCache.set(id, render);
    return render;
  }

  /** Where a warped layer's picture is, in world space; null — not warped. */
  private warpedBox(id: NodeId, world: Matrix): Rect | null {
    const warp = this.doc.get(id, 'warp');
    if (!warp) return null;
    const w = this.doc.get(id, 'width');
    const h = this.doc.get(id, 'height');
    const e = warpExtent(warp);
    return transformRect(world, { x: e.minX * w, y: e.minY * h, width: (e.maxX - e.minX) * w, height: (e.maxY - e.minY) * h });
  }

  /** Strokes outside the box and shadows/blur extend what is painted (exports and culling need it). */
  private outset(id: NodeId, rect: Rect): Rect {
    let render = rect;
    const d = this.doc;
    let { left, top, right, bottom } = this.paintMargins(id);
    // A warp may carry the picture beyond the box.
    const warp = d.get(id, 'warp');
    if (warp) {
      const e = warpExtent(warp);
      const w = d.get(id, 'width');
      const h = d.get(id, 'height');
      left += -e.minX * w;
      top += -e.minY * h;
      right += (e.maxX - 1) * w;
      bottom += (e.maxY - 1) * h;
    }
    if (left || top || right || bottom) {
      render = { x: render.x - left, y: render.y - top, width: render.width + left + right, height: render.height + top + bottom };
    }
    return render;
  }

  /** How far strokes, shadows and blur paint beyond the layer's box, in its own units (no warp). */
  paintMargins(id: NodeId): { left: number; top: number; right: number; bottom: number } {
    const d = this.doc;
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    if (d.get(id, 'strokes').some((p) => p.visible)) {
      const align = d.type(id) === 'LINE' ? 'CENTER' : d.get(id, 'strokeAlign');
      const sides = d.get(id, 'strokeWeights');
      const weight = sides ? Math.max(...sides) : d.get(id, 'strokeWeight');
      const out = align === 'OUTSIDE' ? weight : align === 'CENTER' ? weight / 2 : 0;
      // Miter joins can reach further than the stroke; round and square caps half a weight.
      const join = d.get(id, 'strokeJoin') === 'MITER' && align !== 'INSIDE' ? (weight / 2) * Math.min(d.get(id, 'strokeMiterLimit'), 4) : 0;
      const ends = d.type(id) === 'LINE' || d.type(id) === 'VECTOR';
      const caps = ends && (d.get(id, 'startCap') !== 'NONE' || d.get(id, 'endCap') !== 'NONE') ? Math.max(6, weight * 4) : 0;
      left = top = right = bottom = Math.max(out, join, caps);
    }
    for (const e of d.get(id, 'effects')) {
      if (!e.visible) continue;
      if (e.type === 'DROP_SHADOW') {
        const r = e.radius + Math.max(0, e.spread);
        left = Math.max(left, r - e.offset.x);
        right = Math.max(right, r + e.offset.x);
        top = Math.max(top, r - e.offset.y);
        bottom = Math.max(bottom, r + e.offset.y);
      } else if (e.type === 'TEXTURE' && !e.clipToShape) {
        // A roughened edge frays up to its radius outwards.
        left = Math.max(left, e.radius * 1.5);
        right = Math.max(right, e.radius * 1.5);
        top = Math.max(top, e.radius * 1.5);
        bottom = Math.max(bottom, e.radius * 1.5);
      } else if (e.type === 'LAYER_BLUR') {
        // The blur is a Gaussian with σ = radius (CSS blur()): it shows up to about 3σ out (BUG-129:
        // with 1σ a tile next to a strongly blurred layer culled it, and its glow ended at the tile's edge).
        const reach = e.radius * 3;
        left = Math.max(left, reach);
        right = Math.max(right, reach);
        top = Math.max(top, reach);
        bottom = Math.max(bottom, reach);
      }
    }
    // Hanging marks and list markers stand outside the text's box.
    if (d.type(id) === 'TEXT' && (d.get(id, 'hangingPunctuation') || d.get(id, 'hangingList'))) {
      const size = Math.max(d.get(id, 'fontSize'), ...d.get(id, 'textRuns').map((r) => r.style.fontSize ?? 0));
      left = Math.max(left, size * 2);
      right = Math.max(right, size);
    }
    // A wavy, thick or lowered underline may reach below the text's box.
    if (d.type(id) === 'TEXT' && (d.get(id, 'decorationStyle') !== 'SOLID' || d.get(id, 'decorationThickness') !== null || d.get(id, 'underlineOffset') !== null)) {
      const size = Math.max(d.get(id, 'fontSize'), ...d.get(id, 'textRuns').map((r) => r.style.fontSize ?? 0));
      bottom = Math.max(bottom, size * 0.5 + (d.get(id, 'decorationThickness') ?? size / 16) * 3 + Math.max(0, d.get(id, 'underlineOffset') ?? 0));
    }
    // A sticky's lifted corners cast a shadow below it (drawn by the renderer).
    if (d.type(id) === 'FRAME' && d.get(id, 'board')?.kind === 'STICKY') {
      left = Math.max(left, 24);
      right = Math.max(right, 24);
      bottom = Math.max(bottom, 50);
    }
    return { left, top, right, bottom };
  }

  private computeRenderBounds(id: NodeId): Rect {
    let render = this.bounds(id);
    render = this.outset(id, render);
    if (this.doc.get(id, 'clipsContent') && !this.outlines) return render;
    for (const child of this.doc.children(id)) {
      if (!this.doc.get(child, 'visible') && !this.outlines?.hidden) continue;
      const rb = this.renderBoundsCache.get(child);
      if (rb) render = union(render, rb);
    }
    return render;
  }

  /** World transform of a node (maps its local box to world space). */
  world(id: NodeId): Matrix {
    // Caches may be stale right after an edit (bounds() refreshed them, world() did not).
    this.ensure();
    const cached = this.worldCache.get(id);
    if (cached) return cached;
    // Nodes outside the current page (or not yet cached) are computed on demand.
    const parent = this.doc.parent(id);
    const parentWorld = parent && this.doc.type(parent) !== 'PAGE' ? this.world(parent) : IDENTITY;
    return multiply(parentWorld, nodeTransform(this.doc.get(id, 'x'), this.doc.get(id, 'y'), this.doc.get(id, 'rotation')));
  }

  /** World-space axis-aligned bounds of a node's own box. */
  bounds(id: NodeId): Rect {
    this.ensure();
    return this.boundsCache.get(id) ?? transformRect(this.world(id), { x: 0, y: 0, width: this.doc.get(id, 'width'), height: this.doc.get(id, 'height') });
  }

  /** Bounds of everything the node paints, including unclipped children. */
  renderBounds(id: NodeId): Rect {
    this.ensure();
    return this.renderBoundsCache.get(id) ?? this.bounds(id);
  }

  /** Paint order (higher = painted later = on top). */
  paintOrder(id: NodeId): number {
    return this.order.get(id) ?? -1;
  }

  /** Bounds of all top-level content on the page. */
  contentBounds(): Rect | null {
    this.ensure();
    let out: Rect | null = null;
    for (const id of this.doc.children(this.pageId)) {
      if (!this.doc.get(id, 'visible') && !this.outlines?.hidden) continue;
      const rb = this.renderBounds(id);
      out = out ? union(out, rb) : rb;
    }
    return out;
  }

  /** Nodes whose bounds intersect a world rectangle. */
  queryRect(r: Rect): NodeId[] {
    this.ensure();
    return this.index.query(r);
  }

  /**
   * All nodes under a world point, top-most first. A node clipped away by an
   * ancestor frame at that point is not hit.
   */
  hitTest(p: Point, options: HitOptions = {}): NodeId[] {
    this.ensure();
    const tolerance = options.tolerance ?? 0;
    const candidates = this.index.queryPoint(p, tolerance);
    if (this.outlines) {
      const near = candidates.filter((id) => this.nearOutline(id, p, Math.max(tolerance, 1e-6), { ...options, includeHidden: options.includeHidden || this.outlines!.hidden }));
      if (near.length > 0) return near.sort((a, b) => this.paintOrder(b) - this.paintOrder(a));
    }
    const hits = candidates.filter((id) => this.hitsNode(id, p, tolerance, options));
    hits.sort((a, b) => this.paintOrder(b) - this.paintOrder(a));
    return hits;
  }

  private hitsNode(id: NodeId, p: Point, tolerance: number, options: HitOptions): boolean {
    const d = this.doc;
    if (!d.store.isAlive(id)) return false;
    // Visibility, locking and clipping are inherited from ancestors.
    let current: NodeId | null = id;
    while (current !== null && current !== this.pageId) {
      if (!options.includeHidden && !d.get(current, 'visible')) return false;
      if (!options.includeLocked && d.get(current, 'locked')) return false;
      if (current !== id && d.get(current, 'clipsContent') && !this.insideBox(current, p, 0)) return false;
      // Inside a warped layer its content is part of one stretched picture: the layer itself is clicked.
      if (current !== id && d.get(current, 'warp')) return false;
      // Inside a boolean operation only its result is there to click: not a hole, not what was cut away.
      if (current !== id && d.type(current) === 'BOOLEAN_OPERATION' && !this.openBooleans.has(current) && !this.insideShape(current, p, tolerance)) return false;
      current = d.parent(current);
    }
    return this.insideShape(id, p, tolerance);
  }

  /** Outline view: on the layer's line (a text — anywhere in its box), whatever covers or clips it. */
  private nearOutline(id: NodeId, p: Point, tolerance: number, options: HitOptions): boolean {
    const d = this.doc;
    if (!d.store.isAlive(id)) return false;
    for (let at: NodeId | null = id; at !== null && at !== this.pageId; at = d.parent(at)) {
      if (!options.includeHidden && !d.get(at, 'visible')) return false;
      if (!options.includeLocked && d.get(at, 'locked')) return false;
    }
    const type = d.type(id);
    if (type === 'GROUP') return false;
    if (type === 'TEXT') return this.insideBox(id, p, tolerance);
    const inv = invert(this.world(id));
    if (!inv) return false;
    const local = apply(inv, p);
    const w = d.get(id, 'width');
    // Distances in the layer's space: its scale is that of the world here (no scaling in transforms).
    if (type === 'LINE') return distanceToSegment(local, { x: 0, y: 0 }, { x: w, y: 0 }) <= tolerance;
    // Components, copies and sections have no shape of their own: their box.
    const paths = nodePaths(d, id);
    const h = d.get(id, 'height');
    const box = [{ closed: true, points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }] }];
    return (paths.length ? flattenPaths(paths, 0.5) : box).some((l) =>
      l.points.some((a, i) => {
        const b = l.points[i + 1] ?? (l.closed ? l.points[0] : undefined);
        return b !== undefined && distanceToSegment(local, a, b) <= tolerance;
      }),
    );
  }

  private insideBox(id: NodeId, p: Point, tolerance: number): boolean {
    const inv = invert(this.world(id));
    if (!inv) return false;
    const local = apply(inv, p);
    const w = this.doc.get(id, 'width');
    const h = this.doc.get(id, 'height');
    return local.x >= -tolerance && local.y >= -tolerance && local.x <= w + tolerance && local.y <= h + tolerance;
  }

  private insideShape(id: NodeId, p: Point, tolerance: number): boolean {
    const type = this.doc.type(id);
    const inv = invert(this.world(id));
    if (!inv) return false;
    const local = apply(inv, p);
    const w = this.doc.get(id, 'width');
    const h = this.doc.get(id, 'height');
    // A warped layer is where its picture is: inside the warped outline.
    const warp = this.doc.get(id, 'warp');
    if (warp && w > 0 && h > 0) {
      const outline = warpOutline(warp).map((q) => ({ x: q.x * w, y: q.y * h }));
      if (polygonContains(outline, local)) return true;
      return tolerance > 0 && outline.some((a, i) => distanceToSegment(local, a, outline[(i + 1) % outline.length]!) <= tolerance);
    }
    if (type === 'LINE') {
      const weight = this.doc.get(id, 'strokeWeight');
      return distanceToSegment(local, { x: 0, y: 0 }, { x: w, y: 0 }) <= weight / 2 + tolerance + 2;
    }
    if (type === 'VECTOR' || type === 'BOOLEAN_OPERATION') {
      const paths = nodePaths(this.doc, id);
      const lines = flattenPaths(paths, 0.5);
      const filled = this.doc.get(id, 'fills').some((f) => f.visible);
      const rule = type === 'VECTOR' && this.doc.get(id, 'windingRule') === 'EVENODD' ? 'EVENODD' : 'NONZERO';
      if (filled && insideRegion({ contours: lines.filter((l) => l.closed).map((l) => l.points), rule }, local)) return true;
      const reach = this.doc.get(id, 'strokeWeight') / 2 + tolerance + 2;
      return lines.some((l) => l.points.some((a, i) => {
        const b = l.points[i + 1] ?? (l.closed ? l.points[0] : undefined);
        return b !== undefined && distanceToSegment(local, a, b) <= reach;
      }));
    }
    if (type === 'POLYGON' || type === 'STAR') {
      // The outline as drawn: rounded corners included.
      const points = flattenPaths(nodePaths(this.doc, id), 0.5)[0]?.points ?? [];
      if (polygonContains(points, local)) return true;
      // Thin tips are hard to hit: accept points close to the outline too.
      return points.some((a, i) => distanceToSegment(local, a, points[(i + 1) % points.length]!) <= tolerance + 2);
    }
    if (type === 'ELLIPSE' && this.doc.get(id, 'arc')) {
      // An arc, pie or ring: inside its outline (the hole of a ring is outside).
      const lines = flattenPaths(nodePaths(this.doc, id), 0.5);
      return insideRegion({ contours: lines.map((l) => l.points), rule: 'NONZERO' }, local);
    }
    if (type === 'ELLIPSE') {
      return ellipseContains({ x: -tolerance, y: -tolerance, width: w + tolerance * 2, height: h + tolerance * 2 }, local);
    }
    return local.x >= -tolerance && local.y >= -tolerance && local.x <= w + tolerance && local.y <= h + tolerance;
  }
}
