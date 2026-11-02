// Fonts kept in the file (Figma users' complaint: a font installed on one
// computer shows as a fallback for everyone else). A font file is stored among
// the file's resources and listed on the document; whoever opens the file gets
// it registered in the browser, so the text looks the same everywhere —
// including exports. Fonts come from a file (TTF, OTF, WOFF, WOFF2), in
// Chrome and Edge straight from the fonts installed on this computer, or —
// for the families Google Fonts has — from there through our server (a .fig
// brings its Google fonts along by itself).

import { base64ToBytes, tr, type Document, type EmbeddedFont } from '#core';

const registered = new Set<string>();
const key = (f: EmbeddedFont) => `${f.hash}\u0000${f.family}\u0000${f.weight}\u0000${f.italic}`;

export function embeddedFonts(doc: Document): EmbeddedFont[] {
  return (doc.get(doc.rootId, 'embeddedFonts') as EmbeddedFont[] | undefined) ?? [];
}

const registeredListeners = new Set<(families: string[]) => void>();

/** Calls `fn` whenever the file's fonts become available in the page (what was drawn with a fallback can be redrawn). */
export function onFontsRegistered(fn: (families: string[]) => void): () => void {
  registeredListeners.add(fn);
  return () => registeredListeners.delete(fn);
}

/** Registers the file's fonts in the page. Resolves with the families that became available. */
export async function registerEmbeddedFonts(doc: Document): Promise<string[]> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return [];
  const added: string[] = [];
  for (const f of embeddedFonts(doc)) {
    const k = key(f);
    if (registered.has(k)) continue;
    const blob = doc.store.blobs.get(f.hash);
    if (!blob) continue;
    registered.add(k);
    try {
      const face = new FontFace(f.family, base64ToBytes(blob.data) as BufferSource, { weight: f.weight === 0 ? '1 1000' : String(f.weight), style: f.italic ? 'italic' : 'normal' });
      await face.load();
      document.fonts.add(face);
      added.push(f.family);
    } catch {
      registered.delete(k);
    }
  }
  const families = [...new Set(added)];
  if (families.length) for (const fn of registeredListeners) fn(families);
  return families;
}

// ---------- reading a font file ----------

export interface FontInfo {
  family: string;
  weight: number;
  italic: boolean;
}

const WEIGHT_WORDS: [RegExp, number][] = [
  [/hairline|thin/i, 100],
  [/extra\s*-?light|ultra\s*-?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi\s*-?bold|demi\s*-?bold/i, 600],
  [/extra\s*-?bold|ultra\s*-?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

/** Weight from a style name like "SemiBold Italic". */
export function weightFromStyle(style: string): number {
  for (const [re, w] of WEIGHT_WORDS) if (re.test(style)) return w;
  return 400;
}

/** Family, weight and slant from a file name like "Golos-Text_SemiBold-Italic.woff2" (WOFF2 cannot be read here). */
export function infoFromFileName(name: string): FontInfo {
  const base = name.replace(/\.[^.]+$/, '');
  const words = base.split(/[-_\s]+/).flatMap((w) => w.split(/(?<=[a-z])(?=[A-Z])/)).filter(Boolean);
  const styleWord = /^(thin|hairline|extra|ultra|light|regular|normal|book|medium|semi|demi|bold|black|heavy|italic|oblique|variable|vf)$/i;
  let cut = words.length;
  while (cut > 1 && styleWord.test(words[cut - 1]!)) cut--;
  const family = words.slice(0, cut).join(' ');
  const style = words.slice(cut).join(' ');
  const variable = /variable|\bvf\b/i.test(style);
  return { family, weight: variable ? 0 : weightFromStyle(style), italic: /italic|oblique/i.test(style) };
}

const u16 = (v: DataView, o: number) => v.getUint16(o);
const u32 = (v: DataView, o: number) => v.getUint32(o);
const tag = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Tables of an OpenType/TrueType or WOFF file (WOFF2 needs Brotli: not read). */
async function tables(bytes: Uint8Array): Promise<Map<string, DataView> | null> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) return null;
  const sig = tag(v, 0);
  const out = new Map<string, DataView>();
  if (sig === '\u0000\u0001\u0000\u0000' || sig === 'OTTO' || sig === 'true') {
    const count = u16(v, 4);
    for (let i = 0; i < count; i++) {
      const r = 12 + i * 16;
      if (r + 16 > bytes.length) break;
      const offset = u32(v, r + 8);
      const length = u32(v, r + 12);
      if (offset + length <= bytes.length) out.set(tag(v, r), new DataView(bytes.buffer, bytes.byteOffset + offset, length));
    }
    return out;
  }
  if (sig === 'wOFF') {
    const count = u16(v, 12);
    for (let i = 0; i < count; i++) {
      const r = 44 + i * 20;
      const t = tag(v, r);
      if (t !== 'name' && t !== 'OS/2' && t !== 'fvar') continue;
      const offset = u32(v, r + 4);
      const compLength = u32(v, r + 8);
      const origLength = u32(v, r + 12);
      const raw = bytes.subarray(offset, offset + compLength);
      const data = compLength < origLength ? await inflate(raw) : raw;
      out.set(t, new DataView(data.buffer, data.byteOffset, data.byteLength));
    }
    return out;
  }
  return null;
}

function nameOf(name: DataView, ids: number[]): string | null {
  const count = u16(name, 2);
  const strings = u16(name, 4);
  for (const id of ids) {
    let best: string | null = null;
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      if (r + 12 > name.byteLength) break;
      const platform = u16(name, r);
      const lang = u16(name, r + 4);
      if (u16(name, r + 6) !== id) continue;
      const length = u16(name, r + 8);
      const offset = strings + u16(name, r + 10);
      if (offset + length > name.byteLength) continue;
      let text = '';
      if (platform === 3 || platform === 0) for (let k = 0; k < length; k += 2) text += String.fromCharCode(u16(name, offset + k));
      else if (platform === 1) for (let k = 0; k < length; k++) text += String.fromCharCode(name.getUint8(offset + k));
      else continue;
      // English (US) Windows names first: they are the ones apps show.
      if (platform === 3 && lang === 0x409) return text;
      best ??= text;
    }
    if (best) return best;
  }
  return null;
}

/** Family, weight and slant of a font file: from its own tables, else from the file name. */
export async function fontInfo(bytes: Uint8Array, fileName: string): Promise<FontInfo> {
  const fallback = infoFromFileName(fileName);
  const t = await tables(bytes).catch(() => null);
  const name = t?.get('name');
  if (!t || !name) return fallback;
  const family = (nameOf(name, [16, 1]) ?? fallback.family).replace(/\s+Variable$/i, '');
  const style = nameOf(name, [17, 2]) ?? '';
  const os2 = t.get('OS/2');
  const weight = t.has('fvar') || fallback.weight === 0 ? 0 : os2 && os2.byteLength >= 6 ? u16(os2, 4) : weightFromStyle(style);
  const italic = (os2 && os2.byteLength >= 64 ? (u16(os2, 62) & 1) === 1 : false) || /italic|oblique/i.test(style);
  return { family, weight, italic };
}

/**
 * How Office knows a font: by its legacy family (name ID 1), where every
 * weight past Regular and Bold is a family of its own ("T2 Rooftop Medium"),
 * and whether the face is that family's Bold or Italic (name ID 2).
 */
export interface OfficeFace {
  family: string;
  bold: boolean;
  italic: boolean;
  /** 0 — a variable font. */
  weight: number;
}

export async function officeFace(bytes: Uint8Array): Promise<OfficeFace | null> {
  const t = await tables(bytes).catch(() => null);
  const name = t?.get('name');
  const family = name && nameOf(name, [1]);
  if (!t || !name || !family) return null;
  const style = nameOf(name, [2]) ?? '';
  const os2 = t.get('OS/2');
  const weight = t.has('fvar') ? 0 : os2 && os2.byteLength >= 6 ? u16(os2, 4) : weightFromStyle(style);
  return { family, bold: /bold/i.test(style), italic: /italic|oblique/i.test(style), weight };
}

const MIME: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };

/** Adds font files to the file (one undo step). Same family, weight and slant replace the old one. */
export async function embedFontFiles(doc: Document, files: { name: string; bytes: Uint8Array }[]): Promise<{ families: string[]; errors: string[] }> {
  const entries: { info: FontInfo; bytes: Uint8Array; mime: string }[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = MIME[ext];
    if (!mime) {
      errors.push(tr('«{0}» — не файл шрифта (нужен TTF, OTF, WOFF или WOFF2)', f.name));
      continue;
    }
    const info = await fontInfo(f.bytes, f.name);
    // The browser must be able to use it.
    try {
      await new FontFace('cs-probe', f.bytes as BufferSource).load();
    } catch {
      errors.push(tr('«{0}» — браузер не смог прочитать шрифт', f.name));
      continue;
    }
    entries.push({ info, bytes: f.bytes, mime });
  }
  if (entries.length) addEntries(doc, entries);
  return { families: [...new Set(entries.map((e) => e.info.family))], errors };
}

function addEntries(doc: Document, entries: { info: FontInfo; bytes: Uint8Array; mime: string }[], undoable = true): void {
  doc.transact(
    (tx) => {
      let list = embeddedFonts(doc).slice();
      for (const e of entries) {
        const hash = tx.addBlob(e.bytes, e.mime);
        list = list.filter((f) => !(f.family === e.info.family && f.weight === e.info.weight && f.italic === e.info.italic));
        list.push({ family: e.info.family, weight: e.info.weight, italic: e.info.italic, hash });
      }
      tx.set(doc.rootId, 'embeddedFonts', list);
    },
    { label: tr('Встроить шрифт'), undoable },
  );
}

/** Weights Google has: whole hundreds, 100…900. */
function googleWeight(weight: number): number {
  return Math.min(900, Math.max(100, Math.round((weight || 400) / 100) * 100));
}

/**
 * One face from Google Fonts through our server: bytes, 'missing' (Google has
 * no such family or face) or 'failed' (no server here, no network, Google down).
 */
async function googleFace(family: string, weight: number, italic: boolean): Promise<Uint8Array | 'missing' | 'failed'> {
  try {
    const res = await fetch(`/api/fonts/google?family=${encodeURIComponent(family)}&weight=${weight}${italic ? '&italic=1' : ''}`, { headers: { 'X-CS': '1' }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404 && (res.headers.get('content-type') ?? '').includes('json')) return 'missing';
    if (!res.ok || res.headers.get('content-type') !== 'font/ttf') return 'failed';
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return 'failed';
  }
}

/**
 * Embeds families from Google Fonts in the weights the file uses (Regular when
 * none of them is there — the browser makes the rest from it). `undoable:
 * false` — part of making the file (an import), not a step to undo.
 */
export async function embedGoogleFamilies(doc: Document, families: readonly string[], undoable = true): Promise<{ embedded: string[]; missing: string[]; failed: string[] }> {
  const out = { embedded: [] as string[], missing: [] as string[], failed: [] as string[] };
  const entries: { info: FontInfo; bytes: Uint8Array; mime: string }[] = [];
  await Promise.all(
    families.map(async (family) => {
      const styles = new Map<string, { weight: number; italic: boolean }>();
      for (const s of usedStyles(doc, family)) styles.set(`${googleWeight(s.weight)}${s.italic}`, { weight: googleWeight(s.weight), italic: s.italic });
      if (!styles.size) styles.set('400false', { weight: 400, italic: false });
      const got = await Promise.all([...styles.values()].map(async (s) => ({ ...s, res: await googleFace(family, s.weight, s.italic) })));
      let found = got.filter((g) => g.res instanceof Uint8Array);
      if (!found.length && got.every((g) => g.res === 'missing') && !styles.has('400false')) {
        const regular = await googleFace(family, 400, false);
        if (regular instanceof Uint8Array) found = [{ weight: 400, italic: false, res: regular }];
      }
      const usable: typeof entries = [];
      for (const g of found) {
        const bytes = g.res as Uint8Array;
        try {
          await new FontFace('cs-probe', bytes as BufferSource).load();
          usable.push({ info: { family, weight: g.weight, italic: g.italic }, bytes, mime: 'font/ttf' });
        } catch {
          // a face the browser cannot read is left out
        }
      }
      if (usable.length) {
        entries.push(...usable);
        out.embedded.push(family);
      } else if (got.some((g) => g.res === 'failed')) out.failed.push(family);
      else out.missing.push(family);
    }),
  );
  if (entries.length) addEntries(doc, entries, undoable);
  return out;
}

/** Weights and slants of a family the file uses (text layers and styled parts). */
export function usedStyles(doc: Document, family: string): { weight: number; italic: boolean }[] {
  const out = new Map<string, { weight: number; italic: boolean }>();
  // A diagram's font: its blocks are written in 400–700.
  const diagram = doc.get(doc.rootId, 'diagram') as { font?: string } | undefined;
  if (diagram?.font === family) for (const weight of [400, 500, 600, 700]) out.set(`${weight}false`, { weight, italic: false });
  for (const page of doc.pages()) {
    doc.store.walk(page, (id) => {
      if (doc.type(id) !== 'TEXT') return;
      const baseFamily = doc.get(id, 'fontFamily');
      const base = { weight: doc.get(id, 'fontWeight'), italic: doc.get(id, 'italic') };
      if (baseFamily === family) out.set(`${base.weight}${base.italic}`, base);
      for (const r of doc.get(id, 'textRuns')) {
        if ((r.style.fontFamily ?? baseFamily) !== family) continue;
        const s = { weight: r.style.fontWeight ?? base.weight, italic: r.style.italic ?? base.italic };
        out.set(`${s.weight}${s.italic}`, s);
      }
    });
  }
  return [...out.values()];
}

export type LocalFont = { family: string; style: string; postscriptName?: string; blob(): Promise<Blob> };

/** One font of a collection (.ttc, common for system fonts on a Mac) as a font file of its own. */
export function fontFromCollection(bytes: Uint8Array, postscriptName: string | undefined): Uint8Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(v, 0) !== 'ttcf') return bytes;
  const count = u32(v, 8);
  let chosen = u32(v, 12);
  for (let i = 0; i < count && postscriptName; i++) {
    const at = u32(v, 12 + i * 4);
    const n = u16(v, at + 4);
    for (let k = 0; k < n; k++) {
      const r = at + 12 + k * 16;
      if (tag(v, r) !== 'name') continue;
      const name = new DataView(bytes.buffer, bytes.byteOffset + u32(v, r + 8), u32(v, r + 12));
      if (nameOf(name, [6]) === postscriptName) chosen = at;
    }
  }
  const n = u16(v, chosen + 4);
  const records = Array.from({ length: n }, (_, k) => {
    const r = chosen + 12 + k * 16;
    return { tag: u32(v, r), sum: u32(v, r + 4), offset: u32(v, r + 8), length: u32(v, r + 12) };
  });
  const headerSize = 12 + n * 16;
  const size = records.reduce((s, r) => s + ((r.length + 3) & ~3), headerSize);
  const out = new Uint8Array(size);
  const w = new DataView(out.buffer);
  out.set(bytes.subarray(chosen, chosen + 12), 0);
  let at = headerSize;
  records.forEach((r, k) => {
    const rec = 12 + k * 16;
    w.setUint32(rec, r.tag);
    w.setUint32(rec + 4, r.sum);
    w.setUint32(rec + 8, at);
    w.setUint32(rec + 12, r.length);
    out.set(bytes.subarray(r.offset, r.offset + r.length), at);
    at += (r.length + 3) & ~3;
  });
  return out;
}

/**
 * Embeds a family installed on this computer (Chrome, Edge: Local Font Access),
 * only in the weights the file uses — whole families can weigh megabytes.
 */
export async function embedLocalFamily(doc: Document, family: string): Promise<{ count: number; error?: string }> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts;
  if (!query) return { count: 0, error: tr('Браузер не даёт доступ к шрифтам компьютера: добавьте файл шрифта.') };
  let fonts: LocalFont[];
  try {
    fonts = (await query()).filter((f) => f.family === family);
  } catch {
    return { count: 0, error: tr('Браузер не дал доступ к списку шрифтов. Разрешите «Шрифты» в настройках сайта.') };
  }
  if (!fonts.length) return { count: 0, error: tr('Шрифт «{0}» не найден на этом компьютере', family) };
  const wanted = usedStyles(doc, family);
  const pick = fonts.filter((f) => !wanted.length || wanted.some((w) => w.weight === weightFromStyle(f.style) && w.italic === /italic|oblique/i.test(f.style)));
  const chosen = pick.length ? pick : fonts;
  const entries: { info: FontInfo; bytes: Uint8Array; mime: string }[] = [];
  for (const f of chosen) {
    const bytes = fontFromCollection(new Uint8Array(await (await f.blob()).arrayBuffer()), f.postscriptName);
    const info = await fontInfo(bytes, `${family}-${f.style}.ttf`);
    entries.push({ info: { ...info, family }, bytes, mime: tag(new DataView(bytes.buffer), 0) === 'OTTO' ? 'font/otf' : 'font/ttf' });
  }
  addEntries(doc, entries);
  return { count: entries.length };
}

/** Removes a family from the file (the text falls back to what this computer has). */
export function removeEmbeddedFamily(doc: Document, family: string): void {
  doc.transact((tx) => tx.set(doc.rootId, 'embeddedFonts', embeddedFonts(doc).filter((f) => f.family !== family)), { label: tr('Убрать шрифт из файла') });
}
