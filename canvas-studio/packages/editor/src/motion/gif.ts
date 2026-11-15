// An animated GIF of our own (Motion, stage 5: export without a server or a library): one palette of 256 colours
// for the whole animation (median cut over a 15-bit histogram of every frame, so colours do not flicker between
// frames), each pixel to its nearest colour, frames LZW-compressed as GIF89a has them; looping when asked.

export interface GifFrame {
  /** RGBA, width × height × 4. */
  data: Uint8ClampedArray;
}

/** A 15-bit colour key (5 bits a channel). */
const key15 = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** 256 colours for the frames: median cut of the histogram. */
export function buildPalette(frames: readonly GifFrame[], size = 256): Uint8Array {
  const hist = new Uint32Array(32768);
  for (const f of frames) {
    const d = f.data;
    // Every second pixel is enough to see which colours are there.
    for (let i = 0; i < d.length; i += 8) hist[key15(d[i]!, d[i + 1]!, d[i + 2]!)]!++;
  }
  type Box = { keys: number[] };
  const present: number[] = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) present.push(k);
  const channel = (k: number, c: number) => (k >> (10 - c * 5)) & 31;
  const boxes: Box[] = [{ keys: present }];
  while (boxes.length < size) {
    // Split the box with the widest channel (weighted by how many pixels it holds).
    let best = -1;
    let bestScore = 0;
    let bestChannel = 0;
    boxes.forEach((b, i) => {
      if (b.keys.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 31;
        let hi = 0;
        let weight = 0;
        for (const k of b.keys) {
          const v = channel(k, c);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          weight += hist[k]!;
        }
        const score = (hi - lo) * Math.log2(1 + weight);
        if (score > bestScore) {
          bestScore = score;
          best = i;
          bestChannel = c;
        }
      }
    });
    if (best < 0) break;
    const box = boxes[best]!;
    box.keys.sort((a, b) => channel(a, bestChannel) - channel(b, bestChannel));
    let total = 0;
    for (const k of box.keys) total += hist[k]!;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.keys.length - 1; i++) {
      acc += hist[box.keys[i]!]!;
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(best, 1, { keys: box.keys.slice(0, cut) }, { keys: box.keys.slice(cut) });
  }
  const palette = new Uint8Array(size * 3);
  boxes.forEach((b, i) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let w = 0;
    for (const k of b.keys) {
      const n = hist[k]!;
      r += (channel(k, 0) * 8 + 4) * n;
      g += (channel(k, 1) * 8 + 4) * n;
      bl += (channel(k, 2) * 8 + 4) * n;
      w += n;
    }
    if (w) {
      palette[i * 3] = Math.round(r / w);
      palette[i * 3 + 1] = Math.round(g / w);
      palette[i * 3 + 2] = Math.round(bl / w);
    }
  });
  return palette;
}

/** Each pixel's nearest palette colour (looked up once per 15-bit colour). */
function indexer(palette: Uint8Array): (r: number, g: number, b: number) => number {
  const cache = new Int16Array(32768).fill(-1);
  const n = palette.length / 3;
  return (r, g, b) => {
    const k = key15(r, g, b);
    const hit = cache[k]!;
    if (hit >= 0) return hit;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = palette[i * 3]! - r;
      const dg = palette[i * 3 + 1]! - g;
      const db = palette[i * 3 + 2]! - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    cache[k] = best;
    return best;
  };
}

/** GIF's LZW of 8-bit indices: codes from 9 to 12 bits, a clear code when the table is full. */
export function lzw(indices: Uint8Array): Uint8Array {
  const CLEAR = 256;
  const EOI = 257;
  const out: number[] = [];
  let bits = 0;
  let nbits = 0;
  let size = 9;
  const emit = (code: number) => {
    bits |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      out.push(bits & 255);
      bits >>>= 8;
      nbits -= 8;
    }
  };
  let dict = new Map<number, number>();
  let next = 258;
  emit(CLEAR);
  if (indices.length === 0) {
    emit(EOI);
    if (nbits > 0) out.push(bits & 255);
    return new Uint8Array(out);
  }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i]!;
    const k = prefix * 256 + c;
    const found = dict.get(k);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(k, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(CLEAR);
      dict = new Map();
      next = 258;
      size = 9;
    }
    prefix = c;
  }
  emit(prefix);
  emit(EOI);
  if (nbits > 0) out.push(bits & 255);
  return new Uint8Array(out);
}

/** The animation as GIF89a bytes; `delay` in hundredths of a second per frame. */
export function encodeGif(width: number, height: number, frames: readonly GifFrame[], delay: number, loop: boolean): Uint8Array {
  const palette = buildPalette(frames);
  const nearest = indexer(palette);
  const bytes: number[] = [];
  const word = (v: number) => bytes.push(v & 255, (v >> 8) & 255);
  const text = (s: string) => {
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  text('GIF89a');
  word(width);
  word(height);
  bytes.push(0xf7, 0, 0); // a global table of 256 colours
  for (const v of palette) bytes.push(v);
  if (loop) {
    bytes.push(0x21, 0xff, 11);
    text('NETSCAPE2.0');
    bytes.push(3, 1, 0, 0, 0);
  }
  const indices = new Uint8Array(width * height);
  for (const f of frames) {
    const d = f.data;
    for (let p = 0, i = 0; p < indices.length; p++, i += 4) indices[p] = nearest(d[i]!, d[i + 1]!, d[i + 2]!);
    bytes.push(0x21, 0xf9, 4, 0x04);
    word(Math.max(2, Math.round(delay)));
    bytes.push(0, 0);
    bytes.push(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    bytes.push(0);
    bytes.push(8);
    const data = lzw(indices);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      bytes.push(n);
      for (let j = 0; j < n; j++) bytes.push(data[i + j]!);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}
