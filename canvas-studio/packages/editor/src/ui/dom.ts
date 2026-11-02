// Tiny DOM helpers: the UI is plain DOM, no framework.

import { tr } from '#core';
import { play } from '../sounds.ts';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/** Creates an element: h('button', { class: 'x', onclick: fn, title: '…' }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(el.dataset, value);
    } else if (typeof value !== 'string' && key in el) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === 'number' ? String(child) : child);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Own icon set, 16×16, stroke-based so it follows `currentColor`. */
const ICONS: Record<string, string> = {
  select: 'M4 2.5v10l2.8-2.6 1.9 4.1 1.6-.7-1.9-4.1H12z',
  frame: 'M5 2v12M11 2v12M2 5h12M2 11h12',
  section: 'M2.5 2.5h11v11h-11zM4.5 4.5h4',
  play: 'M5 3.5v9l7.5-4.5z',
  rectangle: 'M3 3.5h10v9H3z',
  ellipse: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3z',
  line: 'M3 13L13 3',
  arrow: 'M3 13L13 3M7.5 3H13v5.5',
  pen: 'M8 1.8l4.2 5.6L10 12.5H6L3.8 7.4zM8 1.8v5.4M8.9 8.1a.9.9 0 1 1-1.8 0 .9.9 0 1 1 1.8 0zM6 14.3h4',
  vector: 'M3 12.5C5 4 11 12 13 3.5M2 11.5h2v2H2zM12 2.5h2v2h-2z',
  union: 'M2.5 2.5h7v4h4v7h-7v-4h-4z',
  subtract: 'M2.5 2.5h7v4h-3v3h-4zM6.5 6.5h7v7h-7z',
  intersect: 'M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7zM6.5 6.5h3v3h-3z',
  exclude: 'M2.5 2.5h7v4h-3v3h-4zM9.5 6.5h4v7h-7v-4h3z',
  mask: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 2.5v11',
  polygon: 'M8 2.5l6 10.5H2z',
  star: 'M8 1.8l1.9 4.1 4.4.5-3.3 3 .9 4.4L8 11.6l-3.9 2.2.9-4.4-3.3-3 4.4-.5z',
  image: 'M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6.2a1 1 0 1 0 0-.1z',
  blob: 'M8.3 2.6c2.7.1 5.3 1.9 5.1 4.6-.2 2.6-2.6 6.4-5.6 6.2-3-.2-5.6-2.3-5.3-5.3.3-3 3.1-5.6 5.8-5.5z',
  waves: 'M2 6.5c2-1.6 4-1.6 6 0s4 1.6 6 0M2 10.5c2-1.6 4-1.6 6 0s4 1.6 6 0',
  backdrop: 'M3 2.5h10a.5.5 0 0 1 .5.5v10a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5zM6 4.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM10.5 8a2.5 2.5 0 1 1 0 5',
  doodle: 'M2 11.5c1.5-3 3-6 4.5-6s-1 6 1 6 2.5-5 4-5 .5 4 2.5 4',
  palette: 'M8 2.5a5.5 5.5 0 1 0 0 11c.9 0 1.3-.6 1.1-1.3-.3-.9.3-1.7 1.2-1.7h1.3a2.4 2.4 0 0 0 2.4-2.6C13.7 4.8 11.2 2.5 8 2.5zM5 7.5a.8.8 0 1 0 0-.1zM7 5a.8.8 0 1 0 0-.1zM10 5.2a.8.8 0 1 0 0-.1z',
  imageTiles: 'M2.5 3h11v10h-11zM8 3v10M2.5 8h11M4 6.5l1.5-1.5 1 1M10 11.5l1-1 1.5 1.5',
  text: 'M3 3.5h10M8 3.5V13M6 13h4',
  hand: 'M5.5 8V4a1 1 0 0 1 2 0v3.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7.2V4a1 1 0 0 1 2 0v5.5c0 2.5-1.6 4.5-4 4.5-1.5 0-2.5-.7-3.4-2L2.6 9.4a1 1 0 0 1 1.6-1.2l1.3 1.4',
  undo: 'M5 4L2 7l3 3M2 7h7a4 4 0 0 1 0 8H7',
  redo: 'M11 4l3 3-3 3M14 7H7a4 4 0 0 0 0 8h2',
  plus: 'M8 3v10M3 8h10',
  grip: 'M6 4.5h.5M9.5 4.5h.5M6 8h.5M9.5 8h.5M6 11.5h.5M9.5 11.5h.5',
  minus: 'M3 8h10',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  eyeOff: 'M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.4M4.2 4.6C2.6 5.8 1.5 8 1.5 8S4 12.5 8 12.5c1.2 0 2.3-.4 3.2-.9M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2.1',
  lock: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  unlock: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 3.9-.6',
  chevronRight: 'M6 4l4 4-4 4',
  chevronLeft: 'M10 4l-4 4 4 4',
  chevronDown: 'M4 6l4 4 4-4',
  chevronUp: 'M4 10l4-4 4 4',
  collapseAll: 'M5 3l3 3 3-3M5 13l3-3 3 3',
  iconSet: 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM11.5 9.2l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z',
  // «Контент»: lines of data and a person.
  contentReel: 'M2 3.5h7M2 6.5h7M2 9.5h4M2 12.5h4M11.5 7.5a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zM8.5 14c.3-1.6 1.5-2.5 3-2.5s2.7.9 3 2.5',
  phone: 'M5 1.5h6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM7 12.5h2',
  tablet: 'M3.5 1.5h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM7 12.5h2',
  desktop: 'M1.5 2.5h13v8.5h-13zM5.5 14h5M8 11v3',
  laptop: 'M2.5 2h11v8h-11zM.5 10h15v1h-15zM4.5 14h7',
  watch: 'M5 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM14 5.5h1v3h-1',
  // Board (FEAT-083).
  sticky: 'M2.5 2.5h11v7l-4 4h-7zM13.5 9.5h-4v4',
  connector: 'M3 12.5h3.5V3.5H13M10.5 1.5l2.5 2-2.5 2',
  marker: 'M10.5 2.5l3 3-7 7-3.5.5.5-3.5zM9 4l3 3',
  width: 'M2 8c2-3 4-4.5 6-4.5S12 5 14 8M2 8c2 3 4 4.5 6 4.5s4-1.5 6-4.5M8 3.5v9',
  scale: 'M3 13V8.5M3 13h4.5M3 13l5-5M13 3v4.5M13 3H8.5M13 3L8 8M9.5 13H13V9.5',
  lasso: 'M8 2.5c3.3 0 5.5 1.6 5.5 3.6S11.3 9.7 8 9.7 2.5 8.1 2.5 6.1 4.7 2.5 8 2.5zM4.3 8.9c-.7.8-.8 1.9 0 2.6.9.8 2.4.5 2.6 1.6.1.7-.4 1.2-1 1.4',
  pencil: 'M11.2 2.3l2.5 2.5-8.2 8.2-3.3.8.8-3.3zM9.7 3.8l2.5 2.5M3.5 10.6l1.9 1.9',
  highlighter: 'M10 2l4 4-5 5H5V7zM5 11l-2.5 2.5h4',
  eraser: 'M6 13.5h7.5M2.8 9.7l6-6a1.5 1.5 0 0 1 2.1 0l2.4 2.4a1.5 1.5 0 0 1 0 2.1L8 13.5H5.6L2.8 10.7a.7.7 0 0 1 0-1zM5.5 7l4.5 4.5',
  tape: 'M2.5 10.5l1.1-1-1-1.1 1-1L12 4l-.6 1 1 1.1-1 1 .6 1z',
  stamp: 'M8 2.5a2.2 2.2 0 0 1 1.3 4L9 9h3.5v2.5h-9V9H7L6.7 6.5A2.2 2.2 0 0 1 8 2.5zM3 13.5h10',
  shapes: 'M2.5 9.5h5v4h-5zM11 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM11 9l3 4.5H8z',
  rounded: 'M5 3.5h6a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z',
  diamond: 'M8 2l6 6-6 6-6-6z',
  parallelogram: 'M5 3.5h9l-3 9H2z',
  hexagon: 'M5 3h6l3 5-3 5H5L2 8z',
  cylinder: 'M3 4.5c0-1.1 2.2-2 5-2s5 .9 5 2v7c0 1.1-2.2 2-5 2s-5-.9-5-2zM3 4.5c0 1.1 2.2 2 5 2s5-.9 5-2',
  document: 'M3 2.5h10v9c-2.5-1.5-4.5 2-10 .5z',
  blockArrow: 'M2 6h7V3l5 5-5 5v-3H2z',
  speech: 'M2.5 3h11v7.5H7l-3 2.5v-2.5H2.5z',
  terminator: 'M5 4h6a4 4 0 0 1 0 8H5a4 4 0 0 1 0-8z',
  subprocess: 'M2 3.5h12v9H2zM4.5 3.5v9M11.5 3.5v9',
  trapezoid: 'M5 3.5h6l3 9H2z',
  multiDocument: 'M2 5.5h9v7c-2-1.2-3.6 1.6-9 .4zM3.5 5.5V4h9v7M5 4V2.5h9v7',
  note: 'M2.5 2.5h8l3 3v8h-11zM10.5 2.5v3h3',
  cloud: 'M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.6-1 3.2 3.2 0 0 1 .3 7z',
  queue: 'M4 4h8a2 4 0 0 1 0 8H4a2 4 0 0 1 0-8zM12 4a2 4 0 0 0 0 8',
  server: 'M4 1.5h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zM5.5 4h5M5.5 6h5M10.5 8.5v.01',
  user: 'M8 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 14c0-3 2.2-5 5-5s5 2 5 5z',
  routeStraight: 'M3 13L13 3',
  routeElbow: 'M3 13V8h10V3',
  routeCurve: 'M3 13C3 6 13 10 13 3',
  routeAvoid: 'M6 6.5h4v4H6zM2 8.5h2v-5h8v5h2',
  routeReset: 'M2.5 11.5h11M4 7.5c1.5-3 6.5-3 8 0',
  arrowEnds: 'M2 8h12M11 5l3 3-3 3M5 5L2 8l3 3',
  arrowEnd: 'M2 8h12M11 5l3 3-3 3',
  lineEnd: 'M2 8h12',
  dashed: 'M2 8h2.5M6.75 8h2.5M11.5 8H14',
  board: 'M2.5 2.5h11v11h-11zM5 5.5h2.5V8H5zM9 9h2.5v2.5H9z',
  templates: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  expandAll: 'M5 6l3-3 3 3M5 10l3 3 3-3',
  group: 'M2.5 2.5h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M2.5 5.5v-3',
  page: 'M4 2h6l3 3v9H4zM10 2v3h3',
  arrowRight: 'M2 8h11M9 4l4 4-4 4',
  branch: 'M4.5 5v6M11.5 6c0 3-7 2.5-7 5M3 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 4.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  arrowDown: 'M8 2v11M4 9l4 4 4-4',
  wrap: 'M2 4h11v4H5M7 6L5 8l2 2M2 12h4',
  alignLeft: 'M2.5 2v12M5 5h8M5 10h5',
  alignHCenter: 'M8 2v12M4 5h8M5.5 10h5',
  alignRight: 'M13.5 2v12M3 5h8M6 10h5',
  alignTop: 'M2 2.5h12M5 5v8M10 5v5',
  merge: 'M2.5 3.5h11v9h-11zM4.5 8H7M11.5 8H9M5.5 6.5 7 8l-1.5 1.5M10.5 6.5 9 8l1.5 1.5',
  split: 'M2.5 3.5h11v9h-11zM8 3.5v9M6.5 8H4.5M9.5 8h2M5.5 6.5 4 8l1.5 1.5M10.5 6.5 12 8l-1.5 1.5',
  alignVCenter: 'M2 8h12M5 4v8M10 5.5v5',
  alignBottom: 'M2 13.5h12M5 3v8M10 6v5',
  command: 'M5 2a3 3 0 1 0 0 6h6a3 3 0 1 0 0-6 3 3 0 0 0-3 3v6a3 3 0 1 0 3-3H5a3 3 0 1 0 3 3V5a3 3 0 0 0-3-3z',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  close: 'M4 4l8 8M12 4l-8 8',
  clip: 'M2.5 5.5h8v8M5.5 2.5v8h8',
  radius: 'M2.5 13.5V8a5.5 5.5 0 0 1 5.5-5.5h5.5',
  rotate: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5',
  // Position section (as in Figma): a quarter turn, mirror left–right, mirror top–bottom.
  // A square and a clockwise arrow over it (the old one read as a hook).
  rotate90: 'M2.5 8.5h6v5h-6zM4.5 5.5a5 5 0 0 1 8 3.5M10.6 7.6l1.9 1.9 1.9-1.9',
  flipH: 'M8 1.5v13M6 4L2 12h4zM10 4l4 8h-4z',
  flipV: 'M1.5 8h13M4 6L12 2v4zM4 10l8 4v-4z',
  opacity: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 2v12',
  textLeft: 'M2.5 4h11M2.5 8h7M2.5 12h9',
  textCenter: 'M2.5 4h11M4.5 8h7M3.5 12h9',
  textRight: 'M2.5 4h11M6.5 8h7M4.5 12h9',
  textJustify: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  gap: 'M2 2.5v11M14 2.5v11M6 5.5h4v5H6z',
  gapRows: 'M2.5 2h11M2.5 14h11M5.5 6v4h5V6z',
  columns: 'M2.5 2.5h11v11h-11zM6.2 2.5v11M9.8 2.5v11',
  rows: 'M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11',
  padding: 'M2.5 2.5h11v11h-11zM5.5 5.5h5v5h-5z',
  component: 'M8 1.8l2.2 2.2L8 6.2 5.8 4zM8 9.8l2.2 2.2L8 14.2 5.8 12zM4 5.8l2.2 2.2L4 10.2 1.8 8zM12 5.8l2.2 2.2-2.2 2.2L9.8 8z',
  instance: 'M8 2.2L13.8 8 8 13.8 2.2 8z',
  componentSet: 'M2.5 2.5h11v11h-11zM8 5l3 3-3 3-3-3z',
  listBullet: 'M6.5 4h7M6.5 8h7M6.5 12h7M3 4h.01M3 8h.01M3 12h.01',
  panelRight: 'M2.5 3.5h11v9h-11zM10 3.5v9',
  panelLeft: 'M2.5 3.5h11v9h-11zM6 3.5v9',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  detach: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1M2 2l2 2M14 14l-2-2',
  reset: 'M3 8a5 5 0 1 0 1.5-3.6M3 2.5V5h2.5',
  variable: 'M8 2l5 3v6l-5 3-5-3V5zM8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6',
  styles: 'M4.5 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM11.5 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM4.5 10a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM11.5 10a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  sliders: 'M3 4.5h10M3 11.5h10M6 3v3M10 10v3',
  back: 'M9.5 3.5L5 8l4.5 4.5',
  folder: 'M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z',
  import: 'M8 2v8M5 7l3 3 3-3M3 10v3.5h10V10',
  export: 'M8 10V2M5 5l3-3 3 3M3 10v3.5h10V10',
  people: 'M6 3a2.2 2.2 0 1 1 0 4.4A2.2 2.2 0 0 1 6 3zM2 13c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8M10.5 3.3a2.2 2.2 0 0 1 0 4.2M11.5 9.4c1.5.4 2.5 1.8 2.5 3.6',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3l-2 10',
  copy: 'M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3',
  slides: 'M2 2.5h12v8.5H2zM8 11v2.5M5 13.5h6M5 5.5h4M5 8h6',
  shadow: 'M3 3h8v8H3zM5 13h8V5',
  blur: 'M8 2.5c2 2.5 4 4.6 4 7a4 4 0 0 1-8 0c0-2.4 2-4.5 4-7z',
  eyedropper: 'M10.5 2.5l3 3-1.6 1.6-3-3zM9.3 5.3l1.4 1.4-6 6H3.3v-1.4z',
  bucket: 'M3 8.5l5-5 5 5-5 5zM3 8.5h10M13.5 10.5c.7 1 1 1.6 1 2.1a1 1 0 0 1-2 0c0-.5.3-1.1 1-2.1z',
  scissors: 'M4.5 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM4.5 10a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM5.8 5.2l8 6.3M5.8 10.8l8-6.3',
  clock: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.5V8l2.5 1.5',
  search: 'M7 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM10 10l3.5 3.5',
  comment: 'M8 2.5c3.3 0 5.5 2.1 5.5 4.8S11.3 12 8 12c-.8 0-1.5-.1-2.2-.3L2.5 13.5l1-2.6C2.9 10 2.5 8.7 2.5 7.3 2.5 4.6 4.7 2.5 8 2.5z',
  check: 'M3 8.5l3.2 3L13 4.5',
  // A diagram file (FEAT-090): a node and its branches.
  diagram: 'M6.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M9.5 8H11M11 8l1.8-3.5M11 8l1.8 3.5M6.5 8H5M5 8 3.2 4.5M5 8l-1.8 3.5',
  // A question mark centred in the box (the ring is the button's border): a text glyph sat off centre.
  question: 'M5.6 6a2.4 2.4 0 1 1 3.5 2.1c-.7.4-1.1.9-1.1 1.6v.4M8 12.6v.1',
  help: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.4M8 11.4v.1',
  fit: 'M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3M5.5 6h5v4h-5z',
  expand: 'M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9',
};

/** Grey rows where a list is coming (a skeleton screen); screen readers hear `label` instead. */
export function skeletonRows(label: string, rows = 4, tall = false): HTMLElement {
  return h('div', { class: `skeleton-rows${tall ? ' tall' : ''}`, role: 'status', 'aria-busy': 'true', 'aria-label': label }, ...Array.from({ length: rows }, () => h('i', {})));
}

export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.rectangle!);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** Smart actions (✦): a big four-point star and two small ones, filled with the text colour. */
export function sparkles(size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon', 'sparkles');
  for (const d of [
    'M10 2.5c.7 5.2 2.9 7.4 8.1 8.1-5.2.7-7.4 2.9-8.1 8.1-.7-5.2-2.9-7.4-8.1-8.1 5.2-.7 7.4-2.9 8.1-8.1Z',
    'M19 1.5c.3 2 1.1 2.8 3.1 3.1-2 .3-2.8 1.1-3.1 3.1-.3-2-1.1-2.8-3.1-3.1 2-.3 2.8-1.1 3.1-3.1Z',
    'M18.5 15c.25 1.6.9 2.25 2.5 2.5-1.6.25-2.25.9-2.5 2.5-.25-1.6-.9-2.25-2.5-2.5 1.6-.25 2.25-.9 2.5-2.5Z',
  ]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
  }
  return svg;
}

/** The Simmetrika mark: two mirrored arcs with a vector node on the axis (apps/web/icons/logo.svg). */
export function brandMark(size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('brand-mark');
  const parts: [string, string, boolean][] = [
    ['M26 9.5A22.5 22.5 0 0 0 26 54.5', '#4F5BD5', true],
    ['M38 9.5A22.5 22.5 0 0 1 38 54.5', '#A24BE8', true],
    ['M32 23.5L40.5 32L32 40.5L23.5 32Z', '#FFAE1A', false],
  ];
  for (const [d, color, stroke] of parts) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    if (stroke) {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', '9');
      path.setAttribute('stroke-linecap', 'round');
    } else path.setAttribute('fill', color);
    svg.append(path);
  }
  return svg;
}

/** Icon for a node type in the layers panel. */
export function typeIcon(type: string, autoLayout: boolean): SVGSVGElement {
  if (type === 'COMPONENT') return icon('component', 14);
  if (type === 'COMPONENT_SET') return icon('componentSet', 14);
  if (type === 'INSTANCE') return icon('instance', 14);
  if (type === 'FRAME') return icon(autoLayout ? 'padding' : 'frame', 14);
  if (type === 'SECTION') return icon('section', 14);
  if (type === 'GROUP') return icon('group', 14);
  if (type === 'ELLIPSE') return icon('ellipse', 14);
  if (type === 'LINE') return icon('line', 14);
  if (type === 'POLYGON') return icon('polygon', 14);
  if (type === 'VECTOR') return icon('vector', 14);
  if (type === 'BOOLEAN_OPERATION') return icon('union', 14);
  if (type === 'STAR') return icon('star', 14);
  if (type === 'TEXT') return icon('text', 14);
  return icon('rectangle', 14);
}

/** Download a blob as a file. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  play('export');
}

/** A small "?" that opens the help at an article (the app listens for the event). */
export function helpLink(article: string): HTMLButtonElement {
  return h('button', { class: 'help-link-icon', type: 'button', title: tr('Справка по разделу'), 'aria-label': tr('Справка по разделу'), onclick: () => window.dispatchEvent(new CustomEvent('cs-help', { detail: article })) }, icon('question', 12));
}
