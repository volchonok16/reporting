// Board objects (FEAT-083): stickies, shapes with text and connectors are made
// of ordinary layers, so they render, export, travel between files and merge
// as any other layer. What makes them board objects is this pass, run after
// every local edit (pipeline.ts):
//   sticky — the text sits inside the note with a font size that fits it, the
//            author's name at the bottom when the board shows authors;
//   shape  — the outline is redrawn at the shape's size, the text is centred in
//            it and the shape grows when the text needs more room;
//   connector — the line goes from one end to the other, ends attached to a
//            layer follow it; its label stays at the middle.
// Remote edits and undo do not run it: their ops already carry the results.

import { valueEquals, type BoardRole, type BoardShape, type ConnectorEnd, type ConnectorRoute, type ConnectorSide, type Document, type NodeId, type PropKey, type Transaction, type VectorPath, type VectorPoint } from '#core';
import { apply, invert, multiply, nodeTransform, IDENTITY, type Matrix, type Point, type Rect } from '#geometry';
import { textStyleOf, type TextMeasurer } from '#layout';
import { codeRuns, isCodeLang } from './code-highlight.ts';

export const STICKY_SIZE = 240;
export const STICKY_PADDING = 20;
/** Font sizes a sticky's text takes, the largest that fits. */
export const STICKY_FONT_SIZES = [32, 28, 24, 20, 18, 16, 14, 12, 10, 8];
/** Text smaller than this is hard to read: past it a sticky grows down instead, as in FigJam (BUG-105). */
export const STICKY_MIN_AUTO_FONT = 16;
const AUTHOR_SIZE = 11;
const SHAPE_PADDING = 12;

export function roleOf(doc: Document, id: NodeId): BoardRole | null {
  return doc.store.isAlive(id) ? doc.get(id, 'board') : null;
}

/** A sticky, a shape or a connector label: one object on the board whose parts are kept by this pass. */
export function isBoardObject(doc: Document, id: NodeId): boolean {
  const kind = roleOf(doc, id)?.kind;
  return kind === 'STICKY' || kind === 'SHAPE' || kind === 'CONNECTOR_LABEL' || kind === 'LINK' || kind === 'CODE';
}

/** The text a board object shows (the one edited on double click), if it has one. */
export function boardTextOf(doc: Document, id: NodeId): NodeId | null {
  const kind = roleOf(doc, id)?.kind;
  const want = kind === 'STICKY' ? 'STICKY_TEXT' : kind === 'SHAPE' ? 'SHAPE_TEXT' : kind === 'CODE' ? 'CODE_TEXT' : kind === 'CONNECTOR_LABEL' ? 'TEXT' : null;
  if (!want) return null;
  for (const c of doc.children(id)) {
    if (want === 'TEXT' ? doc.type(c) === 'TEXT' : roleOf(doc, c)?.kind === want) return c;
  }
  return null;
}

/**
 * Runs after every local edit: `objects` before layout (stickies and shapes
 * place their parts), `connectors` after it (ends follow the final places).
 */
export function syncBoard(doc: Document, tx: Transaction, userChanges: ReadonlyMap<NodeId, ReadonlySet<PropKey>>, measurer: TextMeasurer, phase: 'objects' | 'connectors'): void {
  const touched = tx.changes.touched();
  if (touched.size === 0) return;
  if (phase === 'connectors') {
    let any = doc.get(doc.rootId, 'fileKind') === 'BOARD';
    for (const id of touched) {
      if (any) break;
      if (doc.store.record(id)?.props.board) any = true;
    }
    if (any) syncConnectors(doc, tx, userChanges, touched);
    return;
  }
  const objects = new Set<NodeId>();
  for (const id of touched) {
    const record = doc.store.record(id);
    if (!record) continue;
    if (record.parent === null && userChanges.get(id)?.has('boardAuthors')) {
      for (const r of doc.store.allRecords()) if (r.props.board?.kind === 'STICKY' && doc.store.isAlive(r.id)) objects.add(r.id);
      continue;
    }
    const role = record.props.board;
    if (!role) continue;
    if (!doc.store.isAlive(id)) continue;
    if (role.kind === 'STICKY' || role.kind === 'SHAPE' || role.kind === 'STAMP' || role.kind === 'CODE') objects.add(id);
    else if (role.kind === 'STICKY_TEXT' || role.kind === 'STICKY_AUTHOR' || role.kind === 'SHAPE_TEXT' || role.kind === 'SHAPE_OUTLINE' || role.kind === 'CODE_TEXT') {
      const parent = doc.parent(id);
      if (parent) objects.add(parent);
    }
  }
  for (const id of objects) {
    const role = doc.get(id, 'board');
    if (role?.kind === 'STICKY') syncSticky(doc, tx, id, measurer);
    else if (role?.kind === 'SHAPE') syncShape(doc, tx, id, role.shape, measurer);
    else if (role?.kind === 'STAMP') syncStamp(doc, tx, id);
    else if (role?.kind === 'CODE') syncCode(doc, tx, id, role.lang, measurer);
  }
}

// ---------- code blocks ----------

/** Padding of a code block around its text. */
export const CODE_PADDING = 16;

/**
 * A code block after an edit: the text spans the block's width, the block grows and
 * shrinks with the text (at least two lines high), and the text is coloured by its
 * language — the colours are runs, recomputed from the characters each time.
 */
function syncCode(doc: Document, tx: Transaction, id: NodeId, lang: string, measurer: TextMeasurer): void {
  const text = doc.children(id).find((c) => roleOf(doc, c)?.kind === 'CODE_TEXT');
  if (!text) return;
  const w = doc.get(id, 'width');
  const inner = Math.max(40, w - CODE_PADDING * 2);
  const characters = doc.get(text, 'characters');
  const runs = codeRuns(isCodeLang(lang) ? lang : 'plain', characters);
  if (JSON.stringify(runs) !== JSON.stringify(doc.get(text, 'textRuns'))) tx.set(text, 'textRuns', runs);
  const height = measurer.measure(textStyleOf(doc, text), inner).height;
  const lineHeight = doc.get(text, 'fontSize') * 1.5;
  set(doc, tx, text, { x: CODE_PADDING, y: CODE_PADDING, width: inner, height: round(height), textAutoResize: 'HEIGHT' });
  const outer = round(Math.max(height, lineHeight * 2) + CODE_PADDING * 2);
  if (Math.abs(doc.get(id, 'height') - outer) > 0.5) tx.set(id, 'height', outer);
}

// ---------- stickies ----------

function syncSticky(doc: Document, tx: Transaction, id: NodeId, measurer: TextMeasurer): void {
  const role = doc.get(id, 'board') as Extract<BoardRole, { kind: 'STICKY' }>;
  const w = doc.get(id, 'width');
  const h = doc.get(id, 'height');
  const inner = Math.max(1, w - STICKY_PADDING * 2);
  let text: NodeId | null = null;
  let author: NodeId | null = null;
  for (const c of doc.children(id)) {
    const kind = roleOf(doc, c)?.kind;
    if (kind === 'STICKY_TEXT') text = c;
    else if (kind === 'STICKY_AUTHOR') author = c;
  }
  text ??= tx.create('TEXT', id, { name: 'Text', board: { kind: 'STICKY_TEXT' }, characters: '', fontSize: 24, textAutoResize: 'HEIGHT', fills: stickyInk() });
  let reserved = 0;
  const showAuthor = doc.get(doc.rootId, 'boardAuthors') && role.author.trim() !== '';
  if (author || showAuthor) {
    author ??= tx.create('TEXT', id, { name: 'Author', board: { kind: 'STICKY_AUTHOR' }, characters: role.author, fontSize: AUTHOR_SIZE, textAutoResize: 'HEIGHT', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.5, visible: true }] });
    set(doc, tx, author, { characters: role.author, visible: showAuthor, width: inner, textAutoResize: 'HEIGHT', x: STICKY_PADDING });
    const ah = measurer.measure(textStyleOf(doc, author), inner).height;
    set(doc, tx, author, { height: round(ah), y: round(h - STICKY_PADDING + 6 - ah) });
    if (showAuthor) reserved = ah + 6;
  }
  const room = h - STICKY_PADDING * 2 - reserved;
  const style = textStyleOf(doc, text);
  let size = STICKY_FONT_SIZES[STICKY_FONT_SIZES.length - 1]!;
  let height = 0;
  // The longest word must fit on a line whole: a word broken in the middle reads badly.
  const longest = style.characters.split(/\s+/).reduce((a, w) => (w.length > a.length ? w : a), '');
  const plain = { ...style, runs: (style.runs ?? []).map((r) => ({ ...r, style: { ...r.style, fontSize: undefined } })) };
  // A size chosen by hand stays; otherwise the largest that fits, down to a readable size.
  for (const s of role.fontSize ? [role.fontSize] : STICKY_FONT_SIZES.filter((v) => v >= STICKY_MIN_AUTO_FONT)) {
    const m = measurer.measure({ ...plain, fontSize: s }, inner);
    size = s;
    height = m.height;
    const word = longest ? measurer.measure({ ...plain, runs: [], characters: longest, fontSize: s, listType: 'NONE', paragraphIndent: 0 }, null).width : 0;
    if (m.height <= room && word <= inner + 0.5) break;
  }
  set(doc, tx, text, { fontSize: size, x: STICKY_PADDING, y: STICKY_PADDING, width: inner, height: round(height), textAutoResize: 'HEIGHT' });
  // Text that does not fit at its size grows the sticky down, as in FigJam (it never shrinks by itself).
  if (height > room + 0.5) {
    const grown = round(h + (height - room));
    tx.set(id, 'height', grown);
    if (author && doc.get(author, 'visible')) tx.set(author, 'y', round(grown - STICKY_PADDING + 6 - doc.get(author, 'height')));
  }
  // Sizes of the runs follow the base size (a sticky's text is one size).
  const runs = doc.get(text, 'textRuns');
  if (runs.some((r) => r.style.fontSize !== undefined)) tx.set(text, 'textRuns', runs.map((r) => ({ ...r, style: { ...r.style, fontSize: undefined } })));
}

function stickyInk() {
  return [{ type: 'SOLID' as const, color: { r: 0.1, g: 0.1, b: 0.1, a: 1 }, opacity: 1, visible: true }];
}

// ---------- shapes ----------

/** Where a shape's text may go, as shares of its width and height (left, top, right, bottom). */
const TEXT_INSETS: Record<BoardShape, [number, number, number, number]> = {
  RECTANGLE: [0, 0, 0, 0],
  ROUNDED: [0, 0, 0, 0],
  ELLIPSE: [0.15, 0.15, 0.15, 0.15],
  DIAMOND: [0.25, 0.25, 0.25, 0.25],
  TRIANGLE: [0.25, 0.45, 0.25, 0.05],
  PARALLELOGRAM: [0.15, 0, 0.15, 0],
  HEXAGON: [0.15, 0, 0.15, 0],
  CYLINDER: [0, 0.2, 0, 0.08],
  DOCUMENT: [0, 0, 0, 0.14],
  STAR: [0.3, 0.38, 0.3, 0.25],
  ARROW: [0, 0.25, 0.3, 0.25],
  SPEECH: [0, 0, 0, 0.22],
  TERMINATOR: [0.1, 0, 0.1, 0],
  SUBPROCESS: [0.1, 0, 0.1, 0],
  MULTI_DOCUMENT: [0, 0.12, 0.08, 0.14],
  TRAPEZOID: [0.15, 0, 0.15, 0],
  NOTE: [0, 0.12, 0, 0],
  CLOUD: [0.14, 0.3, 0.1, 0.06],
  QUEUE: [0.04, 0, 0.16, 0],
  SERVER: [0, 0.3, 0, 0],
  USER: [0, 0.72, 0, 0],
};

function syncShape(doc: Document, tx: Transaction, id: NodeId, shape: BoardShape, measurer: TextMeasurer): void {
  const w = doc.get(id, 'width');
  let h = doc.get(id, 'height');
  let outline: NodeId | null = null;
  let text: NodeId | null = null;
  for (const c of doc.children(id)) {
    const kind = roleOf(doc, c)?.kind;
    if (kind === 'SHAPE_OUTLINE') outline = c;
    else if (kind === 'SHAPE_TEXT') text = c;
  }
  const [l, t, r, b] = TEXT_INSETS[shape] ?? [0, 0, 0, 0];
  if (text) {
    // The text's room inside the outline, wider when a word would not fit whole (up to the shape's own width).
    const room0 = Math.max(1, w * (1 - l - r) - SHAPE_PADDING * 2);
    const chars = doc.get(text, 'characters');
    const longest = chars.split(/\s+/).reduce((x, y) => (y.length > x.length ? y : x), '');
    const word = longest ? measurer.measure({ ...textStyleOf(doc, text), runs: [], characters: longest, listType: 'NONE', paragraphIndent: 0 }, null).width + 1 : 0;
    const width = Math.min(Math.max(room0, word), Math.max(1, w - SHAPE_PADDING * 2));
    const shift = (width - room0) / 2;
    set(doc, tx, text, { width: round(width), textAutoResize: 'HEIGHT', textAlignH: 'CENTER' });
    const th = doc.get(text, 'characters') ? measurer.measure(textStyleOf(doc, text), width).height : measurer.measure({ ...textStyleOf(doc, text), characters: ' ' }, width).height;
    // The text needs more room: the shape grows (and never shrinks by itself).
    const need = (th + SHAPE_PADDING * 2) / Math.max(0.2, 1 - t - b);
    if (need > h + 0.5) {
      h = round(need);
      tx.set(id, 'height', h);
    }
    const top = h * t + SHAPE_PADDING;
    const room = h * (1 - t - b) - SHAPE_PADDING * 2;
    set(doc, tx, text, { x: round(w * l + SHAPE_PADDING - shift), y: round(top + (room - th) / 2), height: round(th) });
  }
  if (outline) {
    const paths = shapeOutline(shape, w, h);
    set(doc, tx, outline, { x: 0, y: 0, width: w, height: h, rotation: 0 });
    if (!valueEquals(doc.get(outline, 'vectorPaths'), paths)) tx.set(outline, 'vectorPaths', paths);
  }
}

const K = 0.5522847498;

/** The outline of a board shape at a size, in its own coordinates. */
export function shapeOutline(shape: BoardShape, w: number, h: number): VectorPath[] {
  const p = (x: number, y: number, extra: Partial<VectorPoint> = {}): VectorPoint => ({ x: round(x), y: round(y), ...extra });
  const poly = (...pts: [number, number][]): VectorPath[] => [{ closed: true, points: pts.map(([x, y]) => p(x, y)) }];
  switch (shape) {
    case 'ROUNDED':
      return [roundedRect(0, 0, w, h, Math.min(16, w / 4, h / 4))];
    case 'ELLIPSE':
      return [ellipse(w / 2, h / 2, w / 2, h / 2)];
    case 'DIAMOND':
      return poly([w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]);
    case 'TRIANGLE':
      return poly([w / 2, 0], [w, h], [0, h]);
    case 'PARALLELOGRAM': {
      const s = Math.min(w * 0.2, h * 0.6);
      return poly([s, 0], [w, 0], [w - s, h], [0, h]);
    }
    case 'HEXAGON': {
      const s = Math.min(w * 0.25, h * 0.5);
      return poly([s, 0], [w - s, 0], [w, h / 2], [w - s, h], [s, h], [0, h / 2]);
    }
    case 'CYLINDER': {
      const ry = Math.min(h * 0.15, 20);
      const kx = (w / 2) * K;
      const ky = ry * K;
      const body: VectorPath = {
        closed: true,
        points: [
          p(0, ry, { in: { x: 0, y: round(h - ry + ky) }, out: { x: 0, y: round(ry - ky) } }),
          p(w / 2, 0, { in: { x: round(w / 2 - kx), y: 0 }, out: { x: round(w / 2 + kx), y: 0 } }),
          p(w, ry, { in: { x: w, y: round(ry - ky) } }),
          p(w, h - ry, { out: { x: w, y: round(h - ry + ky) } }),
          p(w / 2, h, { in: { x: round(w / 2 + kx), y: h }, out: { x: round(w / 2 - kx), y: h } }),
          p(0, h - ry, { in: { x: 0, y: round(h - ry + ky) } }),
        ],
      };
      // The near half of the top rim.
      const rim: VectorPath = {
        closed: false,
        points: [p(0, ry, { out: { x: 0, y: round(ry + ky) } }), p(w / 2, ry * 2, { in: { x: round(w / 2 - kx), y: round(ry * 2) }, out: { x: round(w / 2 + kx), y: round(ry * 2) } }), p(w, ry, { in: { x: w, y: round(ry + ky) } })],
      };
      return [body, rim];
    }
    case 'DOCUMENT':
      return [documentOutline(0, 0, w, h, Math.min(h * 0.1, 14), p)];
    case 'STAR': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const k = i % 2 === 0 ? 1 : 0.45;
        pts.push([w / 2 + Math.cos(a) * (w / 2) * k, h / 2 + Math.sin(a) * (h / 2) * k]);
      }
      return poly(...pts);
    }
    case 'ARROW': {
      const head = Math.min(w * 0.4, h * 0.8);
      const half = h * 0.25;
      return poly([0, h / 2 - half], [w - head, h / 2 - half], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h / 2 + half], [0, h / 2 + half]);
    }
    case 'SPEECH': {
      const bottom = h * 0.8;
      const r = Math.min(12, w / 4, bottom / 4);
      const body = roundedRect(0, 0, w, bottom, r);
      // The tail cuts into the bottom edge: drawn as part of the same outline.
      const pts = body.points;
      const tail = [p(w * 0.36, bottom), p(w * 0.2, h), p(w * 0.22, bottom)];
      // Insert the tail where the bottom edge runs from right to left (after the bottom-right corner).
      const at = pts.findIndex((q) => q.y === round(bottom) && q.x < w - r + 0.01 && q.x > r - 0.01 && q.x > w / 2);
      const index = at >= 0 ? at + 1 : pts.length;
      return [{ closed: true, points: [...pts.slice(0, index), ...tail, ...pts.slice(index)] }];
    }
    case 'TERMINATOR':
      return [roundedRect(0, 0, w, h, Math.min(h / 2, w / 2))];
    case 'SUBPROCESS': {
      // Open contours are details: drawn as lines over the fill (see the renderers).
      const s = Math.min(14, w * 0.1);
      return [...poly([0, 0], [w, 0], [w, h], [0, h]), { closed: false, points: [p(s, 0), p(s, h)] }, { closed: false, points: [p(w - s, 0), p(w - s, h)] }];
    }
    case 'MULTI_DOCUMENT': {
      // Two sheets peeking out from behind the front one (only their visible strips).
      const o = Math.min(8, w * 0.06, h * 0.08);
      const d = Math.min((h - o * 2) * 0.1, 14);
      const front = documentOutline(0, o * 2, w - o * 2, h - o * 2, d, p);
      const back = (k: number): VectorPath => {
        const x = o * k;
        const y = o * (2 - k);
        const fx = w - o * 2 + x;
        return { closed: true, points: [p(x, y), p(fx, y), p(fx, h - x - d), p(fx - o, h - x - d), p(fx - o, y + o), p(x, y + o)] };
      };
      return [back(2), back(1), front];
    }
    case 'TRAPEZOID': {
      const s = Math.min(w * 0.2, h * 0.6);
      return poly([s, 0], [w - s, 0], [w, h], [0, h]);
    }
    case 'NOTE': {
      const f = Math.min(20, w * 0.2, h * 0.3);
      return [...poly([0, 0], [w - f, 0], [w, f], [w, h], [0, h]), { closed: false, points: [p(w - f, 0), p(w - f, f), p(w, f)] }];
    }
    case 'CLOUD': {
      // Puffs drawn in a unit box, stretched to the size.
      const c = (x: number, y: number, ix?: number, iy?: number, ox?: number, oy?: number): VectorPoint =>
        p(x * w, y * h, { ...(ix !== undefined ? { in: { x: round(ix * w), y: round(iy! * h) } } : {}), ...(ox !== undefined ? { out: { x: round(ox * w), y: round(oy! * h) } } : {}) });
      return [
        {
          closed: true,
          points: [
            c(0.24, 1, undefined, undefined, 0.07, 1),
            c(0.08, 0.66, 0, 0.84, 0.01, 0.47),
            c(0.29, 0.36, 0.13, 0.3, 0.3, 0.1),
            c(0.64, 0.14, 0.52, -0.03, 0.8, 0.05),
            c(0.9, 0.44, 0.97, 0.22, 1.03, 0.56),
            c(0.78, 1, 1, 0.98, undefined, undefined),
          ],
        },
      ];
    }
    case 'QUEUE': {
      // A cylinder lying on its side: a message queue, a bus.
      const rx = Math.min(w * 0.12, 20);
      const kx = rx * K;
      const ky = (h / 2) * K;
      const body: VectorPath = {
        closed: true,
        points: [
          p(rx, 0),
          p(w - rx, 0, { out: { x: round(w - rx + kx), y: 0 } }),
          p(w, h / 2, { in: { x: w, y: round(h / 2 - ky) }, out: { x: w, y: round(h / 2 + ky) } }),
          p(w - rx, h, { in: { x: round(w - rx + kx), y: h } }),
          p(rx, h, { out: { x: round(rx - kx), y: h } }),
          p(0, h / 2, { in: { x: 0, y: round(h / 2 + ky) }, out: { x: 0, y: round(h / 2 - ky) } }),
          p(rx, 0, { in: { x: round(rx - kx), y: 0 } }),
        ],
      };
      // The near half of the right end.
      const rim: VectorPath = {
        closed: false,
        points: [p(w - rx, 0, { out: { x: round(w - rx - kx), y: 0 } }), p(w - rx * 2, h / 2, { in: { x: w - rx * 2, y: round(h / 2 - ky) }, out: { x: w - rx * 2, y: round(h / 2 + ky) } }), p(w - rx, h, { in: { x: round(w - rx - kx), y: h } })],
      };
      return [body, rim];
    }
    case 'SERVER': {
      // A tower: its case, two drive bays and a power light.
      const r = Math.min(8, w / 8, h / 8);
      const pad = Math.min(16, w * 0.16);
      const bay = (y: number): VectorPath => ({ closed: false, points: [p(pad, y), p(w - pad, y)] });
      const light = Math.min(3.5, w * 0.03);
      return [roundedRect(0, 0, w, h, r), bay(h * 0.1), bay(h * 0.18), ellipse(w - pad - light, h * 0.26, light, light)];
    }
    case 'USER': {
      // A person: the head and the shoulders, the name below.
      const fh = h * 0.68;
      const head = Math.min(w * 0.2, fh * 0.24);
      const cx = w / 2;
      const top = fh * 0.04;
      const sw = Math.min(w * 0.42, fh * 0.6);
      const sy = top + head * 2 + fh * 0.06;
      const sh = fh - sy;
      const k = sw * K;
      const shoulders: VectorPath = {
        closed: true,
        points: [
          p(cx - sw, fh, { out: { x: round(cx - sw), y: round(fh - sh * K) } }),
          p(cx, sy, { in: { x: round(cx - k), y: round(sy) }, out: { x: round(cx + k), y: round(sy) } }),
          p(cx + sw, fh, { in: { x: round(cx + sw), y: round(fh - sh * K) } }),
        ],
      };
      return [ellipse(cx, top + head, head, head), shoulders];
    }
    default:
      return poly([0, 0], [w, 0], [w, h], [0, h]);
  }
}

/** A sheet with a wavy bottom edge (the flowchart's document), in a box. */
function documentOutline(x: number, y: number, w: number, h: number, d: number, p: (x: number, y: number, extra?: Partial<VectorPoint>) => VectorPoint): VectorPath {
  return { closed: true, points: [p(x, y), p(x + w, y), p(x + w, y + h - d, { out: { x: round(x + w * 0.7), y: round(y + h - d * 3) } }), p(x, y + h - d, { in: { x: round(x + w * 0.3), y: round(y + h + d) } })] };
}

function roundedRect(x: number, y: number, w: number, h: number, r: number): VectorPath {
  const k = r * (1 - K);
  const P = (px: number, py: number, inn?: Point, out?: Point): VectorPoint => ({ x: round(px), y: round(py), ...(inn ? { in: { x: round(inn.x), y: round(inn.y) } } : {}), ...(out ? { out: { x: round(out.x), y: round(out.y) } } : {}) });
  return {
    closed: true,
    points: [
      P(x + r, y, { x: x + k, y }),
      P(x + w - r, y, undefined, { x: x + w - k, y }),
      P(x + w, y + r, { x: x + w, y: y + k }),
      P(x + w, y + h - r, undefined, { x: x + w, y: y + h - k }),
      P(x + w - r, y + h, { x: x + w - k, y: y + h }),
      P(x + r, y + h, undefined, { x: x + k, y: y + h }),
      P(x, y + h - r, { x, y: y + h - k }),
      P(x, y + r, undefined, { x, y: y + k }),
    ],
  };
}

function ellipse(cx: number, cy: number, rx: number, ry: number): VectorPath {
  const kx = rx * K;
  const ky = ry * K;
  const P = (x: number, y: number, inn: Point, out: Point): VectorPoint => ({ x: round(x), y: round(y), in: { x: round(inn.x), y: round(inn.y) }, out: { x: round(out.x), y: round(out.y) } });
  return {
    closed: true,
    points: [
      P(cx, cy - ry, { x: cx - kx, y: cy - ry }, { x: cx + kx, y: cy - ry }),
      P(cx + rx, cy, { x: cx + rx, y: cy - ky }, { x: cx + rx, y: cy + ky }),
      P(cx, cy + ry, { x: cx + kx, y: cy + ry }, { x: cx - kx, y: cy + ry }),
      P(cx - rx, cy, { x: cx - rx, y: cy + ky }, { x: cx - rx, y: cy - ky }),
    ],
  };
}

// ---------- stamps ----------

function syncStamp(doc: Document, tx: Transaction, id: NodeId): void {
  const w = doc.get(id, 'width');
  const h = doc.get(id, 'height');
  const size = Math.min(w, h);
  set(doc, tx, id, { cornerRadius: size / 2 });
  for (const c of doc.children(id)) {
    if (doc.type(c) !== 'TEXT') continue;
    const weight = (doc.get(c, 'fontWeight') as number | undefined) ?? 400;
    const baseFontSize = weight >= 700 ? 16 : 28;
    set(doc, tx, c, { fontSize: Math.round(size * baseFontSize / 44) });
    break;
  }
}

// ---------- connectors ----------

/** World transform of a layer (page coordinates). */
export function worldOf(doc: Document, id: NodeId): Matrix {
  let m: Matrix = IDENTITY;
  const chain: NodeId[] = [];
  for (let cur: NodeId | null = id; cur && doc.type(cur) !== 'PAGE' && doc.type(cur) !== 'DOCUMENT'; cur = doc.parent(cur)) chain.push(cur);
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i]!;
    m = multiply(m, nodeTransform(doc.get(n, 'x'), doc.get(n, 'y'), doc.get(n, 'rotation')));
  }
  return m;
}

/** Page-space box of a layer (axis-aligned around its corners). */
export function worldBox(doc: Document, id: NodeId): Rect {
  const m = worldOf(doc, id);
  const w = doc.get(id, 'width');
  const h = doc.get(id, 'height');
  const pts = [apply(m, { x: 0, y: 0 }), apply(m, { x: w, y: 0 }), apply(m, { x: w, y: h }), apply(m, { x: 0, y: h })];
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const NORMALS: Record<Exclude<ConnectorSide, 'AUTO'>, Point> = { TOP: { x: 0, y: -1 }, RIGHT: { x: 1, y: 0 }, BOTTOM: { x: 0, y: 1 }, LEFT: { x: -1, y: 0 } };

/** Whether an end is attached to a layer that is there (on the same page as the connector). */
function attached(doc: Document, end: ConnectorEnd, page: NodeId | null): boolean {
  return !!end.node && doc.store.isAlive(end.node) && doc.pageOf(end.node) === page;
}

/** The side of a box that faces a point. */
export function facingSide(box: Rect, toward: Point): Exclude<ConnectorSide, 'AUTO'> {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (Math.abs(dx) * Math.max(1, box.height) >= Math.abs(dy) * Math.max(1, box.width)) return dx >= 0 ? 'RIGHT' : 'LEFT';
  return dy >= 0 ? 'BOTTOM' : 'TOP';
}

export function sidePoint(box: Rect, side: Exclude<ConnectorSide, 'AUTO'>): Point {
  switch (side) {
    case 'TOP':
      return { x: box.x + box.width / 2, y: box.y };
    case 'RIGHT':
      return { x: box.x + box.width, y: box.y + box.height / 2 };
    case 'BOTTOM':
      return { x: box.x + box.width / 2, y: box.y + box.height };
    default:
      return { x: box.x, y: box.y + box.height / 2 };
  }
}

interface ResolvedEnd {
  point: Point;
  /** Direction the line leaves this end in (null for a free end). */
  normal: Point | null;
}

/** Where both ends of a connector are now. */
export function resolveEnds(doc: Document, start: ConnectorEnd, end: ConnectorEnd, page: NodeId | null): [ResolvedEnd, ResolvedEnd] {
  const boxA = attached(doc, start, page) ? worldBox(doc, start.node!) : null;
  const boxB = attached(doc, end, page) ? worldBox(doc, end.node!) : null;
  const center = (b: Rect) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const towardA = boxB ? center(boxB) : { x: end.x, y: end.y };
  const towardB = boxA ? center(boxA) : { x: start.x, y: start.y };
  const one = (box: Rect | null, e: ConnectorEnd, toward: Point): ResolvedEnd => {
    if (!box) return { point: { x: e.x, y: e.y }, normal: null };
    const side = e.side === 'AUTO' ? facingSide(box, toward) : e.side;
    return { point: sidePoint(box, side), normal: NORMALS[side] };
  };
  return [one(boxA, start, towardA), one(boxB, end, towardB)];
}

/** The point a bent connector passes through (FEAT-115): its offset from the middle between the ends; null — not bent. */
export function bendPoint(a: ResolvedEnd, b: ResolvedEnd, bend: { x: number; y: number } | undefined): Point | null {
  if (!bend) return null;
  return { x: (a.point.x + b.point.x) / 2 + bend.x, y: (a.point.y + b.point.y) / 2 + bend.y };
}

/** The line of a connector as it is stored: bent through its point, or (elbow, not bent) around the objects on the page unless told not to. */
export function connectorRoute(a: ResolvedEnd, b: ResolvedEnd, role: Extract<BoardRole, { kind: 'CONNECTOR' }>, obstacles: () => readonly Rect[]): VectorPoint[] {
  const via = bendPoint(a, b, role.bend);
  return connectorPath(a, b, role.route, role.route === 'ELBOW' && !via && role.avoid !== false ? obstacles() : [], via);
}

/**
 * The connector's line in page coordinates. An elbow line goes around
 * `obstacles` (boxes of the objects on the page) when the plain one would cross them.
 * `via` — a point the line is bent through (then it does not go around anything).
 */
export function connectorPath(a: ResolvedEnd, b: ResolvedEnd, route: ConnectorRoute, obstacles: readonly Rect[] = [], via: Point | null = null): VectorPoint[] {
  const p0 = a.point;
  const p1 = b.point;
  if (via) return bentPath(a, b, route, via);
  if (route === 'STRAIGHT') return [{ ...p0 }, { ...p1 }];
  const na = a.normal ?? guessNormal(p0, p1);
  const nb = b.normal ?? guessNormal(p1, p0);
  if (route === 'CURVE') {
    const d = Math.max(40, Math.hypot(p1.x - p0.x, p1.y - p0.y) / 2.5);
    return [
      { x: p0.x, y: p0.y, out: { x: p0.x + na.x * d, y: p0.y + na.y * d } },
      { x: p1.x, y: p1.y, in: { x: p1.x + nb.x * d, y: p1.y + nb.y * d } },
    ];
  }
  // Elbow: out of each end along its side, then across.
  const GAP = 24;
  const a1 = { x: p0.x + na.x * GAP, y: p0.y + na.y * GAP };
  const b1 = { x: p1.x + nb.x * GAP, y: p1.y + nb.y * GAP };
  const horizontalA = na.x !== 0;
  const horizontalB = nb.x !== 0;
  let middle: Point[];
  if (horizontalA && horizontalB) {
    const x = (na.x > 0 && nb.x < 0 && a1.x <= b1.x) || (na.x < 0 && nb.x > 0 && a1.x >= b1.x) ? (p0.x + p1.x) / 2 : na.x > 0 ? Math.max(a1.x, b1.x) : Math.min(a1.x, b1.x);
    middle = [{ x, y: p0.y }, { x, y: p1.y }];
  } else if (!horizontalA && !horizontalB) {
    const y = (na.y > 0 && nb.y < 0 && a1.y <= b1.y) || (na.y < 0 && nb.y > 0 && a1.y >= b1.y) ? (p0.y + p1.y) / 2 : na.y > 0 ? Math.max(a1.y, b1.y) : Math.min(a1.y, b1.y);
    middle = [{ x: p0.x, y }, { x: p1.x, y }];
  } else if (horizontalA) {
    middle = [{ x: p1.x, y: p0.y }];
  } else {
    middle = [{ x: p0.x, y: p1.y }];
  }
  let pts = [p0, ...middle, p1];
  if (obstacles.length > 0 && crosses(pts, obstacles)) {
    const around = routeAround(a1, na, b1, nb, obstacles);
    if (around) pts = [p0, ...around, p1];
  }
  return simplify(pts);
}

/** A connector bent through a point: a straight line breaks there, a curve passes through it smoothly, an elbow line turns towards it at right angles. */
function bentPath(a: ResolvedEnd, b: ResolvedEnd, route: ConnectorRoute, v: Point): VectorPoint[] {
  const p0 = a.point;
  const p1 = b.point;
  if (route === 'STRAIGHT') return [{ ...p0 }, { x: v.x, y: v.y }, { ...p1 }];
  const na = a.normal ?? guessNormal(p0, v);
  const nb = b.normal ?? guessNormal(p1, v);
  if (route === 'CURVE') {
    // Through the point along the direction from one end to the other.
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const t = { x: dx / len, y: dy / len };
    const l0 = Math.hypot(v.x - p0.x, v.y - p0.y);
    const l1 = Math.hypot(p1.x - v.x, p1.y - v.y);
    const d0 = Math.max(30, l0 / 2.5);
    const d1 = Math.max(30, l1 / 2.5);
    return [
      { x: p0.x, y: p0.y, out: { x: p0.x + na.x * d0, y: p0.y + na.y * d0 } },
      { x: v.x, y: v.y, in: { x: v.x - (t.x * l0) / 3, y: v.y - (t.y * l0) / 3 }, out: { x: v.x + (t.x * l1) / 3, y: v.y + (t.y * l1) / 3 } },
      { x: p1.x, y: p1.y, in: { x: p1.x + nb.x * d1, y: p1.y + nb.y * d1 } },
    ];
  }
  // Elbow: out of each end along its side, then a run through the point, across or along.
  const GAP = 24;
  const a1 = { x: p0.x + na.x * GAP, y: p0.y + na.y * GAP };
  const b1 = { x: p1.x + nb.x * GAP, y: p1.y + nb.y * GAP };
  const across = [p0, a1, { x: a1.x, y: v.y }, v, { x: b1.x, y: v.y }, b1, p1];
  const along = [p0, a1, { x: v.x, y: a1.y }, v, { x: v.x, y: b1.y }, b1, p1];
  // The one that does not double back on itself, then with fewer turns, then shorter.
  return simplify(elbowCost(across) <= elbowCost(along) ? across : along);
}

/** How bad an elbow line looks: doubling back on itself (a spike) is worst, then turns, then length. */
function elbowCost(pts: readonly Point[]): number {
  const q: Point[] = [];
  for (const p of pts) {
    const last = q[q.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.01 || Math.abs(last.y - p.y) > 0.01) q.push(p);
  }
  let cost = 0;
  for (let i = 1; i < q.length; i++) {
    const a = q[i - 1]!;
    const b = q[i]!;
    cost += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const c = q[i + 1];
    if (!c) continue;
    const d1 = { x: b.x - a.x, y: b.y - a.y };
    const d2 = { x: c.x - b.x, y: c.y - b.y };
    const cross = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(cross) > 0.01) cost += 40;
    else if (d1.x * d2.x + d1.y * d2.y < 0) cost += 1e6;
  }
  return cost;
}

/** Drops points that repeat or lie on a straight run. */
function simplify(pts: readonly Point[]): VectorPoint[] {
  const out: Point[] = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - q.x) < 0.01 && Math.abs(last.y - q.y) < 0.01) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((Math.abs(prev.x - last.x) < 0.01 && Math.abs(last.x - q.x) < 0.01) || (Math.abs(prev.y - last.y) < 0.01 && Math.abs(last.y - q.y) < 0.01))) out.pop();
    out.push(q);
  }
  return out.map((q) => ({ x: q.x, y: q.y }));
}

/** Whether a polyline goes through the inside of any box. */
function crosses(points: readonly Point[], boxes: readonly Rect[]): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    for (const r of boxes) if (segmentInside(a, b, r)) return true;
  }
  return false;
}

/** An axis-aligned (or any) segment passing through the inside of a box (touching its edge does not count). */
function segmentInside(a: Point, b: Point, r: Rect): boolean {
  const E = 0.5;
  const x0 = r.x + E;
  const y0 = r.y + E;
  const x1 = r.x + r.width - E;
  const y1 = r.y + r.height - E;
  if (x1 <= x0 || y1 <= y0) return false;
  // Liang–Barsky clipping.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-6;
}

/** Room kept between a routed line and the objects it goes around. */
const CLEARANCE = 12;
/** A turn costs as much as this much length: fewer turns, cleaner lines. */
const TURN = 40;

/**
 * Right-angle path between two points that leave their objects along their
 * sides, around boxes: the shortest path with few turns over the grid of lines
 * along the boxes' edges (kept a little away from them). Null when there is none.
 */
function routeAround(a: Point, na: Point, b: Point, nb: Point, obstacles: readonly Rect[]): Point[] | null {
  const boxes = obstacles.map((r) => ({ x: r.x - CLEARANCE, y: r.y - CLEARANCE, width: r.width + CLEARANCE * 2, height: r.height + CLEARANCE * 2 }));
  const inside = (p: Point) => boxes.some((r) => p.x > r.x + 0.01 && p.x < r.x + r.width - 0.01 && p.y > r.y + 0.01 && p.y < r.y + r.height - 0.01);
  if (inside(a) || inside(b)) return null;
  const uniq = (v: number[]) => [...new Set(v.map((n) => Math.round(n * 100) / 100))].sort((p, q) => p - q);
  const xs = uniq([a.x, b.x, (a.x + b.x) / 2, ...boxes.flatMap((r) => [r.x, r.x + r.width])]);
  const ys = uniq([a.y, b.y, (a.y + b.y) / 2, ...boxes.flatMap((r) => [r.y, r.y + r.height])]);
  const W = xs.length;
  const H = ys.length;
  const at = (i: number, j: number) => ({ x: xs[i]!, y: ys[j]! });
  const free = new Uint8Array(W * H);
  for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) free[j * W + i] = inside(at(i, j)) ? 0 : 1;
  // Whether the step between two neighbouring grid points stays outside every box.
  const open = (i: number, j: number, k: number, l: number) => {
    const m = { x: (xs[i]! + xs[k]!) / 2, y: (ys[j]! + ys[l]!) / 2 };
    return free[j * W + i] === 1 && free[l * W + k] === 1 && !inside(m);
  };
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const dirOf = (n: Point) => DIRS.findIndex((d) => d.x === Math.sign(n.x) && d.y === Math.sign(n.y));
  const si = xs.indexOf(Math.round(a.x * 100) / 100);
  const sj = ys.indexOf(Math.round(a.y * 100) / 100);
  const ti = xs.indexOf(Math.round(b.x * 100) / 100);
  const tj = ys.indexOf(Math.round(b.y * 100) / 100);
  if (si < 0 || sj < 0 || ti < 0 || tj < 0) return null;
  const startDir = Math.max(0, dirOf(na));
  // Arriving at the end, the line goes into its object: against the end's side.
  const endDir = Math.max(0, dirOf({ x: -nb.x, y: -nb.y }));
  const N = W * H * 4;
  const cost = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const key = (i: number, j: number, d: number) => (j * W + i) * 4 + d;
  const heap: [number, number][] = [];
  const push = (c: number, k: number) => {
    heap.push([c, k]);
    let n = heap.length - 1;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (heap[p]![0] <= heap[n]![0]) break;
      [heap[p], heap[n]] = [heap[n]!, heap[p]!];
      n = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let n = 0;
      for (;;) {
        const l = n * 2 + 1;
        const r = l + 1;
        let m = n;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === n) break;
        [heap[m], heap[n]] = [heap[n]!, heap[m]!];
        n = m;
      }
    }
    return top;
  };
  const s = key(si, sj, startDir);
  cost[s] = 0;
  push(0, s);
  let best = -1;
  let bestCost = Infinity;
  while (heap.length > 0) {
    const [c, k] = pop();
    if (c > cost[k]! || c >= bestCost) continue;
    const d = k % 4;
    const cell = (k - d) / 4;
    const i = cell % W;
    const j = (cell - i) / W;
    if (i === ti && j === tj) {
      const total = c + (d === endDir ? 0 : TURN);
      if (total < bestCost) {
        bestCost = total;
        best = k;
      }
      continue;
    }
    for (let nd = 0; nd < 4; nd++) {
      const dir = DIRS[nd]!;
      // No going straight back.
      if (dir.x === -DIRS[d]!.x && dir.y === -DIRS[d]!.y) continue;
      const k2 = i + dir.x;
      const l2 = j + dir.y;
      if (k2 < 0 || l2 < 0 || k2 >= W || l2 >= H || !open(i, j, k2, l2)) continue;
      const step = Math.abs(xs[k2]! - xs[i]!) + Math.abs(ys[l2]! - ys[j]!);
      const next = key(k2, l2, nd);
      const nc = c + step + (nd === d ? 0 : TURN);
      if (nc < cost[next]!) {
        cost[next] = nc;
        from[next] = k;
        push(nc, next);
      }
    }
  }
  if (best < 0) return null;
  const path: Point[] = [];
  for (let k = best; k >= 0; k = from[k]!) {
    const cell = (k - (k % 4)) / 4;
    const i = cell % W;
    path.push(at(i, (cell - i) / W));
  }
  return path.reverse();
}

/** Boxes of the objects on a page that elbow connectors go around (not connectors, labels, strokes or sections). */
export function obstaclesOf(doc: Document, page: NodeId | null): Rect[] {
  if (!page) return [];
  const out: Rect[] = [];
  const visit = (parent: NodeId) => {
    for (const id of doc.children(parent)) {
      if (!doc.get(id, 'visible')) continue;
      const type = doc.type(id);
      if (type === 'SECTION') {
        visit(id);
        continue;
      }
      const kind = doc.get(id, 'board')?.kind;
      if (kind === 'CONNECTOR' || kind === 'CONNECTOR_LABEL' || kind === 'MARKER' || kind === 'STAMP') continue;
      if (type === 'TEXT' || type === 'LINE' || type === 'VECTOR') continue;
      out.push(worldBox(doc, id));
    }
  };
  visit(page);
  return out;
}

function guessNormal(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
  return { x: 0, y: dy >= 0 ? 1 : -1 };
}

/** Middle of a connector's line (for its label), in page coordinates. */
export function connectorMiddle(points: readonly VectorPoint[]): Point {
  if (points.length === 2 && (points[0]!.out || points[1]!.in)) {
    const a = points[0]!;
    const b = points[1]!;
    const c1 = a.out ?? a;
    const c2 = b.in ?? b;
    return { x: 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x, y: 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y };
  }
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  let left = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= len && len > 0) return { x: a.x + ((b.x - a.x) * left) / len, y: a.y + ((b.y - a.y) * left) / len };
    left -= len;
  }
  return { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 };
}

/**
 * Connectors an edit may move: the touched ones, those whose ends hold a touched
 * layer (or a layer inside one), those whose label changed, and elbow lines going
 * around objects near a touched one. Routing every line of a big board after each
 * key press was the slow part of typing on it; null — all of them (a layer deleted
 * or the tree reshaped: an obstacle may be gone).
 */
function connectorsToRoute(doc: Document, touched: ReadonlySet<NodeId>, connectors: readonly NodeId[], labels: readonly NodeId[]): Set<NodeId> | null {
  for (const id of touched) if (!doc.store.isAlive(id)) return null;
  const within = (node: NodeId | null): boolean => {
    for (let cur = node; cur && doc.store.isAlive(cur); cur = doc.parent(cur)) if (touched.has(cur)) return true;
    return false;
  };
  const out = new Set<NodeId>();
  for (const id of labels) if (touched.has(id)) out.add((doc.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR_LABEL' }>).connector);
  // Boxes of what changed (top-level boxes of board objects, not every text inside them).
  const boxes: Rect[] = [];
  for (const id of touched) {
    const type = doc.type(id);
    if (type === 'PAGE' || type === 'DOCUMENT' || !doc.store.isAlive(id)) continue;
    boxes.push(worldBox(doc, id));
  }
  const M = 400;
  for (const id of connectors) {
    if (out.has(id) || touched.has(id)) {
      out.add(id);
      continue;
    }
    const role = doc.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;
    if (within(role.start.node) || within(role.end.node)) {
      out.add(id);
      continue;
    }
    if (role.route !== 'ELBOW' || role.avoid === false || role.bend) continue;
    const b = worldBox(doc, id);
    if (boxes.some((r) => r.x < b.x + b.width + M && r.x + r.width > b.x - M && r.y < b.y + b.height + M && r.y + r.height > b.y - M)) out.add(id);
  }
  return out;
}

function syncConnectors(doc: Document, tx: Transaction, userChanges: ReadonlyMap<NodeId, ReadonlySet<PropKey>>, touched?: ReadonlySet<NodeId>): void {
  let connectors: NodeId[] = [];
  const labels: NodeId[] = [];
  for (const r of doc.store.allRecords()) {
    const kind = r.props.board?.kind;
    if (kind !== 'CONNECTOR' && kind !== 'CONNECTOR_LABEL') continue;
    if (!doc.store.isAlive(r.id)) continue;
    (kind === 'CONNECTOR' ? connectors : labels).push(r.id);
  }
  // Only the lines this edit may move (see connectorsToRoute); the whole board when it cannot be told.
  const route = touched && !tx.changes.structural ? connectorsToRoute(doc, touched, connectors, labels) : null;
  if (route) connectors = connectors.filter((id) => route.has(id));
  const middles = new Map<NodeId, Point>();
  // Boxes of the objects per page: elbow lines go around them.
  const obstacles = new Map<NodeId | null, Rect[]>();
  const around = (page: NodeId | null, a: Point, b: Point) => {
    if (!obstacles.has(page)) obstacles.set(page, obstaclesOf(doc, page));
    // Only those near the line matter (and keep the grid small).
    const M = 400;
    const x0 = Math.min(a.x, b.x) - M;
    const y0 = Math.min(a.y, b.y) - M;
    const x1 = Math.max(a.x, b.x) + M;
    const y1 = Math.max(a.y, b.y) + M;
    return obstacles.get(page)!.filter((r) => r.x < x1 && r.x + r.width > x0 && r.y < y1 && r.y + r.height > y0);
  };
  for (const id of connectors) {
    const role = doc.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR' }>;
    const page = doc.pageOf(id);
    let start = role.start;
    let end = role.end;
    const parentWorld = worldOf(doc, doc.parent(id)!);
    // Dragged as a whole: its free ends go along (ends attached to layers stay with them).
    const keys = userChanges.get(id);
    if (keys && (keys.has('x') || keys.has('y')) && !keys.has('board')) {
      const [a0, b0] = resolveEnds(doc, start, end, page);
      const expected = boundsOf(connectorRoute(a0, b0, role, () => around(page, a0.point, b0.point)));
      const now = apply(parentWorld, { x: doc.get(id, 'x'), y: doc.get(id, 'y') });
      const dx = now.x - expected.x;
      const dy = now.y - expected.y;
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        if (!attached(doc, start, page)) start = { ...start, x: start.x + dx, y: start.y + dy };
        if (!attached(doc, end, page)) end = { ...end, x: end.x + dx, y: end.y + dy };
      }
    }
    const [a, b] = resolveEnds(doc, start, end, page);
    const points = connectorRoute(a, b, role, () => around(page, a.point, b.point));
    // Ends remember where they are; a layer that is gone leaves its end free in place.
    const keep = (e: ConnectorEnd, r: ResolvedEnd): ConnectorEnd => ({ node: attached(doc, e, page) ? e.node : null, side: attached(doc, e, page) ? e.side : 'AUTO', x: round(r.point.x), y: round(r.point.y) });
    const next: BoardRole = { ...role, start: keep(start, a), end: keep(end, b) };
    if (!valueEquals(next, role)) tx.set(id, 'board', next);
    const box = boundsOf(points);
    const inverse = invert(parentWorld) ?? IDENTITY;
    const origin = apply(inverse, { x: box.x, y: box.y });
    const local = (q: Point) => ({ x: round(q.x - box.x), y: round(q.y - box.y) });
    const path: VectorPath = { closed: false, points: points.map((q) => ({ ...local(q), ...(q.in ? { in: local(q.in) } : {}), ...(q.out ? { out: local(q.out) } : {}) })) };
    set(doc, tx, id, { x: round(origin.x), y: round(origin.y), width: round(box.width), height: round(box.height), rotation: 0 });
    if (doc.get(id, 'vectorNetwork') !== null) tx.set(id, 'vectorNetwork', null);
    if (!valueEquals(doc.get(id, 'vectorPaths'), [path])) tx.set(id, 'vectorPaths', [path]);
    middles.set(id, bendPoint(a, b, role.bend) ?? connectorMiddle(points));
  }
  for (const id of labels) {
    const role = doc.get(id, 'board') as Extract<BoardRole, { kind: 'CONNECTOR_LABEL' }>;
    if (!doc.store.isAlive(role.connector) || doc.get(role.connector, 'board')?.kind !== 'CONNECTOR') {
      tx.delete(id);
      continue;
    }
    const mid = middles.get(role.connector);
    if (!mid) continue;
    const inverse = invert(worldOf(doc, doc.parent(id)!)) ?? IDENTITY;
    const at = apply(inverse, mid);
    set(doc, tx, id, { x: round(at.x - doc.get(id, 'width') / 2), y: round(at.y - doc.get(id, 'height') / 2) });
  }
}

function boundsOf(points: readonly VectorPoint[]): Rect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const q of points) {
    xs.push(q.x);
    ys.push(q.y);
    for (const c of [q.in, q.out]) {
      if (!c) continue;
      xs.push(c.x);
      ys.push(c.y);
    }
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// ---------- helpers ----------

function set(doc: Document, tx: Transaction, id: NodeId, props: Partial<Record<PropKey, unknown>>): void {
  for (const [key, value] of Object.entries(props) as [PropKey, unknown][]) {
    if (!valueEquals(doc.get(id, key), value)) tx.set(id, key, value as never);
  }
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** The board pass over every object of a document (a board just imported, made outside the editor). */
export function refreshBoard(doc: Document, tx: Transaction, measurer: TextMeasurer): void {
  for (const r of doc.store.allRecords()) {
    if (!doc.store.isAlive(r.id)) continue;
    const role = r.props.board;
    if (role?.kind === 'STICKY') syncSticky(doc, tx, r.id, measurer);
    else if (role?.kind === 'SHAPE') syncShape(doc, tx, r.id, role.shape, measurer);
    else if (role?.kind === 'STAMP') syncStamp(doc, tx, r.id);
  }
  syncConnectors(doc, tx, new Map());
}
