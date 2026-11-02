// Link cards on a board (FEAT-160, as in FigJam): a link pasted on a board, or
// given to the «Ссылка» button, becomes a card with the page's picture, title,
// description and address. The server reads the page (browsers cannot read
// other sites); without it — offline, or a board kept in this browser — the
// card has the address alone. The card is an ordinary frame with auto layout,
// so it copies into a design as it is.

import { hexToColor, safeLink, solid, tr, type Color, type NodeId } from '#core';
import type { Point } from '#geometry';
import { placeFor } from './board.ts';
import type { Editor } from './editor.ts';

export interface LinkPreviewData {
  url: string;
  title: string;
  description: string;
  site: string;
  image: { mime: string; data: string } | null;
}

export const LINK_CARD_WIDTH = 400;

const color = (hex: string): Color => hexToColor(hex) ?? { r: 1, g: 1, b: 1, a: 1 };

/** The link in a pasted text: one line, http(s) or www. Null — the text is not a link. */
export function linkOfText(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t) || t.length > 2048) return null;
  const withScheme = /^www\./i.test(t) ? `https://${t}` : t;
  if (!/^https?:\/\//i.test(withScheme)) return null;
  try {
    const url = new URL(withScheme);
    return url.hostname.includes('.') ? (safeLink(url.href) ?? null) : null;
  } catch {
    return null;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Asks our server for the page's card; null when there is no server or the page did not open. */
export async function fetchLinkPreview(url: string, timeoutMs = 9000): Promise<LinkPreviewData | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { headers: { 'X-CS': '1' }, signal: abort.signal });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as LinkPreviewData;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const base64ToBytes = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

/** The picture's pixel size; null when the browser cannot show it. */
async function pictureSize(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

/** Puts a card with its centre at a point (inside a section under it) and selects it. */
export async function createLinkCard(editor: Editor, center: Point, url: string, preview: LinkPreviewData | null): Promise<NodeId> {
  const host = hostOf(url);
  const bytes = preview?.image ? base64ToBytes(preview.image.data) : null;
  const size = bytes && preview?.image ? await pictureSize(bytes, preview.image.mime) : null;
  // Without a preview the card still reads as one: the site large, the whole address under it.
  const title = preview?.title || host;
  const description = preview ? preview.description : url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
  const { parent, local } = placeFor(editor, center);
  const pictureHeight = size ? Math.round(Math.min(260, Math.max(120, (LINK_CARD_WIDTH * size.height) / size.width))) : 0;
  const at = local({ x: center.x - LINK_CARD_WIDTH / 2, y: center.y - (pictureHeight + 110) / 2 });
  let made: NodeId[] = [];
  return editor.commit(tr('Ссылка'), (tx) => {
    const card = tx.create('FRAME', parent, {
      name: title,
      x: Math.round(at.x),
      y: Math.round(at.y),
      width: LINK_CARD_WIDTH,
      height: pictureHeight + 110,
      cornerRadius: 12,
      clipsContent: true,
      fills: [solid(color('#FFFFFF'))],
      strokes: [solid(color('#E3E3E3'))],
      strokeWeight: 1,
      strokeAlign: 'INSIDE',
      effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 2 }, radius: 8, spread: 0, visible: true }],
      layoutMode: 'VERTICAL',
      sizingH: { mode: 'FIXED' },
      sizingV: { mode: 'HUG' },
      board: { kind: 'LINK', url },
    });
    if (bytes && size && preview?.image) {
      tx.create('RECTANGLE', card, {
        name: tr('Картинка'),
        width: LINK_CARD_WIDTH,
        height: pictureHeight,
        sizingH: { mode: 'FILL' },
        fills: [{ type: 'IMAGE', imageHash: tx.addBlob(bytes, preview.image.mime), scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }],
      });
    }
    const body = tx.create('FRAME', card, { name: tr('Текст'), fills: [], layoutMode: 'VERTICAL', itemSpacing: 6, paddingTop: 16, paddingBottom: 18, paddingLeft: 20, paddingRight: 20, sizingH: { mode: 'FILL' }, sizingV: { mode: 'HUG' }, width: LINK_CARD_WIDTH, height: 100 });
    const text = (name: string, characters: string, fontSize: number, fill: string, extra: Record<string, unknown> = {}) =>
      tx.create('TEXT', body, { name, characters, fontSize, fills: [solid(color(fill))], textAutoResize: 'HEIGHT', sizingH: { mode: 'FILL' }, width: LINK_CARD_WIDTH - 40, ...extra });
    text(tr('Заголовок'), title, 18, '#1E1E1E', { fontWeight: 600, maxLines: 2, lineHeight: { unit: 'PERCENT', value: 125 } });
    if (description && description !== title) text(tr('Описание'), description, 14, '#5C5C5C', { maxLines: 3, lineHeight: { unit: 'PERCENT', value: 140 } });
    if (preview) text(tr('Адрес'), preview.site && preview.site !== host ? `${preview.site} · ${host}` : host, 13, '#4F5BD5', { maxLines: 1 });
    made = [card];
    return card;
  }, () => made);
}

/** The link a card points to, if the layer is a card. */
export function linkOfCard(editor: Editor, id: NodeId): string | null {
  const role = editor.doc.get(id, 'board');
  return role?.kind === 'LINK' ? (safeLink(role.url) ?? null) : null;
}

/** Pastes or inserts a link: reads the page, then puts the card at the middle of the screen. */
export async function insertLink(editor: Editor, url: string, toast: (message: string) => void): Promise<void> {
  const { width, height } = editor.screenSize;
  const center = editor.viewport.screenToWorld({ x: width / 2, y: height / 2 });
  const slow = setTimeout(() => toast(tr('Загружаю превью ссылки…')), 600);
  const preview = await fetchLinkPreview(url);
  clearTimeout(slow);
  if (editor.doc.readOnly) return;
  await createLinkCard(editor, center, url, preview);
  if (!preview) toast(tr('Превью не загрузилось — на карточке только адрес. Двойной щелчок откроет страницу.'));
}
