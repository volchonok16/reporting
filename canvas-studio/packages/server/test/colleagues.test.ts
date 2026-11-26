import assert from 'node:assert/strict';
import test from 'node:test';
import { colleagueNeedles, foldPersonQuery } from '../src/pg-storage.ts';

test('фамилия находится без регистра и с ё как е', () => {
  assert.equal(foldPersonQuery('Иванов'), 'иванов');
  assert.equal(foldPersonQuery('иванов'), foldPersonQuery('ИВАНОВ'));
  assert.equal(foldPersonQuery('Ёлкин'), 'елкин');
  assert.equal(foldPersonQuery('ёлкин'), 'елкин');
});

test('несколько слов фамилии — отдельные образцы, почта целиком', () => {
  assert.equal(colleagueNeedles('И'), null);
  const one = colleagueNeedles('  Иванов ');
  assert.deepEqual(one, { emailLike: '%иванов%', nameLikes: ['%иванов%'] });
  const two = colleagueNeedles('Иванов Иван');
  assert.deepEqual(two?.nameLikes, ['%иванов%', '%иван%']);
  assert.equal(colleagueNeedles('A%_b')?.emailLike, '%a\\%\\_b%');
});
