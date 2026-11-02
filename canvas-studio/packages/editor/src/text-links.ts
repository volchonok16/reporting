// Hyperlinks in text: which link is under a point of the canvas. The text is
// laid out exactly as it is drawn (and as the caret is placed while editing),
// so the link of the character under the pointer is found.

import { safeLink, type Document, type NodeId } from '#core';
import { apply, invert, type Point } from '#geometry';
import { indexAt, runStyleAt, textStyleOf, type TextMeasurer } from '#layout';
import type { SceneGraph } from '#render';

/** The link of the character under a world point of a text layer, or null. */
export function linkAt(doc: Document, scene: SceneGraph, measurer: TextMeasurer, id: NodeId, world: Point): string | null {
  if (doc.type(id) !== 'TEXT') return null;
  const runs = doc.get(id, 'textRuns');
  if (!runs.some((r) => r.style.link)) return null;
  const inv = invert(scene.world(id));
  if (!inv) return null;
  const p = apply(inv, world);
  const w = doc.get(id, 'width');
  const h = doc.get(id, 'height');
  const autoWidth = doc.get(id, 'textAutoResize') === 'WIDTH_AND_HEIGHT';
  const { layout } = measurer.measure(textStyleOf(doc, id), autoWidth ? null : w);
  const valign = doc.get(id, 'textAlignV');
  const top = valign === 'CENTER' ? (h - layout.height) / 2 : valign === 'BOTTOM' ? h - layout.height : 0;
  if (p.y < top || p.y > top + layout.height) return null;
  const index = indexAt(layout, p.x, p.y - top, measurer, w, doc.get(id, 'textAlignH'));
  // indexAt gives the caret position nearest to the point: the character is the one it stands before or after.
  const link = runStyleAt(runs, index).link ?? (index > 0 ? runStyleAt(runs, index - 1).link : undefined);
  return link ? safeLink(link) : null;
}

/** Opens a link in a new tab, never giving the page a handle on this one. */
export function openLink(url: string): void {
  const safe = safeLink(url);
  if (safe) window.open(safe, '_blank', 'noopener,noreferrer');
}
