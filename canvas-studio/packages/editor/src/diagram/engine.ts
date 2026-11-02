// The diagram engine (FEAT-090): DocPlan's parsers, layouts and SVG renderers
// of 23 kinds of diagrams, built into packages/diagrams/engine.js by
// tools/diagrams-engine.mjs. It is a classic script of about a megabyte, so it
// is loaded only when a diagram is opened, once per page.

import type { DiagramOffsets } from '#core';

export interface DiagramDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 1-based line of the text, or none. */
  line: number | null;
  code?: string;
  /** An example of what is meant. */
  hint?: string;
}

export interface DiagramRender {
  svg?: SVGSVGElement;
  width?: number;
  height?: number;
  diagnostics?: DiagramDiagnostic[];
  /** Nothing to draw yet: what to write. */
  emptyMessage?: string;
  errorMessage?: string;
  /** The hierarchy's direction as drawn (the text may set it: «направление: вертикаль»). */
  direction: 'lr' | 'tb';
}

export interface DiagramRenderOptions {
  text: string;
  layout: string;
  theme: string;
  font: string;
  direction: 'lr' | 'tb';
  spacing: Record<string, number>;
  dark: boolean;
  /** Colours of one's own in place of the palette (for the kinds that take a palette). */
  colors?: string[];
}

export interface DiagramEngine {
  layouts: string[];
  labels: Record<string, string>;
  themes: string[];
  palettes: Record<string, string[]>;
  fonts: Record<string, string>;
  family(layout: string): string;
  /** The palette a layout is drawn with: perspective and reversibility have their own; some cannot be grey. */
  theme(layout: string, preferred: string): { theme: string; locked: 'all' | 'mono' | null };
  render(opts: DiagramRenderOptions): DiagramRender;
  highlight(text: string, layout: string): string;
  example(layout: string, direction?: 'lr' | 'tb'): string;
  help(layout: string): { title: string; html: string };
  blocks(diagnostics: DiagramDiagnostic[]): boolean;
  /** Removes a renderer's own background rect, so the diagram lies straight on the canvas. */
  stripBackground(svg: SVGSVGElement): void;
  /** DocPlan's preparation of the picture for a file. */
  exportSvg(svg: SVGSVGElement, opts: { background: string; transparent: boolean }): { svgString: string; w: number; h: number };
  spacing: {
    layouts: string[];
    presets: Record<string, number>;
    min(layout: string): number;
    max: number;
    defaults(): Record<string, number>;
    clamp(v: number): number;
  };
  manual: {
    supports(layout: string): boolean;
    enabled(): boolean;
    setEnabled(on: boolean): void;
    overrides(): DiagramOffsets;
    setOverrides(o: DiagramOffsets | null): void;
    clear(): void;
    bind(svg: SVGSVGElement): void;
  };
}

let loading: Promise<DiagramEngine> | null = null;

/** The engine, loading it on first use. */
export function loadDiagramEngine(): Promise<DiagramEngine> {
  loading ??= new Promise<DiagramEngine>((resolve, reject) => {
    const ready = (window as unknown as { SimmetrikaDiagrams?: DiagramEngine }).SimmetrikaDiagrams;
    if (ready) {
      resolve(ready);
      return;
    }
    const script = document.createElement('script');
    script.src = new URL('../../../diagrams/engine.js', import.meta.url).href;
    script.async = true;
    script.onload = () => {
      const engine = (window as unknown as { SimmetrikaDiagrams?: DiagramEngine }).SimmetrikaDiagrams;
      if (engine) resolve(engine);
      else reject(new Error('diagram engine did not start'));
    };
    script.onerror = () => reject(new Error('diagram engine not loaded'));
    document.head.append(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}
