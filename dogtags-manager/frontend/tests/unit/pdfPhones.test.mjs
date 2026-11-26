import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPhoneNumbers, phoneListText, uniquePhoneNumbers } from '../../src/features/pdf/phoneNumbers.ts';

test('PDF phone extraction accepts plain and formatted numbers while preserving prefixes', () => {
  const text = 'Phones: +7 (999) 123-45-67, 8 800 555 35 35; 999-123-45-67.\n79000000011 79000000022\n+7\u00a0(900)\u202f000–11—22';
  assert.deepEqual(extractPhoneNumbers(text), ['79991234567', '88005553535', '9991234567', '79000000011', '79000000022', '79000001122']);
});

test('dates, longer identifiers and numbers attached to words are not telephone matches', () => {
  assert.deepEqual(extractPhoneNumbers('29.10.2026 123456789012 1234567890123456 ID79000000011ABC 123\n4567890'), []);
});

test('one output list preserves occurrence order and can remove repeated numbers', () => {
  const numbers = extractPhoneNumbers('79000000011\n79000000022\n+7 (900) 000-00-11');
  assert.equal(numbers.length, 3);
  assert.deepEqual(uniquePhoneNumbers(numbers), ['79000000011', '79000000022']);
  assert.equal(phoneListText(uniquePhoneNumbers(numbers), 'txt'), '79000000011\r\n79000000022\r\n');
  assert.equal(phoneListText(numbers, 'csv'), 'MSISDN\r\n79000000011\r\n79000000022\r\n79000000011\r\n');
});
