// Typograph for text already typed (as SBOL Typograph): the rules of Russian
// typesetting — «ёлочки» with „лапками“ inside, a dash with a non-breaking space
// before it, an en dash in number ranges, non-breaking spaces after short words
// and before particles, with numbers, units, № and initials; ellipsis, ©, ±, ×;
// extra spaces. English text gets “curly” quotes and its own short words.
// Every change is an edit of the text with its styles (a bold word stays bold);
// line breaks are never touched, links and e-mails are left as they are.

import type { TextRun } from '#core';
import { editRuns, runStyleAt } from '#layout';

export const NBSP = ' ';

interface State {
  text: string;
  runs: TextRun[];
  changes: number;
}

/** Web addresses and e-mails: no rule touches them. */
function protectedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/(?:https?:\/\/|www\.)[^\s«»"]+|[\w.+-]+@[\w-]+\.[\w.-]+/giu)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** Replaces `length` characters at `at` with `insert`, keeping the styles of the characters around. */
function edit(s: State, at: number, length: number, insert: string): void {
  const text = s.text.slice(0, at) + insert + s.text.slice(at + length);
  // What replaces characters takes the style of the first of them (a quote in a bold run stays bold).
  s.runs = editRuns(s.runs, at, length, insert.length, text.length, length > 0 ? runStyleAt(s.runs, at) : null);
  s.text = text;
  s.changes++;
}

/** Applies a rule to every match, from the end so earlier positions stay right. */
function pass(s: State, re: RegExp, replace: (m: RegExpExecArray) => string): void {
  const guard = protectedRanges(s.text);
  const matches = [...s.text.matchAll(re)] as RegExpExecArray[];
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    const at = m.index;
    const out = replace(m);
    if (out === m[0]) continue;
    // Inside an address, or right after one (a rule looking back would read the address).
    if (guard.some(([a, b]) => at <= b && at + m[0].length > a)) continue;
    edit(s, at, m[0].length, out);
  }
}

/** Words bound to the next one by a non-breaking space (besides any word of one or two letters). */
const BIND_RU = ['без', 'для', 'над', 'под', 'при', 'про', 'обо', 'изо', 'ото', 'или', 'как', 'что', 'где', 'это', 'через', 'перед', 'между', 'около', 'после', 'вне', 'меж', 'ради', 'сквозь'];
const BIND_EN = ['the', 'and', 'for', 'but', 'nor', 'not', 'via'];

/** Russian unless there are more Latin letters than Cyrillic ones. */
export function isRussian(text: string): boolean {
  // Addresses and e-mails are Latin whatever the language.
  for (const [a, b] of protectedRanges(text).reverse()) text = text.slice(0, a) + text.slice(b);
  const cyr = (text.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  return cyr >= lat;
}

/** Quotes by nesting: «outer „inner“ outer» in Russian, “outer ‘inner’ outer” in English. */
function quotes(s: State, ru: boolean): void {
  const [open1, close1, open2, close2] = ru ? ['«', '»', '„', '“'] : ['“', '”', '‘', '’'];
  const guard = protectedRanges(s.text);
  // Straight quotes always; curly ones of the other language in Russian text.
  const candidates = ru ? '"“”„«»' : '"“”';
  let depth = 0;
  const plan: [number, string][] = [];
  for (let i = 0; i < s.text.length; i++) {
    const ch = s.text[i]!;
    if (!candidates.includes(ch) || guard.some(([a, b]) => i >= a && i < b)) continue;
    // A paragraph starts afresh.
    const prev = i === 0 ? '' : s.text[i - 1]!;
    if (prev === '\n') depth = 0;
    const opening = ch === '«' || ch === '„' ? true : ch === '»' ? false : i === 0 || /[\s([{—–\-/«„“‘]/u.test(prev);
    // In Russian text “ after a letter closes an inner quote, before one it opens.
    let out: string;
    if (opening) {
      out = depth === 0 ? open1 : open2;
      depth = Math.min(depth + 1, 2);
    } else {
      out = depth >= 2 ? close2 : close1;
      depth = Math.max(depth - 1, 0);
    }
    if (out !== ch) plan.push([i, out]);
  }
  for (let k = plan.length - 1; k >= 0; k--) edit(s, plan[k]![0], 1, plan[k]![1]);
}

/** The text set by the rules; the runs follow the characters. `changes` — how many edits were made. */
export function typographRuns(text: string, runs: readonly TextRun[]): { text: string; runs: TextRun[]; changes: number } {
  const s: State = { text, runs: [...runs], changes: 0 };
  const ru = isRussian(text);
  const L = '\\p{L}';

  // Spaces: several in a row → one; none after an opening bracket or quote, none before punctuation.
  pass(s, /[ \t]{2,}/gu, () => ' ');
  pass(s, /(?<=[(\[«„“])[ \t]+/gu, () => '');
  pass(s, /(?<=\S)[ \t]+(?=[,.;:!?)\]»…])/gu, () => '');

  // Symbols.
  pass(s, /\.{3}/gu, () => '…');
  pass(s, /\((?:c|C|с|С)\)/gu, () => '©');
  pass(s, /\((?:r|R)\)/gu, () => '®');
  pass(s, /\((?:tm|TM)\)/gu, () => '™');
  pass(s, /\+-/gu, () => '±');
  pass(s, /(?<=\d)( ?)[xх]( ?)(?=\d)/gu, (m) => `${m[1]}×${m[2]}`);

  // Dashes: between words — an em dash with a non-breaking space before it; a dialogue line opens with one.
  pass(s, /(?<=\S)[ \t ]+(?:-{1,2}|–|—)[ \t]+/gu, () => `${NBSP}— `);
  pass(s, /(?<=^|\n)(?:-{1,2}|–)[ \t]+/gu, () => '— ');
  // Number ranges (10–20, 1941–1945); not dates or phone numbers with more parts.
  pass(s, /(?<![\d-])(\d{1,4})-(\d{1,4})(?![\d-])/gu, (m) => `${m[1]}–${m[2]}`);

  quotes(s, ru);
  // An apostrophe inside a word.
  pass(s, new RegExp(`(?<=${L})'(?=${L})`, 'gu'), () => '’');

  // Non-breaking spaces after short words: «в доме», «и в доме», «для всех».
  const bind = ru ? BIND_RU : BIND_EN;
  pass(s, new RegExp(`(?<=(?:^|[\\s(«„“"—–-])(?:${L}{1,2}|${bind.join('|')}))[ \\t](?=\\S)`, 'giu'), () => NBSP);
  if (ru) {
    // …and before particles: «он же», «был бы», «так ли».
    pass(s, new RegExp(`(?<=${L})[ \\t](?=(?:ли|ль|же|ж|бы|б)(?!${L}))`, 'giu'), () => NBSP);
    // Abbreviations: т. е., т. д., т. п., т. к., т. н., в т. ч.
    pass(s, new RegExp(`(?<!${L})([тТ])\\.[ \\t]?([едпкнч])\\.`, 'gu'), (m) => `${m[1]}.${NBSP}${m[2]}.`);
  }
  // Initials: А. С. Пушкин.
  pass(s, new RegExp(`(?<!${L})(\\p{Lu})\\.[ \\t]?(?=\\p{Lu})`, 'gu'), (m) => `${m[1]}.${NBSP}`);
  // Numbers: with what they count (10 кг, 5 %, 2026 г., 3 px), after № and §, in groups of thousands.
  pass(s, new RegExp(`(?<=\\d)[ \\t](?=[%‰°₽$€]|${L}{1,4}\\.?(?!${L}))`, 'gu'), () => NBSP);
  pass(s, /([№§])[ \t]?(?=\d)/gu, (m) => `${m[1]}${NBSP}`);
  pass(s, /(?<=(?:^|[^\d])\d{1,3}(?: \d{3})*)[ \t](?=\d{3}(?!\d))/gu, () => NBSP);

  return { text: s.text, runs: s.runs, changes: s.changes };
}

/** The text alone, set by the rules. */
export function typograph(text: string): string {
  return typographRuns(text, []).text;
}
