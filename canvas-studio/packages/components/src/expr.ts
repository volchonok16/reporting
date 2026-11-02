// Expressions for prototype logic (FR-PRT-040, 041) and variable values
// (FR-VAR-003): values of variables, arithmetic, string concatenation,
// comparisons and logic, written the way a designer would: `{count} + 1`,
// `!{isOpen}`, `"Привет, " + {name}`, `{count} > 3 и не {isOpen}`,
// `{space.base} * 2`, `{size.m} + 4px`, `{isDense} ? 8 : 12`,
// `lighten({brand}, 10%)`. Own tokenizer and Pratt parser; every error carries
// its position so the editor can underline it.
//
// Variables are written by name in braces. In the file they are stored by id
// (`{#<id>}`), so renaming a variable never breaks an expression.

import { tr } from '#core';
import type { Color } from '#core';

export type ExprValue = number | string | boolean | Color;

export class ExprError extends Error {
  readonly start: number;
  readonly end: number;
  constructor(message: string, start: number, end: number) {
    super(message);
    this.start = start;
    this.end = end;
  }
}

type Token =
  | { kind: 'num'; value: number; start: number; end: number }
  | { kind: 'str'; value: string; start: number; end: number }
  | { kind: 'bool'; value: boolean; start: number; end: number }
  | { kind: 'color'; value: Color; start: number; end: number }
  | { kind: 'var'; ref: string; start: number; end: number }
  | { kind: 'fn'; name: string; start: number; end: number }
  | { kind: 'op'; value: string; start: number; end: number }
  | { kind: 'end'; start: number; end: number };

export type Expr =
  | { kind: 'lit'; value: ExprValue; start: number; end: number }
  | { kind: 'var'; ref: string; start: number; end: number }
  | { kind: 'unary'; op: '-' | '!'; arg: Expr; start: number; end: number }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; start: number; end: number }
  | { kind: 'cond'; test: Expr; then: Expr; else: Expr; start: number; end: number }
  | { kind: 'call'; name: string; args: Expr[]; start: number; end: number };

/** Words accepted as operators, in Russian and English. */
const WORD_OPS: Record<string, string> = { и: '&&', and: '&&', или: '||', or: '||', не: '!', not: '!' };
const WORD_BOOLS: Record<string, boolean> = { true: true, false: false, истина: true, ложь: false, да: true, нет: false };
const SYMBOLS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', '=', '?', ':', ','];

/** Functions: colours and rounding (FR-VAR-003). Amounts take `10%`, `0.1` or `10`. */
const FUNCTIONS: Record<string, { min: number; max: number }> = {
  lighten: { min: 2, max: 2 },
  darken: { min: 2, max: 2 },
  mix: { min: 2, max: 3 },
  alpha: { min: 2, max: 2 },
  min: { min: 1, max: 99 },
  max: { min: 1, max: 99 },
  round: { min: 1, max: 2 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  abs: { min: 1, max: 1 },
  clamp: { min: 3, max: 3 },
};

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === '{') {
      const close = text.indexOf('}', i + 1);
      if (close < 0) throw new ExprError(tr('Нет закрывающей скобки «}»'), i, text.length);
      const ref = text.slice(i + 1, close).trim();
      if (!ref) throw new ExprError(tr('Пустое имя переменной'), i, close + 1);
      out.push({ kind: 'var', ref, start, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '«') {
      const quote = ch === '«' ? '»' : ch;
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\' && j + 1 < text.length) j++;
        value += text[j];
        j++;
      }
      if (j >= text.length) throw new ExprError(tr('Строка не закрыта кавычкой'), i, text.length);
      out.push({ kind: 'str', value, start, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const m = /^#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/i.exec(text.slice(i));
      if (!m) throw new ExprError(tr('Цвет пишется как #RRGGBB'), i, i + 1);
      out.push({ kind: 'color', value: hexColor(m[1]!), start, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    // A decimal comma only between digits that are not an argument list: `1,5` is a number, `{a}, 5` are two arguments.
    const num = /^(\d+(?:\.\d+|,\d+(?!\s*[,)]|\d))?|\.\d+)(px|rem|em)?(%(?=\s*(?:[,)]|$)))?/i.exec(text.slice(i));
    if (num) {
      let value = Number(num[1]!.replace(',', '.'));
      const unit = num[2]?.toLowerCase();
      // rem and em count from the base size of 16 px (FR-VAR-004); 10% is 0.1.
      if (unit === 'rem' || unit === 'em') value *= 16;
      if (num[3]) value /= 100;
      out.push({ kind: 'num', value, start, end: i + num[0].length });
      i += num[0].length;
      continue;
    }
    const word = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(text.slice(i));
    if (word) {
      const w = word[0].toLowerCase();
      if (w in FUNCTIONS && /^\s*\(/.test(text.slice(i + word[0].length))) out.push({ kind: 'fn', name: w, start, end: i + word[0].length });
      else if (w in WORD_OPS) out.push({ kind: 'op', value: WORD_OPS[w]!, start, end: i + word[0].length });
      else if (w in WORD_BOOLS) out.push({ kind: 'bool', value: WORD_BOOLS[w]!, start, end: i + word[0].length });
      else throw new ExprError(tr('Непонятное слово «{0}». Переменные пишутся в фигурных скобках: {{1}}', word[0], word[0]), i, i + word[0].length);
      i += word[0].length;
      continue;
    }
    const sym = SYMBOLS.find((s) => text.startsWith(s, i));
    if (!sym) throw new ExprError(tr('Непонятный символ «{0}»', ch), i, i + 1);
    out.push({ kind: 'op', value: sym === '=' ? '==' : sym, start, end: i + sym.length });
    i += sym.length;
  }
  out.push({ kind: 'end', start: text.length, end: text.length });
  return out;
}

function hexColor(hex: string): Color {
  const h = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const v = (k: number) => parseInt(h.slice(k, k + 2), 16) / 255;
  return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 1 };
}

/** Binding power of binary operators: logic < comparison < sum < product. */
const BINARY: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

export function parseExpr(text: string): Expr {
  const tokens = tokenize(text);
  if (tokens.length === 1) throw new ExprError(tr('Пустое выражение'), 0, 0);
  let pos = 0;
  const peek = () => tokens[pos]!;
  const next = () => tokens[pos++]!;
  const primary = (): Expr => {
    const t = next();
    switch (t.kind) {
      case 'num':
      case 'str':
      case 'bool':
      case 'color':
        return { kind: 'lit', value: t.value, start: t.start, end: t.end };
      case 'var':
        return { kind: 'var', ref: t.ref, start: t.start, end: t.end };
      case 'fn': {
        next(); // (
        const args: Expr[] = [];
        if (!(peek().kind === 'op' && (peek() as { value: string }).value === ')')) {
          for (;;) {
            args.push(ternary());
            const sep = peek();
            if (sep.kind === 'op' && sep.value === ',') {
              next();
              continue;
            }
            break;
          }
        }
        const close = next();
        if (close.kind !== 'op' || close.value !== ')') throw new ExprError(tr('Нет закрывающей скобки «)» у {0}(…)', t.name), close.start, close.end);
        const spec = FUNCTIONS[t.name]!;
        if (args.length < spec.min || args.length > spec.max) {
          throw new ExprError(spec.min === spec.max ? tr('{0}(…) принимает {1} значения через запятую', t.name, spec.min) : tr('{0}(…) принимает от {1} до {2} значений через запятую', t.name, spec.min, spec.max), t.start, close.end);
        }
        return { kind: 'call', name: t.name, args, start: t.start, end: close.end };
      }
      case 'op':
        if (t.value === '(') {
          const inner = ternary();
          const close = next();
          if (close.kind !== 'op' || close.value !== ')') throw new ExprError(tr('Нет закрывающей скобки «)»'), close.start, close.end);
          return { ...inner, start: t.start, end: close.end };
        }
        if (t.value === '-' || t.value === '!') {
          const arg = expr(7);
          return { kind: 'unary', op: t.value, arg, start: t.start, end: arg.end };
        }
        throw new ExprError(tr('Здесь не хватает значения перед «{0}»', t.value), t.start, t.end);
      case 'end':
        throw new ExprError(tr('Выражение оборвалось: не хватает значения'), t.start, t.end);
    }
  };
  const expr = (minPower: number): Expr => {
    let left = primary();
    for (;;) {
      const t = peek();
      if (t.kind !== 'op') {
        if (t.kind === 'end') break;
        if (t.kind === 'fn') throw new ExprError(tr('Между значениями не хватает знака (+, −, и, или…)'), t.start, t.end);
        throw new ExprError(tr('Между значениями не хватает знака (+, −, и, или…)'), t.start, t.end);
      }
      const power = BINARY[t.value];
      if (power === undefined || power <= minPower) break;
      next();
      const right = expr(power);
      left = { kind: 'binary', op: t.value, left, right, start: left.start, end: right.end };
    }
    return left;
  };
  // `условие ? да : нет` — the loosest of all, right-associative.
  const ternary = (): Expr => {
    const test = expr(0);
    const q = peek();
    if (q.kind !== 'op' || q.value !== '?') return test;
    next();
    const then = ternary();
    const colon = next();
    if (colon.kind !== 'op' || colon.value !== ':') throw new ExprError(tr('После «?» нужно «:» — значение, если условие ложно'), colon.start, colon.end);
    const otherwise = ternary();
    return { kind: 'cond', test, then, else: otherwise, start: test.start, end: otherwise.end };
  };
  const result = ternary();
  const rest = peek();
  if (rest.kind !== 'end') throw new ExprError(rest.kind === 'op' && rest.value === ')' ? tr('Лишняя закрывающая скобка') : rest.kind === 'op' && rest.value === ',' ? tr('Запятая разделяет значения только внутри функции: lighten({a}, 10%)') : tr('Лишнее в конце выражения'), rest.start, rest.end);
  return result;
}

/** Reads a variable: `ref` is a name (`Group/Name`) or a stored id (`#id`). */
export type VariableReader = (ref: string) => ExprValue | undefined;

const typeName = (v: ExprValue) => (typeof v === 'number' ? tr('число') : typeof v === 'string' ? tr('строка') : typeof v === 'boolean' ? tr('логическое') : tr('цвет'));

function colorHex(c: Color): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a) : ''}`.toUpperCase();
}

export function formatValue(v: ExprValue): string {
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'boolean') return v ? tr('истина') : tr('ложь');
  if (typeof v === 'string') return v;
  return colorHex(v);
}

function equal(a: ExprValue, b: ExprValue): boolean {
  if (typeof a === 'object' && typeof b === 'object') return colorHex(a) === colorHex(b);
  return a === b;
}

export function evaluate(e: Expr, read: VariableReader): ExprValue {
  switch (e.kind) {
    case 'lit':
      return e.value;
    case 'cond': {
      const test = evaluate(e.test, read);
      if (typeof test !== 'boolean') throw new ExprError(tr('Перед «?» нужно условие (да или нет), а здесь {0}', typeName(test)), e.test.start, e.test.end);
      return evaluate(test ? e.then : e.else, read);
    }
    case 'call':
      return call(e, e.args.map((a) => evaluate(a, read)));
    case 'var': {
      const v = read(e.ref);
      if (v === undefined) throw new ExprError(tr('Нет переменной {{0}}', e.ref.startsWith('#') ? '?' : e.ref), e.start, e.end);
      return v;
    }
    case 'unary': {
      const v = evaluate(e.arg, read);
      if (e.op === '!') {
        if (typeof v !== 'boolean') throw new ExprError(tr('«не» работает с логическим значением, а здесь {0}', typeName(v)), e.start, e.end);
        return !v;
      }
      if (typeof v !== 'number') throw new ExprError(tr('Минус работает с числом, а здесь {0}', typeName(v)), e.start, e.end);
      return -v;
    }
    case 'binary': {
      const op = e.op;
      // Logic short-circuits, as in any programming language.
      if (op === '&&' || op === '||') {
        const l = evaluate(e.left, read);
        if (typeof l !== 'boolean') throw new ExprError(tr('«{0}» соединяет логические значения, а слева {1}', op === '&&' ? tr('и') : tr('или'), typeName(l)), e.left.start, e.left.end);
        if (op === '&&' ? !l : l) return l;
        const r = evaluate(e.right, read);
        if (typeof r !== 'boolean') throw new ExprError(tr('«{0}» соединяет логические значения, а справа {1}', op === '&&' ? tr('и') : tr('или'), typeName(r)), e.right.start, e.right.end);
        return r;
      }
      const l = evaluate(e.left, read);
      const r = evaluate(e.right, read);
      if (op === '==') return equal(l, r);
      if (op === '!=') return !equal(l, r);
      if (op === '+' && (typeof l === 'string' || typeof r === 'string')) return formatValue(l) + formatValue(r);
      if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (!((typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string'))) {
          throw new ExprError(tr('Сравнивать можно числа или строки, а здесь {0} и {1}', typeName(l), typeName(r)), e.start, e.end);
        }
        return op === '<' ? l < r : op === '<=' ? l <= r : op === '>' ? l > r : l >= r;
      }
      if (typeof l !== 'number' || typeof r !== 'number') throw new ExprError(tr('«{0}» работает с числами, а здесь {1} и {2}', op, typeName(l), typeName(r)), e.start, e.end);
      switch (op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          if (r === 0) throw new ExprError(tr('Деление на ноль'), e.right.start, e.right.end);
          return l / r;
        default:
          if (r === 0) throw new ExprError(tr('Остаток от деления на ноль'), e.right.start, e.right.end);
          return l % r;
      }
    }
  }
}

// ---------- functions ----------

/** An amount as a share: `10%` and `0.1` are 0.1, and so is a plain `10` (more than 1 reads as percent). */
const share = (v: number) => Math.max(0, Math.min(1, v > 1 ? v / 100 : v));

function rgbToHsl(c: Color): [number, number, number] {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === c.r ? (c.g - c.b) / d + (c.g < c.b ? 6 : 0) : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number, a: number): Color {
  if (s === 0) return { r: l, g: l, b: l, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
  };
  return { r: ch(h + 1 / 3), g: ch(h), b: ch(h - 1 / 3), a };
}

function call(e: Extract<Expr, { kind: 'call' }>, args: ExprValue[]): ExprValue {
  const color = (i: number): Color => {
    const v = args[i]!;
    if (typeof v !== 'object') throw new ExprError(tr('{0}(…): значение {1} — цвет, а здесь {2}', e.name, i + 1, typeName(v)), e.args[i]!.start, e.args[i]!.end);
    return v;
  };
  const number = (i: number): number => {
    const v = args[i]!;
    if (typeof v !== 'number') throw new ExprError(tr('{0}(…): значение {1} — число, а здесь {2}', e.name, i + 1, typeName(v)), e.args[i]!.start, e.args[i]!.end);
    return v;
  };
  switch (e.name) {
    case 'lighten':
    case 'darken': {
      // As in Sass: the HSL lightness moves by the amount.
      const c = color(0);
      const [h, s, l] = rgbToHsl(c);
      const by = share(number(1)) * (e.name === 'lighten' ? 1 : -1);
      return hslToRgb(h, s, Math.max(0, Math.min(1, l + by)), c.a);
    }
    case 'mix': {
      // As in Sass: the weight is the share of the first colour.
      const a = color(0);
      const b = color(1);
      const w = args.length > 2 ? share(number(2)) : 0.5;
      return { r: a.r * w + b.r * (1 - w), g: a.g * w + b.g * (1 - w), b: a.b * w + b.b * (1 - w), a: a.a * w + b.a * (1 - w) };
    }
    case 'alpha':
      return { ...color(0), a: share(number(1)) };
    case 'min':
      return Math.min(...args.map((_, i) => number(i)));
    case 'max':
      return Math.max(...args.map((_, i) => number(i)));
    case 'round': {
      const step = args.length > 1 ? number(1) : 1;
      if (step <= 0) throw new ExprError(tr('round(…): шаг округления больше нуля'), e.args[1]!.start, e.args[1]!.end);
      return Math.round(number(0) / step) * step;
    }
    case 'floor':
      return Math.floor(number(0));
    case 'ceil':
      return Math.ceil(number(0));
    case 'abs':
      return Math.abs(number(0));
    default: {
      const lo = number(1);
      const hi = number(2);
      return Math.min(Math.max(number(0), Math.min(lo, hi)), Math.max(lo, hi));
    }
  }
}

/** All variable references of an expression text, with positions (for converting names ↔ ids). */
export function references(text: string): { ref: string; start: number; end: number }[] {
  const out: { ref: string; start: number; end: number }[] = [];
  const re = /\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ ref: m[1]!.trim(), start: m.index, end: m.index + m[0].length });
  return out;
}

/** Replaces every `{ref}` with `{map(ref)}` (unchanged when map returns null). */
export function mapReferences(text: string, map: (ref: string) => string | null): string {
  return text.replace(/\{([^{}]*)\}/g, (whole, ref: string) => {
    const to = map(ref.trim());
    return to === null ? whole : `{${to}}`;
  });
}

/** Parses and evaluates; returns the value or the error (for live validation in the panel). */
export function tryEvaluate(text: string, read: VariableReader): { value: ExprValue } | { error: ExprError } {
  try {
    return { value: evaluate(parseExpr(text), read) };
  } catch (error) {
    if (error instanceof ExprError) return { error };
    throw error;
  }
}
