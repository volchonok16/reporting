// Font names for PowerPoint. A design names a family and a weight ("T2 Rooftop",
// 500); PowerPoint knows a font by its legacy family, where every weight past
// Regular and Bold is a family of its own ("T2 Rooftop Medium"), plus the Bold
// and Italic flags. Written as on the canvas, a Medium comes out as Regular
// made bold, an ExtraBold as ExtraBold made bolder still, and a family the
// fonts call otherwise is not found at all. The names are read from the font
// files themselves: the file's own fonts, then those installed on this
// computer (Chrome, Edge).

import type { Document } from '#core';
import { base64ToBytes } from '#core';
import { embeddedFonts, fontFromCollection, officeFace, weightFromStyle, type LocalFont, type OfficeFace } from '../fonts.ts';
import type { El, Run, Slide } from './writer.ts';

/** A face a family has, its bytes read only when chosen. */
export interface FaceSource {
  family: string;
  /** 0 — a variable font. */
  weight: number;
  italic: boolean;
  bytes(): Promise<Uint8Array>;
}

export interface MissingFont {
  family: string;
  /** A family that is there and looks like the one meant ("T2 Halvar" → "Halvar Breit t2"). */
  like: string | null;
}

export interface OfficeFonts {
  /** Family names as written in the presentation. */
  fonts: string[];
  missing: MissingFont[];
}

/** The file's own fonts. */
export function documentFaces(doc: Document): FaceSource[] {
  return embeddedFonts(doc).flatMap((f) => {
    const blob = doc.store.blobs.get(f.hash);
    return blob ? [{ family: f.family, weight: f.weight, italic: f.italic, bytes: async () => base64ToBytes(blob.data) }] : [];
  });
}

/**
 * Fonts installed on this computer. Call it right on the click: the browser
 * asks for the permission only while the click is fresh.
 */
export async function localFaces(): Promise<FaceSource[]> {
  const query = (globalThis as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts;
  if (!query) return [];
  try {
    return (await query()).map((f) => ({
      family: f.family,
      weight: weightFromStyle(f.style),
      italic: /italic|oblique/i.test(f.style),
      bytes: async () => fontFromCollection(new Uint8Array(await (await f.blob()).arrayBuffer()), f.postscriptName),
    }));
  } catch {
    return [];
  }
}

/** The face the browser draws a weight with: the nearest one, heavier first from 500 up (CSS font matching, simplified). */
function nearest(faces: FaceSource[], weight: number, italic: boolean): FaceSource {
  const slant = faces.filter((f) => f.italic === italic);
  const pool = slant.length ? slant : faces;
  const variable = pool.find((f) => f.weight === 0);
  if (variable) return variable;
  const score = (f: FaceSource) => Math.abs(f.weight - weight) * 2 + ((weight >= 500 ? f.weight < weight : f.weight > weight) ? 1 : 0);
  return pool.reduce((a, b) => (score(b) < score(a) ? b : a));
}

const words = (family: string) => family.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** A family whose name holds every word of the missing one, the closest first. */
export function lookAlike(family: string, available: Iterable<string>): string | null {
  const want = words(family);
  let best: { name: string; extra: number } | null = null;
  for (const name of new Set(available)) {
    const have = words(name);
    if (!want.every((w) => have.includes(w))) continue;
    const extra = have.length - want.length;
    if (!best || extra < best.extra) best = { name, extra };
  }
  return best?.name ?? null;
}

function eachRun(els: readonly El[], fn: (r: Omit<Run, 'text'>) => void): void {
  for (const e of els) {
    if (e.k === 'group') eachRun(e.els, fn);
    else if (e.k === 'text')
      for (const p of e.paras) {
        for (const r of p.runs) fn(r);
        if (p.endRun) fn(p.endRun);
      }
  }
}

/**
 * Rewrites the runs of the slides with the names PowerPoint knows: legacy
 * family, Bold and Italic as the chosen face has them — and made bold where
 * the browser makes it bold too (600 and up drawn with a lighter face).
 * Families found nowhere stay as they are.
 */
export async function useOfficeFonts(slides: readonly Slide[], sources: readonly FaceSource[]): Promise<OfficeFonts> {
  const byFamily = new Map<string, FaceSource[]>();
  for (const s of sources) {
    const k = s.family.toLowerCase();
    byFamily.set(k, [...(byFamily.get(k) ?? []), s]);
  }
  const read = new Map<FaceSource, Promise<OfficeFace | null>>();
  const faceOf = (s: FaceSource) => {
    let p = read.get(s);
    if (!p) read.set(s, (p = s.bytes().then(officeFace, () => null)));
    return p;
  };

  // A paragraph's end run can be the very object of a run: each one once.
  const runs = new Set<Omit<Run, 'text'>>();
  for (const slide of slides) eachRun(slide.els, (r) => runs.add(r));
  const fonts = new Set<string>();
  const missing = new Map<string, MissingFont>();
  for (const r of runs) {
    const faces = byFamily.get(r.font.toLowerCase());
    if (!faces) {
      if (!missing.has(r.font)) missing.set(r.font, { family: r.font, like: lookAlike(r.font, sources.map((s) => s.family)) });
      fonts.add(r.font);
      continue;
    }
    const chosen = nearest(faces, r.w, r.i);
    const face = await faceOf(chosen);
    if (!face) {
      fonts.add(r.font);
      continue;
    }
    r.font = face.family;
    r.bold = face.bold || (r.w >= 600 && (face.weight === 0 || face.weight < 600));
    r.i = face.italic || r.i;
    fonts.add(face.family);
  }
  return { fonts: [...fonts].sort(), missing: [...missing.values()] };
}
