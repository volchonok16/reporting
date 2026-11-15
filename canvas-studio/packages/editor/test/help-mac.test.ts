import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARTICLES_EN } from '../src/help/articles-en.ts';
import { ARTICLES_RU } from '../src/help/articles-ru.ts';
import { forMacApp, MAC_ARTICLE_EN, MAC_ARTICLE_RU, MAC_EN, MAC_RU } from '../src/help/mac.ts';

const text = (articles: typeof ARTICLES_RU) => JSON.stringify(articles.map((a) => a.blocks));
const LANGS = [
  ['ru', ARTICLES_RU, MAC_RU, MAC_ARTICLE_RU],
  ['en', ARTICLES_EN, MAC_EN, MAC_ARTICLE_EN],
] as const;

test('help in the macOS app: every swap starts exactly one text of the help, both languages, with and without a server', () => {
  for (const [lang, articles, swaps, own] of LANGS) {
    for (const server of [false, true]) {
      const mac = forMacApp(articles, swaps, own, lang, server);
      assert.deepEqual(mac.unused, [], `${lang}, server ${server}: a start of mac.ts matches no text (or several) — the help changed`);
      assert.equal(mac.articles.find((a) => a.id === 'mac-app')?.title, own.title);
      assert.equal(mac.articles.length, articles.length + 1);
    }
  }
});

test('help in the macOS app: no "this browser" left; without a server no sign-in promises, with one the sync is told', () => {
  for (const server of [false, true]) {
    const ru = text(forMacApp(ARTICLES_RU, MAC_RU, MAC_ARTICLE_RU, 'ru', server).articles);
    const left = ru.match(/.{50}(в этом браузере|из этого браузера|только в браузере|прямо в браузере|из браузера|сохраняются в браузере).{20}/)?.[0];
    assert.ok(!left, `ru, server ${server}: ${left}`);
    assert.ok(!ru.includes('Нужен Chrome 138'));
    const en = text(forMacApp(ARTICLES_EN, MAC_EN, MAC_ARTICLE_EN, 'en', server).articles);
    const leftEn = en.match(/.{50}(in this browser|from this browser|right in the browser|only in the browser|(?<!apart )from the browser|kept in the browser).{20}/)?.[0];
    assert.ok(!leftEn, `en, server ${server}: ${leftEn}`);
  }
  const off = text(forMacApp(ARTICLES_RU, MAC_RU, MAC_ARTICLE_RU, 'ru', false).articles);
  assert.ok(off.includes('Вход в аккаунт в приложении появится позже'));
  const on = text(forMacApp(ARTICLES_RU, MAC_RU, MAC_ARTICLE_RU, 'ru', true).articles);
  assert.ok(!on.includes('появится позже') && !on.includes('в приложении их пока нет'), 'with a server nothing is "not yet"');
  assert.ok(on.includes('совместная правка работают как на сайте'));
});
