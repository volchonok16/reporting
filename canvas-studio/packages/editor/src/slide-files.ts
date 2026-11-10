// A file kept on a slide. The bytes are a document blob; a click opens or downloads them.

import { base64ToBytes, tr, type Document, type SlideFile } from '#core';

const OPEN_MIME = /^(application\/pdf|text\/|image\/|video\/|audio\/)/i;

/** A first place for a new icon: the open area of the slide, stacked so they don't cover each other. */
export function fileAnchor(index: number, height: number): { x: number; y: number } {
  return { x: 72, y: Math.max(72, height - 168 - index * 48) };
}

export function openSlideFile(doc: Document, file: SlideFile, mode: 'open' | 'download'): boolean {
  const blob = doc.store.blobs.get(file.hash);
  if (!blob) return false;
  const bytes = base64ToBytes(blob.data);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mime || blob.mime || 'application/octet-stream' }));
  const canShow = mode === 'open' && OPEN_MIME.test(file.mime || blob.mime);
  if (canShow) window.open(url, '_blank', 'noopener');
  else {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name || tr('Файл');
    link.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}
