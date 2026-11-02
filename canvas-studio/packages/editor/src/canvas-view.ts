// The canvas: rendering, overlays and all pointer interaction on the canvas
// (selection, marquee, move with snapping and re-parenting, resize, rotate,
// shape creation, text creation and in-place text editing, pan and zoom).

import type { TextMentions } from './ui/text-mentions.ts';
import { isDark, onThemeChange } from './theme.ts';
import { play } from './sounds.ts';
import { CanvasInk } from './canvas-ink.ts';
import { tr } from '#core';
import { CONNECT_HANDLE, connectHandlePoint, drawConnectHandle, drawConnections, drawFlowFlag, drawPendingConnection } from './prototype/overlay.ts';
import { screenOf } from './prototype/model.ts';
import { type HandleMirror, DEV_STATUS_LABELS, hexToColor, isFrameLike, isGradient, rgba, type DevStatus, solid, type Color, type GradientPaint, type NodeId, type NodeProps, type NodeType, type VectorNetwork } from '#core';
import { cssColor } from '#render';
import { caretAt, indexAt, lineOffset, scaleNode, strokeLinePaths, textStyleOf } from '#layout';
import { widthAt, cubicOf, handlesAt, vertexMirror, pointInPolygon, eraseFill, eraseNetwork, simplifyNetwork, cutNetworkSegment, detachVertex, findFaces, refillPart, flattenPaths, loopPath, nearestSegment, regionAt, splitNetworkSegment, strokeChains, toggleRegionAt } from '#geometry';
import { pathOf } from '#render';
import { addStop } from './ui/paint-editor.ts';
import { h, icon } from './ui/dom.ts';
import { apply, invert, rectFromPoints, transformCorners, intersects, isConvexQuad, polygonPoints, starPoints, warpOutline, type Matrix, type Point, type Rect } from '#geometry';
import { Canvas2DRenderer, cssFont, Viewport } from '#render';
import { normalizeVector, round2, normalizeAngle, shownPageBackground, type Editor, type EditorGesture, type Guide } from './editor.ts';
import { IS_MAC } from './keyboard.ts';
import { smartReplace } from './smart-symbols.ts';
import { ICON_DRAG_TYPE } from './ui/icons-panel.ts';
import { CONTENT_DRAG_TYPE } from './ui/content-panel.ts';
import { TileLayer } from './tiles.ts';
import { cellPlace, cellsBetween, stepCell, tableOf, tableShape } from './tables.ts';
import { BoardView } from './board-view.ts';
import { lockedAt } from './board-actions.ts';
import { addNeighbour, boardObjectOf, editableTextOf, isConnector, smoothStroke } from './board.ts';
import { linkOfCard } from './link-card.ts';
import { openLink } from './text-links.ts';
import { cellAt } from './shape-builder.ts';
import { collectTargets, neighbourDistances, snapRect, snapValue, type SnapTargets } from './snapping.ts';
import { measureRects, type SpacingMatch } from '#geometry';
import { drawGuides, drawLayoutGrids, drawLoupe, drawMeasurements, drawNewGuide, drawPixelGrid, drawRulers, drawSpacing, RULER, SPACING_COLOR } from './precision-overlay.ts';

const ACCENT = '#4F5BD5';
/** Components and instances are shown in purple, as designers expect from Figma. */
const COMPONENT_ACCENT = '#9747FF';
export const COMPONENT_DRAG_TYPE = 'application/x-canvas-studio-component';
const GUIDE = '#F24822';
const HANDLE = 8;
/** How far from a selection's edge (screen px) the edge can still be grabbed to resize. */
const EDGE_GRAB = 4;
/** The rotation handle above the box (as in PowerPoint): its distance from the top edge and its radius, screen px. */
const ROTATE_STEM = 26;
const ROTATE_KNOB = 8;

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
const RADIUS_HANDLE = 8;
/** Pencil stroke, px: Figma's default round 3 px. */
const WARP_HANDLE = 10;
const DRAG_THRESHOLD = 3;

type HandleDir = { hx: -1 | 0 | 1; hy: -1 | 0 | 1 };

type Mode =
  | { kind: 'idle' }
  /** A board tool or handle has the pointer (board-view.ts). */
  | { kind: 'board' }
  | { kind: 'pan'; last: Point }
  | { kind: 'text-select'; anchor: number }
  | { kind: 'pen-drag'; gesture: EditorGesture; vertex: number; start: Point; segment: number | null }
  | { kind: 'vec-points'; gesture: EditorGesture | null; start: Point; screen: Point; snapshot: VectorNetwork; clickedKey: string; toggle: boolean }
  | { kind: 'vec-handle'; gesture: EditorGesture; segment: number; end: 'a' | 'b'; mirror: HandleMirror | null }
  | { kind: 'vec-bend'; gesture: EditorGesture; segment: number }
  | { kind: 'vec-marquee'; start: Point; screen: Point; base: string[]; lasso: Point[] | null }
  | { kind: 'pending-move'; start: Point; screen: Point; clicked: NodeId; wasSelected: boolean; alt: boolean; narrowTo?: NodeId; toggle?: boolean; clearOnClick?: boolean }
  | {
      kind: 'move';
      start: Point;
      gesture: EditorGesture;
      ids: NodeId[];
      origins: Map<NodeId, Point>;
      startBounds: Rect;
      targets: SnapTargets;
      /** Axis locked by Shift; chosen once per press so the object does not jump between axes. */
      axis: 'x' | 'y' | null;
      /** How far the pointer took the layers (snapping included): in auto layout they are drawn there, not in their place. */
      shift: Point;
      /** The part of `shift` that snapping added: the picture glides over it (FEAT-150). */
      snap?: Point;
    }
  | { kind: 'marquee'; start: Point; container: NodeId; base: NodeId[]; clicked: NodeId | null; moved: boolean; /** Mod: nested layers too. */ deep?: boolean }
  | {
      kind: 'resize';
      gesture: EditorGesture;
      dir: HandleDir;
      ids: NodeId[];
      single: { id: NodeId; m0: Matrix; w0: number; h0: number; origin: Point } | null;
      startBounds: Rect;
      boxes: Map<NodeId, { world: Rect; w: number; h: number }>;
      targets: SnapTargets;
    }
  | { kind: 'gradient'; gesture: EditorGesture | null; part: 'from' | 'to' | 'stop' | 'line'; stop: number; t: number; screen: Point }
  | { kind: 'radius'; gesture: EditorGesture; id: NodeId; corner: number; only: boolean }
  | { kind: 'warp'; gesture: EditorGesture; id: NodeId; corner: number }
  | { kind: 'arc'; gesture: EditorGesture; id: NodeId; part: 'sweep' | 'start' | 'ratio' }
  | { kind: 'pencil'; points: Point[]; parent: NodeId; ink: Color }
  | { kind: 'builder'; chosen: number[]; remove: boolean }
  | { kind: 'vec-width'; gesture: EditorGesture; id: NodeId; index: number; along: boolean }
  | { kind: 'vec-erase'; gesture: EditorGesture; id: NodeId; last: Point; fill: boolean; net: VectorNetwork }
  | { kind: 'vec-transform'; gesture: EditorGesture; id: NodeId; net: VectorNetwork; chosen: Set<number>; box: Rect; handle: number; start: Point }
  | { kind: 'rotate'; gesture: EditorGesture; id: NodeId; m0: Matrix; w: number; h: number; r0: number; a0: number; pivot: Point }
  | { kind: 'origin' }
  | { kind: 'connect'; source: NodeId; from: Point; to: Point; target: NodeId | null }
  | { kind: 'create'; type: NodeType; extra: Partial<NodeProps>; start: Point; screen: Point; parent: NodeId; gesture: EditorGesture | null; id: NodeId | null; targets: SnapTargets }
  /** Dragging an equal-spacing handle of the selection (FR-DRW-092). */
  | { kind: 'spacing'; axis: 'x' | 'y'; ids: NodeId[]; boxes: Rect[]; gap0: number; start: Point; gesture: EditorGesture }
  /** Dragging a padding or gap handle of an auto layout frame (FR-AL-003, as in Figma). */
  | { kind: 'al-handle'; frame: NodeId; side: AlSide; v0: number; start: Point; inv: Matrix; gesture: EditorGesture }
  /** A table's column border dragged (FEAT-168): the two columns beside it share their width anew. */
  | { kind: 'table-col'; table: NodeId; index: number; start: number; widths: number[]; inv: Matrix; gesture: EditorGesture }
  /** A table's row border dragged (FEAT-170): the row above it gets that height (never less than its texts). */
  | { kind: 'table-row'; table: NodeId; index: number; start: number; height: number; cells: NodeId[]; inv: Matrix; gesture: EditorGesture }
  /** Selecting cells of a table (FEAT-170): from a cell over others, or along the row or column handles; `base` — kept with Mod. */
  | { kind: 'table-cells'; table: NodeId; axis: 'cell' | 'row' | 'col'; anchor: { row: number; col: number }; base: NodeId[]; last: string }
  /** Dragging a ruler guide: a new one out of a ruler (owner null) or an existing one (FR-CNV-044). */
  | { kind: 'guide'; axis: 'X' | 'Y'; owner: NodeId | null; index: number; gesture: EditorGesture | null; at: number; overRuler: boolean; targets: SnapTargets };

interface Label {
  id: NodeId;
  rect: Rect;
}

/** A padding side or the gap between layers of an auto layout frame. */
type AlSide = 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft' | 'itemSpacing';

/** A handle on the canvas: the bar to drag (screen), the strip it changes (screen corners), its value. */
interface AlHandle {
  side: AlSide;
  p: Point;
  /** The bar runs along x (top, bottom, gaps of a column) or along y. */
  along: 'x' | 'y';
  regions: Point[][];
  value: number;
}

export class CanvasView {
  readonly element: HTMLDivElement;
  readonly renderer: Canvas2DRenderer;
  private radiusLabel: { p: Point; text: string } | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly editor: Editor;
  /** Board tools, "+" handles and connector ends (FEAT-083). */
  readonly board: BoardView;
  private readonly textArea: HTMLTextAreaElement;
  /** The «@» list of board texts (set by the app when the file is on the server). */
  mentions: TextMentions | null = null;
  /** The invisible input that takes typing while a text is edited. */
  get textInput(): HTMLTextAreaElement {
    return this.textArea;
  }
  private textGesture: EditorGesture | null = null;
  private mode: Mode = { kind: 'idle' };
  private frame = 0;
  /** Set by the app: an icon dragged from its panel was dropped at a world point. */
  onIconDrop: ((id: string, world: Point) => boolean) | null = null;
  /** A set from the «Контент» panel dropped: into the layer under the point or a new layer there. */
  onContentDrop: ((id: string, world: Point) => boolean) | null = null;
  private dpr = 1;
  private labels: Label[] = [];
  private lastStats = { drawn: 0, culled: 0, ms: 0 };
  spaceDown = false;
  /** Alt held: measurements to the hovered layer (FR-CNV-042). */
  private altDown = false;
  /** Last pointer position on the canvas (screen), for Alt measurements and the eyedropper. */
  private pointer: Point | null = null;
  /** Guide under the pointer (highlighted, draggable). */
  private hoverGuide: { owner: NodeId; index: number } | null = null;
  /** The padding or gap handle under the pointer: its strip is shown. */
  private hoverAl: AlSide | null = null;
  /** The row or column handle of a table under the pointer (FEAT-170). */
  private hoverGrabber: string | null = null;
  /** Where a range of cells starts: the cell (row, column) last clicked without Shift. */
  private cellAnchor: { table: NodeId; axis: 'cell' | 'row' | 'col'; row: number; col: number } | null = null;
  /** Eyedropper sample around the pointer (FR-DRW-053). */
  private loupe: { pixels: ImageData; color: Color; average: Color } | null = null;
  private guideInput: HTMLInputElement | null = null;
  onStats: ((stats: { drawn: number; culled: number; ms: number }) => void) | null = null;
  /** Opens the context menu; set by the app. `hits` are all layers under the cursor, top-most first. */
  onMenu: ((clientX: number, clientY: number, hits: NodeId[]) => void) | null = null;
  /** Mod+K while editing text: a hyperlink for the selected characters (set by the app). */
  onLink: (() => void) | null = null;
  /** A click with the comment tool: start a discussion there (set by the app). */
  onComment: ((world: Point, screen: Point) => void) | null = null;

  constructor(editor: Editor, renderer: Canvas2DRenderer) {
    this.editor = editor;
    this.renderer = renderer;
    this.renderer.pageBackground = shownPageBackground;
    this.renderer.ink = new CanvasInk(editor).forNode;
    this.renderer.pagePattern = BoardView.pattern(editor);
    this.board = new BoardView(editor, { request: () => this.request(false), focus: () => this.focus() });
    // The canvas colour follows the system theme while the file is open.
    onThemeChange(() => this.refreshAll());
    this.element = document.createElement('div');
    this.element.className = 'canvas-view';
    this.canvas = document.createElement('canvas');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', tr('Холст'));
    // The page on the GPU when the browser can (tiles.ts); this canvas then only shows hover, selection and the like over it.
    this.tiles = gpuWanted() ? TileLayer.create(renderer) : null;
    const ctx = this.canvas.getContext('2d', { alpha: this.tiles !== null });
    if (!ctx) throw new Error(tr('Canvas 2D недоступен'));
    this.ctx = ctx;
    // Under the canvas of hover and selection.
    if (this.tiles) {
      this.element.prepend(this.tiles.canvas);
      this.tiles.onNeedFrame = () => this.request(false);
    }
    this.textArea = document.createElement('textarea');
    this.textArea.className = 'text-editor';
    this.textArea.spellcheck = true;
    this.textArea.hidden = true;
    this.element.append(this.canvas, this.textArea);

    new ResizeObserver(() => this.resize()).observe(this.element);
    // Components dragged from the assets panel become instances where they are dropped.
    this.canvas.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes(COMPONENT_DRAG_TYPE) || e.dataTransfer?.types.includes(ICON_DRAG_TYPE) || e.dataTransfer?.types.includes(CONTENT_DRAG_TYPE)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    this.canvas.addEventListener('drop', (e) => {
      // An icon from the «Иконки» panel: where it is dropped.
      const iconId = e.dataTransfer?.getData(ICON_DRAG_TYPE);
      if (iconId && this.onIconDrop?.(iconId, editor.viewport.screenToWorld(this.local(e)))) {
        e.preventDefault();
        this.focus();
        return;
      }
      const contentId = e.dataTransfer?.getData(CONTENT_DRAG_TYPE);
      if (contentId && this.onContentDrop?.(contentId, editor.viewport.screenToWorld(this.local(e)))) {
        e.preventDefault();
        this.focus();
        return;
      }
      const component = e.dataTransfer?.getData(COMPONENT_DRAG_TYPE);
      if (!component) return;
      e.preventDefault();
      e.stopPropagation();
      const world = editor.viewport.screenToWorld(this.local(e));
      editor.placeInstance(component, world);
      this.focus();
    });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', () => this.cancelMode());
    this.canvas.addEventListener('pointerleave', () => {
      if (this.mode.kind === 'idle') editor.setHover(null);
      this.pointer = null;
      if (this.hoverGuide || this.loupe || editor.distances.length > 0) {
        this.hoverGuide = null;
        editor.distances = [];
        this.request();
      }
    });
    this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.textArea.addEventListener('input', (e) => this.onTextInput(e as InputEvent));
    this.textArea.addEventListener('keydown', (e) => this.onTextKey(e));
    this.textArea.addEventListener('keyup', () => this.syncFromTextArea());
    this.textArea.addEventListener('select', () => this.syncFromTextArea());
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === this.textArea) this.syncFromTextArea();
    });

    editor.events.on('change', () => {
      this.request();
      if (editor.editingText) this.positionTextArea();
    });
    editor.events.on('viewport', () => {
      this.request(false);
      if (editor.editingText) this.positionTextArea();
    });
    // Hover and selection are drawn over the content: the content itself stays.
    editor.events.on('overlay', () => this.request(false));
    editor.events.on('selection', () => this.request(false));
    editor.events.on('appear', (ids) => this.greet(ids));
    // Another page or file: nothing of the old tiles may show through.
    editor.events.on('page', () => {
      this.tiles?.clear();
      this.request();
    });
    editor.events.on('document', () => {
      this.tiles?.clear();
      this.request();
    });
    // Fonts arriving change how text looks without changing the document.
    document.fonts?.addEventListener?.('loadingdone', () => this.refreshAll());
    editor.events.on('editText', (id) => {
      // A text on a path is typed into as a plain line (the caret follows it), then goes back on its path.
      const before = this.renderer.plainTextFor;
      const now = id && editor.doc.get(id, 'textPath') ? id : null;
      if (before !== now) {
        this.renderer.plainTextFor = now;
        const areas = [before, now].filter((x): x is NodeId => !!x && editor.doc.store.isAlive(x)).map((x) => editor.scene.renderBounds(x));
        editor.scene.damageAreas(areas);
      }
      if (id) this.beginTextEditing(id);
      else this.endTextEditing();
    });
    editor.events.on('textSelection', () => this.onTextSelection());
    editor.events.on('tool', (tool) => {
      if (tool !== 'pen' && tool !== 'select') this.pen = null;
      this.updateCursor();
      // The eraser's circle and the "+" handles belong to tools: they go with them.
      this.request(false);
    });
    editor.events.on('vectorEdit', (edit) => {
      // The pen's place is forgotten when another tool takes over.
      if (!edit || edit.tool !== 'pen') this.pen = null;
      if (!edit || edit.tool !== 'bucket') this.bucketHover = null;
      if (!edit || edit.tool !== 'scissors') this.scissorsHover = null;
      this.updateVectorBar();
      this.request();
    });
    editor.events.on('shapeBuilder', () => {
      this.builderHover = -1;
      this.updateBuilderBar();
      this.updateCursor();
      this.request();
    });
    editor.events.on('view', (view) => {
      this.renderer.outlines = view.outlines ? { hidden: view.outlineHidden, bounds: view.outlineBounds } : null;
      this.updateOutlineBadge();
      this.refreshAll();
    });
    // Alt shows measurements without moving the pointer (FR-CNV-042).
    const alt = (down: boolean) => {
      if (this.altDown === down) return;
      this.altDown = down;
      this.updateMeasure();
      if (this.editor.shapeBuilder) this.request();
    };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Alt') alt(true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Alt') alt(false);
    });
    window.addEventListener('blur', () => alt(false));
  }

  focus(): void {
    this.canvas.focus({ preventScroll: true });
  }

  /** A second finger came down: what the first one began is undone, the pinch takes over. */
  cancelPointer(): void {
    if (this.mode.kind !== 'idle') this.cancelMode();
    this.mode = { kind: 'idle' };
    this.request();
  }

  /** Cancels the current pointer interaction (Esc). Returns true if something was cancelled. */
  cancelMode(): boolean {
    const mode = this.mode;
    if (mode.kind === 'board') this.board.cancel();
    if (mode.kind === 'move' || mode.kind === 'resize' || mode.kind === 'rotate' || mode.kind === 'radius' || mode.kind === 'warp' || mode.kind === 'arc') mode.gesture.cancel();
    if (mode.kind === 'gradient' && mode.gesture) mode.gesture.cancel();
    this.radiusLabel = null;
    if (mode.kind === 'create' && mode.gesture) mode.gesture.cancel();
    if (mode.kind === 'vec-handle' || mode.kind === 'vec-bend' || mode.kind === 'pen-drag') mode.gesture.cancel();
    if (mode.kind === 'vec-points' && mode.gesture) mode.gesture.cancel();
    if (mode.kind === 'vec-erase' || mode.kind === 'vec-transform' || mode.kind === 'vec-width') mode.gesture.cancel();
    let active = mode.kind !== 'idle';
    if (!active && (this.editor.tool === 'eyedropper' || this.editor.tool === 'comment')) {
      this.editor.setTool('select');
      active = true;
    }
    // Esc with the pen: first the path being drawn ends, then point editing.
    if (!active && this.pen?.last != null && this.editor.vectorEdit?.tool === 'pen') {
      this.pen.last = null;
      this.pen.out = null;
      active = true;
    }
    if (!active && this.editor.vectorEdit) {
      this.finishVectorEdit();
      active = true;
    }
    if (!active && this.editor.shapeBuilder) {
      this.editor.setShapeBuilder(null);
      active = true;
    }
    // Esc with gradient handles shown hides them first.
    if (!active && this.editor.gradientEdit) {
      this.editor.setGradientEdit(null);
      active = true;
    }
    // Then the perspective corners: the layer stays selected.
    if (!active && this.editor.warpEdit) {
      this.editor.setWarpEdit(null);
      active = true;
    }
    if (mode.kind === 'guide' && mode.gesture) mode.gesture.cancel();
    if (mode.kind === 'spacing' || mode.kind === 'al-handle') mode.gesture.cancel();
    this.mode = { kind: 'idle' };
    this.editor.marquee = null;
    this.editor.guides = [];
    this.editor.spacing = [];
    this.editor.distances = [];
    this.editor.dropTarget = null;
    this.request();
    return active;
  }

  // ---------- rendering ----------

  /** `content: false` — only the view, hover or selection changed (a heavy page may reuse its picture). */
  request(content = true): void {
    if (content) this.contentDirty = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /**
   * The page as last drawn, kept when drawing it is slow (thousands of layers
   * in view): while the view only moves or zooms, this picture is shown moved
   * and scaled, and the page is drawn anew once the view rests.
   */
  private cache: { canvas: HTMLCanvasElement; zoom: number; offsetX: number; offsetY: number; width: number; height: number; dpr: number } | null = null;
  /** The page as tiles on the GPU; null — drawn by Canvas 2D each time (no WebGL 2, or turned off). */
  private readonly tiles: TileLayer | null;

  /** A gesture is going on (dragging, resizing, drawing): heavy background work waits. */
  get busy(): boolean {
    return this.mode.kind !== 'idle';
  }

  /** Something outside the document changed how everything looks (theme, fonts, pictures loaded, view settings). */
  refreshAll(): void {
    this.editor.scene.damageEverything();
    this.request();
  }
  private contentDirty = true;
  private settle: ReturnType<typeof setTimeout> | null = null;

  private drawContent(width: number, height: number): void {
    const vp = this.editor.viewport;
    // The eyedropper reads the pixels of this canvas: the page is drawn here then.
    // Pixel preview, magnified: one small picture of the page, enlarged without smoothing (not tiles).
    const preview = this.editor.view.pixelPreview;
    const pixels = preview > 0 && vp.zoom * this.dpr > preview;
    const gpu = this.tiles !== null && this.tiles.usable && this.editor.tool !== 'eyedropper' && !pixels;
    if (this.tiles) {
      this.tiles.canvas.hidden = !gpu;
      if (!gpu) this.dropLift();
      const damage = this.editor.scene.takeDamage();
      this.tiles.damage(damage.all || !gpu, damage.rects);
    }
    if (gpu) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const page = this.editor.doc.get(this.editor.pageId, 'backgroundColor');
      // Before the tiles take the damage: dropping the lift damages where the layers are now.
      const offset = this.liftOffset();
      if (!this.lifted) {
        const late = this.editor.scene.takeDamage();
        this.tiles!.damage(late.all, late.rects);
      }
      const done = this.tiles!.render(this.editor.scene, vp, width, height, this.dpr, this.renderer.pageBackground ? this.renderer.pageBackground(page) : page, offset);
      this.lastStats = { drawn: this.tiles!.stats.drawn, culled: this.tiles!.stats.missing, ms: this.tiles!.stats.ms };
      this.cache = null;
      // Tiles still to draw: the next frame goes on with them.
      if (!done) this.request(false);
      return;
    }
    if (pixels) {
      this.drawPixelPreview(width, height, preview);
      this.cache = null;
      return;
    }
    const c = this.cache;
    const same = c && !this.contentDirty && c.width === width && c.height === height && c.dpr === this.dpr;
    if (same && (c.zoom !== vp.zoom || c.offsetX !== vp.offsetX || c.offsetY !== vp.offsetY)) {
      const k = vp.zoom / c.zoom;
      const ctx = this.ctx;
      const page = this.editor.doc.get(this.editor.pageId, 'backgroundColor');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = cssColor(this.renderer.pageBackground ? this.renderer.pageBackground(page) : page);
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * (vp.offsetX - c.offsetX * k), this.dpr * (vp.offsetY - c.offsetY * k));
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(c.canvas, 0, 0, width, height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (this.settle) clearTimeout(this.settle);
      this.settle = setTimeout(() => {
        this.settle = null;
        this.request();
      }, 120);
      return;
    }
    if (same && c.zoom === vp.zoom && c.offsetX === vp.offsetX && c.offsetY === vp.offsetY) {
      // Nothing moved (hover, selection): the picture as it is.
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.drawImage(c.canvas, 0, 0);
      return;
    }
    this.contentDirty = false;
    this.lastStats = this.renderer.renderPage({ ctx: this.ctx, width, height, dpr: this.dpr }, this.editor.scene, this.editor.viewport);
    if (this.lastStats.ms < 16) {
      this.cache = null;
      return;
    }
    const canvas = this.cache?.canvas ?? document.createElement('canvas');
    if (canvas.width !== this.canvas.width || canvas.height !== this.canvas.height) {
      canvas.width = this.canvas.width;
      canvas.height = this.canvas.height;
    }
    canvas.getContext('2d')!.drawImage(this.canvas, 0, 0);
    this.cache = { canvas, zoom: vp.zoom, offsetX: vp.offsetX, offsetY: vp.offsetY, width, height, dpr: this.dpr };
  }

  private pixelCanvas: HTMLCanvasElement | null = null;

  /** The visible page drawn at `scale` pixels per unit (aligned to the design's pixel grid), then laid over the screen in big square pixels. */
  private drawPixelPreview(width: number, height: number, scale: number): void {
    const vp = this.editor.viewport;
    const area = vp.visibleRect(width, height);
    const x0 = Math.floor(area.x * scale) / scale;
    const y0 = Math.floor(area.y * scale) / scale;
    const w = Math.max(1, Math.ceil((area.x + area.width - x0) * scale) + 1);
    const h = Math.max(1, Math.ceil((area.y + area.height - y0) * scale) + 1);
    const canvas = (this.pixelCanvas ??= document.createElement('canvas'));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const small = new Viewport();
    small.zoom = scale;
    small.offsetX = -x0 * scale;
    small.offsetY = -y0 * scale;
    this.contentDirty = false;
    this.lastStats = this.renderer.renderPage({ ctx: canvas.getContext('2d')!, width: w, height: h, dpr: 1 }, this.editor.scene, small);
    const ctx = this.ctx;
    const k = (vp.zoom * this.dpr) / scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, (x0 * vp.zoom + vp.offsetX) * this.dpr, (y0 * vp.zoom + vp.offsetY) * this.dpr, w * k, h * k);
    ctx.imageSmoothingEnabled = true;
  }

  private resize(): void {
    const rect = this.element.getBoundingClientRect();
    const first = this.editor.screenSize.width === 800 && this.editor.screenSize.height === 600;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    if (this.tiles) {
      this.tiles.resize(this.canvas.width, this.canvas.height);
      this.tiles.canvas.style.width = `${rect.width}px`;
      this.tiles.canvas.style.height = `${rect.height}px`;
    }
    // A slide whole in view stays whole when the view changes size (the notes under it pulled up, FEAT-166).
    const wholeSlide = !first && this.editor.stageFitted();
    this.editor.screenSize = { width: rect.width, height: rect.height };
    if (first) this.editor.zoomToFit();
    else if (wholeSlide) this.editor.fitStage();
    else if (this.editor.slideStage) this.editor.requestViewport();
    this.render();
  }

  /** Next redraw of moving fills (videos, animated GIFs) — about 30 frames a second while one is in view. */
  private motion: ReturnType<typeof setTimeout> | null = null;

  render(): void {
    const { width, height } = this.editor.screenSize;
    // Warped layers are made coarser during a gesture (a resize remakes them every frame), in full after it.
    this.renderer.draft = this.busy;
    if (!this.busy && this.renderer.drafted.size > 0) {
      const scene = this.editor.scene;
      const ids = [...this.renderer.drafted].filter((id) => this.editor.doc.store.isAlive(id));
      this.renderer.drafted.clear();
      scene.damageAreas(ids.map((id) => scene.renderBounds(id)));
      this.contentDirty = true;
    }
    this.drawContent(width, height);
    if (this.renderer.animated.size > 0 && !this.motion) {
      this.motion = setTimeout(() => {
        this.motion = null;
        const scene = this.editor.scene;
        const ids = [...this.renderer.animated].filter((id) => this.editor.doc.store.isAlive(id));
        this.renderer.animated.clear();
        if (ids.length === 0) return;
        scene.damageAreas(ids.map((id) => scene.renderBounds(id)));
        this.request();
      }, 33);
    }
    // The eyedropper reads the rendered content before overlays are drawn on top.
    this.loupe = this.editor.tool === 'eyedropper' && this.pointer ? this.sample(this.pointer) : null;
    this.drawOverlay();
    this.onStats?.(this.lastStats);
  }

  private screenPoint(p: Point): Point {
    return this.editor.viewport.worldToScreen(p);
  }

  private nodeCorners(id: NodeId): Point[] {
    const d = this.editor.doc;
    // A layer dragged in auto layout: its outline goes with its picture.
    const shift = this.flowShift(id) ?? { x: 0, y: 0 };
    return transformCorners(this.editor.scene.world(id), { x: 0, y: 0, width: d.get(id, 'width'), height: d.get(id, 'height') }).map((p) => this.screenPoint({ x: p.x + shift.x, y: p.y + shift.y }));
  }

  private drawOverlay(): void {
    const ctx = this.ctx;
    const editor = this.editor;
    const d = editor.doc;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineJoin = 'miter';
    drawPixelGrid(ctx, editor);
    drawLayoutGrids(ctx, editor);
    drawGuides(ctx, editor, this.mode.kind === 'guide' && this.mode.owner ? { owner: this.mode.owner, index: this.mode.index } : this.hoverGuide);

    // Masks are invisible themselves: a dashed outline shows where a selected mask (or the mask inside a selected group) crops.
    const masks = editor.selection.flatMap((id) => (d.store.isAlive(id) ? [id, ...d.children(id)] : [])).filter((id) => d.get(id, 'isMask'));
    if (masks.length > 0) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#4F5BD5';
      ctx.lineWidth = 1;
      for (const id of masks) {
        const b = editor.scene.bounds(id);
        const a = this.screenPoint({ x: b.x, y: b.y });
        const c = this.screenPoint({ x: b.x + b.width, y: b.y + b.height });
        ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
      }
      ctx.restore();
    }

    // Titles of top-level frames, components and sets; variant names inside sets.
    this.labels = [];
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'bottom';
    const titled: NodeId[] = [];
    const sections: NodeId[] = [];
    // Groups do not make a frame "nested": titles show through any number of groups (BUG-003).
    const collect = (parent: NodeId) => {
      for (const id of d.children(parent)) {
        const type = d.type(id);
        if (!d.get(id, 'visible')) continue;
        if (type === 'GROUP') collect(id);
        // Sections keep their content "top level": frames inside them get titles too.
        if (type === 'SECTION') {
          sections.push(id);
          collect(id);
          continue;
        }
        if (!['FRAME', 'COMPONENT', 'COMPONENT_SET'].includes(type)) continue;
        // Stickies, shapes, stamps and labels of a board are objects, not screens: no title over them.
        if (d.get(id, 'board')) continue;
        // A slide on show is the paper itself: no title over it (FEAT-165).
        if (this.editor.isPinned(id)) continue;
        titled.push(id);
        if (type === 'COMPONENT_SET') for (const v of d.children(id)) if (d.get(v, 'visible')) titled.push(v);
      }
    };
    collect(editor.pageId);
    const screen = editor.screenSize;
    for (const id of sections) this.drawSectionTitle(ctx, id);
    const protoFlows = editor.prototype.mode === 'prototype' ? editor.prototype.flows() : [];
    for (const id of titled) {
      const type = d.type(id);
      const isComponent = type === 'COMPONENT' || type === 'COMPONENT_SET';
      const inSet = type === 'COMPONENT' && d.type(d.parent(id)!) === 'COMPONENT_SET';
      const p = this.screenPoint(apply(editor.scene.world(id), { x: 0, y: 0 }));
      const prefix = type === 'COMPONENT_SET' ? '❖ ' : isComponent ? '◇ ' : '';
      const name = prefix + d.get(id, 'name');
      const maxWidth = Math.max(0, d.get(id, 'width') * editor.viewport.zoom);
      if (maxWidth < 24) continue;
      // Off screen: no title to measure (a page with thousands of frames spent ~10 ms a frame here).
      if (p.x > screen.width || p.x + maxWidth < 0 || p.y < 0 || p.y - 40 > screen.height) continue;
      // Variant labels sit inside the set's padding, so they are drawn smaller and only when there is room.
      if (inSet && editor.viewport.zoom < 0.5) continue;
      const text = ellipsize(ctx, name, maxWidth);
      const w = ctx.measureText(text).width;
      // A frame title under a section's title pill would be unreadable: the pill wins.
      const under = { x: p.x, y: p.y - 18, width: w, height: 16 };
      if (this.labels.some((l) => sections.includes(l.id) && intersects(l.rect, under))) continue;
      const selected = editor.selection.includes(id);
      const base = isComponent ? COMPONENT_ACCENT : '#8A8A8A';
      ctx.fillStyle = selected ? (isComponent ? COMPONENT_ACCENT : ACCENT) : editor.hover === id ? (isComponent ? COMPONENT_ACCENT : '#333') : base;
      ctx.globalAlpha = isComponent && !selected && editor.hover !== id ? 0.85 : 1;
      ctx.fillText(text, p.x, p.y - 4);
      ctx.globalAlpha = 1;
      this.labels.push({ id, rect: { x: p.x, y: p.y - 18, width: w, height: 16 } });
      // Flow start flag above the title on the Prototype tab (FR-PRT-002).
      const flow = protoFlows.find((f) => f.nodeId === id);
      if (flow) {
        const fw = drawFlowFlag(ctx, { x: p.x, y: p.y - 19 }, flow.name, maxWidth);
        this.labels.push({ id, rect: { x: p.x, y: p.y - 39, width: fw, height: 17 } });
        ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.textBaseline = 'bottom';
      }
      // Mode badge where a frame switches a variable mode (FR-VAR-012).
      const modes = d.get(id, 'variableModes');
      if (modes && text === name) {
        const names = Object.entries(modes)
          .map(([c, m]) => {
            if (!d.store.isAlive(c)) return undefined;
            const mode = d.get(c, 'modes').find((x) => x.id === m)?.name;
            // An extended collection names itself: «Бренд Б · Тёмная» (FR-VAR-013).
            return mode && d.get(c, 'extendsCollection') ? `${d.get(c, 'name')} · ${mode}` : mode;
          })
          .filter(Boolean)
          .join(', ');
        const room = maxWidth - w - 10;
        if (names && room > 30) {
          const badge = ellipsize(ctx, `◐ ${names}`, room - 8);
          const bw = ctx.measureText(badge).width + 8;
          const bx = p.x + w + 6;
          ctx.fillStyle = 'rgba(79, 91, 213, 0.12)';
          ctx.beginPath();
          ctx.roundRect(bx, p.y - 17, bw, 14, 3);
          ctx.fill();
          ctx.fillStyle = ACCENT;
          ctx.fillText(badge, bx + 4, p.y - 4.5);
        }
      }
    }

    // Instances of the selected component are outlined (BUG-028): editing the main
    // component changes them too, so the link is visible before it surprises.
    this.drawLinkedInstances();

    // Hover outline.
    if (editor.hover && !editor.selection.includes(editor.hover) && d.store.isAlive(editor.hover)) {
      this.strokePolygon(this.nodeCorners(editor.hover), this.accentFor(editor.hover), 1.5);
    }

    // Multi-edit variants: a dotted outline round each variant that takes the edits (as in Figma).
    if (editor.variantEdit && d.store.isAlive(editor.variantEdit)) {
      ctx.setLineDash([4, 3]);
      for (const v of d.children(editor.variantEdit)) if (d.type(v) === 'COMPONENT') this.strokePolygon(this.nodeCorners(v), COMPONENT_ACCENT, 1);
      ctx.setLineDash([]);
    }

    // Selection outlines, handles and size label.
    const selection = editor.topLevelSelection();
    if (selection.length > 0 && editor.editingText === null && !editor.vectorEdit && !editor.shapeBuilder) {
      for (const id of selection) if (!isConnector(d, id)) this.strokePolygon(this.nodeCorners(id), this.accentFor(id), 1);
      const handles = this.handles();
      const accent = selection.every((id) => this.accentFor(id) === COMPONENT_ACCENT) ? COMPONENT_ACCENT : ACCENT;
      if (handles) {
        this.strokePolygon(handles.corners, accent, 1);
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        // A locked object on a board does not resize: no handles to promise it (the lock is drawn instead).
        // Nor a slide (FEAT-165): the format sets its size; in «Все слайды» it is only dragged to another place.
        const fixed = (editor.isBoardFile() && selection.some((id) => !editor.canTransform(id))) || selection.some((id) => editor.isSlide(id) || editor.isTableCell(id));
        for (const h of fixed ? [] : handles.points) {
          ctx.fillRect(h.p.x - HANDLE / 2, h.p.y - HANDLE / 2, HANDLE, HANDLE);
          ctx.strokeRect(h.p.x - HANDLE / 2 + 0.5, h.p.y - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1);
        }
        const knob = fixed ? null : this.rotateHandle();
        if (knob) this.drawRotateHandle(knob, accent);
        // Board objects: no size tag (the "+" handle is under them).
        if (!(selection.length === 1 && d.get(selection[0]!, 'board'))) this.drawSizeLabel(handles.corners, handles.size, accent);
      }
      this.drawSpacingHandles();
      this.drawAlHandles();
      // Corner radius handles (FEAT-013).
      this.drawGradientHandles();
      this.drawWarpHandles(accent);
      this.drawArcHandles(accent);
      this.drawOrigin(accent);
      const radius = this.editor.gradientEdit || this.warpHandles() ? null : this.radiusHandles();
      if (radius) {
        for (const r of radius.points) {
          ctx.beginPath();
          ctx.arc(r.p.x, r.p.y, RADIUS_HANDLE / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (this.radiusLabel) this.drawTag(this.radiusLabel.p, this.radiusLabel.text, accent);
      }
    } else if (editor.editingText) {
      this.strokePolygon(this.nodeCorners(editor.editingText), ACCENT, 1);
      for (const m of editor.textMirrors) if (editor.doc.store.isAlive(m)) this.strokePolygon(this.nodeCorners(m), ACCENT, 1);
      this.drawTextEditing();
    }

    this.drawVectorEdit();

    // Prototype tab: connections, the "+" handle and a connection being dragged (FR-PRT-001).
    if (editor.prototype.mode === 'prototype') {
      drawConnections(ctx, editor);
      const handle = this.connectHandle();
      if (handle && this.mode.kind !== 'connect') drawConnectHandle(ctx, handle.p, this.hoverConnect);
      if (this.mode.kind === 'connect') {
        drawConnectHandle(ctx, this.mode.from, true);
        drawPendingConnection(ctx, editor, this.mode.from, this.mode.to, this.mode.target);
      }
    }

    // Drop target while dragging into a frame.
    if (editor.dropTarget && editor.dropTarget.parent !== editor.pageId && d.store.isAlive(editor.dropTarget.parent)) {
      this.strokePolygon(this.nodeCorners(editor.dropTarget.parent), ACCENT, 2);
    }
    this.drawGridCells();
    this.drawTableGrabbers();

    // Snap guides.
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1;
    for (const g of editor.guides) this.drawGuide(g);

    // Marquee.
    if (editor.marquee) {
      const a = this.screenPoint({ x: editor.marquee.x, y: editor.marquee.y });
      const b = this.screenPoint({ x: editor.marquee.x + editor.marquee.width, y: editor.marquee.y + editor.marquee.height });
      ctx.fillStyle = 'rgba(79, 91, 213, 0.08)';
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = ACCENT;
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    }

    // Equal gaps, distances, a guide being dragged out of a ruler, the rulers, the loupe.
    drawSpacing(ctx, editor, editor.spacing);
    drawMeasurements(ctx, editor, editor.distances, editor.distanceHelpers);
    if (this.mode.kind === 'guide' && this.mode.owner === null && !this.mode.overRuler) drawNewGuide(ctx, editor, this.mode.axis, this.mode.at);
    drawRulers(ctx, editor, editor.selection.length > 0 ? editor.selectionBounds() : null, isDark());
    if (this.mode.kind === 'guide' && !this.mode.overRuler) this.drawGuideLabel(this.mode.axis, this.mode.at);
    if (this.loupe && this.pointer) drawLoupe(ctx, this.pointer, this.loupe.pixels, this.lastMod ? this.loupe.average : this.loupe.color);
    this.board.draw(ctx);
    if (this.mode.kind === 'pencil') this.drawPencil(this.mode.points, this.mode.ink);
    this.drawBuilder();
  }

  /** The builder's area under the pointer (-1 — none). */
  private builderHover = -1;

  private builderCellAt(world: Point): number {
    const builder = this.editor.shapeBuilder;
    if (!builder) return -1;
    const parent = this.editor.doc.parent(builder.ids[0]!)!;
    return cellAt(builder.cells, this.editor.toParentSpace(parent, world));
  }

  /**
   * Every area outlined (white under the accent: seen on any fill); the one under the pointer and
   * the chosen ones lightened and ringed (red, darkened — to be removed). A tint of the accent over
   * the shape's own colour came out muddy and read as nothing.
   */
  private drawBuilder(): void {
    const builder = this.editor.shapeBuilder;
    if (!builder) return;
    const ctx = this.ctx;
    const m = this.editor.scene.world(this.editor.doc.parent(builder.ids[0]!)!);
    const mode = this.mode.kind === 'builder' ? this.mode : null;
    const chosen = new Set(mode ? mode.chosen : this.builderHover >= 0 ? [this.builderHover] : []);
    const remove = mode ? mode.remove : this.altDown;
    const trace = (i: number) => {
      ctx.beginPath();
      for (const contour of builder.cells[i]!.region.contours) {
        contour.forEach((q, k) => {
          const p = this.screenPoint(apply(m, q));
          if (k === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
      }
    };
    builder.cells.forEach((_, i) => {
      if (chosen.has(i)) return;
      trace(i);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    for (const i of chosen) {
      if (!builder.cells[i]) continue;
      trace(i);
      ctx.fillStyle = remove ? 'rgba(0, 0, 0, 0.35)' : 'rgba(255, 255, 255, 0.45)';
      ctx.fill('nonzero');
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = remove ? '#E5484D' : ACCENT;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  /** The bar of the shape builder over the canvas: what the gestures do, and done. */
  private builderBar: HTMLElement | null = null;
  private outlineBar: HTMLElement | null = null;

  /** Outline view on: a bar in the canvas corner with its options and the way out (one does not forget it is on). */
  private updateOutlineBadge(): void {
    const view = this.editor.view;
    this.outlineBar?.remove();
    this.outlineBar = null;
    if (!view.outlines) return;
    const toggle = (label: string, title: string, on: boolean, patch: () => Partial<typeof view>) =>
      h('button', { class: `vector-bar-tool${on ? ' active' : ''}`, type: 'button', title, 'aria-pressed': String(on), onclick: () => this.editor.setView(patch()) }, label);
    this.outlineBar = h(
      'div',
      { class: 'vector-bar outline-bar', role: 'toolbar', 'aria-label': tr('Контурный режим') },
      h('span', { class: 'vector-bar-hint' }, tr('Контуры')),
      toggle(tr('Скрытые слои'), tr('Показывать и выделять скрытые слои'), view.outlineHidden, () => ({ outlineHidden: !view.outlineHidden })),
      toggle(tr('Рамки'), tr('Показывать рамку каждого объекта'), view.outlineBounds, () => ({ outlineBounds: !view.outlineBounds })),
      h('button', { class: 'vector-bar-tool', type: 'button', title: tr('Выйти из контурного режима ({0})', IS_MAC ? '⇧⌘O' : 'Ctrl+Shift+O'), onclick: () => this.editor.setView({ outlines: false }) }, tr('Готово')),
    );
    this.element.append(this.outlineBar);
  }

  private updateBuilderBar(): void {
    if (!this.editor.shapeBuilder) {
      this.builderBar?.remove();
      this.builderBar = null;
      return;
    }
    if (this.builderBar) return;
    this.builderBar = h(
      'div',
      { class: 'vector-bar', role: 'toolbar', 'aria-label': tr('Конструктор фигур') },
      h('span', { class: 'vector-bar-hint' }, tr('Щелчок — отделить область · протяните — слить · Alt+щелчок — удалить')),
      h('button', { class: 'text-button primary', type: 'button', onclick: () => this.editor.setShapeBuilder(null) }, tr('Готово')),
    );
    this.element.append(this.builderBar);
  }

  /** The sketch being drawn, as it will look: a round stroke of the pencil's width. */
  private drawPencil(points: readonly Point[], ink: Color): void {
    const ctx = this.ctx;
    ctx.strokeStyle = cssColor(ink);
    ctx.lineWidth = this.editor.boardPrefs.pencilSize * this.editor.viewport.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    points.forEach((q, i) => {
      const p = this.screenPoint(q);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    if (points.length === 1) ctx.lineTo(this.screenPoint(points[0]!).x + 0.01, this.screenPoint(points[0]!).y);
    ctx.stroke();
  }

  /** Pencil ink: the one chosen in the tool's bar, or as in Figma — black, white on a dark frame or canvas under the sketch. */
  private pencilInk(parent: NodeId): Color {
    const chosen = this.editor.boardPrefs.pencilInk;
    const own = chosen ? hexToColor(chosen) : null;
    if (own) return own;
    const d = this.editor.doc;
    let under: Color | null = null;
    for (let id: NodeId | null = parent; id && !under; id = d.parent(id)) {
      if (id === this.editor.pageId) under = shownPageBackground(d.get(id, 'backgroundColor'));
      else {
        const fill = d.get(id, 'fills').findLast((f) => f.visible && f.type === 'SOLID');
        if (fill && fill.type === 'SOLID' && fill.opacity * fill.color.a > 0.5) under = fill.color;
      }
    }
    const light = under ? 0.2126 * under.r + 0.7152 * under.g + 0.0722 * under.b : 1;
    return light < 0.4 ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 1 };
  }

  /** The sketch becomes a vector layer in the frame where it began; the pencil stays on to draw more. */
  private finishPencil(points: readonly Point[], parent: NodeId, ink: Color): void {
    const editor = this.editor;
    const raw = points.length === 1 ? [points[0]!, { x: points[0]!.x + 0.01, y: points[0]!.y }] : points;
    const local = raw.map((p) => editor.toParentSpace(parent, p));
    const smooth = smoothStroke(local, 1.2 / Math.max(0.1, editor.viewport.zoom));
    const xs = smooth.flatMap((p) => [p.x, p.in?.x ?? p.x, p.out?.x ?? p.x]);
    const ys = smooth.flatMap((p) => [p.y, p.in?.y ?? p.y, p.out?.y ?? p.y]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const shift = (q: Point) => ({ x: round2(q.x - x), y: round2(q.y - y) });
    const path = { closed: false, points: smooth.map((p) => ({ ...shift(p), ...(p.in ? { in: shift(p.in) } : {}), ...(p.out ? { out: shift(p.out) } : {}) })) };
    let id = '';
    editor.commit(tr('Карандаш'), (tx) => {
      id = tx.create('VECTOR', parent, {
        name: editor.nextName('VECTOR'),
        x: round2(x),
        y: round2(y),
        width: round2(Math.max(...xs) - x),
        height: round2(Math.max(...ys) - y),
        vectorPaths: [path],
        fills: [],
        strokes: [solid(ink)],
        strokeWeight: editor.boardPrefs.pencilSize,
        strokeAlign: 'CENTER',
        strokeCap: 'ROUND',
        strokeJoin: 'ROUND',
      });
    }, () => []);
    if (id) editor.setSelection([id]);
  }

  /**
   * Cells of a grid: dashed for a selected grid frame (or the grid of a
   * selected layer), and the cell a dragged layer would take, filled.
   */
  private drawGridCells(): void {
    const editor = this.editor;
    const d = editor.doc;
    const frames = new Set<NodeId>();
    for (const id of editor.selection) {
      if (!d.store.isAlive(id)) continue;
      if (d.get(id, 'layoutMode') === 'GRID') frames.add(id);
      const parent = d.parent(id);
      if (parent && d.get(parent, 'layoutMode') === 'GRID') frames.add(parent);
    }
    const drop = editor.dropTarget?.cell ? editor.dropTarget : null;
    if (drop) frames.add(drop.parent);
    const ctx = this.ctx;
    for (const frame of frames) {
      // A table shows its own handles instead (FEAT-170): its lines are the grid.
      if (d.get(frame, 'table')) continue;
      const g = editor.gridGeometry(frame);
      if (!g) continue;
      const world = editor.scene.world(frame);
      const rect = (x: number, y: number, w: number, h: number) => transformCorners(world, { x, y, width: w, height: h }).map((p) => this.screenPoint(p));
      ctx.save();
      ctx.setLineDash([3, 3]);
      for (const r of g.rows) for (const c of g.columns) this.strokePolygon(rect(c.start, r.start, c.size, r.size), 'rgba(151,71,255,0.55)', 1);
      ctx.restore();
      if (drop && drop.parent === frame && drop.cell) {
        const c = g.columns[drop.cell.column];
        const r = g.rows[drop.cell.row];
        const rowGap = d.get(frame, 'gridRowGap');
        const last = g.rows[g.rows.length - 1];
        const top = r ? r.start : last ? last.start + last.size + rowGap : 0;
        const height = r ? r.size : (last?.size ?? 40);
        if (c) {
          const pts = rect(c.start, top, c.size, height);
          ctx.save();
          ctx.fillStyle = 'rgba(79, 91, 213, 0.15)';
          ctx.beginPath();
          pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          this.strokePolygon(pts, ACCENT, 1.5);
        }
      }
    }
  }

  // ---------- tables: row and column handles, ranges of cells (FEAT-170, as in FigJam) ----------

  /** The table whose handles show: the selected one, or the one the selected cells or texts are in. */
  private handledTable(): NodeId | null {
    const editor = this.editor;
    const d = editor.doc;
    if (editor.tool !== 'select' || editor.editingText || editor.vectorEdit || editor.selection.length === 0) return null;
    const table = tableOf(d, editor.selection[0]!);
    if (!table || d.get(table, 'locked') || editor.selection.some((id) => tableOf(d, id) !== table)) return null;
    return table;
  }

  /** A handle left of every row and above every column (on screen). */
  private tableGrabbers(): { table: NodeId; axis: 'row' | 'col'; index: number; quad: Point[] }[] {
    const table = this.handledTable();
    const g = table ? this.editor.gridGeometry(table) : null;
    if (!table || !g) return [];
    const z = this.editor.viewport.zoom;
    const world = this.editor.scene.world(table);
    const off = 5 / z;
    const size = 7 / z;
    const quad = (x: number, y: number, w: number, h: number) => transformCorners(world, { x, y, width: Math.max(0, w), height: Math.max(0, h) }).map((p) => this.screenPoint(p));
    const inset = (n: number) => Math.min(2 / z, n / 4);
    return [
      ...g.columns.map((c, index) => ({ table, axis: 'col' as const, index, quad: quad(c.start + inset(c.size), -off - size, c.size - 2 * inset(c.size), size) })),
      ...g.rows.map((r, index) => ({ table, axis: 'row' as const, index, quad: quad(-off - size, r.start + inset(r.size), size, r.size - 2 * inset(r.size)) })),
    ];
  }

  private grabberAt(screen: Point): { table: NodeId; axis: 'row' | 'col'; index: number } | null {
    return this.tableGrabbers().find((g) => this.insidePolygon(screen, g.quad)) ?? null;
  }

  private drawTableGrabbers(): void {
    const editor = this.editor;
    const d = editor.doc;
    const ctx = this.ctx;
    const selected = new Set(editor.selection);
    // Selected cells are tinted, as a range in a spreadsheet.
    const cells = editor.selection.filter((id) => editor.isTableCell(id));
    ctx.save();
    if (cells.length > 1) {
      ctx.fillStyle = 'rgba(79, 91, 213, 0.12)';
      for (const id of cells) {
        ctx.beginPath();
        this.nodeCorners(id).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
      }
    }
    const list = this.tableGrabbers();
    if (list.length) {
      const { cols, cells: all } = tableShape(d, list[0]!.table);
      // A row (column) is selected when all its cells are.
      const whole = (axis: 'row' | 'col', index: number) => {
        const line = all.filter((c, i) => (axis === 'row' ? Math.floor(i / cols) : i % cols) === index && d.get(c, 'visible'));
        return line.length > 0 && line.every((c) => selected.has(c));
      };
      for (const g of list) {
        const on = whole(g.axis, g.index);
        const hover = this.hoverGrabber === `${g.axis}${g.index}`;
        ctx.fillStyle = on ? ACCENT : hover ? 'rgba(79, 91, 213, 0.55)' : 'rgba(138, 138, 138, 0.28)';
        ctx.beginPath();
        g.quad.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** The row and column of a table at a point (the nearest ones when past its edges). */
  private tablePlaceAt(table: NodeId, world: Point): { row: number; col: number } | null {
    const g = this.editor.gridGeometry(table);
    const inv = invert(this.editor.scene.world(table));
    if (!g || !inv) return null;
    const p = apply(inv, world);
    const index = (tracks: readonly { start: number }[], v: number) => {
      let at = 0;
      tracks.forEach((t, i) => {
        if (v >= t.start) at = i;
      });
      return at;
    };
    return { row: index(g.rows, p.y), col: index(g.columns, p.x) };
  }

  /** Selects the cells from the anchor to `at`: a rectangle, or whole rows or columns. */
  private selectTableRange(mode: Extract<Mode, { kind: 'table-cells' }>, at: { row: number; col: number }): void {
    const d = this.editor.doc;
    const key = `${at.row}:${at.col}`;
    if (key === mode.last) return;
    mode.last = key;
    const { rows, cols } = tableShape(d, mode.table);
    const a = mode.axis === 'row' ? { row: mode.anchor.row, col: 0 } : mode.axis === 'col' ? { row: 0, col: mode.anchor.col } : mode.anchor;
    const b = mode.axis === 'row' ? { row: at.row, col: cols - 1 } : mode.axis === 'col' ? { row: rows - 1, col: at.col } : at;
    this.editor.setSelection([...new Set([...mode.base, ...cellsBetween(d, mode.table, a, b)])]);
    this.request();
  }

  /** A press on a row or column handle: that row (column); Shift — up to it from the last one; Mod — added. */
  private pressGrabber(grab: { table: NodeId; axis: 'row' | 'col'; index: number }, e: PointerEvent): void {
    const prev = this.cellAnchor;
    const from = e.shiftKey && prev && prev.table === grab.table && prev.axis === grab.axis ? prev : { table: grab.table, axis: grab.axis, row: grab.index, col: grab.index };
    this.cellAnchor = from;
    const base = this.modKey(e) ? this.editor.selection.filter((id) => this.editor.isTableCell(id)) : [];
    const mode: Extract<Mode, { kind: 'table-cells' }> = { kind: 'table-cells', table: grab.table, axis: grab.axis, anchor: { row: from.row, col: from.col }, base, last: '' };
    this.mode = mode;
    this.selectTableRange(mode, { row: grab.index, col: grab.index });
  }

  /**
   * A press on a cell while the table's cells (or texts) are selected: that cell; Shift —
   * the rectangle from the last clicked one; Mod — added or taken out; dragging over
   * cells selects the rectangle. A selected table itself keeps its ways (a click picks a
   * cell, dragging moves it); Shift+click picks a range from its first cell.
   */
  private pressTableCell(top: NodeId | null, world: Point, e: PointerEvent): boolean {
    const editor = this.editor;
    const d = editor.doc;
    const sel = editor.selection;
    if (!top || sel.length === 0 || editor.editingText) return false;
    const table = tableOf(d, sel[0]!);
    if (!table || tableOf(d, top) !== table || sel.some((id) => tableOf(d, id) !== table)) return false;
    if (sel.length === 1 && sel[0] === table && !e.shiftKey) return false;
    const place = cellPlace(d, top) ?? this.tablePlaceAt(table, world);
    if (!place) return false;
    const { cols, cells } = tableShape(d, table);
    const cell = cells[place.row * cols + place.col];
    if (!cell) return false;
    if (this.modKey(e)) {
      editor.toggleSelection(cell);
      this.cellAnchor = { table, axis: 'cell', row: place.row, col: place.col };
      return true;
    }
    const prev = this.cellAnchor;
    const from = e.shiftKey ? (prev && prev.table === table && prev.axis === 'cell' ? prev : { table, axis: 'cell' as const, row: 0, col: 0 }) : { table, axis: 'cell' as const, row: place.row, col: place.col };
    this.cellAnchor = from;
    const mode: Extract<Mode, { kind: 'table-cells' }> = { kind: 'table-cells', table, axis: 'cell', anchor: { row: from.row, col: from.col }, base: [], last: '' };
    this.mode = mode;
    this.selectTableRange(mode, place);
    return true;
  }

  /** Dashed purple outlines around instances of the component the selection belongs to. */
  private drawLinkedInstances(): void {
    const editor = this.editor;
    const d = editor.doc;
    const components = new Set<NodeId>();
    for (const id of editor.selection) {
      let cur: NodeId | null = id;
      while (cur && d.type(cur) !== 'PAGE') {
        if (d.type(cur) === 'COMPONENT') components.add(cur);
        if (d.type(cur) === 'COMPONENT_SET') for (const v of d.children(cur)) components.add(v);
        if (d.type(cur) === 'INSTANCE') break;
        cur = d.parent(cur);
      }
    }
    if (components.size === 0) return;
    const ctx = this.ctx;
    let count = 0;
    ctx.save();
    ctx.setLineDash([4, 3]);
    d.store.walk(editor.pageId, (id) => {
      if (count > 300) return false;
      if (d.type(id) !== 'INSTANCE') return;
      const main = d.get(id, 'mainComponent');
      if (!main || !components.has(main) || editor.selection.includes(id)) return;
      count++;
      this.strokePolygon(this.nodeCorners(id), 'rgba(151, 71, 255, 0.75)', 1);
    });
    ctx.restore();
  }

  /** Handles in the gaps of an equally spaced selection: drag to change all gaps (FR-DRW-092). */
  private spacingHandles(): { axis: 'x' | 'y'; ids: NodeId[]; boxes: Rect[]; gap: number; points: Point[] } | null {
    const editor = this.editor;
    if (editor.selection.length < 2 || editor.editingText || editor.vectorEdit || (this.mode.kind !== 'idle' && this.mode.kind !== 'spacing')) return null;
    const eq = editor.equalSpacing();
    if (!eq) return null;
    const points: Point[] = [];
    for (let i = 0; i + 1 < eq.boxes.length; i++) {
      const a = eq.boxes[i]!;
      const b = eq.boxes[i + 1]!;
      const p =
        eq.axis === 'x'
          ? { x: a.x + a.width + eq.gap / 2, y: (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2 }
          : { x: (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2, y: a.y + a.height + eq.gap / 2 };
      points.push(this.screenPoint(p));
    }
    // Too small on screen to grab.
    if (eq.gap * editor.viewport.zoom < 6) return null;
    return { ...eq, points };
  }

  private spacingHandleAt(screen: Point): { axis: 'x' | 'y'; ids: NodeId[]; boxes: Rect[]; gap: number } | null {
    const h = this.spacingHandles();
    if (!h) return null;
    return h.points.some((p) => Math.abs(p.x - screen.x) <= 5 && Math.abs(p.y - screen.y) <= 9) ? h : null;
  }

  /**
   * Padding and gap handles of a selected row or column (as in Figma): a bar
   * in the middle of each padding and of each gap; hovered or dragged, its
   * strip turns pink and shows the value.
   */
  private alHandles(): { frame: NodeId; handles: AlHandle[] } | null {
    const editor = this.editor;
    const mode = this.mode;
    if (editor.tool !== 'select' || editor.selection.length !== 1 || editor.editingText || editor.vectorEdit || editor.doc.readOnly) return null;
    if (mode.kind !== 'idle' && mode.kind !== 'al-handle') return null;
    const id = editor.selection[0]!;
    const d = editor.doc;
    const layout = d.get(id, 'layoutMode');
    // A board object (a link card) keeps its own layout: no padding handles on it.
    if (!isFrameLike(d.type(id)) || (layout !== 'HORIZONTAL' && layout !== 'VERTICAL') || !editor.canTransform(id) || d.get(id, 'board')) return null;
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const zoom = editor.viewport.zoom;
    // Too small on screen: the handles would cover the frame.
    if (w * zoom < 48 || h * zoom < 48) return null;
    const world = editor.scene.world(id);
    const quad = (x: number, y: number, rw: number, rh: number) => transformCorners(world, { x: Math.min(x, x + rw), y: Math.min(y, y + rh), width: Math.abs(rw), height: Math.abs(rh) }).map((p) => this.screenPoint(p));
    const at = (x: number, y: number) => this.screenPoint(apply(world, { x, y }));
    // A small padding keeps its bar inside the edge, clear of the resize handles.
    const inset = 12 / zoom;
    const pt = d.get(id, 'paddingTop');
    const pr = d.get(id, 'paddingRight');
    const pb = d.get(id, 'paddingBottom');
    const pl = d.get(id, 'paddingLeft');
    const handles: AlHandle[] = [
      { side: 'paddingTop', p: at(w / 2, Math.max(pt / 2, inset)), along: 'x', regions: [quad(0, 0, w, pt)], value: pt },
      { side: 'paddingBottom', p: at(w / 2, h - Math.max(pb / 2, inset)), along: 'x', regions: [quad(0, h - pb, w, pb)], value: pb },
      { side: 'paddingLeft', p: at(Math.max(pl / 2, inset), h / 2), along: 'y', regions: [quad(0, 0, pl, h)], value: pl },
      { side: 'paddingRight', p: at(w - Math.max(pr / 2, inset), h / 2), along: 'y', regions: [quad(w - pr, 0, pr, h)], value: pr },
    ];
    // Gaps between neighbours in the flow (within a row when wrapping).
    const horizontal = layout === 'HORIZONTAL';
    const kids = d.children(id).filter((c) => d.get(c, 'visible') && d.get(c, 'positioning') === 'AUTO');
    const regions: Point[][] = [];
    let mid: Point | null = null;
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i]!;
      const b = kids[i + 1]!;
      const ax = d.get(a, 'x'), ay = d.get(a, 'y'), aw = d.get(a, 'width'), ah = d.get(a, 'height');
      const bx = d.get(b, 'x'), by = d.get(b, 'y'), bh = d.get(b, 'height'), bw = d.get(b, 'width');
      if (horizontal) {
        if (bx < ax) continue; // the next row
        const top = Math.min(ay, by);
        const bottom = Math.max(ay + ah, by + bh);
        regions.push(quad(ax + aw, top, bx - ax - aw, bottom - top));
        mid ??= at((ax + aw + bx) / 2, (top + bottom) / 2);
      } else {
        const left = Math.min(ax, bx);
        const right = Math.max(ax + aw, bx + bw);
        regions.push(quad(left, ay + ah, right - left, by - ay - ah));
        mid ??= at((left + right) / 2, (ay + ah + by) / 2);
      }
    }
    if (mid && d.get(id, 'spacingMode') === 'FIXED') handles.push({ side: 'itemSpacing', p: mid, along: horizontal ? 'y' : 'x', regions, value: d.get(id, 'itemSpacing') });
    return { frame: id, handles };
  }

  /**
   * A column border of a table under the pointer (FEAT-168): of the table the selection is
   * in, or of the one under the pointer. Its index (the column left of it), where it is in
   * the table's space, the columns' widths now.
   */
  private tableColumnAt(screen: Point): { table: NodeId; index: number; x: number; widths: number[]; inv: Matrix } | null {
    const editor = this.editor;
    if (editor.tool !== 'select' || editor.editingText || editor.vectorEdit || editor.doc.readOnly) return null;
    const world = editor.viewport.screenToWorld(screen);
    const d = editor.doc;
    const under = editor.scene.hitTest(world, { tolerance: 4 / editor.viewport.zoom })[0];
    const candidates = [editor.selection[0] ? tableOf(d, editor.selection[0]) : null, under ? tableOf(d, under) : null];
    for (const table of candidates) {
      if (!table || !d.store.isAlive(table) || d.get(table, 'locked')) continue;
      const g = editor.gridGeometry(table);
      const inv = invert(editor.scene.world(table));
      if (!g || !inv || g.columns.length < 2) continue;
      const p = apply(inv, world);
      if (p.y < 0 || p.y > d.get(table, 'height')) continue;
      const gap = d.get(table, 'gridColumnGap');
      const reach = 4 / editor.viewport.zoom;
      for (let i = 0; i < g.columns.length - 1; i++) {
        const c = g.columns[i]!;
        const x = c.start + c.size + gap / 2;
        if (Math.abs(p.x - x) <= reach) return { table, index: i, x: p.x, widths: g.columns.map((col) => col.size), inv };
      }
    }
    return null;
  }

  /** A row border of a table under the pointer (FEAT-170), the bottom edge of the last row too; the row above it, its cells. */
  private tableRowAt(screen: Point): { table: NodeId; index: number; y: number; height: number; cells: NodeId[]; inv: Matrix } | null {
    const editor = this.editor;
    if (editor.tool !== 'select' || editor.editingText || editor.vectorEdit || editor.doc.readOnly) return null;
    const world = editor.viewport.screenToWorld(screen);
    const d = editor.doc;
    const under = editor.scene.hitTest(world, { tolerance: 4 / editor.viewport.zoom })[0];
    const candidates = [editor.selection[0] ? tableOf(d, editor.selection[0]) : null, under ? tableOf(d, under) : null];
    for (const table of candidates) {
      if (!table || !d.store.isAlive(table) || d.get(table, 'locked')) continue;
      const g = editor.gridGeometry(table);
      const inv = invert(editor.scene.world(table));
      if (!g || !inv) continue;
      const p = apply(inv, world);
      if (p.x < 0 || p.x > d.get(table, 'width')) continue;
      const gap = d.get(table, 'gridRowGap');
      const reach = 4 / editor.viewport.zoom;
      for (let i = 0; i < g.rows.length; i++) {
        const r = g.rows[i]!;
        const y = r.start + r.size + gap / 2;
        if (Math.abs(p.y - y) > reach) continue;
        const { cols, cells } = tableShape(d, table);
        const row = cells.filter((c, k) => Math.floor(k / cols) === i && d.get(c, 'visible') && d.get(c, 'gridRowSpan') <= 1);
        if (row.length) return { table, index: i, y: p.y, height: r.size, cells: row, inv };
      }
    }
    return null;
  }

  private alHandleAt(screen: Point): { frame: NodeId; handle: AlHandle } | null {
    const all = this.alHandles();
    if (!all) return null;
    for (const handle of all.handles) {
      const dx = Math.abs(screen.x - handle.p.x);
      const dy = Math.abs(screen.y - handle.p.y);
      if (handle.along === 'x' ? dx <= 9 && dy <= 5 : dx <= 5 && dy <= 9) return { frame: all.frame, handle };
    }
    return null;
  }

  private drawAlHandles(): void {
    const all = this.alHandles();
    if (!all) return;
    const ctx = this.ctx;
    const active = this.mode.kind === 'al-handle' ? this.mode.side : this.hoverAl;
    for (const handle of all.handles) {
      const on = handle.side === active;
      if (on) {
        // The strip it changes, hatched as in Figma.
        ctx.save();
        ctx.fillStyle = 'rgba(242, 78, 160, 0.18)';
        ctx.strokeStyle = 'rgba(242, 78, 160, 0.5)';
        ctx.lineWidth = 1;
        for (const r of handle.regions) {
          ctx.beginPath();
          r.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
          ctx.fill();
          ctx.save();
          ctx.clip();
          const xs = r.map((p) => p.x);
          const ys = r.map((p) => p.y);
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
          ctx.beginPath();
          for (let k = x0 - (y1 - y0); k < x1; k += 6) {
            ctx.moveTo(k, y1);
            ctx.lineTo(k + (y1 - y0), y0);
          }
          ctx.stroke();
          ctx.restore();
        }
        ctx.restore();
      }
      ctx.fillStyle = on ? SPACING_COLOR : '#FFFFFF';
      ctx.strokeStyle = SPACING_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (handle.along === 'x') ctx.roundRect(handle.p.x - 7, handle.p.y - 2, 14, 4, 2);
      else ctx.roundRect(handle.p.x - 2, handle.p.y - 7, 4, 14, 2);
      ctx.fill();
      ctx.stroke();
      if (on) this.drawTag({ x: handle.p.x + 10, y: handle.p.y + 8 }, fmt(handle.value), SPACING_COLOR);
    }
  }

  private drawSpacingHandles(): void {
    const h = this.spacingHandles();
    if (!h) return;
    const ctx = this.ctx;
    for (const p of h.points) {
      ctx.fillStyle = SPACING_COLOR;
      ctx.beginPath();
      if (h.axis === 'x') ctx.roundRect(p.x - 2, p.y - 7, 4, 14, 2);
      else ctx.roundRect(p.x - 7, p.y - 2, 14, 4, 2);
      ctx.fill();
    }
  }

  /** Pink gap markers for a dragged spacing. */
  private spacingMatch(axis: 'x' | 'y', ids: readonly NodeId[], gap: number): SpacingMatch[] {
    const editor = this.editor;
    const boxes = ids.map((id) => editor.scene.bounds(id));
    const gaps = [];
    for (let i = 0; i + 1 < boxes.length; i++) {
      const a = boxes[i]!;
      const b = boxes[i + 1]!;
      gaps.push(axis === 'x' ? { from: a.x + a.width, to: b.x, at: (Math.max(a.y, b.y) + Math.min(a.y + a.height, b.y + b.height)) / 2 } : { from: a.y + a.height, to: b.y, at: (Math.max(a.x, b.x) + Math.min(a.x + a.width, b.x + b.width)) / 2 });
    }
    return [{ axis, value: gap, gaps }];
  }

  /** Position of a dragged guide next to the pointer. */
  private drawGuideLabel(axis: 'X' | 'Y', at: number): void {
    if (!this.pointer) return;
    const owner = this.mode.kind === 'guide' && this.mode.owner ? this.mode.owner : null;
    const origin = owner ? (this.editor.guideOrigin(owner) ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    const value = at - (axis === 'X' ? origin.x : origin.y);
    this.drawTag({ x: this.pointer.x + 14, y: this.pointer.y + 14 }, `${axis === 'X' ? 'X' : 'Y'} ${fmt(value)}`, ACCENT);
  }

  // ---------- precision: measurements, guides, eyedropper ----------

  /** Distances are shown: Alt held, or always in the "Code" tab (as in Dev Mode). */
  private measuring(): boolean {
    return this.altDown || this.editor.prototype.mode === 'code';
  }

  /** Alt measurements from the selection to the hovered layer or the parent (FR-CNV-042). */
  private updateMeasure(): void {
    const editor = this.editor;
    const had = editor.distances.length > 0 && this.mode.kind === 'idle';
    if (this.mode.kind !== 'idle') return;
    editor.distances = [];
    editor.distanceHelpers = [];
    const selection = editor.topLevelSelection();
    if (this.measuring() && this.pointer && selection.length > 0 && editor.tool === 'select' && !editor.editingText) {
      const sel = editor.selectionBounds()!;
      const world = editor.viewport.screenToWorld(this.pointer);
      // The deepest layer under the pointer that is not part of the selection; else the parent frame.
      const hit = editor.scene.hitTest(world, { tolerance: 3 / editor.viewport.zoom }).find((id) => !selection.some((s) => editor.doc.store.isAncestorOrSelf(s, id)));
      let target: NodeId | null = hit ?? null;
      if (!target) {
        const parent = editor.doc.parent(selection[0]!);
        if (parent && parent !== editor.pageId && editor.doc.type(parent) !== 'PAGE') target = parent;
      }
      if (target) {
        const m = measureRects(sel, editor.scene.bounds(target));
        editor.distances = m.lines;
        editor.distanceHelpers = m.helpers;
        editor.setHover(target);
      }
    }
    if (had || editor.distances.length > 0) this.request();
  }

  /** The guide under a screen point (within 3 px). */
  private guideAt(screen: Point): { owner: NodeId; index: number; axis: 'X' | 'Y'; at: number } | null {
    const editor = this.editor;
    const world = editor.viewport.screenToWorld(screen);
    let best: { owner: NodeId; index: number; axis: 'X' | 'Y'; at: number; d: number } | null = null;
    for (const g of editor.worldGuides()) {
      if (g.span) {
        const s = g.span;
        const inside = g.axis === 'X' ? world.y >= s.y && world.y <= s.y + s.height : world.x >= s.x && world.x <= s.x + s.width;
        if (!inside) continue;
      }
      const sp = editor.viewport.worldToScreen(g.axis === 'X' ? { x: g.at, y: 0 } : { x: 0, y: g.at });
      const d = g.axis === 'X' ? Math.abs(sp.x - screen.x) : Math.abs(sp.y - screen.y);
      if (d <= 3 && (!best || d < best.d)) best = { ...g, d };
    }
    return best ? { owner: best.owner, index: best.index, axis: best.axis, at: best.at } : null;
  }

  private overRuler(screen: Point, axis: 'X' | 'Y'): boolean {
    if (!this.editor.view.rulers) return false;
    // A horizontal guide (Y) goes back into the top ruler, a vertical one (X) into the left ruler.
    return axis === 'Y' ? screen.y < RULER : screen.x < RULER;
  }

  private updateGuide(world: Point, screen: Point, e: PointerEvent): void {
    const mode = this.mode;
    if (mode.kind !== 'guide') return;
    const editor = this.editor;
    let at = mode.axis === 'X' ? world.x : world.y;
    if (!this.modKey(e)) {
      const snapped = snapValue(editor, mode.axis === 'X' ? 'x' : 'y', at, mode.targets);
      at = snapped.value;
      editor.guides = snapped.guide ? [snapped.guide] : [];
    } else editor.guides = [];
    at = Math.round(at * 100) / 100;
    mode.at = at;
    mode.overRuler = this.overRuler(screen, mode.axis);
    if (mode.owner !== null) {
      mode.gesture ??= editor.beginGesture(tr('Переместить направляющую'));
      mode.gesture.update((tx) => editor.setGuide(tx, mode.owner!, mode.index, at));
    }
    this.canvas.style.cursor = mode.overRuler && mode.owner ? 'not-allowed' : mode.axis === 'X' ? 'col-resize' : 'row-resize';
    this.request();
  }

  private finishGuide(mode: Extract<Mode, { kind: 'guide' }>, screen: Point): void {
    const editor = this.editor;
    editor.guides = [];
    const over = this.overRuler(screen, mode.axis);
    if (mode.owner === null) {
      if (!over) editor.addGuide(editor.guideOwnerAt(editor.viewport.screenToWorld(screen)), mode.axis, mode.at);
    } else if (over) {
      // Dragged back into the ruler: delete.
      mode.gesture?.cancel();
      editor.removeGuide(mode.owner, mode.index);
    } else mode.gesture?.commit();
    this.request();
  }

  /** Double click on a guide: type its exact position (FR-CNV-044). */
  private editGuide(g: { owner: NodeId; index: number; axis: 'X' | 'Y' }, screen: Point): void {
    const editor = this.editor;
    this.guideInput?.remove();
    const current = editor.doc.get(g.owner, 'guides')[g.index];
    if (!current) return;
    const input = document.createElement('input');
    input.className = 'guide-input';
    input.type = 'text';
    input.inputMode = 'decimal';
    input.value = String(current.offset);
    input.title = g.owner === editor.pageId ? tr('Позиция направляющей на странице') : tr('Позиция направляющей во фрейме «{0}»', editor.doc.get(g.owner, 'name'));
    input.style.left = `${screen.x + 8}px`;
    input.style.top = `${screen.y + 8}px`;
    this.element.append(input);
    this.guideInput = input;
    // Focus after the double click has finished, or its own events take the focus back.
    const opened = performance.now();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    const done = (save: boolean) => {
      if (this.guideInput !== input) return;
      this.guideInput = null;
      const v = Number(input.value.replace(',', '.'));
      input.remove();
      if (save && Number.isFinite(v)) editor.setGuideOffset(g.owner, g.index, v);
      this.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => {
      if (performance.now() - opened < 250) {
        input.focus();
        return;
      }
      done(true);
    });
  }

  private lastMod = false;

  /** Eyedropper click: the colour goes to the selection's fill (or the clipboard). */
  private pickColor(screen: Point, average: boolean): void {
    // Render now so the sample is of the content, without overlays on top.
    this.pointer = screen;
    this.render();
    const sample = this.loupe;
    if (!sample) return;
    this.editor.applyPickedColor(average ? sample.average : sample.color);
  }

  /** Pixels around a screen point and the colour in the middle (or the 3×3 average). */
  private sample(p: Point): { pixels: ImageData; color: Color; average: Color } | null {
    const n = 11;
    const half = Math.floor(n / 2);
    const x = Math.round(p.x * this.dpr) - half;
    const y = Math.round(p.y * this.dpr) - half;
    let pixels: ImageData;
    try {
      pixels = this.ctx.getImageData(x, y, n, n);
    } catch {
      return null;
    }
    const at = (i: number, j: number) => {
      const k = (j * n + i) * 4;
      return [pixels.data[k]!, pixels.data[k + 1]!, pixels.data[k + 2]!] as const;
    };
    const [r, g, b] = at(half, half);
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const [pr, pg, pb] = at(half + i, half + j);
        sr += pr;
        sg += pg;
        sb += pb;
      }
    }
    return { pixels, color: { r: r / 255, g: g / 255, b: b / 255, a: 1 }, average: { r: sr / 9 / 255, g: sg / 9 / 255, b: sb / 9 / 255, a: 1 } };
  }


  /** Purple for components, instances and their layers; blue otherwise. */
  private accentFor(id: NodeId): string {
    const d = this.editor.doc;
    let current: NodeId | null = id;
    while (current !== null) {
      const type = d.type(current);
      if (type === 'COMPONENT' || type === 'COMPONENT_SET' || type === 'INSTANCE') return COMPONENT_ACCENT;
      if (type === 'PAGE') return ACCENT;
      current = d.parent(current);
    }
    return ACCENT;
  }

  private strokePolygon(points: Point[], color: string, width: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  private drawGuide(g: Guide): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (g.axis === 'x') {
      const a = this.screenPoint({ x: g.at, y: g.from });
      const b = this.screenPoint({ x: g.at, y: g.to });
      ctx.moveTo(Math.round(a.x) + 0.5, a.y);
      ctx.lineTo(Math.round(b.x) + 0.5, b.y);
    } else {
      const a = this.screenPoint({ x: g.from, y: g.at });
      const b = this.screenPoint({ x: g.to, y: g.at });
      ctx.moveTo(a.x, Math.round(a.y) + 0.5);
      ctx.lineTo(b.x, Math.round(b.y) + 0.5);
    }
    ctx.stroke();
  }

  private drawSizeLabel(corners: Point[], size: { w: number; h: number }, accent = ACCENT): void {
    const ctx = this.ctx;
    const text = `${fmt(size.w)} × ${fmt(size.h)}`;
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    const tw = ctx.measureText(text).width;
    const bottomY = Math.max(...corners.map((p) => p.y));
    const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
    const x = cx - tw / 2 - 4;
    const y = bottomY + 8;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(x, y, tw + 8, 16, 3);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 4, y + 8.5);
  }

  /** Resize handles: for one node they follow its rotation; for several, the selection bounds. */
  private handles(): { corners: Point[]; points: { dir: HandleDir; p: Point }[]; size: { w: number; h: number } } | null {
    const editor = this.editor;
    const selection = editor.topLevelSelection();
    if (selection.length === 0) return null;
    // Perspective corners being dragged: the box is not resized meanwhile (its corners would be under them).
    if (this.warpHandles()) return null;
    // A connector is changed by its ends (board-view.ts), not by a box.
    if (selection.length === 1 && isConnector(editor.doc, selection[0]!)) return null;
    let corners: Point[];
    let size: { w: number; h: number };
    if (selection.length === 1) {
      const id = selection[0]!;
      corners = this.nodeCorners(id);
      size = { w: editor.doc.get(id, 'width'), h: editor.doc.get(id, 'height') };
    } else {
      const b = editor.selectionBounds()!;
      corners = [
        { x: b.x, y: b.y },
        { x: b.x + b.width, y: b.y },
        { x: b.x + b.width, y: b.y + b.height },
        { x: b.x, y: b.y + b.height },
      ].map((p) => this.screenPoint(p));
      size = { w: b.width, h: b.height };
    }
    const [tl, tr, br, bl] = corners as [Point, Point, Point, Point];
    const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const isLine = selection.length === 1 && editor.doc.type(selection[0]!) === 'LINE';
    const points: { dir: HandleDir; p: Point }[] = isLine
      ? [
          { dir: { hx: -1, hy: 0 }, p: mid(tl, bl) },
          { dir: { hx: 1, hy: 0 }, p: mid(tr, br) },
        ]
      : [
          { dir: { hx: -1, hy: -1 }, p: tl },
          { dir: { hx: 1, hy: -1 }, p: tr },
          { dir: { hx: 1, hy: 1 }, p: br },
          { dir: { hx: -1, hy: 1 }, p: bl },
        ];
    if (!isLine) {
      // Edge handles are hidden on small objects so corners stay easy to grab.
      const big = Math.hypot(tr.x - tl.x, tr.y - tl.y) > 40 && Math.hypot(bl.x - tl.x, bl.y - tl.y) > 40;
      if (big) {
        points.push(
          { dir: { hx: 0, hy: -1 }, p: mid(tl, tr) },
          { dir: { hx: 1, hy: 0 }, p: mid(tr, br) },
          { dir: { hx: 0, hy: 1 }, p: mid(bl, br) },
          { dir: { hx: -1, hy: 0 }, p: mid(tl, bl) },
        );
      }
    }
    return { corners, points, size };
  }

  /**
   * Circles inside the corners of a selected rectangle or frame: drag to round
   * the corners. They sit `radius` in from each corner (at least a few pixels on
   * screen) and are hidden when the shape is too small to grab them safely.
   */
  private radiusHandles(): { id: NodeId; points: { corner: number; p: Point }[] } | null {
    const editor = this.editor;
    const d = editor.doc;
    if (editor.tool !== 'select' || editor.editingText || editor.vectorEdit || this.mode.kind === 'move' || this.mode.kind === 'resize') return null;
    const ids = editor.topLevelSelection();
    if (ids.length !== 1) return null;
    const id = ids[0]!;
    // A slide is the paper, a table's cell is the table's: no rounding knobs on them (FEAT-165, FEAT-168).
    if (editor.isSlide(id) || editor.isTableCell(id)) return null;
    const type = d.type(id);
    if ((type === 'POLYGON' || type === 'STAR') && editor.canTransform(id) && !d.get(id, 'board') && !d.get(id, 'warp')) {
      // One handle at the top corner, as in Figma: it rounds every corner.
      const c = this.polygonCorner(id);
      if (!c || Math.min(d.get(id, 'width'), d.get(id, 'height')) * editor.viewport.zoom < 48) return null;
      const r = Math.min(d.get(id, 'cornerRadius'), c.max);
      const along = Math.max(10 / editor.viewport.zoom, r / c.sinHalf);
      const m = editor.scene.world(id);
      return { id, points: [{ corner: -1, p: this.screenPoint(apply(m, { x: c.p.x + c.dir.x * along, y: c.p.y + c.dir.y * along })) }] };
    }
    if (!(type === 'RECTANGLE' || (isFrameLike(type) && type !== 'COMPONENT_SET')) || !editor.canTransform(id)) return null;
    // Board objects have their own look: no corner handles (their "+" handles are there).
    if (d.get(id, 'board')) return null;
    // A warped layer's corners are not where its box is: no radius circles over the picture.
    if (d.get(id, 'warp')) return null;
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const zoom = editor.viewport.zoom;
    if (Math.min(w, h) * zoom < 48) return null;
    const radii = d.get(id, 'cornerRadii') ?? [0, 1, 2, 3].map(() => d.get(id, 'cornerRadius'));
    const m = editor.scene.world(id);
    const min = 10 / zoom;
    const max = Math.min(w, h) / 2;
    // Corners: top-left, top-right, bottom-right, bottom-left (the order of cornerRadii).
    const corners: [number, number, number, number][] = [
      [0, 0, 1, 1],
      [w, 0, -1, 1],
      [w, h, -1, -1],
      [0, h, 1, -1],
    ];
    const points = corners.map(([cx, cy, sx, sy], corner) => {
      const inset = Math.min(max, Math.max(min, Math.min(radii[corner] ?? 0, max)));
      return { corner, p: this.screenPoint(apply(m, { x: cx + sx * inset, y: cy + sy * inset })) };
    });
    return { id, points };
  }

  /** The gradient being edited on the canvas, with its handle positions on screen. */
  private gradientHandles(): { paint: GradientPaint; from: Point; to: Point; m: Matrix; w: number; h: number; stops: Point[] } | null {
    const editor = this.editor;
    const g = editor.gradientEdit;
    if (!g || !editor.doc.store.isAlive(g.id) || editor.tool !== 'select') return null;
    const paint = editor.doc.get(g.id, g.key)[g.index];
    if (!paint || !isGradient(paint)) return null;
    const m = editor.scene.world(g.id);
    const w = editor.doc.get(g.id, 'width');
    const h = editor.doc.get(g.id, 'height');
    const from = this.screenPoint(apply(m, { x: paint.from.x * w, y: paint.from.y * h }));
    const to = this.screenPoint(apply(m, { x: paint.to.x * w, y: paint.to.y * h }));
    const stops = paint.stops.map((s) => ({ x: from.x + (to.x - from.x) * s.position, y: from.y + (to.y - from.y) * s.position }));
    return { paint, from, to, m, w, h, stops };
  }

  private drawGradientHandles(): void {
    const g = this.gradientHandles();
    if (!g) return;
    const ctx = this.ctx;
    const selected = this.editor.gradientEdit?.stop ?? -1;
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.moveTo(g.from.x, g.from.y);
    ctx.lineTo(g.to.x, g.to.y);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    // The shape it spreads in: a circle (radial, angular — the full turn) or a diamond.
    if (g.paint.type !== 'GRADIENT_LINEAR') {
      const r = Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y);
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (g.paint.type === 'GRADIENT_DIAMOND') {
        const ux = (g.to.x - g.from.x) / (r || 1);
        const uy = (g.to.y - g.from.y) / (r || 1);
        ctx.moveTo(g.from.x + ux * r, g.from.y + uy * r);
        ctx.lineTo(g.from.x - uy * r, g.from.y + ux * r);
        ctx.lineTo(g.from.x - ux * r, g.from.y - uy * r);
        ctx.lineTo(g.from.x + uy * r, g.from.y - ux * r);
        ctx.closePath();
      } else ctx.arc(g.from.x, g.from.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const end of [g.from, g.to]) {
      ctx.beginPath();
      ctx.arc(end.x, end.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    g.paint.stops.forEach((stop, i) => {
      const p = g.stops[i]!;
      // Stops at the very ends are shown by the end handles themselves.
      if (Math.hypot(p.x - g.from.x, p.y - g.from.y) < 3 || Math.hypot(p.x - g.to.x, p.y - g.to.y) < 3) {
        const end = Math.hypot(p.x - g.from.x, p.y - g.from.y) < 3 ? g.from : g.to;
        ctx.beginPath();
        ctx.arc(end.x, end.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = cssColor(stop.color);
        ctx.fill();
        if (i === selected) {
          ctx.beginPath();
          ctx.arc(end.x, end.y, 8, 0, Math.PI * 2);
          ctx.strokeStyle = ACCENT;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        return;
      }
      const size = i === selected ? 14 : 12;
      ctx.fillStyle = '#FFFFFF';
      ctx.strokeStyle = i === selected ? ACCENT : 'rgba(0,0,0,0.4)';
      ctx.lineWidth = i === selected ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(p.x - size / 2, p.y - size / 2, size, size, 3);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = cssColor(stop.color);
      ctx.fillRect(p.x - size / 2 + 2.5, p.y - size / 2 + 2.5, size - 5, size - 5);
    });
    ctx.restore();
  }

  private gradientHandleAt(screen: Point): { part: 'from' | 'to' | 'stop' | 'line'; stop: number; t: number } | null {
    const g = this.gradientHandles();
    if (!g) return null;
    // Ends first: dragging an end moves the gradient; a click on it selects the stop sitting there.
    const nearest = (t: number) => {
      let best = -1;
      g.paint.stops.forEach((s, i) => {
        if (Math.abs(s.position - t) < 0.02 && (best < 0 || Math.abs(s.position - t) < Math.abs(g.paint.stops[best]!.position - t))) best = i;
      });
      return best;
    };
    if (Math.hypot(screen.x - g.from.x, screen.y - g.from.y) <= 8) return { part: 'from', stop: nearest(0), t: 0 };
    if (Math.hypot(screen.x - g.to.x, screen.y - g.to.y) <= 8) return { part: 'to', stop: nearest(1), t: 1 };
    for (let i = g.stops.length - 1; i >= 0; i--) {
      const p = g.stops[i]!;
      if (Math.abs(screen.x - p.x) <= 8 && Math.abs(screen.y - p.y) <= 8) return { part: 'stop', stop: i, t: g.paint.stops[i]!.position };
    }
    const dx = g.to.x - g.from.x;
    const dy = g.to.y - g.from.y;
    const len2 = dx * dx + dy * dy;
    if (len2 > 0) {
      const t = ((screen.x - g.from.x) * dx + (screen.y - g.from.y) * dy) / len2;
      const px = g.from.x + dx * t;
      const py = g.from.y + dy * t;
      if (t >= 0 && t <= 1 && Math.hypot(screen.x - px, screen.y - py) <= 5) return { part: 'line', stop: -1, t };
    }
    return null;
  }

  private writeGradient(next: GradientPaint): void {
    const mode = this.mode;
    const g = this.editor.gradientEdit;
    if (mode.kind !== 'gradient' || !g) return;
    const editor = this.editor;
    if (!mode.gesture) mode.gesture = editor.beginGesture(tr('Градиент'));
    mode.gesture.update((tx) => {
      const list = [...editor.doc.get(g.id, g.key)];
      list[g.index] = next;
      tx.set(g.id, g.key, list);
    });
  }

  private updateGradient(world: Point, screen: Point, e: PointerEvent): void {
    const mode = this.mode;
    if (mode.kind !== 'gradient') return;
    if (!mode.gesture && Math.hypot(screen.x - mode.screen.x, screen.y - mode.screen.y) <= DRAG_THRESHOLD) return;
    const g = this.gradientHandles();
    if (!g) return;
    if (mode.part === 'from' || mode.part === 'to') {
      const inv = invert(g.m);
      if (!inv) return;
      const local = apply(inv, world);
      let u = { x: g.w > 0 ? local.x / g.w : 0, y: g.h > 0 ? local.y / g.h : 0 };
      if (e.shiftKey) {
        // Snap the direction to 45° steps around the other end.
        const other = mode.part === 'from' ? g.paint.to : g.paint.from;
        const vx = (u.x - other.x) * g.w;
        const vy = (u.y - other.y) * g.h;
        const angle = Math.round(Math.atan2(vy, vx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(vx, vy);
        u = { x: other.x + (g.w > 0 ? (Math.cos(angle) * len) / g.w : 0), y: other.y + (g.h > 0 ? (Math.sin(angle) * len) / g.h : 0) };
      }
      const round = (v: number) => Math.round(v * 10000) / 10000;
      const point = { x: round(u.x), y: round(u.y) };
      this.writeGradient(mode.part === 'from' ? { ...g.paint, from: point } : { ...g.paint, to: point });
    } else if (mode.part === 'stop') {
      const dx = g.to.x - g.from.x;
      const dy = g.to.y - g.from.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) return;
      const t = Math.min(1, Math.max(0, ((screen.x - g.from.x) * dx + (screen.y - g.from.y) * dy) / len2));
      const stops = [...g.paint.stops];
      const stop = stops[mode.stop];
      if (!stop) return;
      stops[mode.stop] = { ...stop, position: Math.round(t * 1000) / 1000 };
      this.writeGradient({ ...g.paint, stops });
    }
    this.request();
  }

  /**
   * Arc handles of a selected ellipse (Figma's arc tool): «sweep» on the rim where the
   * arc ends (at the right while the ellipse is whole), «start» where it begins (a dot
   * inside), «ratio» between the centre and the rim for the hole of a ring.
   */
  private arcHandles(): { id: NodeId; points: { part: 'sweep' | 'start' | 'ratio'; p: Point }[] } | null {
    const editor = this.editor;
    const d = editor.doc;
    if (editor.tool !== 'select' || editor.editingText || editor.vectorEdit || this.mode.kind === 'move' || this.mode.kind === 'resize') return null;
    const ids = editor.topLevelSelection();
    if (ids.length !== 1) return null;
    const id = ids[0]!;
    if (d.type(id) !== 'ELLIPSE' || !editor.canTransform(id) || d.get(id, 'board') || d.get(id, 'warp')) return null;
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const zoom = editor.viewport.zoom;
    if (Math.min(w, h) * zoom < 48) return null;
    const arc = d.get(id, 'arc');
    const m = editor.scene.world(id);
    const rim = Math.max(0.5, 1 - 12 / (zoom * Math.min(w, h) / 2));
    const at = (deg: number, f: number) => {
      const t = (deg * Math.PI) / 180;
      return this.screenPoint(apply(m, { x: w / 2 + (w / 2) * f * Math.cos(t), y: h / 2 + (h / 2) * f * Math.sin(t) }));
    };
    if (!arc) return { id, points: [{ part: 'sweep', p: at(0, rim) }] };
    return {
      id,
      points: [
        { part: 'sweep', p: at(arc.start + arc.sweep, rim) },
        { part: 'start', p: at(arc.start, rim) },
        { part: 'ratio', p: at(arc.start + arc.sweep / 2, Math.max(arc.inner, 0.2) * rim) },
      ],
    };
  }

  private drawArcHandles(accent: string): void {
    const handles = this.arcHandles();
    if (!handles) return;
    const ctx = this.ctx;
    for (const { part, p } of handles.points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, RADIUS_HANDLE / 2 + 1, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (part === 'start') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
      }
    }
    if (this.radiusLabel && this.mode.kind === 'arc') this.drawTag(this.radiusLabel.p, this.radiusLabel.text, accent);
  }

  private arcHandleAt(screen: Point): { id: NodeId; part: 'sweep' | 'start' | 'ratio' } | null {
    const handles = this.arcHandles();
    if (!handles) return null;
    for (const { part, p } of handles.points) if (Math.hypot(screen.x - p.x, screen.y - p.y) <= RADIUS_HANDLE / 2 + 4) return { id: handles.id, part };
    return null;
  }

  /** Drags an arc handle: the angle round the centre (in the ellipse's own proportions) or the distance out. */
  private updateArc(world: Point, e: PointerEvent, screen: Point): void {
    const mode = this.mode;
    if (mode.kind !== 'arc') return;
    const d = this.editor.doc;
    const inv = invert(this.editor.scene.world(mode.id));
    if (!inv) return;
    const w = d.get(mode.id, 'width');
    const h = d.get(mode.id, 'height');
    if (w <= 0 || h <= 0) return;
    const p = apply(inv, world);
    const ux = (p.x - w / 2) / (w / 2);
    const uy = (p.y - h / 2) / (h / 2);
    let angle = (Math.atan2(uy, ux) * 180) / Math.PI;
    // Shift: steps of 15°, as rotation.
    if (e.shiftKey) angle = Math.round(angle / 15) * 15;
    const arc = d.get(mode.id, 'arc') ?? { start: 0, sweep: 360, inner: 0 };
    let next = arc;
    let label = '';
    if (mode.part === 'sweep') {
      let sweep = (((angle - arc.start) % 360) + 360) % 360;
      if (sweep < 0.5) sweep = 360;
      next = { ...arc, sweep: Math.round(sweep * 100) / 100 };
      label = tr('Дуга {0}%', Math.round((sweep / 360) * 100));
    } else if (mode.part === 'start') {
      next = { ...arc, start: Math.round((((angle % 360) + 360) % 360) * 100) / 100 };
      label = tr('Начало {0}°', Math.round(((angle % 360) + 360) % 360));
    } else {
      const inner = Math.max(0, Math.min(0.99, Math.hypot(ux, uy)));
      next = { ...arc, inner: Math.round(inner * 1000) / 1000 };
      label = tr('Отверстие {0}%', Math.round(inner * 100));
    }
    // A whole ellipse without a hole is no arc at all.
    const whole = Math.abs(next.sweep) >= 360 && next.inner === 0;
    mode.gesture.update((tx) => tx.set(mode.id, 'arc', whole ? null : next));
    this.radiusLabel = { p: { x: screen.x + 14, y: screen.y + 18 }, text: label };
    this.request();
  }

  /** Perspective corners being edited (mockups), on the screen; null — not editing. */
  private warpHandles(): { id: NodeId; points: Point[]; m: Matrix; w: number; h: number } | null {
    const editor = this.editor;
    const id = editor.warpEdit;
    if (!id || editor.tool !== 'select' || editor.editingText || editor.vectorEdit || !editor.doc.store.isAlive(id)) return null;
    const warp = editor.doc.get(id, 'warp');
    if (warp?.type !== 'PERSPECTIVE') return null;
    const w = editor.doc.get(id, 'width');
    const h = editor.doc.get(id, 'height');
    const m = editor.scene.world(id);
    return { id, points: warp.corners.map((c) => this.screenPoint(apply(m, { x: c.x * w, y: c.y * h }))), m, w, h };
  }

  /** The warped outline and its four corners, round as in mockup tools. */
  private drawWarpHandles(accent: string): void {
    const handles = this.warpHandles();
    if (!handles) return;
    const ctx = this.ctx;
    const warp = this.editor.doc.get(handles.id, 'warp')!;
    const outline = warpOutline(warp, 1).map((q) => this.screenPoint(apply(handles.m, { x: q.x * handles.w, y: q.y * handles.h })));
    this.strokePolygon(outline, accent, 1.5);
    for (const p of handles.points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, WARP_HANDLE / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private warpHandleAt(screen: Point): { id: NodeId; corner: number } | null {
    const handles = this.warpHandles();
    if (!handles) return null;
    let best: { id: NodeId; corner: number } | null = null;
    let bestDistance = WARP_HANDLE / 2 + 4;
    handles.points.forEach((p, corner) => {
      const distance = Math.hypot(screen.x - p.x, screen.y - p.y);
      if (distance <= bestDistance) {
        best = { id: handles.id, corner };
        bestDistance = distance;
      }
    });
    return best;
  }

  /** Drags a perspective corner; it clicks into the box's own corners and edges' ends nearby. */
  private updateWarp(world: Point, screen: Point): void {
    const mode = this.mode;
    if (mode.kind !== 'warp') return;
    const d = this.editor.doc;
    const warp = d.get(mode.id, 'warp');
    if (warp?.type !== 'PERSPECTIVE') return;
    const m = this.editor.scene.world(mode.id);
    const inv = invert(m);
    if (!inv) return;
    const w = d.get(mode.id, 'width');
    const h = d.get(mode.id, 'height');
    if (w <= 0 || h <= 0) return;
    const local = apply(inv, world);
    let corner = { x: local.x / w, y: local.y / h };
    const home = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }][mode.corner]!;
    const homeScreen = this.screenPoint(apply(m, { x: home.x * w, y: home.y * h }));
    if (Math.hypot(screen.x - homeScreen.x, screen.y - homeScreen.y) <= 6) corner = { ...home };
    const corners = warp.corners.map((c) => ({ ...c })) as typeof warp.corners;
    corners[mode.corner] = { x: Math.round(corner.x * 10000) / 10000, y: Math.round(corner.y * 10000) / 10000 };
    // A corner dragged across the others would turn the picture inside out: it stops at the last good place.
    if (!isConvexQuad(corners)) return;
    mode.gesture.update((tx) => tx.set(mode.id, 'warp', { ...warp, corners }));
    this.request();
  }

  /**
   * The top corner of a polygon or a star, in its own space: where it is, the way into
   * the shape (the corner's bisector), sin of half its angle and the largest radius it
   * takes (the arc reaching the middle of the shorter side).
   */
  private polygonCorner(id: NodeId): { p: Point; dir: Point; sinHalf: number; max: number } | null {
    const d = this.editor.doc;
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const pts = d.type(id) === 'POLYGON' ? polygonPoints(w, h, d.get(id, 'pointCount')) : starPoints(w, h, d.get(id, 'pointCount'), d.get(id, 'innerRadius'));
    const p = pts[0]!;
    const a = pts[pts.length - 1]!;
    const b = pts[1]!;
    const la = Math.hypot(a.x - p.x, a.y - p.y);
    const lb = Math.hypot(b.x - p.x, b.y - p.y);
    if (la < 1e-6 || lb < 1e-6) return null;
    const u = { x: (a.x - p.x) / la, y: (a.y - p.y) / la };
    const v = { x: (b.x - p.x) / lb, y: (b.y - p.y) / lb };
    const bis = Math.hypot(u.x + v.x, u.y + v.y);
    if (bis < 1e-6) return null;
    const angle = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
    return { p, dir: { x: (u.x + v.x) / bis, y: (u.y + v.y) / bis }, sinHalf: Math.sin(angle / 2), max: (Math.min(la, lb) / 2) * Math.tan(angle / 2) };
  }

  private radiusHandleAt(screen: Point): { id: NodeId; corner: number } | null {
    const r = this.radiusHandles();
    if (!r) return null;
    for (const { corner, p } of r.points) if (Math.hypot(screen.x - p.x, screen.y - p.y) <= RADIUS_HANDLE / 2 + 3) return { id: r.id, corner };
    return null;
  }

  private updateRadius(world: Point, e: PointerEvent, screen: Point): void {
    const mode = this.mode;
    if (mode.kind !== 'radius') return;
    const editor = this.editor;
    const d = editor.doc;
    const inv = invert(editor.scene.world(mode.id));
    if (!inv) return;
    const p = apply(inv, world);
    if (mode.corner === -1) {
      // A polygon or a star: how far into the shape along the top corner's bisector.
      const c = this.polygonCorner(mode.id);
      if (!c) return;
      const along = (p.x - c.p.x) * c.dir.x + (p.y - c.p.y) * c.dir.y;
      const value = Math.round(Math.max(0, Math.min(c.max, along * c.sinHalf)));
      mode.gesture.update((tx) => tx.set(mode.id, 'cornerRadius', value));
      this.radiusLabel = { p: { x: screen.x + 14, y: screen.y + 18 }, text: tr('Радиус {0}', value) };
      this.request();
      return;
    }
    const w = d.get(mode.id, 'width');
    const h = d.get(mode.id, 'height');
    const [cx, cy, sx, sy] = ([[0, 0, 1, 1], [w, 0, -1, 1], [w, h, -1, -1], [0, h, 1, -1]] as const)[mode.corner]!;
    // Distance from the corner along the diagonal, as in Figma.
    const r = Math.max(0, Math.min(Math.min(w, h) / 2, ((p.x - cx) * sx + (p.y - cy) * sy) / 2));
    const value = Math.round(r);
    const only = mode.only || e.altKey;
    mode.gesture.update((tx) => {
      if (only) {
        const radii = [...(d.get(mode.id, 'cornerRadii') ?? [0, 1, 2, 3].map(() => d.get(mode.id, 'cornerRadius')))] as [number, number, number, number];
        radii[mode.corner] = value;
        tx.set(mode.id, 'cornerRadii', radii);
      } else {
        tx.set(mode.id, 'cornerRadii', null);
        tx.set(mode.id, 'cornerRadius', value);
      }
    });
    this.radiusLabel = { p: { x: screen.x + 14, y: screen.y + 18 }, text: tr('Радиус {0}', value) };
    this.request();
  }

  /** A small filled tag with text (size and radius hints). */
  private drawTag(p: Point, text: string, color: string): void {
    const ctx = this.ctx;
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(p.x, p.y, w, 16, 3);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, p.x + 4, p.y + 8.5);
  }

  private handleAt(screen: Point): { dir: HandleDir; rotate: boolean } | null {
    if (this.editor.tool !== 'select' || this.editor.editingText || this.editor.vectorEdit) return null;
    if (this.editor.topLevelSelection().some((id) => !this.editor.canTransform(id) || this.editor.isSlide(id))) return null;
    const h = this.handles();
    if (!h) return null;
    const knob = this.rotateHandle();
    if (knob && Math.hypot(screen.x - knob.p.x, screen.y - knob.p.y) <= ROTATE_KNOB + 4) return { dir: { hx: 0, hy: -1 }, rotate: true };
    for (const { dir, p } of h.points) {
      if (Math.abs(screen.x - p.x) <= HANDLE && Math.abs(screen.y - p.y) <= HANDLE) return { dir, rotate: false };
    }
    // Anywhere along an edge, as in Figma: the whole edge resizes, not only its middle handle (BUG-108).
    if (h.points.length > 2) {
      const [tl, tr, br, bl] = h.corners as [Point, Point, Point, Point];
      const edges: [Point, Point, HandleDir][] = [
        [tl, tr, { hx: 0, hy: -1 }],
        [tr, br, { hx: 1, hy: 0 }],
        [bl, br, { hx: 0, hy: 1 }],
        [tl, bl, { hx: -1, hy: 0 }],
      ];
      for (const [a, b, dir] of edges) if (distanceToSegment(screen, a, b) <= EDGE_GRAB) return { dir, rotate: false };
    }
    // Rotation zone just outside the corners (single selection only).
    if (this.editor.topLevelSelection().length === 1) {
      for (const { dir, p } of h.points) {
        if (dir.hx === 0 || dir.hy === 0) continue;
        const dist = Math.hypot(screen.x - p.x, screen.y - p.y);
        if (dist > HANDLE && dist <= HANDLE + 14 && !this.insidePolygon(screen, h.corners)) return { dir, rotate: true };
      }
    }
    return null;
  }

  /**
   * The rotation handle (as in PowerPoint): a knob on a short stem above the middle of the
   * top edge, turning with the object. One object that can be turned; not on a board, in
   * text or point editing. Turning just outside a corner (as in Figma) works too.
   */
  private rotateHandle(): { base: Point; p: Point } | null {
    const editor = this.editor;
    if (editor.tool !== 'select' || editor.editingText || editor.vectorEdit || editor.isBoardFile() || editor.doc.readOnly) return null;
    const selection = editor.topLevelSelection();
    if (selection.length !== 1 || !editor.canTransform(selection[0]!)) return null;
    const h = this.handles();
    if (!h || h.points.length <= 2) return null;
    const [tl, tr, br, bl] = h.corners as [Point, Point, Point, Point];
    const base = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
    // Outward from the box, square to the top edge (whichever way the object is turned or flipped).
    const centre = { x: (tl.x + tr.x + br.x + bl.x) / 4, y: (tl.y + tr.y + br.y + bl.y) / 4 };
    let nx = -(tr.y - tl.y);
    let ny = tr.x - tl.x;
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) return null;
    nx /= len;
    ny /= len;
    if (nx * (base.x - centre.x) + ny * (base.y - centre.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { base, p: { x: base.x + nx * ROTATE_STEM, y: base.y + ny * ROTATE_STEM } };
  }

  private drawRotateHandle(knob: { base: Point; p: Point }, accent: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const dx = knob.p.x - knob.base.x;
    const dy = knob.p.y - knob.base.y;
    const k = (ROTATE_STEM - ROTATE_KNOB) / ROTATE_STEM;
    ctx.moveTo(knob.base.x, knob.base.y);
    ctx.lineTo(knob.base.x + dx * k, knob.base.y + dy * k);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(knob.p.x, knob.p.y, ROTATE_KNOB, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.stroke();
    // A circular arrow inside the knob: three quarters of a turn, clockwise, its head along the arc.
    const r = ROTATE_KNOB - 3.2;
    const from = -Math.PI * 0.35;
    const to = from + Math.PI * 1.45;
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(knob.p.x, knob.p.y, r, from, to);
    ctx.stroke();
    const end = { x: knob.p.x + r * Math.cos(to), y: knob.p.y + r * Math.sin(to) };
    const along = { x: -Math.sin(to), y: Math.cos(to) };
    const out = { x: Math.cos(to), y: Math.sin(to) };
    ctx.beginPath();
    ctx.moveTo(end.x + along.x * 2.6, end.y + along.y * 2.6);
    ctx.lineTo(end.x + out.x * 2.1, end.y + out.y * 2.1);
    ctx.lineTo(end.x - out.x * 2.1, end.y - out.y * 2.1);
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.restore();
  }

  private insidePolygon(p: Point, poly: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  /**
   * Section title: a pill in the section's top-left corner, at screen size, so
   * the section can be picked and renamed at any zoom (its body is canvas).
   */
  private drawSectionTitle(ctx: CanvasRenderingContext2D, id: NodeId): void {
    const editor = this.editor;
    const d = editor.doc;
    const zoom = editor.viewport.zoom;
    const maxWidth = d.get(id, 'width') * zoom - 16;
    if (maxWidth < 24) return;
    const p = this.screenPoint(apply(editor.scene.world(id), { x: 0, y: 0 }));
    ctx.save();
    ctx.font = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    const text = ellipsize(ctx, d.get(id, 'name'), maxWidth - 16);
    const w = ctx.measureText(text).width + 16;
    const x = p.x + 8;
    const y = p.y + 8;
    const selected = editor.selection.includes(id);
    const hovered = editor.hover === id;
    // The pill takes the section's own fill, so a coloured section has a matching title.
    const fill = d.get(id, 'fills').find((f) => f.visible && f.type === 'SOLID');
    const bg = selected ? ACCENT : fill && fill.type === 'SOLID' ? sectionPillColor(fill.color) : '#E6E6E6';
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x, y, w, 22, 5);
    ctx.fill();
    if (hovered && !selected) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = selected ? '#FFFFFF' : '#1E1E1E';
    ctx.fillText(text, x + 8, y + 11.5);
    // Work status badge next to the title (FR-CNV-071).
    let total = w;
    const status = d.get(id, 'devStatus');
    if (status !== 'NONE' && maxWidth - w > 60) {
      ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      const label = ellipsize(ctx, DEV_STATUS_LABELS[status], maxWidth - w - 32);
      const bw = ctx.measureText(label).width + 22;
      const bx = x + w + 4;
      ctx.fillStyle = STATUS_COLORS[status];
      ctx.beginPath();
      ctx.roundRect(bx, y, bw, 22, 5);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(bx + 9, y + 11, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(label, bx + 16, y + 11.5);
      total += 4 + bw;
    }
    ctx.restore();
    this.labels.push({ id, rect: { x, y, width: total, height: 22 } });
  }

  /** Pointer is over the "+" handle (it fills in). */
  private hoverConnect = false;

  /** The "+" handle of the selected layer on the Prototype tab, if any. */
  private connectHandle(): { id: NodeId; p: Point } | null {
    const editor = this.editor;
    if (editor.prototype.mode !== 'prototype' || editor.tool !== 'select' || editor.editingText || editor.vectorEdit) return null;
    const sel = editor.topLevelSelection();
    if (sel.length !== 1) return null;
    const id = sel[0]!;
    if (!editor.doc.store.isAlive(id) || !editor.prototype.canInteract(id)) return null;
    return { id, p: connectHandlePoint(editor, id) };
  }

  private overConnectHandle(screen: Point): { id: NodeId; p: Point } | null {
    const h = this.connectHandle();
    return h && Math.hypot(screen.x - h.p.x, screen.y - h.p.y) <= CONNECT_HANDLE / 2 + 3 ? h : null;
  }

  /** The screen under a point that a connection from `source` can lead to. */
  private connectTarget(world: Point, source: NodeId): NodeId | null {
    const d = this.editor.doc;
    const own = screenOf(d, source);
    for (const hit of this.editor.scene.hitTest(world)) {
      const s = screenOf(d, hit);
      if (s && s !== own) return s;
    }
    return null;
  }

  /** A field over a frame's or a section's name: Enter or leaving it saves, Esc keeps the old name. */
  private renameInPlace(id: NodeId): void {
    const label = this.labels.find((l) => l.id === id);
    if (!label) return;
    const editor = this.editor;
    const r = label.rect;
    const input = h('input', {
      class: 'canvas-rename',
      type: 'text',
      value: editor.doc.get(id, 'name'),
      'aria-label': tr('Название'),
      style: { left: `${r.x}px`, top: `${r.y - 2}px`, width: `${Math.max(180, r.width + 40)}px` },
    });
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      if (save && value && value !== editor.doc.get(id, 'name')) editor.commit(tr('Переименовать'), (tx) => tx.set(id, 'name', value));
      this.canvas.focus();
      this.request();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    this.element.append(input);
    input.focus();
    input.select();
  }

  private labelAt(screen: Point): NodeId | null {
    for (const label of this.labels) {
      if (this.editor.isPinned(label.id)) continue;
      const r = label.rect;
      if (screen.x >= r.x && screen.x <= r.x + r.width && screen.y >= r.y && screen.y <= r.y + r.height) return label.id;
    }
    return null;
  }

  // ---------- pointer input ----------

  private local(e: PointerEvent | MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private modKey(e: PointerEvent | MouseEvent): boolean {
    return IS_MAC ? e.metaKey : e.ctrlKey;
  }

  private onPointerDown(e: PointerEvent): void {
    const editor = this.editor;
    const screen = this.local(e);
    const world = editor.viewport.screenToWorld(screen);
    // PointerEvent.detail is always 0, so clicks are counted here (double / triple click).
    const now = performance.now();
    const last = this.lastPress;
    const clicks = last && now - last.time < 450 && Math.hypot(screen.x - last.p.x, screen.y - last.p.y) < 6 ? last.count + 1 : 1;
    this.lastPress = { time: now, p: screen, count: clicks };
    if (editor.editingText && e.button === 0 && !this.spaceDown) {
      // Inside the edited text: place the caret or select (double click — word, triple — paragraph).
      const index = this.textIndexAt(world);
      if (index !== null) {
        e.preventDefault();
        this.canvas.setPointerCapture(e.pointerId);
        const text = editor.doc.get(editor.editingText, 'characters');
        if (clicks === 2) {
          const [a, b] = wordAt(text, index);
          editor.setTextSelection(a, b);
        } else if (clicks >= 3) {
          const a = text.lastIndexOf('\n', index - 1) + 1;
          const nl = text.indexOf('\n', index);
          editor.setTextSelection(a, nl < 0 ? text.length : nl);
        } else {
          editor.setTextSelection(e.shiftKey ? editor.textSel.anchor : index, index);
          this.mode = { kind: 'text-select', anchor: e.shiftKey ? editor.textSel.anchor : index };
        }
        this.textArea.focus({ preventScroll: true });
        return;
      }
      editor.stopTextEditing();
    }
    this.focus();
    this.canvas.setPointerCapture(e.pointerId);

    if (e.button === 1 || (e.button === 0 && (this.spaceDown || editor.tool === 'hand'))) {
      this.mode = { kind: 'pan', last: screen };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    this.lastMod = this.modKey(e);

    if (editor.tool === 'eyedropper') {
      this.pickColor(screen, this.modKey(e));
      return;
    }
    if (editor.tool === 'comment') {
      this.onComment?.(world, screen);
      return;
    }
    if (this.board.pointerDown(world, screen, e.altKey, e.shiftKey)) {
      this.mode = { kind: 'board' };
      this.request(false);
      return;
    }
    // Dragging out of a ruler creates a guide (FR-CNV-044).
    if (editor.view.rulers && (screen.x < RULER || screen.y < RULER)) {
      if (screen.x < RULER && screen.y < RULER) return;
      const axis = screen.y < RULER ? 'Y' : 'X';
      this.mode = { kind: 'guide', axis, owner: null, index: -1, gesture: null, at: axis === 'X' ? world.x : world.y, overRuler: true, targets: collectTargets(editor, []) };
      return;
    }

    if (editor.shapeBuilder) {
      const cell = this.builderCellAt(world);
      if (cell >= 0) {
        this.mode = { kind: 'builder', chosen: [cell], remove: e.altKey };
        this.canvas.setPointerCapture(e.pointerId);
        this.request();
        return;
      }
      // A click off the areas leaves the builder and acts as usual.
      editor.setShapeBuilder(null);
    }
    if (editor.vectorEdit) {
      if (this.vectorDown(world, screen, e)) return;
      editor.exitVectorEdit();
    } else if (editor.tool === 'pen') {
      this.penStart(world, e);
      return;
    } else if (editor.tool === 'pencil') {
      const parent = editor.containerAt(world);
      this.mode = { kind: 'pencil', points: [world], parent, ink: this.pencilInk(parent) };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (editor.tool === 'select') {
      // The "+" handle on the Prototype tab sits over the right resize handle and wins.
      const connect = this.overConnectHandle(screen);
      if (connect) {
        this.mode = { kind: 'connect', source: connect.id, from: connect.p, to: screen, target: null };
        this.request();
        return;
      }
      const border = this.handleAt(screen) ? null : this.tableColumnAt(screen);
      if (border) {
        this.mode = { kind: 'table-col', table: border.table, index: border.index, start: border.x, widths: border.widths, inv: border.inv, gesture: editor.beginGesture(tr('Ширина столбца')) };
        return;
      }
      const rowBorder = this.handleAt(screen) ? null : this.tableRowAt(screen);
      if (rowBorder) {
        this.mode = { kind: 'table-row', table: rowBorder.table, index: rowBorder.index, start: rowBorder.y, height: rowBorder.height, cells: rowBorder.cells, inv: rowBorder.inv, gesture: editor.beginGesture(tr('Высота строки')) };
        return;
      }
      const grab = this.handleAt(screen) ? null : this.grabberAt(screen);
      if (grab) {
        this.pressGrabber(grab, e);
        return;
      }
      const al = this.handleAt(screen) ? null : this.alHandleAt(screen);
      if (al) {
        const inv = invert(editor.scene.world(al.frame));
        if (inv) {
          const label = al.handle.side === 'itemSpacing' ? tr('Промежуток') : tr('Внутренний отступ');
          this.mode = { kind: 'al-handle', frame: al.frame, side: al.handle.side, v0: al.handle.value, start: apply(inv, world), inv, gesture: editor.beginGesture(label) };
          this.request();
          return;
        }
      }
      const sp = this.spacingHandleAt(screen);
      if (sp) {
        this.mode = { kind: 'spacing', axis: sp.axis, ids: sp.ids, boxes: sp.boxes, gap0: sp.gap, start: world, gesture: editor.beginGesture(tr('Промежутки')) };
        return;
      }
    }
    if (editor.tool === 'select' && !this.handleAt(screen)) {
      const guide = this.guideAt(screen);
      if (guide) {
        this.mode = { kind: 'guide', axis: guide.axis, owner: guide.owner, index: guide.index, gesture: null, at: guide.at, overRuler: false, targets: collectTargets(editor, []) };
        return;
      }
    }

    if (editor.tool === 'select') {
      const arcPart = this.arcHandleAt(screen);
      if (arcPart) {
        this.mode = { kind: 'arc', gesture: editor.beginGesture(tr('Дуга')), id: arcPart.id, part: arcPart.part };
        return;
      }
      const warpCorner = this.warpHandleAt(screen);
      if (warpCorner) {
        this.mode = { kind: 'warp', gesture: editor.beginGesture(tr('Перспектива')), id: warpCorner.id, corner: warpCorner.corner };
        return;
      }
      const gradient = this.gradientHandleAt(screen);
      if (gradient) {
        const g = editor.gradientEdit!;
        if (gradient.stop >= 0) editor.setGradientEdit({ ...g, stop: gradient.stop });
        this.mode = { kind: 'gradient', gesture: null, part: gradient.part, stop: gradient.stop, t: gradient.t, screen };
        return;
      }
      const radius = this.radiusHandleAt(screen);
      if (radius) {
        this.mode = { kind: 'radius', gesture: editor.beginGesture(tr('Скругление углов')), id: radius.id, corner: radius.corner, only: e.altKey };
        return;
      }
      const origin = this.originPoint();
      if (origin && Math.hypot(origin.x - screen.x, origin.y - screen.y) <= 9) {
        this.mode = { kind: 'origin' };
        return;
      }
      const handle = this.handleAt(screen);
      if (handle) {
        if (handle.rotate) this.startRotate(world);
        else this.startResize(handle.dir);
        return;
      }
      const label = this.labelAt(screen);
      if (label) {
        const deferToggle = e.shiftKey && editor.selection.includes(label);
        if (e.shiftKey && !deferToggle) editor.toggleSelection(label);
        else if (!editor.selection.includes(label)) editor.setSelection([label]);
        this.mode = { kind: 'pending-move', start: world, screen, clicked: label, wasSelected: true, alt: e.altKey, toggle: deferToggle };
        return;
      }
      const hits = editor.pickable(editor.scene.hitTest(world, { tolerance: 3 / editor.viewport.zoom }));
      const top = hits[0];
      if (this.pressTableCell(top ?? null, world, e)) return;
      // Pressing anywhere inside the selection box drags the whole selection, as in Figma:
      // on a gap between grouped shapes, on a child or on a shape showing through (BUG-020).
      // A click without dragging then selects what is under the cursor (or clears the selection).
      // An empty place while inside a group or a frame: one level up per click (user's decision, 26 October).
      const up = !e.shiftKey && !this.modKey(e) ? this.levelUp(top ?? null) : null;
      if (!e.shiftKey && !this.modKey(e) && editor.selection.length > 0 && editor.topLevelSelection().every((id) => editor.canTransform(id))) {
        const box = this.handles();
        const over = top ? editor.selectableFor(top, false) : null;
        // On a board another object lying over the selection (a stamp on a sticky, a sticky in a section)
        // is a thing of its own: pressing on it takes it, not the selection under it (BUG-083).
        const ownObject = editor.isBoardFile() && over !== null && !editor.selection.includes(over) && editor.doc.get(over, 'board') !== null;
        if (box && this.insidePolygon(screen, box.corners) && !ownObject) {
          const target = over;
          const first = editor.topLevelSelection()[0]!;
          this.mode = {
            kind: 'pending-move',
            start: world,
            screen,
            clicked: target && editor.selection.includes(target) ? target : first,
            wasSelected: true,
            alt: e.altKey,
            narrowTo: target && !editor.selection.includes(target) ? target : up ?? undefined,
            clearOnClick: !target && !up,
          };
          return;
        }
      }
      if (up) {
        // A click goes one level up; dragging from the empty place draws a marquee over the layers
        // of the frame pressed (the page's, outside everything), not moves the parent (BUG-138).
        const pressed = top ? editor.selectableFor(top, false) : null;
        this.mode = { kind: 'marquee', start: world, container: pressed ?? this.marqueeContainer(world), base: [], clicked: up, moved: false };
        return;
      }
      if (top) {
        const target = editor.selectableFor(top, this.modKey(e));
        // The empty part of an artboard holding layers is canvas to the pointer, as in Figma (BUG-104):
        // a press there starts a marquee over its layers; with Mod the marquee takes nested layers
        // and a click without dragging selects the frame itself.
        const emptyFrame = !editor.isBoardFile() && target === top && editor.doc.children(top).length > 0 && !editor.selection.includes(top) && (this.modKey(e) ? isFrameLike(editor.doc.type(top)) : editor.isArtboard(top));
        if (emptyFrame && !e.shiftKey) {
          editor.setSelection([]);
          this.mode = { kind: 'marquee', start: world, container: top, base: [], clicked: this.modKey(e) ? top : null, moved: false, deep: this.modKey(e) };
          return;
        }
        // Pressing inside an already selected object drags that object; a click without
        // dragging then selects the layer under the cursor (BUG-002).
        const selectedAncestor = !e.shiftKey && !editor.selection.includes(target) ? [top, ...editor.doc.store.ancestors(top)].find((id) => editor.selection.includes(id)) : undefined;
        if (selectedAncestor) {
          this.mode = { kind: 'pending-move', start: world, screen, clicked: selectedAncestor, wasSelected: true, alt: e.altKey, narrowTo: target };
          return;
        }
        const wasSelected = editor.selection.includes(target);
        // Shift on a selected object: deselect on release only if it was not dragged, so Shift+drag works.
        if (e.shiftKey && wasSelected) {
          this.mode = { kind: 'pending-move', start: world, screen, clicked: target, wasSelected, alt: e.altKey, toggle: true };
          return;
        }
        if (e.shiftKey) editor.toggleSelection(target);
        else if (!wasSelected) editor.setSelection([target]);
        if (editor.selection.includes(target)) {
          this.mode = { kind: 'pending-move', start: world, screen, clicked: target, wasSelected, alt: e.altKey };
        }
        return;
      }
      const base = e.shiftKey ? [...editor.selection] : [];
      if (!e.shiftKey) editor.setSelection([]);
      // A locked object on a board: dragging over it draws a marquee, a click selects it (to unlock it).
      const locked = editor.isBoardFile() && !this.modKey(e) ? lockedAt(editor, world) : null;
      this.mode = { kind: 'marquee', start: world, container: this.marqueeContainer(world), base, clicked: locked, moved: false };
      return;
    }

    if (editor.tool === 'hand') return;
    const type = TOOL_TYPES[editor.tool];
    if (!type) return;
    // Sections go on the page or into another section, never into a frame.
    const parent = type === 'SECTION' ? editor.sectionAt(world) : editor.containerAt(world);
    const extra: Partial<NodeProps> = editor.tool === 'arrow' ? { endCap: 'ARROW', name: editor.nextName('ARROW') } : {};
    this.mode = { kind: 'create', type, extra, start: world, screen, parent, gesture: null, id: null, targets: collectTargets(editor, []) };
  }

  private onPointerMove(e: PointerEvent): void {
    const editor = this.editor;
    const screen = this.local(e);
    const world = editor.viewport.screenToWorld(screen);
    const mode = this.mode;
    this.pointer = screen;
    this.lastMod = this.modKey(e);
    if (this.altDown !== e.altKey) this.altDown = e.altKey;
    switch (mode.kind) {
      case 'board':
        this.board.pointerMove(world, screen, e.shiftKey);
        return;
      case 'idle': {
        if (editor.shapeBuilder) {
          const cell = this.builderCellAt(world);
          if (cell !== this.builderHover) {
            this.builderHover = cell;
            this.request();
          }
          this.canvas.style.cursor = cell >= 0 ? 'pointer' : 'default';
          return;
        }
        const boardCursor = this.board.hover(world, screen);
        if (boardCursor) {
          this.canvas.style.cursor = boardCursor;
          editor.setHover(null);
          return;
        }
        if (editor.tool === 'eyedropper' || editor.tool === 'pencil') {
          this.canvas.style.cursor = 'crosshair';
          this.request();
          return;
        }
        if (editor.view.rulers && (screen.x < RULER || screen.y < RULER)) {
          this.canvas.style.cursor = screen.x < RULER && screen.y < RULER ? 'default' : screen.y < RULER ? 'row-resize' : 'col-resize';
          editor.setHover(null);
          return;
        }
        const grab = editor.tool === 'select' && !this.handleAt(screen) ? this.grabberAt(screen) : null;
        const grabKey = grab ? `${grab.axis}${grab.index}` : null;
        if (grabKey !== this.hoverGrabber) {
          this.hoverGrabber = grabKey;
          this.request();
        }
        if (grab) {
          this.canvas.style.cursor = 'pointer';
          editor.setHover(null);
          return;
        }
        if (editor.tool === 'select' && !this.handleAt(screen) && this.tableColumnAt(screen)) {
          this.canvas.style.cursor = 'col-resize';
          editor.setHover(null);
          return;
        }
        if (editor.tool === 'select' && !this.handleAt(screen) && this.tableRowAt(screen)) {
          this.canvas.style.cursor = 'row-resize';
          editor.setHover(null);
          return;
        }
        const al = editor.tool === 'select' && !this.handleAt(screen) ? this.alHandleAt(screen) : null;
        if ((al?.handle.side ?? null) !== this.hoverAl) {
          this.hoverAl = al?.handle.side ?? null;
          this.request();
        }
        if (al) {
          this.canvas.style.cursor = al.handle.along === 'x' ? 'ns-resize' : 'ew-resize';
          editor.setHover(null);
          return;
        }
        if (editor.tool === 'select' && this.spacingHandleAt(screen)) {
          const sp = this.spacingHandleAt(screen)!;
          this.canvas.style.cursor = sp.axis === 'x' ? 'ew-resize' : 'ns-resize';
          editor.setHover(null);
          return;
        }
        if (editor.tool === 'select' && !this.handleAt(screen)) {
          const g = this.guideAt(screen);
          const changed = (g?.owner ?? null) !== (this.hoverGuide?.owner ?? null) || (g?.index ?? -1) !== (this.hoverGuide?.index ?? -1);
          this.hoverGuide = g ? { owner: g.owner, index: g.index } : null;
          if (changed) this.request();
          if (g) {
            this.canvas.style.cursor = g.axis === 'X' ? 'col-resize' : 'row-resize';
            editor.setHover(null);
            return;
          }
        }
        if (this.measuring() && editor.selection.length > 0 && editor.tool === 'select') {
          this.updateCursor(null);
          this.updateMeasure();
          return;
        }
        if (editor.distances.length > 0) this.updateMeasure();
        if (editor.vectorEdit && (editor.vectorEdit.tool !== 'edit' || this.pointsBox())) {
          this.vectorHover(world, screen);
          if (editor.vectorEdit.tool !== 'edit' || this.pointsBoxHandleAt(screen)) return;
        }
        if (editor.tool === 'pen') {
          this.canvas.style.cursor = 'crosshair';
          return;
        }
        const gradientPart = this.gradientHandleAt(screen);
        if (gradientPart) {
          this.canvas.style.cursor = gradientPart.part === 'line' ? 'copy' : 'move';
          editor.setHover(null);
          return;
        }
        const overConnect = this.overConnectHandle(screen) !== null;
        if (overConnect !== this.hoverConnect) {
          this.hoverConnect = overConnect;
          this.request();
        }
        if (overConnect) {
          this.canvas.style.cursor = 'crosshair';
          editor.setHover(null);
          return;
        }
        if (this.warpHandleAt(screen) || this.arcHandleAt(screen)) {
          this.canvas.style.cursor = 'move';
          editor.setHover(null);
          return;
        }
        if (this.radiusHandleAt(screen)) {
          this.canvas.style.cursor = 'default';
          editor.setHover(null);
          return;
        }
        const handle = this.handleAt(screen);
        this.updateCursor(handle);
        if (handle || editor.tool !== 'select') {
          editor.setHover(null);
          return;
        }
        const label = this.labelAt(screen);
        if (label) {
          editor.setHover(label);
          return;
        }
        const top = editor.pickable(editor.scene.hitTest(world, { tolerance: 3 / editor.viewport.zoom }))[0];
        editor.setHover(top ? editor.selectableFor(top, this.modKey(e)) : null);
        return;
      }
      case 'pan':
        editor.viewport.panBy(screen.x - mode.last.x, screen.y - mode.last.y);
        mode.last = screen;
        editor.requestViewport();
        return;
      case 'pending-move':
        if (Math.hypot(screen.x - mode.screen.x, screen.y - mode.screen.y) > DRAG_THRESHOLD) this.startMove(mode.start, mode.alt);
        return;
      case 'move':
        this.updateMove(world, e);
        return;
      case 'marquee':
        this.updateMarquee(world);
        return;
      case 'resize':
        this.updateResize(world, e);
        return;
      case 'rotate':
        this.updateRotate(world, e.shiftKey);
        return;
      case 'radius':
        this.updateRadius(world, e, screen);
        return;
      case 'warp':
        this.updateWarp(world, screen);
        return;
      case 'arc':
        this.updateArc(world, e, screen);
        return;
      case 'vec-transform':
        this.transformPoints(this.toNode(mode.id, world), e);
        return;
      case 'origin':
        this.editor.rotationOrigin = { shown: true, at: world };
        this.request();
        return;
      case 'vec-width':
        this.widthDrag(mode, this.toNode(mode.id, world));
        return;
      case 'vec-erase':
        this.eraseTo(this.toNode(mode.id, world));
        this.penHover = world;
        this.request();
        return;
      case 'builder': {
        const cell = this.builderCellAt(world);
        if (cell >= 0 && !mode.chosen.includes(cell)) mode.chosen.push(cell);
        this.builderHover = cell;
        this.request();
        return;
      }
      case 'pencil': {
        // Shift: a straight line from where the sketch began, in steps of 45° (as in Figma).
        if (e.shiftKey) {
          const a = mode.points[0]!;
          const step = Math.PI / 4;
          const angle = Math.round(Math.atan2(world.y - a.y, world.x - a.x) / step) * step;
          const len = Math.hypot(world.x - a.x, world.y - a.y);
          mode.points = [a, { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len }];
        } else {
          const last = mode.points[mode.points.length - 1]!;
          if (Math.hypot(world.x - last.x, world.y - last.y) * this.editor.viewport.zoom >= 1.5) mode.points.push(world);
        }
        this.request();
        return;
      }
      case 'pen-drag':
        this.penDrag(world, e);
        return;
      case 'vec-points':
        this.vectorDragPoints(world, screen, e);
        return;
      case 'vec-handle':
        this.vectorDragHandle(world, e);
        return;
      case 'vec-bend':
        this.vectorBend(world);
        return;
      case 'vec-marquee':
        this.vectorMarquee(world, screen);
        return;
      case 'text-select': {
        const index = this.textIndexAt(world, true);
        if (index !== null) this.editor.setTextSelection(mode.anchor, index);
        return;
      }
      case 'gradient':
        this.updateGradient(world, screen, e);
        return;
      case 'create':
        this.updateCreate(world, screen, e);
        return;
      case 'connect':
        mode.to = screen;
        mode.target = this.connectTarget(world, mode.source);
        this.request();
        return;
      case 'guide':
        this.updateGuide(world, screen, e);
        return;
      case 'table-cells': {
        const at = this.tablePlaceAt(mode.table, world);
        if (at) this.selectTableRange(mode, mode.axis === 'row' ? { row: at.row, col: 0 } : mode.axis === 'col' ? { row: 0, col: at.col } : at);
        return;
      }
      case 'table-row': {
        const h = Math.max(12, Math.round(mode.height + apply(mode.inv, world).y - mode.start));
        // The row's cells (not merged across rows) get the least height; a text taller than it keeps the row taller.
        mode.gesture.update((tx) => {
          for (const c of mode.cells) tx.set(c, 'minHeight', { unit: 'PX', value: h });
        });
        this.request();
        return;
      }
      case 'table-col': {
        const x = apply(mode.inv, world).x;
        const w = mode.widths;
        const pair = w[mode.index]! + w[mode.index + 1]!;
        const min = Math.min(24, pair / 2);
        const left = Math.max(min, Math.min(pair - min, w[mode.index]! + x - mode.start));
        const widths = [...w];
        widths[mode.index] = left;
        widths[mode.index + 1] = pair - left;
        // Shares in pixels of the current width: the table keeps its width and stretches as before.
        mode.gesture.update((tx) => tx.set(mode.table, 'gridColumns', widths.map((v) => ({ kind: 'FR' as const, value: round2(v) }))));
        this.request();
        return;
      }
      case 'al-handle': {
        const local = apply(mode.inv, world);
        const dx = local.x - mode.start.x;
        const dy = local.y - mode.start.y;
        const d = editor.doc;
        const horizontal = d.get(mode.frame, 'layoutMode') === 'HORIZONTAL';
        const delta = { paddingTop: dy, paddingBottom: -dy, paddingLeft: dx, paddingRight: -dx, itemSpacing: horizontal ? dx : dy }[mode.side];
        const raw = editor.view.snapToPixel ? Math.round(mode.v0 + delta) : round2(mode.v0 + delta);
        // Padding stops at zero; the gap may go below it (layers overlap), as in Figma.
        const value = mode.side === 'itemSpacing' ? raw : Math.max(0, raw);
        // Alt: the opposite side too; Alt+Shift: all four sides.
        const OPPOSITE = { paddingTop: 'paddingBottom', paddingBottom: 'paddingTop', paddingLeft: 'paddingRight', paddingRight: 'paddingLeft' } as const;
        const sides: AlSide[] =
          mode.side === 'itemSpacing' || !e.altKey ? [mode.side] : e.shiftKey ? ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] : [mode.side, OPPOSITE[mode.side]];
        mode.gesture.update((tx) => {
          for (const side of sides) tx.set(mode.frame, side, value);
        });
        this.request();
        return;
      }
      case 'spacing': {
        const delta = mode.axis === 'x' ? world.x - mode.start.x : world.y - mode.start.y;
        const gap = Math.max(0, editor.view.snapToPixel ? Math.round(mode.gap0 + delta) : round2(mode.gap0 + delta));
        mode.gesture.update((tx) => editor.setEqualSpacing(tx, mode.axis, mode.ids, mode.boxes, gap));
        editor.spacing = this.spacingMatch(mode.axis, mode.ids, gap);
        this.request();
        return;
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const editor = this.editor;
    const mode = this.mode;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.mode = { kind: 'idle' };
    editor.spacing = [];
    if (mode.kind === 'move' || mode.kind === 'resize') editor.distances = [];
    if (mode.kind === 'board') {
      const screen = this.local(e);
      this.board.pointerUp(editor.viewport.screenToWorld(screen), screen);
      this.updateCursor();
      return;
    }
    switch (mode.kind) {
      case 'guide':
        this.finishGuide(mode, this.local(e));
        return;
      case 'spacing':
      case 'al-handle':
      case 'table-col':
      case 'table-row':
        mode.gesture.commit();
        this.request();
        return;
      case 'table-cells':
        this.request();
        return;
      case 'pending-move':
        // A plain click on an already-selected object narrows the selection to it.
        if (mode.toggle) editor.toggleSelection(mode.clicked);
        else if (mode.narrowTo) editor.setSelection([mode.narrowTo]);
        else if (mode.clearOnClick) editor.setSelection([]);
        else if (mode.wasSelected && !e.shiftKey && editor.selection.length > 1) editor.setSelection([mode.clicked]);
        break;
      case 'move':
      case 'resize':
      case 'rotate':
      case 'radius':
      case 'warp':
      case 'arc':
        if (mode.kind === 'resize') {
          const sections = mode.ids.filter((id) => editor.doc.type(id) === 'SECTION');
          if (sections.length > 0) mode.gesture.update((tx) => sections.forEach((id) => editor.adoptIntoSection(tx, id)));
        }
        mode.gesture.commit();
        this.radiusLabel = null;
        break;
      case 'pencil':
        this.finishPencil(mode.points, mode.parent, mode.ink);
        break;
      case 'builder':
        editor.applyShapeBuilder(mode.chosen, mode.remove);
        // The area under the pointer stays lit: the step is seen to have happened, and the next one is ready.
        this.builderHover = this.builderCellAt(editor.viewport.screenToWorld(this.local(e)));
        this.request();
        break;
      case 'origin':
        break;
      case 'vec-transform':
        mode.gesture.update((tx) => normalizeVector(editor.doc, tx, mode.id));
        mode.gesture.commit();
        break;
      case 'vec-width':
        mode.gesture.commit();
        break;
      case 'vec-erase': {
        // A cut-out area comes as many short lines: fitted back into curves.
        const net = mode.fill ? simplifyNetwork(mode.net, 0.1) : mode.net;
        mode.gesture.update((tx) => {
          tx.set(mode.id, 'vectorNetwork', net);
          normalizeVector(editor.doc, tx, mode.id);
        });
        mode.gesture.commit();
        if (editor.vectorEdit) editor.setVectorTool('eraser');
        break;
      }
      case 'pen-drag':
        mode.gesture.update((tx) => {
          if (editor.vectorEdit) normalizeVector(editor.doc, tx, editor.vectorEdit.id);
        });
        mode.gesture.commit();
        break;
      case 'vec-marquee': {
        const dragged = editor.marquee !== null || (mode.lasso !== null && mode.lasso.length >= 3);
        editor.marquee = null;
        if (!dragged && editor.vectorEdit) {
          // A plain click: inside the shape clears the point selection; outside ends editing and selects what is there.
          const id = editor.vectorEdit.id;
          const hit = editor.scene.hitTest(mode.start, { tolerance: 3 / editor.viewport.zoom })[0];
          if (hit === id) editor.setVectorSelection([]);
          else {
            this.finishVectorEdit();
            editor.setSelection(hit ? [hit] : []);
          }
        }
        break;
      }
      case 'vec-points':
        if (mode.gesture) {
          mode.gesture.update((tx) => normalizeVector(editor.doc, tx, editor.vectorEdit!.id));
          mode.gesture.commit();
        } else if (mode.toggle) {
          const sel = editor.vectorEdit?.selected ?? [];
          editor.setVectorSelection(sel.includes(mode.clickedKey) ? sel.filter((k) => k !== mode.clickedKey) : [...sel, mode.clickedKey]);
        } else editor.setVectorSelection([mode.clickedKey]);
        break;
      case 'vec-handle':
      case 'vec-bend':
        mode.gesture.update((tx) => normalizeVector(editor.doc, tx, editor.vectorEdit!.id));
        mode.gesture.commit();
        break;
      case 'gradient':
        if (mode.gesture) mode.gesture.commit();
        else if (mode.part === 'line') {
          // A click on the gradient line adds a stop there.
          const g = editor.gradientEdit;
          const paint = g ? editor.doc.get(g.id, g.key)[g.index] : null;
          if (g && paint && isGradient(paint)) {
            editor.commit(tr('Точка градиента'), (tx) => {
              const list = [...editor.doc.get(g.id, g.key)];
              list[g.index] = addStop(paint, mode.t);
              tx.set(g.id, g.key, list);
            });
            editor.setGradientEdit({ ...g, stop: paint.stops.length });
          }
        }
        break;
      case 'marquee':
        if (!mode.moved && mode.clicked) editor.setSelection([mode.clicked]);
        break;
      case 'create':
        this.finishCreate(mode);
        break;
      case 'connect':
        if (mode.target) editor.prototype.connect(mode.source, mode.target);
        break;
      default:
        break;
    }
    editor.marquee = null;
    editor.guides = [];
    editor.dropTarget = null;
    this.updateCursor();
    this.request();
  }

  private onDoubleClick(e: MouseEvent): void {
    {
      const screen = this.local(e);
      const g = this.editor.tool === 'select' ? this.guideAt(screen) : null;
      if (g) {
        this.editGuide(g, screen);
        return;
      }
      // The name over a frame or a section: renamed right there (as in Figma).
      const label = this.editor.tool === 'select' || this.editor.tool === 'hand' ? this.labelAt(screen) : null;
      if (label && !this.editor.doc.readOnly) {
        this.renameInPlace(label);
        return;
      }
    }
    const editor = this.editor;
    // A double click with the pen ends the path (the pen stays: the next click starts anew).
    if (editor.vectorEdit?.tool === 'pen') {
      if (this.pen) this.pen.last = null;
      this.request();
      return;
    }
    if (editor.tool !== 'select') return;
    const world = editor.viewport.screenToWorld(this.local(e));
    if (editor.vectorEdit) {
      this.vectorToggleSmooth(this.local(e));
      return;
    }
    {
      // A sticky, a shape or a label: type into it; a connector: into its label.
      const hit = editor.pickable(editor.scene.hitTest(world, { tolerance: 4 / editor.viewport.zoom }))[0];
      const object = hit && !this.modKey(e) ? (boardObjectOf(editor.doc, hit) ?? (isConnector(editor.doc, hit) ? hit : null)) : null;
      // A link card opens its page, for viewers too.
      const link = object ? linkOfCard(editor, object) : null;
      if (link) {
        openLink(link);
        return;
      }
      if (object && !editor.doc.readOnly && !editor.editingText) {
        const text = editableTextOf(editor, object);
        if (text) {
          editor.startTextEditing(text);
          const index = this.textIndexAt(world);
          if (index !== null) {
            const [a, b] = wordAt(editor.doc.get(text, 'characters'), index);
            editor.setTextSelection(a, b);
          }
        }
        return;
      }
    }
    {
      // Double click on a selected shape edits its points.
      const hit = editor.scene.hitTest(world, { tolerance: 3 / editor.viewport.zoom })[0];
      const only = editor.selection.length === 1 ? editor.selection[0]! : null;
      // A warped layer: its perspective corners (its points would be where the flat layer is).
      const warp = only && hit === only ? editor.doc.get(only, 'warp') : null;
      if (only && warp) {
        if (warp.type === 'PERSPECTIVE' && editor.canTransform(only)) editor.setWarpEdit(only);
        return;
      }
      if (hit && only && hit === only && ['VECTOR', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE'].includes(editor.doc.type(only))) {
        editor.enterVectorEdit(only);
        return;
      }
    }
    const top = editor.pickable(editor.scene.hitTest(world, { tolerance: 3 / editor.viewport.zoom }))[0];
    if (!top) return;
    if (editor.editingText) return;
    const target = editor.selectableFor(top, false);
    const textId = editor.doc.type(target) === 'TEXT' ? target : target === editor.selection[0] && editor.doc.type(top) === 'TEXT' ? top : null;
    if (textId) {
      if (!editor.canTransform(textId) && !editor.isInstanceLayer(textId)) return;
      editor.startTextEditing(textId);
      // Double click selects the word under the pointer, as in other editors.
      const index = this.textIndexAt(world);
      if (index !== null) {
        const [a, b] = wordAt(editor.doc.get(textId, 'characters'), index);
        editor.setTextSelection(a, b);
      }
      return;
    }
    if (target !== editor.selection[0]) editor.setSelection([target]);
  }

  /** Right click / two-finger tap: select what is under the cursor, then show the menu (FR-CNV-032). */
  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const editor = this.editor;
    if (this.mode.kind !== 'idle' && this.mode.kind !== 'pending-move') this.cancelMode();
    this.mode = { kind: 'idle' };
    const world = editor.viewport.screenToWorld(this.local(e));
    // Right click inside the edited text keeps editing (menu applies to the text layer).
    if (editor.editingText && this.textIndexAt(world) === null) editor.stopTextEditing();
    const hits = editor.pickable(editor.scene.hitTest(world, { tolerance: 3 / editor.viewport.zoom }));
    const label = this.labelAt(this.local(e));
    const top = label ?? hits[0];
    // Inside the selection box the menu belongs to the selection, even over a gap between its shapes (BUG-023).
    const box = editor.selection.length > 0 ? this.handles() : null;
    const insideSelection = !!box && this.insidePolygon(this.local(e), box.corners);
    const hitTarget = top ? (label ?? editor.selectableFor(top, false)) : null;
    if (insideSelection && (!hitTarget || editor.selection.includes(hitTarget) || editor.doc.store.ancestors(hitTarget).some((a) => editor.selection.includes(a)))) {
      this.onMenu?.(e.clientX, e.clientY, hits);
      return;
    }
    const locked = !top && editor.isBoardFile() ? lockedAt(editor, world) : null;
    if (top) {
      const target = label ?? editor.selectableFor(top, false);
      if (!editor.selection.includes(target)) editor.setSelection([target]);
    } else {
      // A locked object on a board: its menu (with «Открепить»), not the empty board's.
      editor.setSelection(locked ? [locked] : []);
    }
    this.onMenu?.(e.clientX, e.clientY, hits);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const editor = this.editor;
    const screen = this.local(e);
    // A slide on show, whole in view: scrolling turns slides, as in a presentation app (FEAT-165).
    if (editor.slideStage && !e.ctrlKey && !e.metaKey && editor.stageFitted()) {
      this.flipBy(e.deltaY * (e.deltaMode === 1 ? 16 : 1));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // Pinch on trackpads arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0035));
      editor.viewport.zoomAt(screen, editor.viewport.zoom * factor);
    } else {
      const scale = e.deltaMode === 1 ? 16 : 1;
      const dx = (e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX) * scale;
      const dy = (e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY) * scale;
      editor.viewport.panBy(-dx, -dy);
    }
    editor.requestViewport();
  }

  /** Scroll gathered toward turning a slide, and when the last turn was (a trackpad's swipe goes on for a while). */
  private flipScroll = 0;
  private flippedAt = 0;

  private flipScrollAt = 0;

  private flipBy(dy: number): void {
    const now = performance.now();
    // A pause starts a new gesture; right after a turn the rest of the swipe is let go.
    if (now - this.flipScrollAt > 250) this.flipScroll = 0;
    this.flipScrollAt = now;
    if (now - this.flippedAt < 450) return;
    this.flipScroll += dy;
    if (Math.abs(this.flipScroll) < 60) return;
    this.editor.slideStage?.flip(this.flipScroll > 0 ? 1 : -1);
    this.flipScroll = 0;
    this.flippedAt = now;
  }

  private updateCursor(handle?: { dir: HandleDir; rotate: boolean } | null): void {
    let cursor = 'default';
    const editor = this.editor;
    if (this.mode.kind === 'pan') cursor = 'grabbing';
    else if (this.spaceDown || editor.tool === 'hand') cursor = 'grab';
    else if (editor.tool === 'text') cursor = 'text';
    else if (editor.tool !== 'select' || editor.shapeBuilder) cursor = 'crosshair';
    else if (handle?.rotate) cursor = 'alias';
    else if (handle) {
      const { hx, hy } = handle.dir;
      cursor = hx === 0 ? 'ns-resize' : hy === 0 ? 'ew-resize' : hx === hy ? 'nwse-resize' : 'nesw-resize';
    }
    this.canvas.style.cursor = cursor;
  }

  setSpace(down: boolean): void {
    this.spaceDown = down;
    this.updateCursor();
  }

  // ---------- move ----------

  /**
   * The selection lifted off the page while it is dragged (BUG-070): the
   * tiles are drawn once without it, it is drawn once into its own picture,
   * and each frame only moves that picture. Put back when the drag ends.
   */
  private lifted: { ids: NodeId[]; parents: NodeId[]; origin: Point } | null = null;

  /** Whether layers can be shown apart from the page while dragged and look the same. */
  private liftable(ids: readonly NodeId[]): boolean {
    const d = this.editor.doc;
    const plain = (id: NodeId) => {
      const blend = d.get(id, 'blendMode');
      return blend === 'NORMAL' || blend === 'PASS_THROUGH';
    };
    for (const id of ids) {
      if (d.get(id, 'isMask') || !plain(id)) return false;
      if (d.get(id, 'effects').some((e) => e.type === 'BACKGROUND_BLUR' && e.visible)) return false;
      if (d.children(d.parent(id)!).some((c) => d.get(c, 'isMask'))) return false;
      // Clipped, faded or blended by a parent: the picture alone would look different.
      // Taken out of auto layout it is carried above the page, as in Figma: a clipping parent does not cut it.
      const carried = this.editor.inAutoLayout(id);
      for (const a of d.store.ancestors(id)) {
        if (a === this.editor.pageId) break;
        if ((d.get(a, 'clipsContent') && !carried) || d.get(a, 'opacity') < 1 || !plain(a)) return false;
      }
    }
    return true;
  }

  private lift(ids: readonly NodeId[]): void {
    const tiles = this.tiles;
    if (!tiles || !tiles.usable || this.editor.tool === 'eyedropper' || ids.length === 0 || !this.liftable(ids)) return;
    // A drag right after an insertion: the greeting gives way.
    this.appearing = null;
    const scene = this.editor.scene;
    if (!tiles.setLift(scene, ids, this.editor.viewport.zoom * this.dpr)) return;
    this.shownSnap = null;
    const d = this.editor.doc;
    this.lifted = { ids: [...ids], parents: ids.map((id) => d.parent(id)!), origin: this.editor.worldOrigin(ids[0]!) };
    for (const id of ids) scene.quiet.add(id);
    this.renderer.lifted = scene.quiet;
    // The page without them.
    scene.damageAreas(ids.map((id) => scene.renderBounds(id)));
  }

  /** Puts the lifted layers back on the page where they are now. */
  private dropLift(): void {
    const lifted = this.lifted;
    if (!lifted) return;
    this.lifted = null;
    const scene = this.editor.scene;
    scene.quiet.clear();
    this.renderer.lifted = null;
    this.tiles?.clearLift();
    const d = this.editor.doc;
    scene.damageAreas(lifted.ids.filter((id) => d.store.isAlive(id)).map((id) => scene.renderBounds(id)));
    this.request();
  }

  /** How far the lifted layers went since drawn; null — they must go back on the page. */
  private liftOffset(): { dx: number; dy: number; scale?: number } | null {
    const lifted = this.lifted;
    if (!lifted) return null;
    const d = this.editor.doc;
    if (this.appearing) return this.appearOffset();
    // Deleted by someone else: back on the page, drawn as usual.
    if (this.mode.kind !== 'move' || lifted.ids.some((id) => !d.store.isAlive(id))) {
      this.dropLift();
      return null;
    }
    // Into another frame: lifted again there (if it can be).
    if (lifted.ids.some((id, i) => d.parent(id) !== lifted.parents[i])) {
      const ids = lifted.ids;
      this.dropLift();
      this.lift(ids);
      if (!this.lifted) return null;
    }
    // Zoomed while dragging: drawn again at the new scale.
    const scale = this.editor.viewport.zoom * this.dpr;
    if (this.tiles!.liftScale !== scale) {
      const ids = lifted.ids;
      this.dropLift();
      this.lift(ids);
      if (!this.lifted) return null;
    }
    const first = lifted.ids[0]!;
    // In auto layout the layer keeps its place in the layout (the others make room), its picture follows the pointer, as in Figma.
    const flow = this.flowShift(first);
    const now = flow ? this.dragged(first) : this.editor.worldOrigin(first);
    const lag = flow ? { x: 0, y: 0 } : this.snapLag();
    return { dx: now.x - this.lifted!.origin.x - lag.x, dy: now.y - this.lifted!.origin.y - lag.y };
  }

  /** The snap offset as shown: it follows the real one softly (FEAT-150). */
  private shownSnap: { x: number; y: number; at: number } | null = null;

  /**
   * How far the picture still is from where snapping put the layers: a guide caught
   * pulls the object over in a few frames instead of a jump, letting go — the same.
   */
  private snapLag(): Point {
    const mode = this.mode;
    const target = mode.kind === 'move' && mode.snap ? mode.snap : { x: 0, y: 0 };
    const now = performance.now();
    if (!this.editor.motionOn() || !this.shownSnap) {
      this.shownSnap = { ...target, at: now };
      return { x: 0, y: 0 };
    }
    const s = this.shownSnap;
    const k = 1 - Math.exp(-Math.min(64, now - s.at) / 50);
    s.at = now;
    s.x += (target.x - s.x) * k;
    s.y += (target.y - s.y) * k;
    const zoom = this.editor.viewport.zoom;
    if (Math.abs(target.x - s.x) * zoom < 0.3 && Math.abs(target.y - s.y) * zoom < 0.3) {
      s.x = target.x;
      s.y = target.y;
    } else {
      this.request(false);
    }
    return { x: target.x - s.x, y: target.y - s.y };
  }

  /** Layers greeted after insertion: lifted and bounced for a moment (FEAT-150). */
  private appearing: { started: number } | null = null;

  /** Greets new layers: a little spring of scale on their lifted picture. */
  private greet(ids: readonly NodeId[]): void {
    if (!this.editor.motionOn() || this.mode.kind !== 'idle' || this.lifted) return;
    const d = this.editor.doc;
    const alive = ids.filter((id) => d.store.isAlive(id));
    if (alive.length === 0) return;
    this.editor.scene.ensure();
    this.lift(alive);
    if (!this.lifted) return;
    this.appearing = { started: performance.now() };
    this.request();
  }

  /** The bounce: from a little smaller, a touch past full size, settling — a third of a second. */
  private appearOffset(): { dx: number; dy: number; scale: number } | null {
    const t = (performance.now() - this.appearing!.started) / 340;
    if (t >= 1 || this.mode.kind !== 'idle' || this.lifted!.ids.some((id) => !this.editor.doc.store.isAlive(id))) {
      this.appearing = null;
      this.dropLift();
      return null;
    }
    this.request(false);
    return { dx: 0, dy: 0, scale: 1 - 0.1 * Math.exp(-3.5 * t) * Math.cos(2 * Math.PI * 1.1 * t) };
  }

  /** Where the pointer has taken a dragged layer (its origin). */
  private dragged(id: NodeId): Point {
    const mode = this.mode as Extract<Mode, { kind: 'move' }>;
    const origin = mode.origins.get(id)!;
    return { x: origin.x + mode.shift.x, y: origin.y + mode.shift.y };
  }

  /** How far a dragged layer in auto layout is drawn from its place in the layout; null — drawn in its place. */
  private flowShift(id: NodeId): Point | null {
    const mode = this.mode;
    if (mode.kind !== 'move' || !this.lifted?.ids.includes(id) || !mode.origins.has(id) || !this.editor.inAutoLayout(id)) return null;
    const at = this.dragged(id);
    const now = this.editor.worldOrigin(id);
    return { x: at.x - now.x, y: at.y - now.y };
  }

  private startMove(start: Point, alt: boolean): void {
    const editor = this.editor;
    let ids = editor.topLevelSelection().filter((id) => editor.canTransform(id));
    if (ids.length === 0) {
      this.mode = { kind: 'idle' };
      return;
    }
    const gesture = editor.beginGesture(alt ? tr('Дублировать перетаскиванием') : tr('Переместить'));
    if (alt) {
      let copies: NodeId[] = [];
      gesture.update((tx) => {
        copies = editor.duplicateInPlace(tx, ids);
      });
      ids = copies;
      editor.setSelection(copies);
    }
    const origins = new Map<NodeId, Point>();
    for (const id of ids) origins.set(id, editor.worldOrigin(id));
    const startBounds = editor.selectionBounds()!;
    this.mode = { kind: 'move', start, gesture, ids, origins, startBounds, targets: collectTargets(editor, ids), axis: null, shift: { x: 0, y: 0 } };
    this.lift(ids);
  }

  private updateMove(world: Point, e: PointerEvent): void {
    const mode = this.mode;
    if (mode.kind !== 'move') return;
    const editor = this.editor;
    let dx = world.x - mode.start.x;
    let dy = world.y - mode.start.y;
    if (!e.shiftKey) mode.axis = null;
    else {
      // The axis is fixed once the pointer has moved a little, and kept while Shift is held (BUG-010).
      if (!mode.axis && Math.max(Math.abs(dx), Math.abs(dy)) * editor.viewport.zoom >= 4) mode.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      if (mode.axis === 'x') dy = 0;
      else if (mode.axis === 'y') dx = 0;
      else dx = dy = 0;
    }
    // The constrained pointer decides where the object lands, not the raw cursor.
    const point = { x: mode.start.x + dx, y: mode.start.y + dy };
    // Drop target: the frame under the cursor (FR-CNV-054); Mod keeps the current parent.
    // Children of a group stay in it when dragged; the group grows (BUG-014). Leave a group via the layers panel.
    const inGroup = (id: NodeId) => editor.doc.type(editor.doc.parent(id)!) === 'GROUP';
    const keepParent = this.modKey(e) || mode.ids.every(inGroup);
    const target = keepParent ? null : editor.containerAt(point, mode.ids);
    const autoTarget = target !== null && isFrameLike(editor.doc.type(target)) && editor.doc.get(target, 'layoutMode') !== 'NONE';
    const guided = editor.guides.length > 0;
    editor.guides = [];
    mode.snap = { x: 0, y: 0 };
    // Inside auto layout the position comes from the layout, so snapping would only mislead.
    if (!this.modKey(e) && !autoTarget) {
      const moved = { ...mode.startBounds, x: mode.startBounds.x + dx, y: mode.startBounds.y + dy };
      const snap = snapRect(editor, moved, mode.targets);
      if (mode.axis !== 'y' && !(e.shiftKey && !mode.axis)) {
        dx += snap.dx;
        mode.snap.x = snap.dx;
      }
      if (mode.axis !== 'x' && !(e.shiftKey && !mode.axis)) {
        dy += snap.dy;
        mode.snap.y = snap.dy;
      }
      editor.guides = snap.guides;
      // A guide caught: a tiny click (when sounds are on).
      if (!guided && snap.guides.length > 0) play('snap');
      editor.spacing = snap.spacing;
      // Distances to the nearest neighbours on each side (FR-CNV-041), not too far away.
      const box = { ...mode.startBounds, x: mode.startBounds.x + dx, y: mode.startBounds.y + dy };
      const limit = 400 / editor.viewport.zoom;
      editor.distances = editor.view.snapping ? neighbourDistances(box, mode.targets.boxes).filter((m) => m.value <= limit) : [];
      editor.distanceHelpers = [];
    } else {
      editor.spacing = [];
      editor.distances = [];
    }
    // Into a grid: the cell under the pointer (layers after the first take the next cells).
    const cell = autoTarget && editor.doc.get(target, 'layoutMode') === 'GRID' ? editor.gridCellAt(target, point) : null;
    const index = autoTarget && !cell ? this.insertionIndex(target, point, mode.ids) : null;
    editor.dropTarget = target ? { parent: target, index, ...(cell ? { cell } : {}) } : null;
    mode.shift = { x: dx, y: dy };
    mode.gesture.update((tx) => {
      for (const id of mode.ids) {
        const parent = editor.doc.parent(id)!;
        if (target && target !== parent && !inGroup(id)) {
          if (!editor.reparentKeepingPosition(tx, id, target, autoTarget ? (cell ? { at: 'end' } : { index: index ?? 0 }) : { at: 'end' })) continue;
        } else if (cell && target === parent) {
          // stays in its grid; the cell is set below
        } else if (autoTarget && target === parent && index !== null) {
          const siblings = editor.doc.children(parent).filter((s) => !mode.ids.includes(s));
          const anchor = siblings[index];
          if (siblings.indexOf(id) !== index) tx.move(id, parent, anchor ? { before: anchor } : { at: 'end' });
        }
        if (cell && editor.doc.parent(id) === target) {
          const columns = editor.gridGeometry(target!)?.columns.length ?? 1;
          const k = mode.ids.indexOf(id);
          const column = cell.column + k;
          tx.update(id, { gridColumn: column % columns, gridRow: cell.row + Math.floor(column / columns) });
        }
        if (editor.inAutoLayout(id)) continue;
        const origin = mode.origins.get(id)!;
        const local = editor.toParentSpace(editor.doc.parent(id)!, { x: origin.x + dx, y: origin.y + dy });
        tx.update(id, { x: round2(local.x), y: round2(local.y) });
      }
    });
    this.request();
  }

  /** Where a dragged item lands among the flow children of an auto layout frame. */
  private insertionIndex(frame: NodeId, world: Point, moving: readonly NodeId[]): number {
    const editor = this.editor;
    const horizontal = editor.doc.get(frame, 'layoutMode') === 'HORIZONTAL';
    const siblings = editor.doc.children(frame).filter((s) => !moving.includes(s));
    let index = siblings.length;
    for (let i = 0; i < siblings.length; i++) {
      const b = editor.scene.bounds(siblings[i]!);
      const center = horizontal ? b.x + b.width / 2 : b.y + b.height / 2;
      if ((horizontal ? world.x : world.y) < center) {
        index = i;
        break;
      }
    }
    return index;
  }

  // ---------- marquee ----------

  /**
   * Whose layers a marquee from an empty place picks: inside a section the section's, as on the page;
   * in a presentation the slide's — the one pressed, or the one on show when the press is beside it
   * (the slides are paper, not layers: from the page the marquee took nothing).
   */
  private marqueeContainer(world: Point): NodeId {
    const editor = this.editor;
    if (editor.slideStage) {
      const slide = editor.scene.hitTest(world).find((id) => editor.isPinned(id)) ?? editor.slideStage.current();
      if (slide && editor.doc.store.isAlive(slide)) return slide;
    }
    return editor.sectionAt(world);
  }

  /**
   * Where a click on an empty place goes while the selection is inside a group or a
   * frame: its parent (one level up per click). Empty — nothing under the cursor, or only
   * a container the selection is already inside. Null — not the case (a layer of its own
   * is under the cursor, the selection is on the page, several parents, a board).
   */
  private levelUp(top: NodeId | null): NodeId | null {
    const editor = this.editor;
    const d = editor.doc;
    if (editor.isBoardFile()) return null;
    const sel = editor.topLevelSelection().filter((id) => d.store.isAlive(id));
    if (sel.length === 0) return null;
    const parents = new Set(sel.map((id) => d.parent(id)));
    if (parents.size !== 1) return null;
    const parent = [...parents][0]!;
    if (!parent || d.type(parent) === 'PAGE' || !d.store.isAlive(parent) || editor.isPinned(parent)) return null;
    const target = top ? editor.selectableFor(top, false) : null;
    if (target && (sel.includes(target) || !d.store.ancestors(sel[0]!).includes(target))) return null;
    return parent;
  }

  /** The marquee takes every layer it touches, as in Figma; with Mod (deep) the innermost layers inside frames and groups. */
  private updateMarquee(world: Point): void {
    const mode = this.mode;
    if (mode.kind !== 'marquee') return;
    const editor = this.editor;
    const d = editor.doc;
    const r = rectFromPoints(mode.start, world);
    if (r.width * editor.viewport.zoom < 2 && r.height * editor.viewport.zoom < 2) return;
    mode.moved = true;
    editor.marquee = r;
    const touched = (id: NodeId) => d.get(id, 'visible') && !d.get(id, 'locked') && intersects(r, editor.scene.bounds(id));
    const inside: NodeId[] = [];
    const collect = (parent: NodeId) => {
      for (const id of d.children(parent)) {
        if (!touched(id)) continue;
        if (mode.deep && editor.isContainer(id) && d.children(id).length > 0 && d.type(id) !== 'INSTANCE') collect(id);
        else inside.push(id);
      }
    };
    collect(mode.container);
    editor.setSelection([...mode.base, ...inside]);
    this.request();
  }

  // ---------- resize ----------

  private startResize(dir: HandleDir): void {
    const editor = this.editor;
    const ids = editor.topLevelSelection().filter((id) => editor.canTransform(id));
    if (ids.length === 0) return;
    const gesture = editor.beginGesture(tr('Изменить размер'));
    const single = ids.length === 1 ? { id: ids[0]!, m0: editor.localTransform(ids[0]!), w0: editor.doc.get(ids[0]!, 'width'), h0: editor.doc.get(ids[0]!, 'height'), origin: { x: 0, y: 0 } } : null;
    const boxes = new Map<NodeId, { world: Rect; w: number; h: number }>();
    for (const id of ids) boxes.set(id, { world: editor.scene.bounds(id), w: editor.doc.get(id, 'width'), h: editor.doc.get(id, 'height') });
    this.mode = { kind: 'resize', gesture, dir, ids, single, startBounds: editor.selectionBounds()!, boxes, targets: collectTargets(editor, ids) };
  }

  private updateResize(world: Point, e: PointerEvent): void {
    const mode = this.mode;
    if (mode.kind !== 'resize') return;
    const editor = this.editor;
    const { hx, hy } = mode.dir;
    editor.guides = [];
    const snapping = !this.modKey(e);

    if (mode.single) {
      const { id, m0, w0, h0 } = mode.single;
      const unrotated = Math.abs(m0.b) < 1e-9 && editor.parentLinearInverse(id).b === 0;
      let p = world;
      if (snapping && unrotated) {
        const sx = hx !== 0 ? snapValue(editor, 'x', p.x, mode.targets) : null;
        const sy = hy !== 0 ? snapValue(editor, 'y', p.y, mode.targets) : null;
        p = { x: sx?.value ?? p.x, y: sy?.value ?? p.y };
        editor.guides = [sx?.guide, sy?.guide].filter((g): g is Guide => !!g);
      }
      const parent = editor.doc.parent(id)!;
      const inv = invert(m0);
      if (!inv) return;
      const local = apply(inv, editor.toParentSpace(parent, p));
      let left = 0;
      let right = w0;
      let top = 0;
      let bottom = h0;
      if (hx === -1) left = local.x;
      if (hx === 1) right = local.x;
      if (hy === -1) top = local.y;
      if (hy === 1) bottom = local.y;
      if (e.altKey) {
        if (hx !== 0) {
          const half = Math.abs((hx === 1 ? right : w0 - left) - w0 / 2);
          left = w0 / 2 - half;
          right = w0 / 2 + half;
        }
        if (hy !== 0) {
          const half = Math.abs((hy === 1 ? bottom : h0 - top) - h0 / 2);
          top = h0 / 2 - half;
          bottom = h0 / 2 + half;
        }
      }
      // Shift keeps the proportions; a layer with «Lock aspect ratio» keeps them unless Ctrl is held (as in Figma).
      const scale = editor.scaleMode;
      const keep = scale || (editor.doc.get(id, 'lockAspect') ? !e.ctrlKey : e.shiftKey);
      if (keep && w0 > 0 && h0 > 0) {
        // Keep proportions; the scale follows the dominant axis for corner handles.
        const sw = Math.abs(right - left) / w0;
        const sh = Math.abs(bottom - top) / h0;
        const k = hx !== 0 && hy !== 0 ? Math.max(sw, sh) : hx !== 0 ? sw : sh;
        const nw = w0 * k;
        const nh = h0 * k;
        if (e.altKey || hx === 0) {
          left = (w0 - nw) / 2;
          right = left + nw;
        } else if (hx === -1) left = right - nw;
        else right = left + nw;
        if (e.altKey || hy === 0) {
          top = (h0 - nh) / 2;
          bottom = top + nh;
        } else if (hy === -1) top = bottom - nh;
        else bottom = top + nh;
      }
      const x0 = Math.min(left, right);
      const y0 = Math.min(top, bottom);
      const w = Math.abs(right - left);
      const h = editor.doc.type(id) === 'LINE' ? 0 : Math.abs(bottom - top);
      const origin = apply(m0, { x: x0, y: y0 });
      // Mod on a frame: only the frame's box changes, its children stay where they are on the canvas (BUG-011).
      const d = editor.doc;
      const keepChildren = this.modKey(e) && isFrameLike(d.type(id)) && d.get(id, 'layoutMode') === 'NONE' && d.children(id).length > 0;
      mode.gesture.update((tx) => {
        if (keepChildren) {
          // x0/y0 are in the frame's own (start) space; children move back by the change since the last update.
          const dx = x0 - mode.single!.origin.x;
          const dy = y0 - mode.single!.origin.y;
          if (dx !== 0 || dy !== 0) {
            for (const child of d.children(id)) {
              if (editor.inAutoLayout(child)) continue;
              tx.update(child, { x: round2(d.get(child, 'x') - dx), y: round2(d.get(child, 'y') - dy) });
            }
          }
          tx.update(id, { x: round2(origin.x), y: round2(origin.y), width: round2(w), height: round2(h) });
        } else if (scale) {
          // The scale tool: everything inside grows with the box (each update scales from where the last one left it).
          tx.update(id, { x: round2(origin.x), y: round2(origin.y) });
          const byWidth = w0 > 0;
          const now = byWidth ? d.get(id, 'width') : d.get(id, 'height');
          if (now > 0) scaleNode(d, tx, id, (byWidth ? w : h) / now);
        } else {
          tx.update(id, { x: round2(origin.x), y: round2(origin.y) });
          this.editor.applySize(tx, id, round2(w), round2(h), hx !== 0, hy !== 0);
        }
      });
      mode.single.origin = keepChildren ? { x: x0, y: y0 } : mode.single.origin;
      this.request();
      return;
    }

    // Several objects: scale everything inside the selection bounds.
    const s0 = mode.startBounds;
    let left = s0.x;
    let right = s0.x + s0.width;
    let top = s0.y;
    let bottom = s0.y + s0.height;
    let p = world;
    if (snapping) {
      const sx = hx !== 0 ? snapValue(editor, 'x', p.x, mode.targets) : null;
      const sy = hy !== 0 ? snapValue(editor, 'y', p.y, mode.targets) : null;
      p = { x: sx?.value ?? p.x, y: sy?.value ?? p.y };
      editor.guides = [sx?.guide, sy?.guide].filter((g): g is Guide => !!g);
    }
    if (hx === -1) left = p.x;
    if (hx === 1) right = p.x;
    if (hy === -1) top = p.y;
    if (hy === 1) bottom = p.y;
    const keep = editor.scaleMode || (mode.ids.every((id) => editor.doc.get(id, 'lockAspect')) ? !e.ctrlKey : e.shiftKey);
    if (keep && s0.width > 0 && s0.height > 0) {
      const k = Math.max(Math.abs(right - left) / s0.width, Math.abs(bottom - top) / s0.height);
      if (hx === -1) left = right - s0.width * k;
      else right = left + s0.width * k;
      if (hy === -1) top = bottom - s0.height * k;
      else bottom = top + s0.height * k;
    }
    const nb = rectFromPoints({ x: left, y: top }, { x: right, y: bottom });
    const sx = s0.width === 0 ? 1 : nb.width / s0.width;
    const sy = s0.height === 0 ? 1 : nb.height / s0.height;
    mode.gesture.update((tx) => {
      for (const id of mode.ids) {
        const start = mode.boxes.get(id)!;
        const origin = { x: nb.x + (start.world.x - s0.x) * sx, y: nb.y + (start.world.y - s0.y) * sy };
        const local = editor.toParentSpace(editor.doc.parent(id)!, origin);
        tx.update(id, { x: round2(local.x), y: round2(local.y) });
        if (editor.scaleMode) {
          const now = editor.doc.get(id, 'width');
          if (now > 0 && start.w > 0) scaleNode(editor.doc, tx, id, (start.w * sx) / now);
          else if (editor.doc.get(id, 'height') > 0 && start.h > 0) scaleNode(editor.doc, tx, id, (start.h * sy) / editor.doc.get(id, 'height'));
        } else this.editor.applySize(tx, id, round2(start.w * sx), round2(start.h * sy), hx !== 0, hy !== 0);
      }
    });
    this.request();
  }

  // ---------- rotate ----------

  private startRotate(world: Point): void {
    const editor = this.editor;
    const id = editor.topLevelSelection()[0];
    if (!id || !editor.canTransform(id)) return;
    const m0 = editor.localTransform(id);
    const w = editor.doc.get(id, 'width');
    const h = editor.doc.get(id, 'height');
    const parent = editor.doc.parent(id)!;
    // Round the centre, or round the origin moved with Alt+R.
    const moved = editor.rotationOrigin.at;
    const pivot = moved ? editor.toParentSpace(parent, moved) : apply(m0, { x: w / 2, y: h / 2 });
    const p = editor.toParentSpace(parent, world);
    const a0 = Math.atan2(p.y - pivot.y, p.x - pivot.x);
    this.mode = { kind: 'rotate', gesture: editor.beginGesture(tr('Повернуть')), id, m0, w, h, r0: editor.doc.get(id, 'rotation'), a0, pivot };
  }

  private updateRotate(world: Point, snap: boolean): void {
    const mode = this.mode;
    if (mode.kind !== 'rotate') return;
    const editor = this.editor;
    const parent = editor.doc.parent(mode.id)!;
    const c = mode.pivot;
    const p = editor.toParentSpace(parent, world);
    const a = Math.atan2(p.y - c.y, p.x - c.x);
    let rotation = mode.r0 + ((a - mode.a0) * 180) / Math.PI;
    if (snap) rotation = Math.round(rotation / 15) * 15;
    rotation = normalizeAngle(round2(rotation));
    // The layer's corner turned round the pivot by the change of angle.
    const turn = ((rotation - mode.r0) * Math.PI) / 180;
    const dx = mode.m0.e - c.x;
    const dy = mode.m0.f - c.y;
    const ox = c.x + dx * Math.cos(turn) - dy * Math.sin(turn);
    const oy = c.y + dx * Math.sin(turn) + dy * Math.cos(turn);
    mode.gesture.update((tx) => tx.update(mode.id, { rotation, x: round2(ox), y: round2(oy) }));
    this.request();
  }

  // ---------- create ----------

  private updateCreate(world: Point, screen: Point, e: PointerEvent): void {
    const mode = this.mode;
    if (mode.kind !== 'create') return;
    const editor = this.editor;
    if (!mode.gesture && Math.hypot(screen.x - mode.screen.x, screen.y - mode.screen.y) <= DRAG_THRESHOLD) return;
    let p = world;
    editor.guides = [];
    if (!this.modKey(e)) {
      const sx = snapValue(editor, 'x', p.x, mode.targets);
      const sy = snapValue(editor, 'y', p.y, mode.targets);
      p = { x: sx.value, y: sy.value };
      editor.guides = [sx.guide, sy.guide].filter((g): g is Guide => !!g);
    }
    let w = p.x - mode.start.x;
    let h = p.y - mode.start.y;
    if (e.shiftKey) {
      if (mode.type === 'LINE') {
        const angle = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(w, h);
        w = Math.cos(angle) * len;
        h = Math.sin(angle) * len;
      } else {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
    }
    let rect: Rect;
    if (e.altKey && mode.type !== 'LINE') rect = { x: mode.start.x - Math.abs(w), y: mode.start.y - Math.abs(h), width: Math.abs(w) * 2, height: Math.abs(h) * 2 };
    else rect = rectFromPoints(mode.start, { x: mode.start.x + w, y: mode.start.y + h });
    if (!mode.gesture) {
      mode.gesture = editor.beginGesture(tr('Создать'));
      const type = mode.type;
      const parent = mode.parent;
      let id = '';
      mode.gesture.update((tx) => {
        id = tx.create(type, parent, { name: editor.nextName(type), ...defaultsFor(type), ...mode.extra });
      });
      mode.id = id;
      editor.setSelection([id]);
    }
    const id = mode.id!;
    mode.gesture.update((tx) => {
      if (mode.type === 'LINE') {
        const local = editor.toParentSpace(mode.parent, mode.start);
        const length = Math.hypot(w, h);
        const rotation = (Math.atan2(h, w) * 180) / Math.PI;
        tx.update(id, { x: round2(local.x), y: round2(local.y), width: round2(length), height: 0, rotation: round2(rotation) });
        return;
      }
      const local = editor.toParentSpace(mode.parent, { x: rect.x, y: rect.y });
      const props: Partial<NodeProps> = { x: round2(local.x), y: round2(local.y), width: round2(rect.width), height: round2(rect.height) };
      if (mode.type === 'TEXT') props.textAutoResize = 'HEIGHT';
      tx.update(id, props);
    });
    this.request();
  }

  private finishCreate(mode: Extract<Mode, { kind: 'create' }>): void {
    const editor = this.editor;
    if (mode.gesture && mode.id) {
      // A drawn section takes in the layers it encloses (FR-CNV: sections).
      if (mode.type === 'SECTION') mode.gesture.update((tx) => editor.adoptIntoSection(tx, mode.id!));
      mode.gesture.commit();
      editor.setTool('select');
      if (mode.type === 'TEXT') editor.startTextEditing(mode.id);
      return;
    }
    // A click without dragging: default size at the click point.
    const local = editor.toParentSpace(mode.parent, mode.start);
    const type = mode.type;
    const props: Partial<NodeProps> = { ...defaultsFor(type), x: round2(local.x), y: round2(local.y) };
    if (type === 'TEXT') {
      const id = editor.commit(tr('Создать текст'), (tx) => tx.create('TEXT', mode.parent, { name: editor.nextName('TEXT'), ...props }));
      editor.setTool('select');
      editor.startTextEditing(id);
      return;
    }
    if (type === 'FRAME' || type === 'RECTANGLE' || type === 'ELLIPSE' || type === 'POLYGON' || type === 'STAR') Object.assign(props, { width: 100, height: 100 });
    if (type === 'LINE') Object.assign(props, { width: 100, height: 0 });
    let id = '';
    editor.commit(tr('Создать'), (tx) => {
      id = tx.create(type, mode.parent, { name: editor.nextName(type), ...props, ...mode.extra });
    }, () => [id]);
    editor.setTool('select');
  }

  // ---------- pen and point editing (stage "Vectors": vector networks) ----------
  // Point editing works on the vector's network: points (vertices) joined by
  // segments in any way, and filled regions. Tools inside it: edit points,
  // pen (draw on from any point — three or more segments may meet), paint
  // bucket (fill or empty the area under the pointer) and scissors (cut a
  // segment or split a point). A new drawing with the pen is point editing of
  // a new vector with the pen.

  /** The bar of point editing over the canvas: its tools, simplify and done. */
  private vectorBar: HTMLElement | null = null;

  private updateVectorBar(): void {
    const editor = this.editor;
    const edit = editor.vectorEdit;
    if (!edit) {
      this.vectorBar?.remove();
      this.vectorBar = null;
      return;
    }
    if (!this.vectorBar) {
      const tool = (id: 'edit' | 'pen' | 'bucket' | 'scissors' | 'eraser' | 'lasso' | 'width', iconName: string, label: string, hint: string) =>
        h('button', { class: 'vector-bar-tool', type: 'button', 'data-tool': id, title: hint, 'aria-label': label, onclick: () => editor.setVectorTool(id) }, icon(iconName, 16), h('span', {}, label));
      this.vectorBar = h(
        'div',
        { class: 'vector-bar', role: 'toolbar', 'aria-label': tr('Правка точек') },
        tool('edit', 'select', tr('Править'), tr('Двигать точки и ручки, щелчок по сегменту добавляет точку, рамка выделяет точки (V)')),
        tool('lasso', 'lasso', tr('Лассо'), tr('Обведите точки произвольной линией — они выделятся; Shift добавляет к выделенным (Q)')),
        tool('pen', 'pen', tr('Перо'), tr('Рисовать дальше от любой точки — из одной точки может выходить сколько угодно сегментов (P)')),
        tool('bucket', 'bucket', tr('Заливка'), tr('Щелчок по замкнутой области заливает её, повторный — убирает заливку (B)')),
        tool('scissors', 'scissors', tr('Ножницы'), tr('Щелчок по сегменту разрезает его, по точке — разъединяет сегменты в ней')),
        tool('width', 'width', tr('Ширина'), tr('Щелчок по линии ставит точку ширины, ручки по бокам меняют толщину, центр двигает точку вдоль линии; Delete убирает точку (Shift+W)')),
        tool('eraser', 'eraser', tr('Ластик'), tr('Проведите по контуру — его часть сотрётся, на краях появятся новые точки. Толщина — в правой панели (Shift+E)')),
        h('span', { class: 'vector-bar-sep' }),
        h('button', { class: 'vector-bar-tool', type: 'button', title: tr('Меньше точек при том же виде'), onclick: () => editor.simplifySelection() }, h('span', {}, tr('Упростить'))),
        h('button', { class: 'text-button primary', type: 'button', onclick: () => this.finishVectorEdit() }, tr('Готово')),
      );
      this.element.append(this.vectorBar);
    }
    for (const b of this.vectorBar.querySelectorAll<HTMLElement>('[data-tool]')) b.classList.toggle('active', b.dataset.tool === edit.tool);
  }

  /** The pen inside point editing: the point drawing goes on from, and the control of the next segment there. */
  private pen: { last: number | null; out: Point | null; fresh: boolean } | null = null;
  private penHover: Point | null = null;
  /** Under the pointer in point editing: the area the bucket would fill, the segment the scissors would cut. */
  private bucketHover: Point[][] | null = null;
  private scissorsHover: number | null = null;

  /** Enter: finishes the pen path or leaves point editing. */
  confirm(): boolean {
    if (this.editor.vectorEdit) {
      this.finishVectorEdit();
      return true;
    }
    return false;
  }

  /** Leaves point editing; a vector the pen left without segments goes. */
  private finishVectorEdit(): void {
    const editor = this.editor;
    const edit = editor.vectorEdit;
    this.pen = null;
    this.penHover = null;
    if (!edit) return;
    const net = editor.networkOf(edit.id);
    if (net && net.segments.length === 0) {
      editor.commit(tr('Перо'), (tx) => tx.delete(edit.id));
      editor.exitVectorEdit();
      editor.setSelection([]);
    } else editor.exitVectorEdit();
    editor.setTool('select');
    this.request();
  }

  /** World point → the edited vector's own coordinates. */
  private toNode(id: NodeId, world: Point): Point {
    const inv = invert(this.editor.scene.world(id));
    return inv ? apply(inv, world) : world;
  }

  /** A new drawing with the pen tool: a vector with one point, edited with the pen. */
  private penStart(world: Point, e: PointerEvent): void {
    const editor = this.editor;
    const parent = editor.containerAt(world);
    const local = editor.toParentSpace(parent, world);
    let id = '';
    editor.commit(tr('Перо'), (tx) => {
      id = tx.create('VECTOR', parent, { name: editor.nextName('VECTOR'), x: round2(local.x), y: round2(local.y), width: 0, height: 0, vectorPaths: [], vectorNetwork: { vertices: [{ x: 0, y: 0 }], segments: [], regions: [] } });
    }, () => []);
    editor.enterVectorEdit(id, 'pen');
    this.pen = { last: 0, out: null, fresh: true };
    // Dragging out of the first point pulls the handle of the first segment.
    this.mode = { kind: 'pen-drag', gesture: editor.beginGesture(tr('Изменить кривую')), vertex: 0, start: { x: 0, y: 0 }, segment: null };
    this.canvas.setPointerCapture(e.pointerId);
  }

  /** The vertex of the edited network under a screen point. */
  private vertexAt(id: NodeId, screen: Point, radius = 7): number | null {
    const net = this.editor.networkOf(id);
    if (!net) return null;
    const m = this.editor.scene.world(id);
    for (let v = net.vertices.length - 1; v >= 0; v--) {
      const sp = this.screenPoint(apply(m, net.vertices[v]!));
      if (Math.abs(screen.x - sp.x) <= radius && Math.abs(screen.y - sp.y) <= radius) return v;
    }
    return null;
  }

  /** A click with the pen in point editing: a new point and segment, or a joint with a point already there. */
  private penDown(world: Point, screen: Point, e: PointerEvent): void {
    const editor = this.editor;
    const edit = editor.vectorEdit!;
    const id = edit.id;
    const net = editor.networkOf(id);
    if (!net) return;
    this.pen ??= { last: edit.selected.length === 1 ? Number(edit.selected[0]) : null, out: null, fresh: false };
    const pen = this.pen;
    const hit = this.vertexAt(id, screen, 8);
    let local = this.toNode(id, world);
    // Starting from a point: the drawing goes on from there (a branch when it already has two segments).
    if (pen.last === null) {
      if (hit !== null) {
        pen.last = hit;
        pen.out = null;
        editor.setVectorSelection([String(hit)]);
        return;
      }
      const gesture = editor.beginGesture(tr('Перо'));
      let v = 0;
      gesture.update((tx) => {
        v = net.vertices.length;
        tx.set(id, 'vectorNetwork', { ...net, vertices: [...net.vertices, { x: round2(local.x), y: round2(local.y) }] });
      });
      pen.last = v;
      this.mode = { kind: 'pen-drag', gesture, vertex: v, start: { x: round2(local.x), y: round2(local.y) }, segment: null };
      editor.setVectorSelection([String(v)]);
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    const from = net.vertices[pen.last];
    if (!from) {
      pen.last = null;
      return;
    }
    if (hit === pen.last) return;
    if (e.shiftKey) local = snapAngle(from, local);
    const gesture = editor.beginGesture(tr('Перо'));
    const vertices = [...net.vertices];
    let target = hit;
    if (target === null) {
      vertices.push({ x: round2(local.x), y: round2(local.y) });
      target = vertices.length - 1;
    }
    const segment = { a: pen.last, b: target, ...(pen.out ? { ca: pen.out } : {}) };
    const segments = [...net.segments, segment];
    let next = { vertices, segments, regions: net.regions };
    const joined = hit !== null;
    if (joined) {
      // A joint that closes a loop: the new area is filled (as Figma does when a path is closed);
      // a filled area cut in two keeps both halves filled.
      const si = segments.length - 1;
      const faces = findFaces(next).filter((f) => f.loop.includes(si)).sort((x, y) => Math.abs(x.area) - Math.abs(y.area));
      const face = faces[0];
      // Closing a loop: the segment borders one face only. Cutting a face in two: it borders two, and they keep their fill.
      const closing = faces.length === 1;
      next = refillPart(net, next, target, face && closing ? { loop: face.loop, filled: true } : undefined);
    }
    const t = target;
    gesture.update((tx) => {
      tx.set(id, 'vectorNetwork', next);
      if (joined && next.regions.length > net.regions.length && !editor.doc.get(id, 'fills').some((f) => f.visible)) tx.set(id, 'fills', [solid(rgba(0.85, 0.85, 0.85))]);
    });
    // A joint ends the path (the pen starts anew from the next point clicked).
    pen.last = joined ? null : t;
    pen.out = null;
    editor.setVectorSelection(joined ? [] : [String(t)]);
    this.mode = { kind: 'pen-drag', gesture, vertex: t, start: { ...vertices[t]! }, segment: segments.length - 1 };
    this.canvas.setPointerCapture(e.pointerId);
  }

  /** Dragging after placing a point pulls out symmetric curve handles (Alt — only the outgoing one). */
  private penDrag(world: Point, e: PointerEvent): void {
    const mode = this.mode;
    const edit = this.editor.vectorEdit;
    if (mode.kind !== 'pen-drag' || !edit || !this.pen) return;
    let local = this.toNode(edit.id, world);
    if (e.shiftKey) local = snapAngle(mode.start, local);
    const dx = local.x - mode.start.x;
    const dy = local.y - mode.start.y;
    if (Math.hypot(dx, dy) * this.editor.viewport.zoom < 2) return;
    const out = { x: round2(mode.start.x + dx), y: round2(mode.start.y + dy) };
    if (this.pen.last === mode.vertex) this.pen.out = out;
    const net = this.editor.networkOf(edit.id);
    if (!net) return;
    // The segment just drawn arrives with the mirrored handle.
    if (mode.segment !== null && !e.altKey) {
      const segments = net.segments.map((s, i) => (i === mode.segment ? { ...s, cb: { x: round2(mode.start.x - dx), y: round2(mode.start.y - dy) } } : s));
      mode.gesture.update((tx) => tx.set(edit.id, 'vectorNetwork', { ...net, segments }));
    }
    this.request();
  }

  /** The edited network's outline, points, handles and what the tool would do under the pointer. */
  private drawVectorEdit(): void {
    const editor = this.editor;
    const edit = editor.vectorEdit;
    const net = edit ? editor.networkOf(edit.id) : null;
    if (!edit || !net) return;
    const ctx = this.ctx;
    const m = editor.scene.world(edit.id);
    const z = editor.viewport.zoom;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.transform(z, 0, 0, z, editor.viewport.offsetX, editor.viewport.offsetY);
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    if (this.bucketHover && edit.tool === 'bucket') {
      ctx.fillStyle = 'rgba(79, 91, 213, 0.25)';
      ctx.beginPath();
      for (const poly of this.bucketHover) poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.fill('evenodd');
    }
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5 / z;
    ctx.stroke(pathOf(strokeChains(net)));
    if (this.scissorsHover !== null && edit.tool === 'scissors' && net.segments[this.scissorsHover]) {
      ctx.strokeStyle = '#F24822';
      ctx.lineWidth = 3 / z;
      const c = cubicOf(net, net.segments[this.scissorsHover]!);
      ctx.beginPath();
      ctx.moveTo(c.p0.x, c.p0.y);
      ctx.bezierCurveTo(c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.p3.x, c.p3.y);
      ctx.stroke();
    }
    ctx.restore();
    // The frame round the selected points: scale by its handles, rotate just outside a corner.
    const pbox = this.pointsBox();
    if (pbox) {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      pbox.handles.slice(0, 4).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      for (const p of pbox.handles) {
        ctx.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
        ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
      }
    }
    // Width points: a dot on the line and a handle at each side; the place a click would add one.
    if (edit.tool === 'width') this.drawWidthPoints(edit.id);
    // The lasso being drawn.
    if (this.mode.kind === 'vec-marquee' && this.mode.lasso && this.mode.lasso.length > 1) {
      ctx.beginPath();
      this.mode.lasso.forEach((q, i) => {
        const p = this.screenPoint(q);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(79, 91, 213, 0.08)';
      ctx.fill();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // The eraser: a circle of its weight at the pointer.
    if (edit.tool === 'eraser' && this.penHover) {
      const p = this.screenPoint(this.penHover);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, (editor.eraserWeight / 2) * z), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(242, 72, 34, 0.12)';
      ctx.fill();
      ctx.strokeStyle = '#F24822';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // Rubber band from the pen's point to the pointer.
    if (edit.tool === 'pen' && this.pen?.last != null && this.penHover && this.mode.kind !== 'pen-drag') {
      const from = net.vertices[this.pen.last];
      if (from) {
        const a = this.screenPoint(apply(m, from));
        const b = this.screenPoint(this.penHover);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        if (this.pen.out) {
          const c = this.screenPoint(apply(m, this.pen.out));
          ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
        } else ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    const selected = new Set(edit.selected);
    // Handles of the selected points: the control points of their segments at that end.
    net.segments.forEach((s) => {
      for (const [v, c] of [[s.a, s.ca], [s.b, s.cb]] as const) {
        if (!c || !selected.has(String(v))) continue;
        const sp = this.screenPoint(apply(m, net.vertices[v]!));
        const sh = this.screenPoint(apply(m, c));
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(sh.x, sh.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sh.x, sh.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.stroke();
      }
    });
    net.vertices.forEach((p, v) => {
      const sp = this.screenPoint(apply(m, p));
      const on = selected.has(String(v)) || (edit.tool === 'pen' && this.pen?.last === v);
      ctx.fillStyle = on ? ACCENT : '#FFFFFF';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.fillRect(sp.x - 3.5, sp.y - 3.5, 7, 7);
      ctx.strokeRect(sp.x - 3.5, sp.y - 3.5, 7, 7);
    });
  }

  /** What the pointer is over in point editing, for the bucket and the scissors (shown before the click). */
  /**
   * The frame round two or more selected points (Figma: scale and rotate a group of
   * points): its box in the vector's coordinates, a little out from the points so
   * the handles do not cover them, and the handles on the screen — corners
   * (top-left, top-right, bottom-right, bottom-left), then the sides (top, right,
   * bottom, left).
   */
  private pointsBox(): { box: Rect; handles: Point[] } | null {
    const editor = this.editor;
    const edit = editor.vectorEdit;
    if (!edit || (edit.tool !== 'edit' && edit.tool !== 'lasso') || edit.selected.length < 2) return null;
    if (this.mode.kind !== 'idle' && this.mode.kind !== 'vec-transform') return null;
    const net = editor.networkOf(edit.id);
    if (!net) return null;
    const box = (() => {
      const pts = edit.selected.map((k) => net.vertices[Number(k)]).filter((p): p is NonNullable<typeof p> => !!p);
      if (pts.length < 2) return null;
      const pad = 8 / editor.viewport.zoom;
      const x0 = Math.min(...pts.map((p) => p.x)) - pad;
      const y0 = Math.min(...pts.map((p) => p.y)) - pad;
      return { x: x0, y: y0, width: Math.max(...pts.map((p) => p.x)) + pad - x0, height: Math.max(...pts.map((p) => p.y)) + pad - y0 };
    })();
    if (!box) return null;
    const m = editor.scene.world(edit.id);
    const at = (fx: number, fy: number) => this.screenPoint(apply(m, { x: box.x + box.width * fx, y: box.y + box.height * fy }));
    return { box, handles: [at(0, 0), at(1, 0), at(1, 1), at(0, 1), at(0.5, 0), at(1, 0.5), at(0.5, 1), at(0, 0.5)] };
  }

  /** A handle of the points' frame under the pointer: 0–7 scale (as in `pointsBox`), 8 — rotate (just outside a corner). */
  private pointsBoxHandleAt(screen: Point): { box: Rect; handle: number } | null {
    const pbox = this.pointsBox();
    if (!pbox) return null;
    const i = pbox.handles.findIndex((p) => Math.abs(p.x - screen.x) <= 5 && Math.abs(p.y - screen.y) <= 5);
    if (i >= 0) return { box: pbox.box, handle: i };
    const near = pbox.handles.slice(0, 4).some((p) => Math.hypot(p.x - screen.x, p.y - screen.y) <= 18);
    const quad = pbox.handles.slice(0, 4);
    return near && !pointInPolygon(quad, screen) ? { box: pbox.box, handle: 8 } : null;
  }

  /** Scales or rotates the selected points (with the handles of the curves at them). */
  private transformPoints(p: Point, e: PointerEvent): void {
    const mode = this.mode;
    if (mode.kind !== 'vec-transform') return;
    const { box, handle, start } = mode;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    let fn: (q: Point) => Point;
    if (handle === 8) {
      let angle = Math.atan2(p.y - center.y, p.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x);
      if (e.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      fn = (q) => ({ x: center.x + (q.x - center.x) * cos - (q.y - center.y) * sin, y: center.y + (q.x - center.x) * sin + (q.y - center.y) * cos });
    } else {
      // Which sides the handle moves: x (−1 left, 1 right, 0 none), y likewise.
      const SIDES: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]];
      const [hx, hy] = SIDES[handle]!;
      const edgeX = hx < 0 ? box.x : box.x + box.width;
      const edgeY = hy < 0 ? box.y : box.y + box.height;
      // Alt: from the centre; otherwise from the opposite side.
      const ax = e.altKey ? center.x : hx < 0 ? box.x + box.width : box.x;
      const ay = e.altKey ? center.y : hy < 0 ? box.y + box.height : box.y;
      let sx = hx === 0 || edgeX === ax ? 1 : (p.x - ax) / (edgeX - ax);
      let sy = hy === 0 || edgeY === ay ? 1 : (p.y - ay) / (edgeY - ay);
      // Shift: proportions kept.
      if (e.shiftKey) {
        const s = hx !== 0 && hy !== 0 ? (Math.abs(sx) > Math.abs(sy) ? sx : sy) : hx !== 0 ? sx : sy;
        sx = Math.sign(sx || 1) * Math.abs(s);
        sy = Math.sign(sy || 1) * Math.abs(s);
      }
      fn = (q) => ({ x: ax + (q.x - ax) * sx, y: ay + (q.y - ay) * sy });
    }
    const net = mode.net;
    const next: VectorNetwork = {
      ...net,
      vertices: net.vertices.map((v, i) => (mode.chosen.has(i) ? { ...v, ...fn(v) } : v)),
      segments: net.segments.map((s) => ({ ...s, ...(s.ca && mode.chosen.has(s.a) ? { ca: fn(s.ca) } : {}), ...(s.cb && mode.chosen.has(s.b) ? { cb: fn(s.cb) } : {}) })),
    };
    mode.gesture.update((tx) => tx.set(mode.id, 'vectorNetwork', next));
    this.request();
  }

  /** With the width tool: where along the line a click would add a width point. */
  private widthHover: number | null = null;

  /** The first line the stroke follows, with lengths along it (the same `t` the stroke's width uses). */
  private widthLine(id: NodeId): { pts: Point[]; len: number[]; total: number } | null {
    const line = flattenPaths(strokeLinePaths(this.editor.doc, id), 0.2)[0];
    if (!line || line.points.length < 2) return null;
    const pts = line.points;
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
    const total = len[len.length - 1]! + (line.closed ? Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y) : 0);
    return total > 0 ? { pts: line.closed ? [...pts, pts[0]!] : pts, len: line.closed ? [...len, total] : len, total } : null;
  }

  /** A place on the line by its share of the length, with the unit normal there. */
  private widthAtT(line: { pts: Point[]; len: number[]; total: number }, t: number): { p: Point; n: Point } {
    const s = Math.max(0, Math.min(1, t)) * line.total;
    let i = 1;
    while (i < line.pts.length - 1 && line.len[i]! < s) i++;
    const a = line.pts[i - 1]!;
    const b = line.pts[i]!;
    const seg = line.len[i]! - line.len[i - 1]! || 1;
    const f = Math.max(0, Math.min(1, (s - line.len[i - 1]!) / seg));
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, n: { x: -(b.y - a.y) / l, y: (b.x - a.x) / l } };
  }

  /** The nearest place on the line to a point of the vector: its `t` and distance. */
  private widthNearest(line: { pts: Point[]; len: number[]; total: number }, q: Point): { t: number; distance: number } {
    let best = { t: 0, distance: Infinity };
    for (let i = 1; i < line.pts.length; i++) {
      const a = line.pts[i - 1]!;
      const b = line.pts[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const f = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
      const d = Math.hypot(q.x - (a.x + dx * f), q.y - (a.y + dy * f));
      if (d < best.distance) best = { t: (line.len[i - 1]! + (line.len[i]! - line.len[i - 1]!) * f) / line.total, distance: d };
    }
    return best;
  }

  /** The line under the pointer (within the stroke and a little more). */
  private widthNear(id: NodeId, world: Point): { t: number } | null {
    const line = this.widthLine(id);
    if (!line) return null;
    const near = this.widthNearest(line, this.toNode(id, world));
    const d = this.editor.doc;
    const reach = (d.get(id, 'strokeWeight') / 2) * widthAt(d.get(id, 'strokeProfile') === 'CUSTOM' ? d.get(id, 'widthPoints') : [], near.t) + 6 / this.editor.viewport.zoom;
    return near.distance <= reach ? { t: near.t } : null;
  }

  /** Handles of the width points on the screen: the centre and both sides. */
  private widthHandles(id: NodeId): { index: number; center: Point; sides: [Point, Point] }[] {
    const d = this.editor.doc;
    const line = this.widthLine(id);
    if (!line || d.get(id, 'strokeProfile') !== 'CUSTOM') return [];
    const m = this.editor.scene.world(id);
    const half = d.get(id, 'strokeWeight') / 2;
    return d.get(id, 'widthPoints').map((w, index) => {
      const { p, n } = this.widthAtT(line, w.t);
      const r = Math.max(half * w.width, 4 / this.editor.viewport.zoom);
      const screen = (q: Point) => this.screenPoint(apply(m, q));
      return { index, center: screen(p), sides: [screen({ x: p.x + n.x * r, y: p.y + n.y * r }), screen({ x: p.x - n.x * r, y: p.y - n.y * r })] as [Point, Point] };
    });
  }

  private widthHit(id: NodeId, screen: Point): { index: number; part: 'center' | 'side' } | null {
    // The nearest handle wins: on a thin point the sides sit close to the centre.
    let best: { index: number; part: 'center' | 'side'; d: number } | null = null;
    for (const h of this.widthHandles(id)) {
      for (const [p, part] of [[h.center, 'center'], [h.sides[0], 'side'], [h.sides[1], 'side']] as const) {
        const d = Math.hypot(p.x - screen.x, p.y - screen.y);
        if (d <= 6 && (!best || d < best.d)) best = { index: h.index, part, d };
      }
    }
    return best && { index: best.index, part: best.part };
  }

  /** A press with the width tool: a handle of a point, or a new point on the line (its width then follows the pointer). */
  private widthDown(id: NodeId, world: Point, screen: Point): void {
    const editor = this.editor;
    const d = editor.doc;
    const hit = this.widthHit(id, screen);
    if (hit) {
      editor.setWidthSelection(hit.index);
      this.mode = { kind: 'vec-width', gesture: editor.beginGesture(tr('Точка ширины')), id, index: hit.index, along: hit.part === 'center' };
      return;
    }
    const near = this.widthNear(id, world);
    if (!near) {
      editor.setWidthSelection(null);
      return;
    }
    if (d.get(id, 'strokeWeight') <= 0 || !d.get(id, 'strokes').some((p) => p.visible)) {
      editor.toast(tr('Толщина вдоль линии — у обводки: добавьте слою обводку'));
      return;
    }
    const custom = d.get(id, 'strokeProfile') === 'CUSTOM';
    const existing = custom ? d.get(id, 'widthPoints') : [];
    const point = { t: Math.round(near.t * 10000) / 10000, width: Math.round(widthAt(existing, near.t) * 100) / 100 };
    const gesture = editor.beginGesture(tr('Точка ширины'));
    gesture.update((tx) => {
      tx.set(id, 'strokeProfile', 'CUSTOM');
      tx.set(id, 'widthPoints', [...existing, point]);
    });
    editor.setWidthSelection(existing.length);
    this.mode = { kind: 'vec-width', gesture, id, index: existing.length, along: false };
  }

  /** Drags a width point: its side — the width (the distance from the line), its centre — along the line. */
  private widthDrag(mode: Extract<Mode, { kind: 'vec-width' }>, local: Point): void {
    const d = this.editor.doc;
    const line = this.widthLine(mode.id);
    const points = d.get(mode.id, 'widthPoints');
    const w = points[mode.index];
    if (!line || !w) return;
    let next = w;
    if (mode.along) next = { ...w, t: Math.round(this.widthNearest(line, local).t * 10000) / 10000 };
    else {
      const { p, n } = this.widthAtT(line, w.t);
      const half = d.get(mode.id, 'strokeWeight') / 2;
      const dist = Math.abs((local.x - p.x) * n.x + (local.y - p.y) * n.y);
      next = { ...w, width: Math.round(Math.min(20, dist / Math.max(0.01, half)) * 100) / 100 };
    }
    mode.gesture.update((tx) => tx.set(mode.id, 'widthPoints', points.map((x, i) => (i === mode.index ? next : x))));
    this.request();
  }

  private drawWidthPoints(id: NodeId): void {
    const ctx = this.ctx;
    for (const h of this.widthHandles(id)) {
      const chosen = this.editor.widthSelection === h.index;
      ctx.strokeStyle = '#F24E9E';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(h.sides[0].x, h.sides[0].y);
      ctx.lineTo(h.sides[1].x, h.sides[1].y);
      ctx.stroke();
      for (const s of h.sides) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(h.center.x, h.center.y, chosen ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = chosen ? '#F24E9E' : '#FFFFFF';
      ctx.fill();
      ctx.stroke();
    }
    if (this.widthHover !== null && this.mode.kind === 'idle') {
      const line = this.widthLine(id);
      if (line) {
        const p = this.screenPoint(apply(this.editor.scene.world(id), this.widthAtT(line, this.widthHover).p));
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(242, 78, 158, 0.5)';
        ctx.fill();
      }
    }
  }

  /** The rotation origin on the screen while it is shown (Alt+R): where it was moved, or the layer's centre. */
  private originPoint(): Point | null {
    const editor = this.editor;
    if (!editor.rotationOrigin.shown || editor.tool !== 'select') return null;
    const ids = editor.topLevelSelection();
    if (ids.length !== 1 || !editor.canTransform(ids[0]!)) return null;
    const id = ids[0]!;
    if (editor.rotationOrigin.at) return this.screenPoint(editor.rotationOrigin.at);
    return this.screenPoint(apply(editor.scene.world(id), { x: editor.doc.get(id, 'width') / 2, y: editor.doc.get(id, 'height') / 2 }));
  }

  private drawOrigin(accent: string): void {
    const p = this.originPoint();
    if (!p) return;
    const ctx = this.ctx;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x - 10, p.y);
    ctx.lineTo(p.x + 10, p.y);
    ctx.moveTo(p.x, p.y - 10);
    ctx.lineTo(p.x, p.y + 10);
    ctx.stroke();
  }

  /** The eraser goes on to a point of the edited vector (its own coordinates). */
  private eraseTo(at: Point): void {
    const mode = this.mode;
    if (mode.kind !== 'vec-erase') return;
    const r = this.editor.eraserWeight / 2;
    const next = mode.fill ? eraseFill(mode.net, mode.last, at, r) : eraseNetwork(mode.net, mode.last, at, r);
    mode.last = at;
    if (!next) return;
    mode.net = next;
    mode.gesture.update((tx) => tx.set(mode.id, 'vectorNetwork', next));
  }

  private vectorHover(world: Point, screen: Point): void {
    const editor = this.editor;
    const edit = editor.vectorEdit;
    const net = edit ? editor.networkOf(edit.id) : null;
    this.bucketHover = null;
    this.scissorsHover = null;
    if (!edit || !net) return;
    const boxHandle = this.vectorHit(screen)?.kind === 'point' ? null : this.pointsBoxHandleAt(screen);
    if (boxHandle) {
      this.canvas.style.cursor = boxHandle.handle === 8 ? 'alias' : ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'][boxHandle.handle]!;
      return;
    }
    const local = this.toNode(edit.id, world);
    if (edit.tool === 'bucket') {
      const region = regionAt(net, local);
      if (region) this.bucketHover = region.loops.map((loop) => flattenPaths([loopPath(net, loop)!].filter(Boolean), 0.5)[0]?.points ?? []);
      this.canvas.style.cursor = region ? 'cell' : 'not-allowed';
    } else if (edit.tool === 'scissors') {
      const near = nearestSegment(net, local);
      if (near && near.distance * editor.viewport.zoom <= 6 && this.vertexAt(edit.id, screen) === null) this.scissorsHover = near.segment;
      this.canvas.style.cursor = 'crosshair';
    } else if (edit.tool === 'pen') {
      this.penHover = world;
      this.canvas.style.cursor = 'crosshair';
    } else if (edit.tool === 'eraser') {
      this.penHover = world;
      this.canvas.style.cursor = 'none';    } else if (edit.tool === 'lasso') {
      this.canvas.style.cursor = 'crosshair';
    } else if (edit.tool === 'width') {
      const hit = this.widthHit(edit.id, screen);
      const near = hit ? null : this.widthNear(edit.id, world);
      this.widthHover = near ? near.t : null;
      this.canvas.style.cursor = hit ? (hit.part === 'center' ? 'move' : 'ew-resize') : near ? 'copy' : 'default';
    }
    this.request();
  }

  /** Handles of selected points, points and segments under a screen point. */
  private vectorHit(screen: Point): { kind: 'handle'; segment: number; end: 'a' | 'b' } | { kind: 'point'; key: string } | { kind: 'segment'; segment: number; t: number } | null {
    const editor = this.editor;
    const edit = editor.vectorEdit;
    const net = edit ? editor.networkOf(edit.id) : null;
    if (!edit || !net) return null;
    const m = editor.scene.world(edit.id);
    const selected = new Set(edit.selected);
    for (let si = 0; si < net.segments.length; si++) {
      const s = net.segments[si]!;
      for (const end of ['a', 'b'] as const) {
        const c = end === 'a' ? s.ca : s.cb;
        if (!c || !selected.has(String(s[end]))) continue;
        const sh = this.screenPoint(apply(m, c));
        if (Math.hypot(screen.x - sh.x, screen.y - sh.y) <= 6) return { kind: 'handle', segment: si, end };
      }
    }
    const v = this.vertexAt(edit.id, screen, 6);
    if (v !== null) return { kind: 'point', key: String(v) };
    const near = nearestSegment(net, this.toNode(edit.id, editor.viewport.screenToWorld(screen)));
    if (near && near.distance * editor.viewport.zoom <= 5) return { kind: 'segment', segment: near.segment, t: near.t };
    return null;
  }

  /** Pointer down in point editing; false when the press is outside the vector (editing ends). */
  private vectorDown(world: Point, screen: Point, e: PointerEvent): boolean {
    const editor = this.editor;
    const edit = editor.vectorEdit!;
    const net = editor.networkOf(edit.id);
    if (!net) return false;
    if (edit.tool === 'pen') {
      this.penDown(world, screen, e);
      return true;
    }
    if (edit.tool === 'bucket') {
      const next = toggleRegionAt(net, this.toNode(edit.id, world));
      if (!next) {
        editor.toast(tr('Здесь нет замкнутой области: заливаются места, со всех сторон обведённые сегментами'));
        return true;
      }
      const filled = next.regions.length > net.regions.length;
      editor.commit(filled ? tr('Залить область') : tr('Убрать заливку области'), (tx) => {
        tx.set(edit.id, 'vectorNetwork', next);
        if (filled && !editor.doc.get(edit.id, 'fills').some((f) => f.visible)) tx.set(edit.id, 'fills', [solid(rgba(0.85, 0.85, 0.85))]);
      });
      this.vectorHover(world, screen);
      return true;
    }
    if (edit.tool === 'width') {
      this.widthDown(edit.id, world, screen);
      this.canvas.setPointerCapture(e.pointerId);
      return true;
    }
    if (edit.tool === 'eraser') {
      const d = editor.doc;
      // A filled shape loses the area under the eraser; lines lose their pieces.
      const fill = net.regions.length > 0 && d.get(edit.id, 'fills').some((f) => f.visible);
      const at = this.toNode(edit.id, world);
      this.mode = { kind: 'vec-erase', gesture: editor.beginGesture(tr('Ластик')), id: edit.id, last: at, fill, net };
      this.eraseTo(at);
      this.canvas.setPointerCapture(e.pointerId);
      return true;
    }
    if (edit.tool === 'scissors') {
      const v = this.vertexAt(edit.id, screen);
      if (v !== null) {
        editor.commit(tr('Разрезать точку'), (tx) => tx.set(edit.id, 'vectorNetwork', detachVertex(net, v)));
        return true;
      }
      const near = nearestSegment(net, this.toNode(edit.id, world));
      if (near && near.distance * editor.viewport.zoom <= 6) {
        editor.commit(tr('Разрезать сегмент'), (tx) => tx.set(edit.id, 'vectorNetwork', cutNetworkSegment(net, near.segment, near.t)));
        this.scissorsHover = null;
      }
      return true;
    }
    const hit = this.vectorHit(screen);
    this.canvas.setPointerCapture(e.pointerId);
    const boxHandle = hit?.kind === 'point' ? null : this.pointsBoxHandleAt(screen);
    if (boxHandle) {
      this.mode = { kind: 'vec-transform', gesture: editor.beginGesture(boxHandle.handle === 8 ? tr('Повернуть точки') : tr('Масштабировать точки')), id: edit.id, net, chosen: new Set(edit.selected.map(Number)), box: boxHandle.box, handle: boxHandle.handle, start: this.toNode(edit.id, world) };
      return true;
    }
    if (!hit) {
      // Away from the points: a frame selects points; a plain click inside the shape clears the selection, outside ends editing.
      this.mode = { kind: 'vec-marquee', start: world, screen, base: e.shiftKey ? [...edit.selected] : [], lasso: edit.tool === 'lasso' ? [world] : null };
      return true;
    }
    if (hit.kind === 'handle') {
      this.mode = { kind: 'vec-handle', gesture: editor.beginGesture(tr('Изменить кривую')), segment: hit.segment, end: hit.end, mirror: null };
      return true;
    }
    if (hit.kind === 'segment' && this.modKey(e)) {
      // Bend tool (Mod + drag on a segment): the segment becomes a curve through the pointer (FR-DRW-024).
      this.mode = { kind: 'vec-bend', gesture: editor.beginGesture(tr('Изогнуть сегмент')), segment: hit.segment };
      return true;
    }
    if (hit.kind === 'segment') {
      // A click on a segment adds a point there, keeping the curve (and the regions through it).
      const { net: next, vertex } = splitNetworkSegment(net, hit.segment, hit.t);
      editor.commit(tr('Добавить точку'), (tx) => tx.set(edit.id, 'vectorNetwork', next));
      editor.setVectorSelection([String(vertex)]);
      return true;
    }
    const selected = edit.selected;
    if (!selected.includes(hit.key) && !e.shiftKey) editor.setVectorSelection([hit.key]);
    else if (!selected.includes(hit.key) && e.shiftKey) editor.setVectorSelection([...selected, hit.key]);
    this.mode = { kind: 'vec-points', gesture: null, start: world, screen, snapshot: structuredClone(net), clickedKey: hit.key, toggle: e.shiftKey && selected.includes(hit.key) };
    return true;
  }

  /** Marquee over points while editing them. */
  private vectorMarquee(world: Point, screen: Point): void {
    const mode = this.mode;
    const editor = this.editor;
    const edit = editor.vectorEdit;
    const net = edit ? editor.networkOf(edit.id) : null;
    if (mode.kind !== 'vec-marquee' || !edit || !net) return;
    if (mode.lasso) {
      // The lasso: points inside the line drawn round them (as in Figma, Q).
      const last = mode.lasso[mode.lasso.length - 1]!;
      if (Math.hypot(world.x - last.x, world.y - last.y) * editor.viewport.zoom >= 2) mode.lasso.push(world);
      if (mode.lasso.length < 3) return;
      const m = editor.scene.world(edit.id);
      const inside = net.vertices.map((p, v) => ({ p: apply(m, p), v })).filter(({ p }) => pointInPolygon(mode.lasso!, p)).map(({ v }) => String(v));
      editor.setVectorSelection([...mode.base, ...inside]);
      this.request();
      return;
    }
    if (Math.hypot(screen.x - mode.screen.x, screen.y - mode.screen.y) <= DRAG_THRESHOLD && !editor.marquee) return;
    const r = rectFromPoints(mode.start, world);
    editor.marquee = r;
    const m = editor.scene.world(edit.id);
    const inside = net.vertices.map((p, v) => ({ p: apply(m, p), v })).filter(({ p }) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height).map(({ v }) => String(v));
    editor.setVectorSelection([...mode.base, ...inside]);
  }

  private vectorDragPoints(world: Point, screen: Point, e: PointerEvent): void {
    const mode = this.mode;
    const editor = this.editor;
    const edit = editor.vectorEdit;
    if (mode.kind !== 'vec-points' || !edit) return;
    if (!mode.gesture) {
      if (Math.hypot(screen.x - mode.screen.x, screen.y - mode.screen.y) <= DRAG_THRESHOLD) return;
      mode.gesture = editor.beginGesture(tr('Переместить точки'));
      if (!edit.selected.includes(mode.clickedKey)) editor.setVectorSelection([mode.clickedKey]);
    }
    const a = this.toNode(edit.id, mode.start);
    let b = this.toNode(edit.id, world);
    if (e.shiftKey) b = Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const selected = new Set(editor.vectorEdit!.selected.map(Number));
    const move = <P extends Point>(v: P): P => ({ ...v, x: round2(v.x + dx), y: round2(v.y + dy) });
    const net = mode.snapshot;
    // A point takes the handles of its segments along.
    const next = {
      vertices: net.vertices.map((p, v) => (selected.has(v) ? move(p) : p)),
      segments: net.segments.map((s) => ({ ...s, ...(s.ca && selected.has(s.a) ? { ca: move(s.ca) } : {}), ...(s.cb && selected.has(s.b) ? { cb: move(s.cb) } : {}) })),
      regions: net.regions,
    };
    mode.gesture.update((tx) => tx.set(edit.id, 'vectorNetwork', next));
    this.request();
  }

  private vectorDragHandle(world: Point, e: PointerEvent): void {
    const mode = this.mode;
    const editor = this.editor;
    const edit = editor.vectorEdit;
    const net = edit ? editor.networkOf(edit.id) : null;
    if (mode.kind !== 'vec-handle' || !edit || !net) return;
    const local = this.toNode(edit.id, world);
    const h = { x: round2(local.x), y: round2(local.y) };
    const segments = net.segments.map((s) => ({ ...s }));
    const s = segments[mode.segment];
    if (!s) return;
    const v = mode.end === 'a' ? s.a : s.b;
    // How the other handle follows, as the point stood when the drag began (Figma's mirroring).
    mode.mirror ??= vertexMirror(net, v);
    if (mode.end === 'a') s.ca = h;
    else s.cb = h;
    const p = net.vertices[v]!;
    // Alt breaks the link for good, as in Figma.
    const mirror = e.altKey ? 'NONE' : mode.mirror;
    const pair = handlesAt(net, v);
    const twin = pair?.find((x) => !(x.segment === mode.segment && x.end === mode.end));
    if (twin && mirror !== 'NONE') {
      const other = segments[twin.segment]!;
      const old = twin.end === 'a' ? other.ca : other.cb;
      if (old) {
        const len = Math.hypot(h.x - p.x, h.y - p.y);
        const keep = mirror === 'ANGLE' ? Math.hypot(old.x - p.x, old.y - p.y) : len;
        const k = len > 0 ? keep / len : 0;
        const next = { x: round2(p.x - (h.x - p.x) * k), y: round2(p.y - (h.y - p.y) * k) };
        if (twin.end === 'a') other.ca = next;
        else other.cb = next;
      }
    }
    const vertices = e.altKey && net.vertices[v]!.mirror !== 'NONE' ? net.vertices.map((x, i) => (i === v ? { ...x, mirror: 'NONE' as const } : x)) : net.vertices;
    mode.gesture.update((tx) => tx.set(edit.id, 'vectorNetwork', { ...net, vertices, segments }));
    this.request();
  }

  private vectorBend(world: Point): void {
    const mode = this.mode;
    const edit = this.editor.vectorEdit;
    const net = edit ? this.editor.networkOf(edit.id) : null;
    if (mode.kind !== 'vec-bend' || !edit || !net) return;
    const s = net.segments[mode.segment];
    if (!s) return;
    const a = net.vertices[s.a]!;
    const b = net.vertices[s.b]!;
    const p = this.toNode(edit.id, world);
    // Equal handle offsets d put the curve's middle at (a+b)/2 + 3d/4: solve for d.
    const dx = ((p.x - (a.x + b.x) / 2) * 4) / 3;
    const dy = ((p.y - (a.y + b.y) / 2) * 4) / 3;
    const segments = net.segments.map((x, i) => (i === mode.segment ? { ...x, ca: { x: round2(a.x + dx), y: round2(a.y + dy) }, cb: { x: round2(b.x + dx), y: round2(b.y + dy) } } : x));
    mode.gesture.update((tx) => tx.set(edit.id, 'vectorNetwork', { ...net, segments }));
    this.request();
  }

  /** Double click on a point: corner ↔ smooth. */
  private vectorToggleSmooth(screen: Point): void {
    const editor = this.editor;
    const edit = editor.vectorEdit;
    const net = edit ? editor.networkOf(edit.id) : null;
    if (!edit || !net || edit.tool !== 'edit') return;
    const v = this.vertexAt(edit.id, screen, 6);
    if (v === null) return;
    const p = net.vertices[v]!;
    const segments = net.segments.map((s) => ({ ...s }));
    const at = segments.map((s, i) => (s.a === v || s.b === v ? i : -1)).filter((i) => i >= 0);
    const smooth = at.some((i) => (segments[i]!.a === v ? segments[i]!.ca : segments[i]!.cb));
    if (smooth) {
      for (const i of at) {
        const s = segments[i]!;
        if (s.a === v) delete s.ca;
        if (s.b === v) delete s.cb;
      }
    } else if (at.length === 2) {
      const far = (i: number) => {
        const s = segments[i]!;
        return net.vertices[s.a === v ? s.b : s.a]!;
      };
      const prev = far(at[0]!);
      const next = far(at[1]!);
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(Math.hypot(next.x - p.x, next.y - p.y), Math.hypot(prev.x - p.x, prev.y - p.y)) / 3;
      const toward = (q: Point, sign: number) => ({ x: round2(p.x + ((sign * dx) / len) * k), y: round2(p.y + ((sign * dy) / len) * k) });
      for (const [i, sign] of [[at[0]!, -1], [at[1]!, 1]] as const) {
        const s = segments[i]!;
        if (s.a === v) s.ca = toward(p, sign);
        else s.cb = toward(p, sign);
      }
    } else return;
    editor.commit(tr('Угол / сглаживание'), (tx) => {
      tx.set(edit.id, 'vectorNetwork', { ...net, segments });
      normalizeVector(editor.doc, tx, edit.id);
    });
    editor.setVectorSelection([String(v)]);
  }

  // ---------- text editing ----------
  // The text stays on the canvas while it is edited (so mixed styles show as they
  // are); an invisible textarea takes keyboard and IME input, and the caret and
  // selection are drawn by the overlay from the same layout as the text.

  private caretOn = true;
  private lastPress: { time: number; p: Point; count: number } | null = null;
  private caretTimer: ReturnType<typeof setInterval> | null = null;
  /** Remembered x for Up/Down so the caret keeps its column. */
  private caretColumn: number | null = null;

  private beginTextEditing(id: NodeId): void {
    const editor = this.editor;
    this.textArea.hidden = false;
    this.textArea.value = editor.doc.get(id, 'characters');
    this.onTextSelection();
    if (this.caretTimer) clearInterval(this.caretTimer);
    this.caretTimer = setInterval(() => {
      this.caretOn = !this.caretOn;
      this.request();
    }, 530);
    requestAnimationFrame(() => this.textArea.focus({ preventScroll: true }));
    this.request();
  }

  private endTextEditing(): void {
    if (this.caretTimer) clearInterval(this.caretTimer);
    this.caretTimer = null;
    this.textArea.hidden = true;
    this.mentions?.hide();
    if (this.mode.kind === 'text-select') this.mode = { kind: 'idle' };
    if (document.activeElement === this.textArea) this.focus();
    this.request();
  }

  /** Layout of the edited text in its own box, as the renderer draws it. */
  private textGeometry(id: NodeId) {
    const d = this.editor.doc;
    const w = d.get(id, 'width');
    const h = d.get(id, 'height');
    const autoWidth = d.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT';
    const { layout } = this.editor.measurer.measure(textStyleOf(d, id), autoWidth ? null : w);
    const valign = d.get(id, 'textAlignV');
    const top = valign === 'CENTER' ? (h - layout.height) / 2 : valign === 'BOTTOM' ? h - layout.height : 0;
    return { layout, top, w, h, align: d.get(id, 'textAlignH'), m: this.editor.scene.world(id) };
  }

  /** Character offset under a world point inside the edited text (null when outside it). */
  private textIndexAt(world: Point, clampOutside = false): number | null {
    const id = this.editor.editingText;
    if (!id || !this.editor.doc.store.isAlive(id)) return null;
    const g = this.textGeometry(id);
    const inv = invert(g.m);
    if (!inv) return null;
    const p = apply(inv, world);
    const pad = 4 / this.editor.viewport.zoom;
    if (!clampOutside && (p.x < -pad || p.y < -pad || p.x > Math.max(g.w, 4) + pad || p.y > Math.max(g.h, g.layout.height) + pad)) return null;
    return indexAt(g.layout, p.x, p.y - g.top, this.editor.measurer, g.w, g.align);
  }

  private onTextSelection(): void {
    const editor = this.editor;
    const id = editor.editingText;
    if (!id) return;
    const value = editor.doc.get(id, 'characters');
    if (this.textArea.value !== value) this.textArea.value = value;
    const { anchor, focus } = editor.textSel;
    const start = Math.min(anchor, focus);
    const end = Math.max(anchor, focus);
    if (this.textArea.selectionStart !== start || this.textArea.selectionEnd !== end) {
      this.textArea.setSelectionRange(start, end, focus < anchor ? 'backward' : 'forward');
    }
    this.caretOn = true;
    this.positionTextArea();
    this.mentions?.update();
    this.request();
  }

  /** Keeps the (invisible) textarea at the caret, so IME candidate windows appear in the right place. */
  private positionTextArea(): void {
    const id = this.editor.editingText;
    if (!id || !this.editor.doc.store.isAlive(id)) return;
    const g = this.textGeometry(id);
    const caret = caretAt(g.layout, this.editor.textSel.focus, this.editor.measurer, g.w, g.align);
    const p = this.screenPoint(apply(g.m, { x: caret.x, y: g.top + caret.y }));
    const style = this.textArea.style;
    style.left = `${p.x}px`;
    style.top = `${p.y}px`;
    style.height = `${Math.max(8, caret.height * this.editor.viewport.zoom)}px`;
    style.fontSize = `${Math.max(8, this.editor.doc.get(id, 'fontSize') * this.editor.viewport.zoom)}px`;
  }

  private syncFromTextArea(): void {
    const editor = this.editor;
    if (!editor.editingText) return;
    const t = this.textArea;
    const backward = t.selectionDirection === 'backward';
    const anchor = backward ? t.selectionEnd : t.selectionStart;
    const focus = backward ? t.selectionStart : t.selectionEnd;
    if (t.value !== editor.doc.get(editor.editingText, 'characters')) editor.replaceText(t.value, anchor, focus);
    else editor.setTextSelection(anchor, focus);
  }

  /** The edited text is a board code block's: typed as is (no smart quotes, Tab is spaces, no @ list). */
  private inCode(): boolean {
    const id = this.editor.editingText;
    return !!id && this.editor.doc.get(id, 'board')?.kind === 'CODE_TEXT';
  }

  /** The last smart symbol put in while typing: Backspace right after it brings back what was typed. */
  private smartUndo: { at: number; typed: string; length: number } | null = null;

  private onTextInput(e: InputEvent): void {
    this.caretColumn = null;
    const t = this.textArea;
    const caret = t.selectionStart;
    const last = this.smartUndo;
    this.smartUndo = null;
    if (e.inputType === 'deleteContentBackward' && last && caret === last.at + last.length - 1 && t.selectionEnd === caret) {
      // The symbol lost its last character to Backspace: the typed text comes back instead.
      t.setRangeText(last.typed, last.at, caret, 'end');
    } else if (e.inputType === 'insertText' && e.data?.length === 1 && this.editor.view.smartSymbols && caret === t.selectionEnd && !this.inCode()) {
      const smart = smartReplace(t.value.slice(0, caret), t.value);
      if (smart) {
        const at = caret - smart.remove;
        this.smartUndo = { at, typed: t.value.slice(at, caret), length: smart.insert.length };
        t.setRangeText(smart.insert, at, caret, 'end');
      }
    }
    this.syncFromTextArea();
  }

  /**
   * Mod+Enter on a selected sticky (or a board shape): a blank one beside it,
   * its text ready for typing, as in FigJam (BUG-106). False — nothing to add to.
   */
  addBoardNeighbour(): boolean {
    const editor = this.editor;
    if (editor.selection.length !== 1 || editor.editingText) return false;
    const object = editor.selection[0]!;
    const kind = editor.doc.get(object, 'board')?.kind;
    if (kind !== 'STICKY' && kind !== 'SHAPE') return false;
    const next = addNeighbour(editor, object, 'RIGHT', undefined, kind !== 'STICKY');
    if (next) this.board.editText(next);
    return next !== null;
  }

  private onTextKey(e: KeyboardEvent): void {
    const editor = this.editor;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    e.stopPropagation();
    // The «@» list takes arrows, Enter, Tab and Esc while it is open.
    if (this.mentions?.key(e)) return;
    if (e.key === 'Escape' || (e.key === 'Enter' && mod)) {
      e.preventDefault();
      const id = editor.editingText;
      editor.stopTextEditing();
      // Out of a sticky's text: the sticky is selected, as the object it is part of.
      // After multi-edit text all the edited layers stay selected.
      const object = id && editor.doc.store.isAlive(id) ? (boardObjectOf(editor.doc, id) ?? id) : null;
      if (object && !(object === id && editor.selection.includes(id))) editor.setSelection([object]);
      this.focus();
      return;
    }
    // Tab in a code block: two spaces (Shift+Tab takes up to two back from the line's start).
    if (e.key === 'Tab' && !mod && !e.altKey && this.inCode()) {
      e.preventDefault();
      const t = this.textArea;
      if (e.shiftKey) {
        const lineStart = t.value.lastIndexOf('\n', t.selectionStart - 1) + 1;
        const lead = /^ {1,2}/.exec(t.value.slice(lineStart))?.[0].length ?? 0;
        if (lead) t.setRangeText('', lineStart, lineStart + lead, 'preserve');
      } else t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
      this.syncFromTextArea();
      return;
    }
    // Tab in a table's cell: the next cell (Shift — the one before), past the last a new row (FEAT-167).
    if (e.key === 'Tab' && !mod && !e.altKey && editor.editingText && tableOf(editor.doc, editor.editingText)) {
      e.preventDefault();
      const from = editor.editingText;
      editor.stopTextEditing();
      const next = stepCell(editor, from, e.shiftKey ? -1 : 1);
      if (next) {
        editor.setSelection([next]);
        editor.startTextEditing(next);
        // At once, not on the next frame: what is typed right after Tab goes into the new cell, not to canvas shortcuts.
        this.textArea.focus({ preventScroll: true });
      }
      return;
    }
    // Tab in a sticky or a shape: the next one to the right (Shift — below), typing goes on there.
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const id = editor.editingText;
      const object = id ? boardObjectOf(editor.doc, id) : null;
      const kind = object ? editor.doc.get(object, 'board')?.kind : null;
      if (object && (kind === 'STICKY' || kind === 'SHAPE')) {
        e.preventDefault();
        editor.stopTextEditing();
        const next = addNeighbour(editor, object, e.shiftKey ? 'BOTTOM' : 'RIGHT', undefined, kind !== 'STICKY');
        if (next) this.board.editText(next);
        return;
      }
    }
    // Tab / Shift+Tab in a list: the paragraph one level deeper or back (as in Figma).
    if (e.key === 'Tab' && !mod && !e.altKey && editor.shiftListLevel(e.shiftKey ? -1 : 1)) {
      e.preventDefault();
      return;
    }
    const code = e.code;
    // ⌥⌘V: the copied look onto the selected characters (as in Figma).
    if (mod && e.altKey && code === 'KeyV') {
      e.preventDefault();
      editor.pasteProperties();
      return;
    }
    if (mod && !e.altKey) {
      const style = code === 'KeyB' ? 'bold' : code === 'KeyI' ? 'italic' : code === 'KeyU' ? 'underline' : code === 'KeyX' && e.shiftKey ? 'strike' : null;
      if (style) {
        e.preventDefault();
        editor.toggleTextStyle(style);
        return;
      }
      // ⌘Z takes back the typing; with nothing typed — the step before the editing (it ends the editing).
      // ⌘⇧Z (Ctrl+Y) brings the typing back; the file's steps are not redone inside a text.
      if (code === 'KeyZ' || (code === 'KeyY' && !IS_MAC)) {
        e.preventDefault();
        const redo = code === 'KeyY' || e.shiftKey;
        if (redo) editor.redoTextSession();
        else if (!editor.undoTextSession()) editor.undo();
        return;
      }
      if (code === 'KeyK' && !e.shiftKey) {
        e.preventDefault();
        this.onLink?.();
        return;
      }
      if (e.shiftKey && (code === 'Digit7' || code === 'Digit8')) {
        // Mod+Shift+7 — numbered list, Mod+Shift+8 — bulleted list (FR-TXT-022).
        e.preventDefault();
        editor.toggleList(code === 'Digit7' ? 'NUMBER' : 'BULLET');
        return;
      }
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.altKey) {
      const id = editor.editingText;
      if (!id) return;
      e.preventDefault();
      const g = this.textGeometry(id);
      const caret = caretAt(g.layout, editor.textSel.focus, editor.measurer, g.w, g.align);
      const target = caret.line + (e.key === 'ArrowUp' ? -1 : 1);
      const text = editor.doc.get(id, 'characters');
      let index: number;
      if (target < 0) index = 0;
      else if (target >= g.layout.lines.length) index = text.length;
      else {
        this.caretColumn ??= caret.x;
        const line = g.layout.lines[target]!;
        index = indexAt(g.layout, this.caretColumn, line.y + line.height / 2, editor.measurer, g.w, g.align);
      }
      editor.setTextSelection(e.shiftKey ? editor.textSel.anchor : index, index);
      return;
    }
    if ((e.key === 'Home' || e.key === 'End') && !mod) {
      // Start / end of the visual line (the textarea only knows paragraphs).
      const id = editor.editingText;
      if (!id) return;
      e.preventDefault();
      const g = this.textGeometry(id);
      const caret = caretAt(g.layout, editor.textSel.focus, editor.measurer, g.w, g.align);
      const line = g.layout.lines[caret.line];
      if (!line) return;
      const lineEnd = line.fragments.length > 0 ? line.fragments[line.fragments.length - 1]!.end : line.end;
      const next = g.layout.lines[caret.line + 1];
      // At a soft wrap, the end of the line is before its trailing space.
      const index = e.key === 'Home' ? line.start : next && next.start === lineEnd ? Math.max(line.start, lineEnd - (/\s/.test(editor.doc.get(id, 'characters')[lineEnd - 1] ?? '') ? 1 : 0)) : lineEnd;
      editor.setTextSelection(e.shiftKey ? editor.textSel.anchor : index, index);
      return;
    }
    if (e.key !== 'Shift') this.caretColumn = null;
    // Other keys (typing, Left/Right, Home/End, Backspace) are handled by the textarea itself.
    requestAnimationFrame(() => this.syncFromTextArea());
  }

  /** Selection highlight and caret of the edited text (screen space). */
  private drawTextEditing(): void {
    const editor = this.editor;
    const id = editor.editingText;
    if (!id || !editor.doc.store.isAlive(id)) return;
    const ctx = this.ctx;
    const g = this.textGeometry(id);
    const { start, end } = editor.textRange();
    const toScreen = (x: number, y: number) => this.screenPoint(apply(g.m, { x, y: g.top + y }));
    if (start !== end) {
      ctx.fillStyle = 'rgba(79, 91, 213, 0.28)';
      for (const line of g.layout.lines) {
        const lineEnd = line.fragments.length > 0 ? line.fragments[line.fragments.length - 1]!.end : line.end;
        if (end < line.start || start > lineEnd || (start === end)) continue;
        if (end === line.start && line.start !== lineEnd) continue;
        const a = caretAt(g.layout, Math.max(start, line.start), editor.measurer, g.w, g.align);
        const bIndex = Math.min(end, lineEnd);
        let bx = caretAt(g.layout, bIndex, editor.measurer, g.w, g.align).x;
        if (caretAt(g.layout, bIndex, editor.measurer, g.w, g.align).line !== a.line) bx = line.x + lineOffset(line, g.w, g.align) + line.fragments.reduce((n, f) => Math.max(n, f.x + f.width), 0);
        // A selected line break shows as a small extra block.
        if (end > lineEnd && editor.doc.get(id, 'characters')[lineEnd] === '\n') bx += editor.doc.get(id, 'fontSize') * 0.3;
        const pts = [toScreen(a.x, line.y), toScreen(bx, line.y), toScreen(bx, line.y + line.height), toScreen(a.x, line.y + line.height)];
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
      }
    }
    if (this.caretOn && (start === end || document.activeElement === this.textArea)) {
      const caret = caretAt(g.layout, editor.textSel.focus, editor.measurer, g.w, g.align);
      const a = toScreen(caret.x, caret.y);
      const b = toScreen(caret.x, caret.y + caret.height);
      ctx.strokeStyle = editor.pendingTextStyle ? '#7B61FF' : ACCENT;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
}

const TOOL_TYPES: Partial<Record<string, NodeType>> = {
  frame: 'FRAME',
  section: 'SECTION',
  rectangle: 'RECTANGLE',
  ellipse: 'ELLIPSE',
  polygon: 'POLYGON',
  star: 'STAR',
  line: 'LINE',
  arrow: 'LINE',
  text: 'TEXT',
};

function defaultsFor(type: NodeType): Partial<NodeProps> {
  if (type === 'TEXT') return { characters: '', fontSize: 16, textAutoResize: 'WIDTH_AND_HEIGHT' };
  if (type === 'FRAME') return { clipsContent: true };
  return {};
}

const STATUS_COLORS: Record<Exclude<DevStatus, 'NONE'>, string> = {
  IN_PROGRESS: '#E8850C',
  READY_FOR_DEV: '#14AE5C',
  COMPLETED: '#757575',
};

/** A title pill a little darker than the section fill, opaque, so it reads over the content. */
function sectionPillColor(c: Color): string {
  const k = 0.9;
  const ch = (v: number) => Math.round(Math.max(0, Math.min(1, (v * c.a + (1 - c.a)) * k)) * 255);
  return `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})`;
}

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(out + '…').width > max) out = out.slice(0, -1);
  return out + '…';
}

/** Word boundaries around a character offset (letters, digits and _; otherwise the run of other characters). */
export function wordAt(text: string, index: number): [number, number] {
  const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
  let i = Math.min(index, text.length);
  if (!isWord(text[i]) && isWord(text[i - 1])) i--;
  const kind = isWord(text[i]);
  let a = i;
  let b = i;
  while (a > 0 && isWord(text[a - 1]) === kind && text[a - 1] !== '\n') a--;
  while (b < text.length && isWord(text[b]) === kind && text[b] !== '\n') b++;
  return [a, b];
}

/** Shift while drawing: the new point snaps to 45° steps around the previous one. */
function snapAngle(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
}

/** The GPU page can be turned off (?gpu=0 or cs-gpu=off in this browser) to compare or to work around a driver. */
function gpuWanted(): boolean {
  try {
    if (new URLSearchParams(location.search).get('gpu') === '0') return false;
    return localStorage.getItem('cs-gpu') !== 'off';
  } catch {
    return true;
  }
}
