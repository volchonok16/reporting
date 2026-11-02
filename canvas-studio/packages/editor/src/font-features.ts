// OpenType features and variation axes of a text (Figma's «Details» of the
// text panel). Canvas text takes neither, but a font registered with them —
// @font-face descriptors `featureSettings` / `variationSettings` — draws them:
// so each combination asked for gets its own registered copy of the font file
// under a name of its own, and canvas-text.ts draws with that name.
// The font file comes from the file's own fonts or, for Inter, from the editor.
// A system font that is not in the file has no file we can read: the panel
// suggests putting it in the file.

import { base64ToBytes, type Document, type EmbeddedFont } from '#core';
import { FontFile, setFontAliasResolver, unwrapWoff, type FontInfo } from '#render';
import type { RunFont } from '#layout';
import { embeddedFonts } from './fonts.ts';

/** Inter ships with the editor; its TTF (not the WOFF2 the page uses) can be read. */
const BUILT_IN: Record<string, { normal: string; italic: string }> = {
  Inter: { normal: '/apps/web/fonts/inter/InterVariable.ttf', italic: '/apps/web/fonts/inter/InterVariable-Italic.ttf' },
};

interface Source {
  key: string;
  bytes: () => Promise<Uint8Array | null>;
  /** The weights this file covers: a variable font — all. */
  weight: string;
  italic: boolean;
}

/** The file a family/weight/slant is drawn from, if we have one (the closest weight of the file's fonts). */
function sourceOf(doc: Document, family: string, weight: number, italic: boolean): Source | null {
  const own = embeddedFonts(doc).filter((f) => f.family === family);
  if (own.length > 0) {
    const sameSlant = own.filter((f) => f.italic === italic);
    const pool = sameSlant.length ? sameSlant : own;
    const best = pool.reduce((a: EmbeddedFont, b: EmbeddedFont) => (b.weight === 0 || (a.weight !== 0 && Math.abs(b.weight - weight) < Math.abs(a.weight - weight)) ? b : a));
    return {
      key: best.hash,
      italic: best.italic,
      weight: best.weight === 0 ? '1 1000' : String(best.weight),
      bytes: async () => {
        const blob = doc.store.blobs.get(best.hash);
        return blob ? unwrapWoff(base64ToBytes(blob.data)) : null;
      },
    };
  }
  const built = BUILT_IN[family];
  if (built) {
    const url = italic ? built.italic : built.normal;
    return { key: url, italic, weight: '100 900', bytes: () => fetchBytes(url) };
  }
  return null;
}

const fetched = new Map<string, Promise<Uint8Array | null>>();

function fetchBytes(url: string): Promise<Uint8Array | null> {
  let p = fetched.get(url);
  if (!p) {
    p = fetch(url)
      .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
      .catch(() => null);
    fetched.set(url, p);
  }
  return p;
}

const files = new Map<string, Promise<FontFile | null>>();

async function fileOf(source: Source): Promise<FontFile | null> {
  let p = files.get(source.key);
  if (!p) {
    p = source.bytes().then((b) => {
      if (!b) return null;
      try {
        return new FontFile(b);
      } catch {
        return null;
      }
    });
    files.set(source.key, p);
  }
  return p;
}

/**
 * What the font of a text can do: its features (with the names it gives its
 * stylistic sets) and axes. Null — no file to read (a system font not kept in
 * the file, or a WOFF2 one).
 */
export async function fontAbilities(doc: Document, family: string, weight: number, italic: boolean): Promise<FontInfo | null> {
  const source = sourceOf(doc, family, weight, italic);
  return source ? ((await fileOf(source))?.info ?? null) : null;
}

/** The parsed font file of a family (for outlines in exports); null — none to read. */
export function fontFileOf(doc: Document, family: string, weight: number, italic: boolean): Promise<FontFile | null> {
  const source = sourceOf(doc, family, weight, italic);
  return source ? fileOf(source) : Promise.resolve(null);
}

// ---------- registered copies with features ----------

/** Registered names by (file, features, axes): ready ones only; a pending one is null. */
const aliases = new Map<string, string | null>();
let counter = 0;
let current: Document | null = null;
const readyListeners = new Set<() => void>();

/** Calls `fn` when a font with features becomes ready (texts using it are re-measured then). */
export function onFeatureFontsReady(fn: () => void): () => void {
  readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

/** Starts drawing fonts with features for this document (call when a document opens). */
export function useFeatureFonts(doc: Document): void {
  current = doc;
  setFontAliasResolver(resolve);
}

function resolve(font: RunFont): string | null {
  const doc = current;
  if (!doc || typeof FontFace === 'undefined') return null;
  const source = sourceOf(doc, font.fontFamily, font.fontWeight, font.italic);
  if (!source) return null;
  const key = `${source.key}|${source.italic}|${font.features ?? ''}|${font.variations ?? ''}`;
  if (aliases.has(key)) return aliases.get(key)!;
  aliases.set(key, null);
  const name = `cs-ff-${++counter}`;
  void (async () => {
    const bytes = await source.bytes();
    if (!bytes) return;
    try {
      const face = new FontFace(name, bytes.slice() as BufferSource, {
        weight: source.weight,
        style: source.italic ? 'italic' : 'normal',
        ...(font.features ? { featureSettings: font.features } : {}),
        ...(font.variations ? { variationSettings: font.variations } : {}),
      } as FontFaceDescriptors);
      await face.load();
      document.fonts.add(face);
      aliases.set(key, name);
      for (const fn of readyListeners) fn();
    } catch {
      // The plain family stays.
    }
  })();
  return null;
}
