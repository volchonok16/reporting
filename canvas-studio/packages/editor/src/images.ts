// Reading image files picked, dropped or pasted by the user.

import { tr } from '#core';
export interface ImageInput {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  name: string;
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif', 'image/bmp', 'video/mp4', 'video/webm', 'video/quicktime'];

/** Largest video kept in a file: it travels inside the document (as in Figma, videos are fills). */
export const MAX_VIDEO_BYTES = 15 * 1024 * 1024;

/** Pictures and videos (Figma treats both as fills). */
export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

/** A video's frame size, read from its metadata. */
function videoSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (ok: boolean) => {
      URL.revokeObjectURL(url);
      if (ok && video.videoWidth > 0) resolve({ width: video.videoWidth, height: video.videoHeight });
      else reject(new Error(tr('Видео в этом формате браузер не открывает: попробуйте MP4 или WebM')));
    };
    video.preload = 'metadata';
    video.muted = true;
    video.addEventListener('loadedmetadata', () => done(true), { once: true });
    video.addEventListener('error', () => done(false), { once: true });
    video.src = url;
  });
}

/** Reads a file and its pixel size; rejects files the browser cannot decode (and videos over the limit). */
export async function readImageFile(file: File): Promise<ImageInput> {
  const name = file.name.replace(/\.[a-z0-9]+$/i, '') || tr('Изображение');
  if (file.type.startsWith('video/')) {
    if (file.size > MAX_VIDEO_BYTES) throw new Error(tr('Видео больше 15 МБ: сожмите его или обрежьте'));
    const size = await videoSize(file);
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type, ...size, name };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const bitmap = await createImageBitmap(file);
  const result = { bytes, mime: file.type || 'image/png', width: bitmap.width, height: bitmap.height, name: file.name.replace(/\.[a-z0-9]+$/i, '') || tr('Изображение') };
  bitmap.close();
  return result;
}

/** Opens the system file dialog. Resolves with an empty list when cancelled. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    // In the page while the dialog is open: a detached input can be dropped by the
    // browser (Safari) and its "change" never comes — the choice then did nothing.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.hidden = true;
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

/** Opens the system file dialog for images. Resolves with an empty list when cancelled. */
export function pickImageFiles(multiple = false): Promise<File[]> {
  return pickFiles(IMAGE_TYPES.join(','), multiple);
}

/** Side of the pieces a big picture is cut into (as Insert Big Image: what any GPU still takes in one go). */
export const BIG_IMAGE_TILE = 4096;

/** Most a big picture may add to a file: documents are saved whole, and the server takes up to 64 MB. */
const MAX_BIG_IMAGE_BYTES = 44 * 1024 * 1024;

/** How far a piece of a big picture reaches over the next one, in pixels. */
const SEAM_OVERLAP = 2;

/** Whether the picture is solid along every seam between its pieces (where they overlap). */
function seamsOpaque(image: ImageBitmap): boolean {
  const { width, height } = image;
  const strip = (sx: number, sy: number, w: number, h: number) => {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(image, sx, sy, w, h, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return false;
    return true;
  };
  for (let x = BIG_IMAGE_TILE; x < width; x += BIG_IMAGE_TILE) if (!strip(x, 0, Math.min(SEAM_OVERLAP, width - x), height)) return false;
  for (let y = BIG_IMAGE_TILE; y < height; y += BIG_IMAGE_TILE) if (!strip(0, y, width, Math.min(SEAM_OVERLAP, height - y))) return false;
  return true;
}

export interface ImageTile extends ImageInput {
  /** Where the piece sits in the whole picture, in pixels. */
  x: number;
  y: number;
}

/**
 * A picture at its own size, cut into pieces of at most BIG_IMAGE_TILE pixels.
 * One that fits in a piece keeps its own bytes; the pieces of a JPEG are JPEGs at
 * high quality, all others PNG (lossless, transparency kept).
 */
export async function sliceBigImage(file: File): Promise<{ name: string; width: number; height: number; tiles: ImageTile[] }> {
  const name = file.name.replace(/\.[a-z0-9]+$/i, '') || tr('Изображение');
  let whole: ImageBitmap;
  try {
    whole = await createImageBitmap(file);
  } catch {
    throw new Error(tr('Не удалось открыть «{0}»: формат не поддерживается или картинка слишком велика для браузера', file.name));
  }
  const { width, height } = whole;
  if (width <= BIG_IMAGE_TILE && height <= BIG_IMAGE_TILE) {
    whole.close();
    return { name, width, height, tiles: [{ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type || 'image/png', width, height, name, x: 0, y: 0 }] };
  }
  const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  // Pieces reach a little over their neighbours with the same pixels: side by side
  // edge to edge, the canvas between them would show through at fractional zoom.
  // Not where a seam is see-through — there the overlap would darken it.
  const overlap = mime === 'image/jpeg' || seamsOpaque(whole) ? SEAM_OVERLAP : 0;
  const tiles: ImageTile[] = [];
  let total = 0;
  try {
    for (let y = 0; y < height; y += BIG_IMAGE_TILE) {
      for (let x = 0; x < width; x += BIG_IMAGE_TILE) {
        const w = Math.min(BIG_IMAGE_TILE + overlap, width - x);
        const h = Math.min(BIG_IMAGE_TILE + overlap, height - y);
        const canvas = new OffscreenCanvas(w, h);
        canvas.getContext('2d')!.drawImage(whole, x, y, w, h, 0, 0, w, h);
        const blob = await canvas.convertToBlob(mime === 'image/jpeg' ? { type: mime, quality: 0.95 } : { type: mime });
        total += blob.size;
        if (total > MAX_BIG_IMAGE_BYTES) throw new Error(tr('«{0}» слишком тяжёлое: в файле оно заняло бы больше 44 МБ. Сожмите картинку или сохраните её в JPEG', file.name));
        tiles.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mime, width: w, height: h, name: tr('{0}, часть {1}', name, tiles.length + 1), x, y });
      }
    }
  } finally {
    whole.close();
  }
  return { name, width, height, tiles };
}
