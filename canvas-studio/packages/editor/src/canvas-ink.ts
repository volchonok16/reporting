// Dark ink on the dark canvas (as Miro does it): in the dark theme, on the
// theme's own canvas colour, black text, lines, arrows and marker strokes that lie right on the canvas are
// shown light, dark colourful ones a little lighter.
// Only how they look here: the file, other people's screens and exports keep
// the stored colours. Fills are never changed (a black phone stays black);
// anything over a filled frame, sticky, shape or card stays as it is.

import type { Color, Document, NodeId } from '#core';
import type { SceneGraph } from '#render';
import { darkVariant, toOklch } from './color-math.ts';
import { isDark } from './theme.ts';
import { isThemePageBackground, type Editor } from './editor.ts';

/** Darker than this (OKLCH lightness) is hard to see on #1E1E1E. */
const DARK_INK = 0.5;
/** Layers whose fill can be what other layers lie on. */
const BACKDROPS = new Set(['SECTION', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'BOOLEAN_OPERATION']);

const lighten = (c: Color): Color => (toOklch(c).l < DARK_INK ? darkVariant(c) : c);

export class CanvasInk {
  private readonly editor: Editor;
  private readonly onCanvas = new Map<NodeId, boolean>();

  constructor(editor: Editor) {
    this.editor = editor;
    editor.events.on('change', () => this.onCanvas.clear());
    editor.events.on('page', () => this.onCanvas.clear());
  }

  /** The renderer's hook: how this layer's strokes and letters are coloured, or null — as stored. */
  readonly forNode = (id: NodeId): ((c: Color) => Color) | null => {
    const e = this.editor;
    if (!isDark() || !isThemePageBackground(e.doc.get(e.pageId, 'backgroundColor'))) return null;
    if (!hasDarkInk(e.doc, id)) return null;
    let known = this.onCanvas.get(id);
    if (known === undefined) {
      known = liesOnCanvas(e.doc, e.scene, id);
      this.onCanvas.set(id, known);
    }
    return known ? lighten : null;
  };
}

function visiblePaints(d: Document, id: NodeId, key: 'fills' | 'strokes') {
  return d.get(id, key).filter((p) => p.visible);
}

/** Strokes or letters dark enough to get lost on the dark canvas. */
function hasDarkInk(d: Document, id: NodeId): boolean {
  const type = d.type(id);
  const paints = type === 'TEXT' ? visiblePaints(d, id, 'fills') : d.get(id, 'strokeWeight') > 0 ? visiblePaints(d, id, 'strokes') : [];
  if (type === 'TEXT' && d.get(id, 'characters').length === 0) return false;
  return paints.some((p) => (p.type === 'SOLID' ? toOklch(p.color).l < DARK_INK : 'stops' in p && p.stops.some((s) => toOklch(s.color).l < DARK_INK)));
}

/** Filled enough to be the ground under what lies on it. */
function isBackdrop(d: Document, id: NodeId): boolean {
  if (!BACKDROPS.has(d.type(id)) || !d.get(id, 'visible') || d.get(id, 'opacity') < 0.5) return false;
  return visiblePaints(d, id, 'fills').some((p) => p.opacity >= 0.5 && (p.type !== 'SOLID' || p.color.a >= 0.5));
}

/** Every visible fill is a dark solid colour. */
function darkFill(d: Document, id: NodeId): boolean {
  return visiblePaints(d, id, 'fills').every((p) => p.type === 'SOLID' && toOklch(p.color).l < DARK_INK);
}

/**
 * Nothing filled under the layer's middle: no filled ancestor, and no filled
 * layer painted below it (an earlier sibling of it or of an ancestor) there.
 * A light-filled layer is its own ground for its outline; a dark-filled one
 * (a black shape) is not — its outline shows where it ends.
 */
function liesOnCanvas(d: Document, scene: SceneGraph, id: NodeId): boolean {
  if (d.type(id) !== 'TEXT' && isBackdrop(d, id) && !darkFill(d, id)) return false;
  const b = scene.renderBounds(id);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const covers = (s: NodeId) => {
    if (!isBackdrop(d, s)) return false;
    const r = scene.renderBounds(s);
    return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
  };
  let child = id;
  let parent = d.parent(id);
  while (parent) {
    if (parent !== scene.pageId && isBackdrop(d, parent)) return false;
    for (const s of d.children(parent)) {
      if (s === child) break;
      if (covers(s)) return false;
    }
    if (parent === scene.pageId) return true;
    child = parent;
    parent = d.parent(parent);
  }
  return true;
}
