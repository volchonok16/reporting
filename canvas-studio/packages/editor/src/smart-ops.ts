// The algorithms behind the newer smart actions (✦): contrast, text styles,
// the same picture elsewhere, palettes from a colour and from a picture, a dark
// theme. Each has a plan (what and how much — the menu says it before the
// click) and an apply that is one undo step.

import { base64ToBytes, TEXT_STYLE_KEYS, tr, type Color, type NodeId, type Paint } from '#core';
import { contrast, darkVariant, fixContrast, hueName, mainColors, neededContrast, over, shades } from './color-math.ts';
import { shownPageBackground, type Editor } from './editor.ts';

// ---------- contrast ----------

export interface ContrastIssue {
  id: NodeId;
  ratio: number;
  need: number;
  /** The fixed colour; null — cannot fix here (bound to a variable or a style, inside a copy). */
  fix: Color | null;
}

function solidOf(fills: readonly Paint[]): { color: Color; opacity: number } | 'other' | null {
  const top = [...fills].reverse().find((p) => p.visible && p.opacity > 0);
  if (!top) return null;
  return top.type === 'SOLID' ? { color: top.color, opacity: top.opacity } : 'other';
}

/**
 * What a text stands on: the topmost layer under it with a plain fill —
 * siblings below it that cover it, then its parents — over the page colour.
 * null — a picture or a gradient: cannot be judged.
 */
function backgroundOf(editor: Editor, text: NodeId): Color | null {
  const d = editor.doc;
  const tb = editor.scene.bounds(text);
  const layers: Paint[][] = [];
  let child = text;
  let parent = d.parent(child);
  while (parent !== null && d.type(parent) !== 'PAGE') {
    const siblings = d.children(parent);
    for (let i = siblings.indexOf(child) - 1; i >= 0; i--) {
      const s = siblings[i]!;
      if (!d.get(s, 'visible') || d.type(s) === 'TEXT') continue;
      const b = editor.scene.bounds(s);
      if (b.x <= tb.x && b.y <= tb.y && b.x + b.width >= tb.x + tb.width && b.y + b.height >= tb.y + tb.height && solidOf(d.get(s, 'fills')) !== null) layers.push(d.get(s, 'fills'));
    }
    if (solidOf(d.get(parent, 'fills')) !== null) layers.push(d.get(parent, 'fills'));
    child = parent;
    parent = d.parent(parent);
  }
  // From the page up to the layer just under the text.
  let bg: Color = shownPageBackground(d.get(editor.pageId, 'backgroundColor'));
  for (const fills of layers.reverse()) {
    const s = solidOf(fills);
    if (s === 'other') return null;
    if (s) bg = over(s.color, bg, s.opacity);
  }
  return bg;
}

export function contrastIssues(editor: Editor, roots: readonly NodeId[]): ContrastIssue[] {
  const d = editor.doc;
  const out: ContrastIssue[] = [];
  const visit = (id: NodeId) => {
    if (!d.get(id, 'visible')) return;
    if (d.type(id) === 'TEXT' && d.get(id, 'characters').trim()) {
      const fg = solidOf(d.get(id, 'fills'));
      const bg = fg && fg !== 'other' ? backgroundOf(editor, id) : null;
      if (fg && fg !== 'other' && bg) {
        const seen = over(fg.color, bg, fg.opacity);
        const need = neededContrast(d.get(id, 'fontSize'), d.get(id, 'fontWeight'));
        const ratio = contrast(seen, bg);
        if (ratio < need) {
          const fixable = !editor.isInstanceLayer(id) && !d.get(id, 'fillStyleId') && !Object.keys(d.get(id, 'boundVariables') ?? {}).some((k) => k.startsWith('fills'));
          out.push({ id, ratio, need, fix: fixable ? fixContrast({ ...seen, a: 1 }, bg, need) : null });
        }
      }
      return;
    }
    for (const c of d.children(id)) visit(c);
  };
  roots.forEach(visit);
  return out;
}

export function fixContrastIssues(editor: Editor, issues: readonly ContrastIssue[]): number {
  const d = editor.doc;
  const fixable = issues.filter((i) => i.fix);
  if (!fixable.length) return 0;
  editor.commit(tr('Исправить контраст'), (tx) => {
    for (const i of fixable) {
      const fills = d.get(i.id, 'fills').slice();
      const at = fills.findLastIndex((p) => p.visible && p.opacity > 0);
      fills[at] = { type: 'SOLID', color: i.fix!, opacity: 1, visible: true };
      tx.set(i.id, 'fills', fills);
      // Coloured parts of the text would keep the old colour: they take the base one.
      const runs = d.get(i.id, 'textRuns');
      if (runs.some((r) => r.style.fills)) tx.set(i.id, 'textRuns', runs.map((r) => ({ ...r, style: { ...r.style, fills: undefined } })));
    }
  });
  return fixable.length;
}

// ---------- text styles ----------

/** Texts without a text style whose typography equals one exactly. */
export function textStyleMatches(editor: Editor, roots: readonly NodeId[]): { id: NodeId; style: NodeId }[] {
  const d = editor.doc;
  const styles = d.styles().filter((s) => d.get(s, 'styleType') === 'TEXT');
  if (!styles.length) return [];
  const sig = (id: NodeId) => JSON.stringify(TEXT_STYLE_KEYS.map((k) => d.get(id, k)));
  const bySig = new Map<string, NodeId>();
  for (const s of styles) if (!bySig.has(sig(s))) bySig.set(sig(s), s);
  const out: { id: NodeId; style: NodeId }[] = [];
  const visit = (id: NodeId) => {
    if (d.type(id) === 'TEXT') {
      const style = !d.get(id, 'textStyleId') && !editor.isInstanceLayer(id) ? bySig.get(sig(id)) : undefined;
      if (style) out.push({ id, style });
      return;
    }
    if (d.type(id) !== 'INSTANCE') for (const c of d.children(id)) visit(c);
  };
  roots.forEach(visit);
  return out;
}

export function bindTextStyles(editor: Editor, matches: readonly { id: NodeId; style: NodeId }[]): number {
  if (!matches.length) return 0;
  editor.commit(tr('Привязать к текстовым стилям'), (tx) => {
    for (const m of matches) tx.set(m.id, 'textStyleId', m.style);
  });
  return matches.length;
}

// ---------- the same picture ----------

export function imageHashes(editor: Editor, ids: readonly NodeId[]): Set<string> {
  const d = editor.doc;
  const out = new Set<string>();
  for (const id of ids) for (const p of d.get(id, 'fills')) if (p.type === 'IMAGE' && p.visible) out.add(p.imageHash);
  return out;
}

/** Layers with any of these pictures, per page (the selected ones left out). */
export function sameImages(editor: Editor, ids: readonly NodeId[]): Map<NodeId, NodeId[]> {
  const d = editor.doc;
  const hashes = imageHashes(editor, ids);
  const skip = new Set(ids);
  const out = new Map<NodeId, NodeId[]>();
  if (!hashes.size) return out;
  for (const page of d.pages()) {
    d.store.walk(page, (id) => {
      if (skip.has(id) || id === page) return;
      if (d.get(id, 'fills').some((p) => p.type === 'IMAGE' && hashes.has(p.imageHash))) out.set(page, [...(out.get(page) ?? []), id]);
    });
  }
  return out;
}

// ---------- palettes and themes ----------

/** The one plain colour of a layer (its fill, or a text's colour); null — none or several. */
export function singleColor(editor: Editor, id: NodeId): { color: Color; index: number } | null {
  const d = editor.doc;
  // A colour from a variable or a style is someone's system already: leave it.
  if (d.get(id, 'fillStyleId') || Object.keys(d.get(id, 'boundVariables') ?? {}).some((k) => k.startsWith('fills'))) return null;
  const fills = d.get(id, 'fills');
  const solid = fills.map((p, index) => ({ p, index })).filter(({ p }) => p.visible && p.type === 'SOLID');
  if (solid.length !== 1 || solid[0]!.p.type !== 'SOLID') return null;
  return { color: solid[0]!.p.color, index: solid[0]!.index };
}

/** A collection for generated colours: «Палитра» if there is one, else a new one (inside the current step). */
export function paletteCollection(editor: Editor, name: string): NodeId {
  const d = editor.doc;
  const found = d.collections().find((c) => d.get(c, 'name') === name);
  return found ?? editor.variables.createCollection(name);
}

/** A group name not taken in the collection: «Синий», «Синий 2»… */
export function freeGroup(editor: Editor, collection: NodeId, base: string): string {
  const d = editor.doc;
  const taken = new Set(d.children(collection).map((v) => d.get(v, 'name').split('/')[0]!));
  let name = base;
  for (let i = 2; taken.has(name) || d.children(collection).some((v) => d.get(v, 'name') === name); i++) name = `${base} ${i}`;
  return name;
}

/** Shades 50…900 of the layer's colour → variables «Палитра / Синий/50…900»; the layer gets bound to its own shade. */
export function createShades(editor: Editor, id: NodeId): { group: string; count: number } | null {
  const one = singleColor(editor, id);
  if (!one) return null;
  const list = shades(one.color);
  let group = '';
  editor.commit(tr('Палитра из цвета'), () => {
    const collection = paletteCollection(editor, tr('Палитра'));
    group = freeGroup(editor, collection, hueName(one.color));
    let source: NodeId | null = null;
    for (const s of list) {
      const v = editor.variables.createVariable(collection, 'COLOR', `${group}/${s.stop}`, s.color);
      if (s.source) source = v;
    }
    if (source && !editor.isInstanceLayer(id)) editor.variables.bind(`fills/${one.index}`, source, [id]);
  });
  return { group, count: list.length };
}

/** Pixels of a picture, scaled down to at most `side` px (the browser decodes it). */
async function pixelsOf(editor: Editor, hash: string, side = 72): Promise<Uint8ClampedArray | null> {
  const blob = editor.doc.store.blobs.get(hash);
  if (!blob || typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(new Blob([base64ToBytes(blob.data) as BlobPart], { type: blob.mime }));
    const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * k));
    const h = Math.max(1, Math.round(bitmap.height * k));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
}

/** The main colours of the selected picture → a new collection «Цвета «…»». */
export async function createImagePalette(editor: Editor, id: NodeId): Promise<{ collection: string; count: number } | null> {
  const [hash] = imageHashes(editor, [id]);
  if (!hash) return null;
  const px = await pixelsOf(editor, hash);
  if (!px) return null;
  const colors = mainColors(px, 6);
  if (!colors.length) return null;
  const d = editor.doc;
  const names = new Set(d.collections().map((c) => d.get(c, 'name')));
  let name = tr('Цвета «{0}»', d.get(id, 'name'));
  for (let i = 2; names.has(name); i++) name = tr('Цвета «{0}» {1}', d.get(id, 'name'), i);
  editor.commit(tr('Палитра из картинки'), () => {
    const collection = editor.variables.createCollection(name);
    const used = new Map<string, number>();
    for (const { color } of colors) {
      const base = hueName(color);
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      editor.variables.createVariable(collection, 'COLOR', n > 1 ? `${base} ${n}` : base, color);
    }
  });
  return { collection: name, count: colors.length };
}

const DARK = /тёмн|темн|dark|night|ночн/i;

/** Collections a dark mode can be made for: colours, no dark mode yet; the one with most colours first. */
export function darkThemeCandidates(editor: Editor): NodeId[] {
  const d = editor.doc;
  return d
    .collections()
    .filter((c) => !d.get(c, 'modes').some((m) => DARK.test(m.name)))
    .map((c) => ({ c, n: d.children(c).filter((v) => d.get(v, 'varType') === 'COLOR').length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.c);
}

/** Adds mode «Тёмная» with dark colours; shows it on `show` (the selected frames). */
export function createDarkTheme(editor: Editor, collection: NodeId, show: readonly NodeId[]): number {
  const d = editor.doc;
  let changed = 0;
  editor.commit(tr('Тёмная тема'), (tx) => {
    const base = d.get(collection, 'modes')[0]!.id;
    const mode = editor.variables.addMode(collection, tr('Тёмная'));
    for (const v of d.children(collection)) {
      if (d.get(v, 'varType') !== 'COLOR') continue;
      const value = d.get(v, 'varValues')[base];
      if (!value || typeof value !== 'object' || !('r' in value)) continue;
      tx.set(v, 'varValues', { ...d.get(v, 'varValues'), [mode]: darkVariant(value) });
      changed++;
    }
    if (show.length) editor.variables.setMode(show, collection, mode);
  });
  return changed;
}
