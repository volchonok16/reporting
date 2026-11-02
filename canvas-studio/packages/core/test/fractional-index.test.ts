import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidOrderKey, keyBetween, keysBetween } from '../src/fractional-index.ts';

test('first key and keys around it', () => {
  const first = keyBetween(null, null);
  assert.equal(first, 'a0');
  const after = keyBetween(first, null);
  const before = keyBetween(null, first);
  assert.ok(before < first && first < after);
});

test('keys stay sorted and short under repeated appends and prepends', () => {
  let last: string | null = null;
  const keys: string[] = [];
  for (let i = 0; i < 10_000; i++) {
    last = keyBetween(last, null);
    keys.push(last);
  }
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
  assert.ok((last ?? '').length <= 5, `append keys grew to ${last}`);

  let first: string | null = null;
  for (let i = 0; i < 10_000; i++) first = keyBetween(null, first);
  assert.ok((first ?? '').length <= 6, `prepend keys grew to ${first}`);
});

test('repeated inserts between two keys keep strict order', () => {
  let lo = keyBetween(null, null);
  const hi = keyBetween(lo, null);
  for (let i = 0; i < 500; i++) {
    const mid = keyBetween(lo, hi);
    assert.ok(lo < mid && mid < hi);
    assert.ok(isValidOrderKey(mid));
    lo = mid;
  }
});

test('keysBetween returns n ordered keys inside the bounds', () => {
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);
  const keys = keysBetween(a, b, 25);
  assert.equal(keys.length, 25);
  assert.deepEqual(keys, [...keys].sort());
  assert.ok(keys.every((k) => a < k && k < b));
});

test('invalid bounds are rejected', () => {
  assert.throws(() => keyBetween('a1', 'a0'));
  assert.throws(() => keyBetween('a10', null));
  assert.equal(isValidOrderKey('!!'), false);
});
