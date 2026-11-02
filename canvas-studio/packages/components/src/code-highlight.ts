// Syntax highlighting of board code blocks (roadmap step 10): our own small
// tokenizer, no packages. It knows comments, strings, numbers, keywords,
// literals, function calls, types and — for HTML and XML — tags and attributes;
// enough to read code on a board, not a compiler. The colours are the runs of
// the block's text, so export, PDF and other people see the same.

import type { Paint, TextRun } from '#core';

export type CodeLang = 'plain' | 'js' | 'ts' | 'py' | 'html' | 'css' | 'json' | 'sql' | 'sh' | 'go' | 'java' | 'kotlin' | 'swift' | 'c' | 'cs' | 'php' | 'rust' | 'ruby';

export const CODE_LANGS: readonly { id: CodeLang; label: string }[] = [
  { id: 'plain', label: 'Текст' },
  { id: 'js', label: 'JavaScript' },
  { id: 'ts', label: 'TypeScript' },
  { id: 'py', label: 'Python' },
  { id: 'html', label: 'HTML / XML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL' },
  { id: 'sh', label: 'Bash' },
  { id: 'go', label: 'Go' },
  { id: 'java', label: 'Java' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'swift', label: 'Swift' },
  { id: 'c', label: 'C / C++' },
  { id: 'cs', label: 'C#' },
  { id: 'php', label: 'PHP' },
  { id: 'rust', label: 'Rust' },
  { id: 'ruby', label: 'Ruby' },
];

export function isCodeLang(v: unknown): v is CodeLang {
  return typeof v === 'string' && CODE_LANGS.some((l) => l.id === v);
}

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'function' | 'type' | 'tag' | 'attr' | 'property';

export interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

interface Spec {
  line: string[];
  block: [string, string][];
  quotes: string[];
  keywords: string;
  literals: string;
  /** SQL: keywords in any case. */
  anyCase?: boolean;
  /** Python, Ruby: """…""" strings. */
  triple?: boolean;
  /** Bash, PHP: $name is a variable (shown as a property). */
  dollar?: boolean;
}

const C_LIKE = { line: ['//'], block: [['/*', '*/']] as [string, string][] };
const SPECS: Record<Exclude<CodeLang, 'plain' | 'html' | 'json' | 'css'>, Spec> = {
  js: { ...C_LIKE, quotes: ['"', "'", '`'], keywords: 'async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield', literals: 'true false null undefined NaN Infinity' },
  ts: { ...C_LIKE, quotes: ['"', "'", '`'], keywords: 'abstract as async await break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while yield any boolean never number object string symbol unknown', literals: 'true false null undefined NaN Infinity' },
  py: { line: ['#'], block: [], quotes: ['"', "'"], triple: true, keywords: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self', literals: 'True False None' },
  sql: { line: ['--'], block: [['/*', '*/']], quotes: ["'", '"'], anyCase: true, keywords: 'select from where and or not insert into values update set delete create table drop alter add column index primary key foreign references join left right inner outer full on as group by order having limit offset union all distinct case when then else end in is like between exists returning with view default unique check desc asc count sum avg min max', literals: 'null true false' },
  sh: { line: ['#'], block: [], quotes: ['"', "'"], dollar: true, keywords: 'if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit echo cd source alias sudo', literals: 'true false' },
  go: { ...C_LIKE, quotes: ['"', "'", '`'], keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var', literals: 'true false nil iota' },
  java: { ...C_LIKE, quotes: ['"', "'"], keywords: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public record return short static super switch synchronized this throw throws try var void volatile while', literals: 'true false null' },
  kotlin: { ...C_LIKE, quotes: ['"', "'"], keywords: 'as break class companion constructor continue data do else enum fun if import in init interface internal is lateinit object open operator out override package private protected public return sealed super suspend this throw try typealias val var vararg when where while', literals: 'true false null' },
  swift: { ...C_LIKE, quotes: ['"'], keywords: 'as associatedtype break case catch class continue default defer do else enum extension fallthrough for func guard if import in init inout internal is let mutating open operator private protocol public repeat rethrows return self static struct subscript super switch throw throws try typealias var where while async await', literals: 'true false nil' },
  c: { ...C_LIKE, line: ['//', '#'], quotes: ['"', "'"], keywords: 'auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern float for friend goto if inline int long namespace new operator private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while', literals: 'true false NULL nullptr' },
  cs: { ...C_LIKE, quotes: ['"', "'"], keywords: 'abstract as async await base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach get if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly record ref return sealed set short sizeof static string struct switch this throw try typeof uint ulong using var virtual void volatile while yield', literals: 'true false null' },
  php: { ...C_LIKE, line: ['//', '#'], quotes: ['"', "'"], dollar: true, keywords: 'abstract and array as break case catch class clone const continue declare default do echo else elseif empty enum extends final finally fn for foreach function global if implements include interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while yield', literals: 'true false null TRUE FALSE NULL' },
  rust: { ...C_LIKE, quotes: ['"'], keywords: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while', literals: 'true false None Some Ok Err' },
  ruby: { line: ['#'], block: [['=begin', '=end']], quotes: ['"', "'"], keywords: 'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_accessor', literals: 'true false nil' },
};

const words = (s: string) => new Set(s.split(' '));
const SETS = new Map<Spec, { keywords: Set<string>; literals: Set<string> }>();
function setsOf(spec: Spec) {
  let s = SETS.get(spec);
  if (!s) {
    s = { keywords: words(spec.anyCase ? spec.keywords.toLowerCase() : spec.keywords), literals: words(spec.anyCase ? spec.literals.toLowerCase() : spec.literals) };
    SETS.set(spec, s);
  }
  return s;
}

const IDENT_START = /[\p{L}_$]/u;
const IDENT = /[\p{L}\p{N}_$]/u;
const NUMBER = /^(0[xX][\da-fA-F_]+|0[bB][01_]+|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)([eE][+-]?\d+)?)[a-zA-Z%]*/;

/** Where a string opened at `i` with `q` ends (past its closing quote, or the line's end). */
function stringEnd(text: string, i: number, q: string, multiline: boolean): number {
  let j = i + q.length;
  while (j < text.length) {
    if (text[j] === '\\') {
      j += 2;
      continue;
    }
    if (text.startsWith(q, j)) return j + q.length;
    if (text[j] === '\n' && !multiline) return j;
    j++;
  }
  return text.length;
}

function codeTokens(text: string, spec: Spec): Token[] {
  const out: Token[] = [];
  const { keywords, literals } = setsOf(spec);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const line = spec.line.find((m) => text.startsWith(m, i) && !(m === '#' && spec === SPECS.c && !/^#\s*\w/.test(text.slice(i))));
    if (line) {
      const end = text.indexOf('\n', i);
      out.push({ start: i, end: end < 0 ? text.length : end, kind: spec === SPECS.c && line === '#' ? 'keyword' : 'comment' });
      i = end < 0 ? text.length : end;
      continue;
    }
    const block = spec.block.find(([open]) => text.startsWith(open, i));
    if (block) {
      const end = text.indexOf(block[1], i + block[0].length);
      const stop = end < 0 ? text.length : end + block[1].length;
      out.push({ start: i, end: stop, kind: 'comment' });
      i = stop;
      continue;
    }
    if (spec.triple && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const stop = stringEnd(text, i, text.slice(i, i + 3), true);
      out.push({ start: i, end: stop, kind: 'string' });
      i = stop;
      continue;
    }
    if (spec.quotes.includes(ch)) {
      const stop = stringEnd(text, i, ch, ch === '`');
      out.push({ start: i, end: stop, kind: 'string' });
      i = stop;
      continue;
    }
    if (spec.dollar && ch === '$' && IDENT_START.test(text[i + 1] ?? '')) {
      let j = i + 1;
      while (j < text.length && IDENT.test(text[j]!)) j++;
      out.push({ start: i, end: j, kind: 'property' });
      i = j;
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(text[i + 1] ?? ''))) {
      const prev = text[i - 1] ?? '';
      const m = IDENT.test(prev) ? null : NUMBER.exec(text.slice(i, i + 64));
      if (m) {
        out.push({ start: i, end: i + m[0].length, kind: 'number' });
        i += m[0].length;
        continue;
      }
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT.test(text[j]!)) j++;
      const word = text.slice(i, j);
      const key = spec.anyCase ? word.toLowerCase() : word;
      let k = j;
      while (text[k] === ' ') k++;
      const kind: TokenKind | null = keywords.has(key) ? 'keyword' : literals.has(key) ? 'literal' : text[k] === '(' ? 'function' : /^[A-Z][a-z]/.test(word) && !spec.anyCase ? 'type' : null;
      if (kind) out.push({ start: i, end: j, kind });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function markupTokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"?|'[^']*'?)*)>?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].startsWith('<!--')) {
      out.push({ start: m.index, end: m.index + m[0].length, kind: 'comment' });
      continue;
    }
    const nameStart = m.index + (m[0][1] === '/' ? 2 : 1);
    out.push({ start: nameStart, end: nameStart + m[1]!.length, kind: 'tag' });
    const attrs = m[2] ?? '';
    const base = nameStart + m[1]!.length;
    const ar = /([^\s=/"']+)(\s*=\s*("[^"]*"?|'[^']*'?|[^\s>]+))?/g;
    for (let a = ar.exec(attrs); a; a = ar.exec(attrs)) {
      out.push({ start: base + a.index, end: base + a.index + a[1]!.length, kind: 'attr' });
      if (a[3]) {
        const vs = base + a.index + a[0].length - a[3].length;
        out.push({ start: vs, end: vs + a[3].length, kind: 'string' });
      }
    }
  }
  return out;
}

function cssTokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /\/\*[\s\S]*?(?:\*\/|$)|"[^"\n]*"?|'[^'\n]*'?|(-?[\w-]+)(?=\s*:(?!:))|#[\da-fA-F]{3,8}\b|-?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?|@[\w-]+|[.#]?[A-Za-z_][\w-]*/g;
  let depth = 0;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    for (const c of text.slice(last, m.index)) depth += c === '{' ? 1 : c === '}' ? -1 : 0;
    last = m.index + m[0].length;
    const s = m[0];
    // Outside braces a word is a selector (.class, #id, tag); inside, a word that is not a property is a value, left plain.
    const hex = depth > 0 && /^#[\da-fA-F]{3,8}$/.test(s);
    const word = /^[.#]?[A-Za-z_]/.test(s) && !m[1] && !hex;
    if (word && depth > 0) continue;
    const kind: TokenKind = s.startsWith('/*') ? 'comment' : s[0] === '"' || s[0] === "'" ? 'string' : s[0] === '@' ? 'keyword' : m[1] && depth > 0 ? 'property' : word ? 'tag' : 'number';
    out.push({ start: m.index, end: m.index + s.length, kind });
  }
  return out;
}

function jsonTokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /"(?:[^"\\\n]|\\.)*"?(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const s = m[0];
    if (s[0] === '"') {
      const len = m[1] ? s.length - m[1].length : s.length;
      out.push({ start: m.index, end: m.index + len, kind: m[1] ? 'property' : 'string' });
    } else out.push({ start: m.index, end: m.index + s.length, kind: /^[tfn]/.test(s) ? 'literal' : 'number' });
  }
  return out;
}

/** The coloured parts of a code text, in order, never overlapping. */
export function highlightCode(lang: CodeLang, text: string): Token[] {
  if (lang === 'plain' || text.length > 200_000) return [];
  const tokens = lang === 'html' ? markupTokens(text) : lang === 'css' ? cssTokens(text) : lang === 'json' ? jsonTokens(text) : codeTokens(text, SPECS[lang]);
  return tokens.filter((t) => t.end > t.start);
}

/** The colours of a code block (dark, as most editors). */
export const CODE_THEME = {
  background: '#1F2430',
  text: '#E6E6E6',
  colors: { comment: '#7F8A9E', string: '#A5D6A7', number: '#F2B482', keyword: '#C792EA', literal: '#F2B482', function: '#82AAFF', type: '#FFCB6B', tag: '#F07178', attr: '#FFCB6B', property: '#F07178' } satisfies Record<TokenKind, string>,
} as const;

function paint(hex: string): Paint {
  const n = parseInt(hex.slice(1), 16);
  return { type: 'SOLID', color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 }, opacity: 1, visible: true };
}
const PAINTS = new Map<TokenKind, Paint>();

/** The runs that colour a code text (only fills; the rest of the style is the text's own). */
export function codeRuns(lang: CodeLang, text: string): TextRun[] {
  return highlightCode(lang, text).map((t) => {
    let p = PAINTS.get(t.kind);
    if (!p) PAINTS.set(t.kind, (p = paint(CODE_THEME.colors[t.kind])));
    return { start: t.start, end: t.end, style: { fills: [p] } };
  });
}
