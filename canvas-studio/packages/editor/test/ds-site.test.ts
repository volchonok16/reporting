import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '#core';
import { ApproximateTextMeasurer } from '#layout';
import { Editor } from '../src/editor.ts';
import { buildDsSite } from '../src/ds-site.ts';

test('design system site: colours by mode with CSS names, text styles, effects, components with variants and properties, tokens', () => {
  const doc = Document.createEmpty('Ромашка UI', 'test');
  const editor = new Editor(doc, new ApproximateTextMeasurer());
  const empty = buildDsSite({ doc, now: new Date(2026, 10, 9) });
  assert.equal(empty.sections, 0);
  assert.match(empty.html, /пока нет переменных/);
  editor.commit('system', (tx) => {
    const coll = tx.create('VARIABLE_COLLECTION', doc.rootId, { name: 'Цвета', modes: [{ id: 'l', name: 'Светлая' }, { id: 'd', name: 'Тёмная' }] } as never);
    tx.create('VARIABLE', coll, { name: 'Фон/Основной', varType: 'COLOR', varValues: { l: { r: 1, g: 1, b: 1, a: 1 }, d: { r: 0.1, g: 0.1, b: 0.1, a: 1 } }, description: 'Фон экранов' } as never);
    tx.create('VARIABLE', coll, { name: 'Отступ/M', varType: 'FLOAT', varValues: { l: 16, d: 16 }, scopes: ['GAP'] } as never);
    tx.create('STYLE', doc.rootId, { name: 'Заголовок / H1', styleType: 'TEXT', fontFamily: 'Inter', fontSize: 32, fontWeight: 700 });
    tx.create('STYLE', doc.rootId, { name: 'Тень / Карточка', styleType: 'EFFECT', effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0, visible: true }] });
    const set = tx.create('COMPONENT_SET', editor.pageId, { name: 'Кнопка', description: 'Главное действие на экране' });
    tx.create('COMPONENT', set, { name: 'Размер=M, Вид=Основная' });
    tx.create('COMPONENT', set, { name: 'Размер=S, Вид=Вторичная' });
    tx.update(set, { componentProps: [{ id: 'p1', name: 'Подпись', type: 'TEXT' }] } as never);
  });
  const site = buildDsSite({ doc, picture: () => 'data:image/png;base64,AA==', now: new Date(2026, 10, 9) });
  const { html } = site;
  assert.ok(site.sections >= 5, `sections: ${site.sections}`);
  assert.match(html, /<title>Ромашка UI<\/title>/);
  assert.match(html, /Светлая<\/th><th>Тёмная/);
  assert.match(html, /#FFFFFF/i);
  assert.match(html, /#1A1A1A/i);
  assert.match(html, /var\(--[a-z-]+\)/, 'the CSS name as in «Переменные в код»');
  assert.match(html, /Фон экранов/);
  assert.match(html, /font-size: 32px; font-weight: 700/);
  assert.match(html, /box-shadow: 0px 4px 12px 0px/);
  assert.match(html, /Главное действие на экране/);
  assert.match(html, /<dt>Размер<\/dt><dd><span class="pill">M<\/span><span class="pill">S<\/span>/);
  assert.match(html, /Подпись<\/td><td>текст/);
  assert.match(html, /data:image\/png;base64,AA==/);
  assert.match(html, /tokens\.css/);
  // Names from the file cannot break out into markup.
  editor.commit('evil', (tx) => tx.create('STYLE', doc.rootId, { name: '<img src=x onerror=alert(1)>', styleType: 'TEXT' }));
  assert.doesNotMatch(buildDsSite({ doc }).html, /<img src=x/);
});
