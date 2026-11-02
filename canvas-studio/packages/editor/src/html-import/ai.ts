// A layout from a description (FEAT-172), the editor's side: the server asks
// the language model (packages/server/src/ai-layout.ts) and passes its page on
// as it is written; here the text is gathered and the HTML is cut out of it,
// for the HTML import to turn into layers. A layout is changed the same way:
// its page goes along with the request (pictures as short placeholders — the
// model need not read megabytes of base64), the changed page comes back.

import { tr } from '#core';

/** The HTML in an answer: models sometimes add a word before it or wrap it in ``` fences. */
export function extractHtml(text: string): string {
  const start = text.search(/<!doctype html|<html[\s>]/i);
  let html = start >= 0 ? text.slice(start) : text.replace(/^[\s\S]*?```(?:html)?\s*/i, '');
  const end = html.search(/<\/html>/i);
  if (end >= 0) html = html.slice(0, end + 7);
  else html = html.replace(/```[\s\S]*$/, '');
  return html.trim();
}

/** What the model is busy with, by the latest thing in its text: for the caption under the waiting preview. */
const STAGES: [RegExp, string][] = [
  [/<style/gi, tr('Подбираю цвета и шрифты…')],
  [/border-radius/gi, tr('Скругляю углы…')],
  [/box-shadow/gi, tr('Кладу мягкие тени…')],
  [/gradient\(/gi, tr('Смешиваю градиенты…')],
  [/display:\s*grid/gi, tr('Расчерчиваю сетку…')],
  [/@media/gi, tr('Думаю о маленьких экранах…')],
  [/<body/gi, tr('Начинаю вёрстку…')],
  [/<header|class="[^"]*header/gi, tr('Рисую шапку…')],
  [/<nav/gi, tr('Расставляю меню…')],
  [/<h1/gi, tr('Пишу главный заголовок…')],
  [/<button|class="[^"]*btn/gi, tr('Добавляю кнопки…')],
  [/<svg/gi, tr('Рисую иконки…')],
  [/<img|class="[^"]*(?:photo|image|img)/gi, tr('Ставлю картинки…')],
  [/class="[^"]*card/gi, tr('Раскладываю карточки…')],
  [/<table/gi, tr('Заполняю таблицу…')],
  [/<form|<input/gi, tr('Собираю форму…')],
  [/<footer|class="[^"]*footer/gi, tr('Подвал — почти готово…')],
];

export function layoutStage(text: string): string {
  let best = tr('Продумываю, что будет на экране…');
  let at = -1;
  for (const [re, caption] of STAGES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let last = -1;
    while ((m = re.exec(text))) last = m.index;
    if (last > at) {
      at = last;
      best = caption;
    }
  }
  return best;
}

/** While the model changes a layout: what the status line says in turn, so the wait is not dull. */
export function workPhrases(): string[] {
  return [
    tr('Не дышать: работают маги.'),
    tr('Двигаем пиксели силой мысли…'),
    tr('Нейросеть закатала рукава…'),
    tr('Ищем, куда спрятался нужный отступ…'),
    tr('Уговариваем кнопки стать круглее…'),
    tr('Шепчем макету правильные слова…'),
    tr('Подкручиваем винтики в CSS…'),
    tr('Тише, нейросеть сосредоточилась…'),
    tr('Переставляем блоки, как мебель…'),
    tr('Сверяемся с внутренним дизайнером…'),
    tr('Рисуем, стираем, снова рисуем…'),
    tr('Кофе налит, правка в пути…'),
  ];
}

/** The line being written now, for the ticker under the waiting preview. */
export function lastCodeLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line && line !== '```html' && line !== '```') return line.length > 90 ? `${line.slice(0, 90)}…` : line;
  }
  return '';
}

/** A piece of text as a pattern where any run of spaces matches any other: the model may re-indent lines it copies. */
function loosePattern(text: string): RegExp {
  const parts = text.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(parts.join('\\s+'));
}

export interface EditResult {
  html: string;
  /** Blocks applied, and those whose SEARCH was not found in the page. */
  applied: number;
  missed: number;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>/g;

/** What a tag does to the nesting: +1 opens an element, −1 closes one, 0 neither (void, «/>», a comment). */
function tagStep(m: RegExpExecArray): number {
  if (!m[2] || m[3] || VOID_TAGS.has(m[2].toLowerCase())) return 0;
  return m[1] ? -1 : 1;
}

/** Elements a piece of a page leaves open (less than zero — closes ones opened before it). */
function tagBalance(text: string): number {
  let n = 0;
  for (const m of text.matchAll(TAG)) n += tagStep(m);
  return n;
}

/** Where the piece of the page from `start` (now to `end`) has `target` elements open — past the closing tags that follow; −1 if it never does. */
function extendTo(html: string, start: number, end: number, target: number): number {
  let open = tagBalance(html.slice(start, end));
  const re = new RegExp(TAG.source, 'g');
  re.lastIndex = end;
  for (let m = re.exec(html); m && open > target; m = re.exec(html)) {
    open += tagStep(m);
    if (open === target) return m.index + m[0].length;
  }
  return -1;
}

/** Each place the piece is in the page: exactly, or else with other spacing. */
function occurrences(html: string, search: string): { start: number; end: number; loose: boolean }[] {
  const out: { start: number; end: number; loose: boolean }[] = [];
  for (let at = html.indexOf(search); at >= 0; at = html.indexOf(search, at + 1)) out.push({ start: at, end: at + search.length, loose: false });
  if (out.length) return out;
  const re = new RegExp(loosePattern(search).source, 'g');
  for (const m of html.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, loose: true });
  return out;
}

/**
 * The model's answer to a change request applied to the page: «<<<<<<< SEARCH … ======= …
 * >>>>>>> REPLACE» blocks, each found exactly (or with other spacing) and replaced. An answer
 * that is a whole page after all is taken as it is; null — neither (nothing usable came).
 *
 * The blocks are found in the page as it was and in page order, as the model is asked to give
 * them: a piece that is there more than once is the one after the previous block (not always the
 * first on the page, which put the change into another section), and a block never finds the
 * text another block has just put in. A block whose SEARCH is only the first line of a section
 * while its REPLACE is the whole new section takes the old section to its end — else the new one
 * came on top of the old one's content. A block that would still break the nesting is not applied.
 */
export function applyEdits(page: string, answer: string): EditResult | null {
  // Markers only as whole lines: a CSS comment like «/* ===== Меню ===== */» is not a divider.
  const blocks = [...answer.replace(/\r\n/g, '\n').matchAll(/^<{5,}[ \t]*SEARCH[ \t]*\n([\s\S]*?)\n?^={5,}[ \t]*\n([\s\S]*?)\n?^>{5,}[ \t]*REPLACE[ \t]*$/gm)];
  if (!blocks.length) {
    const whole = extractHtml(answer);
    // A whole page, not a piece of one: a piece would wipe the rest of the layout.
    return /<\/html>/i.test(whole) && whole.length > page.length * 0.5 ? { html: whole, applied: 1, missed: 0 } : null;
  }
  const edits = blocks.map(([, search, replace]) => ({ search: search!, replace: replace! }));
  // Blocks that open and close as many elements together as apart (an opening tag removed in one, its closing in another) are taken as they are.
  const consistent = edits.reduce((n, e) => n + tagBalance(e.search) - tagBalance(e.replace), 0) === 0;
  const done: { start: number; end: number; text: string }[] = [];
  const left: typeof edits = [];
  let missed = 0;
  let cursor = 0;
  for (const e of edits) {
    if (!e.search.trim()) {
      missed++;
      continue;
    }
    const free = occurrences(page, e.search).filter((o) => !done.some((d) => o.start < d.end && d.start < o.end));
    const at = free.find((o) => o.start >= cursor) ?? free[0];
    if (!at) {
      left.push(e);
      continue;
    }
    const text = at.loose ? e.replace.trim() : e.replace;
    let end = at.end;
    const want = tagBalance(text);
    const has = tagBalance(page.slice(at.start, end));
    if (want !== has && !consistent) {
      end = want < has ? extendTo(page, at.start, end, want) : -1;
      if (end < 0 || done.some((d) => at.start < d.end && d.start < end)) {
        missed++;
        continue;
      }
    }
    done.push({ start: at.start, end, text });
    cursor = end;
  }
  let html = page;
  for (const d of [...done].sort((a, b) => b.start - a.start)) html = html.slice(0, d.start) + d.text + html.slice(d.end);
  let applied = done.length;
  // Not in the page as it was: perhaps in what an earlier block put in (only where it is once).
  for (const e of left) {
    const at = occurrences(html, e.search);
    if (at.length !== 1) {
      missed++;
      continue;
    }
    html = html.slice(0, at[0]!.start) + (at[0]!.loose ? e.replace.trim() : e.replace) + html.slice(at[0]!.end);
    applied++;
  }
  return { html, applied, missed };
}

/** Pictures (data: URLs) in a page become «cs-img:N» placeholders; `restore` puts them back into the model's answer. */
export function packPictures(html: string): { html: string; restore: (answer: string) => string } {
  const pictures: string[] = [];
  const packed = html.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (url) => {
    let i = pictures.indexOf(url);
    if (i < 0) i = pictures.push(url) - 1;
    return `cs-img:${i}`;
  });
  return { html: packed, restore: (answer) => answer.replace(/cs-img:(\d+)/g, (m, n: string) => pictures[Number(n)] ?? m) };
}

/** A layer's name from the description: its first words. */
export function promptName(prompt: string): string {
  const line = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, '')}…`;
}

/**
 * Asks the server for a page by the description (with `base` — that page
 * changed by it); `onText` gets the whole text so far each time a piece comes.
 * `slide` — a presentation's slide size: the model makes exactly one slide of it.
 * Resolves with the final text.
 */
export async function generateLayout(prompt: string, width: number, signal: AbortSignal, onText: (text: string) => void, base?: string, files: { name: string; text: string }[] = [], slide?: { w: number; h: number }): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/ai/layout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CS': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, width, base, files, slide }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(tr('Нет связи с сервером Симметрики'));
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error(tr('Войдите в аккаунт — макеты по описанию создаются на сервере'));
    if (res.status === 404) throw new Error(tr('Этот сервер не умеет создавать макеты по описанию'));
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? tr('Сервер ответил ошибкой {0}', res.status));
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    onText(text);
  }
  return text + decoder.decode();
}
