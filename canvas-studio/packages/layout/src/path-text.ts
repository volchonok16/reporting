// Text on a path (Figma Draw): the letters of a text placed one by one along a
// line — each at its distance along the path, turned along it. One placement
// for the canvas, SVG and outlines, so they all agree.

import type { TextAlignH, VectorPath } from '#core';
import { flattenPaths } from '#geometry';
import type { Fragment, RichLayout, RunFont, TextMeasureApi } from './rich-text.ts';
import { letterSpacingPx } from './text-measure.ts';

export interface PathGlyph {
  text: string;
  font: RunFont;
  fragment: Fragment;
  /** Where the letter's baseline starts, and its turn (radians, clockwise on screen). */
  x: number;
  y: number;
  angle: number;
  advance: number;
}

interface Track {
  points: { x: number; y: number }[];
  at: number[];
  length: number;
  closed: boolean;
}

function trackOf(paths: readonly VectorPath[]): Track | null {
  const line = flattenPaths(paths, 0.2)[0];
  if (!line || line.points.length < 2) return null;
  const points = line.closed ? [...line.points, line.points[0]!] : line.points;
  const at = [0];
  for (let i = 1; i < points.length; i++) at.push(at[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  return { points, at, length: at[at.length - 1]!, closed: line.closed };
}

function pointAt(t: Track, d: number): { x: number; y: number } {
  // A closed outline goes round: past its start is its end.
  const s = t.closed ? ((d % t.length) + t.length) % t.length : Math.min(t.length, Math.max(0, d));
  let i = 1;
  while (i < t.at.length - 1 && t.at[i]! < s) i++;
  const a = t.points[i - 1]!;
  const b = t.points[i]!;
  const span = t.at[i]! - t.at[i - 1]! || 1;
  const k = (s - t.at[i - 1]!) / span;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Length of the first contour of a path (what the text runs along). */
export function pathLength(paths: readonly VectorPath[]): number {
  return trackOf(paths)?.length ?? 0;
}

/**
 * The letters of a laid-out text along a path. `offset` (0..1 of the length)
 * is where the text starts (left), its middle (centre) or its end (right);
 * paragraphs run on as one line. Letters past either end are left out.
 */
export function pathTextGlyphs(layout: RichLayout, paths: readonly VectorPath[], offset: number, align: TextAlignH, api: TextMeasureApi): PathGlyph[] {
  const track = trackOf(paths);
  if (!track) return [];
  // The text as one line: each letter with its advance (letter spacing included, as the canvas draws it).
  const letters: { text: string; font: RunFont; fragment: Fragment; advance: number }[] = [];
  layout.lines.forEach((line, li) => {
    if (li > 0 && letters.length) {
      const f = letters[letters.length - 1]!;
      letters.push({ text: ' ', font: f.font, fragment: f.fragment, advance: api.width(' ', f.font) });
    }
    for (const frag of line.fragments) {
      const spacing = letterSpacingPx(frag.font);
      let prefix = '';
      let before = 0;
      for (const ch of frag.text) {
        // The width of a run counts the spacing between its letters, not after the last: the first letter adds its own.
        const first = prefix === '';
        prefix += ch;
        const w = api.width(prefix, frag.font);
        letters.push({ text: ch, font: frag.font, fragment: frag, advance: w - before + (first ? spacing : 0) });
        before = w;
      }
    }
  });
  const total = letters.reduce((s, l) => s + l.advance, 0);
  const anchor = offset * track.length;
  let d = align === 'CENTER' || align === 'JUSTIFIED' ? anchor - total / 2 : align === 'RIGHT' ? anchor - total : anchor;
  const out: PathGlyph[] = [];
  for (const l of letters) {
    const mid = d + l.advance / 2;
    if ((track.closed || (mid >= 0 && mid <= track.length)) && !/^\s$/.test(l.text)) {
      // The turn from the chord over the letter's width: smooth on curves.
      const a = pointAt(track, d);
      const b = pointAt(track, d + l.advance);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const c = pointAt(track, mid);
      // The letter's start: half its width back from the middle, along its turn.
      out.push({ text: l.text, font: l.font, fragment: l.fragment, advance: l.advance, angle, x: c.x - (Math.cos(angle) * l.advance) / 2, y: c.y - (Math.sin(angle) * l.advance) / 2 });
    }
    d += l.advance;
  }
  return out;
}
