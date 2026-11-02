// Text measurement with the browser's real font engine (Canvas 2D measureText).

import { tr } from '#core';
import { letterSpacingPx, measureWith, type RunFont, type TextMeasurer, type TextMetrics, type TextStyle } from '#layout';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Canvas text takes no OpenType features or variation axes: a font with them is
 * registered under its own name (editor/font-features.ts), and this resolver
 * gives that name for a font that asks for them (null — not ready, the plain family).
 */
let aliasOf: ((font: RunFont) => string | null) | null = null;

export function setFontAliasResolver(fn: ((font: RunFont) => string | null) | null): void {
  aliasOf = fn;
}

/** The CJK fallbacks by script, the text's own first (Han differs between the three). */
const CJK_FAMILIES: Record<NonNullable<RunFont['cjk']>, string> = {
  SC: '"Noto Sans SC", "Noto Sans JP", "Noto Sans KR"',
  JP: '"Noto Sans JP", "Noto Sans SC", "Noto Sans KR"',
  KR: '"Noto Sans KR", "Noto Sans SC", "Noto Sans JP"',
};

export function cssFont(style: Pick<RunFont, 'italic' | 'fontWeight' | 'fontSize' | 'fontFamily' | 'features' | 'variations' | 'cjk'>): string {
  const name = (style.features || style.variations) && aliasOf ? (aliasOf(style as RunFont) ?? style.fontFamily) : style.fontFamily;
  const family = name.includes(' ') ? `"${name}"` : name;
  // Letters the font has not: Noto Sans of the text's script first (the same on every computer), then the system's.
  const cjk = style.cjk ? `, ${CJK_FAMILIES[style.cjk]}` : '';
  return `${style.italic ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${family}${cjk}, system-ui, -apple-system, "Segoe UI", sans-serif`;
}

const CAPS: Record<string, string> = { NORMAL: 'normal', SMALL_CAPS: 'small-caps', ALL_SMALL_CAPS: 'all-small-caps' };

/** Applies a font (with kerning and small caps where the browser supports them) to a context. */
export function applyFont(ctx: Ctx2D, font: RunFont): void {
  ctx.font = cssFont(font);
  const c = ctx as unknown as { fontKerning?: string; fontVariantCaps?: string; letterSpacing?: string };
  if ('fontKerning' in ctx) c.fontKerning = font.kerning === false ? 'none' : 'normal';
  if ('fontVariantCaps' in ctx) c.fontVariantCaps = CAPS[font.caps ?? 'NORMAL'] ?? 'normal';
  if ('letterSpacing' in ctx) c.letterSpacing = '0px';
}

export class CanvasTextMeasurer implements TextMeasurer {
  private readonly ctx: Ctx2D;
  private readonly cache = new Map<string, number>();
  private readonly metricCache = new Map<string, { ascent: number; descent: number }>();
  /**
   * Whole text layouts by style and width: drawing a page (or a tile of it)
   * lays out every text in view, and texts rarely change between draws.
   */
  private readonly layouts = new Map<string, TextMetrics>();

  constructor() {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const ctx = canvas.getContext('2d') as Ctx2D | null;
    if (!ctx) throw new Error(tr('Canvas 2D недоступен'));
    this.ctx = ctx;
  }

  /** Clears cached widths (call when web fonts finish loading). */
  reset(): void {
    this.cache.clear();
    this.metricCache.clear();
    this.capCache.clear();
    this.layouts.clear();
  }

  width(text: string, font: RunFont): number {
    const spacing = letterSpacingPx(font);
    const key = `${cssFont(font)}|${font.caps}|${font.kerning}|${spacing}|${text}`;
    let w = this.cache.get(key);
    if (w === undefined) {
      applyFont(this.ctx, font);
      w = this.ctx.measureText(text).width + Math.max(0, [...text].length - 1) * spacing;
      if (this.cache.size > 50_000) this.cache.clear();
      this.cache.set(key, w);
    }
    return w;
  }

  metrics(font: RunFont): { ascent: number; descent: number } {
    const key = cssFont(font);
    let m = this.metricCache.get(key);
    if (!m) {
      applyFont(this.ctx, font);
      const t = this.ctx.measureText('Hgдй');
      const ascent = t.fontBoundingBoxAscent ?? font.fontSize * 0.8;
      const descent = t.fontBoundingBoxDescent ?? font.fontSize * 0.2;
      m = Number.isFinite(ascent) && ascent > 0 ? { ascent, descent } : { ascent: font.fontSize * 0.8, descent: font.fontSize * 0.2 };
      this.metricCache.set(key, m);
    }
    return m;
  }

  private readonly capCache = new Map<string, number>();

  capHeight(font: RunFont): number {
    const key = cssFont(font);
    let c = this.capCache.get(key);
    if (c === undefined) {
      applyFont(this.ctx, font);
      const a = this.ctx.measureText('H').actualBoundingBoxAscent;
      c = Number.isFinite(a) && a > 0 ? a : font.fontSize * 0.7;
      this.capCache.set(key, c);
    }
    return c;
  }

  measure(style: TextStyle, maxWidth: number | null): TextMetrics {
    const key = `${maxWidth}|${JSON.stringify(style)}`;
    let m = this.layouts.get(key);
    if (!m) {
      m = measureWith(this, style, maxWidth);
      if (this.layouts.size > 20_000) this.layouts.clear();
      this.layouts.set(key, m);
    }
    return m;
  }
}
