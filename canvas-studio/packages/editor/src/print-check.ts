// «Проверка перед печатью» (FEAT-225, other editors, item 7; as in Affinity and InDesign): what a print shop would
// send back, found by rules —
//   edge     text inside the safe margin (closer than 3 mm to the trim) or crossing it;
//   lowres   a picture printed under 300 ppi (under 150 — bad);
//   nobleed  a layer that touches the trim but stops there: a white hairline may show after cutting;
//   hairline a stroke thinner than 0.25 pt — may not print.
// 1 px of a frame is 1 pt (1/72″), as in Figma's PDF; millimetres are converted at 72/25.4.

import { tr, type NodeId } from '#core';
import type { Editor } from './editor.ts';

export const MM = 72 / 25.4;

export type PrintIssueKind = 'edge' | 'lowres' | 'nobleed' | 'hairline';

export interface PrintIssue {
  kind: PrintIssueKind;
  id: NodeId;
  now: string;
  /** Under 150 ppi, or text crossing the trim. */
  bad?: boolean;
}

export const PRINT_LABELS: Record<PrintIssueKind, string> = {
  edge: tr('Текст у края реза'),
  lowres: tr('Картинка слабого разрешения'),
  nobleed: tr('Не заходит на вылет'),
  hairline: tr('Слишком тонкая линия'),
};

type Size = { width: number; height: number } | null;

const num = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

/** Effective resolution of a picture paint on a layer `w`×`h` pt, by its scale mode. */
export function effectivePpi(mode: string, w: number, h: number, iw: number, ih: number, tileScale = 1): number {
  if (iw <= 0 || ih <= 0 || w <= 0 || h <= 0) return Infinity;
  const sx = w / iw;
  const sy = h / ih;
  // Points per image pixel → pixels per inch.
  const k = mode === 'FIT' ? Math.min(sx, sy) : mode === 'TILE' ? tileScale : mode === 'STRETCH' ? Math.max(sx, sy) : Math.max(sx, sy);
  return 72 / k;
}

export function checkPrint(editor: Editor, frame: NodeId, bleedMm: number, sizeOf: (hash: string) => Size): PrintIssue[] {
  const d = editor.doc;
  const scene = editor.scene;
  scene.ensure();
  const trim = scene.bounds(frame);
  const bleed = bleedMm * MM;
  const safe = 3 * MM;
  const out: PrintIssue[] = [];
  const visit = (id: NodeId) => {
    if (d.get(id, 'visible') === false || d.get(id, 'opacity') <= 0) return;
    const b = scene.bounds(id);
    const type = d.type(id);
    if (type === 'TEXT' && String(d.get(id, 'characters') ?? '').trim()) {
      const left = b.x - trim.x;
      const top = b.y - trim.y;
      const right = trim.x + trim.width - (b.x + b.width);
      const bottom = trim.y + trim.height - (b.y + b.height);
      const min = Math.min(left, top, right, bottom);
      if (min < safe) out.push({ kind: 'edge', id, now: min < 0 ? tr('выходит за рез') : tr('{0} мм от реза', num(min / MM)), bad: min < 0 });
    }
    for (const f of d.get(id, 'fills')) {
      if (!f.visible || f.type !== 'IMAGE') continue;
      const size = sizeOf(f.imageHash);
      if (!size) continue;
      const ppi = effectivePpi(f.scaleMode, b.width, b.height, size.width, size.height, f.scale ?? 1);
      if (ppi < 300) out.push({ kind: 'lowres', id, now: tr('{0} ppi', String(Math.round(ppi))), bad: ppi < 150 });
      break;
    }
    const strokes = d.get(id, 'strokes').some((s) => s.visible);
    const weight = d.get(id, 'strokeWeight');
    if (strokes && weight > 0 && weight < 0.25) out.push({ kind: 'hairline', id, now: `${num(weight)} pt` });
    // Touches an edge of the trim from inside but does not go on into the bleed (the frame's own fill is extended).
    if (bleed > 0 && type !== 'TEXT' && d.get(id, 'fills').some((f) => f.visible)) {
      const eps = 0.5;
      const touch = (edge: number, inner: number, outer: number) => Math.abs(inner - edge) <= eps && outer < bleed - eps;
      const reachL = trim.x - b.x;
      const reachT = trim.y - b.y;
      const reachR = b.x + b.width - (trim.x + trim.width);
      const reachB = b.y + b.height - (trim.y + trim.height);
      if (touch(trim.x, b.x, reachL) || touch(trim.y, b.y, reachT) || touch(trim.x + trim.width, b.x + b.width, reachR) || touch(trim.y + trim.height, b.y + b.height, reachB)) {
        out.push({ kind: 'nobleed', id, now: tr('нужно ещё {0} мм', num(bleedMm)) });
      }
    }
    // Inside a clipped child the parent already cuts: its content is not looked at further for bleed.
    for (const c of d.children(id)) visit(c);
  };
  for (const c of d.children(frame)) visit(c);
  return out;
}
