// Quiet sounds of the interface (FEAT-150): off by default, switched on in Settings.
// Each is synthesized on the spot with Web Audio — no sound files, nothing borrowed.

export type SoundName = 'snap' | 'insert' | 'export' | 'undo';

let ctx: AudioContext | null = null;
let enabled = false;
const last = new Map<SoundName, number>();

/** Sounds on or off (the «Звуки» setting). */
export function setSoundsEnabled(on: boolean): void {
  enabled = on;
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx ??= new Ctor();
    // Browsers start audio suspended until the page has been touched.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One soft tone: a sine from `from` to `to` Hz with a quick attack and a gentle fade. */
function tone(a: AudioContext, at: number, from: number, to: number, length: number, volume: number): void {
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(a.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/** Plays a sound if sounds are on; the same sound at most once in 70 ms. */
export function play(name: SoundName): void {
  if (!enabled) return;
  const now = performance.now();
  if (now - (last.get(name) ?? -Infinity) < 70) return;
  last.set(name, now);
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.005;
  switch (name) {
    case 'snap':
      // A tiny click, like a magnet catching.
      tone(a, t, 1800, 1400, 0.035, 0.035);
      break;
    case 'insert':
      // A soft pop going up.
      tone(a, t, 320, 640, 0.09, 0.06);
      break;
    case 'export':
      // Two notes, a fifth apart: done.
      tone(a, t, 660, 660, 0.16, 0.05);
      tone(a, t + 0.09, 990, 990, 0.22, 0.045);
      break;
    case 'undo':
      // A short step down.
      tone(a, t, 520, 360, 0.07, 0.04);
      break;
  }
}
