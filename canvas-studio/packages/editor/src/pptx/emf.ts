// EMF pictures of PowerPoint (FEAT-158): Windows metafiles, mostly icons drawn
// with GDI commands. The vector part is read here into an SVG — paths, polygons,
// polylines, Béziers, rectangles, ellipses with their pens and brushes, the
// window/viewport mapping and the world transform — so the icon comes over as
// editable vectors. Bitmaps and text inside a metafile are not read; a file
// that draws nothing we can read gives null (a placeholder stays).

interface Pen {
  color: string;
  width: number;
  none: boolean;
}
interface Brush {
  color: string;
  none: boolean;
}
interface Xf {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
interface State {
  pen: Pen;
  brush: Brush;
  world: Xf;
  winOrg: [number, number];
  winExt: [number, number];
  vpOrg: [number, number];
  vpExt: [number, number];
  mapMode: number;
  fillRule: 'evenodd' | 'nonzero';
}

const ID: Xf = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const mul = (m: Xf, n: Xf): Xf => ({ a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b, c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d, e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f });

function colorRef(v: number): string {
  const r = v & 0xff;
  const g = (v >> 8) & 0xff;
  const b = (v >> 16) & 0xff;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

const STOCK: Record<number, Pen | Brush> = {
  0: { color: '#ffffff', none: false },
  1: { color: '#c0c0c0', none: false },
  2: { color: '#808080', none: false },
  3: { color: '#404040', none: false },
  4: { color: '#000000', none: false },
  5: { color: '#000000', none: true },
  6: { color: '#ffffff', width: 1, none: false },
  7: { color: '#000000', width: 1, none: false },
  8: { color: '#000000', width: 1, none: true },
};

/** An SVG of the metafile's vector drawing, or null when it has none that can be read. */
export function emfToSvg(bytes: Uint8Array): string | null {
  if (bytes.length < 88) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 1 || v.getUint32(40, true) !== 0x464d4520) return null;
  const bl = v.getInt32(8, true);
  const bt = v.getInt32(12, true);
  const br = v.getInt32(16, true);
  const bb = v.getInt32(20, true);
  const objects = new Map<number, { pen?: Pen; brush?: Brush }>();
  let st: State = { pen: STOCK[7] as Pen, brush: STOCK[0] as Brush, world: ID, winOrg: [0, 0], winExt: [1, 1], vpOrg: [0, 0], vpExt: [1, 1], mapMode: 1, fillRule: 'evenodd' };
  const saved: State[] = [];
  const out: string[] = [];
  let path: string[] | null = null;
  let cur: [number, number] = [0, 0];

  const toDevice = (x: number, y: number): [number, number] => {
    const w = st.world;
    let px = w.a * x + w.c * y + w.e;
    let py = w.b * x + w.d * y + w.f;
    if (st.mapMode === 7 || st.mapMode === 8) {
      px = ((px - st.winOrg[0]) * st.vpExt[0]) / (st.winExt[0] || 1) + st.vpOrg[0];
      py = ((py - st.winOrg[1]) * st.vpExt[1]) / (st.winExt[1] || 1) + st.vpOrg[1];
    } else {
      px = px - st.winOrg[0] + st.vpOrg[0];
      py = py - st.winOrg[1] + st.vpOrg[1];
    }
    return [px, py];
  };
  /** How much a logical length grows on the device (for pen widths). */
  const scale = () => {
    const w = Math.hypot(st.world.a, st.world.b);
    const m = st.mapMode === 7 || st.mapMode === 8 ? Math.abs(st.vpExt[0] / (st.winExt[0] || 1)) : 1;
    return w * m;
  };
  const pt = (x: number, y: number) => {
    const [px, py] = toDevice(x, y);
    return `${(px - bl).toFixed(2)} ${(py - bt).toFixed(2)}`;
  };
  const paint = (d: string, fill: boolean, stroke: boolean) => {
    const f = fill && !st.brush.none ? st.brush.color : 'none';
    const s = stroke && !st.pen.none ? st.pen.color : 'none';
    if (f === 'none' && s === 'none') return;
    const width = Math.max(0.5, st.pen.width * scale());
    out.push(`<path d="${d}" fill="${f}"${f !== 'none' ? ` fill-rule="${st.fillRule}"` : ''}${s !== 'none' ? ` stroke="${s}" stroke-width="${width.toFixed(2)}" stroke-linejoin="round"` : ''}/>`);
  };
  const emit = (d: string, fill: boolean, stroke: boolean) => {
    if (path) path.push(d);
    else paint(d, fill, stroke);
  };
  const points16 = (off: number, n: number) => {
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([v.getInt16(off + i * 4, true), v.getInt16(off + i * 4 + 2, true)]);
    return pts;
  };
  const points32 = (off: number, n: number) => {
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([v.getInt32(off + i * 8, true), v.getInt32(off + i * 8 + 4, true)]);
    return pts;
  };
  const poly = (pts: [number, number][], close: boolean) => (pts.length ? `M${pts.map((p) => pt(p[0], p[1])).join(' L')}${close ? ' Z' : ''}` : '');
  const bezier = (pts: [number, number][], from: boolean) => {
    // POLYBEZIER starts with its own point; POLYBEZIERTO goes on from the current one.
    let d = '';
    let i = 0;
    if (from) {
      d += `M${pt(pts[0]![0], pts[0]![1])}`;
      i = 1;
    }
    for (; i + 2 < pts.length + (from ? 0 : 0); i += 3) d += ` C${pt(pts[i]![0], pts[i]![1])} ${pt(pts[i + 1]![0], pts[i + 1]![1])} ${pt(pts[i + 2]![0], pts[i + 2]![1])}`;
    return d;
  };

  let off = 0;
  for (let guard = 0; off + 8 <= bytes.length && guard < 200_000; guard++) {
    const type = v.getUint32(off, true);
    const size = v.getUint32(off + 4, true);
    if (size < 8 || off + size > bytes.length) break;
    const p = off + 8;
    switch (type) {
      case 9:
        st.winExt = [v.getInt32(p, true), v.getInt32(p + 4, true)];
        break;
      case 10:
        st.winOrg = [v.getInt32(p, true), v.getInt32(p + 4, true)];
        break;
      case 11:
        st.vpExt = [v.getInt32(p, true), v.getInt32(p + 4, true)];
        break;
      case 12:
        st.vpOrg = [v.getInt32(p, true), v.getInt32(p + 4, true)];
        break;
      case 17:
        st.mapMode = v.getUint32(p, true);
        break;
      case 19:
        st.fillRule = v.getUint32(p, true) === 2 ? 'nonzero' : 'evenodd';
        break;
      case 33:
        saved.push({ ...st });
        break;
      case 34: {
        const rel = v.getInt32(p, true);
        const back = rel < 0 ? saved.splice(saved.length + rel, -rel)[0] : undefined;
        if (back) st = back;
        break;
      }
      case 35:
        st.world = { a: v.getFloat32(p, true), b: v.getFloat32(p + 4, true), c: v.getFloat32(p + 8, true), d: v.getFloat32(p + 12, true), e: v.getFloat32(p + 16, true), f: v.getFloat32(p + 20, true) };
        break;
      case 36: {
        const m: Xf = { a: v.getFloat32(p, true), b: v.getFloat32(p + 4, true), c: v.getFloat32(p + 8, true), d: v.getFloat32(p + 12, true), e: v.getFloat32(p + 16, true), f: v.getFloat32(p + 20, true) };
        const mode = v.getUint32(p + 24, true);
        st.world = mode === 1 ? ID : mode === 2 ? mul(st.world, m) : mode === 3 ? mul(m, st.world) : m;
        break;
      }
      case 37: {
        const ih = v.getUint32(p, true);
        if (ih & 0x80000000) {
          const s = STOCK[ih & 0x7fffffff];
          if (s && 'width' in s) st.pen = s as Pen;
          else if (s) st.brush = s as Brush;
        } else {
          const o = objects.get(ih);
          if (o?.pen) st.pen = o.pen;
          if (o?.brush) st.brush = o.brush;
        }
        break;
      }
      case 38: {
        const style = v.getUint32(p + 4, true);
        objects.set(v.getUint32(p, true), { pen: { width: Math.max(1, v.getInt32(p + 8, true)), color: colorRef(v.getUint32(p + 16, true)), none: (style & 0xf) === 5 } });
        break;
      }
      case 95: {
        const style = v.getUint32(p + 20, true);
        objects.set(v.getUint32(p, true), { pen: { width: Math.max(1, v.getUint32(p + 24, true)), color: colorRef(v.getUint32(p + 32, true)), none: (style & 0xf) === 5 || v.getUint32(p + 28, true) === 1 } });
        break;
      }
      case 39:
        objects.set(v.getUint32(p, true), { brush: { color: colorRef(v.getUint32(p + 8, true)), none: v.getUint32(p + 4, true) === 1 } });
        break;
      case 40:
        objects.delete(v.getUint32(p, true));
        break;
      case 59:
        path = [];
        break;
      case 60:
        break;
      case 61:
        if (path) path.push('Z');
        break;
      case 62:
      case 63:
      case 64:
        if (path) {
          const d = path.join(' ');
          path = null;
          paint(d, type !== 64, type !== 62);
        }
        break;
      case 68:
        path = null;
        break;
      case 27:
        cur = [v.getInt32(p, true), v.getInt32(p + 4, true)];
        if (path) path.push(`M${pt(cur[0], cur[1])}`);
        break;
      case 54: {
        const to: [number, number] = [v.getInt32(p, true), v.getInt32(p + 4, true)];
        if (path) path.push(`L${pt(to[0], to[1])}`);
        else paint(`M${pt(cur[0], cur[1])} L${pt(to[0], to[1])}`, false, true);
        cur = to;
        break;
      }
      case 85:
      case 89:
      case 5:
      case 6: {
        const n = v.getUint32(p + 16, true);
        const pts = type === 85 || type === 89 ? points16(p + 20, n) : points32(p + 20, n);
        const d = type === 85 || type === 5 ? bezier(pts, false) : pts.map((q) => `L${pt(q[0], q[1])}`).join(' ');
        if (path) path.push(d);
        else paint(`M${pt(cur[0], cur[1])} ${d}`, false, true);
        if (pts.length) cur = pts[pts.length - 1]!;
        break;
      }
      case 86:
      case 87:
      case 88:
      case 3:
      case 4:
      case 2: {
        const n = v.getUint32(p + 16, true);
        const pts = type >= 86 ? points16(p + 20, n) : points32(p + 20, n);
        if (type === 88 || type === 2) emit(bezier(pts, true), false, true);
        else emit(poly(pts, type === 86 || type === 3), type === 86 || type === 3, true);
        break;
      }
      case 91:
      case 90:
      case 8:
      case 7: {
        const polys = v.getUint32(p + 16, true);
        const small = type === 91 || type === 90;
        const counts: number[] = [];
        for (let i = 0; i < polys; i++) counts.push(v.getUint32(p + 24 + i * 4, true));
        let at = p + 24 + polys * 4;
        const parts: string[] = [];
        const closed = type === 91 || type === 8;
        for (const c of counts) {
          const pts = small ? points16(at, c) : points32(at, c);
          at += c * (small ? 4 : 8);
          parts.push(poly(pts, closed));
        }
        emit(parts.join(' '), closed, true);
        break;
      }
      case 43:
      case 42:
      case 44: {
        const l = v.getInt32(p, true);
        const t = v.getInt32(p + 4, true);
        const r = v.getInt32(p + 8, true);
        const b = v.getInt32(p + 12, true);
        if (type === 43) emit(poly([[l, t], [r, t], [r, b], [l, b]], true), true, true);
        else {
          // An ellipse (or the corners of a round rectangle) as four quarter curves.
          const rx = type === 42 ? (r - l) / 2 : Math.min((r - l) / 2, v.getInt32(p + 16, true) / 2);
          const ry = type === 42 ? (b - t) / 2 : Math.min((b - t) / 2, v.getInt32(p + 20, true) / 2);
          const k = 0.5523;
          const seg: string[] = [`M${pt(l + rx, t)}`, `L${pt(r - rx, t)}`, `C${pt(r - rx + rx * k, t)} ${pt(r, t + ry - ry * k)} ${pt(r, t + ry)}`, `L${pt(r, b - ry)}`, `C${pt(r, b - ry + ry * k)} ${pt(r - rx + rx * k, b)} ${pt(r - rx, b)}`, `L${pt(l + rx, b)}`, `C${pt(l + rx - rx * k, b)} ${pt(l, b - ry + ry * k)} ${pt(l, b - ry)}`, `L${pt(l, t + ry)}`, `C${pt(l, t + ry - ry * k)} ${pt(l + rx - rx * k, t)} ${pt(l + rx, t)}`, 'Z'];
          emit(seg.join(' '), true, true);
        }
        break;
      }
      case 14:
        off = bytes.length;
        continue;
    }
    off += size;
  }
  if (!out.length) return null;
  const w = Math.max(1, br - bl + 1);
  const h = Math.max(1, bb - bt + 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${out.join('')}</svg>`;
}

/** Pixels not yet encoded (straight RGBA): the build turns them into a PNG in the browser. */
export const RAW_MIME = 'image/x-rgba';

/**
 * The picture inside an EMF+ metafile (Office often wraps a PNG or JPEG so):
 * the first Image object's compressed bitmap, or null.
 */
export function emfPicture(bytes: Uint8Array): { bytes: Uint8Array; mime: string } | null {
  if (bytes.length < 88) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // An object may be split over several records: its parts are joined by id.
  const parts = new Map<number, Uint8Array[]>();
  let off = 0;
  for (let guard = 0; off + 8 <= bytes.length && guard < 100_000; guard++) {
    const type = v.getUint32(off, true);
    const size = v.getUint32(off + 4, true);
    if (size < 8 || off + size > bytes.length) break;
    if (type === 70 && size >= 16 && v.getUint32(off + 12, true) === 0x2b464d45) {
      const end = off + 12 + v.getUint32(off + 8, true);
      let p = off + 16;
      while (p + 12 <= end) {
        const rType = v.getUint16(p, true);
        const flags = v.getUint16(p + 2, true);
        const rSize = v.getUint32(p + 4, true);
        const dataSize = v.getUint32(p + 8, true);
        if (rSize < 12 || p + rSize > end) break;
        if (rType === 0x4008 && ((flags >> 8) & 0x7f) === 5) {
          const id = flags & 0xff;
          const continued = (flags & 0x8000) !== 0;
          const start = p + 12 + (continued ? 4 : 0);
          const len = Math.min(dataSize - (continued ? 4 : 0), p + rSize - start);
          const list = parts.get(id) ?? [];
          list.push(bytes.subarray(start, start + len));
          parts.set(id, list);
        }
        p += rSize;
      }
    }
    if (type === 14) break;
    off += size;
  }
  for (const list of parts.values()) {
    const total = list.reduce((a, b) => a + b.length, 0);
    const data = new Uint8Array(total);
    let at = 0;
    for (const b of list) {
      data.set(b, at);
      at += b.length;
    }
    if (data.length < 28) continue;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // EmfPlusImage: version, type (1 — bitmap); bitmap: width, height, stride, pixel format, type (0 — pixels, 1 — a compressed file).
    if (dv.getUint32(4, true) !== 1) continue;
    if (dv.getUint32(24, true) === 0) {
      const width = dv.getUint32(8, true);
      const height = dv.getUint32(12, true);
      const stride = dv.getInt32(16, true);
      const format = dv.getUint32(20, true);
      // 32-bit formats only (RGB, ARGB, premultiplied ARGB): what Office writes.
      if (![0x22009, 0x26200a, 0xe200b].includes(format) || !width || !height || Math.abs(stride) < width * 4) continue;
      const rgba = new Uint8Array(width * height * 4);
      const premultiplied = format === 0xe200b;
      for (let y = 0; y < height; y++) {
        const row = 28 + (stride > 0 ? y * stride : (height - 1 - y) * -stride);
        for (let x = 0; x < width; x++) {
          const i = row + x * 4;
          if (i + 3 >= data.length) break;
          const a = format === 0x22009 ? 255 : data[i + 3]!;
          const k = premultiplied && a > 0 ? 255 / a : 1;
          const o = (y * width + x) * 4;
          rgba[o] = Math.min(255, data[i + 2]! * k);
          rgba[o + 1] = Math.min(255, data[i + 1]! * k);
          rgba[o + 2] = Math.min(255, data[i]! * k);
          rgba[o + 3] = a;
        }
      }
      return { bytes: rgba, mime: `${RAW_MIME};w=${width};h=${height}` };
    }
    if (dv.getUint32(24, true) !== 1) continue;
    const file = data.subarray(28);
    if (file[0] === 0x89 && file[1] === 0x50) return { bytes: file.slice(), mime: 'image/png' };
    if (file[0] === 0xff && file[1] === 0xd8) return { bytes: file.slice(), mime: 'image/jpeg' };
    if (file[0] === 0x47 && file[1] === 0x49) return { bytes: file.slice(), mime: 'image/gif' };
  }
  return null;
}
