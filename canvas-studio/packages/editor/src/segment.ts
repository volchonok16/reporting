// Cutting an object out of a busy background without a model (the "AI without AI"
// rule): GrabCut, written here from its published description (Rother, Kolmogorov,
// Blake, 2004). The edge of the picture is taken as background and the rest as maybe
// object; colours of each are described by a mixture of five Gaussians; a minimum cut
// of the pixel graph (Boykov–Kolmogorov max-flow) splits them where the colour model
// and the image's own edges agree; the mixtures are learnt again from the split and
// the cut repeated. The mask is then made soft and true to the full-size picture by an
// edge-aware (guided) filter.

/** Colour of a pixel, 0..255 per channel. */
type RGB = [number, number, number];

// ---------- Gaussian mixture ----------

interface Gaussian {
  weight: number;
  mean: RGB;
  /** Inverse covariance (row-major 3 × 3) and the log of the normalising factor. */
  inv: number[];
  logNorm: number;
}

const K = 5;

function fitGaussians(pixels: Float32Array, members: Int32Array, count: number, assign: Uint8Array): Gaussian[] {
  const sums = new Float64Array(K * 13); // n, sum rgb, sum products (9)
  for (let k = 0; k < count; k++) {
    const p = members[k]!;
    const c = assign[p]!;
    const r = pixels[p * 3]!;
    const g = pixels[p * 3 + 1]!;
    const b = pixels[p * 3 + 2]!;
    const o = c * 13;
    sums[o]! += 1;
    sums[o + 1]! += r;
    sums[o + 2]! += g;
    sums[o + 3]! += b;
    const v = [r, g, b];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) sums[o + 4 + i * 3 + j]! += v[i]! * v[j]!;
  }
  const out: Gaussian[] = [];
  for (let c = 0; c < K; c++) {
    const o = c * 13;
    const n = sums[o]!;
    if (n < 1) continue;
    const mean: RGB = [sums[o + 1]! / n, sums[o + 2]! / n, sums[o + 3]! / n];
    const cov: number[] = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov.push(sums[o + 4 + i * 3 + j]! / n - mean[i]! * mean[j]! + (i === j ? 4 : 0));
    const det =
      cov[0]! * (cov[4]! * cov[8]! - cov[5]! * cov[7]!) - cov[1]! * (cov[3]! * cov[8]! - cov[5]! * cov[6]!) + cov[2]! * (cov[3]! * cov[7]! - cov[4]! * cov[6]!);
    if (!(det > 1e-6)) continue;
    const inv = [
      (cov[4]! * cov[8]! - cov[5]! * cov[7]!) / det,
      (cov[2]! * cov[7]! - cov[1]! * cov[8]!) / det,
      (cov[1]! * cov[5]! - cov[2]! * cov[4]!) / det,
      (cov[5]! * cov[6]! - cov[3]! * cov[8]!) / det,
      (cov[0]! * cov[8]! - cov[2]! * cov[6]!) / det,
      (cov[2]! * cov[3]! - cov[0]! * cov[5]!) / det,
      (cov[3]! * cov[7]! - cov[4]! * cov[6]!) / det,
      (cov[1]! * cov[6]! - cov[0]! * cov[7]!) / det,
      (cov[0]! * cov[4]! - cov[1]! * cov[3]!) / det,
    ];
    out.push({ weight: n / count, mean, inv, logNorm: -0.5 * Math.log(det) - 1.5 * Math.log(2 * Math.PI) });
  }
  return out;
}

/** Log of the component's density at a colour (weight included). */
function logDensity(g: Gaussian, r: number, gr: number, b: number): number {
  const d0 = r - g.mean[0];
  const d1 = gr - g.mean[1];
  const d2 = b - g.mean[2];
  const m = g.inv;
  const q = d0 * (m[0]! * d0 + m[1]! * d1 + m[2]! * d2) + d1 * (m[3]! * d0 + m[4]! * d1 + m[5]! * d2) + d2 * (m[6]! * d0 + m[7]! * d1 + m[8]! * d2);
  return Math.log(g.weight) + g.logNorm - 0.5 * q;
}

/** −log of the mixture's density (the cost of saying the colour belongs to it). */
function cost(gs: Gaussian[], r: number, g: number, b: number): number {
  let best = -Infinity;
  let sum = 0;
  const logs = gs.map((c) => logDensity(c, r, g, b));
  for (const l of logs) best = Math.max(best, l);
  for (const l of logs) sum += Math.exp(l - best);
  return -(best + Math.log(sum));
}

/** The component each pixel is most likely from (k-means at first, then the mixture). */
function assignComponents(pixels: Float32Array, members: Int32Array, count: number, assign: Uint8Array, gs: Gaussian[] | null): void {
  if (gs && gs.length > 0) {
    for (let k = 0; k < count; k++) {
      const p = members[k]!;
      let best = 0;
      let bestL = -Infinity;
      gs.forEach((g, c) => {
        const l = logDensity(g, pixels[p * 3]!, pixels[p * 3 + 1]!, pixels[p * 3 + 2]!);
        if (l > bestL) {
          bestL = l;
          best = c;
        }
      });
      assign[p] = best;
    }
    return;
  }
  // k-means with centres spread over the colours (k-means++ without the randomness: farthest points).
  const centres: RGB[] = [];
  const first = members[0]!;
  centres.push([pixels[first * 3]!, pixels[first * 3 + 1]!, pixels[first * 3 + 2]!]);
  const d2 = (p: number, c: RGB) => (pixels[p * 3]! - c[0]) ** 2 + (pixels[p * 3 + 1]! - c[1]) ** 2 + (pixels[p * 3 + 2]! - c[2]) ** 2;
  const step = Math.max(1, Math.floor(count / 2000));
  while (centres.length < K) {
    let far = -1;
    let farD = -1;
    for (let k = 0; k < count; k += step) {
      const p = members[k]!;
      const d = Math.min(...centres.map((c) => d2(p, c)));
      if (d > farD) {
        farD = d;
        far = p;
      }
    }
    if (far < 0) break;
    centres.push([pixels[far * 3]!, pixels[far * 3 + 1]!, pixels[far * 3 + 2]!]);
  }
  for (let iter = 0; iter < 6; iter++) {
    const acc = new Float64Array(centres.length * 4);
    for (let k = 0; k < count; k++) {
      const p = members[k]!;
      let best = 0;
      let bestD = Infinity;
      centres.forEach((c, i) => {
        const d = d2(p, c);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      assign[p] = best;
      acc[best * 4]! += pixels[p * 3]!;
      acc[best * 4 + 1]! += pixels[p * 3 + 1]!;
      acc[best * 4 + 2]! += pixels[p * 3 + 2]!;
      acc[best * 4 + 3]! += 1;
    }
    centres.forEach((c, i) => {
      const n = acc[i * 4 + 3]!;
      if (n > 0) {
        c[0] = acc[i * 4]! / n;
        c[1] = acc[i * 4 + 1]! / n;
        c[2] = acc[i * 4 + 2]! / n;
      }
    });
  }
}

// ---------- Max-flow on an 8-connected grid (Boykov–Kolmogorov) ----------

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];
/** The direction back. */
const OPP = [4, 5, 6, 7, 0, 1, 2, 3];
const TERMINAL = 8;
const NONE = 9;
const FREE = 0;
const S = 1;
const T = 2;

/**
 * Minimum cut of a grid graph: `source[p]` / `sink[p]` are the terminal capacities,
 * `cap[p * 8 + d]` the capacity from p to its neighbour in direction d. Returns 1 for
 * pixels on the source side.
 */
export function gridMinCut(width: number, height: number, source: Float64Array, sink: Float64Array, cap: Float64Array): Uint8Array {
  const n = width * height;
  const tr = new Float64Array(n);
  for (let p = 0; p < n; p++) tr[p] = source[p]! - sink[p]!;
  const tree = new Uint8Array(n);
  const parent = new Uint8Array(n).fill(NONE);
  const dist = new Int32Array(n);
  const stamp = new Int32Array(n);
  let time = 1;
  let active: number[] = [];
  let aHead = 0;
  const inActive = new Uint8Array(n);
  const push = (p: number) => {
    if (inActive[p]) return;
    inActive[p] = 1;
    active.push(p);
  };
  const neighbour = (p: number, d: number): number => {
    const x = (p % width) + DX[d]!;
    const y = Math.floor(p / width) + DY[d]!;
    return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
  };
  for (let p = 0; p < n; p++) {
    if (tr[p]! > 0) {
      tree[p] = S;
      parent[p] = TERMINAL;
      dist[p] = 1;
      stamp[p] = time;
      push(p);
    } else if (tr[p]! < 0) {
      tree[p] = T;
      parent[p] = TERMINAL;
      dist[p] = 1;
      stamp[p] = time;
      push(p);
    }
  }
  const orphans: number[] = [];
  // Residual capacity of the edge that links a node to its parent, in the direction the flow goes.
  const linkCap = (u: number): number => {
    const d = parent[u]!;
    if (d === TERMINAL) return tree[u] === S ? tr[u]! : -tr[u]!;
    const v = neighbour(u, d);
    return tree[u] === S ? cap[v * 8 + OPP[d]!]! : cap[u * 8 + d]!;
  };
  for (;;) {
    // Growth: find a path from S to T.
    let from = -1;
    let to = -1;
    let dir = -1;
    while (aHead < active.length && from < 0) {
      // The queue's done part is dropped now and then.
      if (aHead > 65536) {
        active = active.slice(aHead);
        aHead = 0;
      }
      const p = active[aHead]!;
      if (tree[p] === FREE) {
        inActive[p] = 0;
        aHead++;
        continue;
      }
      for (let d = 0; d < 8; d++) {
        const q = neighbour(p, d);
        if (q < 0) continue;
        const c = tree[p] === S ? cap[p * 8 + d]! : cap[q * 8 + OPP[d]!]!;
        if (c <= 0) continue;
        if (tree[q] === FREE) {
          tree[q] = tree[p]!;
          parent[q] = OPP[d]!;
          dist[q] = dist[p]! + 1;
          stamp[q] = stamp[p]!;
          push(q);
        } else if (tree[q] !== tree[p]) {
          if (tree[p] === S) {
            from = p;
            to = q;
            dir = d;
          } else {
            from = q;
            to = p;
            dir = OPP[d]!;
          }
          break;
        } else if (stamp[q]! <= stamp[p]! && dist[q]! > dist[p]! && parent[q] !== TERMINAL) {
          // A shorter way to the root for q (the heuristic of the paper).
          parent[q] = OPP[d]!;
          stamp[q] = stamp[p]!;
          dist[q] = dist[p]! + 1;
        }
      }
      if (from < 0) {
        inActive[p] = 0;
        aHead++;
      }
    }
    if (from < 0) break;
    time++;
    // Augment: the bottleneck along S root … from → to … T root.
    let b = cap[from * 8 + dir]!;
    for (let u = from; parent[u] !== TERMINAL; u = neighbour(u, parent[u]!)) b = Math.min(b, linkCap(u));
    {
      let u = from;
      while (parent[u] !== TERMINAL) u = neighbour(u, parent[u]!);
      b = Math.min(b, tr[u]!);
    }
    for (let u = to; parent[u] !== TERMINAL; u = neighbour(u, parent[u]!)) b = Math.min(b, linkCap(u));
    {
      let u = to;
      while (parent[u] !== TERMINAL) u = neighbour(u, parent[u]!);
      b = Math.min(b, -tr[u]!);
    }
    cap[from * 8 + dir]! -= b;
    cap[to * 8 + OPP[dir]!]! += b;
    for (let u = from; ; ) {
      const d = parent[u]!;
      if (d === TERMINAL) {
        tr[u]! -= b;
        if (tr[u]! <= 0) {
          parent[u] = NONE;
          orphans.push(u);
        }
        break;
      }
      const v = neighbour(u, d);
      cap[v * 8 + OPP[d]!]! -= b;
      cap[u * 8 + d]! += b;
      if (cap[v * 8 + OPP[d]!]! <= 0) {
        parent[u] = NONE;
        orphans.push(u);
      }
      u = v;
    }
    for (let u = to; ; ) {
      const d = parent[u]!;
      if (d === TERMINAL) {
        tr[u]! += b;
        if (tr[u]! >= 0) {
          parent[u] = NONE;
          orphans.push(u);
        }
        break;
      }
      const v = neighbour(u, d);
      cap[u * 8 + d]! -= b;
      cap[v * 8 + OPP[d]!]! += b;
      if (cap[u * 8 + d]! <= 0) {
        parent[u] = NONE;
        orphans.push(u);
      }
      u = v;
    }
    // Adoption: orphans look for a new parent in their tree, or become free.
    while (orphans.length > 0) {
      const u = orphans.pop()!;
      const t = tree[u]!;
      let bestD = -1;
      let bestDist = Infinity;
      for (let d = 0; d < 8; d++) {
        const v = neighbour(u, d);
        if (v < 0 || tree[v] !== t) continue;
        const c = t === S ? cap[v * 8 + OPP[d]!]! : cap[u * 8 + d]!;
        if (c <= 0) continue;
        // Does v still reach its terminal? (stamped this round — known to.)
        let w = v;
        let steps = 0;
        let ok = false;
        for (;;) {
          if (stamp[w] === time) {
            steps += dist[w]!;
            ok = true;
            break;
          }
          const pd = parent[w]!;
          if (pd === TERMINAL) {
            stamp[w] = time;
            dist[w] = 1;
            steps += 1;
            ok = true;
            break;
          }
          if (pd === NONE) break;
          steps++;
          w = neighbour(w, pd);
        }
        if (!ok) continue;
        if (steps < bestDist) {
          bestDist = steps;
          bestD = d;
        }
        // Stamp the way, so the next orphans walk less.
        let x = v;
        let left = steps;
        while (stamp[x] !== time) {
          stamp[x] = time;
          dist[x] = left;
          left--;
          x = neighbour(x, parent[x]!);
        }
      }
      if (bestD >= 0) {
        parent[u] = bestD;
        stamp[u] = time;
        dist[u] = bestDist + 1;
        continue;
      }
      // No way back: u leaves its tree; its children are orphans, neighbours that could reach it wake up.
      for (let d = 0; d < 8; d++) {
        const v = neighbour(u, d);
        if (v < 0 || tree[v] !== t) continue;
        const c = t === S ? cap[v * 8 + OPP[d]!]! : cap[u * 8 + d]!;
        if (c > 0) push(v);
        if (parent[v] !== TERMINAL && parent[v] !== NONE && neighbour(v, parent[v]!) === u) {
          parent[v] = NONE;
          orphans.push(v);
        }
      }
      tree[u] = FREE;
      inActive[u] = 0;
    }
  }
  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = tree[p] === S ? 1 : 0;
  return out;
}

// ---------- GrabCut ----------

export interface CutOptions {
  /** Pixels known to be the object (1) or the background (2), 0 — unknown (strokes of the "Keep" and "Remove" brushes). */
  hints?: Uint8Array;
  iterations?: number;
  /** The previous cut (cutting again after a stroke): it is the start, and the edge stays as it decided — quicker. */
  previous?: Uint8Array;
}

/**
 * Splits a small picture (RGBA) into object (1) and background (0).
 *
 * The picture's edge is taken as background — except where the object goes out of the
 * frame (a portrait cut by the bottom edge, a face at the side): the first cut keeps the
 * bottom edge free, then every piece of the edge the object presses against is freed
 * and the cut repeated.
 */
export function grabCut(rgba: Uint8ClampedArray, width: number, height: number, options: CutOptions = {}): Uint8Array {
  const n = width * height;
  const pixels = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) {
    pixels[p * 3] = rgba[p * 4]!;
    pixels[p * 3 + 1] = rgba[p * 4 + 1]!;
    pixels[p * 3 + 2] = rgba[p * 4 + 2]!;
  }
  const hints = options.hints ?? new Uint8Array(n);
  const smooth = smoothness(pixels, width, height);
  const ring = Math.max(1, Math.round(Math.min(width, height) * 0.01));
  // The edge in pieces: side (0 top, 1 right, 2 bottom, 3 left) and place along it.
  const pieces = 16;
  const pieceOf = (x: number, y: number): number => {
    if (y < ring) return 0 * pieces + Math.min(pieces - 1, Math.floor((x / width) * pieces));
    if (x >= width - ring) return 1 * pieces + Math.min(pieces - 1, Math.floor((y / height) * pieces));
    if (y >= height - ring) return 2 * pieces + Math.min(pieces - 1, Math.floor((x / width) * pieces));
    if (x < ring) return 3 * pieces + Math.min(pieces - 1, Math.floor((y / height) * pieces));
    return -1;
  };
  const bottom = (piece: number) => piece >= 2 * pieces && piece < 3 * pieces;
  const run = (free: Uint8Array, start?: Uint8Array): Uint8Array => {
    const label = new Uint8Array(n);
    const fixed = new Uint8Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        const piece = pieceOf(x, y);
        if (hints[p] === 1) {
          label[p] = 1;
          fixed[p] = 1;
        } else if (hints[p] === 2 || rgba[p * 4 + 3]! < 16 || (piece >= 0 && !free[piece])) fixed[p] = 2;
        else label[p] = piece >= 0 || !start ? 1 : start[p]!;
      }
    }
    return cut(pixels, width, height, label, fixed, smooth, start ? 3 : (options.iterations ?? 5));
  };
  // 1. The bottom edge free (things stand on it, people are cut by it); cutting again after a
  // stroke — also the pieces of the edge that were object, starting from the previous cut.
  const free = new Uint8Array(pieces * 4);
  const share = (label: Uint8Array, from: number, to: number) => {
    const inside = new Float64Array(pieces * 4);
    const total = new Float64Array(pieces * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const depth = Math.min(x, y, width - 1 - x, height - 1 - y);
        if (depth < from || depth >= to) continue;
        // The piece of the nearest side.
        const piece = depth === y ? pieceOf(x, 0) : depth === width - 1 - x ? pieceOf(width - 1, y) : depth === height - 1 - y ? pieceOf(x, height - 1) : pieceOf(0, y);
        total[piece]! += 1;
        inside[piece]! += label[y * width + x]!;
      }
    }
    return Array.from(inside, (v, k) => (total[k]! > 0 ? v / total[k]! : 0));
  };
  for (let k = 0; k < pieces * 4; k++) if (bottom(k)) free[k] = 1;
  if (options.previous) share(options.previous, 0, ring).forEach((v, k) => v > 0.5 && (free[k] = 1));
  const first = run(free, options.previous);
  // 2. Pieces of the edge the object presses against (most of the band just inside is object) are freed too.
  let added = 0;
  share(first, ring, ring + 3).forEach((v, k) => {
    if (v > 0.5 && !free[k]) {
      free[k] = 1;
      added++;
    }
  });
  // Nothing new presses on the edge — done; the object everywhere on the edge — the cut found no object, keep the first.
  const freed = free.reduce((a, v) => a + v, 0);
  if (added === 0 || freed > pieces * 2.5) return first;
  return run(free, options.previous ? first : undefined);
}

/** Smoothness: strong across similar colours, weak across the picture's own edges (8 neighbours). */
function smoothness(pixels: Float32Array, width: number, height: number): Float64Array {
  const n = width * height;
  let sum = 0;
  let count = 0;
  const diff2 = (p: number, q: number) => (pixels[p * 3]! - pixels[q * 3]!) ** 2 + (pixels[p * 3 + 1]! - pixels[q * 3 + 1]!) ** 2 + (pixels[p * 3 + 2]! - pixels[q * 3 + 2]!) ** 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (x + 1 < width) {
        sum += diff2(p, p + 1);
        count++;
      }
      if (y + 1 < height) {
        sum += diff2(p, p + width);
        count++;
      }
    }
  }
  const beta = count > 0 && sum > 0 ? 1 / (2 * (sum / count)) : 0;
  const smooth = new Float64Array(n * 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      for (let d = 0; d < 8; d++) {
        const xx = x + DX[d]!;
        const yy = y + DY[d]!;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        smooth[p * 8 + d] = (GAMMA / (d % 2 === 1 ? Math.SQRT2 : 1)) * Math.exp(-beta * diff2(p, yy * width + xx));
      }
    }
  }
  return smooth;
}

const GAMMA = 50;

/** GrabCut's loop: learn both colour mixtures from the split, cut again, until it settles. */
function cut(pixels: Float32Array, width: number, height: number, label: Uint8Array, fixed: Uint8Array, smooth: Float64Array, iterations: number): Uint8Array {
  const n = width * height;
  const big = GAMMA * 9 + 1;
  const assign = new Uint8Array(n);
  const fg = new Int32Array(n);
  const bg = new Int32Array(n);
  let fgModel: Gaussian[] | null = null;
  let bgModel: Gaussian[] | null = null;
  for (let it = 0; it < iterations; it++) {
    let nf = 0;
    let nb = 0;
    for (let p = 0; p < n; p++) {
      if (label[p]) fg[nf++] = p;
      else bg[nb++] = p;
    }
    if (nf < K || nb < K) break;
    assignComponents(pixels, fg, nf, assign, fgModel);
    assignComponents(pixels, bg, nb, assign, bgModel);
    fgModel = fitGaussians(pixels, fg, nf, assign);
    bgModel = fitGaussians(pixels, bg, nb, assign);
    if (fgModel.length === 0 || bgModel.length === 0) break;
    const source = new Float64Array(n);
    const sink = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      if (fixed[p] === 1) source[p] = big;
      else if (fixed[p] === 2) sink[p] = big;
      else {
        // Paying the background's cost to call it object, and the other way round.
        source[p] = cost(bgModel, pixels[p * 3]!, pixels[p * 3 + 1]!, pixels[p * 3 + 2]!);
        sink[p] = cost(fgModel, pixels[p * 3]!, pixels[p * 3 + 1]!, pixels[p * 3 + 2]!);
      }
    }
    const next = gridMinCut(width, height, source, sink, smooth.slice());
    let changed = 0;
    for (let p = 0; p < n; p++) if (next[p] !== label[p]) changed++;
    label.set(next);
    if (changed < n * 0.001) break;
  }
  return keepMain(label, width, height, fixed);
}

/** Islands of object far from the main part (specks of background taken by mistake) go; the main parts and anything marked "keep" stay. */
function keepMain(label: Uint8Array, width: number, height: number, fixed: Uint8Array): Uint8Array {
  const n = width * height;
  const seen = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!label[s] || seen[s]! >= 0) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    seen[s] = id;
    while (head < tail) {
      const p = queue[head++]!;
      const x = p % width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q < 0 || q >= n || !label[q] || seen[q]! >= 0) continue;
        seen[q] = id;
        queue[tail++] = q;
      }
    }
    let marked = false;
    for (let k = 0; k < tail && !marked; k++) marked = fixed[queue[k]!] === 1;
    sizes.push(marked ? Infinity : tail);
  }
  const largest = Math.max(0, ...sizes.filter(Number.isFinite));
  for (let p = 0; p < n; p++) if (label[p] && sizes[seen[p]!]! < largest * 0.04) label[p] = 0;
  return label;
}

// ---------- Soft edge at full size ----------

/** Box mean over a (2r+1) square, by summed-area table. */
export function boxMeanOf(src: Float32Array, width: number, height: number, r: number): Float32Array {
  return boxMean(src, width, height, r);
}

function boxMean(src: Float32Array, width: number, height: number, r: number): Float32Array {
  const sat = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += src[y * width + x]!;
      sat[(y + 1) * (width + 1) + x + 1] = sat[y * (width + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(height, y + r + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width, x + r + 1);
      const s = sat[y1 * (width + 1) + x1]! - sat[y0 * (width + 1) + x1]! - sat[y1 * (width + 1) + x0]! + sat[y0 * (width + 1) + x0]!;
      out[y * width + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/**
 * A guided filter (He, Sun, Tang) on a rough mask with the picture's brightness as the
 * guide: the mask's edge snaps to the picture's edges and becomes soft where they are
 * (hair, fur, blur). Returns alpha 0..1.
 */
export function refineMask(rgba: Uint8ClampedArray, width: number, height: number, rough: Float32Array, radius: number, eps = 1e-3): Float32Array {
  const n = width * height;
  const I = new Float32Array(n);
  for (let p = 0; p < n; p++) I[p] = (0.299 * rgba[p * 4]! + 0.587 * rgba[p * 4 + 1]! + 0.114 * rgba[p * 4 + 2]!) / 255;
  const II = new Float32Array(n);
  const Ip = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    II[p] = I[p]! * I[p]!;
    Ip[p] = I[p]! * rough[p]!;
  }
  const mI = boxMean(I, width, height, radius);
  const mP = boxMean(rough, width, height, radius);
  const mII = boxMean(II, width, height, radius);
  const mIp = boxMean(Ip, width, height, radius);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const varI = mII[p]! - mI[p]! * mI[p]!;
    const cov = mIp[p]! - mI[p]! * mP[p]!;
    a[p] = cov / (varI + eps);
    b[p] = mP[p]! - a[p]! * mI[p]!;
  }
  const ma = boxMean(a, width, height, radius);
  const mb = boxMean(b, width, height, radius);
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) out[p] = Math.min(1, Math.max(0, ma[p]! * I[p]! + mb[p]!));
  return out;
}
