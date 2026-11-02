// A picture of a diagram from its document alone (FEAT-090): for the history
// of versions, where a version is a document that is not open. The engine
// draws it off screen (DocPlan's export measures what is drawn, so the SVG is
// put into the page for a moment).

import type { Document } from '#core';
import { isDark } from '../theme.ts';
import { loadDiagramEngine } from './engine.ts';
import { fontFaceCss, prepareSvg, rasterizePrepared } from './export.ts';
import { diagramBackground, diagramDark, diagramFontFamily, diagramSpec, diagramText } from './model.ts';

/** Draws the diagram of `doc` fitted into the canvas (its CSS size); false — nothing to draw. */
export async function drawDiagramPreview(canvas: HTMLCanvasElement, doc: Document): Promise<boolean> {
  const engine = await loadDiagramEngine();
  const spec = diagramSpec(doc);
  const text = diagramText(spec) ?? engine.example(spec.layout, spec.direction);
  const dark = diagramDark(spec, isDark());
  const background = diagramBackground(dark);
  engine.manual.setOverrides(spec.offsets[spec.layout] ?? { nodes: {} });
  const look = engine.theme(spec.layout, spec.theme);
  const colors = spec.colors?.length && look.locked !== 'all' ? spec.colors : undefined;
  const result = engine.render({ text, layout: spec.layout, theme: look.theme, font: spec.font, direction: spec.direction, spacing: spec.spacing, dark, ...(colors ? { colors } : {}) });
  const width = canvas.clientWidth || 400;
  const height = canvas.clientHeight || 300;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!result.svg) return false;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
  holder.append(result.svg);
  document.body.append(holder);
  try {
    const p = prepareSvg(engine, result.svg, background, false, fontFaceCss(doc, diagramFontFamily(spec)));
    const fit = Math.min((width - 24) / p.w, (height - 24) / p.h, 2) * dpr;
    const drawn = await rasterizePrepared(p, fit);
    ctx.drawImage(drawn, Math.round((canvas.width - drawn.width) / 2), Math.round((canvas.height - drawn.height) / 2));
    return true;
  } finally {
    holder.remove();
  }
}
