// Putting an icon of the set on the canvas: a frame of the chosen size (named
// «Иконка / …») holding the drawing as vectors that scale with the frame, so
// the icon is resized as one thing; its colour is the vectors' strokes and fills
// (the panel's «Selection colours» recolour it). The line keeps the chosen width
// at any size.

import { isFrameLike, tr, type NodeId } from '#core';
import type { Point } from '#geometry';
import type { Editor } from '../editor.ts';
import { buildSvgInto } from '../svg-import.ts';
import type { IconDef } from './set.ts';

export interface IconLook {
  /** Side of the icon, px. */
  size: number;
  /** Line width on the canvas, px. */
  stroke: number;
  /** #RRGGBB */
  color: string;
}

export const DEFAULT_LOOK: IconLook = { size: 24, stroke: 2, color: '#1E1E1E' };

/** The icon as an SVG document of `look` (the drawing's own grid is 24 × 24). */
export function iconSvg(def: IconDef, look: IconLook): string {
  const width = (look.stroke * 24) / look.size;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${look.size}" height="${look.size}" fill="none" stroke="${look.color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${def.body.replaceAll('currentColor', look.color)}</svg>`;
}

/**
 * Puts the icon centred at `at` (world), into the frame there; without `at` — into the
 * selected frame (its middle) or the middle of the view. Selects it; returns its frame.
 */
export function insertIcon(editor: Editor, def: IconDef, look: IconLook, at?: Point): NodeId | null {
  const d = editor.doc;
  if (d.readOnly) return null;
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  let parent: NodeId;
  let centre: Point;
  if (at) {
    centre = at;
    parent = editor.containerAt(at);
  } else if (only && isFrameLike(d.type(only)) && d.type(only) !== 'INSTANCE' && !editor.isInstanceLayer(only)) {
    const b = editor.scene.bounds(only);
    centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    parent = only;
  } else {
    centre = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
    parent = editor.containerAt(centre);
  }
  const local = editor.toParentSpace(parent, centre);
  const size = look.size;
  let frame: NodeId | null = null;
  editor.commit(
    tr('Иконка: {0}', def.ru),
    (tx) => {
      frame = tx.create('FRAME', parent, {
        name: `${tr('Иконка')} / ${def.ru}`,
        x: Math.round(local.x - size / 2),
        y: Math.round(local.y - size / 2),
        width: size,
        height: size,
        fills: [],
        clipsContent: false,
      });
      const drawing = buildSvgInto(tx, editor, iconSvg(def, look), frame, { x: 0, y: 0, width: size, height: size }, def.ru);
      // The drawing grows with the frame: the icon is resized as one thing.
      if (drawing) tx.set(drawing, 'constraints', { horizontal: 'SCALE', vertical: 'SCALE' });
    },
    () => (frame ? [frame] : []),
  );
  if (frame) editor.appear([frame]);
  return frame;
}
