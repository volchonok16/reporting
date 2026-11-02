// Device frames for the prototype viewer (FR-PRT-050): iPhone, Pixel, iPad,
// MacBook or none. Drawn with plain canvas shapes (no images), proportional to
// the screen width, so any frame size gets a fitting body.

import { tr } from '#core';
import type { PrototypeDevice } from '#core';

/** Body around the screen, in fractions of the screen width. */
interface DeviceSpec {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Outer corner radius of the body. */
  body: number;
  /** Corner radius of the visible screen. */
  screen: number;
}

const SPECS: Record<Exclude<PrototypeDevice, 'NONE'>, DeviceSpec> = {
  IPHONE: { left: 0.04, top: 0.04, right: 0.04, bottom: 0.04, body: 0.15, screen: 0.115 },
  PIXEL: { left: 0.035, top: 0.05, right: 0.035, bottom: 0.05, body: 0.12, screen: 0.085 },
  IPAD: { left: 0.045, top: 0.045, right: 0.045, bottom: 0.045, body: 0.06, screen: 0.025 },
  MACBOOK: { left: 0.025, top: 0.035, right: 0.025, bottom: 0.11, body: 0.025, screen: 0 },
};

export const DEVICE_LABELS: Record<PrototypeDevice, string> = {
  NONE: tr('Без рамки'),
  IPHONE: 'iPhone',
  PIXEL: 'Pixel',
  IPAD: 'iPad',
  MACBOOK: 'MacBook',
};

/** Space the body takes around a screen of `width` (unscaled px). */
export function deviceInsets(device: PrototypeDevice, width: number): { left: number; top: number; right: number; bottom: number } {
  if (device === 'NONE') return { left: 0, top: 0, right: 0, bottom: 0 };
  const s = SPECS[device];
  return { left: s.left * width, top: s.top * width, right: s.right * width, bottom: s.bottom * width };
}

/** Corner radius of the visible screen, in canvas pixels. */
export function screenRadius(device: PrototypeDevice, canvasWidth: number): number {
  return device === 'NONE' ? 0 : SPECS[device].screen * canvasWidth;
}

/** Draws the body for a screen drawn at (x, y, w, h) canvas pixels, under the screen. */
export function drawDevice(ctx: CanvasRenderingContext2D, device: PrototypeDevice, x: number, y: number, w: number, h: number): void {
  if (device === 'NONE') return;
  const s = SPECS[device];
  ctx.save();
  if (device === 'MACBOOK') {
    // Lid: a thin dark bezel around the display.
    const lx = x - s.left * w;
    const ly = y - s.top * w;
    const lw = w + (s.left + s.right) * w;
    const lh = h + s.top * w + 0.03 * w;
    ctx.fillStyle = '#0d0d0f';
    ctx.beginPath();
    ctx.roundRect(lx, ly, lw, lh, [s.body * w, s.body * w, 0, 0]);
    ctx.fill();
    ctx.strokeStyle = '#3a3a3e';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Camera.
    ctx.fillStyle = '#26262a';
    ctx.beginPath();
    ctx.arc(x + w / 2, y - (s.top * w) / 2, Math.max(1.5, 0.004 * w), 0, Math.PI * 2);
    ctx.fill();
    // Base: wider than the lid, with the opening notch.
    const by = ly + lh;
    const bw = lw * 1.14;
    const bx = x + w / 2 - bw / 2;
    const bh = 0.035 * w;
    ctx.fillStyle = '#c9cacf';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, [0, 0, bh, bh]);
    ctx.fill();
    ctx.fillStyle = '#a9aaaf';
    ctx.beginPath();
    ctx.roundRect(x + w / 2 - 0.08 * w, by, 0.16 * w, bh * 0.35, [0, 0, bh * 0.3, bh * 0.3]);
    ctx.fill();
    ctx.restore();
    return;
  }
  const bx = x - s.left * w;
  const by = y - s.top * w;
  const bw = w + (s.left + s.right) * w;
  const bh = h + (s.top + s.bottom) * w;
  ctx.fillStyle = '#111114';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, s.body * w);
  ctx.fill();
  // A lighter rim, like the metal edge.
  ctx.strokeStyle = '#3c3c42';
  ctx.lineWidth = Math.max(1, 0.006 * w);
  ctx.stroke();
  ctx.restore();
}

/** Things that sit over the screen: the iPhone island, the Pixel camera hole, the iPad camera. */
export function drawDeviceOverlay(ctx: CanvasRenderingContext2D, device: PrototypeDevice, x: number, y: number, w: number): void {
  ctx.save();
  ctx.fillStyle = '#050506';
  if (device === 'IPHONE') {
    const iw = 0.32 * w;
    const ih = 0.093 * w;
    ctx.beginPath();
    ctx.roundRect(x + w / 2 - iw / 2, y + 0.028 * w, iw, ih, ih / 2);
    ctx.fill();
  } else if (device === 'PIXEL') {
    ctx.beginPath();
    ctx.arc(x + w / 2, y + 0.05 * w, 0.028 * w, 0, Math.PI * 2);
    ctx.fill();
  } else if (device === 'IPAD') {
    ctx.fillStyle = '#26262a';
    ctx.beginPath();
    ctx.arc(x + w / 2, y - 0.0225 * w, Math.max(1.5, 0.006 * w), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
