// What kind a font is, read from its letters (FEAT-153, the font picker's filters):
// monospace — «i» as wide as «M»; serif — the feet of «I» and «H» wider than their
// stems; decorative — by the name (scripts, hands, display faces cannot be told
// by a few pixels); Cyrillic — its Cyrillic letters are not the fallback's.
// Measured once per family and kept in this browser.

export type FontKind = 'sans' | 'serif' | 'mono' | 'display';

export interface FontTraits {
  kind: FontKind;
  cyrillic: boolean;
}

const KEY = 'cs-font-traits';
const VERSION = 1;
let cache: Record<string, FontTraits> | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const DISPLAY = /script|hand|brush|comic|marker|chalk|papyrus|impact|lobster|pacifico|display|decor|stencil|graffiti|caveat|cursive|felt|copperplate|fantasy|zapfino|snell|bradley|chancery|signpainter|party|trattatello|herculanum|luminari|phosphate|sketch|kalam|amatic|shadows into|permanent marker|dancing|great vibes|satisfy/i;

function load(): Record<string, FontTraits> {
  if (cache) return cache;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { v: number; fonts: Record<string, FontTraits> } | null;
    cache = v && v.v === VERSION ? v.fonts : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify({ v: VERSION, fonts: cache }));
    } catch {
      // not kept: measured again next time
    }
  }, 500);
}

function context(): CanvasRenderingContext2D | null {
  if (ctx || typeof document === 'undefined') return ctx;
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 160;
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx;
}

/** Widths of the first ink run in each row of a letter drawn at 120 px (top to bottom, rows with ink only). */
function stems(c: CanvasRenderingContext2D, family: string, letter: string): number[] {
  c.clearRect(0, 0, 160, 160);
  c.font = `120px "${family}", sans-serif`;
  c.fillStyle = '#000';
  c.textBaseline = 'alphabetic';
  c.fillText(letter, 20, 135);
  const data = c.getImageData(0, 0, 160, 160).data;
  const rows: number[] = [];
  for (let y = 0; y < 160; y++) {
    let x = 0;
    while (x < 160 && data[(y * 160 + x) * 4 + 3]! < 128) x++;
    if (x === 160) continue;
    let w = 0;
    while (x + w < 160 && data[(y * 160 + x + w) * 4 + 3]! >= 128) w++;
    rows.push(w);
  }
  return rows;
}

/** Whether a letter has feet: its bottom rows reach well past its stem. */
function hasFeet(c: CanvasRenderingContext2D, family: string, letter: string): boolean {
  const rows = stems(c, family, letter);
  if (rows.length < 20) return false;
  const stem = rows[Math.floor(rows.length * 0.3)]!;
  const foot = Math.max(...rows.slice(Math.floor(rows.length * 0.94)));
  return foot > stem * 1.5 + 2;
}

/** The family's kind and whether it has Cyrillic letters. */
export function fontTraits(family: string): FontTraits {
  const known = load()[family];
  if (known) return known;
  const c = context();
  if (!c) return { kind: 'sans', cyrillic: true };
  const width = (font: string, s: string) => {
    c.font = font;
    return c.measureText(s).width;
  };
  const narrow = width(`48px "${family}", monospace`, 'iiiiiiiiii');
  const wide = width(`48px "${family}", monospace`, 'MMMMMMMMMM');
  const sample = 'ЖЩЫЮЯжщыюя';
  const cyrillic = ['monospace', 'serif'].some((f) => Math.abs(width(`48px "${family}", ${f}`, sample) - width(`48px ${f}`, sample)) > 0.5);
  let kind: FontKind;
  if (DISPLAY.test(family)) kind = 'display';
  else if (Math.abs(narrow - wide) < Math.max(1, wide * 0.01)) kind = 'mono';
  else kind = hasFeet(c, family, 'I') && hasFeet(c, family, 'H') ? 'serif' : 'sans';
  const traits = { kind, cyrillic };
  load()[family] = traits;
  save();
  return traits;
}
