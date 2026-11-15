// Motion, stage 5: an animated frame as a GIF or a video, made here in the browser (Figma Motion exports MP4,
// GIF, WebM). Frames are drawn by a scene of their own posed for each moment — the canvas being edited is not
// touched; a GIF is encoded by our own encoder, a video recorded from a canvas (MP4 where the browser records it —
// Safari, the macOS app — else WebM), in real time, one round of the timeline.

import { tr, type NodeId } from '#core';
import { invert, transformRect } from '#geometry';
import { SceneGraph, type Canvas2DRenderer, type Pose, context2d } from '#render';
import type { Editor } from '../editor.ts';
import { encodeGif } from './gif.ts';
import { fullPose } from './model.ts';

/** The longest side of an exported animation (a GIF of a big frame would be huge). */
const MAX_SIDE = { gif: 640, video: 1280 };

interface Frames {
  width: number;
  height: number;
  /** Draws the moment `t` (ms) and gives the canvas. */
  draw(t: number): OffscreenCanvas;
  duration: number;
  loop: boolean;
}

async function framer(editor: Editor, renderer: Canvas2DRenderer, frame: NodeId, maxSide: number): Promise<Frames> {
  const doc = editor.doc;
  const motion = doc.get(frame, 'motion');
  if (!motion) throw new Error(tr('У фрейма нет таймлайна'));
  const scene = new SceneGraph(doc, doc.pageOf(frame) ?? editor.pageId);
  scene.ensure();
  // The frame's own box: what it shows of its layers, whatever they do on the timeline.
  const bounds = scene.bounds(frame);
  const scale = Math.min(2, maxSide / Math.max(bounds.width, bounds.height));
  // Even sizes: video encoders want them.
  const width = Math.max(2, Math.round((bounds.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((bounds.height * scale) / 2) * 2);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = context2d(canvas);
  if (!ctx) throw new Error(tr('Canvas 2D недоступен'));
  const draw = (t: number) => {
    scene.setPose(fullPose(doc, frame, () => t));
    scene.ensure();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
    const parent = doc.parent(frame);
    if (parent && doc.type(parent) !== 'PAGE') {
      const m = scene.world(parent);
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    }
    renderer.renderNode(ctx, scene, frame, bounds, scale);
    return canvas;
  };
  draw(0);
  // Pictures decode asynchronously: the frames are drawn once they are there.
  await renderer.images.settled();
  return { width, height, draw, duration: motion.duration, loop: motion.loop };
}

/** The animation as an animated GIF (20 frames a second). */
export async function exportGif(editor: Editor, renderer: Canvas2DRenderer, frame: NodeId, onProgress?: (part: number) => void): Promise<Blob> {
  const f = await framer(editor, renderer, frame, MAX_SIDE.gif);
  const fps = 20;
  const count = Math.max(1, Math.round((f.duration / 1000) * fps));
  const frames = [];
  for (let i = 0; i < count; i++) {
    const c = f.draw((i / fps) * 1000);
    frames.push({ data: context2d(c)!.getImageData(0, 0, f.width, f.height).data });
    onProgress?.((i + 1) / (count + 1));
    if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
  }
  const bytes = encodeGif(f.width, f.height, frames, 100 / fps, f.loop);
  onProgress?.(1);
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' });
}

/** What this browser records a canvas into: MP4 first, else WebM; null — no recording. */
export function videoType(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const [mime, ext] of [['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9', 'webm'], ['video/webm', 'webm']] as const) {
    if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
  }
  return null;
}

/** The animation as a video: one round recorded in real time (30 frames a second). */
export async function exportVideo(editor: Editor, renderer: Canvas2DRenderer, frame: NodeId, onProgress?: (part: number) => void): Promise<{ blob: Blob; ext: string }> {
  const type = videoType();
  if (!type) throw new Error(tr('Этот браузер не записывает видео. Сохраните GIF'));
  const f = await framer(editor, renderer, frame, MAX_SIDE.video);
  const shown = document.createElement('canvas');
  shown.width = f.width;
  shown.height = f.height;
  const ctx = context2d(shown)!;
  ctx.drawImage(f.draw(0), 0, 0);
  const stream = shown.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: type.mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const step = () => {
      const t = Math.min(f.duration, performance.now() - start);
      ctx.drawImage(f.draw(t), 0, 0);
      onProgress?.(t / f.duration);
      if (t < f.duration) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  // The last moment stays a little, so players do not cut it.
  await new Promise((r) => setTimeout(r, 120));
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  return { blob: new Blob(chunks, { type: type.mime.split(';')[0] }), ext: type.ext };
}

/** The longest side of one picture inside a Lottie file, in pixels. */
const LOTTIE_MAX_PX = 2048;

/** The animation as a Lottie file (JSON): pictures of the layers, the motion as Lottie keyframes (motion/lottie.ts). */
export async function exportLottie(editor: Editor, renderer: Canvas2DRenderer, frame: NodeId): Promise<Blob> {
  const { buildLottie, lottieUnits, unitHides } = await import('./lottie.ts');
  const doc = editor.doc;
  if (!doc.get(frame, 'motion')) throw new Error(tr('У фрейма нет таймлайна'));
  const scene = new SceneGraph(doc, doc.pageOf(frame) ?? editor.pageId);
  const side = Math.max(doc.get(frame, 'width'), doc.get(frame, 'height'), 1);
  const k = Math.min(2, LOTTIE_MAX_PX / side);
  const units = lottieUnits(doc, frame);
  const draw = (unit: (typeof units)[number]): { canvas: OffscreenCanvas; x: number; y: number } | null => {
    const pose = new Map<NodeId, Pose>([[unit.id, { opacity: 1 }]]);
    if (unit.kind === 'layer') for (const id of unitHides(doc, frame, unit)) pose.set(id, { opacity: 0 });
    scene.setPose(pose);
    scene.ensure();
    const world = scene.world(unit.id);
    const inv = invert(world);
    if (!inv) return null;
    // Where the picture is in the layer's own space: everything it draws, effects and overflow included.
    const box = transformRect(inv, scene.renderBounds(unit.id));
    const w = Math.ceil(box.width * k);
    const hgt = Math.ceil(box.height * k);
    if (w < 1 || hgt < 1 || w > 8192 || hgt > 8192) return null;
    const canvas = new OffscreenCanvas(w, hgt);
    const ctx = context2d(canvas)!;
    ctx.setTransform(k, 0, 0, k, -box.x * k, -box.y * k);
    ctx.transform(inv.a, inv.b, inv.c, inv.d, inv.e, inv.f);
    const parent = doc.parent(unit.id);
    if (parent && doc.type(parent) !== 'PAGE') {
      const m = scene.world(parent);
      ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    }
    // A frame's own look: drawn without its children (hiding them by opacity left their shadows in it).
    renderer.renderNode(ctx, scene, unit.id, scene.renderBounds(unit.id), k, unit.kind === 'own' ? { children: false } : {});
    return { canvas, x: box.x, y: box.y };
  };
  for (const u of units) draw(u);
  // Pictures decode asynchronously: drawn again once they are there.
  await renderer.images.settled();
  const pictures = new Map<NodeId, import('./lottie.ts').UnitPicture>();
  for (const unit of units) {
    const drawn = draw(unit);
    if (!drawn) continue;
    // Cropped to what is painted: a frame's own look under hidden children is often a small part of it.
    const { canvas } = drawn;
    const data = context2d(canvas)!.getImageData(0, 0, canvas.width, canvas.height).data;
    let [x0, y0, x1, y1] = [canvas.width, canvas.height, -1, -1];
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3]! === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) continue;
    const crop = new OffscreenCanvas(x1 - x0 + 1, y1 - y0 + 1);
    context2d(crop)!.drawImage(canvas, -x0, -y0);
    const url = await new Promise<string>((resolve, reject) => {
      void crop.convertToBlob({ type: 'image/png' }).then((blob) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }, reject);
    });
    pictures.set(unit.id + ':' + unit.kind, { url, width: crop.width, height: crop.height, x: drawn.x + x0 / k, y: drawn.y + y0 / k, k });
    await new Promise((r) => setTimeout(r, 0));
  }
  scene.setPose(null);
  const json = buildLottie(doc, frame, (unit) => pictures.get(unit.id + ':' + unit.kind) ?? null);
  return new Blob([JSON.stringify(json)], { type: 'application/json' });
}
