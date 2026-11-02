// Rich text (stage "Text for real"): parts of one text with their own font,
// weight, size, colour, decoration, letter spacing and super/subscript.
//
// The node's own properties are the base style; `textRuns` override them for
// character ranges. Everything here is pure: the same layout is used to size
// the node, to draw it, and to place the caret while editing.

import type { FontVariantCaps, LetterSpacing, LineHeight, ListType, Paint, TextBaseline, TextCase, TextDecoration, TextRun, TextRunStyle, TextWrap, DecorationStyle, TextDirection } from '#core';

/** Fully resolved character style. */
export interface RunFont {
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  letterSpacing: LetterSpacing;
  caps?: FontVariantCaps;
  kerning?: boolean;
  /** OpenType features and variation axes, as CSS writes them ('"tnum" 1, "ss01" 1'; '"opsz" 20'); empty — none. */
  features?: string;
  variations?: string;
  /** Chinese, Japanese or Korean text inside: its letters fall back to Noto Sans of that script, as in Figma. */
  cjk?: CjkScript;
}

export type CjkScript = 'SC' | 'JP' | 'KR';

/** Which CJK script a text is in: kana — Japanese, hangul — Korean, only Han — Chinese; undefined — none. */
export function cjkScriptOf(text: string): CjkScript | undefined {
  if (/[\u3040-\u30FF\u31F0-\u31FF]/u.test(text)) return 'JP';
  if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u.test(text)) return 'KR';
  if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(text)) return 'SC';
  return undefined;
}

export interface ResolvedStyle extends RunFont {
  fills: Paint[] | null;
  textDecoration: TextDecoration;
  baseline: TextBaseline;
  /** Hyperlink (only in runs: a text node has no link of its own). */
  link?: string;
}

export const RUN_KEYS = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'fills', 'textDecoration', 'letterSpacing', 'baseline', 'link'] as const;
export type RunKey = (typeof RUN_KEYS)[number];

export const MIXED_RUN = Symbol('mixed');

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function styleEquals(a: TextRunStyle, b: TextRunStyle): boolean {
  return RUN_KEYS.every((k) => same(a[k], b[k]));
}

function clean(style: TextRunStyle, base?: Partial<ResolvedStyle>): TextRunStyle {
  const out: TextRunStyle = {};
  for (const k of RUN_KEYS) {
    const v = style[k];
    if (v === undefined) continue;
    if (base && same(base[k as keyof ResolvedStyle], v)) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Sorted, clipped, without empty runs or empty styles, adjacent equal runs merged. */
export function normalizeRuns(runs: readonly TextRun[], length: number, base?: Partial<ResolvedStyle>): TextRun[] {
  const sorted = runs
    .map((r) => ({ start: Math.max(0, Math.min(length, r.start)), end: Math.max(0, Math.min(length, r.end)), style: clean(r.style, base) }))
    .filter((r) => r.end > r.start && Object.keys(r.style).length > 0)
    .sort((a, b) => a.start - b.start);
  const out: TextRun[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) r.start = last.end;
    if (r.end <= r.start) continue;
    if (last && last.end === r.start && styleEquals(last.style, r.style)) last.end = r.end;
    else out.push(r);
  }
  return out;
}

/** Override of the character at `index` (empty when it uses the base style). */
export function runStyleAt(runs: readonly TextRun[], index: number): TextRunStyle {
  for (const r of runs) if (r.start <= index && index < r.end) return r.style;
  return {};
}

/**
 * Applies `patch` to characters [start, end). A key set to `undefined` removes
 * the override (the base style shows through).
 */
export function applyRunStyle(runs: readonly TextRun[], length: number, start: number, end: number, patch: TextRunStyle, base?: Partial<ResolvedStyle>): TextRun[] {
  const a = Math.max(0, Math.min(length, start));
  const b = Math.max(a, Math.min(length, end));
  if (a === b) return normalizeRuns(runs, length, base);
  // Break the text at every run edge and at the range edges, then restyle the pieces inside.
  const cuts = new Set<number>([0, length, a, b]);
  for (const r of runs) {
    cuts.add(Math.max(0, Math.min(length, r.start)));
    cuts.add(Math.max(0, Math.min(length, r.end)));
  }
  const points = [...cuts].sort((x, y) => x - y);
  const out: TextRun[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const s = points[i]!;
    const e = points[i + 1]!;
    let style: TextRunStyle = { ...runStyleAt(runs, s) };
    if (s >= a && e <= b) {
      style = { ...style };
      for (const k of Object.keys(patch) as RunKey[]) {
        const v = patch[k];
        if (v === undefined) delete style[k];
        else (style as Record<string, unknown>)[k] = v;
      }
    }
    out.push({ start: s, end: e, style });
  }
  return normalizeRuns(out, length, base);
}

/**
 * Keeps runs in step with an edit: `removed` characters at `at` were replaced by
 * `inserted` characters. Inserted text takes the style of the character before
 * it (or of the first replaced character), or `insertStyle` when given.
 */
export function editRuns(runs: readonly TextRun[], at: number, removed: number, inserted: number, newLength: number, insertStyle?: TextRunStyle | null): TextRun[] {
  const delta = inserted - removed;
  const removedEnd = at + removed;
  const inherited = insertStyle ?? (at > 0 ? runStyleAt(runs, at - 1) : runStyleAt(runs, at));
  const out: TextRun[] = [];
  for (const r of runs) {
    // Part before the edit.
    if (r.start < at) out.push({ start: r.start, end: Math.min(r.end, at), style: r.style });
    // Part after the removed range, shifted.
    if (r.end > removedEnd) out.push({ start: Math.max(r.start, removedEnd) + delta, end: r.end + delta, style: r.style });
  }
  if (inserted > 0 && Object.keys(inherited).length > 0) out.push({ start: at, end: at + inserted, style: { ...inherited } });
  return normalizeRuns(out, newLength);
}

/** Value of one style key over [start, end): the value, or MIXED_RUN when it differs. */
export function rangeValue<K extends RunKey>(runs: readonly TextRun[], base: ResolvedStyle, start: number, end: number, key: K): ResolvedStyle[K] | typeof MIXED_RUN {
  const value = (i: number) => {
    const v = runStyleAt(runs, i)[key];
    return (v === undefined ? base[key] : v) as ResolvedStyle[K];
  };
  if (end <= start) return value(Math.max(0, start - 1));
  const first = value(start);
  // Only run edges can change the value: check those.
  const points = [start, ...runs.flatMap((r) => [r.start, r.end]).filter((p) => p > start && p < end)];
  for (const p of points) if (!same(value(p), first)) return MIXED_RUN;
  return first;
}

/** Same as rangeValue over the whole text. */
export function textValue<K extends RunKey>(runs: readonly TextRun[], base: ResolvedStyle, length: number, key: K): ResolvedStyle[K] | typeof MIXED_RUN {
  return length === 0 ? base[key] : rangeValue(runs, base, 0, length, key);
}

export function resolve(base: ResolvedStyle, style: TextRunStyle): ResolvedStyle {
  return {
    ...base,
    ...(clean(style) as Partial<ResolvedStyle>),
  };
}

// ---------- Layout ----------

export interface TextMeasureApi {
  /** Width of text in one font, letter spacing included. */
  width(text: string, font: RunFont): number;
  /** Ascent and descent (px) of a font at its size. */
  metrics?(font: RunFont): { ascent: number; descent: number };
  /** Height of the capitals above the baseline (px), for vertical trim. */
  capHeight?(font: RunFont): number;
}

export interface RichStyle {
  characters: string;
  base: ResolvedStyle;
  runs: readonly TextRun[];
  lineHeight: LineHeight;
  paragraphSpacing: number;
  paragraphIndent: number;
  listType: ListType;
  maxLines: number;
  textCase: TextCase;
  hangingPunctuation?: boolean;
  hangingList?: boolean;
  /** How lines break (CSS text-wrap): AUTO — as many words as fit, BALANCE — lines of about equal length, PRETTY — no word alone on the last line, no short word at a line's end. */
  textWrap?: TextWrap;
  /** Writing direction: AUTO — by the first letter of each paragraph (Arabic, Hebrew — right to left). */
  textDirection?: TextDirection;
  /** Nesting level of each paragraph of a list (0 — the top); missing — 0. */
  listLevels?: readonly number[];
  /** Space between two items of a list, px (between other paragraphs — paragraphSpacing); undefined — paragraphSpacing. */
  listSpacing?: number;
}

export interface Fragment {
  start: number;
  end: number;
  text: string;
  /** Offset from the line's left edge. */
  x: number;
  width: number;
  style: ResolvedStyle;
  /** Font actually used (smaller for super/subscript). */
  font: RunFont;
  /** Vertical shift of the baseline, px (negative = up). */
  shift: number;
}

export interface RichLine {
  start: number;
  /** End of the line's characters (exclusive), not counting the "\n". */
  end: number;
  text: string;
  /** Left offset of the line (list and first-line indents). */
  x: number;
  y: number;
  height: number;
  /** Baseline from the top of the line. */
  baseline: number;
  /** Width without trailing spaces (for alignment). */
  width: number;
  available: number | null;
  fragments: Fragment[];
  marker?: string;
  markerX?: number;
  markerFont?: RunFont;
  /** Right to left (Arabic, Hebrew): fragments are placed from the right, each drawn with direction rtl. */
  rtl?: boolean;
  /** Hanging punctuation: the width of an opening mark at the line's start and of a closing one at its end, to stand outside the edge. */
  hangStart?: number;
  hangEnd?: number;
}

export interface RichLayout {
  width: number;
  height: number;
  lines: RichLine[];
  /** Text after case transformation (same length as `characters`). */
  text: string;
}

export const SUPER_SCALE = 0.65;

/** Letters written right to left: Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms. */
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const LTR_LETTER = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/u;

/** The paragraph reads right to left: its first letter with a direction is Hebrew or Arabic. */
export function firstStrongIsRtl(text: string): boolean {
  for (const ch of text) {
    if (RTL_LETTER.test(ch)) return true;
    if (LTR_LETTER.test(ch)) return false;
  }
  return false;
}

/** Deepest list level. */
export const MAX_LIST_LEVEL = 5;

export function listLevelOf(levels: readonly number[] | undefined, paragraph: number): number {
  const v = levels?.[paragraph] ?? 0;
  return Number.isFinite(v) ? Math.max(0, Math.min(MAX_LIST_LEVEL, Math.round(v))) : 0;
}

/** A list item's marker by level, as in Figma and the browsers: • ◦ ▪ for bullets; 1. a. i. for numbers. */
export function listMarker(type: ListType, level: number, n: number): string {
  if (type === 'BULLET') return ['•', '◦', '▪'][level % 3]!;
  const kind = level % 3;
  if (kind === 0) return `${n}.`;
  if (kind === 1) {
    let s = '';
    for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(97 + ((v - 1) % 26)) + s;
    return `${s}.`;
  }
  const romans: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  let v = n;
  for (const [value, letters] of romans) for (; v >= value; v -= value) s += letters;
  return `${s}.`;
}

/**
 * Paragraph levels after an edit of the text: [at, at + removed) of `before` became
 * [at, at + inserted) of `after`. A removed line break joins two paragraphs (the first
 * keeps its level); a typed one starts a paragraph at the level of the one it splits.
 */
export function editListLevels(levels: readonly number[], before: string, after: string, at: number, removed: number, inserted: number): number[] {
  const paragraphOf = (text: string, index: number) => {
    let n = 0;
    for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
    return n;
  };
  const k = paragraphOf(before, at);
  const gone = paragraphOf(before.slice(at, at + removed), removed);
  const added = paragraphOf(after.slice(at, at + inserted), inserted);
  if (gone === 0 && added === 0) return [...levels];
  const out = [...levels];
  const own = listLevelOf(levels, k);
  out.splice(k + 1, gone, ...new Array<number>(added).fill(own));
  // Trailing zeros say nothing.
  while (out.length > 0 && !out[out.length - 1]) out.pop();
  return out.map((v) => v ?? 0);
}

/** Marks that hang outside the text's edge with hanging punctuation on: at a line's start, and at its end. */
const HANG_START = /^[«"“„‘'‚‹(\[{]/u;
const HANG_END = /[»"”’'›)\]}.,:;!?…]$/u;

function caseText(text: string, textCase: TextCase): string {
  if (textCase === 'ORIGINAL') return text;
  let out = '';
  let start = true;
  for (const ch of text) {
    let mapped = ch;
    if (textCase === 'UPPER' || (textCase === 'TITLE' && start)) mapped = ch.toLocaleUpperCase();
    else if (textCase === 'LOWER') mapped = ch.toLocaleLowerCase();
    // Keep offsets stable: a character whose case form is longer (ß → SS) stays as it is.
    out += mapped.length === ch.length ? mapped : ch;
    start = /\s/.test(ch);
  }
  return out;
}

export function lineHeightOf(lh: LineHeight, fontSize: number): number {
  switch (lh.unit) {
    case 'AUTO':
      return Math.round(fontSize * 1.2);
    case 'PX':
      return lh.value;
    case 'PERCENT':
      return (fontSize * lh.value) / 100;
    case 'MULTIPLIER':
      return fontSize * lh.value;
  }
}

function fontOf(style: ResolvedStyle): RunFont {
  const scale = style.baseline === 'NORMAL' ? 1 : SUPER_SCALE;
  return { fontFamily: style.fontFamily, fontWeight: style.fontWeight, italic: style.italic, fontSize: style.fontSize * scale, letterSpacing: style.letterSpacing, caps: style.caps, kerning: style.kerning, features: style.features, variations: style.variations, cjk: style.cjk };
}

function shiftOf(style: ResolvedStyle): number {
  return style.baseline === 'SUPER' ? -style.fontSize * 0.35 : style.baseline === 'SUB' ? style.fontSize * 0.15 : 0;
}

interface Piece {
  start: number;
  end: number;
  space: boolean;
  style: ResolvedStyle;
}

/** Letters a line may break between with no space, as CSS does: Chinese, Japanese, Korean. */
export const BREAKS_ANYWHERE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Style segments of [from, to): consecutive characters with the same resolved style. */
function pieces(text: string, from: number, to: number, runs: readonly TextRun[], base: ResolvedStyle): Piece[] {
  const out: Piece[] = [];
  const edges = new Set<number>([from, to]);
  for (const r of runs) {
    if (r.start > from && r.start < to) edges.add(r.start);
    if (r.end > from && r.end < to) edges.add(r.end);
  }
  const points = [...edges].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i++) {
    const s = points[i]!;
    const e = points[i + 1]!;
    const style = resolve(base, runStyleAt(runs, s));
    // Split further into words and spaces; a non-breaking space (U+00A0, U+2007, U+202F) is part of the word.
    const re = /[^\S\u00A0\u2007\u202F]+|[\S\u00A0\u2007\u202F]+/g;
    const chunk = text.slice(s, e);
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk))) out.push({ start: s + m.index, end: s + m.index + m[0].length, space: /^[^\S\u00A0\u2007\u202F]/.test(m[0]), style });
  }
  return out;
}

/**
 * Lays out rich text into lines: wrapping on word boundaries across style
 * changes, per-line height from the largest font, a common baseline, list
 * markers, indents, paragraph spacing and truncation with an ellipsis.
 */
export function layoutRichText(style: RichStyle, maxWidth: number | null, api: TextMeasureApi): RichLayout {
  const text = caseText(style.characters, style.textCase);
  const runs = normalizeRuns(style.runs, text.length);
  const base = style.base;
  const metrics = (f: RunFont) => api.metrics?.(f) ?? { ascent: f.fontSize * 0.8, descent: f.fontSize * 0.2 };
  const widthCache = new Map<string, number>();
  const width = (s: string, font: RunFont) => {
    const key = `${font.fontFamily}|${font.fontWeight}|${font.italic}|${font.fontSize}|${font.letterSpacing.unit}${font.letterSpacing.value}|${font.caps}|${font.features ?? ''}|${font.variations ?? ''}|${font.cjk ?? ''}|${s}`;
    let w = widthCache.get(key);
    if (w === undefined) {
      w = api.width(s, font);
      widthCache.set(key, w);
    }
    return w;
  };

  // Paragraph ranges.
  const paragraphs: [number, number][] = [];
  let ps = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      paragraphs.push([ps, i]);
      ps = i + 1;
    }
  }
  const levels = paragraphs.map((_, k) => (style.listType === 'NONE' ? 0 : listLevelOf(style.listLevels, k)));
  // Numbers count per level; an item of a shallower level starts the deeper ones over.
  const counters: number[] = [];
  const markers = paragraphs.map(([s, e], k) => {
    if (style.listType === 'NONE' || text.slice(s, e).trim() === '') return '';
    const level = levels[k]!;
    counters.length = level + 1;
    counters[level] = (counters[level] ?? 0) + 1;
    return listMarker(style.listType, level, counters[level]!);
  });
  const isItem = (k: number) => markers[k] !== '';
  const baseFont = fontOf(base);
  const markerRoom = style.listType === 'NONE' ? 0 : Math.ceil(Math.max(width('•', baseFont), ...markers.map((m) => (m ? width(m, baseFont) : 0))) + base.fontSize * 0.5);
  // Each level one step further in.
  const levelStep = Math.max(markerRoom, Math.ceil(base.fontSize * 1.5));
  // A hanging list keeps its first level's markers outside the edge: the items' text stays where text without a list would be.
  const listIndentOf = (k: number) => (style.listType === 'NONE' ? 0 : (style.hangingList ? 0 : markerRoom) + levels[k]! * levelStep);
  const indent = Math.max(0, style.paragraphIndent);
  const lines: RichLine[] = [];
  let y = 0;

  paragraphs.forEach(([pStart, pEnd], k) => {
    // Between two items of a list its own spacing, between other paragraphs theirs.
    if (k > 0) y += isItem(k) && isItem(k - 1) && style.listSpacing !== undefined ? style.listSpacing : style.paragraphSpacing;
    const listIndent = listIndentOf(k);
    const avail = maxWidth === null ? null : Math.max(1, maxWidth - listIndent);
    const rtlParagraph = style.textDirection === 'RTL' || ((style.textDirection ?? 'AUTO') === 'AUTO' && firstStrongIsRtl(text.slice(pStart, pEnd)));
    const all = pieces(text, pStart, pEnd, runs, base);
    // Lines of this paragraph as lists of [start, end) character ranges with styles.
    type Item = { start: number; end: number; style: ResolvedStyle; space: boolean };
    const itemWidth = (it: Item) => width(text.slice(it.start, it.end), fontOf(it.style));
    /** Breaks the paragraph into lines no wider than `limit` (null — one line). */
    const wrap = (limit: number | null): Item[][] => {
      const out: Item[][] = [];
      let current: Item[] = [];
      let used = 0;
      const room = () => (limit === null ? Infinity : limit - (out.length === 0 ? indent : 0));
      const flush = () => {
        out.push(current);
        current = [];
        used = 0;
      };
      // Group pieces into words (consecutive non-space pieces) and spaces.
      let i = 0;
      while (i < all.length) {
        if (all[i]!.space) {
          const p = all[i++]!;
          current.push({ ...p });
          used += itemWidth(p);
          continue;
        }
        const word: Item[] = [];
        while (i < all.length && !all[i]!.space) word.push({ ...all[i++]! });
        // «No orphans» also keeps a short word (a preposition: «в», «и», «на») with the next one, as Russian typography asks.
        while (style.textWrap === 'PRETTY' && [...text.slice(word[0]!.start, word[word.length - 1]!.end)].length <= 2 && all[i]?.space && all[i + 1] && !all[i + 1]!.space && !/\n/.test(text.slice(all[i]!.start, all[i]!.end))) {
          word.push({ ...all[i++]! });
          while (i < all.length && !all[i]!.space) word.push({ ...all[i++]! });
        }
        const wordWidth = word.reduce((n, p) => n + itemWidth(p), 0);
        if (current.some((c) => !c.space) && used + wordWidth > room()) {
          // Break before the word; spaces stay at the end of the previous line.
          flush();
        }
        if (wordWidth > room() && BREAKS_ANYWHERE.test(text.slice(word[0]!.start, word[word.length - 1]!.end))) {
          // A word longer than the line sticks out of it, as in CSS; Chinese, Japanese and Korean break between letters.
          for (const p of word) {
            let s = p.start;
            for (let c = p.start; c < p.end; c++) {
              const w = width(text.slice(s, c + 1), fontOf(p.style));
              if (c > s && used + w > room()) {
                current.push({ start: s, end: c, style: p.style, space: false });
                flush();
                s = c;
              }
            }
            const rest = { start: s, end: p.end, style: p.style, space: false };
            current.push(rest);
            used += itemWidth(rest);
          }
        } else {
          current.push(...word);
          used += wordWidth;
        }
      }
      flush();
      return out;
    };
    const words = (line: Item[]) => line.filter((it, n) => !it.space && (n === 0 || line[n - 1]!.space)).length;
    let paraLines = wrap(avail);
    if (avail !== null && paraLines.length > 1 && style.textWrap && style.textWrap !== 'AUTO') {
      // Narrower than the box, never more lines: the box (and alignment) stay, only the breaks move.
      const count = paraLines.length;
      const fits = (w: number, ok: (lines: Item[][]) => boolean) => {
        const lines = wrap(w);
        return lines.length === count && ok(lines) ? lines : null;
      };
      if (style.textWrap === 'BALANCE') {
        // The narrowest width that keeps the number of lines: they come out about equal.
        let lo = avail / count;
        let hi = avail;
        let best = paraLines;
        for (let step = 0; step < 14 && hi - lo > 0.5; step++) {
          const mid = (lo + hi) / 2;
          const lines = fits(mid, () => true);
          if (lines) {
            best = lines;
            hi = mid;
          } else lo = mid;
        }
        paraLines = best;
      } else if (words(paraLines[count - 1]!) < 2) {
        // No word alone on the last line: the widest narrower width at which it has two, the lines as many.
        const step = Math.max(1, base.fontSize * 0.25);
        for (let w = avail - step; w >= avail * 0.6; w -= step) {
          const lines = wrap(w);
          if (lines.length > count) break;
          if (words(lines[count - 1]!) >= 2) {
            paraLines = lines;
            break;
          }
        }
      }
    }

    paraLines.forEach((items, li) => {
      const lineStart = items[0]?.start ?? pStart;
      const lineEnd = items.length > 0 ? items[items.length - 1]!.end : pStart;
      // Merge items with the same style into fragments.
      const fragments: Fragment[] = [];
      let x = 0;
      for (const it of items) {
        const last = fragments[fragments.length - 1];
        if (last && last.end === it.start && last.style === it.style) {
          last.end = it.end;
          last.text = text.slice(last.start, last.end);
          last.width = width(last.text, last.font);
          x = last.x + last.width;
          continue;
        }
        const font = fontOf(it.style);
        const t = text.slice(it.start, it.end);
        const w = width(t, font);
        fragments.push({ start: it.start, end: it.end, text: t, x, width: w, style: it.style, font, shift: shiftOf(it.style) });
        x += w;
      }
      // Empty line: its height comes from the style at that position.
      const lineStyle = fragments.length > 0 ? null : resolve(base, runStyleAt(runs, Math.max(0, lineStart - 1)));
      const fonts = fragments.length > 0 ? fragments.map((f) => ({ size: f.style.fontSize, font: f.font, shift: f.shift })) : [{ size: lineStyle!.fontSize, font: fontOf(lineStyle!), shift: 0 }];
      let ascent = 0;
      let descent = 0;
      let height = 0;
      for (const f of fonts) {
        const m = metrics(f.font);
        ascent = Math.max(ascent, m.ascent - f.shift);
        descent = Math.max(descent, m.descent + f.shift);
        height = Math.max(height, lineHeightOf(style.lineHeight, f.size));
      }
      // Half-leading, as in CSS: extra line height is split above and below the glyphs.
      const baseline = (height - (ascent + descent)) / 2 + ascent;
      let trailing = 0;
      for (let f = fragments.length - 1; f >= 0; f--) {
        const frag = fragments[f]!;
        const t = frag.text;
        const trimmed = t.replace(/\s+$/, '');
        if (trimmed.length === t.length) break;
        trailing += frag.width - width(trimmed, frag.font);
        if (trimmed.length > 0) break;
      }
      const lineX = listIndent + (li === 0 ? indent : 0);
      const line: RichLine = {
        start: lineStart,
        end: lineEnd,
        text: text.slice(lineStart, lineEnd),
        x: lineX,
        y,
        height,
        baseline,
        width: Math.max(0, x - trailing),
        available: avail === null ? null : avail - (li === 0 ? indent : 0),
        fragments,
      };
      if (li === 0 && markers[k]) {
        line.marker = markers[k];
        line.markerFont = baseFont;
        line.markerX = listIndent - base.fontSize * 0.5 - width(markers[k]!, baseFont);
        if (!style.hangingList) line.markerX = Math.max(0, line.markerX);
      }
      // Right to left: the fragments mirrored inside the line (the letters inside each are put in order by the browser).
      if (rtlParagraph) {
        line.rtl = true;
        for (const f of fragments) f.x = line.width - f.x - f.width;
      }
      if (style.hangingPunctuation && fragments.length > 0) {
        const first = fragments[0]!;
        const open = HANG_START.exec(first.text);
        if (open) line.hangStart = width(open[0], first.font);
        const last = [...fragments].reverse().find((f) => f.text.trimEnd().length > 0);
        const close = last ? HANG_END.exec(last.text.trimEnd()) : null;
        if (last && close) line.hangEnd = width(close[0], last.font);
      }
      lines.push(line);
      y += height;
    });
  });

  const limit = Math.max(0, Math.floor(style.maxLines));
  if (limit > 0 && lines.length > limit) {
    lines.length = limit;
    const last = lines[limit - 1]!;
    truncate(last, text, width);
    y = last.y + last.height;
  }
  const layoutWidth = maxWidth ?? Math.ceil(Math.max(0, ...lines.map((l) => l.x + l.width)));
  return { width: layoutWidth, height: y, lines, text };
}

/** Shortens the last fragments of a line so that "…" fits. */
function truncate(line: RichLine, text: string, width: (s: string, f: RunFont) => number): void {
  const room = line.available ?? Infinity;
  const frags = line.fragments;
  const total = () => frags.reduce((n, f) => n + f.width, 0);
  const last = () => frags[frags.length - 1];
  let guard = 10_000;
  while (frags.length > 0 && guard-- > 0) {
    const f = last()!;
    const ell = width('…', f.font);
    const trimmed = f.text.replace(/\s+$/, '');
    if (trimmed !== f.text) {
      f.text = trimmed;
      f.end = f.start + trimmed.length;
      f.width = width(f.text, f.font);
    }
    if (total() + ell <= room || f.text.length === 0) {
      if (f.text.length === 0) {
        frags.pop();
        continue;
      }
      break;
    }
    f.text = [...f.text].slice(0, -1).join('');
    f.end = f.start + f.text.length;
    f.width = width(f.text, f.font);
  }
  const tail = last();
  if (tail) {
    tail.text += '…';
    tail.width = width(tail.text, tail.font);
  }
  line.width = total();
  line.end = tail ? tail.start + tail.text.length - 1 : line.start;
  line.text = text.slice(line.start, line.end) + '…';
}

// ---------- Caret ----------

/** Caret position for character offset `index`: x, top and height inside the text box. */
export function caretAt(layout: RichLayout, index: number, api: TextMeasureApi, boxWidth: number, align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'): { x: number; y: number; height: number; line: number } {
  const lines = layout.lines;
  if (lines.length === 0) return { x: 0, y: 0, height: 16, line: 0 };
  let li = lines.findIndex((l, i) => index >= l.start && (index <= l.end || (i + 1 < lines.length && index < lines[i + 1]!.start)));
  if (li < 0) li = index <= 0 ? 0 : lines.length - 1;
  // At a soft wrap the caret belongs to the next line.
  while (li + 1 < lines.length && index >= lines[li + 1]!.start && lines[li + 1]!.start === lines[li]!.end) li++;
  const line = lines[li]!;
  const offset = lineOffset(line, boxWidth, align);
  // Right to left the caret moves from the fragment's right edge leftwards.
  const along = (f: Fragment, w: number) => (line.rtl ? f.x + f.width - w : f.x + w);
  let x = line.x + offset + (line.rtl ? line.width : 0);
  for (const f of line.fragments) {
    if (index <= f.start) break;
    if (index >= f.end) x = line.x + offset + along(f, f.width);
    else {
      x = line.x + offset + along(f, api.width(layout.text.slice(f.start, index), f.font));
      break;
    }
  }
  return { x, y: line.y, height: line.height, line: li };
}

/** Horizontal offset of a line for the text alignment. */
export function lineOffset(line: RichLine, boxWidth: number, align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'): number {
  const room = line.available ?? boxWidth - line.x;
  // Hanging punctuation: the opening mark goes past the left edge, the closing one past the right.
  return align === 'CENTER' ? (room - line.width) / 2 : align === 'RIGHT' ? room - line.width + (line.hangEnd ?? 0) : line.hangStart ? -line.hangStart : 0;
}

/** Character offset nearest to a point inside the text box. */
export function indexAt(layout: RichLayout, px: number, py: number, api: TextMeasureApi, boxWidth: number, align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'): number {
  const lines = layout.lines;
  if (lines.length === 0) return 0;
  let line = lines[lines.length - 1]!;
  for (const l of lines) {
    if (py < l.y + l.height) {
      line = l;
      break;
    }
  }
  if (py < 0) line = lines[0]!;
  const x = px - line.x - lineOffset(line, boxWidth, align);
  let best = line.start;
  let bestDist = Math.abs(x);
  if (line.rtl) {
    best = line.start;
    bestDist = Math.abs(x - line.width);
  }
  for (const f of line.fragments) {
    for (let i = f.start + 1; i <= f.end; i++) {
      const w = api.width(layout.text.slice(f.start, i), f.font);
      const cx = line.rtl ? f.x + f.width - w : f.x + w;
      const dist = Math.abs(x - cx);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
  }
  return best;
}

// ---------- Underline and strikethrough ----------

export interface DecorationLook {
  style: DecorationStyle;
  /** px; null — from the font size. */
  thickness: number | null;
  /** Baseline to the underline, px; null — from the font size. */
  offset: number | null;
}

export const PLAIN_DECORATION: DecorationLook = { style: 'SOLID', thickness: null, offset: null };

/**
 * An underline or a strikethrough of `width` from `x` on a line whose baseline is `y`,
 * as one filled outline (SVG path data): a bar, dashes, dots or a wave. The canvas, SVG
 * and text outlines all draw this, so they agree.
 */
export function decorationPath(kind: 'UNDERLINE' | 'STRIKETHROUGH', x: number, y: number, width: number, fontSize: number, look: DecorationLook = PLAIN_DECORATION): string {
  if (!(width > 0)) return '';
  const t = Math.max(0.5, look.thickness ?? Math.max(1, fontSize / 16));
  const top = kind === 'UNDERLINE' ? y + (look.offset ?? fontSize * 0.12) : y - fontSize * 0.28;
  const r = (v: number) => Math.round(v * 100) / 100;
  const bar = (a: number, b: number) => `M${r(a)} ${r(top)}H${r(b)}V${r(top + t)}H${r(a)}Z`;
  switch (look.style) {
    case 'DASHED': {
      const dash = Math.max(2, t * 3);
      let d = '';
      for (let a = x; a < x + width; a += dash * 2) d += bar(a, Math.min(x + width, a + dash));
      return d;
    }
    case 'DOTTED': {
      // Round dots one thickness wide, a dot's width apart.
      const rad = t / 2;
      const cy = top + rad;
      let d = '';
      for (let cx = x + rad; cx <= x + width - rad + 0.01; cx += t * 2) d += `M${r(cx - rad)} ${r(cy)}A${r(rad)} ${r(rad)} 0 1 0 ${r(cx + rad)} ${r(cy)}A${r(rad)} ${r(rad)} 0 1 0 ${r(cx - rad)} ${r(cy)}Z`;
      return d;
    }
    case 'WAVY': {
      // A sine ribbon `t` thick: the upper edge forward, the lower edge back.
      const amp = t * 1.2 + fontSize * 0.03;
      const wave = Math.max(4, t * 4 + fontSize * 0.2);
      const mid = top + t / 2 + (kind === 'UNDERLINE' ? amp / 2 : 0);
      const steps = Math.max(2, Math.ceil(width / (wave / 8)));
      const at = (i: number) => {
        const px = x + (width * i) / steps;
        return { px, py: mid + amp * Math.sin(((px - x) / wave) * Math.PI * 2) };
      };
      let upper = '';
      let lower = '';
      for (let i = 0; i <= steps; i++) {
        const { px, py } = at(i);
        upper += `${i === 0 ? 'M' : 'L'}${r(px)} ${r(py - t / 2)}`;
      }
      for (let i = steps; i >= 0; i--) {
        const { px, py } = at(i);
        lower += `L${r(px)} ${r(py + t / 2)}`;
      }
      return `${upper}${lower}Z`;
    }
    default:
      return bar(x, x + width);
  }
}
