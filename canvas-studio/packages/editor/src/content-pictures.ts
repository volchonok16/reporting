// Pictures of the «Контент» sets, drawn by code (nothing downloaded): avatars
// with initials, avatar figures, gradient and pattern covers. The same index
// always gives the same picture; avatars with initials follow the names set.

import { initials, type ContentLang, type PictureBytes } from './content-reel.ts';

/** Pairs of a background and a deeper tone: calm, readable with white letters. */
const PALETTE: [string, string][] = [
  ['#5B6CF0', '#3442C9'], ['#E86A5C', '#C2443A'], ['#2FA37A', '#1D7A59'], ['#F2A93B', '#C97F12'],
  ['#8E5BD9', '#6837B0'], ['#3BA4D9', '#1F7BAE'], ['#D9577F', '#B03358'], ['#5C8A3B', '#3F6524'],
  ['#E0784A', '#B8552A'], ['#4A6B8A', '#2F4A66'], ['#C76BC2', '#9C4597'], ['#2E9C9C', '#1A7373'],
];
const SOFT = ['#E7EAFE', '#FDE7E4', '#DFF4EC', '#FEF0D9', '#EEE5FA', '#E0F1FA', '#FBE3EB', '#E6F0DE', '#FCE9DF', '#E3E9F0', '#F6E6F5', '#DDF2F2'];

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return [c, c.getContext('2d')!];
}

/** A small number from i: the same every time, different from its neighbours. */
const hash = (i: number, k: number) => (((i + 1) * 2654435761 + k * 40503) >>> 0) / 4294967296;

function draw(setId: string, i: number, width: number, height: number, lang: ContentLang): HTMLCanvasElement {
  const [c, g] = canvas(width, height);
  const [main, deep] = PALETTE[i % PALETTE.length]!;
  if (setId === 'avatarInitials') {
    g.fillStyle = main;
    g.fillRect(0, 0, width, height);
    g.fillStyle = '#FFFFFF';
    g.font = `600 ${Math.round(height * 0.38)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(initials(i, lang), width / 2, height * 0.53);
  } else if (setId === 'avatarFigure') {
    g.fillStyle = SOFT[i % SOFT.length]!;
    g.fillRect(0, 0, width, height);
    g.fillStyle = main;
    // Head and shoulders, cut by the bottom edge.
    g.beginPath();
    g.arc(width / 2, height * 0.4, height * 0.18, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(width / 2, height * 1.02, width * 0.34, height * 0.38, 0, Math.PI, 0);
    g.fill();
  } else if (setId === 'coverGradient') {
    g.fillStyle = SOFT[i % SOFT.length]!;
    g.fillRect(0, 0, width, height);
    // Three soft blots of colour from neighbouring pairs of the palette.
    for (let k = 0; k < 3; k++) {
      const [colour] = PALETTE[(i + k * 4) % PALETTE.length]!;
      const x = width * (0.15 + hash(i, k) * 0.7);
      const y = height * (0.15 + hash(i, k + 7) * 0.7);
      const r = Math.max(width, height) * (0.45 + hash(i, k + 3) * 0.3);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `${colour}E6`);
      grad.addColorStop(1, `${colour}00`);
      g.fillStyle = grad;
      g.fillRect(0, 0, width, height);
    }
  } else {
    g.fillStyle = SOFT[i % SOFT.length]!;
    g.fillRect(0, 0, width, height);
    g.fillStyle = main;
    g.strokeStyle = main;
    const s = Math.round(Math.min(width, height) / 8);
    switch (i % 6) {
      case 0: // diagonal stripes
        g.lineWidth = s / 2;
        for (let x = -height; x < width + height; x += s * 1.2) {
          g.beginPath();
          g.moveTo(x, 0);
          g.lineTo(x + height, height);
          g.stroke();
        }
        break;
      case 1: // dots
        for (let y = s / 2; y < height + s; y += s)
          for (let x = (y / s) % 2 ? s : s / 2; x < width + s; x += s) {
            g.beginPath();
            g.arc(x, y, s * 0.22, 0, Math.PI * 2);
            g.fill();
          }
        break;
      case 2: // circles from a corner
        g.lineWidth = s / 3;
        for (let r = s; r < width + height; r += s * 0.9) {
          g.beginPath();
          g.arc(0, height, r, 0, Math.PI * 2);
          g.stroke();
        }
        break;
      case 3: // waves
        g.lineWidth = s / 3;
        for (let y = 0; y < height + s; y += s * 0.9) {
          g.beginPath();
          for (let x = 0; x <= width; x += 4) g.lineTo(x, y + Math.sin((x / s) * 1.2) * s * 0.3);
          g.stroke();
        }
        break;
      case 4: // checks
        g.fillStyle = `${main}55`;
        for (let y = 0; y < height; y += s) for (let x = (y / s) % 2 ? s : 0; x < width; x += s * 2) g.fillRect(x, y, s, s);
        break;
      default: // triangles
        g.fillStyle = deep;
        for (let y = 0; y < height + s; y += s * 1.5)
          for (let x = 0; x < width + s; x += s * 1.5) {
            if (hash(i, x * 31 + y) < 0.45) continue;
            g.beginPath();
            g.moveTo(x, y);
            g.lineTo(x + s, y);
            g.lineTo(x + s / 2, y + s * 0.86);
            g.fill();
          }
    }
  }
  return c;
}

/** The i-th picture of a set as PNG bytes, twice the layer's size (sharp on a retina screen). */
export async function pictureBytes(setId: string, i: number, width: number, height: number, lang: ContentLang): Promise<PictureBytes> {
  const c = draw(setId, i, width * 2, height * 2, lang);
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
}

/** A small preview for the panel. */
export function pictureThumb(setId: string, i: number, width: number, height: number, lang: ContentLang): string {
  return draw(setId, i, width, height, lang).toDataURL('image/png');
}
