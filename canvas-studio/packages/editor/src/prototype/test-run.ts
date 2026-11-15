// Testing a prototype on people, the respondent's side (?test=<file>&t=<token>): no account, no editor.
// A short greeting, then each task in turn — its text on a card, then the prototype from the task's start
// screen with the text in a strip below and «Сдаться». Reaching the goal screen ends the task. What is sent:
// taps (screen, point, time, whether something answered), the screens passed, the time and how it ended —
// after every task and, for a task left half-way, when the tab is closed.

import { deserialize, tr, type NodeId } from '#core';
import { CanvasTextMeasurer, setColorProfile } from '#render';
import { userTests, type TestTask, type TestTaskResult } from '../cloud.ts';
import { registerEmbeddedFonts } from '../fonts.ts';
import { h } from '../ui/dom.ts';
import { PrototypePlayer } from './player.ts';
import { isScreen } from './model.ts';

/** Taps closer than this to the previous one in time are the same tap (a double click is not two misses). */
const SAME_TAP_MS = 80;

function sessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function card(...children: (HTMLElement | string)[]): HTMLElement {
  return h('div', { class: 'utest-cover' }, h('div', { class: 'utest-card', role: 'dialog', 'aria-modal': 'true' }, ...children));
}

/** Shows a card until its button is pressed. */
function ask(root: HTMLElement, title: string, text: string, action: string, note?: string): Promise<void> {
  return new Promise((resolve) => {
    const go = h('button', { class: 'text-button primary utest-go', type: 'button' }, action);
    const el = card(h('h1', { class: 'utest-title' }, title), h('p', { class: 'utest-text' }, text), ...(note ? [h('p', { class: 'utest-note' }, note)] : []), go);
    go.addEventListener('click', () => {
      el.remove();
      resolve();
    });
    root.append(el);
    requestAnimationFrame(() => go.focus());
  });
}

export async function runUserTest(root: HTMLElement, params: URLSearchParams): Promise<void> {
  const fileId = params.get('test') ?? '';
  const token = params.get('t') ?? '';
  root.classList.add('utest');
  let opened;
  try {
    opened = await userTests.open(fileId, token);
  } catch (error) {
    root.replaceChildren(card(h('h1', { class: 'utest-title' }, tr('Тест недоступен')), h('p', { class: 'utest-text' }, error instanceof Error ? error.message : String(error))));
    return;
  }
  const doc = deserialize(opened.snapshot);
  setColorProfile(doc.get(doc.rootId, 'colorProfile'));
  await Promise.race([Promise.allSettled([document.fonts?.load('400 16px Inter'), document.fonts?.load('700 16px Inter'), registerEmbeddedFonts(doc)]), new Promise((r) => setTimeout(r, 4000))]);
  const { name, pageId, tasks } = opened.test;
  document.title = name;
  const sid = sessionId();
  const results: TestTaskResult[] = [];
  /** The task under way, as it would be sent if the tab closed now. */
  let running: TestTaskResult | null = null;
  const send = (keepalive = false) => userTests.answer(fileId, token, sid, running ? [...results, { ...running, outcome: 'left' }] : results, keepalive);
  window.addEventListener('pagehide', () => {
    if (running) void send(true);
  });
  root.replaceChildren();
  await ask(root, name, tr('Заданий: {0}. Выполняйте их в прототипе, как в настоящем приложении.', tasks.length), tr('Начать'), tr('Записываются только нажатия и время, без имени.'));
  const usable = tasks.filter((t) => isScreen(doc, t.start));
  for (const [i, task] of usable.entries()) {
    await ask(root, tr('Задание {0} из {1}', i + 1, usable.length), task.text, tr('Начать'));
    results.push(await runTask(root, doc, pageId, task, (r) => (running = r)));
    running = null;
    await send().catch(() => undefined);
  }
  // The last answer once more, in case one on the way was lost.
  await send().catch(() => undefined);
  root.replaceChildren(card(h('h1', { class: 'utest-title' }, tr('Спасибо!')), h('p', { class: 'utest-text' }, tr('Ответы отправлены. Вкладку можно закрыть.'))));
}

/** One task: the prototype from its start until the goal is reached or the respondent gives up. */
function runTask(root: HTMLElement, doc: ReturnType<typeof deserialize>, pageId: NodeId, task: TestTask, live: (r: TestTaskResult) => void): Promise<TestTaskResult> {
  return new Promise((resolve) => {
    const began = performance.now();
    const result: TestTaskResult = { task: task.id, outcome: 'left', ms: 0, path: [task.start], taps: [] };
    live(result);
    const player = new PrototypePlayer({ doc, pageId, start: task.start, measurer: new CanvasTextMeasurer(), bare: true });
    player.el.classList.add('standalone');
    const giveUp = h('button', { class: 'text-button utest-giveup', type: 'button' }, tr('Сдаться'));
    const strip = h('div', { class: 'utest-strip' }, h('p', { class: 'utest-strip-text' }, task.text), giveUp);
    root.replaceChildren(player.el, strip);
    // The screen fits above the strip, so the task never covers a button at the bottom.
    const fit = () => (player.el.style.bottom = `${strip.offsetHeight + 16}px`);
    fit();
    new ResizeObserver(fit).observe(strip);
    let finished = false;
    const finish = (outcome: 'done' | 'gaveup') => {
      if (finished) return;
      finished = true;
      result.outcome = outcome;
      result.ms = Math.round(performance.now() - began);
      // A moment on the goal screen, so the respondent sees where they arrived.
      setTimeout(
        () => {
          player.dispose();
          strip.remove();
          resolve(result);
        },
        outcome === 'done' ? 500 : 0,
      );
    };
    player.onTap = (tap) => {
      if (finished) return;
      const t = Math.round(performance.now() - began);
      const last = result.taps.at(-1);
      if (last && t - last.t < SAME_TAP_MS && Math.abs(last.x - tap.x) < 4 && Math.abs(last.y - tap.y) < 4) return;
      result.taps.push({ s: tap.screen, x: tap.x, y: tap.y, t, hit: tap.hit });
      result.ms = t;
    };
    player.onChange = () => {
      if (finished) return;
      const open = player.openScreens;
      const top = open.at(-1)!;
      if (result.path.at(-1) !== top) result.path.push(top);
      result.ms = Math.round(performance.now() - began);
      if (open.some((s) => task.goals.includes(s))) finish('done');
    };
    giveUp.addEventListener('click', () => finish('gaveup'));
  });
}
