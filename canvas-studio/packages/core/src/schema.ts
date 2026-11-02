// Document schema (section 4 of the spec): node types and typed properties.
// Properties are stored sparsely: a node keeps only values that differ from the
// defaults of its type, which keeps 50 000-node pages compact in memory and lets
// the schema grow without migrating every stored node.

import { tr } from './i18n.ts';
export const SCHEMA_VERSION = 1;

export type NodeType =
  | 'DOCUMENT'
  | 'PAGE'
  | 'FRAME'
  | 'SECTION'
  | 'COMPONENT'
  | 'COMPONENT_SET'
  | 'INSTANCE'
  | 'GROUP'
  | 'RECTANGLE'
  | 'ELLIPSE'
  | 'POLYGON'
  | 'STAR'
  | 'VECTOR'
  | 'BOOLEAN_OPERATION'
  | 'LINE'
  | 'TEXT'
  | 'STYLE'
  | 'VARIABLE_COLLECTION'
  | 'VARIABLE';

export const SCENE_TYPES: readonly NodeType[] = ['SECTION', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'TEXT'];
export const CONTAINER_TYPES: readonly NodeType[] = ['DOCUMENT', 'PAGE', 'SECTION', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'BOOLEAN_OPERATION'];

/** Types without a size of their own: their box is the union of their children. */
export function isGroupLike(type: NodeType): boolean {
  return type === 'GROUP' || type === 'BOOLEAN_OPERATION';
}

/** Shapes whose outline is a path (they can take part in boolean operations and be flattened). */
export const SHAPE_TYPES: readonly NodeType[] = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'LINE', 'BOOLEAN_OPERATION'];

/** Types that behave like a frame: own size, fills, clipping, auto layout, constraints for children. */
export const FRAME_LIKE: readonly NodeType[] = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];

/**
 * Sections (FR-CNV: canvas organisation) group top-level work on the page: an
 * own box with a fill and a title, but no clipping, auto layout or constraints.
 * They live on the page or inside other sections only.
 */
export function isSection(type: NodeType): boolean {
  return type === 'SECTION';
}

export function isFrameLike(type: NodeType): boolean {
  return FRAME_LIKE.includes(type);
}

/** A library switched on in a file (FR-LIB). */
export interface LibraryLink {
  fileId: string;
  name: string;
}

/** Where a component (style, variables) taken from a library comes from. */
export interface LibraryRef {
  fileId: string;
  name: string;
  /** The publication it was taken from: a newer one means an update is available. */
  publishedAt: number;
}

/** Work status of a section (FR-CNV-071). */
export type DevStatus = 'NONE' | 'IN_PROGRESS' | 'READY_FOR_DEV' | 'COMPLETED';

export const DEV_STATUS_LABELS: Record<DevStatus, string> = {
  NONE: tr('Без статуса'),
  IN_PROGRESS: tr('В работе'),
  READY_FOR_DEV: tr('Готово к разработке'),
  COMPLETED: tr('Завершено'),
};

/** Which child types each container accepts. */
export function canContain(parent: NodeType, child: NodeType): boolean {
  // Document-level resources (styles) live next to the pages.
  if (parent === 'DOCUMENT') return child === 'PAGE' || child === 'STYLE' || child === 'VARIABLE_COLLECTION';
  if (parent === 'VARIABLE_COLLECTION') return child === 'VARIABLE';
  // A set holds only its variants.
  if (parent === 'COMPONENT_SET') return child === 'COMPONENT';
  // Components never nest inside components or instances (FR-CMP: no cycles, no nested definitions).
  if (parent === 'COMPONENT' || parent === 'INSTANCE') return SCENE_TYPES.includes(child) && child !== 'COMPONENT' && child !== 'COMPONENT_SET' && child !== 'SECTION';
  if (parent === 'PAGE' || parent === 'SECTION') return SCENE_TYPES.includes(child);
  // Sections organise the page; they never go inside frames, groups or components.
  if (child === 'SECTION') return false;
  if (parent === 'FRAME' || parent === 'GROUP') return SCENE_TYPES.includes(child);
  // A boolean operation combines shapes (and groups of shapes).
  if (parent === 'BOOLEAN_OPERATION') return SHAPE_TYPES.includes(child) || child === 'GROUP';
  return false;
}

// ---------- Value types ----------

/** RGBA, each channel 0..1. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Vec {
  x: number;
  y: number;
}

export type BlendMode =
  | 'PASS_THROUGH'
  | 'NORMAL'
  | 'DARKEN'
  | 'MULTIPLY'
  | 'COLOR_BURN'
  | 'LIGHTEN'
  | 'SCREEN'
  | 'COLOR_DODGE'
  | 'OVERLAY'
  | 'SOFT_LIGHT'
  | 'HARD_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY'
  /** Plus darker: base + blend − 1 (darker than Darken in the mid-tones); white changes nothing. */
  | 'PLUS_DARKER'
  /** Plus lighter: base + blend; black changes nothing. */
  | 'PLUS_LIGHTER';

export interface SolidPaint {
  type: 'SOLID';
  color: Color;
  opacity: number;
  visible: boolean;
  blendMode?: BlendMode;
}

export interface GradientStop {
  position: number;
  color: Color;
}

/**
 * Gradient handles are in the node's unit space: (0,0) top-left, (1,1) bottom-right.
 * Linear — from one end to the other; radial — `from` the centre, `to` on the
 * circle; angular — round `from`, starting toward `to`; diamond — like radial,
 * with a diamond turned toward `to` instead of a circle.
 */
export interface GradientPaint {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  stops: GradientStop[];
  from: Vec;
  to: Vec;
  opacity: number;
  visible: boolean;
  blendMode?: BlendMode;
}

export type ImageScaleMode = 'FILL' | 'FIT' | 'STRETCH' | 'TILE';

/** An image fill; the bytes live in the document's resources under `imageHash`. */
export interface ImagePaint {
  type: 'IMAGE';
  imageHash: string;
  scaleMode: ImageScaleMode;
  /** Tile size relative to the image's natural size (TILE only). */
  scale: number;
  opacity: number;
  visible: boolean;
  blendMode?: BlendMode;
  /**
   * Set after cropping: the whole picture (`source`, also among the resources)
   * and the part kept, as shares of its size — so the crop can be changed or undone later.
   */
  crop?: ImageCrop;
  /** The picture turned clockwise inside the fill (Figma's «Rotate 90°»); the layer stays as it is. */
  rotation?: 0 | 90 | 180 | 270;
  /** The picture mirrored left to right / top to bottom (flipping the layer flips its picture), after `rotation`. */
  flipX?: boolean;
  flipY?: boolean;
  /** Photo adjustments, each −1..1 (0 — as it is); the image itself is not changed. */
  filters?: ImageFilters;
  /** Set after erasing with a brush: the picture before erasing (also among the resources), so erased parts can be brought back. */
  eraseSource?: string;
}

/** Image adjustments as in Figma: exposure, contrast, saturation, white balance, highlights and shadows. */
export interface ImageFilters {
  exposure: number;
  contrast: number;
  saturation: number;
  /** − cooler (blue), + warmer (amber). */
  temperature: number;
  /** − greener, + more magenta. */
  tint: number;
  highlights: number;
  shadows: number;
}

/**
 * A pattern: another layer of the file repeated over the fill (Figma's pattern fill).
 * The tile is the source's picture; `scale` sizes it, `spacing` (share of the tile) parts
 * the copies; hexagonal tiles shift every other row (or column) by half a tile.
 */
export interface PatternPaint {
  type: 'PATTERN';
  sourceId: string | null;
  tileType: 'RECTANGULAR' | 'HORIZONTAL_HEXAGONAL' | 'VERTICAL_HEXAGONAL';
  scale: number;
  spacing: Vec;
  /** Where the first tile starts across the fill. */
  horizontalAlignment: 'START' | 'CENTER' | 'END';
  opacity: number;
  visible: boolean;
  blendMode?: BlendMode;
}

/** A font file kept among the file's resources. Weight 0 — a variable font (every weight). */
export interface EmbeddedFont {
  family: string;
  weight: number;
  italic: boolean;
  hash: string;
}

export interface ImageCrop {
  source: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Line ends (FR-DRW-062). ARROW is a filled triangle (kept for files made
 * before the other kinds existed), LINE_ARROW two open strokes.
 */
export type LineCap = 'NONE' | 'LINE_ARROW' | 'ARROW' | 'REVERSED_TRIANGLE' | 'CIRCLE' | 'DIAMOND' | 'SQUARE';
/** Ends of dashes and open strokes (FR-DRW-061). */
export type StrokeCap = 'NONE' | 'ROUND' | 'SQUARE';
export type StrokeJoin = 'MITER' | 'ROUND' | 'BEVEL';

/** A ruler guide of a page or a frame (FR-CNV-044); a frame's guides are in its own coordinates. */
export interface GuideLine {
  /** X: a vertical line at x = offset; Y: a horizontal line at y = offset. */
  axis: 'X' | 'Y';
  offset: number;
}

/** A layout grid of a frame (FR-GRD-001). Overlays only: never exported or printed. */
export type LayoutGrid =
  | { pattern: 'GRID'; sectionSize: number; color: Color; visible: boolean }
  | {
      pattern: 'COLUMNS' | 'ROWS';
      /** Number of columns or rows; 0 = as many as fit (not with STRETCH). */
      count: number;
      alignment: 'STRETCH' | 'MIN' | 'CENTER' | 'MAX';
      /** Column width / row height when not stretched. */
      sectionSize: number;
      /** Margin from the frame's edge (STRETCH) or offset from the aligned edge. */
      offset: number;
      gutterSize: number;
      color: Color;
      visible: boolean;
    };

/** A point of a vector path; handles are absolute positions in the node's own space. */
export interface VectorPoint {
  x: number;
  y: number;
  /** Handle of the segment arriving at this point. */
  in?: Vec;
  /** Handle of the segment leaving this point. */
  out?: Vec;
}

/** One contour of a vector shape (FR-DRW pen tool). */
export interface VectorPath {
  points: VectorPoint[];
  closed: boolean;
}

export type WindingRule = 'NONZERO' | 'EVENODD';

/**
 * A vector network (as in Figma): points joined by segments in any way — a
 * point may have one, two or more segments — and regions, the closed loops
 * of segments that are filled. Control points of curves are absolute, in the
 * node's own space; a segment without them is straight.
 */
export interface NetworkVertex {
  x: number;
  y: number;
  /** This corner's radius (Figma: a point's corner radius in point editing); absent — the layer's cornerRadius. */
  cornerRadius?: number;
  /**
   * How the two handles at this point follow each other (Figma's mirroring): not at all,
   * the angle, or the angle and the length. Absent — as they stand: opposite and equal
   * — angle and length, opposite — angle, otherwise none.
   */
  mirror?: HandleMirror;
}

export type HandleMirror = 'NONE' | 'ANGLE' | 'ANGLE_AND_LENGTH';

export interface NetworkSegment {
  /** Vertex indices at the ends. */
  a: number;
  b: number;
  /** Control point near `a` and near `b` (absent — straight from that end). */
  ca?: Vec;
  cb?: Vec;
}

export interface NetworkRegion {
  /** Loops of segment indices; the first is the outline, the others holes (with EVENODD). */
  loops: number[][];
  windingRule: WindingRule;
  /** Its own paints (from Figma: one icon of several colours); [] — not filled; absent — the layer's fills. */
  fills?: Paint[];
}

export interface VectorNetwork {
  vertices: NetworkVertex[];
  segments: NetworkSegment[];
  regions: NetworkRegion[];
}

/** One export preset of a layer (FR-EXP): format, scale (or PDF/SVG at 1x) and file name suffix. */
export interface ExportSetting {
  /** HTML — a standalone page of the layer (pictures, vectors and fonts inside). */
  format: 'PNG' | 'JPG' | 'WEBP' | 'SVG' | 'PDF' | 'HTML';
  scale: number;
  /** A size instead of the scale («512w», «300h» in Figma): the picture is this many px wide or high. */
  size?: { side: 'WIDTH' | 'HEIGHT'; px: number };
  suffix: string;
  /** SVG: an icon of one colour takes the colour of the text around it (currentColor). */
  svgCurrentColor?: boolean;
  /** SVG: no width/height, only viewBox. */
  svgResponsive?: boolean;
  /** SVG: text as letter outlines (needs the font's file: kept in the file, or Inter). */
  svgOutlineText?: boolean;
}
/** The scale an export setting gives a w × h layer (a fixed width or height, or the scale itself). */
export function exportScale(s: ExportSetting, w: number, h: number): number {
  if (!s.size || s.size.px <= 0) return s.scale;
  return s.size.px / Math.max(1e-6, s.size.side === 'WIDTH' ? w : h);
}

/** «2x», «512w», «300h» — as typed in the export row. */
export function exportScaleLabel(s: ExportSetting): string {
  return s.size ? `${s.size.px}${s.size.side === 'WIDTH' ? 'w' : 'h'}` : `${s.scale}x`;
}

/** Reads «2», «2x», «0,5x», «512w», «300h»; null — not one of them. */
export function parseExportScale(text: string): Pick<ExportSetting, 'scale' | 'size'> | null {
  const t = text.trim().toLowerCase().replace(',', '.').replace(/\s+/g, '');
  const size = t.match(/^(\d{1,5})(w|h|ш|в)$/);
  if (size) {
    const px = Number(size[1]);
    return px > 0 && px <= 16384 ? { scale: 1, size: { side: size[2] === 'w' || size[2] === 'ш' ? 'WIDTH' : 'HEIGHT', px } } : null;
  }
  const scale = t.match(/^(\d*\.?\d+)(x|х)?$/);
  if (!scale) return null;
  const v = Number(scale[1]);
  return v > 0 && v <= 8 ? { scale: v, size: undefined } : null;
}

export type StrokeProfile = 'UNIFORM' | 'TAPER_BOTH' | 'TAPER_START' | 'TAPER_END' | 'TEARDROP' | 'WAVE' | 'CUSTOM';

/** A width point of a stroke (Figma's variable width tool): where along the line (0..1 of its length) and how wide (× the stroke weight). */
export interface WidthPoint {
  t: number;
  width: number;
}
export type BrushKind = 'NONE' | 'PENCIL' | 'INK' | 'BRUSH' | 'MARKER' | 'CHALK' | 'CUSTOM';

/**
 * A brush made from a layer's shape (Figma Draw's custom brushes): stretched along the
 * whole stroke, or scattered along it. `contours` are the shape's outlines in a unit box:
 * x 0..1 along the stroke, y −0.5..0.5 across it; `aspect` is its width / height.
 */
export interface CustomBrush {
  id: string;
  name: string;
  kind: 'STRETCH' | 'SCATTER';
  contours: { x: number; y: number }[][];
  aspect: number;
}

export type MaskType = 'ALPHA' | 'VECTOR' | 'LUMINANCE';

/**
 * A repeat group (Figma Draw's repeat transforms): its own layers repeated `count` times
 * in all — in a row with `gap` px between copies, or round a circle of `radius` px
 * (the layers at the top, copies turned evenly round the centre below them).
 */
export interface RepeatSettings {
  kind: 'LINEAR' | 'RADIAL';
  count: number;
  gap: number;
  direction: 'HORIZONTAL' | 'VERTICAL';
  radius: number;
}

/**
 * An ellipse cut into an arc, a pie or a ring (Figma's arc tool): from `start` degrees
 * (clockwise from the right) through `sweep` degrees (−360…360), with a hole of `inner`
 * (0..1 of the radius; 0 — a pie to the centre).
 */
export interface EllipseArc {
  start: number;
  sweep: number;
  inner: number;
}

export type BooleanOp = 'UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE';

export type Paint = SolidPaint | GradientPaint | ImagePaint | PatternPaint;

export function isGradient(p: Paint): p is GradientPaint {
  return p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND';
}

export interface ShadowEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: Color;
  offset: Vec;
  radius: number;
  spread: number;
  visible: boolean;
  /** Drop shadow: seen through the layer's transparent areas too (Figma: off by default). */
  showBehind?: boolean;
  /** How the shadow mixes with what is under it (normal when absent). */
  blendMode?: BlendMode;
}

export interface BlurEffect {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;
  visible: boolean;
  /**
   * Progressive blur: `start` px at `from`, growing to `radius` at `to` (points in
   * the layer's unit space, as gradient handles). None — the same blur everywhere.
   */
  progressive?: { from: Vec; to: Vec; start: number };
}

/**
 * Noise over the layer (FEAT-019). Without `noiseType` — grey film grain mixed in
 * (`amount` its strength). MONO / DUO — pixels of one or two colours, MULTI — of any
 * colour, scattered with `density` (0..1); MULTI takes `amount` as its opacity.
 */
export interface NoiseEffect {
  type: 'NOISE';
  /** Strength, 0..1. */
  amount: number;
  /** Grain size in px. */
  size: number;
  visible: boolean;
  noiseType?: 'MONO' | 'DUO' | 'MULTI';
  density?: number;
  color?: Color;
  secondaryColor?: Color;
  blendMode?: BlendMode;
}

/**
 * Glass (Figma's Liquid Glass look): what is under the layer seen through a domed
 * lens — bent near the edge (`refraction`, over `depth` px), split into colours
 * (`dispersion`), frosted (`frost`, blur px) and lit along the rim from `lightAngle`.
 */
export interface GlassEffect {
  type: 'GLASS';
  visible: boolean;
  /** Degrees, 0 — from the right, counter-clockwise like a compass on the screen (−45 — top left). */
  lightAngle: number;
  /** 0..1. */
  lightIntensity: number;
  /** 0..1. */
  refraction: number;
  /** px. */
  depth: number;
  /** 0..1. */
  dispersion: number;
  /** Blur of what is under, px. */
  frost: number;
  /** How wide the rim light spreads, 0..1. */
  splay: number;
}

/** Texture: the layer's edge roughened (`size` of the grain, `radius` how far it reaches). */
export interface TextureEffect {
  type: 'TEXTURE';
  visible: boolean;
  /** px. */
  size: number;
  /** px. */
  radius: number;
  /** Only inside the layer's outline. */
  clipToShape: boolean;
}

export type Effect = ShadowEffect | BlurEffect | NoiseEffect | GlassEffect | TextureEffect;

/**
 * How the layer's picture is laid onto a surface that is not flat to the eye (mockups):
 * the layer is drawn as usual, then its picture is stretched.
 * PERSPECTIVE — the corners (top-left, top-right, bottom-right, bottom-left) moved, in the
 * layer's unit space (0..1 of its width and height; may go beyond the box).
 * CYLINDER — wrapped round a cylinder or a cone (a cup, a tube) seen from the front.
 */
export type Warp =
  | { type: 'PERSPECTIVE'; corners: [Vec, Vec, Vec, Vec] }
  | {
      type: 'CYLINDER';
      /** VERTICAL — the cylinder stands (a cup), HORIZONTAL — it lies (a tube). */
      axis: 'VERTICAL' | 'HORIZONTAL';
      /** How much of the round surface the layer covers, degrees (0 — flat, 180 — the whole front half). */
      bend: number;
      /** The edges curve as seen from above (> 0) or below (< 0); a share of the height, -0.5..0.5. */
      tilt: number;
      /** One end narrower than the other (a cone): > 0 — the bottom (the right end) is narrower; -0.5..0.5. */
      taper: number;
      /** Darker towards the sides, 0..1. */
      shade: number;
    };

// ---------- Prototyping (section 13 of the spec) ----------

/** What starts an interaction (FR-PRT-003). */
export type TriggerType = 'ON_CLICK' | 'ON_HOVER' | 'ON_PRESS' | 'MOUSE_ENTER' | 'MOUSE_LEAVE' | 'AFTER_TIMEOUT' | 'ON_KEY';

export interface Trigger {
  type: TriggerType;
  /** AFTER_TIMEOUT: delay in ms. */
  timeout?: number;
  /** ON_KEY: key as in KeyboardEvent.key ("Enter", "ArrowRight", "a"). */
  key?: string;
}

export type TransitionType = 'INSTANT' | 'DISSOLVE' | 'SMART_ANIMATE' | 'MOVE_IN' | 'MOVE_OUT' | 'PUSH' | 'SLIDE_IN' | 'SLIDE_OUT';
export type TransitionDirection = 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';

/** Timing curve (FR-PRT-021). */
export type Easing =
  | { type: 'LINEAR' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT' | 'EASE_IN_BACK' | 'EASE_OUT_BACK' }
  | { type: 'CUSTOM_BEZIER'; bezier: [number, number, number, number] }
  | { type: 'SPRING'; mass: number; stiffness: number; damping: number };

export interface Transition {
  type: TransitionType;
  direction?: TransitionDirection;
  /** 1–10 000 ms. */
  duration: number;
  easing: Easing;
}

export type OverlayPosition = 'CENTER' | 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT' | 'MANUAL' | 'RELATIVE';

/** How an overlay is shown (FR-PRT-011). */
export interface OverlaySettings {
  position: OverlayPosition;
  /** MANUAL: from the screen's top-left; RELATIVE: from the trigger's bottom-left. */
  offset: Vec;
  closeOnClickOutside: boolean;
  /** Dimming behind the overlay; null = none. */
  background: Color | null;
}

/** One step of an interaction; several run in order (FR-PRT-003, 010). */
export type PrototypeAction =
  | { type: 'NAVIGATE'; destinationId: string | null; transition: Transition | null; preserveScroll?: boolean }
  | { type: 'BACK' }
  | { type: 'URL'; url: string; newTab: boolean }
  | { type: 'SCROLL_TO'; destinationId: string | null; offset: Vec; transition: Transition | null }
  | { type: 'OPEN_OVERLAY' | 'SWAP_OVERLAY'; destinationId: string | null; transition: Transition | null; overlay: OverlaySettings }
  | { type: 'CLOSE_OVERLAY' }
  | { type: 'CHANGE_TO'; destinationId: string | null; transition: Transition | null }
  /** FR-PRT-040: the expression refers to variables as `{#<id>}`; the editor shows names. */
  | { type: 'SET_VARIABLE'; variableId: string | null; expression: string }
  /** FR-PRT-041: if / else if / else; a branch with condition null is "else". */
  | { type: 'CONDITIONAL'; branches: { condition: string | null; actions: PrototypeAction[] }[] };

export type PrototypeDevice = 'NONE' | 'IPHONE' | 'PIXEL' | 'IPAD' | 'MACBOOK';

/** Frame: which way its content scrolls in the prototype (FR-PRT-030). */
export type OverflowDirection = 'NONE' | 'VERTICAL' | 'HORIZONTAL' | 'BOTH';
/** Child of a scrolling frame: scrolls, stays fixed, or sticks at the top edge (FR-PRT-031). */
export type ScrollBehavior = 'SCROLLS' | 'FIXED' | 'STICKY';

export interface Reaction {
  trigger: Trigger;
  actions: PrototypeAction[];
}

/** A flow's entry point on a page (FR-PRT-002). */
export interface FlowStart {
  nodeId: string;
  name: string;
  description: string;
}

export type StrokeAlign = 'INSIDE' | 'CENTER' | 'OUTSIDE';
export type ConstraintType = 'MIN' | 'MAX' | 'STRETCH' | 'CENTER' | 'SCALE';

export interface Constraints {
  horizontal: ConstraintType;
  vertical: ConstraintType;
}

// ---------- Auto layout ----------

export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';

/**
 * A column or row of a grid layout (FR-AL-020…024), as CSS grid tracks:
 * FIXED — px; FR — a share of the room left; HUG — as large as its content.
 */
export type GridTrack = { kind: 'FIXED'; value: number } | { kind: 'FR'; value: number } | { kind: 'HUG' };

/** Where a layer sits in its grid cell along an axis (STRETCH is the layer's "Fill" sizing). */
export type GridAlign = 'MIN' | 'CENTER' | 'MAX';
export type SpacingMode = 'FIXED' | 'BETWEEN' | 'AROUND' | 'EVENLY';
export type AxisAlign = 'MIN' | 'CENTER' | 'MAX';
/** Across a row the layers may also line up by the first line of their text (Figma: "Align text baseline"). */
export type CounterAlign = AxisAlign | 'BASELINE';
/** How wrapped rows share a taller frame: packed by the alignment (AUTO) or spread apart (Figma: gap "Auto"). */
export type AlignContent = 'AUTO' | 'SPACE_BETWEEN';

/**
 * How a child sizes itself along one axis (FR-AL-005).
 * FIXED keeps width/height, HUG fits content, FILL takes remaining space,
 * PERCENT is a share of the parent's content box, FR is a weighted share of the remaining space.
 */
export type Sizing =
  | { mode: 'FIXED' }
  | { mode: 'HUG' }
  | { mode: 'FILL' }
  | { mode: 'PERCENT'; value: number }
  | { mode: 'FR'; value: number };

export type Length = { unit: 'PX'; value: number } | { unit: 'PERCENT'; value: number };

// ---------- Text ----------

export type LineHeight =
  | { unit: 'AUTO' }
  | { unit: 'PX'; value: number }
  | { unit: 'PERCENT'; value: number }
  | { unit: 'MULTIPLIER'; value: number };

export interface LetterSpacing {
  unit: 'PX' | 'PERCENT';
  value: number;
}

export type TextAlignH = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
export type TextAlignV = 'TOP' | 'CENTER' | 'BOTTOM';
export type TextAutoResize = 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
export type TextCase = 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
export type TextDecoration = 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
export type TextDirection = 'AUTO' | 'LTR' | 'RTL';
export type DecorationStyle = 'SOLID' | 'DASHED' | 'DOTTED' | 'WAVY';
export type TextWrap = 'AUTO' | 'BALANCE' | 'PRETTY';
export type ListType = 'NONE' | 'BULLET' | 'NUMBER';
export type TextBaseline = 'NORMAL' | 'SUPER' | 'SUB';
export type FontVariantCaps = 'NORMAL' | 'SMALL_CAPS' | 'ALL_SMALL_CAPS';

/** Character style that a part of a text can override (mixed styles inside one text). */
export interface TextRunStyle {
  fontFamily?: string;
  fontWeight?: number;
  italic?: boolean;
  fontSize?: number;
  fills?: Paint[];
  textDecoration?: TextDecoration;
  letterSpacing?: LetterSpacing;
  baseline?: TextBaseline;
  /** Hyperlink of these characters (http, https, mailto, tel). */
  link?: string;
}

/** Whether an address may be a hyperlink: web, mail and phone links only (no "javascript:"). */
export function safeLink(value: string): string | null {
  let v = value.trim();
  if (!v) return null;
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(v)) v = `mailto:${v}`;
  else if (/^\+?[\d\s()-]{6,}$/.test(v)) v = `tel:${v.replace(/[\s()-]/g, '')}`;
  else if (/^javascript:|^data:|^vbscript:/i.test(v)) return null;
  else if (!/^(https?:\/\/|mailto:|tel:)/i.test(v)) v = `https://${v.replace(/^\/+/, '')}`;
  try {
    const url = new URL(v);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
    return url.protocol === 'mailto:' || url.protocol === 'tel:' ? v : url.href;
  } catch {
    return null;
  }
}

/** Style override for characters [start, end) of `characters` (UTF-16 offsets). */
export interface TextRun {
  start: number;
  end: number;
  style: TextRunStyle;
}

// ---------- Components ----------

export type ComponentPropType = 'TEXT' | 'BOOLEAN' | 'INSTANCE_SWAP';

/** A property declared on a component (or a component set) that instances can set (FR-CMP-010). */
export interface ComponentPropDef {
  id: string;
  name: string;
  type: ComponentPropType;
  description?: string;
}

/** Which layer property a component property drives. */
export type PropBinding = 'characters' | 'visible' | 'mainComponent';

// ---------- Styles (section 11, FR-STY) ----------

/**
 * Kind of a STYLE node. A colour style keeps its paints in `fills` (solid,
 * gradient or image, several layers allowed) and can be used for fills and
 * strokes; an effect style keeps `effects`; a text style keeps the typography
 * props listed in TEXT_STYLE_KEYS.
 */
export type StyleType = 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';

/** Typography properties a text style defines (alignment and sizing stay per layer, as in Figma). */
export const TEXT_STYLE_KEYS = [
  'fontFamily',
  'fontWeight',
  'italic',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'paragraphSpacing',
  'paragraphIndent',
  'textCase',
  'textDecoration',
  'fontVariantCaps',
] as const satisfies readonly PropKey[];

// ---------- Variables (section 11, FR-VAR) ----------

export type VariableType = 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN';

/** A mode of a collection ("Светлая", "Тёмная"); the first mode is the default. */
export interface VariableMode {
  id: string;
  name: string;
}

/** Reference to another variable; a colour alias may change the opacity (FR-VAR-002: `{grey.500} @ 60%`). */
export interface VariableAlias {
  type: 'ALIAS';
  id: string;
  /** Multiplies the alpha of the referenced colour, 0..1. */
  opacity?: number;
}

/**
 * A value computed from other variables (FR-VAR-003): `{#id} * 2`,
 * `lighten({#id}, 10%)`, `{#id} ? 8 : 12`. References are stored by id, so
 * renaming never breaks it; it is computed in each mode.
 */
export interface VariableExpression {
  type: 'EXPRESSION';
  expr: string;
}

export type VariableLiteral = Color | number | string | boolean;
export type VariableValue = VariableLiteral | VariableAlias | VariableExpression;

/** Where a variable is offered (FR-VAR-023); an empty list means everywhere its type fits. */
export type VariableScope =
  | 'FRAME_FILL'
  | 'SHAPE_FILL'
  | 'TEXT_FILL'
  | 'STROKE_COLOR'
  | 'EFFECT_COLOR'
  | 'WIDTH_HEIGHT'
  | 'CORNER_RADIUS'
  | 'GAP'
  | 'OPACITY'
  | 'STROKE_WIDTH'
  | 'FONT_SIZE'
  | 'FONT_WEIGHT'
  | 'LINE_HEIGHT'
  | 'LETTER_SPACING'
  | 'PARAGRAPH_SPACING'
  | 'TEXT_CONTENT'
  | 'FONT_FAMILY'
  | 'GRID';

export function isAlias(v: unknown): v is VariableAlias {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'ALIAS';
}

export function isExpression(v: unknown): v is VariableExpression {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'EXPRESSION';
}

/** Variables a value refers to: the alias target or every `{#id}` of an expression. */
export function valueRefs(v: unknown): string[] {
  if (isAlias(v)) return [v.id];
  if (!isExpression(v)) return [];
  return [...v.expr.matchAll(/\{\s*#([^{}\s]+)\s*\}/g)].map((m) => m[1]!);
}

export function isColorValue(v: unknown): v is Color {
  return typeof v === 'object' && v !== null && 'r' in v && 'g' in v && 'b' in v;
}

// ---------- Boards (FEAT-083) ----------

/** What a file is: a design (frames, components, prototypes) or a board for working together (stickies, shapes, connectors). */
export type FileKind = 'DESIGN' | 'BOARD' | 'DIAGRAM' | 'SLIDES';

/** How a slide comes in during the show. */
export interface SlideTransition {
  type: 'NONE' | 'DISSOLVE' | 'MOVE_IN' | 'PUSH' | 'SLIDE_UP';
  /** ms */
  duration: number;
}

/** A slide of a presentation (a top-level frame): the speaker's notes, how it comes in, skipped in the show. */
export interface SlideInfo {
  notes: string;
  transition?: SlideTransition;
  skip?: boolean;
}

/** A table (FEAT-167): a grid frame of cells, each a frame with a text; the first row may be the header. */
export interface TableInfo {
  header: boolean;
}

/** What a saved file is, for file lists (none — a design). */
export type ListedKind = 'board' | 'diagram' | 'slides';

/** Whether a saved file (its serialized snapshot) is a board — for file lists, without reading the whole file. */
export function snapshotIsBoard(snapshot: string): boolean {
  return snapshot.includes('"fileKind":"BOARD"');
}

/** What a saved file is, for file lists: a board, a diagram, or a design (null). */
export function snapshotKind(snapshot: string): ListedKind | null {
  return snapshot.includes('"fileKind":"BOARD"') ? 'board' : snapshot.includes('"fileKind":"DIAGRAM"') ? 'diagram' : snapshot.includes('"fileKind":"SLIDES"') ? 'slides' : null;
}

// ---------- Diagrams (FEAT-090) ----------

/** Nodes of a diagram moved by hand: node id → offset. */
export interface DiagramOffsets {
  nodes: Record<string, { dx: number; dy: number }>;
}

/**
 * A diagram drawn from text (DocPlan's «Схемы»): 23 kinds — mind maps,
 * flowcharts, BPMN, Gantt, Sankey… One file is one diagram with one text:
 * the kinds of one syntax family (the three maps; rollout, lanes and ribbon)
 * draw the same text, another family's kind replaces it.
 */
export interface DiagramSpec {
  layout: string;
  /** What is written; none — nothing yet, the kind's example is shown (not saved). */
  text?: string;
  /** Texts per syntax family, as diagrams kept them before one file was one diagram: read only. */
  texts?: Record<string, string>;
  /** A new file whose kind is not chosen yet: the kinds open first. */
  fresh?: boolean;
  /** Palette: soft, default, dark, neutral, neon, catppuccin, viridis, tableau, mono. */
  theme: string;
  /** system, arial, georgia, times, verdana, trebuchet, mono. */
  font: string;
  /** The hierarchy: left to right or top down. */
  direction: 'lr' | 'tb';
  /** Branch spacing of the maps: layout → scale (1 — as built). */
  spacing: Record<string, number>;
  /** Nodes moved by hand, per layout. */
  offsets: Record<string, DiagramOffsets>;
  /** Light or dark drawing; none (auto) — as the interface of whoever looks. */
  look?: 'light' | 'dark';
  /** Colours of one's own (#RRGGBB) in place of the palette: branches, lanes, series take them in turn. */
  colors?: string[];
}

/** Outlines of board shapes; the shape is redrawn at the layer's size. */
export type BoardShape =
  | 'RECTANGLE'
  | 'ROUNDED'
  | 'ELLIPSE'
  | 'DIAMOND'
  | 'TRIANGLE'
  | 'PARALLELOGRAM'
  | 'HEXAGON'
  | 'CYLINDER'
  | 'DOCUMENT'
  | 'STAR'
  | 'ARROW'
  | 'SPEECH'
  // Flowcharts and IT diagrams (FEAT-114).
  | 'TERMINATOR'
  | 'SUBPROCESS'
  | 'MULTI_DOCUMENT'
  | 'TRAPEZOID'
  | 'NOTE'
  | 'CLOUD'
  | 'QUEUE'
  | 'SERVER'
  | 'USER';

/** Side of a layer a connector is attached to; AUTO — the side facing the other end. */
export type ConnectorSide = 'AUTO' | 'TOP' | 'RIGHT' | 'BOTTOM' | 'LEFT';

/**
 * End of a connector: attached to a layer (follows it) or free. `x`, `y` is
 * where the end was last, in page coordinates: a free end stays there, and an
 * end whose layer is deleted becomes free at that place.
 */
export interface ConnectorEnd {
  node: string | null;
  side: ConnectorSide;
  x: number;
  y: number;
}

export type ConnectorRoute = 'STRAIGHT' | 'ELBOW' | 'CURVE';

/** Kind of a board line (a connector, a shape's outline). */
export type LineKind = 'SOLID' | 'DASHED' | 'DOTTED';

/**
 * Dashes for a line of a weight: they grow with it, and a round end (which
 * sticks out half the weight on each side) gets that room back — fixed 6/6
 * dashes on a thick line with round ends closed up into a solid one (BUG-082).
 */
export function lineDash(kind: LineKind, weight: number, roundEnds: boolean): number[] {
  const w = Math.max(1, weight);
  if (kind === 'DASHED') return [Math.max(6, w * 3), Math.max(5, w * 2) + (roundEnds ? w : 0)];
  if (kind === 'DOTTED') return [0, w * 2.2];
  return [];
}

export function lineKindOf(dash: readonly number[]): LineKind {
  return dash.length === 0 ? 'SOLID' : dash[0] === 0 ? 'DOTTED' : 'DASHED';
}

/**
 * Role of a layer on a board. Board objects are made of ordinary layers (so they
 * render, export and copy into designs as they are); the board pass
 * (components/board.ts) keeps their parts in place after every edit.
 */
export type BoardRole =
  /** A frame: the note itself (its fill is the colour). `author` — who made it, shown at the bottom when the board shows authors. */
  | { kind: 'STICKY'; author: string; /** Chosen text size; none — the largest that fits (auto). */ fontSize?: number }
  | { kind: 'STICKY_TEXT' }
  | { kind: 'STICKY_AUTHOR' }
  /** A frame without fill: an outline (vector) and a centred text inside. */
  | { kind: 'SHAPE'; shape: BoardShape }
  | { kind: 'SHAPE_OUTLINE' }
  | { kind: 'SHAPE_TEXT' }
  /** A vector line between two ends. */
  | {
      kind: 'CONNECTOR';
      start: ConnectorEnd;
      end: ConnectorEnd;
      route: ConnectorRoute;
      /** Where the line is bent to (FEAT-115): it passes through this point, kept as an offset from the middle between its ends (moves with them). */
      bend?: { x: number; y: number };
      /** An elbow line without a bend goes around objects; false — straight through them. */
      avoid?: boolean;
    }
  /** A frame with a text, kept at the middle of a connector. */
  | { kind: 'CONNECTOR_LABEL'; connector: string }
  /** A stamp or a reaction put on the board. */
  | { kind: 'STAMP' }
  /** A marker or highlighter stroke (the eraser removes only these). */
  | { kind: 'MARKER' }
  /** One vote put on the object it is inside (hidden; votes of several people never overwrite each other). */
  | { kind: 'VOTE'; voter: string; session: string }
  /** A frame showing a web page's card (FEAT-160): picture, title, description, address; a double click opens `url`. */
  | { kind: 'LINK'; url: string }
  /** A code block (step 10): a dark frame with a monospace text coloured by `lang` (components/code-highlight.ts). */
  | { kind: 'CODE'; lang: string }
  | { kind: 'CODE_TEXT' }
  /** Washi tape (step 10): a see-through strip with torn ends, laid over objects. */
  | { kind: 'TAPE' };

/** A board's timer, the same for everyone: running until `endsAt` (ms since epoch), or paused with `left` ms. */
export interface BoardTimer {
  id: string;
  total: number;
  endsAt: number | null;
  left: number;
}

/** A vote on a board: everyone has `perPerson` votes; closed — results are shown. */
export interface BoardVoting {
  id: string;
  perPerson: number;
  by: string;
  open: boolean;
}

// ---------- Properties ----------

export interface NodeProps {
  name: string;
  visible: boolean;
  locked: boolean;
  /** Soft deletion flag: deletion is an ordinary property so it can be undone and merged. */
  deleted: boolean;
  opacity: number;
  blendMode: BlendMode;

  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, around the node's top-left corner. */
  rotation: number;
  /** Width and height change together (Figma's «Lock aspect ratio»): the fields and the handles keep the proportion. */
  lockAspect: boolean;

  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  /** Per-side weights [top, right, bottom, left] for rectangles and frames (FR-DRW-060); null = strokeWeight everywhere. */
  strokeWeights: [number, number, number, number] | null;
  strokeAlign: StrokeAlign;
  dashPattern: number[];
  strokeCap: StrokeCap;
  strokeJoin: StrokeJoin;
  /** Width along the path (Figma Draw): UNIFORM — a plain stroke. */
  strokeProfile: StrokeProfile;
  /** Width points of the CUSTOM profile; between them the width changes smoothly, the ends are the stroke's weight unless a point is there. */
  widthPoints: WidthPoint[];
  /** A drawing brush: the stroke's edge and texture (NONE — a plain stroke). */
  brush: BrushKind;
  /** Miter limit as in SVG (ratio); 4 ≈ 29°. */
  strokeMiterLimit: number;
  effects: Effect[];
  /** The picture of the layer stretched onto a surface (mockups); null — flat. */
  warp: Warp | null;
  /**
   * A code layer (Figma's code layers): a frame with an HTML document (with its
   * <style> and <script>); the layers inside it are made from the code. Null — a plain layer.
   */
  code: string | null;
  cornerRadius: number;
  /** Per-corner radii [top-left, top-right, bottom-right, bottom-left]; overrides cornerRadius when set. */
  cornerRadii: [number, number, number, number] | null;
  cornerSmoothing: number;
  /** Polygon sides / star points. */
  pointCount: number;
  /** Star: inner radius as a share of the outer one (0..1). */
  innerRadius: number;
  /** Ellipse: an arc, pie or ring; null — the whole ellipse. */
  arc: EllipseArc | null;
  /** Vector shape contours (VECTOR nodes), in the node's own coordinates. */
  vectorPaths: VectorPath[];
  /** VECTOR: the shape as a vector network; when set, it is the shape and `vectorPaths` is not used. */
  vectorNetwork: VectorNetwork | null;
  windingRule: WindingRule;
  /** BOOLEAN_OPERATION: how the children are combined. */
  booleanOp: BooleanOp;
  /** The layer masks the layers above it in the same parent. */
  isMask: boolean;
  /** Document: brushes made in this file (the brush menu). */
  brushes: CustomBrush[];
  /** The brush of a stroke whose `brush` is CUSTOM (kept on the layer: it travels with it to other files). */
  customBrush: CustomBrush | null;
  /** GROUP: a repeat group; null — a plain group. */
  repeat: RepeatSettings | null;
  /** A copy a repeat group made of its own layers: rebuilt with them, not edited by hand. */
  repeatCopy: boolean;
  /** How a mask hides: by its opacity, by its outline (any opacity counts as full), by its brightness. */
  maskType: MaskType;
  exportSettings: ExportSetting[];
  /** Line ends. */
  startCap: LineCap;
  endCap: LineCap;
  clipsContent: boolean;
  constraints: Constraints;
  /** PAGE and frames: ruler guides (FR-CNV-044). */
  guides: GuideLine[];
  /** Frames: layout grids (FR-GRD). */
  layoutGrids: LayoutGrid[];
  /** Frames: grid style (FR-GRD-004). */
  gridStyleId: string | null;

  // Auto layout container
  layoutMode: LayoutMode;
  layoutWrap: boolean;
  itemSpacing: number;
  spacingMode: SpacingMode;
  counterAxisSpacing: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAlign: AxisAlign;
  counterAlign: CounterAlign;
  /** Wrapped rows in a frame taller than they are. */
  counterAxisAlignContent: AlignContent;
  strokesIncludedInLayout: boolean;
  /** Canvas stacking: the first layer is drawn on top (Figma: "First on top"), the order in the panel stays. */
  itemReverseZIndex: boolean;

  // Auto layout child
  sizingH: Sizing;
  sizingV: Sizing;
  minWidth: Length | null;
  maxWidth: Length | null;
  minHeight: Length | null;
  maxHeight: Length | null;
  positioning: 'AUTO' | 'ABSOLUTE';

  // Grid layout container (layoutMode GRID)
  /** Columns; more are added (as HUG) when layers are placed beyond them. */
  gridColumns: GridTrack[];
  /** Rows; empty or too few — rows are added as content needs (HUG). */
  gridRows: GridTrack[];
  gridColumnGap: number;
  gridRowGap: number;

  // Grid layout child
  /** Column the layer starts in (0-based); null — placed automatically in reading order. */
  gridColumn: number | null;
  gridRow: number | null;
  gridColumnSpan: number;
  gridRowSpan: number;
  gridAlignH: GridAlign;
  gridAlignV: GridAlign;

  // Text
  characters: string;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  paragraphSpacing: number;
  /** First-line indent of every paragraph, px. */
  paragraphIndent: number;
  listType: ListType;
  /** Nesting level of each paragraph of a list (0 — the top; Tab and Shift+Tab change it); missing — 0. */
  listLevels: number[];
  /** Space between two items of a list, px; null — the paragraph spacing. */
  listSpacing: number | null;
  /** Truncate with an ellipsis after this many lines; 0 = no limit. */
  maxLines: number;
  /** Parts of the text with their own style; the node's own props are the base style. */
  textRuns: TextRun[];
  fontVariantCaps: FontVariantCaps;
  kerning: boolean;
  /** OpenType features turned on (true) or off (false) against the font's default: { tnum: true, liga: false }. */
  fontFeatures: Record<string, boolean>;
  /** Variation axes of a variable font other than the weight (that one is fontWeight): { opsz: 20, wdth: 85 }. */
  fontVariations: Record<string, number>;
  /** Vertical trim (Figma): CAP_HEIGHT — the box starts at the first line's capitals and ends at the last line's baseline. */
  leadingTrim: 'NONE' | 'CAP_HEIGHT';
  /** Hanging punctuation (Figma): opening quotes and brackets at a line's start stand outside the text's edge (closing ones at a right-aligned line's end), so the letters line up. */
  hangingPunctuation: boolean;
  /** Hanging list (Figma): list markers stand outside the text's edge; the items' text lines up with the text around. */
  hangingList: boolean;
  /** Writing direction of the paragraphs: AUTO — by each paragraph's first letter (Arabic and Hebrew right to left). */
  textDirection: TextDirection;
  /** How underline and strikethrough are drawn (Figma's decoration style). */
  decorationStyle: DecorationStyle;
  /** Line thickness of underline and strikethrough, px; null — from the font size. */
  decorationThickness: number | null;
  /** Distance from the baseline down to the underline, px; null — from the font size. */
  underlineOffset: number | null;
  /** How lines break (CSS text-wrap): AUTO — as many words as fit, BALANCE — lines of about equal length (headings), PRETTY — no word alone on the last line. */
  textWrap: TextWrap;
  /** Text on a path (Figma Draw): the line the letters run along, in the text's own space; null — ordinary text. */
  textPath: VectorPath[] | null;
  /** Where along the path (0..1): the start (left), the middle (centre) or the end (right) of the text. */
  textPathOffset: number;
  textAlignH: TextAlignH;
  textAlignV: TextAlignV;
  textAutoResize: TextAutoResize;
  textCase: TextCase;
  textDecoration: TextDecoration;

  // Page
  backgroundColor: Color;

  /** Fonts stored in the file (the document node only): everyone who opens it sees them. */
  embeddedFonts: EmbeddedFont[];
  /** How exported files are named (the document node only); empty — "{name}". */
  exportNameTemplate: string;
  /** The document node: libraries switched on for this file (their components are offered in "Components"). */
  libraries: LibraryLink[];
  /** PAGE: the hidden page that keeps components taken from libraries (not in the page list). */
  libraryPage: boolean;
  /** Component, component set, style, variable collection taken from a library: where from, which publication. */
  libraryRef: LibraryRef | null;

  // Components (section 10)
  /** INSTANCE: the component it shows. */
  mainComponent: string | null;
  /** Layer of an instance: id of the layer it mirrors (its source). */
  componentKey: string | null;
  /** Stable key used to match layers across variants and swaps (FR-CMP-030). Falls back to the node id. */
  layerKey: string | null;
  /** Layer of an instance: properties set locally that no longer follow the source. */
  overrides: string[];
  /** INSTANCE: overrides of layers that disappeared after a swap, kept to restore them (FR-CMP-031). */
  parkedOverrides: Record<string, Record<string, unknown>> | null;
  /** COMPONENT / COMPONENT_SET: declared properties. */
  componentProps: ComponentPropDef[];
  /** Layer inside a component: which of its properties are driven by component properties. */
  propRefs: Partial<Record<PropBinding, string>> | null;
  /** INSTANCE: values of component properties. */
  propValues: Record<string, string | boolean> | null;
  /** COMPONENT / COMPONENT_SET / STYLE: documentation shown to users. */
  description: string;
  /**
   * FRAME made from a page a language model wrote (FEAT-172): that page and a signature of
   * the layers it became. Changed in words again, the frame starts from the page while its
   * layers are as they were made (no loss of an HTML → layers → HTML round trip).
   */
  aiSource: { html: string; sig: string } | null;

  // Styles
  /** STYLE: what the style defines. */
  styleType: StyleType;
  /** Layer: colour style of the fills (the layer keeps a copy of the values). */
  fillStyleId: string | null;
  /** Layer: colour style of the strokes. */
  strokeStyleId: string | null;
  /** Layer: effect style. */
  effectStyleId: string | null;
  /** TEXT: text style of the base typography. */
  textStyleId: string | null;

  // Variables
  /** VARIABLE_COLLECTION: modes, the first is the default (FR-VAR-011). An extension mirrors its parent's. */
  modes: VariableMode[];
  /**
   * VARIABLE_COLLECTION: the collection this one extends (FR-VAR-013). An
   * extension has no variables of its own: it gets every variable of the parent
   * (new ones too) and overrides some values.
   */
  extendsCollection: string | null;
  /** VARIABLE_COLLECTION (an extension): variable id → mode id → its own value. */
  varOverrides: Record<string, Record<string, VariableValue>>;
  /** VARIABLE: value type. */
  varType: VariableType;
  /** VARIABLE: value (or alias) per mode id. */
  varValues: Record<string, VariableValue>;
  /** VARIABLE: properties it is offered for; empty = all that fit its type. */
  scopes: VariableScope[];
  /** VARIABLE: names in code per platform (WEB, IOS, ANDROID or any other key). */
  codeSyntax: Record<string, string>;
  /** VARIABLE: not published to libraries. */
  hiddenFromPublishing: boolean;
  /** SECTION (and later frames): work status shown on the title and in filters (FR-CNV-071, FR-DEV-002). */
  devStatus: DevStatus;
  /** Scene node: prototype interactions (FR-PRT-001, 003). */
  reactions: Reaction[];
  /** Frame: scrolling of its content in the prototype (FR-PRT-030). */
  overflowDirection: OverflowDirection;
  /** Layer inside a scrolling frame (FR-PRT-031). */
  scrollBehavior: ScrollBehavior;
  /** PAGE: flow entry points, in the order shown in the flow list (FR-PRT-002). */
  flowStartingPoints: FlowStart[];
  /** PAGE: background around screens in the prototype viewer (FR-PRT-050); null = dark grey. */
  prototypeBackground: Color | null;
  /** PAGE: device frame drawn around screens in the viewer (FR-PRT-050). */
  prototypeDevice: PrototypeDevice;
  /** Layer or style: field ("width", "fills/0", "visible") → variable id. The layer keeps the resolved value too. */
  boundVariables: Record<string, string> | null;
  /** Page, frame, group, instance: collection id → mode id, inherited by children (FR-VAR-012). */
  variableModes: Record<string, string> | null;
  /** The document node: a design or a board (FEAT-083). */
  fileKind: FileKind;
  /** The document node of a board: authors are shown under stickies. */
  boardAuthors: boolean;
  /** The document node of a board: its own colours (#RRGGBB), offered after the usual ones for stickies, shapes, sections and tape. */
  boardColors: string[];
  /** Layer of a board object (sticky, shape, connector and their parts). */
  board: BoardRole | null;
  /** The document node of a board: the shared timer and the vote. */
  boardTimer: BoardTimer | null;
  boardVoting: BoardVoting | null;
  /** The document node of a diagram: its text and look (FEAT-090). */
  diagram: DiagramSpec | null;
  /** A slide of a presentation (its top-level frame): notes, transition. */
  slide: SlideInfo | null;
  /** The document node of a presentation: the chosen theme. */
  slideTheme: string | null;
  /** A table's frame (FEAT-167). */
  table: TableInfo | null;
}

export type PropKey = keyof NodeProps;

export function rgba(r: number, g: number, b: number, a = 1): Color {
  return { r, g, b, a };
}

/** Parses #RGB, #RRGGBB or #RRGGBBAA. */
export function hexToColor(hex: string): Color | null {
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

export function colorToHex(c: Color, withAlpha = false): string {
  const p = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return ('#' + p(c.r) + p(c.g) + p(c.b) + (withAlpha ? p(c.a) : '')).toUpperCase();
}

export function solid(color: Color, opacity = 1): SolidPaint {
  return { type: 'SOLID', color, opacity, visible: true };
}

const BASE_DEFAULTS: NodeProps = {
  name: '',
  visible: true,
  locked: false,
  deleted: false,
  opacity: 1,
  blendMode: 'PASS_THROUGH',
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  rotation: 0,
  lockAspect: false,
  fills: [],
  strokes: [],
  strokeWeight: 1,
  strokeWeights: null,
  strokeAlign: 'INSIDE',
  dashPattern: [],
  strokeCap: 'NONE',
  strokeJoin: 'MITER',
  strokeProfile: 'UNIFORM',
  widthPoints: [],
  brush: 'NONE',
  strokeMiterLimit: 4,
  effects: [],
  warp: null,
  code: null,
  cornerRadius: 0,
  cornerRadii: null,
  cornerSmoothing: 0,
  pointCount: 5,
  innerRadius: 0.382,
  arc: null,
  vectorPaths: [],
  vectorNetwork: null,
  windingRule: 'NONZERO',
  booleanOp: 'UNION',
  isMask: false,
  repeat: null,
  repeatCopy: false,
  brushes: [],
  customBrush: null,
  maskType: 'ALPHA',
  exportSettings: [],
  startCap: 'NONE',
  endCap: 'NONE',
  clipsContent: false,
  constraints: { horizontal: 'MIN', vertical: 'MIN' },
  guides: [],
  layoutGrids: [],
  gridStyleId: null,
  layoutMode: 'NONE',
  layoutWrap: false,
  itemSpacing: 0,
  spacingMode: 'FIXED',
  counterAxisSpacing: 0,
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
  primaryAlign: 'MIN',
  counterAlign: 'MIN',
  strokesIncludedInLayout: false,
  counterAxisAlignContent: 'AUTO',
  itemReverseZIndex: false,
  sizingH: { mode: 'FIXED' },
  sizingV: { mode: 'FIXED' },
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  positioning: 'AUTO',
  gridColumns: [{ kind: 'FR', value: 1 }, { kind: 'FR', value: 1 }],
  gridRows: [],
  gridColumnGap: 16,
  gridRowGap: 16,
  gridColumn: null,
  gridRow: null,
  gridColumnSpan: 1,
  gridRowSpan: 1,
  gridAlignH: 'MIN',
  gridAlignV: 'MIN',
  characters: '',
  fontFamily: 'Inter',
  fontWeight: 400,
  italic: false,
  fontSize: 16,
  lineHeight: { unit: 'AUTO' },
  letterSpacing: { unit: 'PERCENT', value: 0 },
  paragraphSpacing: 0,
  paragraphIndent: 0,
  listType: 'NONE',
  listLevels: [],
  listSpacing: null,
  maxLines: 0,
  textRuns: [],
  embeddedFonts: [],
  exportNameTemplate: '',
  libraries: [],
  libraryPage: false,
  libraryRef: null,
  fontVariantCaps: 'NORMAL',
  kerning: true,
  fontFeatures: {},
  fontVariations: {},
  leadingTrim: 'NONE',
  hangingPunctuation: false,
  hangingList: false,
  decorationStyle: 'SOLID',
  textDirection: 'AUTO',
  decorationThickness: null,
  underlineOffset: null,
  textWrap: 'AUTO',
  textPath: null,
  textPathOffset: 0.5,
  textAlignH: 'LEFT',
  textAlignV: 'TOP',
  textAutoResize: 'WIDTH_AND_HEIGHT',
  textCase: 'ORIGINAL',
  textDecoration: 'NONE',
  backgroundColor: rgba(0.96, 0.96, 0.96),
  mainComponent: null,
  componentKey: null,
  layerKey: null,
  overrides: [],
  parkedOverrides: null,
  componentProps: [],
  propRefs: null,
  propValues: null,
  description: '',
  aiSource: null,
  styleType: 'FILL',
  fillStyleId: null,
  strokeStyleId: null,
  effectStyleId: null,
  textStyleId: null,
  modes: [],
  extendsCollection: null,
  varOverrides: {},
  varType: 'COLOR',
  varValues: {},
  scopes: [],
  codeSyntax: {},
  hiddenFromPublishing: false,
  devStatus: 'NONE',
  reactions: [],
  overflowDirection: 'NONE',
  scrollBehavior: 'SCROLLS',
  flowStartingPoints: [],
  prototypeBackground: null,
  prototypeDevice: 'NONE',
  boundVariables: null,
  variableModes: null,
  fileKind: 'DESIGN',
  boardAuthors: true,
  boardColors: [],
  board: null,
  boardTimer: null,
  boardVoting: null,
  diagram: null,
  slide: null,
  slideTheme: null,
  table: null,
};

const WHITE = rgba(1, 1, 1);
const SHAPE_GREY = rgba(0.85, 0.85, 0.85);

const TYPE_DEFAULTS: Record<NodeType, Partial<NodeProps>> = {
  DOCUMENT: { name: tr('Без названия') },
  PAGE: { name: tr('Страница 1') },
  FRAME: { name: 'Frame', fills: [solid(WHITE)], clipsContent: true, width: 100, height: 100 },
  SECTION: { name: 'Section', fills: [solid(WHITE)], strokes: [solid(rgba(0, 0, 0), 0.1)], strokeWeight: 1, strokeAlign: 'INSIDE', cornerRadius: 2, width: 400, height: 300 },
  COMPONENT: { name: 'Component', fills: [solid(WHITE)], clipsContent: true, width: 100, height: 100 },
  COMPONENT_SET: {
    name: 'Component set',
    strokes: [solid(rgba(0.592, 0.278, 1))],
    strokeWeight: 1,
    dashPattern: [4, 4],
    cornerRadius: 5,
    width: 100,
    height: 100,
  },
  INSTANCE: { name: 'Instance', clipsContent: true, width: 100, height: 100 },
  GROUP: { name: 'Group' },
  RECTANGLE: { name: 'Rectangle', fills: [solid(SHAPE_GREY)], width: 100, height: 100 },
  ELLIPSE: { name: 'Ellipse', fills: [solid(SHAPE_GREY)], width: 100, height: 100 },
  POLYGON: { name: 'Polygon', fills: [solid(SHAPE_GREY)], width: 100, height: 100, pointCount: 3 },
  STAR: { name: 'Star', fills: [solid(SHAPE_GREY)], width: 100, height: 100, pointCount: 5 },
  VECTOR: { name: 'Vector', strokes: [solid(rgba(0, 0, 0))], strokeAlign: 'CENTER', width: 0, height: 0 },
  BOOLEAN_OPERATION: { name: 'Union', fills: [solid(SHAPE_GREY)] },
  LINE: { name: 'Line', strokes: [solid(rgba(0, 0, 0))], strokeAlign: 'CENTER', width: 100, height: 0 },
  TEXT: { name: 'Text', fills: [solid(rgba(0, 0, 0))], characters: '', width: 0, height: 0 },
  STYLE: { name: 'Style' },
  VARIABLE_COLLECTION: { name: tr('Коллекция') },
  VARIABLE: { name: tr('Переменная') },
};

/** Default value of a property for a node type. */
export function defaultProp<K extends PropKey>(type: NodeType, key: K): NodeProps[K] {
  const typed = TYPE_DEFAULTS[type][key];
  return (typed !== undefined ? typed : BASE_DEFAULTS[key]) as NodeProps[K];
}

export const PROP_KEYS = Object.keys(BASE_DEFAULTS) as PropKey[];

export function isPropKey(key: string): key is PropKey {
  return Object.prototype.hasOwnProperty.call(BASE_DEFAULTS, key);
}

/** Structural equality for property values (they are plain JSON data). */
export function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valueEquals(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!valueEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Deep copy of a JSON-like property value. Values are treated as immutable, but copies protect the store from callers. */
export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}
