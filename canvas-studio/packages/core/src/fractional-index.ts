// Fractional indexing (FR-DOC-006): sibling order is stored as strings that sort
// lexicographically, so two users inserting at the same time never rewrite each
// other's positions. A key is an integer part (its first character encodes the
// length) followed by an optional fractional part, which keeps keys short even
// for long runs of appends.

export const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS.charAt(0);
const LAST = DIGITS.charAt(DIGITS.length - 1);
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);

function digitIndex(ch: string): number {
  const i = DIGITS.indexOf(ch);
  if (i < 0) throw new Error(`Invalid order key digit: ${ch}`);
  return i;
}

/** Midpoint of two fractional parts, `a < b` (b === null means "1"). */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`Order key ${a} must be below ${b}`);
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO))) throw new Error('Trailing zero in order key');
  if (b !== null) {
    // Skip the common prefix.
    let n = 0;
    while ((a.charAt(n) || ZERO) === b.charAt(n)) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? digitIndex(a.charAt(0)) : 0;
  const digitB = b !== null ? digitIndex(b.charAt(0)) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS.charAt(Math.round((digitA + digitB) / 2));
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error(`Invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key.charAt(0));
  if (length > key.length) throw new Error(`Invalid order key: ${key}`);
  return key.slice(0, length);
}

export function isValidOrderKey(key: string): boolean {
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}

function validate(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`Invalid order key: ${key}`);
  const int = integerPart(key);
  for (const ch of key.slice(1)) digitIndex(ch);
  if (key.slice(int.length).endsWith(ZERO)) throw new Error(`Invalid order key: ${key}`);
}

function incrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = digitIndex(digits[i] ?? ZERO) + 1;
    if (d === DIGITS.length) digits[i] = ZERO;
    else {
      digits[i] = DIGITS.charAt(d);
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > 'a') digits.push(ZERO);
  else digits.pop();
  return next + digits.join('');
}

function decrementInteger(x: string): string | null {
  const head = x.charAt(0);
  const digits = x.slice(1).split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = digitIndex(digits[i] ?? ZERO) - 1;
    if (d === -1) digits[i] = LAST;
    else {
      digits[i] = DIGITS.charAt(d);
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return 'Z' + LAST;
  if (head === 'A') return null;
  const prev = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prev < 'Z') digits.push(LAST);
  else digits.pop();
  return prev + digits.join('');
}

/** Returns a key strictly between `a` and `b`; null means "no bound". */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) throw new Error(`Order key ${a} must be below ${b}`);

  if (a === null) {
    if (b === null) return 'a' + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error('Cannot decrement order key any further');
    return res;
  }

  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const next = incrementInteger(ia);
    return next === null ? ia + midpoint(fa, null) : next;
  }

  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const next = incrementInteger(ia);
  if (next === null) throw new Error('Cannot increment order key any further');
  if (next < b) return next;
  return ia + midpoint(fa, null);
}

/** `n` evenly spread keys between `a` and `b`. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    const out: string[] = [];
    let prev = a;
    for (let i = 0; i < n; i++) {
      prev = keyBetween(prev, null);
      out.push(prev);
    }
    return out;
  }
  if (a === null) {
    const out: string[] = [];
    let next = b;
    for (let i = 0; i < n; i++) {
      next = keyBetween(null, next);
      out.push(next);
    }
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}
