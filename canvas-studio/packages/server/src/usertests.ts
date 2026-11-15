// Testing a prototype on people (as Maze, Lyssna). The owner or an editor makes a test: tasks
// («Найдите, где оплатить заказ»), each from a start screen to a goal screen. The prototype is
// frozen at that moment, so taps of every respondent land on the same screens. Anyone with the
// test's link takes it without signing in; nothing about them is kept but their taps, the screens
// they went through and the time. Kept beside the file:
//
//   files/<id>/tests.json                   the tests of the file
//   files/<id>/test-<test>.snapshot.json    the frozen document (pictures stay the file's own)
//   files/<id>/test-<test>.results.json     what respondents did, one entry per session

import { timingSafeEqual } from 'node:crypto';

export interface TestTask {
  id: string;
  text: string;
  start: string;
  goals: string[];
}

export interface UserTest {
  id: string;
  /** In the link; a new test — a new token. */
  token: string;
  name: string;
  pageId: string;
  tasks: TestTask[];
  /** Closed tests take no more answers. */
  open: boolean;
  createdAt: number;
  by: string;
}

/** A tap on a screen: where (in the screen's own units), when from the task's start, whether something answered it. */
export interface Tap {
  s: string;
  x: number;
  y: number;
  t: number;
  hit: boolean;
}

export type Outcome = 'done' | 'gaveup' | 'left';

export interface TaskResult {
  task: string;
  outcome: Outcome;
  ms: number;
  path: string[];
  taps: Tap[];
}

export interface TestSession {
  id: string;
  at: number;
  tasks: TaskResult[];
}

export const TESTS_PER_FILE = 50;
export const TASKS_PER_TEST = 10;
export const TASK_TEXT_MAX = 500;
export const SESSIONS_PER_TEST = 2000;
const PATH_MAX = 200;
const TAPS_MAX = 500;
const ID = /^[A-Za-z0-9_:;.-]{1,64}$/;
export const SESSION_ID = /^[A-Za-z0-9_-]{16,40}$/;

export const testSnapshotName = (id: string) => `test-${id}.snapshot.json`;
export const testResultsName = (id: string) => `test-${id}.results.json`;

export class TestError extends Error {}

function parseList<T>(text: string | null): T[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text) as unknown;
    return Array.isArray(list) ? (list as T[]) : [];
  } catch {
    return [];
  }
}

export const parseTests = (text: string | null) => parseList<UserTest>(text).filter((t) => t && typeof t.id === 'string' && Array.isArray(t.tasks));
export const parseSessions = (text: string | null) => parseList<TestSession>(text).filter((s) => s && typeof s.id === 'string' && Array.isArray(s.tasks));

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Checks the tasks of a new test against the frozen document: a text, a start and a goal that are screens of
 * the page. `isScreen` — whether an id is a screen (a top frame) of `pageId`.
 */
export function cleanTasks(value: unknown, isScreen: (id: string) => boolean): TestTask[] {
  if (!Array.isArray(value) || value.length === 0) throw new TestError('Добавьте задание');
  if (value.length > TASKS_PER_TEST) throw new TestError(`Не больше ${TASKS_PER_TEST} заданий`);
  return value.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const text = str(t.text, TASK_TEXT_MAX);
    if (!text) throw new TestError(`Задание ${i + 1}: напишите, что нужно сделать`);
    const start = str(t.start, 64);
    if (!isScreen(start)) throw new TestError(`Задание ${i + 1}: выберите начальный экран`);
    const goals = (Array.isArray(t.goals) ? t.goals : []).map((g) => str(g, 64)).filter((g, j, all) => isScreen(g) && all.indexOf(g) === j);
    if (goals.length === 0) throw new TestError(`Задание ${i + 1}: выберите экран цели`);
    if (goals.includes(start)) throw new TestError(`Задание ${i + 1}: цель совпадает с началом`);
    return { id: `k${i + 1}`, text, start, goals };
  });
}

const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : null);

/** A session as sent by a respondent's browser: only known tasks, lengths and numbers within bounds. */
export function cleanSession(value: unknown, test: UserTest, id: string, now: number): TestSession {
  const body = (value ?? {}) as Record<string, unknown>;
  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  const known = new Set(test.tasks.map((t) => t.id));
  const out: TaskResult[] = [];
  for (const raw of tasks.slice(0, TASKS_PER_TEST)) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const task = str(r.task, 16);
    if (!known.has(task) || out.some((o) => o.task === task)) continue;
    const outcome = r.outcome === 'done' || r.outcome === 'gaveup' ? r.outcome : 'left';
    const path = (Array.isArray(r.path) ? r.path : []).slice(0, PATH_MAX).filter((s): s is string => typeof s === 'string' && ID.test(s));
    const taps: Tap[] = [];
    for (const p of (Array.isArray(r.taps) ? r.taps : []).slice(0, TAPS_MAX)) {
      const tap = (p ?? {}) as Record<string, unknown>;
      const x = num(tap.x, -100_000, 100_000);
      const y = num(tap.y, -100_000, 100_000);
      const t = num(tap.t, 0, 24 * 3600_000);
      if (typeof tap.s !== 'string' || !ID.test(tap.s) || x === null || y === null || t === null) continue;
      taps.push({ s: tap.s, x, y, t, hit: tap.hit === true });
    }
    out.push({ task, outcome, ms: num(r.ms, 0, 24 * 3600_000) ?? 0, path, taps });
  }
  return { id, at: now, tasks: out };
}

/** The list with this session put in (the same id replaces its earlier state); full lists take no new ones. */
export function upsertSession(list: readonly TestSession[], session: TestSession): TestSession[] | null {
  const i = list.findIndex((s) => s.id === session.id);
  if (i >= 0) return list.map((s, j) => (j === i ? { ...session, at: s.at } : s));
  if (list.length >= SESSIONS_PER_TEST) return null;
  return [...list, session];
}
