// Testing a prototype on people: what the answers to one task add up to — how many reached the goal, gave
// up or left; the usual time of those who reached it; how many taps hit nothing; on which screen people
// stopped; the most common ways through; and the taps on each screen for the heat map.

import type { TestSession, TestTap, TestTaskResult } from '../cloud.ts';

export interface TaskStats {
  /** Respondents who started the task. */
  total: number;
  done: number;
  gaveup: number;
  left: number;
  /** Median time of those who reached the goal, ms; null — nobody did. */
  medianMs: number | null;
  /** Share of taps nothing answered, 0…1; null — no taps. */
  misses: number | null;
  /** Screens where those who did not reach the goal stopped, most common first. */
  stops: { screen: string; n: number }[];
  /** Ways through, most common first (consecutive repeats of a screen are one). */
  paths: { path: string[]; n: number; done: number }[];
  /** Screens tapped on, most taps first. */
  screens: { screen: string; taps: number }[];
}

export function resultsOf(sessions: readonly TestSession[], task: string): TestTaskResult[] {
  const out: TestTaskResult[] = [];
  for (const s of sessions) {
    const r = s.tasks.find((t) => t.task === task);
    if (r) out.push(r);
  }
  return out;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

const squash = (path: readonly string[]) => path.filter((s, i) => s !== path[i - 1]);

const top = <T>(counts: Map<string, T>, n: (v: T) => number, limit: number) => [...counts.entries()].sort((a, b) => n(b[1]) - n(a[1])).slice(0, limit);

export function taskStats(sessions: readonly TestSession[], task: string): TaskStats {
  const list = resultsOf(sessions, task);
  const stops = new Map<string, number>();
  const paths = new Map<string, { path: string[]; n: number; done: number }>();
  const screens = new Map<string, number>();
  let taps = 0;
  let missed = 0;
  for (const r of list) {
    if (r.outcome !== 'done') {
      const at = r.path.at(-1);
      if (at) stops.set(at, (stops.get(at) ?? 0) + 1);
    }
    const path = squash(r.path);
    const key = path.join('>');
    const p = paths.get(key) ?? { path, n: 0, done: 0 };
    p.n++;
    if (r.outcome === 'done') p.done++;
    paths.set(key, p);
    for (const t of r.taps) {
      taps++;
      if (!t.hit) missed++;
      screens.set(t.s, (screens.get(t.s) ?? 0) + 1);
    }
  }
  return {
    total: list.length,
    done: list.filter((r) => r.outcome === 'done').length,
    gaveup: list.filter((r) => r.outcome === 'gaveup').length,
    left: list.filter((r) => r.outcome === 'left').length,
    medianMs: median(list.filter((r) => r.outcome === 'done').map((r) => r.ms)),
    misses: taps ? missed / taps : null,
    stops: top(stops, (n) => n, 5).map(([screen, n]) => ({ screen, n })),
    paths: top(paths, (p) => p.n, 5).map(([, p]) => p),
    screens: top(screens, (n) => n, 50).map(([screen, n]) => ({ screen, taps: n })),
  };
}

/** Every tap on one screen in this task. */
export function tapsOn(sessions: readonly TestSession[], task: string, screen: string): TestTap[] {
  return resultsOf(sessions, task).flatMap((r) => r.taps.filter((t) => t.s === screen));
}
