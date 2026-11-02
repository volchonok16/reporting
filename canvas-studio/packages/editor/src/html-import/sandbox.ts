// Renders an HTML page for import in an isolated frame and asks it for its
// layers. The frame is /html-sandbox with sandbox="allow-scripts": an opaque
// origin, so the page's own scripts run (many pages are built by them) but
// cannot reach the editor, its cookies or its storage. The same frame is the
// live preview: what is on screen when "Import" is pressed is what is taken.

import { tr } from '#core';
import type { H2DImage, H2DNode } from './build.ts';
import { H2D_CHILD } from './runtime.ts';

const RUNTIME = `<script data-h2d>(${H2D_CHILD.toString()})();<\/script><style data-h2d>html{scrollbar-width:none!important}::-webkit-scrollbar{width:0!important;height:0!important}</style>`;

function injectRuntime(html: string): string {
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + RUNTIME + html.slice(m.index + m[0].length);
  return RUNTIME + html;
}

export interface CaptureOptions {
  delay: number;
  scroll: boolean;
  simplify: boolean;
  expand: boolean;
  autoLayout: boolean;
  spacers: boolean;
  name: string;
}

export interface CaptureResult {
  tree: H2DNode;
  images: H2DImage[];
  stats: { nodes: number; images: number };
}

type Message = { h2d?: boolean; kind?: string; text?: string; message?: string; rect?: SlideRect | null } & Partial<CaptureResult>;

/** Where the page's block drawn as a slide is, in page pixels. */
export interface SlideRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Waits for a message from the frame matching `pred`, or fails after `ms`. */
function waitFor(frame: HTMLIFrameElement, pred: (d: Message) => boolean, ms: number, onStatus?: (text: string) => void): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeEventListener('message', on);
      reject(new Error(tr('Страница слишком долго обрабатывается')));
    }, ms);
    const on = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data as Message;
      if (!d || !d.h2d) return;
      if (d.kind === 'status' && d.text) onStatus?.(d.text);
      if (d.kind === 'error') {
        clearTimeout(timer);
        removeEventListener('message', on);
        reject(new Error(d.message ?? tr('Ошибка разбора страницы')));
        return;
      }
      if (pred(d)) {
        clearTimeout(timer);
        removeEventListener('message', on);
        resolve(d);
      }
    };
    addEventListener('message', on);
  });
}

/** Creates the frame at `width × height` CSS pixels inside `host` and renders `html` in it. */
export async function renderPage(host: HTMLElement, html: string, width: number, height: number): Promise<HTMLIFrameElement> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-forms');
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('title', tr('Превью страницы'));
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  const ready = waitFor(frame, (d) => d.kind === 'sandbox', 8000);
  // The version: change it when the sandbox page (static.ts) changes — browsers keep it for a year.
  frame.src = '/html-sandbox?v=2';
  host.replaceChildren(frame);
  await ready;
  const installed = waitFor(frame, (d) => d.kind === 'installed', 20000);
  frame.contentWindow!.postMessage({ h2dLoad: injectRuntime(html) }, '*');
  await installed;
  return frame;
}

/** The page's block of a slide's proportions (`aspect` = width / height) — what a presentation imports; null — none (the whole page goes). */
export async function slideRect(frame: HTMLIFrameElement, aspect: number): Promise<SlideRect | null> {
  const answer = waitFor(frame, (d) => d.kind === 'slideRect', 3000);
  frame.contentWindow!.postMessage({ h2dCmd: 'slideRect', aspect }, '*');
  try {
    return (await answer).rect ?? null;
  } catch {
    return null;
  }
}

/** Asks the rendered page for its layers (it waits for fonts, pictures and scripts first). */
export async function capturePage(frame: HTMLIFrameElement, options: CaptureOptions, onStatus: (text: string) => void): Promise<CaptureResult> {
  const result = waitFor(frame, (d) => d.kind === 'result', 180_000, onStatus);
  frame.contentWindow!.postMessage({ h2dCmd: 'capture', opts: { ...options, lang: 'ru' } }, '*');
  const d = await result;
  return { tree: d.tree!, images: d.images ?? [], stats: d.stats ?? { nodes: 0, images: 0 } };
}
