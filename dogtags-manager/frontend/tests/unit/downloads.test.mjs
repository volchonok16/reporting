import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceFilename } from '../../src/api/downloads.ts';

test('source downloads retain original extensions and UTF-8 filenames', () => {
  assert.equal(sourceFilename('attachment; filename="source.xlsx"', 'source.csv'), 'source.xlsx');
  assert.equal(sourceFilename("attachment; filename*=utf-8''%D0%A2%D0%B5%D1%81%D1%82.xlsb", 'source.csv'), 'Тест.xlsb');
  assert.equal(sourceFilename('attachment; filename=original.numbers', 'source.csv'), 'original.numbers');
  assert.equal(sourceFilename(null, 'fallback.csv'), 'fallback.csv');
  assert.equal(sourceFilename("attachment; filename*=UTF-8''%ZZ; filename=plain.csv", 'fallback.csv'), 'plain.csv');
});
