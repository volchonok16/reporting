import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lang, plural, setLangForTests, tr } from '../src/index.ts';

test('i18n: Russian by default outside a browser; English from the dictionary; placeholders and plurals', () => {
  assert.equal(lang, 'ru');
  assert.equal(tr('Импортировано слоёв: {0}. Отменить — {1}.', 5, '⌘Z'), 'Импортировано слоёв: 5. Отменить — ⌘Z.');
  assert.equal(plural(22, 'слайд', 'слайда', 'слайдов'), 'слайда');
  setLangForTests('en');
  try {
    assert.equal(tr('Файл'), 'File');
    assert.equal(tr('Импортировано слоёв: {0}. Отменить — {1}.', 5, '⌘Z'), 'Imported layers: 5. Undo — ⌘Z.');
    assert.equal(tr('Строки нет в словаре'), 'Строки нет в словаре', 'a missing translation shows the original');
    assert.equal(plural(21, 'слайд', 'слайда', 'слайдов'), 'slides');
    assert.equal(plural(1, 'слайд', 'слайда', 'слайдов'), 'slide');
  } finally {
    setLangForTests('ru');
  }
});
