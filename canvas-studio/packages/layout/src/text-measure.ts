// Text measurement is platform-specific (the browser measures with the real font),
// so layout receives it through this interface. Tests use the approximate measurer.

import type { Document, FontVariantCaps, LetterSpacing, LineHeight, ListType, NodeId, Paint, TextCase, TextDecoration, TextRun, TextWrap, TextDirection } from '#core';
import { BREAKS_ANYWHERE, cjkScriptOf, layoutRichText, type DecorationLook, type RichLayout, type RunFont, type TextMeasureApi } from './rich-text.ts';

export interface TextStyle {
  characters: string;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  lineHeight: LineHeight;
  letterSpacing: LetterSpacing;
  paragraphSpacing: number;
  textCase: TextCase;
  paragraphIndent?: number;
  listType?: ListType;
  listLevels?: readonly number[];
  listSpacing?: number | null;
  maxLines?: number;
  /** Parts with their own style (rich text). */
  runs?: readonly TextRun[];
  fills?: Paint[];
  textDecoration?: TextDecoration;
  fontVariantCaps?: FontVariantCaps;
  kerning?: boolean;
  fontFeatures?: Record<string, boolean>;
  fontVariations?: Record<string, number>;
  leadingTrim?: 'NONE' | 'CAP_HEIGHT';
  hangingPunctuation?: boolean;
  hangingList?: boolean;
  textWrap?: TextWrap;
  textDirection?: TextDirection;
}

/** '"tnum" 1, "liga" 0' from { tnum: true, liga: false } (sorted, so equal settings give equal strings). */
export function featureString(f: Record<string, boolean> | undefined): string {
  return f ? Object.keys(f).sort().map((k) => `"${k}" ${f[k] ? 1 : 0}`).join(', ') : '';
}

export function variationString(v: Record<string, number> | undefined): string {
  return v ? Object.keys(v).sort().map((k) => `"${k}" ${v[k]}`).join(', ') : '';
}

export interface TextLine {
  text: string;
  width: number;
  /** Offset of the line from the left edge (list indent, paragraph indent). */
  x?: number;
  /** Top of the line from the top of the text box. */
  y?: number;
  /** List marker drawn before the first line of a paragraph ("•", "3."). */
  marker?: string;
  /** Left edge of the marker. */
  markerX?: number;
  /** Width available to this line (for centre and right alignment). */
  available?: number | null;
}

/** How a text layer draws its underlines and strikethroughs. */
export function decorationLookOf(d: Document, id: NodeId): DecorationLook {
  return { style: d.get(id, 'decorationStyle'), thickness: d.get(id, 'decorationThickness'), offset: d.get(id, 'underlineOffset') };
}

/** Text style of a TEXT node as stored in the document. */
export function textStyleOf(d: Document, id: NodeId): TextStyle {
  return {
    characters: d.get(id, 'characters'),
    fontFamily: d.get(id, 'fontFamily'),
    fontWeight: d.get(id, 'fontWeight'),
    italic: d.get(id, 'italic'),
    fontSize: d.get(id, 'fontSize'),
    lineHeight: d.get(id, 'lineHeight'),
    letterSpacing: d.get(id, 'letterSpacing'),
    paragraphSpacing: d.get(id, 'paragraphSpacing'),
    textCase: d.get(id, 'textCase'),
    paragraphIndent: d.get(id, 'paragraphIndent'),
    listType: d.get(id, 'listType'),
    listLevels: d.get(id, 'listLevels'),
    listSpacing: d.get(id, 'listSpacing'),
    maxLines: d.get(id, 'maxLines'),
    runs: d.get(id, 'textRuns'),
    fills: d.get(id, 'fills'),
    textDecoration: d.get(id, 'textDecoration'),
    fontVariantCaps: d.get(id, 'fontVariantCaps'),
    kerning: d.get(id, 'kerning'),
    fontFeatures: d.get(id, 'fontFeatures'),
    fontVariations: d.get(id, 'fontVariations'),
    leadingTrim: d.get(id, 'leadingTrim'),
    hangingPunctuation: d.get(id, 'hangingPunctuation'),
    hangingList: d.get(id, 'hangingList'),
    textWrap: d.get(id, 'textWrap'),
    textDirection: d.get(id, 'textDirection'),
  };
}

/** Lays out a text style with a measuring API: the one place where text becomes lines. */
export function measureWith(api: TextMeasureApi, style: TextStyle, maxWidth: number | null): TextMetrics {
  const layout = layoutRichText(
    {
      characters: style.characters,
      base: {
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
        italic: style.italic,
        fontSize: style.fontSize,
        letterSpacing: style.letterSpacing,
        caps: style.fontVariantCaps ?? 'NORMAL',
        kerning: style.kerning ?? true,
        features: featureString(style.fontFeatures) || undefined,
        variations: variationString(style.fontVariations) || undefined,
        fills: style.fills ?? null,
        textDecoration: style.textDecoration ?? 'NONE',
        baseline: 'NORMAL',
        cjk: cjkScriptOf(style.characters),
      },
      runs: style.runs ?? [],
      lineHeight: style.lineHeight,
      paragraphSpacing: style.paragraphSpacing,
      paragraphIndent: style.paragraphIndent ?? 0,
      listType: style.listType ?? 'NONE',
      listLevels: style.listLevels,
      listSpacing: style.listSpacing ?? undefined,
      maxLines: style.maxLines ?? 0,
      textCase: style.textCase,
      hangingPunctuation: style.hangingPunctuation ?? false,
      hangingList: style.hangingList ?? false,
      textWrap: style.textWrap ?? 'AUTO',
      textDirection: style.textDirection ?? 'AUTO',
    },
    maxWidth,
    api,
  );
  // Vertical trim: from the first line's capitals to the last line's baseline (no room above or below the letters).
  if (style.leadingTrim === 'CAP_HEIGHT' && layout.lines.length > 0) {
    const first = layout.lines[0]!;
    const last = layout.lines[layout.lines.length - 1]!;
    const font = first.fragments[0]?.font ?? { fontFamily: style.fontFamily, fontWeight: style.fontWeight, italic: style.italic, fontSize: style.fontSize, letterSpacing: style.letterSpacing };
    const cap = api.capHeight?.(font) ?? font.fontSize * 0.7;
    const top = Math.max(0, first.y + first.baseline - cap);
    const bottom = Math.max(0, last.height - last.baseline);
    for (const l of layout.lines) l.y -= top;
    layout.height = Math.max(0, layout.height - top - bottom);
  }
  const lines: TextLine[] = layout.lines.map((l) => ({
    text: l.fragments.map((f) => f.text).join(''),
    width: l.width,
    x: l.x,
    y: l.y,
    marker: l.marker,
    markerX: l.markerX,
    available: l.available,
  }));
  return { width: layout.width, height: layout.height, lines, lineHeightPx: lineHeightPx(style), layout };
}

/**
 * Places text into lines (FEAT-018): wrapping, paragraph spacing and first-line
 * indent, list markers with a hanging indent, and truncation with an ellipsis
 * after `maxLines`. Shared by every measurer and by the renderer, so what is
 * measured is exactly what is drawn.
 */
export function layoutText(style: TextStyle, maxWidth: number | null, widthOf: (s: string) => number): TextMetrics {
  return measureWith({ width: (text) => widthOf(text) }, style, maxWidth);
}

export interface TextMetrics {
  /** Full rich layout (fragments, baselines) for drawing and caret placement. */
  layout: RichLayout;
  width: number;
  height: number;
  lines: TextLine[];
  lineHeightPx: number;
}

export interface TextMeasurer extends TextMeasureApi {
  /** Measures text; with `maxWidth` lines wrap at word boundaries. */
  measure(style: TextStyle, maxWidth: number | null): TextMetrics;
}

export function lineHeightPx(style: Pick<TextStyle, 'lineHeight' | 'fontSize'>): number {
  const lh = style.lineHeight;
  switch (lh.unit) {
    case 'AUTO':
      return Math.round(style.fontSize * 1.2);
    case 'PX':
      return lh.value;
    case 'PERCENT':
      return (style.fontSize * lh.value) / 100;
    case 'MULTIPLIER':
      return style.fontSize * lh.value;
  }
}

export function letterSpacingPx(style: Pick<TextStyle, 'letterSpacing' | 'fontSize'>): number {
  return style.letterSpacing.unit === 'PX' ? style.letterSpacing.value : (style.fontSize * style.letterSpacing.value) / 100;
}

export function applyTextCase(text: string, textCase: TextCase): string {
  switch (textCase) {
    case 'UPPER':
      return text.toLocaleUpperCase();
    case 'LOWER':
      return text.toLocaleLowerCase();
    case 'TITLE':
      return text.replace(/(^|\s)(\S)/g, (_m, space: string, ch: string) => space + ch.toLocaleUpperCase());
    case 'ORIGINAL':
      return text;
  }
}

/**
 * Word wrapping shared by all measurers: `widthOf` measures a run of text.
 * Paragraphs are split on "\n"; a word longer than the line sticks out of it,
 * as in CSS (it was broken letter by letter: «Корпоративная» in a narrow column
 * stood one letter per line). Chinese, Japanese and Korean break between letters.
 */
export function wrapText(text: string, maxWidth: number | null, widthOf: (s: string) => number): TextLine[] {
  const lines: TextLine[] = [];
  for (const paragraph of text.split('\n')) {
    if (maxWidth === null) {
      lines.push({ text: paragraph, width: widthOf(paragraph) });
      continue;
    }
    const push = (s: string) => {
      const done = s.trimEnd();
      lines.push({ text: done, width: widthOf(done) });
    };
    // Starts a line with `word`; a word wider than the line sticks out, CJK text is broken by characters.
    const startLine = (word: string): string => {
      if (widthOf(word) <= maxWidth || !BREAKS_ANYWHERE.test(word)) return word;
      let piece = '';
      for (const ch of word) {
        if (piece !== '' && widthOf(piece + ch) > maxWidth) {
          push(piece);
          piece = '';
        }
        piece += ch;
      }
      return piece;
    };
    let current = '';
    // Lines break at spaces, not at non-breaking ones (U+00A0, U+2007, U+202F).
    for (const token of paragraph.split(/([^\S\u00A0\u2007\u202F]+)/)) {
      if (token === '') continue;
      if (/^[^\S\u00A0\u2007\u202F]+$/.test(token)) {
        current += token;
        continue;
      }
      if (current.trim() === '') {
        current = startLine(current + token);
      } else if (widthOf(current + token) <= maxWidth) {
        current += token;
      } else {
        push(current);
        current = startLine(token);
      }
    }
    push(current);
  }
  return lines;
}

/** Deterministic measurer for tests and server-side layout: every glyph is 0.5em wide. */
export class ApproximateTextMeasurer implements TextMeasurer {
  width(text: string, font: RunFont): number {
    const n = [...text].length;
    const spacing = letterSpacingPx(font);
    return n * font.fontSize * (font.fontWeight >= 600 ? 0.55 : 0.5) + Math.max(0, n - 1) * spacing;
  }

  measure(style: TextStyle, maxWidth: number | null): TextMetrics {
    return measureWith(this, style, maxWidth);
  }
}
