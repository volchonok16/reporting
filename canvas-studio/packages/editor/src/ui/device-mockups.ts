// Device mockups (FEAT-116): phones, tablets, laptops, desktops and watches
// drawn as layers — a body you recognise (the island or the punch-hole camera,
// the home button, the notch, the stand, the crown and the strap) with a frame
// «Экран» inside it, where the user puts their screen. Proportions are real:
// the body comes from the device's size in millimetres, scaled so that its
// display (diagonal in inches) holds the screen in points. All the drawings are
// our own simple geometry from the public sizes, no one's pictures.
// Opens as a floating panel (the design.mockups command, its own toolbar button).

import { hexToColor, solid, tr } from '#core';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';

type Radii = number | [number, number, number, number];

/** One piece of a device, in the device's own coordinates (they may go below 0: buttons, straps). */
interface Part {
  kind: 'rect' | 'ellipse';
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r?: Radii;
  fill: string;
  stroke?: string;
  /** The frame the user's screen goes into. */
  screen?: true;
}

interface Device {
  name: string;
  /** The screen in points (shown under the name). */
  screen: [number, number];
  parts: Part[];
}

const GLASS = '#0B0B0C';
const SCREEN = '#FFFFFF';
const MM_PER_INCH = 25.4;

/** Points per millimetre: the display's diagonal holds the screen. */
const scaleOf = (screen: [number, number], diagonal: number) => Math.hypot(screen[0], screen[1]) / (diagonal * MM_PER_INCH);

const rect = (name: string, x: number, y: number, w: number, h: number, fill: string, r: Radii = 0, extra: Partial<Part> = {}): Part => ({ kind: 'rect', name, x, y, w, h, r, fill, ...extra });
const circle = (name: string, cx: number, cy: number, d: number, fill: string, extra: Partial<Part> = {}): Part => ({ kind: 'ellipse', name, x: cx - d / 2, y: cy - d / 2, w: d, h: d, fill, ...extra });

// ---------- phones ----------

interface PhoneSpec {
  name: string;
  /** Body, millimetres. */
  mm: [number, number];
  screen: [number, number];
  /** Display diagonal, inches. */
  diagonal: number;
  /** Corner radius of the display, points. */
  screenRadius: number;
  /** The metal (or plastic) edge. */
  frame: string;
  camera: 'island' | 'hole' | 'home';
  buttons: 'apple' | 'android';
}

function phone(s: PhoneSpec): Device {
  const k = scaleOf(s.screen, s.diagonal);
  const bw = Math.round(s.mm[0] * k);
  const bh = Math.round(s.mm[1] * k);
  const [sw, sh] = s.screen;
  const sx = Math.round((bw - sw) / 2);
  const sy = Math.round((bh - sh) / 2);
  const edge = Math.max(3, Math.round(0.6 * k));
  const radius = s.camera === 'home' ? Math.round(9 * k) : s.screenRadius + sx;
  const parts: Part[] = [];
  const button = (name: string, side: 'left' | 'right', at: number, length: number) => parts.push(rect(name, side === 'left' ? -3 : bw - 3, Math.round(bh * at), 6, Math.round(bh * length), s.frame, 2));
  if (s.buttons === 'apple') {
    button(s.camera === 'island' ? tr('Кнопка действия') : tr('Переключатель звука'), 'left', 0.13, 0.04);
    button(tr('Громкость +'), 'left', 0.2, 0.07);
    button(tr('Громкость −'), 'left', 0.29, 0.07);
    button(tr('Боковая кнопка'), 'right', 0.22, 0.11);
  } else {
    button(tr('Громкость'), 'right', 0.2, 0.12);
    button(tr('Кнопка питания'), 'right', 0.36, 0.07);
  }
  parts.push(rect(tr('Корпус'), 0, 0, bw, bh, s.frame, radius));
  parts.push(rect(tr('Стекло'), edge, edge, bw - edge * 2, bh - edge * 2, GLASS, radius - edge));
  parts.push(rect(tr('Экран'), sx, sy, sw, sh, SCREEN, s.screenRadius, { screen: true }));
  if (s.camera === 'island') {
    parts.push(rect(tr('Островок камеры'), Math.round((bw - 126) / 2), sy + 11, 126, 37, '#000000', 18.5));
  } else if (s.camera === 'hole') {
    parts.push(circle(tr('Камера'), bw / 2, sy + 22, 13, '#000000'));
  } else {
    const below = bh - sy - sh;
    parts.push(rect(tr('Динамик'), Math.round(bw / 2 - bw * 0.07), Math.round(sy / 2 - 3), Math.round(bw * 0.14), 6, '#2A2A2C', 3));
    parts.push(circle(tr('Камера'), bw / 2 - bw * 0.15, sy / 2, 11, '#1C1C1E'));
    parts.push(circle(tr('Кнопка «Домой»'), bw / 2, sy + sh + below / 2, Math.round(below * 0.62), GLASS, { stroke: '#3A3A3C' }));
  }
  return { name: s.name, screen: s.screen, parts };
}

// ---------- tablets ----------

interface TabletSpec {
  name: string;
  mm: [number, number];
  screen: [number, number];
  diagonal: number;
  screenRadius: number;
  frame: string;
  /** Where the front camera is, holding it upright: the short top edge or the long right one (landscape camera). */
  camera: 'top' | 'side';
}

function tablet(s: TabletSpec): Device {
  const k = scaleOf(s.screen, s.diagonal);
  const bw = Math.round(s.mm[0] * k);
  const bh = Math.round(s.mm[1] * k);
  const [sw, sh] = s.screen;
  const sx = Math.round((bw - sw) / 2);
  const sy = Math.round((bh - sh) / 2);
  const edge = Math.max(3, Math.round(0.6 * k));
  const radius = s.screenRadius + Math.round(sx * 0.8);
  return {
    name: s.name,
    screen: s.screen,
    parts: [
      rect(tr('Верхняя кнопка'), Math.round(bw * 0.78), -3, Math.round(bw * 0.09), 6, s.frame, 2),
      rect(tr('Громкость +'), bw - 3, Math.round(bh * 0.08), 6, Math.round(bh * 0.045), s.frame, 2),
      rect(tr('Громкость −'), bw - 3, Math.round(bh * 0.135), 6, Math.round(bh * 0.045), s.frame, 2),
      rect(tr('Корпус'), 0, 0, bw, bh, s.frame, radius),
      rect(tr('Стекло'), edge, edge, bw - edge * 2, bh - edge * 2, GLASS, radius - edge),
      rect(tr('Экран'), sx, sy, sw, sh, SCREEN, s.screenRadius, { screen: true }),
      s.camera === 'top' ? circle(tr('Камера'), bw / 2, sy / 2, 9, '#1C1C1E') : circle(tr('Камера'), bw - sx / 2, bh / 2, 9, '#1C1C1E'),
    ],
  };
}

// ---------- laptops ----------

interface LaptopSpec {
  name: string;
  /** Width of the lid, millimetres. */
  mm: number;
  screen: [number, number];
  diagonal: number;
  body: string;
  /** The camera in a notch cut into the top of the screen (MacBooks since 2021). */
  notch: boolean;
}

function laptop(s: LaptopSpec): Device {
  const k = scaleOf(s.screen, s.diagonal);
  const lw = Math.round(s.mm * k);
  const [sw, sh] = s.screen;
  const side = Math.round((lw - sw) / 2);
  const top = s.notch ? side : Math.round(side * 1.5);
  const bottom = Math.round(side * (s.notch ? 1.6 : 1.9));
  const lh = top + sh + bottom;
  const baseW = Math.round(lw * 1.12);
  const baseH = Math.max(18, Math.round(lw * 0.024));
  const lx = Math.round((baseW - lw) / 2);
  const edge = Math.max(3, Math.round(0.5 * k));
  const parts: Part[] = [
    rect(tr('Крышка'), lx, 0, lw, lh, s.body, [Math.round(side * 0.9), Math.round(side * 0.9), 0, 0]),
    rect(tr('Рамка экрана'), lx + edge, edge, lw - edge * 2, lh - edge, GLASS, [Math.round(side * 0.9) - edge, Math.round(side * 0.9) - edge, 0, 0]),
    rect(tr('Экран'), lx + side, top, sw, sh, SCREEN, s.notch ? [10, 10, 0, 0] : 0, { screen: true }),
  ];
  if (s.notch) {
    const nw = Math.round(sw * 0.12);
    parts.push(rect(tr('Вырез камеры'), lx + Math.round((lw - nw) / 2), top, nw, 32, GLASS, [0, 0, 10, 10]));
    parts.push(circle(tr('Камера'), lx + lw / 2, top + 14, 9, '#1C1C1E'));
  } else {
    parts.push(circle(tr('Камера'), lx + lw / 2, top / 2, 9, '#1C1C1E'));
  }
  parts.push(rect(tr('Основание'), 0, lh, baseW, baseH, s.body, [2, 2, Math.round(baseH * 0.9), Math.round(baseH * 0.9)]));
  parts.push(rect(tr('Выемка'), Math.round(baseW / 2 - baseW * 0.075), lh, Math.round(baseW * 0.15), Math.round(baseH * 0.4), shade(s.body), [0, 0, 8, 8]));
  return { name: s.name, screen: s.screen, parts };
}

// ---------- desktops ----------

interface MonitorSpec {
  name: string;
  mm: number;
  screen: [number, number];
  diagonal: number;
  /** Bezel, chin and stand. */
  bezel: string;
  chin: string;
  stand: string;
  /** The all-in-one: a tall coloured chin and a flat stand. */
  allInOne?: true;
}

function monitor(s: MonitorSpec): Device {
  const k = scaleOf(s.screen, s.diagonal);
  const w = Math.round(s.mm * k);
  const [sw, sh] = s.screen;
  const side = Math.round((w - sw) / 2);
  const chinH = s.allInOne ? Math.round(sh * 0.24) : Math.round(side * 1.6);
  const headH = side + sh + chinH;
  const neckW = Math.round(w * (s.allInOne ? 0.27 : 0.09));
  const neckH = Math.round(headH * (s.allInOne ? 0.3 : 0.24));
  const footW = Math.round(w * (s.allInOne ? 0.27 : 0.32));
  const footH = Math.max(12, Math.round(w * 0.012));
  const radius = Math.round(side * 0.7);
  const parts: Part[] = [
    rect(tr('Подставка'), Math.round((w - neckW) / 2), headH - 4, neckW, neckH + 4, s.stand),
    rect(tr('Основание подставки'), Math.round((w - footW) / 2), headH + neckH, footW, footH, s.stand, [3, 3, Math.round(footH / 2), Math.round(footH / 2)]),
    rect(tr('Корпус'), 0, 0, w, headH, s.bezel, radius),
  ];
  if (s.allInOne) parts.push(rect(tr('Подбородок'), 0, side + sh, w, chinH, s.chin, [0, 0, radius, radius]));
  parts.push(rect(tr('Экран'), side, side, sw, sh, SCREEN, 0, { screen: true }));
  return { name: s.name, screen: s.screen, parts };
}

function browser(name: string, screen: [number, number]): Device {
  const [sw, sh] = screen;
  const bar = 44;
  return {
    name,
    screen,
    parts: [
      rect(tr('Окно'), 0, 0, sw, sh + bar, '#E8E8EA', 12, { stroke: '#C8C8CC' }),
      circle(tr('Закрыть'), 22, bar / 2, 12, '#FF5F57'),
      circle(tr('Свернуть'), 42, bar / 2, 12, '#FEBC2E'),
      circle(tr('Развернуть'), 62, bar / 2, 12, '#28C840'),
      rect(tr('Адресная строка'), Math.round(sw * 0.3), 9, Math.round(sw * 0.4), bar - 18, '#FFFFFF', 7),
      rect(tr('Экран'), 0, bar, sw, sh, SCREEN, [0, 0, 12, 12], { screen: true }),
    ],
  };
}

// ---------- watches ----------

interface WatchSpec {
  name: string;
  mm: [number, number];
  screen: [number, number];
  diagonal: number;
  screenRadius: number;
  body: string;
  strap: string;
  /** The orange action button on the left (Ultra). */
  action?: true;
}

function watch(s: WatchSpec): Device {
  const k = scaleOf(s.screen, s.diagonal);
  const bw = Math.round(s.mm[0] * k);
  const bh = Math.round(s.mm[1] * k);
  const [sw, sh] = s.screen;
  const sx = Math.round((bw - sw) / 2);
  const sy = Math.round((bh - sh) / 2);
  const radius = s.screenRadius + sx;
  const strapW = Math.round(bw * 0.78);
  const strapL = Math.round(bh * 0.55);
  const parts: Part[] = [
    rect(tr('Ремешок сверху'), Math.round((bw - strapW) / 2), -strapL, strapW, strapL + 20, s.strap, [strapW * 0.25, strapW * 0.25, 0, 0]),
    rect(tr('Ремешок снизу'), Math.round((bw - strapW) / 2), bh - 20, strapW, strapL + 20, s.strap, [0, 0, strapW * 0.25, strapW * 0.25]),
    rect(tr('Колёсико'), bw - 4, Math.round(bh * 0.2), 12, Math.round(bh * 0.17), s.body, 4),
    rect(tr('Боковая кнопка'), bw - 3, Math.round(bh * 0.48), 6, Math.round(bh * 0.2), s.body, 3),
  ];
  if (s.action) parts.push(rect(tr('Кнопка действия'), -5, Math.round(bh * 0.3), 8, Math.round(bh * 0.16), '#F26B1D', 3));
  parts.push(
    rect(tr('Корпус'), 0, 0, bw, bh, s.body, radius),
    rect(tr('Стекло'), 4, 4, bw - 8, bh - 8, GLASS, radius - 4),
    rect(tr('Экран'), sx, sy, sw, sh, SCREEN, s.screenRadius, { screen: true }),
  );
  return { name: s.name, screen: s.screen, parts };
}

function roundWatch(name: string, d: number, diagonal: number, body: string, strap: string): Device {
  const k = d / (diagonal * MM_PER_INCH);
  const bd = Math.round(d + 2 * 4.5 * k);
  const inset = Math.round((bd - d) / 2);
  const strapW = Math.round(bd * 0.55);
  const strapL = Math.round(bd * 0.6);
  return {
    name,
    screen: [d, d],
    parts: [
      rect(tr('Ремешок сверху'), Math.round((bd - strapW) / 2), -strapL, strapW, strapL + bd * 0.2, strap, [strapW * 0.3, strapW * 0.3, 0, 0]),
      rect(tr('Ремешок снизу'), Math.round((bd - strapW) / 2), bd * 0.8, strapW, strapL + bd * 0.2, strap, [0, 0, strapW * 0.3, strapW * 0.3]),
      rect(tr('Кнопка'), bd - 5, Math.round(bd * 0.3), 10, Math.round(bd * 0.1), body, 3),
      rect(tr('Кнопка'), bd - 5, Math.round(bd * 0.6), 10, Math.round(bd * 0.1), body, 3),
      circle(tr('Корпус'), bd / 2, bd / 2, bd, body),
      circle(tr('Стекло'), bd / 2, bd / 2, bd - 8, GLASS),
      rect(tr('Экран'), inset, inset, d, d, SCREEN, d / 2, { screen: true }),
    ],
  };
}

/** A darker tone of a body colour (the dent in a laptop's base). */
function shade(hex: string): string {
  const c = hexToColor(hex);
  if (!c) return hex;
  const to = (v: number) => Math.round(v * 255 * 0.82).toString(16).padStart(2, '0');
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

const GROUPS = (): { label: string; icon: string; devices: Device[] }[] => [
  {
    label: tr('Телефон'),
    icon: 'phone',
    devices: [
      phone({ name: 'iPhone SE', mm: [67.3, 138.4], screen: [375, 667], diagonal: 4.7, screenRadius: 0, frame: '#2B2B2D', camera: 'home', buttons: 'apple' }),
      phone({ name: 'iPhone 15', mm: [71.6, 147.6], screen: [393, 852], diagonal: 6.1, screenRadius: 55, frame: '#C9D7E1', camera: 'island', buttons: 'apple' }),
      phone({ name: 'iPhone 15 Plus', mm: [77.8, 160.9], screen: [430, 932], diagonal: 6.7, screenRadius: 55, frame: '#EBD3D6', camera: 'island', buttons: 'apple' }),
      phone({ name: 'iPhone 16 Pro', mm: [71.5, 149.6], screen: [402, 874], diagonal: 6.3, screenRadius: 62, frame: '#C2BCB2', camera: 'island', buttons: 'apple' }),
      phone({ name: 'iPhone 16 Pro Max', mm: [77.6, 163.0], screen: [440, 956], diagonal: 6.9, screenRadius: 62, frame: '#3C3C3A', camera: 'island', buttons: 'apple' }),
      phone({ name: 'Samsung Galaxy S24', mm: [70.6, 147.0], screen: [360, 780], diagonal: 6.2, screenRadius: 34, frame: '#2D2E33', camera: 'hole', buttons: 'android' }),
      phone({ name: 'Samsung Galaxy S24 Ultra', mm: [79.0, 162.3], screen: [384, 824], diagonal: 6.8, screenRadius: 10, frame: '#8D8E91', camera: 'hole', buttons: 'android' }),
      phone({ name: 'Google Pixel 9', mm: [72.0, 152.8], screen: [412, 923], diagonal: 6.3, screenRadius: 44, frame: '#D9D6CF', camera: 'hole', buttons: 'android' }),
      phone({ name: tr('Android'), mm: [75.0, 162.0], screen: [412, 915], diagonal: 6.5, screenRadius: 28, frame: '#3A3A3C', camera: 'hole', buttons: 'android' }),
    ],
  },
  {
    label: tr('Планшет'),
    icon: 'tablet',
    devices: [
      tablet({ name: 'iPad mini', mm: [134.8, 195.4], screen: [744, 1133], diagonal: 8.3, screenRadius: 21, frame: '#D8D2E6', camera: 'top' }),
      tablet({ name: 'iPad Air 11″', mm: [178.5, 247.6], screen: [820, 1180], diagonal: 10.9, screenRadius: 18, frame: '#C9D5E0', camera: 'side' }),
      tablet({ name: 'iPad Pro 11″', mm: [177.5, 249.7], screen: [834, 1210], diagonal: 11.1, screenRadius: 18, frame: '#3A3A3C', camera: 'side' }),
      tablet({ name: 'iPad Pro 13″', mm: [215.5, 281.6], screen: [1032, 1376], diagonal: 13, screenRadius: 18, frame: '#D6D6D8', camera: 'side' }),
      tablet({ name: 'Samsung Galaxy Tab S9', mm: [165.8, 254.3], screen: [800, 1280], diagonal: 11, screenRadius: 14, frame: '#2D2E33', camera: 'side' }),
    ],
  },
  {
    label: tr('Ноутбук'),
    icon: 'laptop',
    devices: [
      laptop({ name: 'MacBook Air 13″', mm: 304.1, screen: [1470, 956], diagonal: 13.6, body: '#2E3440', notch: true }),
      laptop({ name: 'MacBook Air 15″', mm: 340.4, screen: [1710, 1112], diagonal: 15.3, body: '#E3DED3', notch: true }),
      laptop({ name: 'MacBook Pro 14″', mm: 312.6, screen: [1512, 982], diagonal: 14.2, body: '#2B2B2D', notch: true }),
      laptop({ name: 'MacBook Pro 16″', mm: 355.7, screen: [1728, 1117], diagonal: 16.2, body: '#D9DADC', notch: true }),
      laptop({ name: 'Surface Laptop', mm: 301, screen: [1440, 960], diagonal: 13.8, body: '#C9C8C4', notch: false }),
      laptop({ name: tr('Ноутбук 15,6″'), mm: 359, screen: [1920, 1080], diagonal: 15.6, body: '#232325', notch: false }),
    ],
  },
  {
    label: tr('Десктоп'),
    icon: 'desktop',
    devices: [
      monitor({ name: 'iMac 24″', mm: 547, screen: [2240, 1260], diagonal: 23.5, bezel: '#F2F2F2', chin: '#A9C1DD', stand: '#9DB4CE', allInOne: true }),
      monitor({ name: tr('Монитор 24″ Full HD'), mm: 540, screen: [1920, 1080], diagonal: 23.8, bezel: '#151515', chin: '#151515', stand: '#2A2A2C' }),
      monitor({ name: tr('Монитор 27″'), mm: 614, screen: [2560, 1440], diagonal: 27, bezel: '#151515', chin: '#151515', stand: '#2A2A2C' }),
      monitor({ name: tr('Ультраширокий 34″'), mm: 810, screen: [3440, 1440], diagonal: 34, bezel: '#151515', chin: '#151515', stand: '#2A2A2C' }),
      browser(tr('Окно браузера'), [1440, 900]),
    ],
  },
  {
    label: tr('Часы'),
    icon: 'watch',
    devices: [
      watch({ name: 'Apple Watch 41 мм', mm: [35, 41], screen: [176, 215], diagonal: 1.69, screenRadius: 34, body: '#E8E3DC', strap: '#E9D4C4' }),
      watch({ name: 'Apple Watch 45 мм', mm: [38, 45], screen: [198, 242], diagonal: 1.9, screenRadius: 38, body: '#2B2B2D', strap: '#3A3E4A' }),
      watch({ name: 'Apple Watch Ultra', mm: [44, 49], screen: [205, 251], diagonal: 1.92, screenRadius: 30, body: '#B9B5AE', strap: '#E46A2E', action: true }),
      roundWatch('Galaxy Watch', 396, 1.5, '#2D2E33', '#3A3B40'),
    ],
  },
];

/** The box around every part (buttons and straps stick out of the body). */
function boundsOf(parts: readonly Part[]): { x: number; y: number; w: number; h: number } {
  const x = Math.min(...parts.map((p) => p.x));
  const y = Math.min(...parts.map((p) => p.y));
  return { x, y, w: Math.max(...parts.map((p) => p.x + p.w)) - x, h: Math.max(...parts.map((p) => p.y + p.h)) - y };
}

const radiiOf = (r: Radii | undefined): [number, number, number, number] => (Array.isArray(r) ? r : [r ?? 0, r ?? 0, r ?? 0, r ?? 0]);

/** The device's silhouette for the panel: the same parts as the layers, the screen light grey. */
function preview(d: Device, height: number): SVGSVGElement {
  const b = boundsOf(d.parts);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const width = Math.min(120, Math.round((b.w / b.h) * height));
  svg.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');
  for (const p of d.parts) {
    const fill = p.screen ? '#E6E8EC' : p.fill;
    let el: SVGElement;
    if (p.kind === 'ellipse') {
      el = document.createElementNS(ns, 'ellipse');
      el.setAttribute('cx', String(p.x + p.w / 2));
      el.setAttribute('cy', String(p.y + p.h / 2));
      el.setAttribute('rx', String(p.w / 2));
      el.setAttribute('ry', String(p.h / 2));
    } else {
      el = document.createElementNS(ns, 'path');
      const max = Math.min(p.w, p.h) / 2;
      const [tl, tr, br, bl] = radiiOf(p.r).map((v) => Math.min(max, Math.max(0, v))) as [number, number, number, number];
      const { x, y, w, h: ht } = { x: p.x, y: p.y, w: p.w, h: p.h };
      el.setAttribute('d', `M${x + tl} ${y}H${x + w - tr}A${tr} ${tr} 0 0 1 ${x + w} ${y + tr}V${y + ht - br}A${br} ${br} 0 0 1 ${x + w - br} ${y + ht}H${x + bl}A${bl} ${bl} 0 0 1 ${x} ${y + ht - bl}V${y + tl}A${tl} ${tl} 0 0 1 ${x + tl} ${y}Z`);
    }
    el.setAttribute('fill', fill);
    if (p.stroke) {
      el.setAttribute('stroke', p.stroke);
      el.setAttribute('stroke-width', String(b.h / height));
    }
    svg.append(el);
  }
  return svg;
}

export class DeviceMockups {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly dock: HTMLElement;
  private openGroup: string = tr('Телефон');

  constructor(editor: Editor, dock: HTMLElement) {
    this.editor = editor;
    this.dock = dock;
    this.el = h('div', { class: 'frame-presets device-presets', role: 'dialog', 'aria-label': tr('Макеты устройств'), hidden: true });
    window.addEventListener('resize', () => this.place());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden) this.close();
    });
    // A click on the canvas or anywhere else outside closes it too (the toolbar button toggles it itself).
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node | null;
      if (this.el.hidden || !t || this.el.contains(t) || this.dock.contains(t)) return;
      this.close();
    });
  }

  toggle(): void {
    if (this.editor.doc.readOnly) return;
    this.el.hidden = !this.el.hidden;
    if (!this.el.hidden) {
      this.update();
      this.place();
    }
  }

  private update(): void {
    const groups = GROUPS();
    const row = h('div', { class: 'fp-groups' });
    for (const g of groups) {
      const on = this.openGroup === g.label;
      const b = h('button', { class: `fp-group${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on) }, icon(g.icon, 14), h('span', {}, g.label));
      b.addEventListener('click', () => {
        this.openGroup = g.label;
        this.update();
        this.place();
      });
      row.append(b);
    }
    row.append(
      h('span', { class: 'fp-hint' }, tr('Вставьте свой экран во фрейм «Экран»')),
      h('button', { class: 'icon-button fp-close', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close')),
    );
    const opened = groups.find((g) => g.label === this.openGroup) ?? groups[0]!;
    const list = h(
      'div',
      { class: 'dm-list' },
      ...opened.devices.map((d) => {
        const b = h('button', { class: 'dm-card', type: 'button', title: tr('Вставить {0}', d.name) }, h('span', { class: 'dm-picture' }, preview(d, 96)), h('span', { class: 'dm-name' }, d.name), h('small', {}, `${d.screen[0]} × ${d.screen[1]}`));
        b.addEventListener('click', () => this.insert(d));
        return b;
      }),
    );
    this.el.replaceChildren(row, list);
  }

  private insert(d: Device): void {
    const e = this.editor;
    const { width, height } = e.screenSize;
    const center = e.viewport.screenToWorld({ x: width / 2, y: height / 2 });
    const b = boundsOf(d.parts);
    const paint = (hex: string) => {
      const c = hexToColor(hex);
      return c ? [solid(c)] : [];
    };
    const bodyId = e.commit(tr('Макет: {0}', d.name), (tx) => {
      const id = tx.create('FRAME', e.pageId, {
        name: d.name,
        x: Math.round(center.x - b.w / 2),
        y: Math.round(center.y - b.h / 2),
        width: b.w,
        height: b.h,
        fills: [],
        clipsContent: false,
      });
      for (const p of d.parts) {
        const r = radiiOf(p.r);
        const common = {
          name: p.name,
          x: p.x - b.x,
          y: p.y - b.y,
          width: p.w,
          height: p.h,
          fills: paint(p.fill),
          ...(p.stroke ? { strokes: paint(p.stroke), strokeWeight: 2, strokeAlign: 'INSIDE' as const } : {}),
        };
        if (p.kind === 'ellipse') tx.create('ELLIPSE', id, common);
        else if (p.screen) tx.create('FRAME', id, { ...common, ...(r.every((v) => v === r[0]) ? { cornerRadius: r[0] } : { cornerRadii: r }), clipsContent: true });
        else tx.create('RECTANGLE', id, { ...common, ...(r.every((v) => v === r[0]) ? { cornerRadius: r[0] } : { cornerRadii: r }) });
      }
      return id;
    });
    e.setTool('select');
    e.setSelection([bodyId]);
    e.zoomToSelection();
    e.appear([bodyId]);
    this.close();
  }

  close(): void {
    this.el.hidden = true;
  }

  private place(): void {
    if (this.el.hidden) return;
    const area = this.el.parentElement;
    if (!area) return;
    const a = area.getBoundingClientRect();
    const d = this.dock.getBoundingClientRect();
    const where = this.dock.dataset.place ?? 'bottom';
    const w = this.el.offsetWidth;
    const hh = this.el.offsetHeight;
    if (where === 'left') {
      this.el.style.left = `${d.right - a.left + 8}px`;
      this.el.style.top = `${Math.max(8, d.top - a.top + d.height / 2 - hh / 2)}px`;
    } else {
      this.el.style.left = `${Math.max(8, Math.min(a.width - w - 8, d.left - a.left + d.width / 2 - w / 2))}px`;
      this.el.style.top = `${where === 'top' ? d.bottom - a.top + 8 : d.top - a.top - hh - 8}px`;
    }
  }
}
