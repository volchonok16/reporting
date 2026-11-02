// Arithmetic in numeric inputs (FR-UI-010): "120/3", "48+16", "(8+4)*2", "-4".
// A small recursive-descent parser — never eval().
//
// Grammar:
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/') factor)*
//   factor := ('+' | '-') factor | number | '(' expr ')'

import { tr } from '#core';
export type ExpressionResult = { ok: true; value: number } | { ok: false; error: string };

export function evaluateExpression(source: string): ExpressionResult {
  const text = source.replace(/,/g, '.').replace(/\s+/g, '');
  let pos = 0;

  const peek = () => text.charAt(pos);

  function number(): number {
    const match = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(pos));
    if (!match) throw new Error(tr('Ожидалось число в позиции {0}', pos + 1));
    pos += match[0].length;
    return Number(match[0]);
  }

  function factor(): number {
    const ch = peek();
    if (ch === '+') {
      pos++;
      return factor();
    }
    if (ch === '-') {
      pos++;
      return -factor();
    }
    if (ch === '(') {
      pos++;
      const value = expr();
      if (peek() !== ')') throw new Error(tr('Не хватает закрывающей скобки'));
      pos++;
      return value;
    }
    return number();
  }

  function term(): number {
    let value = factor();
    for (;;) {
      const ch = peek();
      if (ch === '*' || ch === '×') {
        pos++;
        value *= factor();
      } else if (ch === '/' || ch === '÷') {
        pos++;
        const divisor = factor();
        if (divisor === 0) throw new Error(tr('Деление на ноль'));
        value /= divisor;
      } else return value;
    }
  }

  function expr(): number {
    let value = term();
    for (;;) {
      const ch = peek();
      if (ch === '+') {
        pos++;
        value += term();
      } else if (ch === '-' || ch === '−') {
        pos++;
        value -= term();
      } else return value;
    }
  }

  try {
    if (text.length === 0) return { ok: false, error: tr('Пустое значение') };
    const value = expr();
    if (pos !== text.length) return { ok: false, error: tr('Лишний символ «{0}»', text.charAt(pos)) };
    if (!Number.isFinite(value)) return { ok: false, error: tr('Некорректное значение') };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Applies input to a current value. A leading "+" or "-" followed by an operand
 * with no other leading content is treated as relative when `relative` is set:
 * "+10" adds 10 to each selected object (FR-UI-011).
 */
export function applyNumericInput(input: string, current: number, relative: boolean): ExpressionResult {
  const trimmed = input.trim();
  if (relative && /^[+\-−]\s*[\d.(]/.test(trimmed)) {
    const delta = evaluateExpression(trimmed);
    return delta.ok ? { ok: true, value: current + delta.value } : delta;
  }
  return evaluateExpression(trimmed);
}
