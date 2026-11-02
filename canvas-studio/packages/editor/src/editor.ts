// Editor state and actions. UI components (canvas, panels, palette) read state
// from here and call its actions; they never write to the document directly.

import { boardObjectOf, defaultBoardPrefs, type BoardPrefs, type BoardTool } from './board.ts';
import { isRepeatCopy, repeatGroupOf } from '#components';
import { scaleNode } from '#layout';
import { brushFromPaths } from '#geometry';
import { applyBuilder, builderCells, type BuilderCell } from './shape-builder.ts';
import { outlineFonts, textOutlinePaths } from './text-outline.ts';
import { isDark } from './theme.ts';
import { solid, tr } from '#core';
import { suggestNames } from './auto-name.ts';
import type { ScreenTemplate } from './templates.ts';
import type { ImageInput } from './images.ts';
import { canContain, Document, isFrameLike, type ChangeSet, type ChangeSource, type ComponentPropType, type Gesture, type NodeId, type NodeProps, type NodeType, type BooleanOp, type Color, type Position, type TextRunStyle, type Transaction, type VectorPath, type VectorNetwork, type StyleType, type LayoutGrid, type Paint, type Effect, type CustomBrush, SHAPE_TYPES, TEXT_STYLE_KEYS, colorToHex } from '#core';
import { apply, booleanAll, containsRect, intersects, booleanRegions, deleteVertices, flattenPaths, invert, mapNetwork, mapPaths, networkBounds, networkFromPaths, simplifyNetwork, multiply, nodeTransform, pathsBounds, shapePaths, transformPaths, unionAll, type Measurement, type Point, type Rect, type Region, type SpacingMatch } from '#geometry';
import { applyRunStyle, editListLevels, editRuns, LayoutEngine, listLevelOf, MAX_LIST_LEVEL, layoutRootFor, MIXED_RUN, nodePaths, regionOf, vectorDrawing, type GridGeometry, normalizeRuns, rangeValue, resizeWithConstraints, runStyleAt, scaleChildren, textValue, type ResolvedStyle, type RunKey, type TextMeasurer } from '#layout';
import {
  bindingSpec,
  canBind,
  styleUsers,
  styleValueKeys,
  type StyleBinding,
  addAxis,
  addPropertyFromLayer,
  addVariant,
  combineAsVariants,
  componentSetOf,
  convertFrameToComponent,
  createInstance,
  detachInstance,
  ensureLayerKeys,
  findVariant,
  insideInstance,
  isInstanceLayer,
  isTopLevelInstance,
  mainComponentOf,
  outerInstance,
  processTransaction,
  removeProperty,
  renameAxis,
  renameProperty,
  resetInstance,
  resetOverrides,
  setInstanceProperty,
  setVariantValue,
  unbindLayer,
  wouldCreateCycle,
} from '#components';
import { SceneGraph, Viewport } from '#render';
import { clipboardHtml, clipboardPlainText, copySubtree, parseClipboard, pasteSubtree, resolvePastedStyles, toClipboard, type ClipboardData } from './clipboard.ts';
import { Emitter } from './emitter.ts';
import { play } from './sounds.ts';
import { typographRuns } from './typograph.ts';
import { PrototypeController, type PanelMode } from './prototype/controller.ts';
import { VariablesController } from './variables.ts';
import { libraryOf } from './library.ts';
import { matchingInVariants, variantSetOf } from './multi-edit.ts';

/** Margin a new section leaves around the wrapped layers, and room for its title. */
export const SECTION_PADDING = 40;
export const SECTION_TITLE_SPACE = 24;

export type ToolId = 'select' | 'frame' | 'section' | 'rectangle' | 'ellipse' | 'polygon' | 'star' | 'line' | 'arrow' | 'pen' | 'pencil' | 'scale' | 'text' | 'hand' | 'eyedropper' | 'comment' | BoardTool;

export interface Guide {
  axis: 'x' | 'y';
  /** World coordinate of the guide line. */
  at: number;
  from: number;
  to: number;
}

/** Canvas display settings of this user (not part of the document). */
export interface ViewSettings {
  /** Rulers along the canvas edges (Shift+R, FR-CNV-044). */
  rulers: boolean;
  /** Layout grids of frames (Ctrl+G, FR-GRD-002). */
  layoutGrids: boolean;
  /** Pixel grid at high zoom (Shift+'). */
  pixelGrid: boolean;
  /** Positions and sizes snap to whole pixels (Shift+Mod+'). */
  snapToPixel: boolean;
  /** Snapping to objects, guides and grids. */
  snapping: boolean;
  /** Outline view (⇧⌘O, as in Figma): layers as thin lines; not kept between sessions. */
  outlines: boolean;
  /** Outline view shows hidden layers too. */
  outlineHidden: boolean;
  /** Outline view shows every layer's box. */
  outlineBounds: boolean;
  /** Pixel preview (as in Figma): the page as rasterised at 1x or 2x, magnified without smoothing; 0 — off. */
  pixelPreview: 0 | 1 | 2;
  /** Other people's cursors on the canvas (their selections stay). */
  cursors: boolean;
  /** Words over the panel's icon-only fields (Figma's «Property labels»). */
  propertyLabels: boolean;
  /** Smart symbols while typing: -- → —, -> → →, quotes → «» or “”. */
  smartSymbols: boolean;
  /** Interface motion (FEAT-150): soft snapping, a bounce on insert, a smooth zoom to objects. */
  motion: boolean;
  /** Quiet interface sounds (FEAT-150); off by default. */
  sounds: boolean;
}

/** A default layout grid of a kind, as Figma creates it. */
export function defaultGrid(pattern: 'GRID' | 'COLUMNS' | 'ROWS'): LayoutGrid {
  if (pattern === 'GRID') return { pattern: 'GRID', sectionSize: 10, color: { r: 1, g: 0, b: 0, a: 0.1 }, visible: true };
  return { pattern, count: 5, alignment: 'STRETCH', sectionSize: 60, offset: 0, gutterSize: 20, color: { r: 1, g: 0, b: 0, a: 0.1 }, visible: true };
}

export interface EditorEvents extends Record<string, unknown> {
  change: { changes: ChangeSet; source: ChangeSource };
  selection: readonly NodeId[];
  tool: ToolId;
  page: NodeId;
  viewport: void;
  overlay: void;
  document: Document;
  /** The undo or redo history changed (an edit entered it, undo, redo). */
  history: void;
  toast: { message: string; kind: 'info' | 'error' };
  /** A model job started or settled (Editor.works). */
  work: void;
  editText: NodeId | null;
  textSelection: { anchor: number; focus: number };
  /** Layers just put on the canvas (inserted, pasted): the canvas greets them with a little bounce. */
  appear: readonly NodeId[];
  vectorEdit: { id: NodeId; selected: string[]; tool: VectorTool } | null;
  gradient: { id: NodeId; key: 'fills' | 'strokes'; index: number; stop: number } | null;
  warpEdit: NodeId | null;
  /** A code layer was built (its layers made from its code, or the code failed). */
  codeBuilt: NodeId;
  shapeBuilder: { ids: NodeId[]; cells: BuilderCell[] } | null;
  view: ViewSettings;
  mode: PanelMode;
}

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** Tools inside point editing: edit points, pen, paint bucket (fill areas), scissors. */
export type VectorTool = 'edit' | 'pen' | 'bucket' | 'scissors' | 'eraser' | 'lasso' | 'width';

/** Least gap between objects spread on a board (BUG-068). */
const BOARD_GAP = 24;
/** «@Name» in a board text: the accent colour (#4F5BD5), as mentions in comments. */
const MENTION_COLOR: Color = { r: 0x4f / 255, g: 0x5b / 255, b: 0xd5 / 255, a: 1 };

export class Editor {
  doc: Document;
  scene: SceneGraph;
  readonly viewport = new Viewport();
  readonly events = new Emitter<EditorEvents>();
  readonly measurer: TextMeasurer;
  /** Variables, collections, modes and bindings (section 11). */
  readonly variables: VariablesController = new VariablesController(this);
  /** Prototype interactions, flows and the design/prototype panel mode (section 13). */
  readonly prototype: PrototypeController = new PrototypeController(this);

  pageId: NodeId;
  selection: NodeId[] = [];
  hover: NodeId | null = null;
  tool: ToolId = 'select';
  /** Rotation origin (Alt+R, as in Figma): shown or not, and where it was moved to (page coordinates; null — the centre). */
  rotationOrigin: { shown: boolean; at: Point | null } = { shown: false, at: null };

  toggleRotationOrigin(): void {
    this.rotationOrigin = { shown: !this.rotationOrigin.shown, at: this.rotationOrigin.at };
    this.requestOverlay();
  }

  /**
   * Multi-edit variants (Q, as in Figma): the component set being edited. A layer selected in one
   * variant takes the same layers of the other variants with it, and what is added to a variant
   * is added to all of them.
   */
  variantEdit: NodeId | null = null;

  toggleVariantEdit(): void {
    if (this.variantEdit) {
      this.variantEdit = null;
      this.events.emit('selection', this.selection);
      this.requestOverlay();
      return;
    }
    const sets = new Set(this.selection.map((id) => variantSetOf(this.doc, id)));
    const set = sets.size === 1 ? [...sets][0]! : null;
    if (!set) {
      this.toast(tr('Выделите набор вариантов, вариант или слой внутри варианта'));
      return;
    }
    this.variantEdit = set;
    const first = this.selection[0]!;
    this.selection = [];
    this.setSelection(first === set ? [set] : matchingInVariants(this.doc, first));
  }

  /** @internal Copies the layers just added to a variant into the same place of the other variants. */
  mirrorIntoVariants(tx: Transaction, created: readonly NodeId[]): void {
    const set = this.variantEdit;
    if (!set || !this.doc.store.isAlive(set)) return;
    const d = this.doc;
    const made = new Set(created);
    for (const id of created) {
      if (!d.store.isAlive(id)) continue;
      const parent = d.parent(id)!;
      if (made.has(parent) || variantSetOf(d, parent) !== set) continue;
      if (d.type(id) === 'TEXT' && d.get(id, 'characters') === '') continue;
      const index = d.children(parent).indexOf(id);
      for (const target of matchingInVariants(d, parent).slice(1)) {
        // Added to every variant at once (a duplicate of layers selected in all of them): nothing to copy.
        if (d.children(target).some((c) => made.has(c) && d.get(c, 'name') === d.get(id, 'name'))) continue;
        pasteSubtree(tx, copySubtree(d, id), target, { index: Math.min(index, d.children(target).length) }, d);
      }
    }
  }

  /** The scale tool (K): `tool` is 'select', and resizing scales strokes, text, effects and the rest. */
  scaleMode = false;
  /** What the board tools make next: colours, shape, line kind, stamp, the author's name (FEAT-083). */
  boardPrefs: BoardPrefs = defaultBoardPrefs();
  editingText: NodeId | null = null;
  /** Transient overlay state drawn by the canvas view. */
  marquee: Rect | null = null;
  guides: Guide[] = [];
  /** Equal gaps found while snapping (pink markers, FR-CNV-041). */
  spacing: SpacingMatch[] = [];
  /** Distance labels: to neighbours while dragging, or Alt measurements (FR-CNV-041, 042). */
  distances: Measurement[] = [];
  /** Dashed helper lines of Alt measurements. */
  distanceHelpers: { from: Point; to: Point }[] = [];
  /** Where a dragged layer would land: a frame, a place among its layers, or a cell of its grid. */
  dropTarget: { parent: NodeId; index: number | null; cell?: { column: number; row: number } } | null = null;
  /** Columns and rows of grid frames as last laid out; cleared on every change. */
  private gridCache = new Map<NodeId, GridGeometry | null>();
  /** Frames that have ruler guides / layout grids: the overlay asks every frame, the page may have thousands of layers. */
  private withGuides: NodeId[] | null = null;
  private withLayoutGrids: NodeId[] | null = null;
  /** Gradient whose handles are shown on the canvas (BUG-015); cleared when the selection changes. */
  gradientEdit: { id: NodeId; key: 'fills' | 'strokes'; index: number; stop: number } | null = null;
  /** Layer whose perspective corners are dragged on the canvas (mockups); cleared when the selection changes. */
  warpEdit: NodeId | null = null;
  /** Shape builder: the layers it works on (paint order) and the areas they cut one another into. */
  shapeBuilder: { ids: NodeId[]; cells: BuilderCell[] } | null = null;

  /** Display settings: rulers, grids, pixel grid, snapping (the app persists them). */
  view: ViewSettings = { rulers: false, layoutGrids: true, pixelGrid: true, snapToPixel: true, snapping: true, outlines: false, outlineHidden: false, outlineBounds: false, pixelPreview: 0, cursors: true, propertyLabels: false, smartSymbols: true, motion: true, sounds: false };

  /** The last pixel preview density switched on: Ctrl+P brings it back. */
  private lastPixelPreview: 1 | 2 = 1;

  setPixelPreview(scale: 0 | 1 | 2 | 'toggle'): void {
    const next = scale === 'toggle' ? (this.view.pixelPreview ? 0 : this.lastPixelPreview) : scale;
    if (next) this.lastPixelPreview = next;
    this.setView({ pixelPreview: next });
    this.toast(next ? tr('Пиксельный предпросмотр: {0}x', next) : tr('Пиксельный предпросмотр выключен'));
  }

  setView(patch: Partial<ViewSettings>): void {
    this.view = { ...this.view, ...patch };
    this.scene.setOutlines(this.view.outlines ? { hidden: this.view.outlineHidden } : null);
    this.events.emit('view', this.view);
    this.requestOverlay();
  }

  // ---------- guides (FR-CNV-044) ----------

  /** Who owns a guide dropped at a world point: the selected (or hovered) top-level frame under it, else the page. */
  guideOwnerAt(p: Point): NodeId {
    const d = this.doc;
    const frames = [...this.selection, ...d.children(this.pageId)].filter((id, i, all) => all.indexOf(id) === i && d.store.isAlive(id) && isFrameLike(d.type(id)) && d.get(id, 'rotation') === 0);
    const hit = frames.find((id) => {
      const b = this.scene.bounds(id);
      return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
    });
    return hit && this.selection.includes(hit) ? hit : this.pageId;
  }

  /** World position of an owner's origin (page: 0,0). Guides of rotated frames are not shown. */
  guideOrigin(owner: NodeId): Point | null {
    if (owner === this.pageId || this.doc.type(owner) === 'PAGE') return { x: 0, y: 0 };
    const m = this.scene.world(owner);
    if (Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9) return null;
    return { x: m.e, y: m.f };
  }

  /** Visible frames of this page with something in `key` (found once, until such a change). */
  private framesWith(key: 'guides' | 'layoutGrids'): NodeId[] {
    const d = this.doc;
    const out: NodeId[] = [];
    const visit = (parent: NodeId) => {
      for (const id of d.children(parent)) {
        if (!d.get(id, 'visible')) continue;
        if (isFrameLike(d.type(id)) && d.get(id, key).length > 0) out.push(id);
        visit(id);
      }
    };
    visit(this.pageId);
    return out;
  }

  /** Frames of this page with layout grids (for the overlay). */
  layoutGridFrames(): NodeId[] {
    this.withLayoutGrids ??= this.framesWith('layoutGrids');
    return this.withLayoutGrids;
  }

  /** Guides visible on this page in world coordinates, with their owner and index. */
  worldGuides(): { owner: NodeId; index: number; axis: 'X' | 'Y'; at: number; span: Rect | null }[] {
    const d = this.doc;
    const out: { owner: NodeId; index: number; axis: 'X' | 'Y'; at: number; span: Rect | null }[] = [];
    d.get(this.pageId, 'guides').forEach((g, index) => out.push({ owner: this.pageId, index, axis: g.axis, at: g.offset, span: null }));
    this.withGuides ??= this.framesWith('guides');
    for (const id of this.withGuides) {
      if (!d.store.isAlive(id)) continue;
      const origin = this.guideOrigin(id);
      if (!origin) continue;
      const span = this.scene.bounds(id);
      d.get(id, 'guides').forEach((g, index) => out.push({ owner: id, index, axis: g.axis, at: (g.axis === 'X' ? origin.x : origin.y) + g.offset, span }));
    }
    return out;
  }

  addGuide(owner: NodeId, axis: 'X' | 'Y', worldAt: number): number {
    const origin = this.guideOrigin(owner) ?? { x: 0, y: 0 };
    const offset = round2(worldAt - (axis === 'X' ? origin.x : origin.y));
    const guides = this.doc.get(owner, 'guides');
    this.commit(tr('Добавить направляющую'), (tx) => tx.set(owner, 'guides', [...guides, { axis, offset }]));
    return guides.length;
  }

  /** Moves a guide to a world coordinate (inside a gesture or as one step). */
  setGuide(tx: Transaction, owner: NodeId, index: number, worldAt: number): void {
    const origin = this.guideOrigin(owner) ?? { x: 0, y: 0 };
    const list = [...this.doc.get(owner, 'guides')];
    const g = list[index];
    if (!g) return;
    list[index] = { ...g, offset: round2(worldAt - (g.axis === 'X' ? origin.x : origin.y)) };
    tx.set(owner, 'guides', list);
  }

  /** Sets a guide's exact position in its owner's coordinates (double click on a guide). */
  setGuideOffset(owner: NodeId, index: number, offset: number): void {
    const list = [...this.doc.get(owner, 'guides')];
    const g = list[index];
    if (!g || !Number.isFinite(offset)) return;
    list[index] = { ...g, offset: round2(offset) };
    this.commit(tr('Позиция направляющей'), (tx) => tx.set(owner, 'guides', list));
  }

  removeGuide(owner: NodeId, index: number): void {
    const list = this.doc.get(owner, 'guides').filter((_, i) => i !== index);
    this.commit(tr('Удалить направляющую'), (tx) => tx.set(owner, 'guides', list));
  }

  clearGuides(owner: NodeId = this.pageId): void {
    if (this.doc.get(owner, 'guides').length === 0) return;
    this.commit(tr('Удалить направляющие'), (tx) => tx.set(owner, 'guides', []));
  }

  /**
   * Eyedropper result (FR-DRW-053): the colour becomes the first solid fill of
   * the selection (or of the selected characters while editing text); with
   * nothing selected it is copied as HEX. The tool then returns to "Move".
   */
  /** Set by a colour picker's eyedropper: the next picked colour goes there instead of the selection. */
  pickColorFor: ((color: Color) => void) | null = null;

  applyPickedColor(color: Color): void {
    const target = this.pickColorFor;
    if (target) {
      this.pickColorFor = null;
      this.setTool('select');
      target(color);
      return;
    }
    const hex = colorToHex(color);
    if (this.editingText) {
      this.applyTextStyle({ fills: [{ type: 'SOLID', color, opacity: 1, visible: true }] }, tr('Пипетка'));
    } else {
      const ids = this.topLevelSelection().filter((id) => this.doc.type(id) !== 'GROUP');
      if (ids.length === 0) {
        void globalThis.navigator?.clipboard?.writeText(hex).catch(() => {});
        this.toast(tr('Цвет {0} скопирован', hex));
      } else {
        this.commit(tr('Пипетка'), (tx) => {
          for (const id of ids) {
            const fills = [...this.doc.get(id, 'fills')];
            const i = fills.findIndex((f) => f.type === 'SOLID');
            if (i >= 0) fills[i] = { ...fills[i]!, color } as Paint;
            else fills.push({ type: 'SOLID', color, opacity: 1, visible: true });
            tx.set(id, 'fills', fills);
          }
        });
      }
    }
    this.setTool('select');
  }

  // ---------- layout grids (FR-GRD) ----------

  addLayoutGrid(pattern: 'GRID' | 'COLUMNS' | 'ROWS' = 'COLUMNS'): void {
    const ids = this.selection.filter((id) => isFrameLike(this.doc.type(id)));
    if (ids.length === 0) return;
    this.commit(tr('Сетка колонок'), (tx) => {
      for (const id of ids) tx.set(id, 'layoutGrids', [...this.doc.get(id, 'layoutGrids'), defaultGrid(pattern)]);
    });
    if (!this.view.layoutGrids) this.setView({ layoutGrids: true });
  }

  setWarpEdit(id: NodeId | null): void {
    if (this.warpEdit === id) return;
    this.warpEdit = id;
    this.events.emit('warpEdit', id);
    this.requestOverlay();
  }

  setShapeBuilder(value: Editor['shapeBuilder']): void {
    this.shapeBuilder = value;
    this.events.emit('shapeBuilder', value);
    this.requestOverlay();
  }

  /**
   * Shape builder (Shift+M, as in Figma): the selected shapes, lying in one parent,
   * show the areas they cut one another into; see `applyShapeBuilder`.
   */
  startShapeBuilder(): void {
    if (this.shapeBuilder) {
      this.setShapeBuilder(null);
      return;
    }
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Конструктор фигур'))).filter((id) => SHAPE_TYPES.includes(this.doc.type(id)) && this.doc.type(id) !== 'LINE');
    if (ids.length === 0) {
      this.toast(tr('Выделите фигуры, которые пересекаются: конструктор разрежет их на области'));
      return;
    }
    const parent = this.doc.parent(ids[0]!);
    if (ids.some((id) => this.doc.parent(id) !== parent)) {
      this.toast(tr('Фигуры должны лежать в одном родителе'));
      return;
    }
    const cells = builderCells(this.doc, ids);
    if (cells.length === 0) {
      this.toast(tr('У выделенных фигур нет закрашенных областей'));
      return;
    }
    this.setSelection(ids);
    this.setShapeBuilder({ ids, cells });
  }

  /**
   * Applies the builder to the chosen areas: one area — taken out into its own layer,
   * several — merged into one; `remove` (Alt) — the areas are cut away. The layers
   * stay in the builder for the next step.
   */
  applyShapeBuilder(chosen: readonly number[], remove: boolean): void {
    const builder = this.shapeBuilder;
    if (!builder || chosen.length === 0) return;
    const d = this.doc;
    const parent = d.parent(builder.ids[0]!)!;
    let next: { ids: NodeId[]; cells: BuilderCell[] } = { ids: [], cells: [] };
    this.commit(remove ? tr('Удалить область') : chosen.length > 1 ? tr('Слить области') : tr('Отделить область'), (tx) => {
      next = applyBuilder(d, tx, builder.ids, builder.cells, chosen, remove, (tx, like, paths, after) => {
        const id = tx.create('VECTOR', parent, {
          name: d.get(like, 'name'),
          fills: structuredClone(d.get(like, 'fills')),
          strokes: structuredClone(d.get(like, 'strokes')),
          strokeWeight: d.get(like, 'strokeWeight'),
          strokeAlign: d.get(like, 'strokeAlign'),
          effects: structuredClone(d.get(like, 'effects')),
          opacity: d.get(like, 'opacity'),
          blendMode: d.get(like, 'blendMode'),
          vectorPaths: paths,
        }, { after });
        normalizeVector(d, tx, id);
        return id;
      });
    }, () => next.ids);
    const ids = next.ids.filter((id) => d.store.isAlive(id));
    this.setShapeBuilder(null);
    this.setSelection(ids);
    if (ids.length > 0 && next.cells.length > 0) this.setShapeBuilder({ ids, cells: next.cells });
  }

  setGradientEdit(value: Editor['gradientEdit']): void {
    this.gradientEdit = value;
    this.events.emit('gradient', value);
    this.requestOverlay();
  }
  /** Viewport state per page, so switching pages returns to where you were (FR-CNV-061). */
  private readonly pageViews = new Map<NodeId, ReturnType<Viewport['toJSON']>>();
  private clipboard: ClipboardData | null = null;
  private unsubscribeDoc: (() => void) | null = null;

  constructor(doc: Document, measurer: TextMeasurer) {
    this.doc = doc;
    this.measurer = measurer;
    this.pageId = doc.pages()[0]!;
    this.scene = new SceneGraph(doc, this.pageId);
    this.attach();
  }

  // ---------- document lifecycle ----------

  /** Replaces the open document (open file, new file). */
  setDocument(doc: Document): void {
    this.unsubscribeDoc?.();
    this.doc = doc;
    this.pageId = doc.pages()[0]!;
    this.scene = new SceneGraph(doc, this.pageId);
    this.selection = [];
    this.hover = null;
    this.editingText = null;
    this.pageViews.clear();
    this.attach();
    this.events.emit('document', doc);
    this.events.emit('page', this.pageId);
    this.events.emit('selection', this.selection);
  }

  private attach(): void {
    const offChanges = this.doc.subscribe((changes, source) => {
      this.scene.invalidate(changes);
      if (changes.structural || changes.updated.size > 0) {
        const alive = this.selection.filter((id) => this.doc.store.isAlive(id) && this.doc.pageOf(id) === this.pageId);
        if (alive.length !== this.selection.length) this.setSelection(alive);
      }
      if (!this.doc.store.isAlive(this.pageId)) this.setPage(this.doc.pages()[0]!);
      this.gridCache.clear();
      if (changes.structural || [...changes.updated.values()].some((k) => k.has('guides') || k.has('visible'))) this.withGuides = null;
      if (changes.structural || [...changes.updated.values()].some((k) => k.has('layoutGrids') || k.has('visible'))) this.withLayoutGrids = null;
      this.events.emit('change', { changes, source });
    });
    const offHistory = this.doc.onHistory(() => this.events.emit('history', undefined));
    this.unsubscribeDoc = () => {
      offChanges();
      offHistory();
    };
  }

  // ---------- editing primitives ----------

  /** Runs an edit as one undoable step; layout and group bounds are updated in the same step. */
  commit<T>(label: string, fn: (tx: Transaction) => T, selectionAfter?: () => NodeId[]): T {
    const before = [...this.selection];
    let after: NodeId[] | undefined;
    const result = this.doc.transact(
      (tx) => {
        const value = fn(tx);
        if (this.variantEdit) this.mirrorIntoVariants(tx, [...tx.changes.created]);
        this.postProcess(tx);
        after = selectionAfter?.();
        return value;
      },
      { label, metaBefore: before },
    );
    if (after) this.setSelection(after);
    return result;
  }

  /** Starts a live edit (drag, resize, typing) that becomes one undo step. */
  beginGesture(label: string): EditorGesture {
    return new EditorGesture(this, this.doc.beginGesture(label, [...this.selection]));
  }

  /** @internal Overrides, instance sync, group bounds and auto layout for everything the transaction touched. */
  /** A kind of file's own pass after an edit (a presentation keeps its slides in their grid); `final` — not in the middle of a drag. */
  editPass: ((tx: Transaction, final: boolean) => void) | null = null;

  postProcess(tx: Transaction, final = true): void {
    processTransaction(tx, this.measurer);
    this.editPass?.(tx, final);
  }

  undo(): void {
    // Typing and styling while editing text are one step that is recorded when editing ends:
    // finish editing first, so "Undo" takes back what was just done to the text.
    if (this.editingText) this.stopTextEditing();
    const result = this.doc.undo();
    if (!result) return;
    play('undo');
    const sel = (result.entry.metaBefore as NodeId[] | undefined) ?? [];
    this.setSelection(sel.filter((id) => this.doc.store.isAlive(id)));
    if (result.skipped > 0) this.toast(tr('Часть изменений не отменена: объекты изменены другим участником ({0})', result.skipped));
  }

  redo(): void {
    const result = this.doc.redo();
    if (!result) return;
    if (result.skipped > 0) this.toast(tr('Часть изменений не повторена ({0})', result.skipped));
  }

  /** Goes back (negative) or forward (positive) several steps of the undo history at once. */
  stepHistory(count: number): void {
    for (let i = 0; i < Math.abs(count); i++) {
      if (count < 0 ? !this.doc.canUndo() : !this.doc.canRedo()) break;
      if (count < 0) this.undo();
      else this.redo();
    }
  }

  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    this.events.emit('toast', { message, kind });
  }

  /** Model jobs in progress (✦): the canvas glows over their layers until each settles (ui/work-glow.ts). */
  readonly works = new Set<{ label: string; ids: readonly NodeId[]; started: number }>();

  /** Shows `job` as work over `ids` while it runs; returns it. */
  track<T>(label: string, ids: readonly NodeId[], job: Promise<T>): Promise<T> {
    const work = { label, ids: [...ids], started: Date.now() };
    this.works.add(work);
    this.events.emit('work', undefined);
    const done = () => {
      this.works.delete(work);
      this.events.emit('work', undefined);
    };
    job.then(done, done);
    return job;
  }

  // ---------- selection ----------

  setSelection(ids: readonly NodeId[]): void {
    // A slide on show is the paper, never a selected layer (FEAT-165): whatever asks — a thumbnail,
    // the layers panel, a marquee, ⌘A — it stays out, so there is nothing to drag.
    let unique = [...new Set(ids)].filter((id) => this.doc.store.isAlive(id) && !this.isPinned(id));
    if (this.variantEdit) {
      // Leaving the set ends multi-edit; one layer in a variant brings the same layers of the others.
      if (!this.doc.store.isAlive(this.variantEdit) || unique.some((id) => variantSetOf(this.doc, id) !== this.variantEdit)) this.variantEdit = null;
      else if (unique.length === 1 && unique[0] !== this.variantEdit) unique = matchingInVariants(this.doc, unique[0]!);
    }
    if (unique.length === this.selection.length && unique.every((id, i) => id === this.selection[i])) return;
    this.selection = unique;
    this.scene.openBooleans.clear();
    for (const id of unique) {
      for (const a of [id, ...this.doc.store.ancestors(id)]) if (this.doc.type(a) === 'BOOLEAN_OPERATION') this.scene.openBooleans.add(a);
    }
    if (this.gradientEdit && !unique.includes(this.gradientEdit.id)) this.setGradientEdit(null);
    if (this.warpEdit && !unique.includes(this.warpEdit)) this.setWarpEdit(null);
    if (this.vectorEdit && !unique.includes(this.vectorEdit.id)) this.exitVectorEdit();
    this.rotationOrigin = { shown: false, at: null };
    this.pickedProperty = null;
    if (this.shapeBuilder && (unique.length !== this.shapeBuilder.ids.length || unique.some((id) => !this.shapeBuilder!.ids.includes(id)))) this.setShapeBuilder(null);
    this.events.emit('selection', this.selection);
    this.requestOverlay();
  }

  toggleSelection(id: NodeId): void {
    if (this.selection.includes(id)) this.setSelection(this.selection.filter((s) => s !== id));
    else this.setSelection([...this.selection, id]);
  }

  /** Selected nodes without those whose ancestor is also selected. */
  topLevelSelection(): NodeId[] {
    const set = new Set(this.selection);
    return this.selection.filter((id) => !this.doc.store.ancestors(id).some((a) => set.has(a)));
  }

  /** World bounds of the selection. */
  selectionBounds(): Rect | null {
    return unionAll(this.topLevelSelection().map((id) => this.scene.bounds(id)));
  }

  setHover(id: NodeId | null): void {
    if (this.hover === id) return;
    this.hover = id;
    this.requestOverlay();
  }

  /** The code layer a layer is part of (itself or the nearest ancestor with code); null — none. */
  codeLayerOf(id: NodeId): NodeId | null {
    for (const a of [id, ...this.doc.store.ancestors(id)]) if (this.doc.store.isAlive(a) && this.doc.get(a, 'code') !== null) return a;
    return null;
  }

  /**
   * Maps a hit (the deepest node under the cursor) to what a click selects
   * (FR-CNV-030): the child of the deepest "open" container on the path. The page,
   * top-level frames and the ancestors of the current selection are open.
   */
  selectableFor(hit: NodeId, deep: boolean): NodeId {
    // A copy made by a repeat group is the group's: a click takes the group (its own layers are edited).
    if (isRepeatCopy(this.doc, hit)) return repeatGroupOf(this.doc, hit) ?? hit;
    // Inside a code layer everything is made from its code: a click takes the layer.
    const code = this.codeLayerOf(hit);
    if (code && code !== hit) return code;
    if (deep) return hit;
    // A sticky, a shape or a label is one object: a click takes it whole (its text is edited by double click).
    const object = boardObjectOf(this.doc, hit);
    if (object) return object;
    const chain = [...this.doc.store.ancestors(hit).reverse(), hit].filter((id) => this.doc.type(id) !== 'DOCUMENT');
    const pageIndex = chain.indexOf(this.pageId);
    const path = chain.slice(pageIndex + 1);
    const open = new Set<NodeId>();
    // As in Figma: a click on a layer inside a frame or group selects the parent (BUG-022);
    // double click / Enter goes one level down, Mod+click selects the layer directly.
    // Containers become "open" once they or something inside them is selected.
    for (const id of this.selection) for (const a of this.doc.store.ancestors(id)) open.add(a);
    // A boolean operation opens too: double click picks the shape under the pointer (as in Figma).
    for (const id of this.selection) if (this.isContainer(id) || this.doc.type(id) === 'BOOLEAN_OPERATION') open.add(id);
    // Sections organise the page: what is inside them behaves as if it were on the page.
    // A top-level frame is an artboard, as in Figma: a click takes what is inside it (BUG-104).
    for (const id of path) if (this.doc.type(id) === 'SECTION' || this.isArtboard(id)) open.add(id);
    let choice = path[0] ?? hit;
    for (let i = 0; i < path.length - 1; i++) {
      if (open.has(path[i]!)) choice = path[i + 1]!;
    }
    return choice;
  }

  /**
   * A frame lying on the page or in a section of a design: an artboard (Figma's
   * top-level frame). A click selects what is in it; its empty part starts a
   * marquee; the frame itself is taken by its name or with Mod.
   */
  isArtboard(id: NodeId): boolean {
    const type = this.doc.type(id);
    if (type !== 'FRAME' && type !== 'COMPONENT') return false;
    if (this.isBoardFile() || this.doc.get(id, 'board')) return false;
    const parent = this.doc.parent(id);
    return parent !== null && (parent === this.pageId || this.doc.type(parent) === 'SECTION');
  }

  isContainer(id: NodeId): boolean {
    const type = this.doc.type(id);
    return isFrameLike(type) || type === 'GROUP' || type === 'PAGE' || type === 'SECTION';
  }

  /**
   * Hits a click can land on. A click on the empty part of a section takes the
   * section, in a design as in Figma and on a board as in FigJam (BUG-103);
   * what is inside comes first.
   */
  pickable(hits: readonly NodeId[]): NodeId[] {
    return hits.filter((id) => !this.isPinned(id));
  }

  /**
   * A presentation in the «Слайд» view (FEAT-165), as Figma Slides: the slide on show and
   * a step to the next or previous one. While set, the slides are the paper, not layers —
   * a click on one does not take it, it is not moved, resized or turned — and the view
   * keeps to the slide on show. Null — the canvas is free (designs, boards, the «Все слайды» view).
   */
  slideStage: { current: () => NodeId | null; flip: (step: 1 | -1) => void } | null = null;

  /** A slide of a presentation: its size comes from the format, so it is never resized or turned by hand (FEAT-165). */
  isSlide(id: NodeId): boolean {
    return this.doc.get(this.doc.rootId, 'fileKind') === 'SLIDES' && this.doc.store.isAlive(id) && this.doc.parent(id) === this.pageId && this.doc.type(id) === 'FRAME';
  }

  /** A table's cell (FEAT-168): the table sizes and places it — dragged or resized by hand it would break the grid. */
  isTableCell(id: NodeId): boolean {
    const parent = this.doc.store.isAlive(id) ? this.doc.parent(id) : null;
    return !!parent && this.doc.type(parent) === 'FRAME' && !!this.doc.get(parent, 'table');
  }

  /** A slide held in place by the «Слайд» view (see `slideStage`). */
  isPinned(id: NodeId): boolean {
    return this.slideStage !== null && this.isSlide(id);
  }

  /** The innermost section under a world point (the page when there is none). */
  sectionAt(p: Point, exclude: readonly NodeId[] = []): NodeId {
    for (const id of this.scene.hitTest(p)) {
      if (this.doc.type(id) !== 'SECTION') continue;
      if (exclude.some((e) => this.doc.store.isAncestorOrSelf(e, id))) continue;
      return id;
    }
    return this.pageId;
  }

  /** Whether new layers can be placed inside `id` (instances follow their component and accept none). */
  acceptsChildren(id: NodeId): boolean {
    const type = this.doc.type(id);
    if (type === 'PAGE' || type === 'SECTION') return true;
    if (!isFrameLike(type) || type === 'INSTANCE' || type === 'COMPONENT_SET') return false;
    // A board's sticky, shape, stamp or label is a frame inside, but not a container: a sticky dropped
    // on another one stays beside it (BUG-075: it went inside and under the next column).
    if (this.doc.get(id, 'board')) return false;
    return !insideInstance(this.doc, id);
  }

  /** A layer of an instance: its structure and geometry follow the component. */
  isInstanceLayer(id: NodeId): boolean {
    return isInstanceLayer(this.doc, id);
  }

  /** Whether the layer may be moved, resized, rotated or deleted directly. */
  canTransform(id: NodeId): boolean {
    return !this.isInstanceLayer(id) && !this.doc.get(id, 'locked') && !this.isPinned(id) && !this.isTableCell(id);
  }

  /** Splits ids into editable ones and explains once why the rest were skipped. */
  private transformable(ids: readonly NodeId[], action: string): NodeId[] {
    const ok = ids.filter((id) => !this.isInstanceLayer(id));
    if (ok.length < ids.length) this.toast(tr('{0}: слои копии повторяют компонент. Измените сам компонент или отвяжите копию от него (⌥⌘B).', action));
    return ok;
  }

  // ---------- coordinates ----------

  /** Columns, rows and cells of a grid frame, in its own space (null — not a grid). */
  gridGeometry(frame: NodeId): GridGeometry | null {
    if (!this.doc.store.isAlive(frame) || !isFrameLike(this.doc.type(frame)) || this.doc.get(frame, 'layoutMode') !== 'GRID') return null;
    if (this.gridCache.has(frame)) return this.gridCache.get(frame)!;
    const engine = new LayoutEngine(this.doc, this.measurer);
    engine.layoutRoot(layoutRootFor(this.doc, frame) ?? frame);
    const geometry = engine.grids.get(frame) ?? null;
    this.gridCache.set(frame, geometry);
    return geometry;
  }

  /** The grid cell under a world point (beyond the last row — a new one). */
  gridCellAt(frame: NodeId, world: Point): { column: number; row: number } | null {
    const g = this.gridGeometry(frame);
    if (!g || g.columns.length === 0) return null;
    const p = this.toParentSpace(frame, world);
    const nearest = (tracks: { start: number; size: number }[], v: number) => {
      let best = 0;
      let dist = Infinity;
      tracks.forEach((t, i) => {
        const d = v < t.start ? t.start - v : v > t.start + t.size ? v - t.start - t.size : 0;
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      return best;
    };
    const column = nearest(g.columns, p.x);
    const last = g.rows[g.rows.length - 1];
    const row = last && p.y > last.start + last.size + this.doc.get(frame, 'gridRowGap') / 2 ? g.rows.length : g.rows.length ? nearest(g.rows, p.y) : 0;
    return { column, row };
  }

  /** Converts a world point into the local space of `parent` (page = world). */
  toParentSpace(parent: NodeId, p: Point): Point {
    if (this.doc.type(parent) === 'PAGE') return p;
    const inv = invert(this.scene.world(parent));
    return inv ? apply(inv, p) : p;
  }

  /** World position of a node's origin. */
  worldOrigin(id: NodeId): Point {
    return apply(this.scene.world(id), { x: 0, y: 0 });
  }

  /** Moves `id` under `parent` keeping its position on screen. */
  reparentKeepingPosition(tx: Transaction, id: NodeId, parent: NodeId, position: Position = { at: 'end' }): boolean {
    const world = this.scene.world(id);
    const parentWorld = this.doc.type(parent) === 'PAGE' ? null : this.scene.world(parent);
    if (!tx.move(id, parent, position)) return false;
    const inv = parentWorld ? invert(parentWorld) : null;
    const local = inv ? multiply(inv, world) : world;
    const rotation = (Math.atan2(local.b, local.a) * 180) / Math.PI;
    tx.update(id, { x: round2(local.e), y: round2(local.f), rotation: round2(normalizeAngle(rotation)) });
    return true;
  }

  /** Top-most frame (or page) under a world point that can receive dropped nodes, excluding `exclude` subtrees. */
  containerAt(p: Point, exclude: readonly NodeId[] = []): NodeId {
    const hits = this.scene.hitTest(p);
    for (const id of hits) {
      if (!this.acceptsChildren(id)) continue;
      if (exclude.some((e) => this.doc.store.isAncestorOrSelf(e, id))) continue;
      // A section dragged over a frame stays where sections may live.
      if (exclude.some((e) => !canContain(this.doc.type(id), this.doc.type(e)))) continue;
      return id;
    }
    return this.pageId;
  }

  // ---------- pages ----------

  setPage(pageId: NodeId): void {
    if (pageId === this.pageId) return;
    this.pageViews.set(this.pageId, this.viewport.toJSON());
    this.pageId = pageId;
    this.scene.setPage(pageId);
    this.withGuides = null;
    this.withLayoutGrids = null;
    this.selection = [];
    this.scene.openBooleans.clear();
    const view = this.pageViews.get(pageId);
    if (view) this.viewport.restore(view);
    this.events.emit('page', pageId);
    this.events.emit('selection', this.selection);
    this.requestViewport();
  }

  addPage(): void {
    const n = this.doc.pages().length + 1;
    const page = this.commit(tr('Новая страница'), (tx) => tx.create('PAGE', this.doc.rootId, { name: tr('Страница {0}', n), backgroundColor: themePageBackground() }));
    this.setPage(page);
  }

  renamePage(page: NodeId, name: string): void {
    const value = name.trim();
    if (!value || value === this.doc.get(page, 'name') || this.doc.readOnly) return;
    this.commit(tr('Переименовать страницу'), (tx) => tx.set(page, 'name', value));
  }

  /** A copy of the page with everything on it, right after it; opens the copy (as in Figma). */
  duplicatePage(page: NodeId): void {
    if (this.doc.readOnly) return;
    const copy = this.commit(tr('Дублировать страницу'), (tx) => {
      const id = pasteSubtree(tx, copySubtree(this.doc, page), this.doc.rootId, { after: page }, this.doc);
      tx.set(id, 'name', tr('{0} (копия)', this.doc.get(page, 'name')));
      return id;
    });
    this.setPage(copy);
  }

  /** Deletes a page with everything on it (Undo brings it back); the last page stays. */
  deletePage(page: NodeId): void {
    if (this.doc.readOnly) return;
    const pages = this.doc.pages();
    if (pages.length <= 1) {
      this.toast(tr('Единственную страницу удалить нельзя'));
      return;
    }
    const i = pages.indexOf(page);
    if (page === this.pageId) this.setPage(pages[i + 1] ?? pages[i - 1]!);
    this.commit(tr('Удалить страницу'), (tx) => tx.delete(page));
  }

  /** Moves a page to `index` among the pages (dragged in the list). */
  movePage(page: NodeId, index: number): void {
    if (this.doc.readOnly) return;
    const others = this.doc.pages().filter((p) => p !== page);
    const anchor = others[index];
    if (this.doc.pages().indexOf(page) === index) return;
    this.commit(tr('Порядок страниц'), (tx) => tx.move(page, this.doc.rootId, anchor ? { before: anchor } : { after: others[others.length - 1]! }));
  }

  // ---------- tools ----------

  setTool(tool: ToolId): void {
    // The scale tool (K) is the move tool whose handles scale everything inside (as in Figma).
    const scale = tool === 'scale';
    if (scale) {
      tool = 'select';
      if (this.vectorEdit) this.exitVectorEdit();
    }
    // Inside point editing V and P switch its own tools (as in Figma); other tools leave it.
    if (this.vectorEdit && (tool === 'select' || tool === 'pen')) {
      this.setVectorTool(tool === 'pen' ? 'pen' : 'edit');
      return;
    }
    if (this.vectorEdit && tool !== this.tool) this.exitVectorEdit();
    // Leaving the eyedropper (Esc, another tool) cancels a pick for a colour picker.
    if (tool !== 'eyedropper') this.pickColorFor = null;
    if (this.tool === tool && this.scaleMode === scale) return;
    this.scaleMode = scale;
    this.tool = tool;
    this.events.emit('tool', tool);
  }

  // ---------- creation ----------

  createNode(type: NodeType, parent: NodeId, props: Partial<NodeProps>): NodeId {
    return this.commit(tr('Создать'), (tx) => tx.create(type, parent, { name: this.nextName(type), ...props }), () => []);
  }

  /** Replaces a layer with an instance of a component, in the same place and order (one undo step). */
  replaceWithInstance(id: NodeId, component: NodeId): NodeId | null {
    const parent = this.doc.parent(id);
    if (!parent) return null;
    const placed = this.commit(tr('Заменить на копию компонента'), (tx) => {
      const inst = createInstance(this.doc, tx, component, parent, { x: this.doc.get(id, 'x'), y: this.doc.get(id, 'y') }, { after: id });
      tx.delete(id);
      return inst;
    });
    this.setSelection([placed]);
    return placed;
  }

  /** Puts a screen template to the right of everything on the page and selects it. */
  insertTemplate(template: ScreenTemplate): NodeId {
    const kids = this.doc.children(this.pageId).filter((id) => this.doc.get(id, 'visible'));
    const right = kids.length ? Math.max(...kids.map((id) => this.doc.get(id, 'x') + this.doc.get(id, 'width'))) + 80 : 0;
    const top = kids.length ? Math.min(...kids.map((id) => this.doc.get(id, 'y'))) : 0;
    const id = this.commit(tr('Шаблон «{0}»', template.name), (tx) => template.build(tx, this.pageId, Math.round(right), Math.round(top)));
    this.setSelection([id]);
    this.zoomToSelection();
    return id;
  }

  /** Gives layers with default names meaningful ones (selection, or the whole page). Returns how many were renamed. */
  autoName(): number {
    const roots = this.selection.length ? this.topLevelSelection() : [...this.doc.children(this.pageId)];
    const names = suggestNames(this.doc, roots);
    if (names.size === 0) return 0;
    this.commit(tr('Переименовать слои'), (tx) => {
      for (const [id, name] of names) tx.set(id, 'name', name);
    });
    return names.size;
  }

  /** «Фрейм 3», «Прямоугольник 12» (in the interface's language): the next free number of this kind on the page. */
  nextName(type: NodeType | 'ARROW'): string {
    const base: Record<string, string> = {
      FRAME: tr('Фрейм'),
      SECTION: tr('Секция'),
      COMPONENT: tr('Компонент'),
      GROUP: tr('Группа'),
      RECTANGLE: tr('Прямоугольник'),
      ELLIPSE: tr('Эллипс'),
      POLYGON: tr('Многоугольник'),
      STAR: tr('Звезда'),
      VECTOR: tr('Вектор'),
      LINE: tr('Линия'),
      ARROW: tr('Стрелка'),
      TEXT: tr('Текст'),
    };
    const prefix = base[type] ?? type;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let max = 0;
    this.doc.store.walk(this.pageId, (id) => {
      const m = new RegExp(`^${escaped} (\\d+)$`).exec(this.doc.get(id, 'name'));
      if (m) max = Math.max(max, Number(m[1]));
    });
    return `${prefix} ${max + 1}`;
  }

  // ---------- actions ----------

  deleteSelection(): void {
    if (this.vectorEdit?.tool === 'width' && this.widthSelection !== null) {
      this.removeWidthPoint(this.vectorEdit.id, this.widthSelection);
      return;
    }
    if (this.vectorEdit && this.vectorEdit.selected.length > 0) {
      this.deleteVectorPoints();
      return;
    }
    let ids = this.transformable(this.topLevelSelection(), tr('Удаление'));
    // A table's cell (or its text) is emptied, not taken out: the rest of the grid would shift (FEAT-168).
    const cellTexts = ids.flatMap((id) => {
      const cell = this.isTableCell(id) ? id : this.doc.type(id) === 'TEXT' && this.isTableCell(this.doc.parent(id) ?? id) ? this.doc.parent(id)! : null;
      return cell ? this.doc.children(cell).filter((c) => this.doc.type(c) === 'TEXT') : [];
    });
    if (cellTexts.length) {
      this.commit(tr('Очистить ячейки'), (tx) => {
        for (const t of cellTexts) if (this.doc.get(t, 'characters')) tx.set(t, 'characters', '');
      });
      ids = ids.filter((id) => !this.isTableCell(id) && !(this.doc.type(id) === 'TEXT' && this.isTableCell(this.doc.parent(id) ?? id)));
      if (ids.length === 0) return;
    }
    // On a board a locked object (a template's frame, a background) is kept from a stray Delete.
    if (this.isBoardFile()) {
      const free = ids.filter((id) => !this.doc.store.ancestors(id).concat(id).some((a) => this.doc.store.isAlive(a) && this.doc.type(a) !== 'PAGE' && this.doc.type(a) !== 'DOCUMENT' && this.doc.get(a, 'locked')));
      if (free.length < ids.length) this.toast(tr('Закреплённое не удаляется — сначала открепите (⇧⌘L)'));
      ids = free;
    }
    if (ids.length === 0) return;
    this.commit(tr('Удалить'), (tx) => {
      for (const id of ids) tx.delete(id);
    }, () => []);
  }

  selectAll(): void {
    let parent = this.selection.length > 0 ? this.doc.parent(this.selection[0]!) : this.pageId;
    // On a slide on show: everything on it, not the slides themselves.
    if (this.slideStage && (parent === this.pageId || (this.selection.length === 1 && this.isPinned(this.selection[0]!)))) parent = this.slideStage.current();
    if (!parent) return;
    this.setSelection(this.doc.children(parent).filter((id) => !this.doc.get(id, 'locked')));
  }

  selectChildren(): void {
    const children = this.selection.flatMap((id) => [...this.doc.children(id)]);
    if (children.length > 0) this.setSelection(children);
  }

  selectParent(): void {
    const parents = this.selection.map((id) => this.doc.parent(id)).filter((p): p is NodeId => p !== null && p !== this.pageId);
    // A slide on show is not taken: going up from its layers clears the selection.
    if (parents.some((p) => this.isPinned(p))) this.setSelection(parents.filter((p) => !this.isPinned(p)));
    else if (parents.length > 0) this.setSelection(parents);
  }

  selectSibling(step: 1 | -1): void {
    const current = this.selection[this.selection.length - 1];
    const parent = current ? this.doc.parent(current) : this.pageId;
    if (!parent) return;
    const siblings = this.doc.children(parent);
    if (siblings.length === 0) return;
    const i = current ? siblings.indexOf(current) : -1;
    // Layers list shows the top-most first, so "next" goes down the paint order.
    const next = siblings[(i - step + siblings.length) % siblings.length];
    if (next) this.setSelection([next]);
  }

  nudge(dx: number, dy: number): void {
    const ids = this.topLevelSelection().filter((id) => !this.inAutoLayout(id) && !this.isInstanceLayer(id) && !this.isPinned(id));
    if (ids.length === 0) return;
    this.commit(tr('Сдвинуть'), (tx) => {
      for (const id of ids) {
        const inv = this.parentLinearInverse(id);
        const d = apply(inv, { x: dx, y: dy });
        tx.update(id, { x: round2(this.doc.get(id, 'x') + d.x), y: round2(this.doc.get(id, 'y') + d.y) });
      }
    });
  }

  /** Inverse of the parent's linear transform (rotation), for converting world deltas. */
  parentLinearInverse(id: NodeId) {
    const parent = this.doc.parent(id);
    if (!parent || this.doc.type(parent) === 'PAGE') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const m = this.scene.world(parent);
    const inv = invert({ ...m, e: 0, f: 0 });
    return inv ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  }

  /** Whether the layer's parent arranges its children with auto layout (whatever the layer's own positioning). */
  inAutoLayoutParent(id: NodeId): boolean {
    const parent = this.doc.parent(id);
    return parent !== null && isFrameLike(this.doc.type(parent)) && this.doc.get(parent, 'layoutMode') !== 'NONE';
  }

  /**
   * Takes the selected layers out of their auto layout (they keep their place
   * and are not lined up with the others, as Figma's "absolute position"), or
   * puts them back. Returns false when nothing selected is in an auto layout.
   */
  toggleAbsolute(): boolean {
    const ids = this.selection.filter((id) => this.inAutoLayoutParent(id) && !this.isInstanceLayer(id));
    if (!ids.length) return false;
    const out = !ids.every((id) => this.doc.get(id, 'positioning') === 'ABSOLUTE');
    this.commit(out ? tr('Вывести из адаптивной раскладки') : tr('Вернуть в адаптивную раскладку'), (tx) => {
      for (const id of ids) tx.set(id, 'positioning', out ? 'ABSOLUTE' : 'AUTO');
    });
    return true;
  }

  inAutoLayout(id: NodeId): boolean {
    const parent = this.doc.parent(id);
    return parent !== null && isFrameLike(this.doc.type(parent)) && this.doc.get(parent, 'layoutMode') !== 'NONE' && this.doc.get(id, 'positioning') === 'AUTO';
  }

  /** Copies the selection to the internal clipboard and returns it as text for the system clipboard. */
  copyText(): string | null {
    const ids = this.topLevelSelection();
    if (ids.length === 0) return null;
    this.clipboard = toClipboard(this.doc, ids);
    return JSON.stringify(this.clipboard);
  }

  /** What goes to the system clipboard: layers hidden in HTML, their text as plain text. */
  copyFlavours(): { html: string; text: string } | null {
    const json = this.copyText();
    return json ? { html: clipboardHtml(json), text: clipboardPlainText(this.doc, this.topLevelSelection()) } : null;
  }

  /** Copy from the command palette: no clipboard event is available, so the async API is used. */
  copy(): void {
    const flavours = this.copyFlavours();
    if (!flavours) return;
    const item = typeof ClipboardItem === 'function' ? new ClipboardItem({ 'text/html': new Blob([flavours.html], { type: 'text/html' }), 'text/plain': new Blob([flavours.text], { type: 'text/plain' }) }) : null;
    (item ? navigator.clipboard?.write([item]) : navigator.clipboard?.writeText(flavours.text))?.catch(() => undefined);
  }

  cut(): void {
    this.copy();
    this.deleteSelection();
  }

  /** Paste from a menu or the palette (no clipboard event available). `at` places the top-left corner at a world point. */
  async paste(inPlace = false, at?: Point): Promise<void> {
    let text: string | null = null;
    try {
      // Our layers travel in the HTML flavour; plain text is the fallback (older copies).
      for (const item of (await navigator.clipboard?.read?.()) ?? []) {
        if (item.types.includes('text/html')) {
          const html = await (await item.getType('text/html')).text();
          if (parseClipboard(html)) text = html;
        }
      }
      text ??= (await navigator.clipboard?.readText()) ?? null;
    } catch {
      // Clipboard permission denied: fall back to the internal clipboard.
    }
    if (!this.pasteText(text, inPlace, at)) this.toast(tr('Буфер обмена пуст: сначала скопируйте слои'));
    else this.appear(this.selection);
  }

  /** Paste to replace (Mod+Shift+R, as in Figma): what is copied takes the place of each selected layer. */
  async pasteReplace(): Promise<void> {
    let text: string | null = null;
    try {
      for (const item of (await navigator.clipboard?.read?.()) ?? []) {
        if (item.types.includes('text/html')) {
          const html = await (await item.getType('text/html')).text();
          if (parseClipboard(html)) text = html;
        }
      }
      text ??= (await navigator.clipboard?.readText()) ?? null;
    } catch {
      // Clipboard permission denied: the internal clipboard.
    }
    this.pasteReplaceText(text);
  }

  /** Each selected layer gives way to a copy of the clipboard: centred where it was, in its parent and at its place in the layers. */
  pasteReplaceText(text: string | null): boolean {
    const data = (text ? parseClipboard(text) : null) ?? this.clipboard;
    if (!data || data.nodes.length === 0) {
      this.toast(tr('Буфер обмена пуст: сначала скопируйте слои'));
      return false;
    }
    const doomed = this.transformable(this.topLevelSelection(), tr('Вставить с заменой'));
    if (doomed.length === 0) {
      this.toast(tr('Выделите слои, на место которых вставить скопированное'));
      return false;
    }
    const xs = data.nodes.map((n) => n.props.x ?? 0);
    const ys = data.nodes.map((n) => n.props.y ?? 0);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const width = Math.max(...data.nodes.map((n) => (n.props.x ?? 0) + (n.props.width ?? 0))) - left;
    const height = Math.max(...data.nodes.map((n) => (n.props.y ?? 0) + (n.props.height ?? 0))) - top;
    this.commit(tr('Вставить с заменой'), (tx) => {
      const nodes = resolvePastedStyles(tx, this.doc, data);
      this.pendingSelection = doomed.flatMap((old) => {
        const parent = this.doc.parent(old)!;
        const cx = this.doc.get(old, 'x') + this.doc.get(old, 'width') / 2;
        const cy = this.doc.get(old, 'y') + this.doc.get(old, 'height') / 2;
        let after: NodeId = old;
        const made = nodes.map((node) => {
          const copy = structuredClone(node);
          copy.props.x = round2(cx - width / 2 + ((copy.props.x ?? 0) - left));
          copy.props.y = round2(cy - height / 2 + ((copy.props.y ?? 0) - top));
          after = pasteSubtree(tx, copy, parent, { after }, this.doc);
          return after;
        });
        tx.delete(old);
        return made;
      });
    }, () => this.pendingSelection);
    return true;
  }

  /** Pastes copied layers (system clipboard text if it holds our format, else the internal clipboard). */
  pasteText(text: string | null, inPlace = false, at?: Point): boolean {
    const data = (text ? parseClipboard(text) : null) ?? this.clipboard;
    if (!data || data.nodes.length === 0) return false;
    let target = at ? this.containerAt(at) : this.pasteTarget();
    let dx = inPlace ? 0 : 10;
    let dy = dx;
    // Pasting onto the very layer that was copied (it is still selected): the copy goes next to it,
    // never inside it — inside an auto layout card it would become one of its rows and reflow it.
    const sources = (data.sources ?? []).filter((id) => this.doc.store.isAlive(id));
    let after: NodeId | null = null;
    if (!at && sources.length > 0 && sources.some((src) => this.selection.includes(src) || this.isSelfOrAncestor(src, target))) {
      const first = sources[0]!;
      target = this.doc.parent(first) ?? this.pageId;
      const siblings = sources.filter((id) => this.doc.parent(id) === target);
      after = siblings[siblings.length - 1] ?? null;
      if (this.inAutoLayout(first)) {
        dx = 0;
        dy = 0;
      } else if (target === this.pageId && !inPlace) {
        // A top-level frame: to the right of the originals, in the first free place, as Figma does —
        // never on top of (or under) another frame standing there.
        const box = (id: NodeId) => ({ x: this.doc.get(id, 'x'), y: this.doc.get(id, 'y'), w: this.doc.get(id, 'width'), h: this.doc.get(id, 'height') });
        const boxes = siblings.map(box);
        const left = Math.min(...boxes.map((b) => b.x));
        const top = Math.min(...boxes.map((b) => b.y));
        const width = Math.max(...boxes.map((b) => b.x + b.w)) - left;
        const height = Math.max(...boxes.map((b) => b.y + b.h)) - top;
        const others = this.doc.children(this.pageId).filter((id) => !siblings.includes(id) && this.doc.get(id, 'visible')).map(box);
        const GAP = 40;
        let x = left + width + GAP;
        for (let i = 0; i < 500; i++) {
          const hit = others.find((o) => x < o.x + o.w + GAP && x + width + GAP > o.x && top < o.y + o.h && top + height > o.y);
          if (!hit) break;
          x = hit.x + hit.w + GAP;
        }
        dx = Math.round(x - left);
        dy = 0;
      }
    }
    // Sections live only on the page or in sections: climb out of frames for them.
    while (target !== this.pageId && data.nodes.some((n) => !canContain(this.doc.type(target), n.type))) target = this.doc.parent(target) ?? this.pageId;
    if (at) {
      const local = this.toParentSpace(target, at);
      dx = local.x - Math.min(...data.nodes.map((n) => n.props.x ?? 0));
      dy = local.y - Math.min(...data.nodes.map((n) => n.props.y ?? 0));
    }
    // Several frames selected (none of them copied): a copy goes into each, where it stood in its own frame (as in Figma).
    const frames =
      !at && this.selection.length > 1 && this.selection.every((id) => isFrameLike(this.doc.type(id)) && !sources.includes(id) && data.nodes.every((n) => canContain(this.doc.type(id), n.type)))
        ? [...this.selection]
        : null;
    this.commit(tr('Вставить'), (tx) => {
      const nodes = resolvePastedStyles(tx, this.doc, data);
      this.pendingSelection = (frames ?? [target]).flatMap((into) =>
        nodes.map((node) => {
          const copy = structuredClone(node);
          copy.props.x = round2((copy.props.x ?? 0) + (frames ? 0 : dx));
          copy.props.y = round2((copy.props.y ?? 0) + (frames ? 0 : dy));
          const position = !frames && after && this.doc.parent(after) === into ? { after } : ({ at: 'end' } as const);
          const id = pasteSubtree(tx, copy, into, position, this.doc);
          if (!frames && after) after = id;
          return id;
        }),
      );
      // Brushes come along with the layers that use them (as in Figma): into this file's brush menu.
      const known = this.doc.get(this.doc.rootId, 'brushes');
      const brought = new Map<string, CustomBrush>();
      for (const id of this.pendingSelection) {
        const take = (n: NodeId) => {
          const b = this.doc.get(n, 'customBrush');
          if (b && !known.some((k) => k.id === b.id)) brought.set(b.id, b);
        };
        take(id);
        this.doc.store.walk(id, take);
      }
      if (brought.size > 0) tx.set(this.doc.rootId, 'brushes', [...known, ...brought.values()]);
    }, () => this.pendingSelection);
    return true;
  }

  /** Whether `node` is `id` itself or one of its ancestors. */
  private isSelfOrAncestor(node: NodeId, id: NodeId): boolean {
    for (let cur: NodeId | null = id; cur !== null; cur = this.doc.parent(cur)) if (cur === node) return true;
    return false;
  }

  get hasClipboard(): boolean {
    return this.clipboard !== null;
  }

  private pendingSelection: NodeId[] = [];

  /** Where pasted nodes go: into the selected frame, next to the selected node, or onto the page. */
  private pasteTarget(): NodeId {
    const first = this.selection[0];
    if (!first) return this.pageId;
    // Never into an instance: paste next to the outermost instance instead.
    const outer = outerInstance(this.doc, first);
    if (outer) return this.doc.parent(outer) ?? this.pageId;
    if (this.acceptsChildren(first) && this.doc.type(first) !== 'PAGE') return first;
    const parent = this.doc.parent(first) ?? this.pageId;
    return this.acceptsChildren(parent) ? parent : this.pageId;
  }

  /** Duplicates the selection, or `only` (a slide from the slides panel); returns the copies. */
  duplicate(only?: readonly NodeId[]): NodeId[] {
    const ids = this.transformable(only ? [...only] : this.topLevelSelection(), tr('Дублирование'));
    if (ids.length === 0) return [];
    const created: NodeId[] = [];
    this.commit(tr('Дублировать'), (tx) => {
      for (const id of ids) {
        const parent = this.doc.parent(id)!;
        // Variants share layer keys with their copies, so instances keep overrides when switching.
        if (this.doc.type(id) === 'COMPONENT') ensureLayerKeys(this.doc, tx, id);
        const node = copySubtree(this.doc, id);
        if (!this.inAutoLayout(id)) {
          node.props.x = (node.props.x ?? 0) + 10;
          node.props.y = (node.props.y ?? 0) + 10;
        }
        created.push(pasteSubtree(tx, node, parent, { after: id }, this.doc));
      }
    }, () => created);
    return created;
  }

  /**
   * Duplicates in place without offset; used by Alt-drag. Alt-dragging a
   * component (outside a set) places an instance of it, as in Figma.
   */
  duplicateInPlace(tx: Transaction, ids: readonly NodeId[]): NodeId[] {
    return ids.map((id) => {
      const parent = this.doc.parent(id)!;
      if (this.doc.type(id) === 'COMPONENT' && !componentSetOf(this.doc, id)) {
        return createInstance(this.doc, tx, id, parent, { x: this.doc.get(id, 'x'), y: this.doc.get(id, 'y') }, { after: id });
      }
      if (this.doc.type(id) === 'COMPONENT') ensureLayerKeys(this.doc, tx, id);
      return pasteSubtree(tx, copySubtree(this.doc, id), parent, { after: id }, this.doc);
    });
  }

  group(): void {
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Группировка')));
    if (ids.length === 0) return;
    const parent = this.doc.parent(ids[0]!)!;
    if (ids.some((id) => this.doc.type(id) === 'SECTION')) {
      this.toast(tr('Секции не группируются. Чтобы объединить секции, оберните их в секцию (меню «Обернуть в секцию»).'));
      return;
    }
    // Layers from different frames make a group in each of them (Multi-edit, as in Figma).
    const sets = this.byParent(ids).filter((set) => canContain(this.doc.type(this.doc.parent(set[0]!)!), 'GROUP'));
    if (sets.length === 0) {
      this.toast(this.doc.type(parent) === 'COMPONENT_SET' ? tr('Варианты внутри набора нельзя сгруппировать. Сгруппируйте набор целиком.') : tr('Здесь нельзя создать группу'));
      return;
    }
    const groups: NodeId[] = [];
    this.commit(tr('Сгруппировать'), (tx) => {
      for (const set of sets) {
        const groupId = tx.create('GROUP', this.doc.parent(set[0]!)!, { name: this.nextName('GROUP') }, { after: set[set.length - 1]! });
        for (const id of set) this.reparentKeepingPosition(tx, id, groupId);
        groups.push(groupId);
      }
    }, () => groups);
  }

  /** The layers split by parent, each part in the given order: what Multi-edit does once per frame. */
  private byParent(ids: NodeId[]): NodeId[][] {
    const parts = new Map<NodeId, NodeId[]>();
    for (const id of ids) {
      const parent = this.doc.parent(id)!;
      const part = parts.get(parent);
      if (part) part.push(id);
      else parts.set(parent, [id]);
    }
    return [...parts.values()];
  }

  ungroup(): void {
    const groups = this.transformable(this.topLevelSelection(), tr('Разгруппировка')).filter((id) => {
      const t = this.doc.type(id);
      return t === 'GROUP' || t === 'SECTION' || (t === 'FRAME' && this.doc.children(id).length > 0);
    });
    if (groups.length === 0) return;
    const released: NodeId[] = [];
    const styledFrames = groups.filter((g) => this.doc.type(g) === 'FRAME' && (this.doc.get(g, 'fills').length > 0 || this.doc.get(g, 'strokes').length > 0 || this.doc.get(g, 'effects').length > 0));
    const label = groups.every((g) => this.doc.type(g) === 'FRAME') ? tr('Убрать фрейм') : groups.every((g) => this.doc.type(g) === 'SECTION') ? tr('Убрать секцию') : tr('Разгруппировать');
    this.commit(label, (tx) => {
      for (const g of groups) {
        const parent = this.doc.parent(g)!;
        for (const child of [...this.doc.children(g)]) {
          if (this.reparentKeepingPosition(tx, child, parent, { before: g })) released.push(child);
        }
        tx.delete(g);
      }
    }, () => released);
    if (styledFrames.length > 0) {
      const name = this.doc.get(styledFrames[0]!, 'name');
      const undo = navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z';
      this.toast(tr('Фрейм «{0}» убран вместе с заливкой, обводкой и тенью — слои внутри остались. Вернуть: {1}', name, undo));
    }
  }

  /** Wraps the selection in a frame (FR-LYR-014). */
  frameSelection(autoLayout = false): void {
    const all = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Обёртка во фрейм')));
    if (all.length === 0) return;
    // Layers from different frames are wrapped in each of them (Multi-edit, as in Figma).
    const sets = this.byParent(all).filter((set) => this.acceptsChildren(this.doc.parent(set[0]!)!));
    if (sets.length === 0) {
      this.toast(tr('Здесь нельзя создать фрейм'));
      return;
    }
    const frames: NodeId[] = [];
    this.commit(autoLayout ? tr('Добавить адаптивную раскладку') : tr('Обернуть во фрейм'), (tx) => {
      for (const ids of sets) frames.push(this.wrapInFrame(tx, ids, autoLayout));
    }, () => frames);
  }

  private wrapInFrame(tx: Transaction, ids: NodeId[], autoLayout: boolean): NodeId {
    const parent = this.doc.parent(ids[0]!)!;
    const bounds = unionAll(ids.map((id) => this.scene.bounds(id)))!;
    const origin = this.toParentSpace(parent, { x: bounds.x, y: bounds.y });
    const props: Partial<NodeProps> = {
      name: this.nextName('FRAME'),
      x: round2(origin.x),
      y: round2(origin.y),
      width: round2(bounds.width),
      height: round2(bounds.height),
      fills: [],
      clipsContent: false,
    };
    if (autoLayout) Object.assign(props, this.inferAutoLayout(ids));
    const frameId = tx.create('FRAME', parent, props, { after: ids[ids.length - 1]! });
    const ordered = autoLayout ? this.sortedSpatially(ids, props.layoutMode === 'HORIZONTAL') : ids;
    for (const id of ordered) this.reparentKeepingPosition(tx, id, frameId);
    return frameId;
  }

  /**
   * Wraps the selection in a section (FR-CNV: sections). Sections hold top-level
   * work, so only layers on the page or inside a section can be wrapped; the
   * section gets a margin around them, as in Figma.
   */
  sectionSelection(): NodeId | null {
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Обёртка в секцию')));
    if (ids.length === 0) return null;
    const parent = this.doc.parent(ids[0]!)!;
    const parentType = this.doc.type(parent);
    if ((parentType !== 'PAGE' && parentType !== 'SECTION') || ids.some((id) => this.doc.parent(id) !== parent)) {
      this.toast(tr('В секцию можно обернуть только слои верхнего уровня страницы или секции'));
      return null;
    }
    const pad = SECTION_PADDING;
    const b = unionAll(ids.map((id) => this.scene.bounds(id)))!;
    let section = '';
    this.commit(tr('Обернуть в секцию'), (tx) => {
      const origin = this.toParentSpace(parent, { x: b.x - pad, y: b.y - pad - SECTION_TITLE_SPACE });
      section = tx.create('SECTION', parent, {
        name: this.nextName('SECTION'),
        x: round2(origin.x),
        y: round2(origin.y),
        width: round2(b.width + pad * 2),
        height: round2(b.height + pad * 2 + SECTION_TITLE_SPACE),
      }, { before: ids[0]! });
      for (const id of ids) this.reparentKeepingPosition(tx, id, section);
    }, () => [section]);
    return section;
  }

  /**
   * After a section was drawn, moved or resized: top-level layers lying fully
   * inside it go in, its own children lying fully outside go out (to the page
   * or the enclosing section), as in Figma. Call it after the size change has
   * been applied (a later step of the gesture): moved layers keep their place
   * using the scene's current transforms.
   */
  adoptIntoSection(tx: Transaction, section: NodeId): void {
    const d = this.doc;
    if (!d.store.isAlive(section) || d.type(section) !== 'SECTION') return;
    const parent = d.parent(section)!;
    // The box comes from the props, not the scene: it may change in this very transaction.
    const origin = d.type(parent) === 'PAGE' ? { x: 0, y: 0 } : this.worldOrigin(parent);
    const box = { x: origin.x + d.get(section, 'x'), y: origin.y + d.get(section, 'y'), width: d.get(section, 'width'), height: d.get(section, 'height') };
    for (const id of [...d.children(parent)]) {
      if (id === section || d.get(id, 'locked')) continue;
      if (containsRect(box, this.scene.bounds(id))) this.reparentKeepingPosition(tx, id, section);
    }
    for (const id of [...d.children(section)]) {
      if (!intersects(box, this.scene.bounds(id))) this.reparentKeepingPosition(tx, id, parent, { after: section });
    }
  }

  /** Shift+A: adds auto layout to a frame, or wraps the selection in an auto layout frame (FR-AL-012). */
  addAutoLayout(): void {
    const ids = this.topLevelSelection();
    const only = ids.length === 1 ? ids[0]! : null;
    if (only && (this.doc.type(only) === 'INSTANCE' || this.isInstanceLayer(only))) {
      this.toast(tr('Раскладку копии задаёт компонент. Измените компонент или отвяжите копию от него.'));
      return;
    }
    if (only && (this.doc.type(only) === 'FRAME' || this.doc.type(only) === 'COMPONENT')) {
      if (this.doc.get(only, 'layoutMode') !== 'NONE') {
        this.commit(tr('Убрать адаптивную раскладку'), (tx) => tx.set(only, 'layoutMode', 'NONE'));
        return;
      }
      const children = [...this.doc.children(only)];
      this.commit(tr('Добавить адаптивную раскладку'), (tx) => {
        const inferred = this.inferAutoLayout(children);
        // The layers stay where they are: their distances from the frame's edges become its padding (as in Figma).
        const frame = this.scene.bounds(only);
        const boxes = children.map((id) => this.scene.bounds(id));
        const inset = boxes.length
          ? {
              paddingLeft: Math.max(0, Math.round(Math.min(...boxes.map((b) => b.x)) - frame.x)),
              paddingTop: Math.max(0, Math.round(Math.min(...boxes.map((b) => b.y)) - frame.y)),
              paddingRight: Math.max(0, Math.round(frame.x + frame.width - Math.max(...boxes.map((b) => b.x + b.width)))),
              paddingBottom: Math.max(0, Math.round(frame.y + frame.height - Math.max(...boxes.map((b) => b.y + b.height)))),
            }
          : {};
        tx.update(only, { ...inferred, ...inset, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
        const ordered = this.sortedSpatially(children, inferred.layoutMode === 'HORIZONTAL');
        ordered.forEach((id, i) => tx.move(id, only, { index: i }));
      });
      return;
    }
    if (ids.length > 0) this.frameSelection(true);
  }

  /** Frames with auto layout in the selection and inside it (an instance's inside follows its component). */
  autoLayoutsInSelection(): NodeId[] {
    const d = this.doc;
    const out: NodeId[] = [];
    const visit = (id: NodeId) => {
      if (d.type(id) === 'INSTANCE' || this.isInstanceLayer(id)) return;
      if (isFrameLike(d.type(id)) && d.get(id, 'layoutMode') !== 'NONE') out.push(id);
      for (const c of d.children(id)) visit(c);
    };
    for (const id of this.topLevelSelection()) visit(id);
    return out;
  }

  /**
   * «Remove all auto layout», as in Figma: the selection and everything inside it
   * lose auto layout and grids; every layer keeps its place and size (hug and fill become fixed).
   */
  removeAllAutoLayout(): void {
    const frames = this.autoLayoutsInSelection();
    if (frames.length === 0) {
      this.toast(tr('В выделении нет адаптивной раскладки'));
      return;
    }
    const d = this.doc;
    this.commit(tr('Убрать всю адаптивную раскладку'), (tx) => {
      const fixed = (id: NodeId) => {
        for (const key of ['sizingH', 'sizingV'] as const) if (d.get(id, key).mode !== 'FIXED') tx.set(id, key, { mode: 'FIXED' });
      };
      for (const frame of frames) {
        tx.set(frame, 'layoutMode', 'NONE');
        fixed(frame);
        for (const c of d.children(frame)) fixed(c);
      }
    });
    this.toast(tr('Адаптивная раскладка убрана у фреймов: {0}', frames.length));
  }

  /** Direction, spacing and padding inferred from the current arrangement. */
  private inferAutoLayout(ids: readonly NodeId[]): Partial<NodeProps> {
    const boxes = ids.map((id) => this.scene.bounds(id));
    if (boxes.length < 2) {
      return { layoutMode: 'VERTICAL', itemSpacing: 10, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } };
    }
    const spanX = Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x));
    const spanY = Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y));
    const horizontal = spanX >= spanY;
    const sorted = [...boxes].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      gaps.push(horizontal ? cur.x - (prev.x + prev.width) : cur.y - (prev.y + prev.height));
    }
    gaps.sort((a, b) => a - b);
    // The lower median: with two gaps (21 and 81) the layers keep the tighter one.
    const median = Math.max(0, Math.round(gaps[Math.floor((gaps.length - 1) / 2)] ?? 0));
    return {
      layoutMode: horizontal ? 'HORIZONTAL' : 'VERTICAL',
      itemSpacing: median,
      sizingH: { mode: 'HUG' },
      sizingV: { mode: 'HUG' },
    };
  }

  private sortedSpatially(ids: readonly NodeId[], horizontal: boolean): NodeId[] {
    return [...ids].sort((a, b) => {
      const ba = this.scene.bounds(a);
      const bb = this.scene.bounds(b);
      return horizontal ? ba.x - bb.x : ba.y - bb.y;
    });
  }

  sortedByPaintOrder(ids: readonly NodeId[]): NodeId[] {
    return [...ids].sort((a, b) => this.scene.paintOrder(a) - this.scene.paintOrder(b));
  }

  /** Alignment (FR-DRW-090): one node aligns to its parent, several to the selection bounds. */
  /**
   * Shift+H / Shift+V, as in Figma: mirrors the selection on screen around its
   * centre. There is no mirror matrix in the document, so the mirror is written
   * into the layers: points, corner radii, gradients and children's places are
   * mirrored and the rotation changes sign. Text and the inside of an instance
   * keep reading the right way (only their places and rotation follow).
   */
  flip(axis: 'H' | 'V'): void {
    const ids = this.topLevelSelection().filter((id) => this.canTransform(id) && !this.isInstanceLayer(id));
    if (ids.length === 0) return;
    const box = unionAll(ids.map((id) => this.scene.bounds(id)));
    if (!box) return;
    const pivot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    this.commit(axis === 'H' ? tr('Отразить по горизонтали') : tr('Отразить по вертикали'), (tx) => {
      for (const id of ids) {
        const w = this.doc.get(id, 'width');
        const h = this.doc.get(id, 'height');
        const c = apply(this.scene.world(id), { x: w / 2, y: h / 2 });
        const mirrored = axis === 'H' ? { x: 2 * pivot.x - c.x, y: c.y } : { x: c.x, y: 2 * pivot.y - c.y };
        const parent = this.doc.parent(id)!;
        const rotation = this.mirrorLayer(tx, id, axis);
        if (this.inAutoLayout(id)) continue;
        placeCentre(tx, id, this.toParentSpace(parent, mirrored), w, h, rotation);
      }
    });
  }

  /**
   * Turns a layer to an angle the way the rotation handle does: round its centre, or round
   * the origin moved with Alt+R — so typing the angle the handle showed gives the same result.
   */
  applyRotation(tx: Transaction, id: NodeId, value: number): void {
    const d = this.doc;
    const rotation = normalizeAngle(round2(value));
    const r0 = d.get(id, 'rotation');
    if (this.inAutoLayout(id)) return void tx.set(id, 'rotation', rotation);
    const m0 = this.localTransform(id);
    const parent = d.parent(id)!;
    const moved = this.rotationOrigin.at && this.selection.length === 1 && this.selection[0] === id ? this.rotationOrigin.at : null;
    const pivot = moved ? this.toParentSpace(parent, moved) : apply(m0, { x: d.get(id, 'width') / 2, y: d.get(id, 'height') / 2 });
    const turn = ((rotation - r0) * Math.PI) / 180;
    const dx = m0.e - pivot.x;
    const dy = m0.f - pivot.y;
    tx.update(id, { rotation, x: round2(pivot.x + dx * Math.cos(turn) - dy * Math.sin(turn)), y: round2(pivot.y + dx * Math.sin(turn) + dy * Math.cos(turn)) });
  }

  /** Rotates the selection by 90° (clockwise; counter-clockwise when `back`), each layer around its centre. */
  rotate90(back = false): void {
    const ids = this.topLevelSelection().filter((id) => this.canTransform(id) && !this.isInstanceLayer(id));
    if (ids.length === 0) return;
    this.commit(tr('Повернуть на 90°'), (tx) => {
      for (const id of ids) {
        const w = this.doc.get(id, 'width');
        const h = this.doc.get(id, 'height');
        const centre = apply(this.localTransform(id), { x: w / 2, y: h / 2 });
        const rotation = normalizeDegrees(this.doc.get(id, 'rotation') + (back ? -90 : 90));
        tx.set(id, 'rotation', rotation);
        if (!this.inAutoLayout(id)) placeCentre(tx, id, centre, w, h, rotation);
      }
    });
  }

  /** Mirrors a layer inside its own box (and its children in it); returns its new rotation. */
  private mirrorLayer(tx: Transaction, id: NodeId, axis: 'H' | 'V'): number {
    const d = this.doc;
    const type = d.type(id);
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const r = d.get(id, 'rotation');
    // A regular polygon or star is symmetric left to right: upside down is the same shape turned half round.
    if ((type === 'POLYGON' || type === 'STAR') && axis === 'V') {
      const rotation = normalizeDegrees(180 - r);
      tx.set(id, 'rotation', rotation);
      return rotation;
    }
    const rotation = normalizeDegrees(-r);
    if (rotation !== r) tx.set(id, 'rotation', rotation);
    const m = (p: Point): Point => (axis === 'H' ? { x: w - p.x, y: p.y } : { x: p.x, y: h - p.y });
    const net = d.get(id, 'vectorNetwork');
    if (net) tx.set(id, 'vectorNetwork', mapNetwork(net, m));
    const paths = d.get(id, 'vectorPaths');
    if (!net && paths.length) tx.set(id, 'vectorPaths', mapPaths(paths, m));
    // An arc keeps its sweep: its angles are mirrored (left-right: θ → 180° − θ, up-down: θ → −θ).
    const arc = type === 'ELLIPSE' ? d.get(id, 'arc') : null;
    if (arc) tx.set(id, 'arc', { ...arc, start: normalizeDegrees(axis === 'H' ? 180 - arc.start - arc.sweep : -arc.start - arc.sweep) });
    const radii = d.get(id, 'cornerRadii');
    if (radii) {
      const [tl, tr_, br, bl] = radii;
      tx.set(id, 'cornerRadii', axis === 'H' ? [tr_, tl, bl, br] : [bl, br, tr_, tl]);
    }
    const mirrorPaints = (paints: readonly Paint[]): Paint[] | null => {
      if (!paints.some((p) => 'from' in p || p.type === 'IMAGE')) return null;
      const u = (v: { x: number; y: number }) => (axis === 'H' ? { x: 1 - v.x, y: v.y } : { x: v.x, y: 1 - v.y });
      return paints.map((p) => {
        if ('from' in p) return { ...p, from: u(p.from), to: u(p.to) };
        // A picture in the fill is mirrored with the layer, as in Figma.
        if (p.type === 'IMAGE') return axis === 'H' ? { ...p, flipX: !p.flipX || undefined } : { ...p, flipY: !p.flipY || undefined };
        return p;
      });
    };
    const fills = mirrorPaints(d.get(id, 'fills'));
    if (fills) tx.set(id, 'fills', fills);
    const strokes = mirrorPaints(d.get(id, 'strokes'));
    if (strokes) tx.set(id, 'strokes', strokes);
    if (type === 'TEXT' || type === 'INSTANCE') return rotation;
    for (const child of d.children(id)) {
      const cw = d.get(child, 'width');
      const ch = d.get(child, 'height');
      const centre = apply(this.localTransform(child), { x: cw / 2, y: ch / 2 });
      const childRotation = this.mirrorLayer(tx, child, axis);
      if (this.inAutoLayout(child)) continue;
      placeCentre(tx, child, m(centre), cw, ch, childRotation);
    }
    return rotation;
  }

  /**
   * Aligns the selection: one layer to its parent, several to each other.
   * `asGroup` (Shift on the panel's buttons, as in Figma): several layers move
   * together as one block, aligned to their parent.
   */
  align(edge: AlignEdge, asGroup = false): void {
    const ids = this.topLevelSelection().filter((id) => !this.inAutoLayout(id) && !this.isInstanceLayer(id));
    if (ids.length === 0) return;
    // Each part is aligned to its target; `block` — the part moves as one.
    const parts: { ids: NodeId[]; target: Rect; block: Rect | null }[] = [];
    if (ids.length === 1 || asGroup) {
      // Shift with layers from different frames: each frame's layers to that frame (Multi-edit, as in Figma).
      for (const set of this.byParent(ids)) {
        const parent = this.doc.parent(set[0]!)!;
        if (this.doc.type(parent) === 'PAGE') continue;
        parts.push({ ids: set, target: this.scene.bounds(parent), block: set.length > 1 ? unionAll(set.map((id) => this.scene.bounds(id))) : null });
      }
    } else {
      const all = unionAll(ids.map((id) => this.scene.bounds(id)));
      if (all) parts.push({ ids, target: all, block: null });
    }
    if (parts.length === 0) return;
    this.commit(tr('Выровнять'), (tx) => {
      for (const { ids, target: t, block } of parts) {
        for (const id of ids) {
          const b = block ?? this.scene.bounds(id);
          let dx = 0;
          let dy = 0;
          if (edge === 'left') dx = t.x - b.x;
          if (edge === 'hcenter') dx = t.x + t.width / 2 - (b.x + b.width / 2);
          if (edge === 'right') dx = t.x + t.width - (b.x + b.width);
          if (edge === 'top') dy = t.y - b.y;
          if (edge === 'vcenter') dy = t.y + t.height / 2 - (b.y + b.height / 2);
          if (edge === 'bottom') dy = t.y + t.height - (b.y + b.height);
          const d = apply(this.parentLinearInverse(id), { x: dx, y: dy });
          tx.update(id, { x: round2(this.doc.get(id, 'x') + d.x), y: round2(this.doc.get(id, 'y') + d.y) });
        }
      }
    });
  }

  distribute(axis: 'x' | 'y'): void {
    const ids = this.topLevelSelection().filter((id) => !this.inAutoLayout(id) && !this.isInstanceLayer(id));
    // On a board objects that overlap are spread apart (two are enough); a design keeps Figma's rule (three, the span stays).
    const board = this.doc.get(this.doc.rootId, 'fileKind') === 'BOARD';
    if (ids.length < (board ? 2 : 3)) return;
    const boxes = ids.map((id) => ({ id, b: this.scene.bounds(id) }));
    boxes.sort((p, q) => (axis === 'x' ? p.b.x - q.b.x : p.b.y - q.b.y));
    const first = boxes[0]!.b;
    const last = boxes[boxes.length - 1]!.b;
    const total = boxes.reduce((s, p) => s + (axis === 'x' ? p.b.width : p.b.height), 0);
    const span = axis === 'x' ? last.x + last.width - first.x : last.y + last.height - first.y;
    let gap = (span - total) / (boxes.length - 1);
    // Not enough room between the outer ones: on a board the span grows instead of the objects piling up.
    if (board && gap < BOARD_GAP) gap = BOARD_GAP;
    this.commit(tr('Распределить'), (tx) => {
      let cursor = axis === 'x' ? first.x : first.y;
      for (const { id, b } of boxes) {
        const delta = cursor - (axis === 'x' ? b.x : b.y);
        const d = apply(this.parentLinearInverse(id), axis === 'x' ? { x: delta, y: 0 } : { x: 0, y: delta });
        tx.update(id, { x: round2(this.doc.get(id, 'x') + d.x), y: round2(this.doc.get(id, 'y') + d.y) });
        cursor += (axis === 'x' ? b.width : b.height) + gap;
      }
    });
  }

  /** Moves a node by a world-space offset (works inside rotated or scaled parents). */
  private moveBy(tx: Transaction, id: NodeId, dx: number, dy: number): void {
    const d = apply(this.parentLinearInverse(id), { x: dx, y: dy });
    tx.update(id, { x: round2(this.doc.get(id, 'x') + d.x), y: round2(this.doc.get(id, 'y') + d.y) });
  }

  /**
   * The selection as a row or column with equal gaps (FR-DRW-092): items sorted
   * along the axis, not overlapping, gaps equal within half a pixel.
   */
  equalSpacing(): { axis: 'x' | 'y'; ids: NodeId[]; gap: number; boxes: Rect[] } | null {
    const ids = this.topLevelSelection().filter((id) => !this.inAutoLayout(id) && !this.isInstanceLayer(id));
    if (ids.length < 2) return null;
    for (const axis of ['x', 'y'] as const) {
      const items = ids.map((id) => ({ id, b: this.scene.bounds(id) })).sort((p, q) => (axis === 'x' ? p.b.x - q.b.x : p.b.y - q.b.y));
      const gaps: number[] = [];
      for (let i = 0; i + 1 < items.length; i++) {
        const a = items[i]!.b;
        const b = items[i + 1]!.b;
        gaps.push(axis === 'x' ? b.x - (a.x + a.width) : b.y - (a.y + a.height));
      }
      if (gaps.every((g) => g >= -1e-6 && Math.abs(g - gaps[0]!) < 0.5)) return { axis, ids: items.map((i) => i.id), gap: gaps[0]!, boxes: items.map((i) => i.b) };
    }
    return null;
  }

  /** Sets every gap of an equally spaced selection (dragging a spacing handle). */
  setEqualSpacing(tx: Transaction, axis: 'x' | 'y', ids: readonly NodeId[], boxes: readonly Rect[], gap: number): void {
    let cursor = axis === 'x' ? boxes[0]!.x : boxes[0]!.y;
    ids.forEach((id, i) => {
      const b = boxes[i]!;
      // Relative to where the item is now (a gesture applies this many times).
      const now = this.scene.bounds(id);
      const delta = cursor - (axis === 'x' ? now.x : now.y);
      if (delta !== 0) this.moveBy(tx, id, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
      cursor += (axis === 'x' ? b.width : b.height) + gap;
    });
  }

  /**
   * "Tidy up" (FR-DRW-091): arranges the selection into rows and columns with
   * equal gaps, keeping the reading order and the top-left corner.
   */
  tidyUp(): void {
    const ids = this.topLevelSelection().filter((id) => !this.inAutoLayout(id) && !this.isInstanceLayer(id));
    if (ids.length < 2) return;
    const items = ids.map((id) => ({ id, b: this.scene.bounds(id) }));
    // Rows: items whose vertical centres are close belong together.
    const byY = [...items].sort((p, q) => p.b.y + p.b.height / 2 - (q.b.y + q.b.height / 2));
    const rows: (typeof items)[] = [];
    for (const it of byY) {
      const row = rows[rows.length - 1];
      const cy = it.b.y + it.b.height / 2;
      if (row) {
        const ref = row.reduce((s, r) => s + r.b.y + r.b.height / 2, 0) / row.length;
        const tol = Math.max(...row.map((r) => r.b.height), it.b.height) / 2;
        if (Math.abs(cy - ref) <= tol) {
          row.push(it);
          continue;
        }
      }
      rows.push([it]);
    }
    for (const row of rows) row.sort((p, q) => p.b.x - q.b.x);
    // Gaps: the median of the current gaps (so a rough layout keeps its feel).
    const median = (v: number[], fallback: number) => {
      const s = v.filter((x) => x >= 0).sort((a, b) => a - b);
      return s.length > 0 ? s[Math.floor(s.length / 2)]! : fallback;
    };
    const hGaps = rows.flatMap((row) => row.slice(1).map((it, i) => it.b.x - (row[i]!.b.x + row[i]!.b.width)));
    const vGaps = rows.slice(1).map((row, i) => Math.min(...row.map((r) => r.b.y)) - Math.max(...rows[i]!.map((r) => r.b.y + r.b.height)));
    const gx = Math.round(median(hGaps, 20));
    const gy = Math.round(median(vGaps, gx));
    // Columns line up across rows: each column is as wide as its widest item.
    const cols = Math.max(...rows.map((r) => r.length));
    const colWidth = Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map((r) => r[c]?.b.width ?? 0)));
    const left = Math.min(...items.map((i) => i.b.x));
    let y = Math.min(...items.map((i) => i.b.y));
    this.commit(tr('Выстроить ровной сеткой'), (tx) => {
      for (const row of rows) {
        let x = left;
        row.forEach((it, c) => {
          this.moveBy(tx, it.id, x - it.b.x, y - it.b.y);
          x += colWidth[c]! + gx;
        });
        y += Math.max(...row.map((r) => r.b.height)) + gy;
      }
    });
  }

  /** Changes paint order: 'forward', 'backward', 'front', 'back'. */
  reorder(direction: 'forward' | 'backward' | 'front' | 'back'): void {
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Порядок слоёв')));
    if (ids.length === 0) return;
    this.commit(tr('Порядок слоёв'), (tx) => {
      const list = direction === 'forward' || direction === 'front' ? [...ids].reverse() : ids;
      for (const id of list) {
        const parent = this.doc.parent(id)!;
        const siblings = this.doc.children(parent);
        const i = siblings.indexOf(id);
        if (direction === 'front') tx.move(id, parent, { at: 'end' });
        else if (direction === 'back') tx.move(id, parent, { at: 'start' });
        else if (direction === 'forward' && i < siblings.length - 1) tx.move(id, parent, { after: siblings[i + 1]! });
        else if (direction === 'backward' && i > 0) tx.move(id, parent, { before: siblings[i - 1]! });
      }
    });
  }

  toggleProp(key: 'visible' | 'locked'): void {
    const ids = this.topLevelSelection();
    if (ids.length === 0) return;
    const value = !ids.every((id) => this.doc.get(id, key));
    this.commit(key === 'visible' ? tr('Видимость') : tr('Закрепление'), (tx) => {
      for (const id of ids) tx.set(id, key, value);
    }, () => (key === 'locked' && value && !this.isBoardFile() ? [] : ids));
  }

  /** A board (FEAT-083), not a design. */
  isBoardFile(): boolean {
    return this.doc.get(this.doc.rootId, 'fileKind') === 'BOARD';
  }

  private copiedProps: Partial<NodeProps> | null = null;

  /**
   * A fill, stroke or effect row picked in the right panel (as in Figma): ⌘C copies just that
   * property, ⌘V on another layer adds it — or puts it in place of the row picked there.
   */
  pickedProperty: PickedProperty | null = null;

  /** The last property copied here (also on the system clipboard, for other tabs). */
  propertyClip: string | null = null;

  pickProperty(picked: PickedProperty | null): void {
    this.pickedProperty = picked;
  }

  /** Copies the picked row of the first selected layer; the text for the clipboard, null — nothing picked. */
  copyPickedProperty(): string | null {
    const picked = this.pickedProperty;
    const id = this.selection[0];
    if (!picked || !id || !this.doc.store.isAlive(id)) return null;
    const value = this.doc.get(id, picked.key)[picked.index];
    if (!value) return null;
    this.propertyClip = JSON.stringify({ [PROPERTY_CLIP]: { key: picked.key, value } });
    void navigator.clipboard?.writeText(this.propertyClip).catch(() => undefined);
    return this.propertyClip;
  }

  /** What the last copied property is: fills, strokes or effects. */
  propertyClipKey(): PickedProperty['key'] | null {
    try {
      return this.propertyClip ? (JSON.parse(this.propertyClip) as Record<string, { key: PickedProperty['key'] }>)[PROPERTY_CLIP]?.key ?? null : null;
    } catch {
      return null;
    }
  }

  /** Takes the picked fill, stroke or effect off the selected layers (cut). */
  removePickedProperty(): void {
    const picked = this.pickedProperty;
    if (!picked) return;
    const { key, index } = picked;
    this.commit(tr('Вырезать свойство'), (tx) => {
      for (const id of this.topLevelSelection()) {
        const list = [...this.doc.get(id, key)] as (Paint | Effect)[];
        if (index >= list.length) continue;
        list.splice(index, 1);
        tx.set(id, key, list as never);
      }
    });
    this.pickProperty(null);
  }

  /** Pastes one copied fill, stroke or effect (see `copiedPropertyText`); false — the text is not one. */
  pastePropertyText(text: string | null): boolean {
    let clip: { key: PickedProperty['key']; value: Paint | Effect } | undefined;
    try {
      clip = text && text.includes(PROPERTY_CLIP) ? (JSON.parse(text) as Record<string, typeof clip>)[PROPERTY_CLIP] : undefined;
    } catch {
      return false;
    }
    if (!clip || !['fills', 'strokes', 'effects'].includes(clip.key)) return false;
    const { key, value } = clip;
    const ids = this.topLevelSelection().filter((id) => key === 'effects' || this.doc.type(id) !== 'GROUP');
    if (ids.length === 0) return true;
    const picked = this.pickedProperty?.key === key ? this.pickedProperty.index : null;
    this.commit(key === 'fills' ? tr('Вставить заливку') : key === 'strokes' ? tr('Вставить обводку') : tr('Вставить эффект'), (tx) => {
      for (const id of ids) {
        const list = [...this.doc.get(id, key)] as (Paint | Effect)[];
        if (picked !== null && picked < list.length) list[picked] = structuredClone(value);
        else list.push(structuredClone(value));
        tx.set(id, key, list as never);
        // A pasted stroke shows even on a layer that had none.
        if (key === 'strokes' && this.doc.get(id, 'strokeWeight') === 0) tx.set(id, 'strokeWeight', 1);
      }
    });
    return true;
  }

  /** Copies visual properties of the first selected layer (Mod+Alt+C). */
  copyProperties(): void {
    const id = this.selection[0];
    if (!id) return;
    // Styles go with their values, as in Figma.
    const keys = ['fills', 'fillStyleId', 'strokes', 'strokeStyleId', 'strokeWeight', 'strokeAlign', 'dashPattern', 'effects', 'effectStyleId', 'opacity', 'blendMode', 'cornerRadius', 'cornerRadii'] as const;
    const text = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'textStyleId'] as const;
    const props: Partial<NodeProps> = {};
    for (const k of keys) (props as Record<string, unknown>)[k] = structuredClone(this.doc.get(id, k));
    if (this.doc.type(id) === 'TEXT') for (const k of text) (props as Record<string, unknown>)[k] = structuredClone(this.doc.get(id, k));
    this.copiedProps = props;
    this.toast(tr('Свойства скопированы'));
  }

  /** Applies copied properties to the selection (Mod+Alt+V). */
  pasteProperties(): void {
    const props = this.copiedProps;
    if (props && this.editingText) {
      this.pastePropertiesIntoText(props);
      return;
    }
    const ids = this.topLevelSelection();
    if (!props || ids.length === 0) return;
    this.commit(tr('Вставить оформление'), (tx) => {
      for (const id of ids) {
        const own = { ...props };
        if (this.doc.type(id) !== 'TEXT') {
          for (const k of ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'textStyleId'] as const) delete own[k];
        }
        tx.update(id, own);
      }
    });
  }

  /**
   * While typing: the copied text look goes onto the selected characters; with a bare caret, onto
   * the stretch round it that looks the same (as in Figma).
   */
  private pastePropertiesIntoText(props: Partial<NodeProps>): void {
    const id = this.editingText!;
    const patch: TextRunStyle = {};
    for (const k of ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'letterSpacing', 'textDecoration', 'fills'] as const) {
      if (props[k] !== undefined) (patch as Record<string, unknown>)[k] = structuredClone(props[k]);
    }
    if (Object.keys(patch).length === 0) return;
    let { start, end } = this.textRange();
    if (start === end) {
      const length = this.doc.get(id, 'characters').length;
      const at = Math.max(0, start - 1);
      const cuts = [0, length, ...this.doc.get(id, 'textRuns').flatMap((r) => [r.start, r.end])];
      start = Math.max(...cuts.filter((c) => c <= at));
      end = Math.min(...cuts.filter((c) => c > at));
      if (!(end > start)) return;
      this.textSel = { anchor: start, focus: end };
    }
    this.applyTextStyle(patch, tr('Вставить оформление'));
  }

  private textSelection(): NodeId[] {
    return this.topLevelSelection().filter((id) => this.doc.type(id) === 'TEXT');
  }

  changeFontSize(delta: number): void {
    const ids = this.textSelection();
    if (ids.length === 0) return;
    this.commit(tr('Размер шрифта'), (tx) => {
      for (const id of ids) tx.set(id, 'fontSize', Math.max(1, this.doc.get(id, 'fontSize') + delta));
    });
  }

  setTextAlign(align: 'LEFT' | 'CENTER' | 'RIGHT'): void {
    const ids = this.textSelection();
    if (ids.length === 0) return;
    this.commit(tr('Выравнивание текста'), (tx) => {
      for (const id of ids) tx.set(id, 'textAlignH', align);
    });
  }

  /** Sets a property on every selected node (used by the properties panel). */
  setProps(ids: readonly NodeId[], props: Partial<NodeProps>, label = tr('Изменить свойства')): void {
    if (ids.length === 0) return;
    this.commit(label, (tx) => {
      for (const id of ids) tx.update(id, props);
    });
  }

  // ---------- components (section 10) ----------

  /** Mod+Alt+K: a frame becomes a component; anything else is wrapped in a new component. */
  createComponent(): void {
    const ids = this.topLevelSelection();
    if (ids.length === 0) return;
    if (ids.some((id) => this.isInstanceLayer(id) || insideInstance(this.doc, id))) {
      this.toast(tr('Внутри копии компонента нельзя создать новый компонент'));
      return;
    }
    const already = ids.filter((id) => ['COMPONENT', 'COMPONENT_SET'].includes(this.doc.type(id)));
    if (already.length) {
      this.toast(
        ids.length === 1
          ? tr('Выделенный слой уже компонент')
          : tr('Среди выделенных есть компоненты: «{0}». Компонент не кладут в другой компонент — выделите только обычные слои.', already.slice(0, 3).map((id) => this.doc.get(id, 'name')).join('», «')),
      );
      return;
    }
    const parent = this.doc.parent(ids[0]!)!;
    if (['COMPONENT', 'INSTANCE'].includes(this.doc.type(parent)) || this.doc.store.ancestors(parent).some((a) => this.doc.type(a) === 'COMPONENT')) {
      this.toast(tr('Компонент не может быть внутри другого компонента'));
      return;
    }
    let result = '';
    if (ids.length === 1 && this.doc.type(ids[0]!) === 'FRAME') {
      result = this.commit(tr('Создать компонент'), (tx) => convertFrameToComponent(this.doc, tx, ids[0]!), () => [result]);
      this.setSelection([result]);
      return;
    }
    const ordered = this.sortedByPaintOrder(ids);
    const bounds = unionAll(ordered.map((id) => this.scene.bounds(id)))!;
    this.commit(tr('Создать компонент'), (tx) => {
      const origin = this.toParentSpace(parent, { x: bounds.x, y: bounds.y });
      result = tx.create(
        'COMPONENT',
        parent,
        { name: this.nextName('COMPONENT'), x: round2(origin.x), y: round2(origin.y), width: round2(bounds.width), height: round2(bounds.height), fills: [], clipsContent: false },
        { after: ordered[ordered.length - 1]! },
      );
      for (const id of ordered) this.reparentKeepingPosition(tx, id, result);
      ensureLayerKeys(this.doc, tx, result);
    }, () => [result]);
  }

  /**
   * Inserts images as rectangles with an image fill (FR-DRW: image placement).
   * `at` is the world point of the first image's centre; by default the view centre.
   */
  insertImages(images: readonly ImageInput[], at?: Point): NodeId[] {
    if (images.length === 0) return [];
    const center = at ?? this.viewport.screenToWorld({ x: this.screenSize.width / 2, y: this.screenSize.height / 2 });
    const parent = this.containerAt(center);
    const MAX = 1600;
    const sizes = images.map((img) => {
      const k = Math.min(1, MAX / Math.max(img.width, img.height, 1));
      return { width: Math.max(1, Math.round(img.width * k)), height: Math.max(1, Math.round(img.height * k)) };
    });
    const created: NodeId[] = [];
    this.commit(images.length > 1 ? tr('Вставить изображения') : tr('Вставить изображение'), (tx) => {
      let x = center.x - sizes[0]!.width / 2;
      images.forEach((img, i) => {
        const size = sizes[i]!;
        const hash = tx.addBlob(img.bytes, img.mime);
        const local = this.toParentSpace(parent, { x, y: center.y - size.height / 2 });
        created.push(
          tx.create('RECTANGLE', parent, {
            name: img.name,
            x: round2(local.x),
            y: round2(local.y),
            width: size.width,
            height: size.height,
            fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }],
          }),
        );
        x += size.width + 20;
      });
    }, () => created);
    this.appear(created);
    return created;
  }

  /**
   * Places a big picture at its own size, one pixel to a unit (as Insert Big Image):
   * its pieces side by side in a group named after the file; a single piece is
   * just an image layer. The view then shows it whole.
   */
  insertImageTiles(name: string, width: number, height: number, tiles: readonly (ImageInput & { x: number; y: number })[], at?: Point): NodeId | null {
    if (tiles.length === 0) return null;
    const center = at ?? this.viewport.screenToWorld({ x: this.screenSize.width / 2, y: this.screenSize.height / 2 });
    const parent = this.containerAt(center);
    const origin = this.toParentSpace(parent, { x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2) });
    let top: NodeId | null = null;
    this.commit(tr('Вставить большое изображение'), (tx) => {
      const holder = tiles.length > 1 ? tx.create('GROUP', parent, { name }) : parent;
      for (const tile of tiles) {
        const id = tx.create('RECTANGLE', holder, {
          name: tiles.length > 1 ? tile.name : name,
          x: round2(origin.x + tile.x),
          y: round2(origin.y + tile.y),
          width: tile.width,
          height: tile.height,
          fills: [{ type: 'IMAGE', imageHash: tx.addBlob(tile.bytes, tile.mime), scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }],
        });
        if (tiles.length === 1) top = id;
      }
      if (tiles.length > 1) top = holder;
    }, () => (top ? [top] : []));
    if (top) {
      this.zoomToSelection();
      this.appear([top]);
    }
    return top;
  }

  // ---------- vectors (stage "Vectors") ----------

  /**
   * Point editing of a vector: the edited layer, the selected points (vertex
   * indices of its network) and the tool: edit points, pen (draw more, from
   * any point), paint bucket (fill or empty an area), scissors (cut).
   */
  vectorEdit: { id: NodeId; selected: string[]; tool: VectorTool } | null = null;

  /** Enters point editing (Enter / double click). Built-in shapes become vectors first, as in Figma. */
  enterVectorEdit(id: NodeId, tool: VectorTool = 'edit'): void {
    const type = this.doc.type(id);
    if (!SHAPE_TYPES.includes(type) || type === 'BOOLEAN_OPERATION' || !this.canTransform(id)) return;
    let target = id;
    if (type !== 'VECTOR') {
      this.setSelection([id]);
      this.flattenSelection();
      target = this.selection[0]!;
      if (!target || this.doc.type(target) !== 'VECTOR') return;
    }
    this.setSelection([target]);
    // Points are edited as a network: contours become one (nothing changes on the canvas).
    if (!this.doc.get(target, 'vectorNetwork')) {
      const d = this.doc;
      this.commit(tr('Редактировать точки'), (tx) => {
        tx.set(target, 'vectorNetwork', networkFromPaths(d.get(target, 'vectorPaths'), d.get(target, 'windingRule')));
        tx.set(target, 'vectorPaths', []);
      });
    }
    this.vectorEdit = { id: target, selected: [], tool };
    this.events.emit('vectorEdit', this.vectorEdit);
    this.requestOverlay();
  }

  /** The width point chosen with the width tool (its index in `widthPoints`); null — none. */
  widthSelection: number | null = null;

  setWidthSelection(index: number | null): void {
    this.widthSelection = index;
    if (this.vectorEdit) this.events.emit('vectorEdit', this.vectorEdit);
    this.requestOverlay();
  }

  removeWidthPoint(id: NodeId, index: number): void {
    const points = this.doc.get(id, 'widthPoints').filter((_, i) => i !== index);
    this.commit(tr('Убрать точку ширины'), (tx) => {
      tx.set(id, 'widthPoints', points);
      if (points.length === 0) tx.set(id, 'strokeProfile', 'UNIFORM');
    });
    this.setWidthSelection(null);
  }

  /** The eraser's weight in point editing, px (as Figma's, set in the right panel). */
  eraserWeight = 10;

  setEraserWeight(weight: number): void {
    this.eraserWeight = Math.max(1, Math.min(500, weight));
    if (this.vectorEdit) this.events.emit('vectorEdit', this.vectorEdit);
    this.requestOverlay();
  }

  /** The tool inside point editing (V edit, P pen, B paint bucket, scissors, Shift+E eraser). */
  setVectorTool(tool: VectorTool): void {
    if (!this.vectorEdit) return;
    if (tool !== 'width') this.widthSelection = null;
    this.vectorEdit = { ...this.vectorEdit, tool };
    this.events.emit('vectorEdit', this.vectorEdit);
    this.requestOverlay();
  }

  /** The network of a vector being edited (null when it has none). */
  networkOf(id: NodeId): VectorNetwork | null {
    return this.doc.store.isAlive(id) && this.doc.type(id) === 'VECTOR' ? this.doc.get(id, 'vectorNetwork') : null;
  }

  exitVectorEdit(): void {
    if (!this.vectorEdit) return;
    this.vectorEdit = null;
    this.events.emit('vectorEdit', null);
    this.requestOverlay();
  }

  setVectorSelection(keys: string[]): void {
    if (!this.vectorEdit) return;
    this.vectorEdit = { ...this.vectorEdit, selected: [...new Set(keys)] };
    this.events.emit('vectorEdit', this.vectorEdit);
    this.requestOverlay();
  }

  /**
   * Deletes the selected points: a point between two segments joins its
   * neighbours (a closed shape stays closed); ends and junctions take their
   * segments. A vector left without segments goes.
   */
  deleteVectorPoints(): void {
    const edit = this.vectorEdit;
    const net = edit && this.networkOf(edit.id);
    if (!edit || !net || edit.selected.length === 0) return;
    const id = edit.id;
    const next = deleteVertices(net, new Set(edit.selected.map(Number)));
    const empty = next.segments.length === 0;
    this.commit(tr('Удалить точки'), (tx) => {
      if (empty) tx.delete(id);
      else {
        tx.set(id, 'vectorNetwork', next);
        normalizeVector(this.doc, tx, id);
      }
    });
    if (empty) {
      this.exitVectorEdit();
      this.setSelection([]);
    } else this.setVectorSelection([]);
  }

  /**
   * Simplify path: the same look with fewer points (curves refitted within
   * half a pixel at the current zoom; ends, junctions and corners stay).
   */
  simplifySelection(): void {
    const ids = this.transformable(this.topLevelSelection(), tr('Упростить контур')).filter((id) => this.doc.type(id) === 'VECTOR');
    if (ids.length === 0) {
      this.toast(tr('Выделите вектор (фигуры сначала можно слить в вектор: Mod+E)'));
      return;
    }
    const tolerance = Math.max(0.05, 0.5 / this.viewport.zoom);
    let before = 0;
    let after = 0;
    this.commit(tr('Упростить контур'), (tx) => {
      for (const id of ids) {
        const d = this.doc;
        const net = d.get(id, 'vectorNetwork') ?? networkFromPaths(d.get(id, 'vectorPaths'), d.get(id, 'windingRule'));
        const simple = simplifyNetwork(net, tolerance);
        before += net.vertices.length;
        after += simple.vertices.length;
        tx.set(id, 'vectorNetwork', simple);
        tx.set(id, 'vectorPaths', []);
        normalizeVector(d, tx, id);
      }
    });
    this.exitVectorEdit();
    this.toast(after < before ? tr('Точек было {0}, стало {1}', before, after) : tr('Проще уже некуда: точек {0}', after));
  }

  /**
   * Offset path: the outline moved out (positive) or in (negative) by a
   * distance, with rounded corners; the shape becomes a vector.
   */
  offsetSelection(distance: number): void {
    const ids = this.transformable(this.topLevelSelection(), tr('Сместить контур')).filter((id) => SHAPE_TYPES.includes(this.doc.type(id)));
    if (ids.length === 0 || distance === 0) {
      if (ids.length === 0) this.toast(tr('Выделите фигуру или вектор'));
      return;
    }
    const created: NodeId[] = [];
    this.commit(tr('Сместить контур'), (tx) => {
      for (const id of ids) {
        const d = this.doc;
        const local = nodePaths(d, id);
        const rule = d.type(id) === 'VECTOR' && (vectorDrawing(d, id)?.evenOdd ?? d.get(id, 'windingRule') === 'EVENODD') ? 'EVENODD' : 'NONZERO';
        const closed = local.filter((p) => p.closed);
        if (closed.length === 0) continue;
        const shape = regionOf(closed, rule);
        const band = strokeRegion(closed, Math.abs(distance) * 2, 'CENTER');
        const result = distance > 0 ? booleanRegions('UNION', shape, band) : booleanRegions('SUBTRACT', shape, band);
        const m = nodeTransform(d.get(id, 'x'), d.get(id, 'y'), d.get(id, 'rotation'));
        const paths = transformPaths(result.contours.map((c) => ({ closed: true, points: c.map((p) => ({ x: p.x, y: p.y })) })), m);
        if (paths.length === 0) continue;
        const v = tx.create('VECTOR', d.parent(id)!, {
          name: d.get(id, 'name'),
          fills: structuredClone(d.get(id, 'fills')),
          strokes: structuredClone(d.get(id, 'strokes')),
          strokeWeight: d.get(id, 'strokeWeight'),
          strokeAlign: d.get(id, 'strokeAlign'),
          effects: structuredClone(d.get(id, 'effects')),
          opacity: d.get(id, 'opacity'),
          vectorPaths: paths,
        }, { after: id });
        normalizeVector(d, tx, v);
        tx.delete(id);
        created.push(v);
      }
    }, () => created);
  }

  /** Combines the selected shapes with a live boolean operation (they stay editable inside it). */
  booleanSelection(op: BooleanOp): void {
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Булева операция')));
    const shapes = ids.filter((id) => SHAPE_TYPES.includes(this.doc.type(id)) || this.doc.type(id) === 'GROUP');
    if (shapes.length < 2 && !(shapes.length === 1 && this.doc.type(shapes[0]!) === 'BOOLEAN_OPERATION')) {
      this.toast(tr('Выделите две фигуры или больше (текст и фреймы в булевых операциях не участвуют)'));
      return;
    }
    // A selected boolean operation just changes its operation.
    if (shapes.length === 1) {
      this.commit(tr('Булева операция'), (tx) => tx.update(shapes[0]!, { booleanOp: op, name: BOOLEAN_NAMES[op] }));
      return;
    }
    // Shapes from different frames are combined in each of them (Multi-edit, as in Figma).
    const sets = this.byParent(shapes).filter((set) => set.length > 1 && canContain(this.doc.type(this.doc.parent(set[0]!)!), 'BOOLEAN_OPERATION'));
    if (sets.length === 0) {
      this.toast(tr('Фигуры должны лежать в одном родителе'));
      return;
    }
    const results: NodeId[] = [];
    this.commit(BOOLEAN_NAMES[op], (tx) => {
      for (const set of sets) {
        const first = set[0]!;
        // The result takes the look of the bottom shape, as in Figma.
        const result = tx.create('BOOLEAN_OPERATION', this.doc.parent(first)!, {
          name: BOOLEAN_NAMES[op],
          booleanOp: op,
          fills: structuredClone(this.doc.get(first, 'fills')),
          strokes: structuredClone(this.doc.get(first, 'strokes')),
          strokeWeight: this.doc.get(first, 'strokeWeight'),
          effects: structuredClone(this.doc.get(first, 'effects')),
        }, { after: set[set.length - 1]! });
        for (const id of set) this.reparentKeepingPosition(tx, id, result);
        results.push(result);
      }
    }, () => results);
  }

  /** Outline of a node as paths in its parent's space. */
  private parentSpacePaths(id: NodeId, own = nodePaths(this.doc, id)): VectorPath[] {
    const d = this.doc;
    return transformPaths(own, nodeTransform(d.get(id, 'x'), d.get(id, 'y'), d.get(id, 'rotation')));
  }

  /**
   * Replaces the selected shapes with one vector (FR: Flatten, Mod+E). Booleans become their result;
   * texts become their letters (as in Figma) once their font files are read — `letters` holds them then.
   */
  flattenSelection(letters?: ReadonlyMap<NodeId, VectorPath[]>): void {
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Сплющивание')));
    const texts = ids.filter((id) => this.doc.type(id) === 'TEXT');
    if (texts.length > 0 && !letters) {
      void this.flattenWithText(texts);
      return;
    }
    const shapes = ids.filter((id) => SHAPE_TYPES.includes(this.doc.type(id)) || this.doc.type(id) === 'GROUP' || letters?.has(id));
    if (shapes.length === 0) {
      this.toast(tr('Выделите фигуры, вектор или булеву операцию'));
      return;
    }
    const parent = this.doc.parent(shapes[0]!)!;
    if (shapes.some((id) => this.doc.parent(id) !== parent)) {
      this.toast(tr('Фигуры должны лежать в одном родителе'));
      return;
    }
    let result = '';
    this.commit(tr('Слить в одну фигуру'), (tx) => {
      const first = shapes[0]!;
      // A rounded polygon or star alone keeps its corners as points with the radius (as in Figma), not as arcs.
      const d = this.doc;
      const keepRadius = shapes.length === 1 && (d.type(first) === 'POLYGON' || d.type(first) === 'STAR') ? d.get(first, 'cornerRadius') : 0;
      const paths =
        keepRadius > 0
          ? transformPaths(
              shapePaths(d.type(first), { width: d.get(first, 'width'), height: d.get(first, 'height'), pointCount: d.get(first, 'pointCount'), innerRadius: d.get(first, 'innerRadius') }),
              nodeTransform(d.get(first, 'x'), d.get(first, 'y'), d.get(first, 'rotation')),
            )
          : shapes.flatMap((id) => this.parentSpacePaths(id, letters?.get(id)));
      const evenodd = shapes.length === 1 && this.doc.type(first) === 'VECTOR' && this.doc.get(first, 'windingRule') === 'EVENODD';
      const open = paths.every((p) => !p.closed);
      result = tx.create('VECTOR', parent, {
        name: shapes.length === 1 ? this.doc.get(first, 'name') : 'Vector',
        fills: open ? [] : structuredClone(this.doc.get(first, 'fills')),
        strokes: structuredClone(this.doc.get(first, 'strokes')),
        strokeWeight: this.doc.get(first, 'strokeWeight'),
        strokeAlign: open ? 'CENTER' : this.doc.get(first, 'strokeAlign'),
        effects: structuredClone(this.doc.get(first, 'effects')),
        opacity: this.doc.get(first, 'opacity'),
        windingRule: evenodd ? 'EVENODD' : 'NONZERO',
        cornerRadius: keepRadius,
        vectorPaths: paths,
      }, { after: shapes[shapes.length - 1]! });
      normalizeVector(this.doc, tx, result);
      for (const id of shapes) tx.delete(id);
    }, () => [result]);
  }

  /**
   * Repeat (Figma Draw's repeat transforms): the selection goes into a repeat group that
   * shows it `count` times in a row or round a circle; editing the layers changes every copy.
   */
  addRepeat(kind: 'LINEAR' | 'RADIAL'): void {
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Повтор')));
    if (ids.length === 0) {
      this.toast(tr('Выделите слои, которые нужно повторить'));
      return;
    }
    const parent = this.doc.parent(ids[0]!)!;
    if (ids.some((id) => this.doc.parent(id) !== parent)) {
      this.toast(tr('Слои должны лежать в одном родителе'));
      return;
    }
    // One layer that is a repeat group already: change its kind.
    const only = ids.length === 1 && this.doc.get(ids[0]!, 'repeat') ? ids[0]! : null;
    const height = Math.max(...ids.map((id) => this.doc.get(id, 'height')));
    const settings = { kind, count: kind === 'LINEAR' ? 3 : 6, gap: 10, direction: 'HORIZONTAL' as const, radius: Math.round(Math.max(40, height * 1.5)) };
    let group = '';
    this.commit(tr('Повтор'), (tx) => {
      if (only) {
        group = only;
        tx.set(only, 'repeat', { ...this.doc.get(only, 'repeat')!, kind });
        return;
      }
      group = tx.create('GROUP', parent, { name: kind === 'LINEAR' ? tr('Повтор') : tr('Повтор по кругу'), repeat: settings }, { after: ids[ids.length - 1]! });
      for (const id of ids) this.reparentKeepingPosition(tx, id, group);
    }, () => [group]);
  }

  /** Leaves the copies as ordinary layers and the group as a plain group (Figma: flatten a transform). */
  removeRepeat(keepCopies: boolean): void {
    const groups = this.selection.filter((id) => this.doc.type(id) === 'GROUP' && this.doc.get(id, 'repeat'));
    if (groups.length === 0) return;
    this.commit(keepCopies ? tr('Повтор в слои') : tr('Убрать повтор'), (tx) => {
      for (const g of groups) {
        for (const c of this.doc.children(g)) if (this.doc.get(c, 'repeatCopy')) (keepCopies ? tx.set(c, 'repeatCopy', false) : tx.delete(c));
        tx.set(g, 'repeat', null);
      }
    }, () => groups);
  }

  /**
   * A brush from the selected layer's shape (Figma Draw: Create brush): stretched along a
   * stroke or scattered along it. It goes to this file's brush menu.
   */
  createBrush(kind: 'STRETCH' | 'SCATTER'): void {
    const only = this.selection.length === 1 ? this.selection[0]! : null;
    const paths = only ? nodePaths(this.doc, only) : [];
    const brush = only ? brushFromPaths(paths, kind, this.doc.get(only, 'name'), `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`) : null;
    if (!brush) {
      this.toast(tr('Кисть делается из одного слоя с замкнутым контуром: фигуры, вектора или текста в кривых'));
      return;
    }
    this.commit(tr('Создать кисть'), (tx) => tx.set(this.doc.rootId, 'brushes', [...this.doc.get(this.doc.rootId, 'brushes'), brush]));
    this.toast(tr('Кисть «{0}» добавлена в список кистей обводки', brush.name));
  }

  /** Scales the selection by `k` (the scale tool's field): each layer from its top-left corner, everything inside with it. */
  scaleSelection(k: number): void {
    const ids = this.transformable(this.topLevelSelection(), tr('Масштаб'));
    if (ids.length === 0 || !(k > 0) || k === 1) return;
    this.commit(tr('Масштаб'), (tx) => {
      for (const id of ids) scaleNode(this.doc, tx, id, k);
    });
  }

  /** Reads the fonts of the texts to flatten, then flattens; a text whose font is not in the file stays as it is. */
  private async flattenWithText(texts: readonly NodeId[]): Promise<void> {
    const notes = new Set<string>();
    const letters = new Map<NodeId, VectorPath[]>();
    for (const id of texts) {
      const fileOf = await outlineFonts(this.doc, id, notes);
      if (!this.doc.store.isAlive(id)) continue;
      const paths = textOutlinePaths(this.doc, this.measurer, id, fileOf);
      if (paths) letters.set(id, paths);
    }
    if (letters.size < texts.length) this.toast([...notes][0] ?? tr('Не у всех букв есть контур в шрифте: такой текст оставлен текстом'));
    if (letters.size === 0 && this.topLevelSelection().every((id) => this.doc.type(id) === 'TEXT')) return;
    this.flattenSelection(letters);
  }

  /** Turns strokes into filled shapes (Outline stroke, Mod+Alt+O). */
  outlineStroke(): void {
    const ids = this.transformable(this.topLevelSelection(), tr('Обводка в контур')).filter((id) => SHAPE_TYPES.includes(this.doc.type(id)));
    const withStroke = ids.filter((id) => this.doc.get(id, 'strokes').some((p) => p.visible) && this.doc.get(id, 'strokeWeight') > 0);
    if (withStroke.length === 0) {
      this.toast(tr('Выделите фигуру с обводкой'));
      return;
    }
    const created: NodeId[] = [];
    this.commit(tr('Обводка в контур'), (tx) => {
      for (const id of withStroke) {
        const d = this.doc;
        const local = nodePaths(d, id);
        const weight = d.get(id, 'strokeWeight');
        const align = d.type(id) === 'LINE' || local.every((p) => !p.closed) ? 'CENTER' : d.get(id, 'strokeAlign');
        const region = strokeRegion(local, weight, align);
        const m = nodeTransform(d.get(id, 'x'), d.get(id, 'y'), d.get(id, 'rotation'));
        const paths = transformPaths(region.contours.map((c) => ({ closed: true, points: c.map((p) => ({ x: p.x, y: p.y })) })), m);
        if (paths.length === 0) continue;
        const v = tx.create('VECTOR', d.parent(id)!, {
          name: tr('{0} (контур)', d.get(id, 'name')),
          fills: structuredClone(d.get(id, 'strokes')),
          strokes: [],
          vectorPaths: paths,
        }, { after: id });
        normalizeVector(d, tx, v);
        created.push(v);
        // The original keeps its fill; without a fill it is replaced entirely.
        if (d.get(id, 'fills').some((f) => f.visible) && d.type(id) !== 'LINE') tx.set(id, 'strokes', []);
        else tx.delete(id);
      }
    }, () => created);
  }

  /** Use as mask (Mod+Alt+M): groups the selection; the bottom layer masks the rest. */
  useAsMask(): void {
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Маска')));
    if (ids.length === 0) return;
    if (ids.length === 1) {
      this.setMask(!this.doc.get(ids[0]!, 'isMask'));
      return;
    }
    // Layers from different frames make a mask group in each of them (Multi-edit, as in Figma);
    // a single layer in its frame becomes a mask of what lies above it there.
    const sets = this.byParent(ids);
    if (sets.length > 1 && sets.some((set) => set.length === 1)) {
      this.toast(tr('Выделите в каждом фрейме маску и слои над ней'));
      return;
    }
    const groups: NodeId[] = [];
    this.commit(tr('Использовать как маску'), (tx) => {
      for (const set of sets) {
        const group = tx.create('GROUP', this.doc.parent(set[0]!)!, { name: tr('Группа с маской') }, { after: set[set.length - 1]! });
        for (const id of set) this.reparentKeepingPosition(tx, id, group);
        tx.set(set[0]!, 'isMask', true);
        groups.push(group);
      }
    }, () => groups);
  }

  /**
   * Turns the selected layer into a mask (or back). Like Figma, the mask and the
   * layers above it that it overlaps are wrapped into a "Mask group", so the mask
   * only crops what it covers and nothing else silently disappears (BUG-026).
   */
  setMask(on: boolean): void {
    const ids = this.sortedByPaintOrder(this.transformable(this.topLevelSelection(), tr('Маска')));
    if (ids.length === 0) return;
    if (!on) {
      this.commit(tr('Убрать маску'), (tx) => {
        for (const id of ids) tx.set(id, 'isMask', false);
      });
      return;
    }
    if (ids.length > 1) {
      this.useAsMask();
      return;
    }
    const mask = ids[0]!;
    const parent = this.doc.parent(mask)!;
    const siblings = this.doc.children(parent);
    const box = this.scene.bounds(mask);
    const overlaps = (r: Rect) => r.x < box.x + box.width && r.x + r.width > box.x && r.y < box.y + box.height && r.y + r.height > box.y;
    // Layers above the mask up to the next mask, keeping only those it overlaps.
    const above: NodeId[] = [];
    for (const id of siblings.slice(siblings.indexOf(mask) + 1)) {
      if (this.doc.get(id, 'isMask')) break;
      if (this.doc.get(id, 'visible') && overlaps(this.scene.bounds(id))) above.push(id);
    }
    if (above.length === 0) {
      this.toast(tr('Маска обрезает слои, лежащие над ней. Положите поверх фигуры картинку или другие слои — или выделите маску вместе с ними и нажмите ⌘⌥M'), 'error');
      return;
    }
    let group = '';
    this.commit(tr('Использовать как маску'), (tx) => {
      group = tx.create('GROUP', parent, { name: tr('Группа с маской') }, { after: above[above.length - 1]! });
      for (const id of [mask, ...above]) this.reparentKeepingPosition(tx, id, group);
      tx.set(mask, 'isMask', true);
    }, () => [group]);
    this.toast(tr('Маска обрезает {0} {1} над собой — они собраны в «Группу с маской»', above.length, above.length === 1 ? tr('слой') : tr('слоя(ёв)')));
  }

  // ---------- styles (section 11, FR-STY) ----------

  /** Selected layers a binding applies to (text styles: text layers only). */
  styleTargets(binding: StyleBinding): NodeId[] {
    const spec = bindingSpec(binding);
    return this.selection.filter((id) => this.doc.store.isAlive(id) && spec.accepts(this.doc.type(id)));
  }

  /** Styles of a type in document order. */
  stylesOf(type: StyleType): NodeId[] {
    return this.doc.styles().filter((id) => this.doc.get(id, 'styleType') === type);
  }

  private uniqueStyleName(base: string): string {
    const names = new Set(this.doc.styles().map((id) => this.doc.get(id, 'name')));
    for (let i = 1; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  /**
   * Creates a style from the selection's values (or defaults) and, when
   * `binding` is given, binds the selected layers to it — "Create style" in the
   * fill, stroke, effect and text sections.
   */
  createStyle(type: StyleType, binding?: StyleBinding, name?: string): NodeId {
    const d = this.doc;
    const source = binding ? this.styleTargets(binding)[0] : this.selection[0];
    const props: Partial<NodeProps> = { styleType: type };
    if (type === 'FILL') props.fills = source ? d.get(source, binding === 'strokeStyleId' ? 'strokes' : 'fills') : [{ type: 'SOLID', color: { r: 0.05, g: 0.6, b: 1, a: 1 }, opacity: 1, visible: true }];
    if (type === 'EFFECT') props.effects = source ? d.get(source, 'effects') : [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true }];
    if (type === 'TEXT') {
      const text = source && d.type(source) === 'TEXT' ? source : null;
      for (const k of TEXT_STYLE_KEYS) (props as Record<string, unknown>)[k] = text ? d.get(text, k) : d.get(d.rootId, k);
    }
    if (type === 'GRID') props.layoutGrids = source && d.get(source, 'layoutGrids').length > 0 ? d.get(source, 'layoutGrids') : [defaultGrid('COLUMNS')];
    props.name = name?.trim() || this.uniqueStyleName(type === 'FILL' ? tr('Цвет') : type === 'TEXT' ? tr('Текст') : type === 'GRID' ? tr('Сетка') : tr('Эффект'));
    let style = '';
    this.commit(tr('Создать стиль'), (tx) => {
      style = tx.create('STYLE', d.rootId, props);
      if (binding) for (const id of this.styleTargets(binding)) tx.set(id, binding, style);
    });
    return style;
  }

  /** Binds the selected layers to a style (null detaches, keeping the values). */
  applyStyle(binding: StyleBinding, style: NodeId | null): void {
    const targets = this.styleTargets(binding).filter((id) => style === null || canBind(this.doc, id, binding, style));
    if (targets.length === 0) return;
    this.commit(style ? tr('Применить стиль') : tr('Отвязать от стиля'), (tx) => {
      for (const id of targets) tx.set(id, binding, style);
    });
  }

  detachStyle(binding: StyleBinding): void {
    this.applyStyle(binding, null);
  }

  /** The style the whole selection shares for a binding: id, null (none) or 'mixed'. */
  selectionStyle(binding: StyleBinding): NodeId | null | 'mixed' {
    const targets = this.styleTargets(binding);
    if (targets.length === 0) return null;
    const first = this.doc.get(targets[0]!, binding);
    return targets.every((id) => this.doc.get(id, binding) === first) ? first : 'mixed';
  }

  /** Changes a style's values or name; bound layers follow in the same step. */
  updateStyle(style: NodeId, props: Partial<NodeProps>, label = tr('Изменить стиль')): void {
    if (this.doc.type(style) !== 'STYLE') return;
    this.commit(label, (tx) => tx.update(style, props));
  }

  renameStyle(style: NodeId, name: string): void {
    const v = name.trim();
    if (v) this.updateStyle(style, { name: v }, tr('Переименовать стиль'));
  }

  duplicateStyle(style: NodeId): NodeId {
    const d = this.doc;
    const props: Partial<NodeProps> = { styleType: d.get(style, 'styleType'), description: d.get(style, 'description'), name: tr('{0} (копия)', d.get(style, 'name')) };
    for (const k of styleValueKeys(d.get(style, 'styleType'))) (props as Record<string, unknown>)[k] = d.get(style, k);
    let copy = '';
    this.commit(tr('Дублировать стиль'), (tx) => (copy = tx.create('STYLE', d.rootId, props, { after: style })));
    return copy;
  }

  /** Deletes a style; its layers keep their values and lose the link (undo restores both). */
  deleteStyle(style: NodeId): void {
    if (this.doc.type(style) !== 'STYLE') return;
    const users = styleUsers(this.doc, style).length;
    this.commit(tr('Удалить стиль'), (tx) => tx.delete(style));
    if (users > 0) this.toast(tr('Стиль удалён; {0} слоёв сохранили его значения', users));
  }

  /** Moves a style in the list (and into another folder by renaming, done separately). */
  moveStyle(style: NodeId, position: Position): void {
    this.commit(tr('Переместить стиль'), (tx) => tx.move(style, this.doc.rootId, position));
  }

  /** Every layer of the file that uses a style (FR-STY-004). */
  styleUsers(style: NodeId): NodeId[] {
    return [...new Set(styleUsers(this.doc, style).map((u) => u.id))];
  }

  /** Replaces a style with another one in the whole file (FR-STY-004). Returns the number of layers changed. */
  replaceStyle(from: NodeId, to: NodeId): number {
    const d = this.doc;
    if (d.get(from, 'styleType') !== d.get(to, 'styleType') || from === to) return 0;
    const users = styleUsers(d, from).filter((u) => canBind(d, u.id, u.binding, to));
    if (users.length === 0) return 0;
    this.commit(tr('Заменить стиль'), (tx) => {
      for (const u of users) tx.set(u.id, u.binding, to);
    });
    return users.length;
  }

  /** Selects the layers using a style: on this page, or on the first page that has any (FR-STY-004). */
  selectStyleUsers(style: NodeId): number {
    const users = this.styleUsers(style);
    if (users.length === 0) {
      this.toast(tr('Этот стиль пока нигде не используется'));
      return 0;
    }
    const here = users.filter((id) => this.doc.pageOf(id) === this.pageId);
    const page = here.length > 0 ? this.pageId : this.doc.pageOf(users[0]!)!;
    const switched = page !== this.pageId;
    if (switched) this.setPage(page);
    const onPage = users.filter((id) => this.doc.pageOf(id) === page);
    this.setSelection(onPage);
    if (switched) this.zoomToSelection();
    if (onPage.length < users.length) this.toast(tr('Выделено {0} из {1}: остальные на других страницах', onPage.length, users.length));
    return onPage.length;
  }

  /** Places an instance of `component` at a world point (or next to the component). */
  placeInstance(component: NodeId, at?: Point): NodeId | null {
    if (this.doc.type(component) !== 'COMPONENT') return null;
    const point = at ?? (() => {
      const b = this.scene.bounds(component);
      return { x: b.x + b.width + 40, y: b.y };
    })();
    const parent = this.containerAt(point);
    if (wouldCreateCycle(this.doc, component, parent)) {
      this.toast(tr('Компонент не может содержать свою же копию'));
      return null;
    }
    let id: NodeId = '';
    this.commit(tr('Поставить копию компонента'), (tx) => {
      const local = this.toParentSpace(parent, point);
      id = createInstance(this.doc, tx, component, parent, { x: round2(local.x), y: round2(local.y) });
    }, () => [id]);
    return id;
  }

  /** Command: an instance of the selected component, placed to its right. */
  createInstanceOfSelection(): void {
    const id = this.selection[0];
    if (!id || this.doc.type(id) !== 'COMPONENT') {
      this.toast(tr('Выделите компонент'));
      return;
    }
    if (this.doc.pageOf(id) !== this.pageId) return;
    this.placeInstance(id);
  }

  /** Mod+Alt+B (FR-CMP-041). */
  detachSelection(): void {
    const ids = this.topLevelSelection().filter((id) => isTopLevelInstance(this.doc, id));
    if (ids.length === 0) {
      this.toast(tr('Выделите копию компонента. Вложенная копия отвязывается вместе с внешней.'));
      return;
    }
    const frames: NodeId[] = [];
    this.commit(tr('Отвязать от компонента'), (tx) => {
      for (const id of ids) frames.push(detachInstance(this.doc, tx, id));
    }, () => frames);
  }

  /** Selects the main component of the selected instance, switching page if needed (FR-CMP-004). */
  goToMainComponent(): void {
    const id = this.selection[0];
    const main = id ? (this.doc.type(id) === 'INSTANCE' ? this.doc.get(id, 'mainComponent') : mainComponentOf(this.doc, id)) : null;
    if (!main || !this.doc.store.isAlive(main)) {
      this.toast(main ? tr('Главный компонент удалён') : tr('Выделите копию компонента'));
      return;
    }
    // A component taken from a library is changed in the library's file, not here.
    const library = libraryOf(this.doc, main);
    if (library) {
      globalThis.open?.(`/?file=${encodeURIComponent(library.fileId)}&node=${encodeURIComponent(main)}`, '_blank', 'noopener');
      this.toast(tr('Компонент из библиотеки «{0}»: его меняют в файле библиотеки — он открыт в новой вкладке', library.name));
      return;
    }
    const page = this.doc.pageOf(main);
    if (page && page !== this.pageId) this.setPage(page);
    this.setSelection([main]);
    this.zoomToSelection();
  }

  /** Resets overrides of the selected instances or instance layers (FR-CMP-035). */
  resetSelectedOverrides(keys?: readonly string[]): void {
    const ids = this.topLevelSelection().filter((id) => this.doc.type(id) === 'INSTANCE' || this.isInstanceLayer(id));
    if (ids.length === 0) return;
    this.commit(tr('Сбросить изменения копии'), (tx) => {
      for (const id of ids) {
        if (keys) resetOverrides(this.doc, tx, id, keys);
        else if (this.doc.type(id) === 'INSTANCE') resetInstance(this.doc, tx, id);
        else resetOverrides(this.doc, tx, id);
      }
    });
  }

  /** Combines selected components into a component set (FR-CMP-020). */
  combineAsVariants(): void {
    const ids = this.topLevelSelection();
    if (ids.length === 0 || ids.some((id) => this.doc.type(id) !== 'COMPONENT' || componentSetOf(this.doc, id))) {
      this.toast(tr('Выделите компоненты вне набора вариантов'));
      return;
    }
    const parent = this.doc.parent(ids[0]!);
    if (ids.some((id) => this.doc.parent(id) !== parent)) {
      this.toast(tr('Компоненты должны лежать в одном фрейме'));
      return;
    }
    let set = '';
    this.commit(tr('Объединить компоненты в набор вариантов'), (tx) => {
      set = combineAsVariants(this.doc, tx, ids);
    }, () => [set]);
  }

  /** Adds a variant next to the selected one (or the first one of a selected set). */
  addVariant(): void {
    const id = this.selection[0];
    if (!id) return;
    const variant = this.doc.type(id) === 'COMPONENT_SET' ? this.doc.children(id)[this.doc.children(id).length - 1] : id;
    if (!variant || !componentSetOf(this.doc, variant)) {
      this.toast(tr('Выделите набор вариантов или один из вариантов'));
      return;
    }
    let created = '';
    this.commit(tr('Добавить вариант'), (tx) => {
      created = addVariant(this.doc, tx, variant, (t, source) => pasteSubtree(t, copySubtree(this.doc, source), this.doc.parent(source)!, { after: source }, this.doc));
    }, () => [created]);
  }

  /** Switches an instance to another variant of its set, keeping overrides (FR-CMP-031). */
  switchVariant(instance: NodeId, axis: string, value: string): void {
    const main = this.doc.get(instance, 'mainComponent');
    const set = main ? componentSetOf(this.doc, main) : null;
    if (!main || !set) return;
    const target = findVariant(this.doc, set, main, axis, value);
    if (!target || target === main) return;
    this.commit(tr('Сменить вариант'), (tx) => tx.set(instance, 'mainComponent', target));
  }

  /** Replaces the component an instance shows (FR-CMP-040). */
  swapInstance(instance: NodeId, component: NodeId): void {
    if (this.doc.type(component) !== 'COMPONENT') return;
    const parent = this.doc.parent(instance);
    if (parent && wouldCreateCycle(this.doc, component, parent)) {
      this.toast(tr('Компонент не может содержать свою же копию'));
      return;
    }
    this.commit(tr('Заменить компонент в копии'), (tx) => tx.set(instance, 'mainComponent', component));
  }

  setInstanceProperty(instance: NodeId, propId: string, value: string | boolean): void {
    this.commit(tr('Свойство копии'), (tx) => setInstanceProperty(this.doc, tx, instance, propId, value));
  }

  /** Exposes the selected layer of a component as a component property (FR-CMP-010). */
  addComponentProperty(layer: NodeId, type: ComponentPropType): void {
    try {
      this.commit(tr('Добавить свойство'), (tx) => addPropertyFromLayer(this.doc, tx, layer, type));
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  renameComponentProperty(owner: NodeId, propId: string, name: string): void {
    this.commit(tr('Переименовать свойство'), (tx) => renameProperty(this.doc, tx, owner, propId, name));
  }

  removeComponentProperty(owner: NodeId, propId: string): void {
    this.commit(tr('Удалить свойство'), (tx) => removeProperty(this.doc, tx, owner, propId));
  }

  unbindComponentProperty(layer: NodeId, binding: 'characters' | 'visible' | 'mainComponent'): void {
    this.commit(tr('Отвязать свойство'), (tx) => unbindLayer(this.doc, tx, layer, binding));
  }

  setVariantValue(variant: NodeId, axis: string, value: string): void {
    this.commit(tr('Значение варианта'), (tx) => setVariantValue(this.doc, tx, variant, axis, value));
  }

  renameVariantAxis(set: NodeId, from: string, to: string): void {
    if (!to.trim() || from === to) return;
    this.commit(tr('Переименовать свойство варианта'), (tx) => renameAxis(this.doc, tx, set, from, to.trim()));
  }

  addVariantAxis(set: NodeId): void {
    let n = 2;
    const names = new Set(this.doc.children(set).flatMap((c) => this.doc.get(c, 'name').split(',').map((p) => p.split('=')[0]!.trim())));
    while (names.has(tr('Свойство {0}', n))) n++;
    this.commit(tr('Добавить свойство варианта'), (tx) => addAxis(this.doc, tx, set, tr('Свойство {0}', n), tr('По умолчанию')));
  }

  // ---------- viewport ----------

  zoomTo(zoom: number, anchor?: Point): void {
    const center = anchor ?? { x: this.screenSize.width / 2, y: this.screenSize.height / 2 };
    this.viewport.zoomAt(center, zoom);
    this.requestViewport();
  }

  zoomStep(direction: 1 | -1): void {
    this.zoomTo(this.viewport.stepZoom(direction));
  }

  zoomToFit(): void {
    const bounds = this.scene.contentBounds();
    if (!bounds) return this.glideTo({ zoom: 1, offsetX: this.screenSize.width / 2, offsetY: this.screenSize.height / 2 });
    this.glideTo(this.fitted(bounds, 64, 1));
  }

  zoomToSelection(): void {
    const bounds = this.selectionBounds();
    if (!bounds) return this.zoomToFit();
    this.glideTo(this.fitted(bounds, 80, 8));
  }

  /** Shows a rectangle of the world whole (a slide, all slides), with `padding` screen pixels around. */
  zoomToBounds(bounds: Rect, padding = 48): void {
    this.glideTo(this.fitted(bounds, padding, 8));
  }

  /** The view that would show `bounds` (the current one is not changed). */
  private fitted(bounds: Rect, padding: number, maxZoom: number): { zoom: number; offsetX: number; offsetY: number } {
    const now = this.viewport.toJSON();
    this.viewport.fit(bounds, this.screenSize.width, this.screenSize.height, padding, maxZoom);
    const target = this.viewport.toJSON();
    this.viewport.restore(now);
    return target;
  }

  /** Whether the interface moves: the setting is on and the system does not ask for less motion. */
  motionOn(): boolean {
    if (!this.view.motion || typeof requestAnimationFrame !== 'function' || typeof matchMedia !== 'function') return false;
    return !matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /** The running glide of the view; a newer one (or the user moving the view) stops it. */
  private glide = 0;

  /**
   * Takes the view to `target` (FEAT-150): smoothly, in a quarter of a second — the
   * point in the middle of the screen travels straight, the zoom changes evenly in
   * its logarithm, easing out. At once without motion.
   */
  private glideTo(target: { zoom: number; offsetX: number; offsetY: number }): void {
    const token = ++this.glide;
    const from = this.viewport.toJSON();
    const same = Math.abs(from.zoom - target.zoom) < 1e-6 && Math.abs(from.offsetX - target.offsetX) < 0.5 && Math.abs(from.offsetY - target.offsetY) < 0.5;
    if (same || !this.motionOn()) {
      this.viewport.restore(target);
      this.requestViewport();
      return;
    }
    const cx = this.screenSize.width / 2;
    const cy = this.screenSize.height / 2;
    const c0 = { x: (cx - from.offsetX) / from.zoom, y: (cy - from.offsetY) / from.zoom };
    const c1 = { x: (cx - target.offsetX) / target.zoom, y: (cy - target.offsetY) / target.zoom };
    const z0 = Math.log(from.zoom);
    const z1 = Math.log(target.zoom);
    const DURATION = 280;
    const started = performance.now();
    let shown = from;
    const step = () => {
      if (token !== this.glide) return;
      // Moved by the user meanwhile (wheel, pinch, pan): theirs wins.
      const v = this.viewport.toJSON();
      if (v.zoom !== shown.zoom || v.offsetX !== shown.offsetX || v.offsetY !== shown.offsetY) return;
      const t = Math.min(1, (performance.now() - started) / DURATION);
      const e = 1 - (1 - t) ** 3;
      const zoom = t === 1 ? target.zoom : Math.exp(z0 + (z1 - z0) * e);
      const c = { x: c0.x + (c1.x - c0.x) * e, y: c0.y + (c1.y - c0.y) * e };
      shown = t === 1 ? target : { zoom, offsetX: cx - c.x * zoom, offsetY: cy - c.y * zoom };
      this.viewport.restore(shown);
      shown = this.viewport.toJSON();
      this.requestViewport();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Typograph (FEAT-152): the rules of typesetting over the selected texts — and the
   * texts inside selected frames and groups; while editing, over the edited text.
   * Styles stay with their characters. Returns how many texts changed.
   */
  typographSelection(): number {
    const d = this.doc;
    if (d.readOnly) return 0;
    const editing = this.editingText;
    if (editing) this.stopTextEditing();
    const texts = new Set<NodeId>();
    for (const id of editing ? [editing] : this.selection) {
      if (!d.store.isAlive(id)) continue;
      // The layer itself and everything inside it.
      const take = (n: NodeId) => {
        if (d.type(n) === 'TEXT' && !d.get(n, 'locked')) texts.add(n);
      };
      take(id);
      d.store.walk(id, take);
    }
    if (texts.size === 0) {
      this.toast(tr('Выделите текст, фрейм или группу с текстами'));
      return 0;
    }
    let changed = 0;
    let edits = 0;
    this.commit(tr('Типограф'), (tx) => {
      for (const id of texts) {
        const res = typographRuns(d.get(id, 'characters'), d.get(id, 'textRuns'));
        if (res.changes === 0 || res.text === d.get(id, 'characters')) continue;
        tx.set(id, 'characters', res.text);
        tx.set(id, 'textRuns', normalizeRuns(res.runs, res.text.length, baseTextStyle(d, id)));
        changed++;
        edits += res.changes;
      }
    });
    this.toast(changed === 0 ? tr('Типограф: всё уже по правилам') : tr('Типограф: исправлено мест — {0}, в текстах: {1}', edits, changed));
    return changed;
  }

  /** The live font preview (FEAT-153): a gesture that is cancelled, never recorded. */
  private fontPreview: EditorGesture | null = null;

  /**
   * Shows the selected texts in `family` for a moment (the font picker's live
   * preview); null — back to what they were. Nothing enters the undo history.
   * Not while editing characters (the preview is for whole layers).
   */
  previewFont(family: string | null): void {
    if (family === null) {
      this.fontPreview?.cancel();
      this.fontPreview = null;
      return;
    }
    if (this.doc.readOnly || this.editingText) return;
    const ids = this.topLevelSelection().filter((t) => this.doc.type(t) === 'TEXT');
    if (ids.length === 0) return;
    // Each family from what it was: the previous preview is taken back first.
    this.fontPreview?.cancel();
    this.fontPreview = this.beginGesture(tr('Шрифт'));
    this.fontPreview.update((tx) => {
      for (const t of ids) {
        tx.update(t, { fontFamily: family });
        const length = this.doc.get(t, 'characters').length;
        tx.set(t, 'textRuns', applyRunStyle(this.doc.get(t, 'textRuns'), length, 0, length, { fontFamily: undefined }, baseTextStyle(this.doc, t)));
      }
    });
  }

  /** Greets layers just put on the canvas (a little bounce, a soft sound). */
  appear(ids: readonly NodeId[]): void {
    if (ids.length === 0) return;
    play('insert');
    this.events.emit('appear', ids);
  }

  /** Size of the canvas view in CSS pixels (set by the canvas view). */
  screenSize = { width: 800, height: 600 };

  requestViewport(): void {
    this.keepToStage();
    this.events.emit('viewport', undefined);
  }

  /** How much room the slide on show keeps round it, in screen pixels. */
  static readonly STAGE_PADDING = 40;

  /** Screen pixels at the bottom of the view the slide on show keeps clear: the notes card and the tools over it (FEAT-166). */
  stageInset = 0;

  /** The view showing the slide `b` whole above the inset. */
  private stageView(b: Rect): { zoom: number; offsetX: number; offsetY: number } {
    const now = this.viewport.toJSON();
    this.viewport.fit(b, this.screenSize.width, Math.max(1, this.screenSize.height - this.stageInset), Editor.STAGE_PADDING, 8);
    const target = this.viewport.toJSON();
    this.viewport.restore(now);
    return target;
  }

  /**
   * The «Слайд» view (FEAT-165): no zooming out past the whole slide, which then stands in
   * the middle; zoomed in, the view moves only over the slide, never off it.
   */
  private keepToStage(): void {
    const id = this.slideStage?.current();
    if (!id || !this.doc.store.isAlive(id)) return;
    const b = this.scene.bounds(id);
    const fit = this.stageView(b);
    const v = this.viewport;
    if (v.zoom <= fit.zoom + 1e-6) {
      v.restore(fit);
      return;
    }
    const pad = Editor.STAGE_PADDING;
    const clampAxis = (offset: number, start: number, size: number, screen: number) => {
      const lo = screen - pad - (start + size) * v.zoom;
      const hi = pad - start * v.zoom;
      return lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, offset));
    };
    v.offsetX = clampAxis(v.offsetX, b.x, b.width, this.screenSize.width);
    v.offsetY = clampAxis(v.offsetY, b.y, b.height, this.screenSize.height - this.stageInset);
  }

  /** Shows the slide on show whole, at once. */
  fitStage(): void {
    const id = this.slideStage?.current();
    if (!id || !this.doc.store.isAlive(id)) return;
    this.viewport.restore(this.stageView(this.scene.bounds(id)));
    this.requestViewport();
  }

  /** Whether the slide on show fills the view whole (scrolling then turns slides). */
  stageFitted(): boolean {
    const id = this.slideStage?.current();
    if (!id || !this.doc.store.isAlive(id)) return false;
    return this.viewport.zoom <= this.stageView(this.scene.bounds(id)).zoom + 1e-6;
  }

  requestOverlay(): void {
    this.events.emit('overlay', undefined);
  }

  // ---------- text ----------

  /** Text editing session: one undo step for the whole session, a character selection and a pending style. */
  private textGesture: EditorGesture | null = null;
  /** Selected characters while editing ([start, end), start may be greater than end for backwards selection). */
  textSel = { anchor: 0, focus: 0 };
  /** Style for the next typed characters (Mod+B with a collapsed caret, panel changes). */
  pendingTextStyle: TextRunStyle | null = null;
  /** The edited text layer is named by its content (as in Figma) until someone renames it. */
  private textNamedByContent = false;
  /** Multi-edit text (as in Figma): other text layers that take whatever is typed in the edited one. */
  textMirrors: NodeId[] = [];
  /** Of the mirrors, those named by their content. */
  private mirrorsNamedByContent = new Set<NodeId>();

  private namedByContent(id: NodeId): boolean {
    const name = this.doc.get(id, 'name');
    return /^Text( \d+)?$/.test(name) || name === textLayerName(this.doc.get(id, 'characters'));
  }

  /** Enter on several text layers: edits the first, the rest follow it (Multi-edit text, as in Figma). */
  startMultiTextEditing(ids: NodeId[]): void {
    const texts = ids.filter((id) => this.doc.store.isAlive(id) && this.doc.type(id) === 'TEXT' && !this.doc.get(id, 'board') && !this.isInstanceLayer(id));
    if (texts.length === 0) return;
    this.startTextEditing(this.sortedSpatially(texts, false)[0]!, texts);
  }

  startTextEditing(id: NodeId, mirrors: NodeId[] = []): void {
    if (this.editingText === id) return;
    if (this.editingText) this.stopTextEditing();
    this.editingText = id;
    this.textMirrors = mirrors.filter((m) => m !== id);
    this.mirrorsNamedByContent = new Set(this.textMirrors.filter((m) => this.namedByContent(m)));
    this.setSelection([id]);
    this.textGesture = this.beginGesture(this.textMirrors.length ? tr('Изменить тексты') : tr('Изменить текст'));
    this.textNamedByContent = this.namedByContent(id);
    const length = this.doc.get(id, 'characters').length;
    this.textSel = { anchor: 0, focus: length };
    this.pendingTextStyle = null;
    this.events.emit('editText', id);
    this.events.emit('textSelection', this.textSel);
  }

  stopTextEditing(): void {
    if (this.editingText === null) return;
    const id = this.editingText;
    // In the same undo step as the typing.
    if (this.textNamedByContent && this.doc.store.isAlive(id)) {
      const name = textLayerName(this.doc.get(id, 'characters'));
      if (name && name !== this.doc.get(id, 'name')) this.textGesture?.update((tx) => tx.set(id, 'name', name));
    }
    const mirrors = this.textMirrors.filter((m) => this.doc.store.isAlive(m));
    for (const m of mirrors) {
      const name = textLayerName(this.doc.get(m, 'characters'));
      if (this.mirrorsNamedByContent.has(m) && name && name !== this.doc.get(m, 'name')) this.textGesture?.update((tx) => tx.set(m, 'name', name));
    }
    this.textMirrors = [];
    // A sticky or a shape is named by its text too (the layers list and search show what is written).
    const part = this.doc.store.isAlive(id) ? this.doc.get(id, 'board') : null;
    const owner = this.doc.store.isAlive(id) ? this.doc.parent(id) : null;
    if (owner && (part?.kind === 'STICKY_TEXT' || part?.kind === 'SHAPE_TEXT')) {
      const name = textLayerName(this.doc.get(id, 'characters'));
      if (name && name !== this.doc.get(owner, 'name')) this.textGesture?.update((tx) => tx.set(owner, 'name', name));
      // A sticky nobody has signed yet (from a template) is signed by whoever writes in it first.
      const role = this.doc.get(owner, 'board');
      if (role?.kind === 'STICKY' && !role.author && this.boardPrefs.author && name) this.textGesture?.update((tx) => tx.set(owner, 'board', { ...role, author: this.boardPrefs.author }));
    }
    this.textGesture?.commit();
    this.textGesture = null;
    this.editingText = null;
    this.pendingTextStyle = null;
    this.events.emit('editText', null);
    // The text of a sticky or a shape stays even when empty: it is part of the object.
    if (part) return;
    if (mirrors.length > 0) {
      const all = [id, ...mirrors].filter((t) => this.doc.store.isAlive(t));
      if (all.every((t) => this.doc.get(t, 'characters').trim() === '')) this.commit(tr('Удалить пустой текст'), (tx) => all.forEach((t) => tx.delete(t)), () => []);
      else this.setSelection(all);
      return;
    }
    if (this.doc.store.isAlive(id) && this.doc.get(id, 'characters').trim() === '') {
      // An empty connector label goes away whole.
      if (owner && this.doc.get(owner, 'board')?.kind === 'CONNECTOR_LABEL') {
        this.commit(tr('Удалить пустую подпись'), (tx) => tx.delete(owner), () => []);
        return;
      }
      this.commit(tr('Удалить пустой текст'), (tx) => tx.delete(id), () => []);
    }
  }

  /** Ordered selection while editing. */
  textRange(): { start: number; end: number } {
    const { anchor, focus } = this.textSel;
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  }

  setTextSelection(anchor: number, focus: number): void {
    const id = this.editingText;
    if (!id) return;
    const length = this.doc.get(id, 'characters').length;
    const a = Math.max(0, Math.min(length, anchor));
    const f = Math.max(0, Math.min(length, focus));
    if (a === this.textSel.anchor && f === this.textSel.focus) return;
    this.textSel = { anchor: a, focus: f };
    this.pendingTextStyle = null;
    this.events.emit('textSelection', this.textSel);
    this.requestOverlay();
  }

  /** Applies a new value of the edited text (from typing), keeping styles with their characters. */
  replaceText(value: string, anchor: number, focus: number): void {
    const id = this.editingText;
    if (!id || !this.textGesture) return;
    const old = this.doc.get(id, 'characters');
    if (old !== value) {
      // The changed region: common prefix and suffix stay.
      let p = 0;
      while (p < old.length && p < value.length && old[p] === value[p]) p++;
      let sOld = old.length;
      let sNew = value.length;
      while (sOld > p && sNew > p && old[sOld - 1] === value[sNew - 1]) {
        sOld--;
        sNew--;
      }
      const runs = editRuns(this.doc.get(id, 'textRuns'), p, sOld - p, sNew - p, value.length, this.pendingTextStyle ? { ...runStyleAt(this.doc.get(id, 'textRuns'), Math.max(0, p - 1)), ...this.pendingTextStyle } : null);
      this.textGesture.update((tx) => {
        tx.set(id, 'characters', value);
        tx.set(id, 'textRuns', normalizeRuns(runs, value.length, baseTextStyle(this.doc, id)));
        // Nested list levels move with their paragraphs.
        const levels = this.doc.get(id, 'listLevels');
        if (levels.length > 0) {
          // "a\n" + "\n" is the same text whether Enter split the line or the next one: the caret says which.
          const added = sNew - p;
          const q = anchor === focus && added > 0 && sOld === p && anchor - added >= 0 && value.slice(anchor - added, anchor) === value.slice(p, sNew) && old.slice(0, anchor - added) === value.slice(0, anchor - added) && old.slice(anchor - added) === value.slice(anchor) ? anchor - added : p;
          tx.set(id, 'listLevels', editListLevels(levels, old, value, q, sOld - p, sNew - p));
        }
        // Each mirror keeps its own styles: the same edit where it had the same text, else all of it is replaced.
        for (const m of this.textMirrors) {
          if (!this.doc.store.isAlive(m)) continue;
          const mine = this.doc.get(m, 'characters');
          const mirrored = mine === old ? editRuns(this.doc.get(m, 'textRuns'), p, sOld - p, sNew - p, value.length) : editRuns(this.doc.get(m, 'textRuns'), 0, mine.length, value.length, value.length);
          tx.set(m, 'characters', value);
          tx.set(m, 'textRuns', normalizeRuns(mirrored, value.length, baseTextStyle(this.doc, m)));
        }
      });
      if (sNew > p) this.pendingTextStyle = null;
    }
    const keepPending = this.pendingTextStyle;
    this.setTextSelection(anchor, focus);
    this.pendingTextStyle = keepPending;
  }

  /**
   * Applies character style: to the selected characters while editing, to the next
   * typed characters when the caret is collapsed, or to whole text layers otherwise.
   */
  /**
   * Text size from the bar over the selection: the whole text when nothing is
   * selected in it (a caret alone changed only the next letters — it looked
   * like nothing happened); a sticky keeps the size chosen (null — back to auto).
   */
  setTextSize(size: number | null): void {
    const texts = this.editingText ? [this.editingText] : this.topLevelSelection().flatMap((id) => {
      if (this.doc.type(id) === 'TEXT') return [id];
      const role = this.doc.get(id, 'board');
      if (role?.kind === 'STICKY' || role?.kind === 'SHAPE') return this.doc.children(id).filter((c) => this.doc.type(c) === 'TEXT' && this.doc.get(c, 'board')?.kind !== 'STICKY_AUTHOR');
      return [];
    });
    if (texts.length === 0) return;
    const write = (tx: Transaction) => {
      for (const t of texts) {
        const owner = this.doc.parent(t);
        const role = owner ? this.doc.get(owner, 'board') : null;
        if (owner && role?.kind === 'STICKY') {
          const { fontSize: _old, ...rest } = role;
          tx.set(owner, 'board', size === null ? rest : { ...rest, fontSize: size });
          continue;
        }
        if (size === null) continue;
        const length = this.doc.get(t, 'characters').length;
        tx.set(t, 'fontSize', size);
        tx.set(t, 'textRuns', applyRunStyle(this.doc.get(t, 'textRuns'), length, 0, length, { fontSize: undefined }, baseTextStyle(this.doc, t)));
      }
    };
    const id = this.editingText;
    if (id && this.textGesture) {
      const { start, end } = this.textRange();
      const inSticky = this.doc.get(id, 'board')?.kind === 'STICKY_TEXT';
      // Part of an ordinary text selected: only that part, as before.
      if (start !== end && !inSticky && size !== null) return this.applyTextStyle({ fontSize: size }, tr('Размер шрифта'));
      this.textGesture.update(write);
      this.pendingTextStyle = null;
      this.events.emit('textSelection', this.textSel);
      return;
    }
    this.commit(tr('Размер шрифта'), write);
  }

  applyTextStyle(patch: TextRunStyle, label = tr('Стиль текста')): void {
    const id = this.editingText;
    if (id && this.textGesture) {
      const { start, end } = this.textRange();
      if (start === end) {
        this.pendingTextStyle = { ...(this.pendingTextStyle ?? {}), ...patch };
        this.events.emit('textSelection', this.textSel);
        return;
      }
      this.textGesture.update((tx) => {
        const length = this.doc.get(id, 'characters').length;
        tx.set(id, 'textRuns', applyRunStyle(this.doc.get(id, 'textRuns'), length, start, end, patch, baseTextStyle(this.doc, id)));
      });
      this.events.emit('textSelection', this.textSel);
      return;
    }
    const ids = this.topLevelSelection().filter((t) => this.doc.type(t) === 'TEXT');
    if (ids.length === 0) return;
    this.commit(label, (tx) => {
      for (const t of ids) {
        const props: Partial<NodeProps> = {};
        const clear: TextRunStyle = {};
        for (const [k, v] of Object.entries(patch) as [keyof TextRunStyle, unknown][]) {
          (clear as Record<string, unknown>)[k] = undefined;
          if (k === 'baseline') continue; // super/subscript only makes sense for part of a text
          (props as Record<string, unknown>)[k] = v;
        }
        tx.update(t, props);
        const length = this.doc.get(t, 'characters').length;
        if ('baseline' in patch) tx.set(t, 'textRuns', applyRunStyle(this.doc.get(t, 'textRuns'), length, 0, length, { baseline: patch.baseline === 'NORMAL' ? undefined : patch.baseline }, baseTextStyle(this.doc, t)));
        else tx.set(t, 'textRuns', applyRunStyle(this.doc.get(t, 'textRuns'), length, 0, length, clear, baseTextStyle(this.doc, t)));
      }
    });
  }

  /**
   * Where a link goes: the selected characters while editing (or, with the
   * caret inside a link, that whole link), else every selected text layer.
   */
  linkTargets(): { id: NodeId; start: number; end: number }[] {
    const id = this.editingText;
    if (id) {
      let { start, end } = this.textRange();
      if (start === end) {
        const runs = this.doc.get(id, 'textRuns');
        const run = runs.find((r) => r.style.link && r.start <= start && start <= r.end);
        if (!run) return [];
        start = run.start;
        end = run.end;
      }
      return [{ id, start, end }];
    }
    return this.topLevelSelection()
      .filter((t) => this.doc.type(t) === 'TEXT')
      .map((t) => ({ id: t, start: 0, end: this.doc.get(t, 'characters').length }));
  }

  /** The link of the selection (null — none, MIXED — several different). */
  linkValue(): string | null | typeof MIXED_RUN {
    const targets = this.linkTargets();
    if (!targets.length) return null;
    let out: string | null | undefined;
    for (const t of targets) {
      const v = rangeValue(this.doc.get(t.id, 'textRuns'), baseTextStyle(this.doc, t.id), t.start, t.end, 'link');
      if (v === MIXED_RUN) return MIXED_RUN;
      const link = (v as string | undefined) ?? null;
      if (out === undefined) out = link;
      else if (out !== link) return MIXED_RUN;
    }
    return out ?? null;
  }

  /**
   * Puts «@Name» in place of the «@query» typed before the caret (`from` — where «@» is),
   * in the accent colour and semibold, with a plain space after it, so typing goes on
   * in the text's own style. Returns the range of the mention, or null when not editing.
   */
  insertMention(name: string, from: number): { start: number; end: number } | null {
    const id = this.editingText;
    if (!id || !this.textGesture) return null;
    const { end } = this.textRange();
    const old = this.doc.get(id, 'characters');
    if (from < 0 || from > end || old[from] !== '@') return null;
    const tag = `@${name}`;
    const value = old.slice(0, from) + tag + ' ' + old.slice(end);
    const caret = from + tag.length + 1;
    this.replaceText(value, caret, caret);
    const base = baseTextStyle(this.doc, id);
    this.textGesture.update((tx) => {
      let runs = applyRunStyle(this.doc.get(id, 'textRuns'), value.length, from, from + tag.length, { fills: [solid(MENTION_COLOR)], fontWeight: 600 }, base);
      runs = applyRunStyle(runs, value.length, from + tag.length, caret, { fills: undefined, fontWeight: undefined }, base);
      tx.set(id, 'textRuns', runs);
    });
    this.pendingTextStyle = null;
    this.events.emit('textSelection', this.textSel);
    return { start: from, end: from + tag.length };
  }

  /**
   * Sets a hyperlink (underlined, as links usually are) or removes it with
   * its underline. Returns false when there is nothing to put it on.
   */
  setLink(url: string | null, where: { id: NodeId; start: number; end: number }[] = this.linkTargets()): boolean {
    const targets = where.filter((t) => t.end > t.start && this.doc.store.isAlive(t.id));
    if (!targets.length) return false;
    const patch: TextRunStyle = url ? { link: url, textDecoration: 'UNDERLINE' } : { link: undefined, textDecoration: undefined };
    const apply = (tx: Transaction) => {
      for (const t of targets) {
        const length = this.doc.get(t.id, 'characters').length;
        tx.set(t.id, 'textRuns', applyRunStyle(this.doc.get(t.id, 'textRuns'), length, t.start, t.end, patch, baseTextStyle(this.doc, t.id)));
      }
    };
    if (this.editingText && this.textGesture && targets.every((t) => t.id === this.editingText)) this.textGesture.update(apply);
    else this.commit(url ? tr('Ссылка') : tr('Убрать ссылку'), apply);
    this.events.emit('textSelection', this.textSel);
    return true;
  }

  /** Current value of a character style key for the panel: the editing selection, or whole selected texts. */
  textStyleValue<K extends RunKey>(key: K): ResolvedStyle[K] | typeof MIXED_RUN | null {
    const id = this.editingText;
    if (id) {
      if (this.pendingTextStyle && key in this.pendingTextStyle) return this.pendingTextStyle[key as keyof TextRunStyle] as ResolvedStyle[K];
      const { start, end } = this.textRange();
      return rangeValue(this.doc.get(id, 'textRuns'), baseTextStyle(this.doc, id), start, end, key);
    }
    const ids = this.topLevelSelection().filter((t) => this.doc.type(t) === 'TEXT');
    if (ids.length === 0) return null;
    let result: ResolvedStyle[K] | typeof MIXED_RUN | undefined;
    for (const t of ids) {
      const v = textValue(this.doc.get(t, 'textRuns'), baseTextStyle(this.doc, t), this.doc.get(t, 'characters').length, key);
      if (result === undefined) result = v;
      else if (v === MIXED_RUN || JSON.stringify(v) !== JSON.stringify(result)) return MIXED_RUN;
    }
    return result ?? null;
  }

  toggleTextStyle(kind: 'bold' | 'italic' | 'underline' | 'strike'): void {
    if (kind === 'bold') {
      const w = this.textStyleValue('fontWeight');
      this.applyTextStyle({ fontWeight: typeof w === 'number' && w >= 600 ? 400 : 700 }, tr('Жирный'));
    } else if (kind === 'italic') {
      this.applyTextStyle({ italic: this.textStyleValue('italic') !== true }, tr('Курсив'));
    } else {
      const want = kind === 'underline' ? 'UNDERLINE' : 'STRIKETHROUGH';
      this.applyTextStyle({ textDecoration: this.textStyleValue('textDecoration') === want ? 'NONE' : want }, tr('Оформление текста'));
    }
  }

  /**
   * Tab / Shift+Tab in a list (as in Figma): the paragraphs under the caret or the
   * selection go one level deeper or back; without text editing — every paragraph of
   * the selected lists. False — nothing to do (not a list).
   */
  shiftListLevel(delta: 1 | -1): boolean {
    const editing = this.editingText;
    const ids = editing ? [editing] : this.topLevelSelection().filter((t) => this.doc.type(t) === 'TEXT');
    const lists = ids.filter((t) => this.doc.get(t, 'listType') !== 'NONE');
    if (lists.length === 0) return false;
    const apply = (tx: Transaction) => {
      for (const t of lists) {
        const text = this.doc.get(t, 'characters');
        const count = text.split('\n').length;
        let from = 0;
        let to = count - 1;
        if (editing) {
          const a = Math.min(this.textSel.anchor, this.textSel.focus);
          const b = Math.max(this.textSel.anchor, this.textSel.focus);
          from = text.slice(0, a).split('\n').length - 1;
          to = text.slice(0, b).split('\n').length - 1;
        }
        const levels = [...this.doc.get(t, 'listLevels')];
        for (let k = from; k <= to; k++) levels[k] = Math.max(0, Math.min(MAX_LIST_LEVEL, listLevelOf(levels, k) + delta));
        while (levels.length > 0 && !levels[levels.length - 1]) levels.pop();
        tx.set(t, 'listLevels', Array.from(levels, (v) => v ?? 0));
      }
    };
    if (editing && this.textGesture) this.textGesture.update(apply);
    else this.commit(delta > 0 ? tr('Увеличить отступ списка') : tr('Уменьшить отступ списка'), apply);
    return true;
  }

  /** Turns a list on or off for the edited or selected text layers. */
  toggleList(kind: 'NUMBER' | 'BULLET'): void {
    const ids = this.editingText ? [this.editingText] : this.topLevelSelection().filter((t) => this.doc.type(t) === 'TEXT');
    if (ids.length === 0) return;
    const on = ids.every((t) => this.doc.get(t, 'listType') === kind);
    const apply = (tx: Transaction) => {
      for (const t of ids) tx.set(t, 'listType', on ? 'NONE' : kind);
    };
    if (this.editingText && this.textGesture) this.textGesture.update(apply);
    else this.commit(tr('Список'), apply);
  }

  /** What Undo inside a text session took back, for Redo — and how the texts looked right after it. */
  private textRedo: { props: Map<NodeId, Partial<NodeProps>>; after: string } | null = null;

  private textSnapshot(): Map<NodeId, Partial<NodeProps>> {
    const ids = [this.editingText!, ...this.textMirrors].filter((t) => this.doc.store.isAlive(t));
    return new Map(ids.map((t) => [t, { ...(this.doc.store.record(t)!.props as Partial<NodeProps>) }]));
  }

  /** Undo inside a text session: reverts the session's changes and keeps editing. */
  undoTextSession(): boolean {
    const id = this.editingText;
    if (!id || !this.textGesture) return false;
    const before = this.textSnapshot();
    this.textGesture.cancel();
    const after = JSON.stringify([...this.textSnapshot()]);
    // Nothing was typed: Undo goes on to what was done before the editing.
    if (after === JSON.stringify([...before])) {
      this.textGesture = this.beginGesture(tr('Изменить текст'));
      return false;
    }
    this.textRedo = { props: before, after };
    this.textGesture = this.beginGesture(tr('Изменить текст'));
    const length = this.doc.get(id, 'characters').length;
    this.textSel = { anchor: length, focus: length };
    this.events.emit('editText', id);
    this.events.emit('textSelection', this.textSel);
    return true;
  }

  /** Redo inside a text session: brings back what Undo took, if nothing was typed since. */
  redoTextSession(): boolean {
    const id = this.editingText;
    const redo = this.textRedo;
    if (!id || !this.textGesture || !redo || JSON.stringify([...this.textSnapshot()]) !== redo.after) return false;
    this.textRedo = null;
    this.textGesture.update((tx) => {
      for (const [t, props] of redo.props) tx.update(t, props);
    });
    const length = this.doc.get(id, 'characters').length;
    this.textSel = { anchor: length, focus: length };
    this.events.emit('editText', id);
    this.events.emit('textSelection', this.textSel);
    return true;
  }

  /**
   * Resizes a node with type-specific behaviour: frames move children by their
   * constraints, groups scale their children, text switches to fixed width/height,
   * and manual resizing turns hug/fill into fixed on that axis (as in Figma).
   */
  applySize(tx: Transaction, id: NodeId, w: number, h: number, horizontal: boolean, vertical: boolean): void {
    const d = this.doc;
    const type = d.type(id);
    const props: Partial<NodeProps> = {};
    const sh = d.get(id, 'sizingH').mode;
    const sv = d.get(id, 'sizingV').mode;
    if (horizontal && sh !== 'FIXED' && sh !== 'PERCENT') props.sizingH = { mode: 'FIXED' };
    if (vertical && sv !== 'FIXED' && sv !== 'PERCENT') props.sizingV = { mode: 'FIXED' };
    if (type === 'TEXT') {
      if (vertical) props.textAutoResize = 'NONE';
      else if (horizontal && d.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT') props.textAutoResize = 'HEIGHT';
    }
    tx.update(id, props);
    resizeWithConstraints(d, tx, id, w, h);
  }

  /** Local transform of a node (relative to its parent). */
  localTransform(id: NodeId) {
    return nodeTransform(this.doc.get(id, 'x'), this.doc.get(id, 'y'), this.doc.get(id, 'rotation'));
  }
}

/** A live edit (drag, resize, typing): every update re-runs layout; the whole gesture is one undo step. */
/** The marker of one fill, stroke or effect on the clipboard. */
const PROPERTY_CLIP = 'simmetrika/property';

export interface PickedProperty {
  key: 'fills' | 'strokes' | 'effects';
  index: number;
}

export class EditorGesture {
  private readonly editor: Editor;
  private readonly gesture: Gesture;
  /** Layers made during the gesture: copied into the other variants when it ends (multi-edit variants). */
  private readonly created: NodeId[] = [];

  constructor(editor: Editor, gesture: Gesture) {
    this.editor = editor;
    this.gesture = gesture;
  }

  update(fn: (tx: Transaction) => void): void {
    this.gesture.update((tx) => {
      fn(tx);
      this.created.push(...tx.changes.created);
      this.editor.postProcess(tx, false);
    });
  }

  commit(): void {
    if (this.editor.variantEdit && this.created.length > 0) {
      const created = [...this.created];
      this.created.length = 0;
      this.update((tx) => this.editor.mirrorIntoVariants(tx, created));
      const first = this.editor.selection[0];
      // The new layer is selected with its copies.
      if (first && created.includes(first)) {
        this.editor.selection = [];
        this.editor.setSelection([first]);
      }
    }
    // The drag is over: what the file's own pass waited for (a slide dropped into its new place) happens in the same step.
    const pass = this.editor.editPass;
    if (pass) this.gesture.update((tx) => pass(tx, true));
    this.gesture.commit([...this.editor.selection]);
  }

  cancel(): void {
    this.gesture.cancel();
  }
}

/** A text layer's name from its text: the first line, as in the layers panel of Figma. */
export function textLayerName(characters: string): string {
  const line = characters.split('\n').find((l) => l.trim()) ?? '';
  const clean = line.trim().replace(/\s+/g, ' ');
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.abs(a) < 1e-6 ? 0 : a;
}

/** The text layer's own style, which its runs override. */
export function baseTextStyle(doc: Document, id: NodeId): ResolvedStyle {
  return {
    fontFamily: doc.get(id, 'fontFamily'),
    fontWeight: doc.get(id, 'fontWeight'),
    italic: doc.get(id, 'italic'),
    fontSize: doc.get(id, 'fontSize'),
    letterSpacing: doc.get(id, 'letterSpacing'),
    caps: doc.get(id, 'fontVariantCaps'),
    kerning: doc.get(id, 'kerning'),
    fills: doc.get(id, 'fills'),
    textDecoration: doc.get(id, 'textDecoration'),
    baseline: 'NORMAL',
  };
}

/**
 * Background of new pages, as in Figma: #F5F5F5 in the light theme, #1E1E1E in
 * the dark one. It is stored in the page, so the file looks the same for everyone.
 */
export function themePageBackground(): Color {
  const dark = isDark();
  return dark ? { r: 30 / 255, g: 30 / 255, b: 30 / 255, a: 1 } : { r: 245 / 255, g: 245 / 255, b: 245 / 255, a: 1 };
}

/**
 * The page background as shown. The two theme defaults (#F5F5F5 and #1E1E1E)
 * mean "the canvas colour of the theme": a file started in the dark theme must
 * not keep a dark canvas in a light interface (and the other way round). Any
 * other colour was chosen by hand and is shown as is; «Сбросить» in the panel
 * puts the theme's colour back.
 */
export function shownPageBackground(stored: Color): Color {
  return isThemePageBackground(stored) ? themePageBackground() : stored;
}

/** One of the two theme defaults (#F5F5F5, #1E1E1E): the canvas colour of the theme, not chosen by hand. */
export function isThemePageBackground(stored: Color): boolean {
  const near = (v: number, t: number) => Math.abs(v - t) < 1.5 / 255;
  const isDefault = (t: number) => near(stored.r, t) && near(stored.g, t) && near(stored.b, t);
  return isDefault(30 / 255) || isDefault(245 / 255);
}

const BOOLEAN_NAMES: Record<BooleanOp, string> = { UNION: tr('Объединение'), SUBTRACT: tr('Вычитание'), INTERSECT: tr('Пересечение'), EXCLUDE: tr('Исключение') };

/**
 * Moves a vector's points so its box starts at (0, 0) and fits them exactly,
 * shifting the node so that nothing moves on screen.
 */
export function normalizeVector(doc: Document, tx: Transaction, id: NodeId): void {
  const net = doc.get(id, 'vectorNetwork');
  const paths = doc.get(id, 'vectorPaths');
  const b = net ? networkBounds(net) : pathsBounds(paths);
  if (!b) return;
  const r = (doc.get(id, 'rotation') * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const shift = (p: { x: number; y: number }) => ({ x: round(p.x - b.x), y: round(p.y - b.y) });
  const moved = b.x !== 0 || b.y !== 0;
  tx.update(id, {
    ...(net ? { vectorNetwork: moved ? mapNetwork(net, shift) : net } : { vectorPaths: moved ? mapPaths(paths, shift) : paths }),
    x: round(doc.get(id, 'x') + b.x * cos - b.y * sin),
    y: round(doc.get(id, 'y') + b.x * sin + b.y * cos),
    width: round(b.width),
    height: round(b.height),
  });
}

/** Area covered by a stroke of `weight` along the paths (for Outline stroke). */
export function strokeRegion(paths: readonly VectorPath[], weight: number, align: 'INSIDE' | 'CENTER' | 'OUTSIDE'): Region {
  const half = align === 'CENTER' ? weight / 2 : weight;
  const pieces: Region[] = [];
  const circle = (c: Point): Point[] => {
    const n = Math.max(12, Math.min(48, Math.ceil(half * 2)));
    return Array.from({ length: n }, (_, i) => ({ x: c.x + Math.cos((i / n) * Math.PI * 2) * half, y: c.y + Math.sin((i / n) * Math.PI * 2) * half }));
  };
  for (const line of flattenPaths(paths, 0.1)) {
    const pts = line.points;
    const count = line.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < count; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) continue;
      const nx = (-(b.y - a.y) / len) * half;
      const ny = ((b.x - a.x) / len) * half;
      pieces.push({ contours: [[{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]], rule: 'NONZERO' });
    }
    // Round joins (and round ends of open paths).
    for (const p of pts) pieces.push({ contours: [circle(p)], rule: 'NONZERO' });
  }
  let region = booleanAll('UNION', pieces);
  if (align !== 'CENTER') {
    const shape: Region = { contours: flattenPaths(paths, 0.1).filter((l) => l.closed).map((l) => l.points), rule: 'NONZERO' };
    region = booleanRegions(align === 'INSIDE' ? 'INTERSECT' : 'SUBTRACT', region, shape);
  }
  return region;
}

/** Degrees in (-180, 180]. */
function normalizeDegrees(v: number): number {
  let r = ((v % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return Math.round(r * 100) / 100;
}

/** Puts a layer so that its centre lands at `centre` (parent space), given its size and rotation (around its top-left). */
function placeCentre(tx: Transaction, id: NodeId, centre: Point, w: number, h: number, rotation: number): void {
  const a = (rotation * Math.PI) / 180;
  const ox = (w / 2) * Math.cos(a) - (h / 2) * Math.sin(a);
  const oy = (w / 2) * Math.sin(a) + (h / 2) * Math.cos(a);
  tx.update(id, { x: Math.round((centre.x - ox) * 100) / 100, y: Math.round((centre.y - oy) * 100) / 100 });
}
