import test from 'node:test'
import assert from 'node:assert/strict'
import { validateFields, suggestMsisdnPrefix, suggestLabelCorrection } from '../../src/features/hub/validateFields.ts'

const codes = (values, fields = Object.keys(values), role) =>
  validateFields(values, fields, role).map(({ field, code }) => `${field}:${code}`)

test('Latin label correction proposes matching glyphs without changing the input or guessing other letters', () => {
  const original = 'ООО Vosmerochka: zakaz taxi'
  assert.equal(suggestLabelCorrection('MAV_LABEL_LATIN', original), 'OOO Vosmerochka: zakaz taxi')
  assert.equal(original, 'ООО Vosmerochka: zakaz taxi')
  assert.equal(suggestLabelCorrection('MAV_LABEL_NAME', original), undefined)
  for (const value of ['OOO Vosmerochka', 'Ж Taxi', 'О'.repeat(33)]) {
    assert.equal(suggestLabelCorrection('MAV_LABEL_LATIN', value), undefined)
  }
  assert.equal(suggestLabelCorrection('MAV_LABEL_LATIN', 'Taxi‑Test'), 'Taxi-Test')
})

test('only ordinary hyphen is permitted and typographic dashes have a replacement', () => {
  for (const dash of ['-']) {
    assert.deepEqual(codes({ MAV_LABEL_NAME: `Тест${dash}1`, MAV_LABEL_LATIN: `Test${dash}1` }), [])
  }
  for (const dash of ['–', '—']) {
    assert.ok(codes({ MAV_LABEL_NAME: `Тест${dash}1` }).includes('MAV_LABEL_NAME:label_characters'))
    assert.equal(suggestLabelCorrection('MAV_LABEL_NAME', `Тест${dash}1`), 'Тест-1')
  }
})

test('quotes and forbidden punctuation have one explicit valid replacement; letters are never deleted', () => {
  assert.equal(suggestLabelCorrection('MAV_LABEL_NAME', 'ООО «Тест»'), 'ООО Тест')
  assert.equal(suggestLabelCorrection('MAV_LABEL_LATIN', 'ООО "Taxi"_!'), 'OOO Taxi')
  assert.equal(suggestLabelCorrection('MAV_LABEL_LATIN', 'Ж Taxi'), undefined)
  assert.equal(suggestLabelCorrection('MAV_LABEL_NAME', '""'), undefined)
})

test('ten digit MSISDN is an error with an optional prefix suggestion, never a silent correction', () => {
  const values = { MSISDN: '9937967877' }
  assert.deepEqual(codes(values), ['MSISDN:msisdn_country_prefix'])
  assert.equal(values.MSISDN, '9937967877')
  assert.equal(suggestMsisdnPrefix(values.MSISDN), '79937967877')
  assert.deepEqual(codes({ MSISDN: '79937967877' }), [])
  for (const value of ['79937967877', '001900', '9937967877\n', '９９３７９６７８７７']) {
    assert.equal(suggestMsisdnPrefix(value), undefined)
  }
})

test('label errors follow invalid, corrected and invalid values without mutation', () => {
  const values = { MAV_LABEL_NAME: 'Teст', MAV_LABEL_LATIN: 'A'.repeat(33) }
  assert.deepEqual(codes(values), ['MAV_LABEL_NAME:label_contains_latin', 'MAV_LABEL_LATIN:label_length'])
  assert.deepEqual(codes({ MAV_LABEL_NAME: 'Тест', MAV_LABEL_LATIN: 'Test' }), [])
  assert.deepEqual(codes({ MAV_LABEL_NAME: 'Тест_', MAV_LABEL_LATIN: 'Тест' }),
    ['MAV_LABEL_NAME:label_characters', 'MAV_LABEL_LATIN:label_characters'])
  assert.equal(values.MAV_LABEL_NAME, 'Teст')
  assert.deepEqual(codes({ MAV_LABEL_NAME: 'Ёлка и ёж' }), [])
  assert.deepEqual(codes({ MAV_LABEL_LATIN: 'Ёлка' }), ['MAV_LABEL_LATIN:label_characters'])
  assert.deepEqual(codes({ MAV_LABEL_LATIN: '' }), ['MAV_LABEL_LATIN:label_required'])
  assert.deepEqual(codes({ MAV_LABEL_NAME: 'Тест 1.: -', MAV_LABEL_LATIN: 'Test 1.: -' }), [])
})

test('diagnostics locate hidden INN spaces, foreign label letters and excess characters', () => {
  assert.deepEqual(codes({ INN: '7805406976' }), [])
  const inn = validateFields({ INN: '7805406976  ' }, ['INN'])[0].message
  assert.match(inn, /позиция 11: пробел/)
  assert.match(inn, /позиция 12: пробел/)
  const label = validateFields({ MAV_LABEL_NAME: 'ТеAт_' }, ['MAV_LABEL_NAME']).find(issue => issue.code === 'label_characters').message
  assert.equal(label, 'В этикетке на кириллице найдены недопустимые символы: позиция 5: «_»')
  const latin = validateFields({ MAV_LABEL_LATIN: 'Teст\t' }, ['MAV_LABEL_LATIN'])[0].message
  assert.equal(latin, 'В этикетке на латинице найдены недопустимые символы: позиция 3: «с»; позиция 4: «т»; позиция 5: табуляция')
  assert.match(validateFields({ MAV_LABEL_LATIN: 'A'.repeat(35) }, ['MAV_LABEL_LATIN'])[0].message, /33–35/)
})

test('nonbreaking spaces are accepted as ordinary spaces without hiding alphabet errors', () => {
  assert.deepEqual(codes({ MAV_LABEL_NAME: 'Ёлка\u00a0и\u202fёж', MAV_LABEL_LATIN: 'Elka\u00a0Test' }), [])
  assert.deepEqual(codes({ MAV_LABEL_LATIN: 'Elka\u00a0ёж' }), ['MAV_LABEL_LATIN:label_characters'])
})

test('DELETE repair is allowed only for exact mTELE2 and reports other operators', () => {
  const fields = ['STATUS', 'MAV_OPERATOR_NAME']
  const STATUS = 'Номер телефона уже есть в таблице MAV номеров'
  assert.deepEqual(codes({ STATUS, MAV_OPERATOR_NAME: 'mTELE2' }, fields, 'NUMBERS'), [])
  for (const MAV_OPERATOR_NAME of ['other', '', 'mtele2', 'mTELE2 ', 'Other 😀']) {
    assert.deepEqual(codes({ STATUS, MAV_OPERATOR_NAME }, fields, 'NUMBERS'), ['MAV_OPERATOR_NAME:other_operator'])
  }
  assert.deepEqual(codes({ STATUS: '', MAV_OPERATOR_NAME: 'other' }, fields, 'NUMBERS'), [])
})

test('INN preserves exact digits and rejects checksum, lengths and scientific text', () => {
  for (const INN of ['7707083893', '1234567894', '500100732259']) assert.deepEqual(codes({ INN }), [])
  for (const [INN, code] of [['7707083894', 'inn_checksum'], ['123', 'inn_length'],
    ['7,84201E+11', 'inn_scientific'], [' 7,84201E+11 ', 'inn_scientific'],
    ['12.3', 'inn_fractional'], [' 7707083893', 'inn_characters'], ['7707083893\n', 'inn_characters']]) {
    assert.deepEqual(codes({ INN }), [`INN:${code}`])
  }
  assert.deepEqual(codes({ INN: '７７０７０８３８９３' }), ['INN:inn_characters', 'INN:output_encoding_error'])
})

test('only contract fields are checked; CLIENTS metadata is optional; DELETE uses MSISDN only', () => {
  assert.deepEqual(codes({ INN: '7707083893', COMPANY_NAME: '', COMPANY_CONTRACT: '', MAV_OPERATOR_NAME: '' },
    undefined, 'CLIENTS'), [])
  assert.deepEqual(codes({ INN: 'bad', MSISDN: '79000000123' }, ['MSISDN'], 'DELETE'), [])
  assert.deepEqual(codes({ MSISDN: '' }, ['MSISDN'], 'DELETE'), ['MSISDN:msisdn_required'])
  assert.deepEqual(codes({ MSISDN: ' 123 ' }), ['MSISDN:msisdn_format'])
})

test('flags, active and source operator follow returned contract', () => {
  assert.deepEqual(codes({ IS_MAV: '2', IS_KSS: '', SPREADING: 'true', IS_ACTIVE: '0', INTERNAL_OPERATOR_NAME: '' }),
    ['IS_MAV:flag_value', 'IS_KSS:flag_value', 'SPREADING:flag_value', 'IS_ACTIVE:active_value'])
  assert.deepEqual(codes({ IS_MAV: '0', IS_KSS: '1', SPREADING: '0', IS_ACTIVE: '1', INTERNAL_OPERATOR_NAME: 'hubRTK' }), [])
  assert.deepEqual(codes({ IS_MAV: '0', IS_KSS: '0' }), ['IS_MAV:flags_both_zero'])
  assert.deepEqual(codes({ IS_MAV: '1', IS_KSS: '0' }), [])
})

test('all import cells must encode in CP1251, with Cyrillic and allowed punctuation retained', () => {
  assert.deepEqual(codes({ INTERNAL_OPERATOR_NAME: 'оператор №1 — тест €' }), [])
  assert.deepEqual(codes({ INTERNAL_OPERATOR_NAME: 'operator😀' }), ['INTERNAL_OPERATOR_NAME:output_encoding_error'])
  assert.deepEqual(codes({ COMPANY_NAME: '漢字' }), ['COMPANY_NAME:output_encoding_error'])
  assert.deepEqual(codes({ STATUS: '😀' }, ['STATUS']), [])
})

test('saved correction text is checked exactly without source normalization', () => {
  const values = { MAV_LABEL_NAME: 'Teст' }
  assert.deepEqual(codes(values), ['MAV_LABEL_NAME:label_contains_latin'])
  assert.deepEqual(codes({ MAV_LABEL_NAME: 'Тест' }), [])
  assert.deepEqual(codes({ MAV_LABEL_NAME: 'Teст ' }), ['MAV_LABEL_NAME:label_contains_latin'])
  assert.equal(values.MAV_LABEL_NAME, 'Teст')
})

test('trailing newlines, supplementary symbols and undefined CP1251 character are invalid', () => {
  assert.deepEqual(codes({ MAV_LABEL_LATIN: 'Test\n' }), ['MAV_LABEL_LATIN:label_characters'])
  assert.deepEqual(codes({ MAV_LABEL: 'Тест' }), [])
  assert.deepEqual(codes({ MAV_LABEL_LATIN: '😀'.repeat(17) }),
    ['MAV_LABEL_LATIN:label_characters', 'MAV_LABEL_LATIN:output_encoding_error'])
  assert.deepEqual(codes({ COMPANY_NAME: '\u0098' }), ['COMPANY_NAME:output_encoding_error'])
})

test('STATUS is exact and role-specific, blank is allowed and unknown requires decision', () => {
  assert.deepEqual(codes({ STATUS: '' }, undefined, 'DOGTAGS'), [])
  assert.deepEqual(codes({ STATUS: 'ИНН уже есть в списке MAV клиентов' }, undefined, 'CLIENTS'), [])
  assert.deepEqual(codes({ STATUS: 'Номер телефона уже есть в таблице MAV номеров' }, undefined, 'NUMBERS'), [])
  assert.deepEqual(codes({ STATUS: 'ИНН отсутствует в таблице MAV клиентов' }, undefined, 'DOGTAGS'), [])
  assert.deepEqual(codes({ STATUS: 'MAV_LABEL_NAME отсутствуют в таблице этикеток' }, undefined, 'NUMBERS'), [])
  for (const STATUS of ['Длина MAV_LABEL не должна превышать 32 символа или имеются некорретные символы',
    'Длина MAV_LABEL не должна превышать 32 символа или имеются некорректные символы']) {
    assert.deepEqual(codes({ STATUS }, undefined, 'DOGTAGS'), [])
  }
  assert.deepEqual(codes({ STATUS: 'Указанный MAV_LABEL уже есть у данного клиента' }, undefined, 'DOGTAGS'), [])
  assert.deepEqual(codes({ STATUS: 'ИНН уже есть в списке MAV клиентов' }, undefined, 'DOGTAGS'), ['STATUS:status_unresolved'])
  assert.deepEqual(codes({ STATUS: 'unknown' }, undefined, 'NUMBERS'), ['STATUS:status_unresolved'])
})

test('both general label names permit Latin as a warning, with other validation retained', () => {
  for (const field of ['MAV_LABEL', 'MAV_LABEL_NAME']) {
    const issues = validateFields({ [field]: 'Тест Brand' }, [field]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].scope, 'warning');
    assert.equal(issues[0].code, 'label_contains_latin');
    assert.deepEqual(validateFields({ [field]: 'Тест' }, [field]), []);
  }
  assert.ok(validateFields({ MAV_LABEL_LATIN: 'Teст' }, ['MAV_LABEL_LATIN']).some(issue => issue.scope === 'cell'));
});

test('MSISDN requires 11 digits beginning with 7', () => {
  for (const MSISDN of ['+79878384919', '89878384919', '123', '798783849190']) {
    assert.deepEqual(codes({ MSISDN }), ['MSISDN:msisdn_format']);
  }
  assert.deepEqual(codes({ MSISDN: '79878384919' }), []);
});
