// The file's colour profile (step 9, as Figma's sRGB / Display P3). A colour's numbers are read in the profile
// of the file: in Display P3 the same (1, 0, 0) is a deeper red that only wide-gamut screens show. Everything that
// draws the file — the canvas, its tiles, the renderer's own layers, exports — makes its canvases through
// `context2d`, so they are in the file's space; colours go out through `cssColor` as `color(display-p3 …)`.
// Browsers put the profile into PNG and JPEG made from such a canvas themselves.

export type ColorProfile = 'SRGB' | 'DISPLAY_P3';

let current: ColorProfile = 'SRGB';

/** Set when a file opens and when its profile changes; canvases made before keep their space. */
export function setColorProfile(profile: ColorProfile): void {
  current = profile === 'DISPLAY_P3' ? 'DISPLAY_P3' : 'SRGB';
}

export function colorProfile(): ColorProfile {
  return current;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** A 2D context in the file's colour space. */
export function context2d<C extends AnyCanvas>(canvas: C, settings: CanvasRenderingContext2DSettings = {}): C extends OffscreenCanvas ? OffscreenCanvasRenderingContext2D | null : CanvasRenderingContext2D | null {
  const s = current === 'DISPLAY_P3' ? { ...settings, colorSpace: 'display-p3' as const } : settings;
  return (canvas as HTMLCanvasElement).getContext('2d', s) as never;
}

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encode = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp = (v: number) => Math.max(0, Math.min(1, v));

/**
 * A Display P3 colour as the nearest sRGB one (same transfer curve, P3 primaries → XYZ D65 → sRGB),
 * for what carries sRGB only — SVG and PDF of a P3 file. Out-of-gamut channels are clipped.
 */
export function p3ToSrgb<C extends { r: number; g: number; b: number }>(c: C): C {
  const r = linear(c.r);
  const g = linear(c.g);
  const b = linear(c.b);
  return {
    ...c,
    r: clamp(encode(1.2249401 * r - 0.2249404 * g + 0 * b)),
    g: clamp(encode(-0.0420569 * r + 1.0420571 * g + 0 * b)),
    b: clamp(encode(-0.0196376 * r - 0.0786361 * g + 1.0982735 * b)),
  };
}

/** The colour as sRGB for a format without colour profiles: converted in a P3 file, as it is otherwise. */
export function srgbOut<C extends { r: number; g: number; b: number }>(c: C): C {
  return current === 'DISPLAY_P3' ? p3ToSrgb(c) : c;
}
