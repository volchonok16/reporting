// Help in the macOS app (apps/macos): what the site's help says about "this
// browser", the server and Chrome is not so there. Each swap is the start of a
// text of the help (a paragraph, a tip or a list item — it must start exactly
// one text) and what the app shows instead; null — the app leaves it out.
// Two kinds of app: without a server (its own files only) and with one
// (ServerLink.swift: signing in and syncing as the site) — a swap marked
// 'offline' is for the first only, 'online' for the second, unmarked for both;
// with a server the rest of the site's texts only get "this Mac" for "this
// browser" (WORDS). test/help-mac.test.ts keeps every start pointing at a text.

import type { Article, Block } from './types.ts';

type Swap = [start: string, mac: string | null, when?: 'offline' | 'online'];

const BG_KEEP_RU = 'В окне затемнено то, что уйдёт. Если что-то не так, проведите кистью: «Оставить» (K) по пропавшей части предмета, «Убрать» (R) по оставшемуся фону; после каждого мазка вырезка пересчитывается. Alt — другая кисть, [ и ] — размер. «Удалить фон» (Enter) применяет. Картинка никуда не загружается. Отменить — Mod+Z.';
const BG_KEEP_EN = 'In the window: what goes is dimmed. If something is wrong, brush over it: “Keep” (K) over a part of the object that went, “Remove” (R) over background that stayed; the cut is redone after every stroke. Alt — the other brush, [ and ] — size. “Remove background” (Enter) applies. The image is not uploaded anywhere. Undo — Mod+Z.';

export const MAC_RU: Swap[] = [
  ['Свою нейросеть можно подключить', 'Свою нейросеть можно подключить в «Настройках» → «Нейросеть»: адрес API, модель и ключ любого сервиса с API как у OpenAI (кнопки «DeepSeek», «OpenRouter», «OpenAI» заполнят адрес и модель). Тогда макеты по описанию, тексты, заметки к слайдам и имена слоёв делает она, а запросы оплачиваются по вашему ключу. Ключ хранится в Связке ключей этого Mac, запросы идут из приложения прямо в вашу нейросеть. «Проверить» отправляет маленький запрос и говорит, работает ли всё; «Отключить» стирает адрес, модель и ключ.'],
  ['Без входа файлы хранятся только в этом браузере', 'В приложении файлы хранятся на этом Mac, внутри приложения, отдельно от браузера и сайта. Перенести файл на сайт или на другой компьютер: «Сохранить копию файла…» (Mod+S) здесь и «Открыть с диска…» там. Вход в аккаунт в приложении появится позже.', 'offline'],
  ['Без входа файлы хранятся только в этом браузере', 'Без входа файлы хранятся только на этом Mac, внутри приложения, отдельно от браузера. После входа файлы сохраняются на сервере и открываются с любого устройства и на сайте; файлы с этого Mac можно перенести на сервер, редактор предложит это сам.', 'online'],
  ['Ссылка — кнопка со звеньями цепи', 'Ссылка — кнопка со звеньями цепи или просто вставьте адрес страницы на доску (⌘V): появится карточка с адресом страницы. Двойной щелчок по карточке или «Открыть» на панели над ней открывает страницу в браузере. Картинку, заголовок и описание страницы собирает сервер Симметрики, а в приложении их пока нет.', 'offline'],
  ['Комментарии хранятся на сервере', 'Комментарии хранятся на сервере Симметрики, а в приложении их пока нет.', 'offline'],
  ['Файл Figma открывается в Симметрике', 'Файл Figma открывается в Симметрике новым файлом со всеми страницами. Файл разбирается прямо на этом Mac, ни Figma, ни аккаунт в ней не нужны. Файл .fig можно открыть и из Finder: «Открыть в программе» → Симметрика или перетащить его на значок в Dock.'],
  ['У фото со сложным фоном', `У фото со сложным фоном (улица, интерьер, природа) предмет вырезает небольшая нейросеть прямо на этом Mac (волосы, мех, ветки — чисто) и открывается окно. Нейросеть встроена в приложение и работает без интернета; на картинку уходит несколько секунд. ${BG_KEEP_RU}`],
  ['«Перевести текст…» переводит', 'В приложении для Mac «Перевести текст…» пока не работает: встроенный переводчик есть только в Chrome 138 и новее. Переведите текст на сайте в Chrome или вставьте готовый перевод.'],
  ['Нужен Chrome 138 или новее', null],
  ['При первом переводе на новый язык', null],
  ['Стили отдельных слов (жирное слово в предложении) после перевода', null],
  ['Файлы на сервере, которые вы открывали в этом браузере', 'В приложении интернет почти не нужен: файлы хранятся на этом Mac, нейросеть «Удалить фон» встроена, шрифты Google после первой загрузки остаются на диске. Интернет нужен только для новых шрифтов Google. Вход в аккаунт, общий доступ, комментарии и превью ссылок работают через сервер Симметрики, а в приложении их пока нет. Макет по описанию и тексты от нейросети работают, если подключить свою нейросеть в «Настройках» → «Нейросеть».', 'offline'],
  ['Пропала связь во время работы', null, 'offline'],
  ['Без связи главный экран показывает файлы', null, 'offline'],
  ['Новый файл на сервере без связи не создать', null, 'offline'],
  ['Окно «Настройки» открывается внизу боковой панели', 'Окно «Настройки» открывается внизу боковой панели главного экрана и в главном меню ☰ редактора. В приложении настройки запоминаются на этом Mac.', 'offline'],
  ['«Мои наборы»: вставьте список', '«Мои наборы»: вставьте список (по значению в строке) или таблицу из Excel, Google Таблиц, CSV, и получится набор на каждый столбец. Списки и картинки хранятся на этом Mac.', 'offline'],
];

export const MAC_EN: Swap[] = [
  ['You can connect your own AI', 'You can connect your own AI in “Settings” → “AI”: the API address, the model and the key of any service with an OpenAI-style API (the “DeepSeek”, “OpenRouter” and “OpenAI” buttons fill in the address and the model). Then layouts by description, texts, slide notes and layer names come from it, and requests are paid by your key. The key is kept in this Mac’s Keychain; the app sends requests straight to your AI. “Check” sends a small request and says whether everything works; “Switch off” erases the address, model and key.'],
  ['Without signing in, files live only in this browser', 'In the app, files are kept on this Mac — inside the app, apart from the browser and the site. To move a file to the site or another computer: “Save a copy of the file…” (Mod+S) here and “Open from disk…” there. Signing in comes to the app later.', 'offline'],
  ['Without signing in, files live only in this browser', 'Without signing in, files live only on this Mac — inside the app, apart from the browser. After signing in, files are saved on the server and open from any device and on the site; files from this Mac can be moved to the server — the editor offers it itself.', 'online'],
  ['Link — the chain button', 'Link — the chain button, or just paste a page address onto the board (⌘V): a card with the page’s address appears. A double click on the card or «Open» on the bar above it opens the page in the browser. Simmetrika’s server makes the page’s picture, title and description — the app has none yet.', 'offline'],
  ['Comments are kept on the server', 'Comments are kept on Simmetrika’s server — the app has none yet.', 'offline'],
  ['A Figma file opens in Simmetrika', 'A Figma file opens in Simmetrika as a new file with all its pages. The file is read right on this Mac — neither Figma nor an account there is needed. A .fig file opens from Finder too: “Open With” → Simmetrika, or drop it on the Dock icon.'],
  ['In a photo with a busy background', `In a photo with a busy background (a street, an interior, nature) a small neural network cuts the object out right on this Mac (hair, fur, twigs — cleanly) and a window opens. The network is built into the app and works without internet; a picture takes a few seconds. ${BG_KEEP_EN}`],
  ['“Translate text…” translates', '“Translate text…” does not work in the Mac app yet: the built-in translator is only in Chrome 138 and newer. Translate the text on the site in Chrome, or paste a ready translation.'],
  ['Chrome 138 or newer is needed', null],
  ['The first translation into a new language', null],
  ['Styles of single words (a bold word in a sentence) reset', null],
  ['Server files you have opened in this browser', 'The app hardly needs the internet: files are kept on this Mac, the «Remove background» network is built in, Google fonts stay on disk after their first download. The internet is needed only for new Google fonts. Signing in, sharing, comments and link previews work through Simmetrika’s server — the app has none of them yet. Layouts from a description and AI texts work once you connect your own AI in “Settings” → “AI”.', 'offline'],
  ['Connection lost while working', null, 'offline'],
  ['Without a connection the home screen shows', null, 'offline'],
  ['A new server file cannot be created without a connection', null, 'offline'],
  ['The Settings window is in the home screen sidebar', 'The Settings window is in the home screen sidebar and in the editor’s main menu ☰. In the app, settings are kept on this Mac.', 'offline'],
  ['“My sets”: paste a list', '“My sets”: paste a list (a value per line) or a table from Excel, Google Sheets or CSV — a set per column. Lists and pictures are kept on this Mac.', 'offline'],
];

/** With a server: the site's texts as they are, "this Mac" for "this browser". */
const WORDS: Record<'ru' | 'en', [RegExp, string][]> = {
  ru: [
    [/сохраняются в браузере \(даже если закрыть вкладку\)/g, 'сохраняются на этом Mac (даже если закрыть окно)'],
    [/в этом браузере/g, 'на этом Mac'],
    [/из этого браузера/g, 'с этого Mac'],
    [/из браузера/g, 'с этого Mac'],
    [/только в браузере/g, 'только на этом Mac'],
  ],
  en: [
    [/are kept in the browser \(even if you close the tab\)/g, 'are kept on this Mac (even if you close the window)'],
    [/in this browser/g, 'on this Mac'],
    [/from this browser/g, 'from this Mac'],
    [/from the browser/g, 'from this Mac'],
    [/only in the browser/g, 'only on this Mac'],
  ],
};

const SERVER_TIP_RU = 'Вход, общий доступ, комментарии и совместная правка работают как на сайте, через сервер Симметрики: файлы те же. Без интернета приложение работает с копиями файлов и отправит правки, когда связь вернётся.';
const SERVER_TIP_EN = 'Signing in, sharing, comments and co-editing work as on the site, through Simmetrika’s server: the files are the same. Without internet the app works with copies of the files and sends the changes when the connection is back.';

/** The app's own article: first in «Начало работы». */
export const MAC_ARTICLE_RU: Article = {
  id: 'mac-app',
  section: 'Начало работы',
  title: 'Приложение для Mac',
  keywords: 'macos мак приложение программа офлайн без интернета finder dock окно установка',
  blocks: [
    { p: 'Симметрика для Mac — тот же редактор в своём окне. Работает без интернета: файлы хранятся на этом Mac, нейросеть «Удалить фон» встроена.' },
    {
      list: [
        'Файлы .fig, .pptx и .csdoc.json открываются из Finder: «Открыть в программе» → Симметрика или перетащить на значок в Dock. Каждый — новым файлом в своём окне.',
        'Mod+Shift+N — новое окно, Mod+W — закрыть окно, Mod+Q — выйти. Перед закрытием редактор дописывает последние правки.',
        'Шрифты Google загружаются один раз, когда нужны, и дальше есть и без интернета.',
        'Перенести файл на сайт или на другой Mac: «Сохранить копию файла…» (Mod+S), затем «Открыть с диска…» там.',
      ],
    },
    { tip: 'Вход в аккаунт, общий доступ, комментарии и превью ссылок работают через сервер Симметрики, а в приложении их пока нет. Макет по описанию и тексты от нейросети работают, если подключить свою нейросеть в «Настройках» → «Нейросеть».' },
  ],
  related: ['files'],
};

export const MAC_ARTICLE_EN: Article = {
  id: 'mac-app',
  section: 'Getting started',
  title: 'The Mac app',
  keywords: 'macos mac app application offline without internet finder dock window install',
  blocks: [
    { p: 'Simmetrika for Mac is the same editor in a window of its own. It works without internet: files are kept on this Mac, the «Remove background» network is built in.' },
    {
      list: [
        '.fig, .pptx and .csdoc.json files open from Finder: “Open With” → Simmetrika, or drop them on the Dock icon. Each one opens as a new file in its own window.',
        'Mod+Shift+N — a new window, Mod+W — close the window, Mod+Q — quit. Before closing, the editor saves the last changes.',
        'Google fonts are downloaded once, when needed, and are there without internet afterwards.',
        'To move a file to the site or another Mac: “Save a copy of the file…” (Mod+S), then “Open from disk…” there.',
      ],
    },
    { tip: 'Signing in, sharing, comments and link previews work through Simmetrika’s server — the app has none of them yet. Layouts from a description and AI texts work once you connect your own AI in “Settings” → “AI”.' },
  ],
  related: ['files'],
};

/**
 * The texts of the app instead of the site's; `server` — the app has one (signing in, syncing).
 * The starts that point at no text, or at several — for the test.
 */
export function forMacApp(articles: Article[], all: Swap[], own: Article, lang: 'ru' | 'en', server: boolean): { articles: Article[]; unused: string[] } {
  const swaps = all.filter(([, , when]) => !when || when === (server ? 'online' : 'offline'));
  const used = new Map<string, number>(swaps.map(([start]) => [start, 0]));
  const swap = (text: string): string | null => {
    const hit = swaps.find(([start]) => text.startsWith(start));
    if (!hit) return server ? WORDS[lang].reduce((t, [from, to]) => t.replace(from, to), text) : text;
    used.set(hit[0], used.get(hit[0])! + 1);
    return hit[1];
  };
  const out = articles.map((a) => ({
    ...a,
    blocks: a.blocks.flatMap((b): Block[] => {
      if ('p' in b) {
        const t = swap(b.p);
        return t === null ? [] : [{ p: t }];
      }
      if ('tip' in b) {
        const t = swap(b.tip);
        return t === null ? [] : [{ tip: t }];
      }
      if ('list' in b) {
        const list = b.list.map(swap).filter((t): t is string => t !== null);
        return list.length ? [{ list }] : [];
      }
      return [b];
    }),
  }));
  const mine = server ? { ...own, blocks: own.blocks.map((b) => ('tip' in b ? { tip: lang === 'en' ? SERVER_TIP_EN : SERVER_TIP_RU } : b)) } : own;
  const at = out.findIndex((a) => a.section === own.section);
  out.splice(at < 0 ? 0 : at, 0, mine);
  return { articles: out, unused: [...used].filter(([, n]) => n !== 1).map(([s, n]) => `${s} (${n})`) };
}
