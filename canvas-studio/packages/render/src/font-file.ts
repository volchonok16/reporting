// Reading font files (TTF, OTF, TTC; WOFF through `unwrapWoff`) — our own
// reader, no libraries: what the text panel needs to know about a font (its
// OpenType features with their names, its variation axes, cap height) and the
// outlines of its glyphs for "text as outlines" in SVG. TrueType outlines
// follow the variation axes (gvar); CFF outlines are the default instance.

export interface FontAxis {
  tag: string;
  name: string;
  min: number;
  default: number;
  max: number;
  hidden: boolean;
}

export interface FontInfo {
  family: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  capHeight: number;
  xHeight: number;
  /** OpenType feature tags the font has (GSUB and GPOS), each once. */
  features: string[];
  /** Names the font gives its stylistic sets and character variants (ss01 → «Open digits»). */
  featureNames: Record<string, string>;
  axes: FontAxis[];
}

/** One glyph's outline in font units (y up), as SVG path commands. */
export interface GlyphOutline {
  path: string;
  advance: number;
}

const tag = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
const fixed = (v: DataView, o: number) => v.getInt32(o) / 65536;
const f2dot14 = (v: DataView, o: number) => v.getInt16(o) / 16384;

/** WOFF (1.0) to plain sfnt bytes; anything else back as it is. WOFF2 is not read (null). */
export async function unwrapWoff(bytes: Uint8Array): Promise<Uint8Array | null> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = tag(v, 0);
  if (sig === 'wOF2') return null;
  if (sig !== 'wOFF') return bytes;
  const num = v.getUint16(12);
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < num; i++) {
    const o = 44 + i * 20;
    const offset = v.getUint32(o + 4);
    const comp = v.getUint32(o + 8);
    const orig = v.getUint32(o + 12);
    let data = bytes.subarray(offset, offset + comp);
    if (comp !== orig) data = new Uint8Array(await new Response(new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    tables.push({ tag: tag(v, o), data });
  }
  return buildSfnt(v.getUint32(4), tables);
}

function buildSfnt(flavor: number, tables: { tag: string; data: Uint8Array }[]): Uint8Array {
  const head = 12 + tables.length * 16;
  let size = head;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, flavor);
  v.setUint16(4, tables.length);
  let at = head;
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[o + k] = t.tag.charCodeAt(k);
    v.setUint32(o + 8, at);
    v.setUint32(o + 12, t.data.length);
    out.set(t.data, at);
    at += (t.data.length + 3) & ~3;
  });
  return out;
}

export class FontFile {
  readonly info: FontInfo;
  private readonly v: DataView;
  private readonly tables = new Map<string, { offset: number; length: number }>();
  private readonly cmap = new Map<number, number>();
  private readonly glyphCache = new Map<string, GlyphOutline | null>();
  private numGlyphs = 0;
  private longLoca = false;
  private numHMetrics = 0;
  private cff: Cff | null = null;

  /** Throws on bytes that are not a font. `index` picks a font inside a collection (.ttc). */
  constructor(bytes: Uint8Array, index = 0) {
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.v;
    let start = 0;
    if (tag(v, 0) === 'ttcf') start = v.getUint32(12 + Math.min(index, v.getUint32(8) - 1) * 4);
    const sig = v.getUint32(start);
    if (sig !== 0x00010000 && tag(v, start) !== 'OTTO' && tag(v, start) !== 'true') throw new Error('not a font');
    const count = v.getUint16(start + 4);
    for (let i = 0; i < count; i++) {
      const o = start + 12 + i * 16;
      this.tables.set(tag(v, o), { offset: v.getUint32(o + 8), length: v.getUint32(o + 12) });
    }
    const head = this.t('head');
    const hhea = this.t('hhea');
    const maxp = this.t('maxp');
    if (head === null || hhea === null || maxp === null) throw new Error('not a font');
    const upm = v.getUint16(head + 18);
    this.longLoca = v.getInt16(head + 50) === 1;
    this.numGlyphs = v.getUint16(maxp + 4);
    this.numHMetrics = v.getUint16(hhea + 34);
    let ascender = v.getInt16(hhea + 4);
    let descender = v.getInt16(hhea + 6);
    let capHeight = Math.round(upm * 0.7);
    let xHeight = Math.round(upm * 0.5);
    const os2 = this.t('OS/2');
    if (os2 !== null) {
      const version = v.getUint16(os2);
      ascender = v.getInt16(os2 + 68);
      descender = v.getInt16(os2 + 70);
      if (version >= 2) {
        xHeight = v.getInt16(os2 + 86) || xHeight;
        capHeight = v.getInt16(os2 + 88) || capHeight;
      }
    }
    this.readCmap();
    const cffAt = this.t('CFF ');
    if (cffAt !== null) this.cff = new Cff(v, cffAt);
    const names = this.readNames();
    const { features, featureNames } = this.readFeatures(names);
    this.info = {
      family: names.get(16) ?? names.get(1) ?? '',
      unitsPerEm: upm,
      ascender,
      descender,
      capHeight,
      xHeight,
      features,
      featureNames,
      axes: this.readAxes(names),
    };
  }

  private t(name: string): number | null {
    return this.tables.get(name)?.offset ?? null;
  }

  // ---------- names ----------

  /** Name records by id: Russian, then English, then whatever there is. */
  private readNames(): Map<number, string> {
    const v = this.v;
    const out = new Map<number, { text: string; rank: number }>();
    const at = this.t('name');
    if (at === null) return new Map();
    const count = v.getUint16(at + 2);
    const strings = at + v.getUint16(at + 4);
    for (let i = 0; i < count; i++) {
      const o = at + 6 + i * 12;
      const platform = v.getUint16(o);
      const lang = v.getUint16(o + 4);
      const id = v.getUint16(o + 6);
      const len = v.getUint16(o + 8);
      const off = strings + v.getUint16(o + 10);
      let text = '';
      let rank = 9;
      if (platform === 3 || platform === 0) {
        for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(v.getUint16(off + k));
        rank = lang === 0x0419 ? 0 : lang === 0x0409 || platform === 0 ? 1 : 3;
      } else if (platform === 1) {
        for (let k = 0; k < len; k++) text += String.fromCharCode(v.getUint8(off + k));
        rank = lang === 0 ? 2 : 4;
      } else continue;
      const prev = out.get(id);
      if (!prev || rank < prev.rank) out.set(id, { text, rank });
    }
    return new Map([...out].map(([k, x]) => [k, x.text]));
  }

  // ---------- features and axes ----------

  private readFeatures(names: Map<number, string>): { features: string[]; featureNames: Record<string, string> } {
    const v = this.v;
    const seen = new Set<string>();
    const featureNames: Record<string, string> = {};
    for (const table of ['GSUB', 'GPOS']) {
      const at = this.t(table);
      if (at === null) continue;
      const list = at + v.getUint16(at + 6);
      const count = v.getUint16(list);
      for (let i = 0; i < count; i++) {
        const t = tag(v, list + 2 + i * 6);
        seen.add(t);
        const feature = list + v.getUint16(list + 2 + i * 6 + 4);
        const params = v.getUint16(feature);
        if (!params) continue;
        // ssXX: version, uiNameID; cvXX: format, featUiLabelNameId.
        const nameId = /^ss\d\d$|^cv\d\d$/.test(t) ? v.getUint16(feature + params + 2) : 0;
        const name = nameId ? names.get(nameId) : undefined;
        if (name) featureNames[t] = name;
      }
    }
    return { features: [...seen].sort(), featureNames };
  }

  private axisNames: FontAxis[] = [];

  private readAxes(names: Map<number, string>): FontAxis[] {
    const v = this.v;
    const at = this.t('fvar');
    if (at === null) return [];
    const first = at + v.getUint16(at + 4);
    const count = v.getUint16(at + 8);
    const size = v.getUint16(at + 10);
    const axes: FontAxis[] = [];
    for (let i = 0; i < count; i++) {
      const o = first + i * size;
      const t = tag(v, o);
      axes.push({ tag: t, min: fixed(v, o + 4), default: fixed(v, o + 8), max: fixed(v, o + 12), hidden: (v.getUint16(o + 16) & 1) === 1, name: names.get(v.getUint16(o + 18)) ?? t });
    }
    this.axisNames = axes;
    return axes;
  }

  /** User axis values → normalized −1..1 coordinates (with the font's avar mapping), in fvar order. */
  normalize(values: Record<string, number>): number[] {
    const v = this.v;
    const coords = this.axisNames.map((a) => {
      const x = Math.min(a.max, Math.max(a.min, values[a.tag] ?? a.default));
      if (x < a.default) return a.default === a.min ? 0 : (x - a.default) / (a.default - a.min);
      return a.max === a.default ? 0 : (x - a.default) / (a.max - a.default);
    });
    const avar = this.t('avar');
    if (avar === null) return coords;
    let o = avar + 8;
    return coords.map((c) => {
      const n = v.getUint16(o);
      const maps: [number, number][] = [];
      for (let i = 0; i < n; i++) maps.push([f2dot14(v, o + 2 + i * 4), f2dot14(v, o + 4 + i * 4)]);
      o += 2 + n * 4;
      for (let i = 1; i < maps.length; i++) {
        const [a0, b0] = maps[i - 1]!;
        const [a1, b1] = maps[i]!;
        if (c <= a1) return a1 === a0 ? b0 : b0 + ((c - a0) * (b1 - b0)) / (a1 - a0);
      }
      return c;
    });
  }

  // ---------- characters to glyphs ----------

  private readCmap(): void {
    const v = this.v;
    const at = this.t('cmap');
    if (at === null) return;
    const count = v.getUint16(at + 2);
    let best = -1;
    let bestRank = 9;
    for (let i = 0; i < count; i++) {
      const o = at + 4 + i * 8;
      const platform = v.getUint16(o);
      const encoding = v.getUint16(o + 2);
      const sub = at + v.getUint32(o + 4);
      const format = v.getUint16(sub);
      const rank = format === 12 ? 0 : platform === 3 && encoding === 1 ? 1 : platform === 0 ? 2 : 9;
      if ((format === 4 || format === 12) && rank < bestRank) {
        best = sub;
        bestRank = rank;
      }
    }
    if (best < 0) return;
    if (v.getUint16(best) === 12) {
      const groups = v.getUint32(best + 12);
      for (let i = 0; i < groups; i++) {
        const o = best + 16 + i * 12;
        const startChar = v.getUint32(o);
        const end = Math.min(v.getUint32(o + 4), startChar + 0x10000);
        const glyph = v.getUint32(o + 8);
        for (let c = startChar; c <= end; c++) this.cmap.set(c, glyph + c - startChar);
      }
      return;
    }
    const segs = v.getUint16(best + 6) / 2;
    const ends = best + 14;
    const starts = ends + segs * 2 + 2;
    const deltas = starts + segs * 2;
    const ranges = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      const end = v.getUint16(ends + s * 2);
      const startChar = v.getUint16(starts + s * 2);
      const delta = v.getInt16(deltas + s * 2);
      const range = v.getUint16(ranges + s * 2);
      for (let c = startChar; c <= end && c !== 0xffff; c++) {
        let g: number;
        if (range === 0) g = (c + delta) & 0xffff;
        else {
          const o = ranges + s * 2 + range + (c - startChar) * 2;
          g = v.getUint16(o);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g !== 0) this.cmap.set(c, g);
      }
    }
  }

  glyphId(codePoint: number): number {
    return this.cmap.get(codePoint) ?? 0;
  }

  advance(glyph: number): number {
    const at = this.t('hmtx');
    if (at === null) return 0;
    return this.v.getUint16(at + Math.min(glyph, this.numHMetrics - 1) * 4);
  }

  // ---------- outlines ----------

  /** The outline of a character's glyph at the axis values given (none — the default instance). */
  outline(codePoint: number, axes: Record<string, number> = {}): GlyphOutline | null {
    const glyph = this.glyphId(codePoint);
    const key = `${glyph}|${JSON.stringify(axes)}`;
    if (this.glyphCache.has(key)) return this.glyphCache.get(key)!;
    let result: GlyphOutline | null = null;
    if (this.cff) {
      const path = this.cff.glyph(glyph);
      result = path === null ? null : { path, advance: this.advance(glyph) };
    } else {
      const coords = this.axisNames.length && Object.keys(axes).length ? this.normalize(axes) : null;
      const contours = this.glyfContours(glyph, coords, 0);
      result = contours ? { path: quadPath(contours), advance: this.advance(glyph) } : null;
    }
    if (this.glyphCache.size > 4000) this.glyphCache.clear();
    this.glyphCache.set(key, result);
    return result;
  }

  private glyphRange(glyph: number): { at: number; len: number } | null {
    const v = this.v;
    const loca = this.t('loca');
    const glyf = this.t('glyf');
    if (loca === null || glyf === null || glyph >= this.numGlyphs) return null;
    const a = this.longLoca ? v.getUint32(loca + glyph * 4) : v.getUint16(loca + glyph * 2) * 2;
    const b = this.longLoca ? v.getUint32(loca + glyph * 4 + 4) : v.getUint16(loca + glyph * 2 + 2) * 2;
    return { at: glyf + a, len: b - a };
  }

  /** Contours of a TrueType glyph: points with on-curve flags, deltas for the axes applied, components placed. */
  private glyfContours(glyph: number, coords: number[] | null, depth: number): Point[][] | null {
    const v = this.v;
    const range = this.glyphRange(glyph);
    if (!range) return null;
    if (range.len === 0) return [];
    const o = range.at;
    const n = v.getInt16(o);
    if (n >= 0) {
      const ends: number[] = [];
      for (let i = 0; i < n; i++) ends.push(v.getUint16(o + 10 + i * 2));
      const total = n ? ends[n - 1]! + 1 : 0;
      let p = o + 10 + n * 2;
      p += 2 + v.getUint16(p);
      const flags: number[] = [];
      while (flags.length < total) {
        const f = v.getUint8(p++);
        flags.push(f);
        if (f & 8) {
          const r = v.getUint8(p++);
          for (let k = 0; k < r; k++) flags.push(f);
        }
      }
      const xs: number[] = [];
      let x = 0;
      for (const f of flags) {
        if (f & 2) {
          const d = v.getUint8(p++);
          x += f & 16 ? d : -d;
        } else if (!(f & 16)) {
          x += v.getInt16(p);
          p += 2;
        }
        xs.push(x);
      }
      const ys: number[] = [];
      let y = 0;
      for (const f of flags) {
        if (f & 4) {
          const d = v.getUint8(p++);
          y += f & 32 ? d : -d;
        } else if (!(f & 32)) {
          y += v.getInt16(p);
          p += 2;
        }
        ys.push(y);
      }
      const points: Point[] = flags.map((f, i) => ({ x: xs[i]!, y: ys[i]!, on: (f & 1) === 1 }));
      if (coords) this.applyDeltas(glyph, points, ends, coords);
      const contours: Point[][] = [];
      let from = 0;
      for (const end of ends) {
        contours.push(points.slice(from, end + 1));
        from = end + 1;
      }
      return contours;
    }
    // A composite: other glyphs, moved (and maybe scaled).
    if (depth > 8) return [];
    const out: Point[][] = [];
    let p = o + 10;
    const parts: { glyph: number; dx: number; dy: number; m: [number, number, number, number] }[] = [];
    for (;;) {
      const flags = v.getUint16(p);
      const g = v.getUint16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (flags & 1) {
        dx = flags & 2 ? v.getInt16(p) : v.getUint16(p);
        dy = flags & 2 ? v.getInt16(p + 2) : v.getUint16(p + 2);
        p += 4;
      } else {
        dx = flags & 2 ? v.getInt8(p) : v.getUint8(p);
        dy = flags & 2 ? v.getInt8(p + 1) : v.getUint8(p + 1);
        p += 2;
      }
      let m: [number, number, number, number] = [1, 0, 0, 1];
      if (flags & 8) {
        const s = f2dot14(v, p);
        m = [s, 0, 0, s];
        p += 2;
      } else if (flags & 0x40) {
        m = [f2dot14(v, p), 0, 0, f2dot14(v, p + 2)];
        p += 4;
      } else if (flags & 0x80) {
        m = [f2dot14(v, p), f2dot14(v, p + 2), f2dot14(v, p + 4), f2dot14(v, p + 6)];
        p += 8;
      }
      // Point-matched components (flag 2 off) are rare; they are placed at their origin.
      if (!(flags & 2)) {
        dx = 0;
        dy = 0;
      }
      parts.push({ glyph: g, dx, dy, m });
      if (!(flags & 0x20)) break;
    }
    // Axis deltas of a composite move its components.
    if (coords) {
      const offsets: Point[] = parts.map((c) => ({ x: c.dx, y: c.dy, on: true }));
      this.applyDeltas(glyph, offsets, offsets.map((_, i) => i), coords, true);
      offsets.forEach((pt, i) => {
        parts[i]!.dx = pt.x;
        parts[i]!.dy = pt.y;
      });
    }
    for (const c of parts) {
      const sub = this.glyfContours(c.glyph, coords, depth + 1) ?? [];
      for (const contour of sub) out.push(contour.map((q) => ({ x: q.x * c.m[0] + q.y * c.m[2] + c.dx, y: q.x * c.m[1] + q.y * c.m[3] + c.dy, on: q.on })));
    }
    return out;
  }

  /** gvar: moves the points for the axis coordinates (untouched points of a contour are interpolated). */
  private applyDeltas(glyph: number, points: Point[], ends: number[], coords: number[], composite = false): void {
    const v = this.v;
    const gvar = this.t('gvar');
    if (gvar === null) return;
    const axisCount = v.getUint16(gvar + 4);
    const sharedCount = v.getUint16(gvar + 6);
    const shared = gvar + v.getUint32(gvar + 8);
    const longOffsets = (v.getUint16(gvar + 14) & 1) === 1;
    const dataStart = gvar + v.getUint32(gvar + 16);
    const off = (i: number) => (longOffsets ? v.getUint32(gvar + 20 + i * 4) : v.getUint16(gvar + 20 + i * 2) * 2);
    const a = off(glyph);
    const b = off(glyph + 1);
    if (a === b) return;
    const base = dataStart + a;
    const tupleCount = v.getUint16(base);
    const count = tupleCount & 0x0fff;
    let serialized = base + v.getUint16(base + 2);
    // All points plus four phantom ones (metrics), as gvar counts them.
    const total = points.length + 4;
    let sharedPoints: number[] | null = null;
    if (tupleCount & 0x8000) {
      const r = readPoints(v, serialized, total);
      sharedPoints = r.points;
      serialized = r.next;
    }
    let h = base + 4;
    const dx = new Float64Array(points.length);
    const dy = new Float64Array(points.length);
    for (let t = 0; t < count; t++) {
      const size = v.getUint16(h);
      const index = v.getUint16(h + 2);
      h += 4;
      let peak: number[];
      if (index & 0x8000) {
        peak = [];
        for (let k = 0; k < axisCount; k++) peak.push(f2dot14(v, h + k * 2));
        h += axisCount * 2;
      } else {
        const s = shared + (index & 0x0fff) * axisCount * 2;
        peak = [];
        for (let k = 0; k < axisCount && (index & 0x0fff) < sharedCount; k++) peak.push(f2dot14(v, s + k * 2));
      }
      let lo: number[] | null = null;
      let hi: number[] | null = null;
      if (index & 0x4000) {
        lo = [];
        hi = [];
        for (let k = 0; k < axisCount; k++) lo.push(f2dot14(v, h + k * 2));
        h += axisCount * 2;
        for (let k = 0; k < axisCount; k++) hi.push(f2dot14(v, h + k * 2));
        h += axisCount * 2;
      }
      const data = serialized;
      serialized += size;
      // How much this tuple applies at the coordinates.
      let scalar = 1;
      for (let k = 0; k < axisCount && scalar !== 0; k++) {
        const pk = peak[k] ?? 0;
        const c = coords[k] ?? 0;
        if (pk === 0) continue;
        if (c === 0 || (c < 0 && pk > 0) || (c > 0 && pk < 0)) {
          scalar = 0;
          break;
        }
        const l = lo ? lo[k]! : Math.min(0, pk);
        const u = hi ? hi[k]! : Math.max(0, pk);
        if (c < l || c > u) scalar = 0;
        else if (c < pk) scalar *= (c - l) / (pk - l || 1);
        else if (c > pk) scalar *= (u - c) / (u - pk || 1);
      }
      if (scalar === 0) continue;
      let p = data;
      let which: number[] | null = sharedPoints;
      if (index & 0x2000) {
        const r = readPoints(v, p, total);
        which = r.points;
        p = r.next;
      }
      const n = which ? which.length : total;
      const xs = readDeltas(v, p, n);
      const ys = readDeltas(v, xs.next, n);
      if (!which) {
        for (let i = 0; i < points.length; i++) {
          dx[i]! += xs.values[i]! * scalar;
          dy[i]! += ys.values[i]! * scalar;
        }
        continue;
      }
      // Some points only: the others of each contour follow by interpolation (IUP).
      const tx = new Float64Array(points.length);
      const ty = new Float64Array(points.length);
      const touched = new Uint8Array(points.length);
      which.forEach((pt, i) => {
        if (pt >= points.length) return;
        tx[pt] = xs.values[i]!;
        ty[pt] = ys.values[i]!;
        touched[pt] = 1;
      });
      if (!composite) interpolateUntouched(points, ends, tx, ty, touched);
      for (let i = 0; i < points.length; i++) {
        dx[i]! += tx[i]! * scalar;
        dy[i]! += ty[i]! * scalar;
      }
    }
    for (let i = 0; i < points.length; i++) {
      points[i]!.x += dx[i]!;
      points[i]!.y += dy[i]!;
    }
  }
}

interface Point {
  x: number;
  y: number;
  on: boolean;
}

function readPoints(v: DataView, at: number, total: number): { points: number[] | null; next: number } {
  let p = at;
  let count = v.getUint8(p++);
  if (count & 0x80) count = ((count & 0x7f) << 8) | v.getUint8(p++);
  if (count === 0) return { points: null, next: p };
  const points: number[] = [];
  let last = 0;
  while (points.length < count) {
    const head = v.getUint8(p++);
    const run = (head & 0x7f) + 1;
    const words = (head & 0x80) !== 0;
    for (let i = 0; i < run && points.length < count; i++) {
      last += words ? v.getUint16(p) : v.getUint8(p);
      p += words ? 2 : 1;
      points.push(last);
    }
  }
  void total;
  return { points, next: p };
}

function readDeltas(v: DataView, at: number, count: number): { values: number[]; next: number } {
  const values: number[] = [];
  let p = at;
  while (values.length < count) {
    const head = v.getUint8(p++);
    const run = (head & 0x3f) + 1;
    for (let i = 0; i < run && values.length < count; i++) {
      if (head & 0x80) values.push(0);
      else if (head & 0x40) {
        values.push(v.getInt16(p));
        p += 2;
      } else values.push(v.getInt8(p++));
    }
  }
  return { values, next: p };
}

/** IUP: a point without its own delta moves like its touched neighbours on the contour (between them — in proportion). */
function interpolateUntouched(points: Point[], ends: number[], dx: Float64Array, dy: Float64Array, touched: Uint8Array): void {
  let start = 0;
  for (const end of ends) {
    const idx: number[] = [];
    for (let i = start; i <= end; i++) if (touched[i]) idx.push(i);
    const size = end - start + 1;
    if (idx.length === 1) {
      for (let i = start; i <= end; i++) {
        dx[i] = dx[idx[0]!]!;
        dy[i] = dy[idx[0]!]!;
      }
    } else if (idx.length > 1 && idx.length < size) {
      for (let k = 0; k < idx.length; k++) {
        const p1 = idx[k]!;
        const p2 = idx[(k + 1) % idx.length]!;
        for (let i = p1 === end ? start : p1 + 1; i !== p2; i = i === end ? start : i + 1) {
          dx[i] = iup(points[i]!.x, points[p1]!.x, points[p2]!.x, dx[p1]!, dx[p2]!);
          dy[i] = iup(points[i]!.y, points[p1]!.y, points[p2]!.y, dy[p1]!, dy[p2]!);
        }
      }
    }
    start = end + 1;
  }
}

/** One coordinate of an untouched point between two touched ones (outside them it moves with the nearer). */
function iup(c: number, c1: number, c2: number, d1: number, d2: number): number {
  if (c1 === c2) return d1 === d2 ? d1 : 0;
  const [lo, hi, dlo, dhi] = c1 < c2 ? [c1, c2, d1, d2] : [c2, c1, d2, d1];
  if (c <= lo) return dlo;
  if (c >= hi) return dhi;
  return dlo + ((c - lo) * (dhi - dlo)) / (hi - lo);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** TrueType contours (quadratic, implied on-curve points between two off-curve ones) as an SVG path. */
function quadPath(contours: Point[][]): string {
  let out = '';
  for (const c of contours) {
    if (c.length === 0) continue;
    // Start on an on-curve point (or the middle of the first two off-curve ones).
    let first = c.findIndex((p) => p.on);
    let pts = c;
    if (first < 0) {
      const mid = { x: (c[0]!.x + c[1 % c.length]!.x) / 2, y: (c[0]!.y + c[1 % c.length]!.y) / 2, on: true };
      pts = [mid, ...c.slice(1), c[0]!];
      first = 0;
    } else pts = [...c.slice(first), ...c.slice(0, first)];
    out += `M${r1(pts[0]!.x)} ${r1(pts[0]!.y)}`;
    for (let i = 1; i <= pts.length; i++) {
      const p = pts[i % pts.length]!;
      if (p.on) {
        out += `L${r1(p.x)} ${r1(p.y)}`;
        continue;
      }
      const next = pts[(i + 1) % pts.length]!;
      const end = next.on ? next : { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
      out += `Q${r1(p.x)} ${r1(p.y)} ${r1(end.x)} ${r1(end.y)}`;
      if (next.on) i++;
    }
    out += 'Z';
  }
  return out;
}

// ---------- CFF (OpenType with PostScript outlines) ----------

class Cff {
  private readonly v: DataView;
  private readonly charStrings: number[];
  private readonly gsubrs: number[];
  private readonly subrs: number[];
  /** CID fonts: each glyph's own local subroutines. */
  private readonly fdSubrs: number[][] = [];
  private readonly fdSelect: ((g: number) => number) | null = null;

  constructor(v: DataView, at: number) {
    this.v = v;
    const hdrSize = v.getUint8(at + 2);
    const names = index(v, at + hdrSize);
    const tops = index(v, names.end);
    const strings = index(v, tops.end);
    const gsubrs = index(v, strings.end);
    this.gsubrs = gsubrs.items;
    const top = dict(v, tops.items[0]!, tops.items[1]!);
    this.charStrings = index(v, at + (top.get(17)?.[0] ?? 0)).items;
    const privateOf = (d: Map<number, number[]>): number[] => {
      const p = d.get(18);
      if (!p) return [];
      const [size, off] = p as [number, number];
      const pd = dict(v, at + off, at + off + size);
      const s = pd.get(19);
      return s ? index(v, at + off + s[0]!).items : [];
    };
    this.subrs = privateOf(top);
    const fdArray = top.get(12 * 256 + 36);
    const fdSel = top.get(12 * 256 + 37);
    if (fdArray && fdSel) {
      const fds = index(v, at + fdArray[0]!);
      for (let i = 0; i + 1 < fds.items.length; i++) this.fdSubrs.push(privateOf(dict(v, fds.items[i]!, fds.items[i + 1]!)));
      const s = at + fdSel[0]!;
      const format = v.getUint8(s);
      if (format === 0) this.fdSelect = (g) => v.getUint8(s + 1 + g);
      else if (format === 3) {
        const n = v.getUint16(s + 1);
        this.fdSelect = (g) => {
          for (let i = 0; i < n; i++) {
            const first = v.getUint16(s + 3 + i * 3);
            const next = v.getUint16(s + 3 + (i + 1) * 3);
            if (g >= first && g < next) return v.getUint8(s + 5 + i * 3);
          }
          return 0;
        };
      }
    }
  }

  glyph(g: number): string | null {
    if (g + 1 >= this.charStrings.length) return null;
    const subrs = this.fdSelect ? (this.fdSubrs[this.fdSelect(g)] ?? []) : this.subrs;
    return charString(this.v, this.charStrings[g]!, this.charStrings[g + 1]!, this.gsubrs, subrs);
  }
}

/** A CFF INDEX: absolute offsets of its items (one more than items: the end). */
function index(v: DataView, at: number): { items: number[]; end: number } {
  const count = v.getUint16(at);
  if (count === 0) return { items: [], end: at + 2 };
  const size = v.getUint8(at + 2);
  const read = (o: number) => {
    let x = 0;
    for (let k = 0; k < size; k++) x = x * 256 + v.getUint8(o + k);
    return x;
  };
  const base = at + 3 + (count + 1) * size - 1;
  const items: number[] = [];
  for (let i = 0; i <= count; i++) items.push(base + read(at + 3 + i * size));
  return { items, end: items[count]! };
}

function dict(v: DataView, from: number, to: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let ops: number[] = [];
  let p = from;
  while (p < to) {
    const b = v.getUint8(p);
    if (b <= 21) {
      let op = b;
      p++;
      if (b === 12) op = 12 * 256 + v.getUint8(p++);
      out.set(op, ops);
      ops = [];
    } else if (b === 28) {
      ops.push(v.getInt16(p + 1));
      p += 3;
    } else if (b === 29) {
      ops.push(v.getInt32(p + 1));
      p += 5;
    } else if (b === 30) {
      // A real number: nibbles; only skipped (no outline needs one).
      p++;
      for (;;) {
        const n = v.getUint8(p++);
        if ((n & 15) === 15 || n >> 4 === 15) break;
      }
      ops.push(0);
    } else if (b >= 32 && b <= 246) {
      ops.push(b - 139);
      p++;
    } else if (b >= 247 && b <= 250) {
      ops.push((b - 247) * 256 + v.getUint8(p + 1) + 108);
      p += 2;
    } else if (b >= 251 && b <= 254) {
      ops.push(-(b - 251) * 256 - v.getUint8(p + 1) - 108);
      p += 2;
    } else p++;
  }
  return out;
}

const bias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

/** A Type 2 charstring → SVG path (cubic curves). */
function charString(v: DataView, from: number, to: number, gsubrs: number[], subrs: number[]): string {
  let out = '';
  const stack: number[] = [];
  let x = 0;
  let y = 0;
  let stems = 0;
  let open = false;
  let width = false;
  const move = (dx: number, dy: number) => {
    if (open) out += 'Z';
    x += dx;
    y += dy;
    out += `M${r1(x)} ${r1(y)}`;
    open = true;
  };
  const line = (dx: number, dy: number) => {
    x += dx;
    y += dy;
    out += `L${r1(x)} ${r1(y)}`;
  };
  const curve = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const x1 = x + a;
    const y1 = y + b;
    const x2 = x1 + c;
    const y2 = y1 + d;
    x = x2 + e;
    y = y2 + f;
    out += `C${r1(x1)} ${r1(y1)} ${r1(x2)} ${r1(y2)} ${r1(x)} ${r1(y)}`;
  };
  // The first stack-clearing operator may carry the glyph's width first: dropped.
  const takeWidth = (even: boolean) => {
    if (!width && stack.length % 2 === (even ? 1 : 0)) stack.shift();
    width = true;
  };
  let depth = 0;
  const run = (start: number, end: number): boolean => {
    if (++depth > 10) return true;
    let p = start;
    while (p < end) {
      const b = v.getUint8(p++);
      if (b >= 32 || b === 28) {
        if (b === 28) {
          stack.push(v.getInt16(p));
          p += 2;
        } else if (b <= 246) stack.push(b - 139);
        else if (b <= 250) stack.push((b - 247) * 256 + v.getUint8(p++) + 108);
        else if (b <= 254) stack.push(-(b - 251) * 256 - v.getUint8(p++) - 108);
        else {
          stack.push(v.getInt32(p) / 65536);
          p += 4;
        }
        continue;
      }
      switch (b) {
        case 1: case 3: case 18: case 23:
          takeWidth(true);
          stems += stack.length >> 1;
          stack.length = 0;
          break;
        case 19: case 20:
          takeWidth(true);
          stems += stack.length >> 1;
          stack.length = 0;
          p += (stems + 7) >> 3;
          break;
        case 21:
          takeWidth(false);
          move(stack[0]!, stack[1]!);
          stack.length = 0;
          break;
        case 22:
          if (!width && stack.length > 1) stack.shift();
          width = true;
          move(stack[0]!, 0);
          stack.length = 0;
          break;
        case 4:
          if (!width && stack.length > 1) stack.shift();
          width = true;
          move(0, stack[0]!);
          stack.length = 0;
          break;
        case 5:
          for (let i = 0; i + 1 < stack.length; i += 2) line(stack[i]!, stack[i + 1]!);
          stack.length = 0;
          break;
        case 6: case 7: {
          let horizontal = b === 6;
          for (const d of stack) {
            line(horizontal ? d : 0, horizontal ? 0 : d);
            horizontal = !horizontal;
          }
          stack.length = 0;
          break;
        }
        case 8:
          for (let i = 0; i + 5 < stack.length; i += 6) curve(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          stack.length = 0;
          break;
        case 24: {
          let i = 0;
          for (; i + 7 < stack.length; i += 6) curve(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          line(stack[i]!, stack[i + 1]!);
          stack.length = 0;
          break;
        }
        case 25: {
          let i = 0;
          for (; i + 7 < stack.length; i += 2) line(stack[i]!, stack[i + 1]!);
          curve(stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, stack[i + 4]!, stack[i + 5]!);
          stack.length = 0;
          break;
        }
        case 26: {
          let i = 0;
          let dx1 = 0;
          if (stack.length % 2) dx1 = stack[i++]!;
          for (; i + 3 < stack.length; i += 4) {
            curve(dx1, stack[i]!, stack[i + 1]!, stack[i + 2]!, 0, stack[i + 3]!);
            dx1 = 0;
          }
          stack.length = 0;
          break;
        }
        case 27: {
          let i = 0;
          let dy1 = 0;
          if (stack.length % 2) dy1 = stack[i++]!;
          for (; i + 3 < stack.length; i += 4) {
            curve(stack[i]!, dy1, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, 0);
            dy1 = 0;
          }
          stack.length = 0;
          break;
        }
        case 30: case 31: {
          let vertical = b === 30;
          let i = 0;
          while (i + 3 < stack.length) {
            const last = stack.length - i === 5;
            if (vertical) curve(0, stack[i]!, stack[i + 1]!, stack[i + 2]!, stack[i + 3]!, last ? stack[i + 4]! : 0);
            else curve(stack[i]!, 0, stack[i + 1]!, stack[i + 2]!, last ? stack[i + 4]! : 0, stack[i + 3]!);
            i += 4;
            vertical = !vertical;
          }
          stack.length = 0;
          break;
        }
        case 10: case 29: {
          const n = stack.pop()!;
          const list = b === 10 ? subrs : gsubrs;
          const i = n + bias(list.length - 1);
          if (i >= 0 && i + 1 < list.length && run(list[i]!, list[i + 1]!)) return true;
          break;
        }
        case 11:
          depth--;
          return false;
        case 14:
          if (!width && (stack.length === 1 || stack.length === 5)) stack.shift();
          width = true;
          stack.length = 0;
          if (open) out += 'Z';
          open = false;
          return true;
        case 12: {
          const op = v.getUint8(p++);
          const s = stack;
          if (op === 35) {
            curve(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
            curve(s[6]!, s[7]!, s[8]!, s[9]!, s[10]!, s[11]!);
          } else if (op === 34) {
            curve(s[0]!, 0, s[1]!, s[2]!, s[3]!, 0);
            curve(s[4]!, 0, s[5]!, -s[2]!, s[6]!, 0);
          } else if (op === 36) {
            curve(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, 0);
            curve(s[5]!, 0, s[6]!, s[7]!, s[8]!, -(s[1]! + s[3]! + s[7]!));
          } else if (op === 37) {
            // flex1: the last point closes the move on the longer axis.
            const dx = s[0]! + s[2]! + s[4]! + s[6]! + s[8]!;
            const dy = s[1]! + s[3]! + s[5]! + s[7]! + s[9]!;
            const horizontal = Math.abs(dx) > Math.abs(dy);
            curve(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
            curve(s[6]!, s[7]!, s[8]!, s[9]!, horizontal ? s[10]! : -dx, horizontal ? -dy : s[10]!);
          }
          stack.length = 0;
          break;
        }
        default:
          stack.length = 0;
      }
    }
    depth--;
    return false;
  };
  run(from, to);
  if (open) out += 'Z';
  return out;
}
