// Decoded images for image fills. Decoding is asynchronous, so the first frame
// draws a placeholder and the cache asks for a redraw once the bitmap is ready.
// Videos and animated GIFs are fills too (as in Figma): they hand out the frame of
// the moment, and `isAnimated` tells the canvas to keep redrawing them.

import { base64ToBytes, type Document, type ImageFilters } from '#core';
import { adjustPixels, hasFilters } from './pixels.ts';

/** Frames of an animated GIF with when each ends (ms from the start of the loop). */
type Frames = { images: ImageBitmap[]; ends: number[]; total: number };

type Entry =
  | { state: 'loading' }
  | { state: 'ready'; image: CanvasImageSource; width: number; height: number; frames?: Frames; video?: HTMLVideoElement; used?: number }
  | { state: 'error' };

/**
 * Decoded pictures kept at most this many bytes (width × height × 4): past it the ones
 * not drawn for a while are let go (decoded again when they show). A heavy file
 * scrolled through kept every picture it had ever shown (PERF-003).
 */
export const DECODED_LIMIT = 768 * 1024 * 1024;
/** A picture drawn this recently is never let go. */
const KEEP_MS = 10_000;

/**
 * Bytes of a picture from its base64 without holding the page up: the browser decodes a
 * data: address off the main thread (a 10 MB photo took a noticeable pause); elsewhere — at once.
 */
function bytesOf(data: string, mime: string): Promise<Blob> {
  if (typeof fetch === 'function' && typeof location !== 'undefined' && data.length > 256 * 1024) {
    return fetch(`data:${mime};base64,${data}`).then((r) => r.blob()).catch(() => new Blob([base64ToBytes(data) as BlobPart], { type: mime }));
  }
  return Promise.resolve(new Blob([base64ToBytes(data) as BlobPart], { type: mime }));
}

interface DecodedFrame {
  image: { duration: number | null; close(): void };
}

/** The part of WebCodecs' ImageDecoder used here (not in every TypeScript lib yet). */
interface GifDecoder {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  decode(options: { frameIndex: number }): Promise<DecodedFrame>;
  close(): void;
}

export class ImageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Set<Promise<void>>();
  /** Called whenever an image finishes decoding. */
  onLoad: (hash: string) => void = () => undefined;

  /** The decoded image, or null while it is loading (decoding starts on first request). */
  get(doc: Document, hash: string): { image: CanvasImageSource; width: number; height: number } | null {
    const entry = this.entries.get(hash);
    if (entry) {
      if (entry.state !== 'ready') return null;
      entry.used = performance.now();
      if (entry.frames) {
        // The GIF frame of this moment (all GIFs on the page run on one clock).
        const t = performance.now() % entry.frames.total;
        let i = 0;
        while (i < entry.frames.ends.length - 1 && entry.frames.ends[i]! <= t) i++;
        return { image: entry.frames.images[i]!, width: entry.width, height: entry.height };
      }
      return entry;
    }
    const blob = doc.store.blobs.get(hash);
    if (!blob || typeof createImageBitmap !== 'function') return null;
    this.entries.set(hash, { state: 'loading' });
    const mime = blob.mime;
    const decode = bytesOf(blob.data, mime).then(async (file): Promise<Entry> =>
      mime.startsWith('video/') ? this.loadVideo(file) : mime === 'image/gif' ? this.loadGif(new Uint8Array(await file.arrayBuffer()), file) : createImageBitmap(file).then((bitmap) => ({ state: 'ready' as const, image: bitmap, width: bitmap.width, height: bitmap.height })),
    );
    const task = decode
      .then((ready) => {
        if (ready.state === 'ready') ready.used = performance.now();
        this.entries.set(hash, ready);
        this.trim(hash);
        this.onLoad(hash);
      })
      .catch(() => {
        this.entries.set(hash, { state: 'error' });
      })
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
    return null;
  }

  /** Past the limit, the pictures not drawn for a while go (oldest first); `keep` — the one just decoded. */
  private trim(keep: string): void {
    const size = (e: Entry) => (e.state === 'ready' ? e.width * e.height * 4 * (e.frames?.images.length ?? 1) : 0);
    let total = 0;
    for (const e of this.entries.values()) total += size(e);
    if (total <= DECODED_LIMIT) return;
    const now = performance.now();
    const old = [...this.entries].filter(([h, e]) => h !== keep && e.state === 'ready' && !e.video && now - (e.used ?? 0) > KEEP_MS).sort((a, b) => ((a[1] as { used?: number }).used ?? 0) - ((b[1] as { used?: number }).used ?? 0));
    for (const [hash, e] of old) {
      if (total <= DECODED_LIMIT) break;
      total -= size(e);
      if (e.state === 'ready') {
        for (const img of e.frames?.images ?? [e.image]) (img as { close?: () => void }).close?.();
      }
      this.entries.delete(hash);
      for (const k of [...this.variants.keys()]) if (k.startsWith(`${hash}|`)) this.variants.delete(k);
    }
  }

  /** Whether the fill moves (a video or an animated GIF): the canvas keeps redrawing it. */
  isAnimated(hash: string): boolean {
    const entry = this.entries.get(hash);
    return entry?.state === 'ready' && (!!entry.frames || !!entry.video);
  }

  /** A video plays muted and in a loop, from the document's bytes. */
  private loadVideo(file: Blob): Promise<Entry> {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') return reject(new Error('no video'));
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.autoplay = true;
      video.preload = 'auto';
      video.addEventListener('loadeddata', () => {
        void video.play().catch(() => undefined);
        resolve({ state: 'ready', image: video, width: video.videoWidth, height: video.videoHeight, video });
      }, { once: true });
      video.addEventListener('error', () => reject(new Error('video')), { once: true });
      video.src = URL.createObjectURL(file);
    });
  }

  /** An animated GIF: every frame decoded (WebCodecs); without ImageDecoder — its first frame. */
  private async loadGif(bytes: Uint8Array, file: Blob): Promise<Entry> {
    const Decoder = (globalThis as { ImageDecoder?: new (init: { data: Uint8Array; type: string }) => GifDecoder }).ImageDecoder;
    const still = async (): Promise<Entry> => {
      const bitmap = await createImageBitmap(file);
      return { state: 'ready', image: bitmap, width: bitmap.width, height: bitmap.height };
    };
    if (!Decoder) return still();
    const decoder = new Decoder({ data: bytes, type: 'image/gif' });
    try {
      await decoder.tracks.ready;
      const count = Math.min(500, decoder.tracks.selectedTrack?.frameCount ?? 1);
      if (count <= 1) return still();
      const images: ImageBitmap[] = [];
      const ends: number[] = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        // Durations are in microseconds; browsers treat very short frames as 100 ms.
        const ms = (image.duration ?? 100_000) / 1000;
        total += ms < 20 ? 100 : ms;
        ends.push(total);
        images.push(await createImageBitmap(image as unknown as ImageBitmapSource));
        image.close();
      }
      return { state: 'ready', image: images[0]!, width: images[0]!.width, height: images[0]!.height, frames: { images, ends, total } };
    } catch {
      return still();
    } finally {
      decoder.close();
    }
  }

  /** Turned and adjusted pictures, the last few kept. */
  private readonly variants = new Map<string, { image: CanvasImageSource; width: number; height: number }>();

  /**
   * The image as a fill shows it: turned clockwise by `rotation` and with the photo
   * adjustments applied (the original is not changed). Null while it is decoding.
   */
  adjusted(doc: Document, hash: string, rotation: number, filters: ImageFilters | undefined, flipX = false, flipY = false): { image: CanvasImageSource; width: number; height: number } | null {
    const base = this.get(doc, hash);
    if (!base) return null;
    const turn = ((rotation % 360) + 360) % 360;
    const adjust = hasFilters(filters);
    if ((turn === 0 && !adjust && !flipX && !flipY) || typeof OffscreenCanvas === 'undefined') return base;
    // A moving picture changes every frame: it is turned and adjusted anew each time, not kept.
    const moving = this.isAnimated(hash);
    const key = `${hash}|${turn}|${flipX ? 'x' : ''}${flipY ? 'y' : ''}|${adjust ? JSON.stringify(filters) : ''}`;
    const known = moving ? undefined : this.variants.get(key);
    if (known) return known;
    const side = turn === 90 || turn === 270;
    const width = side ? base.height : base.width;
    const height = side ? base.width : base.height;
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return base;
    ctx.translate(width / 2, height / 2);
    // Mirrored in the fill's own directions, then turned (so a flipped layer shows its picture flipped).
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.rotate((turn * Math.PI) / 180);
    ctx.drawImage(base.image, -base.width / 2, -base.height / 2);
    if (adjust) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      adjustPixels(img, filters);
      ctx.putImageData(img, 0, 0);
    }
    const out = { image: canvas, width, height };
    if (moving) return out;
    if (this.variants.size > 24) this.variants.delete(this.variants.keys().next().value!);
    this.variants.set(key, out);
    return out;
  }

  /** Natural size of an image, if decoded. */
  size(hash: string): { width: number; height: number } | null {
    const entry = this.entries.get(hash);
    return entry?.state === 'ready' ? { width: entry.width, height: entry.height } : null;
  }

  /** Resolves when every requested image has been decoded (used before export). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
