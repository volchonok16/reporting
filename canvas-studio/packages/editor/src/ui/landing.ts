// The page a visitor without an account sees at the address of the site (as
// figma.com): what Simmetrika is, a real picture of the editor and the way in —
// sign up, sign in, or try the example file without an account. Who is signed in
// reaches it by the logo of the file browser (/?welcome) and goes back to the files.

import { tr } from '#core';
import { legalUrl } from './auth-screen.ts';
import { h, icon, sparkles } from './dom.ts';

export type LandingChoice = 'register' | 'login' | 'try' | 'local' | 'files' | 'new' | 'tryBoard' | 'newBoard' | 'tryDiagram' | 'newDiagram' | 'trySlides' | 'newSlides';

const FEATURES: [string, string][] = [
  ['Вместе и в реальном времени', 'Курсоры соавторов, наблюдение за участником, комментарии с @упоминаниями и письмами, история версий.'],
  ['Прототипы', 'Связи между экранами, переходы и умная анимация, оверлеи, прокрутка, переменные и условия.'],
  ['Компоненты и библиотеки', 'Варианты и свойства. Опубликуйте компоненты — и ставьте их в любых файлах команды с обновлением в один клик.'],
  ['Код для разработчиков', 'Вкладка «Код»: размеры и отступы, CSS, SwiftUI и Jetpack Compose, переменные дизайна как CSS.'],
  ['Работает без интернета', 'Правки сохраняются в браузере и уходят на сервер, когда связь вернётся.'],
  ['Импорт и экспорт', 'Файлы Figma (.fig) и PowerPoint (.pptx), HTML-страница → слои, экспорт в PowerPoint, PNG, SVG и векторный PDF.'],
];

/** Presentations (FEAT-157…159): what they are for, plainly. */
const SLIDES_POINTS: [string, string][] = [
  ['Темы и раскладки', 'Девять тем и девять раскладок слайда. Цвета и шрифты темы меняют все слайды сразу, а внутри слайда работает всё, что в макете: компоненты, адаптивная раскладка, эффекты.'],
  ['Показ и окно докладчика', 'На весь экран с любого слайда, с переходами. Во втором окне — следующий слайд, заметки и таймер.'],
  ['Импорт PowerPoint', 'Откройте .pptx — слайды, темы, тексты, таблицы, картинки и значки Office перенесутся слоями, которые можно править.'],
  ['Любой формат', '16 : 9 и 4 : 3, квадрат, 4 : 5 для ленты, 9 : 16 для сторис, A4. Экспорт в PowerPoint и векторный PDF.'],
];

/** The board (FEAT-083): what it is for, plainly. */
const BOARD_POINTS: [string, string][] = [
  ['Стикеры', 'Восемь цветов, шрифт сам подстраивается под текст, под каждым — имя автора. Tab ставит следующий стикер: идеи можно записывать подряд, не трогая мышь.'],
  ['Фигуры и стрелки', 'Двенадцать фигур и связи, которые держатся за объекты и идут за ними. Кнопка «+» у фигуры ставит следующий шаг сразу со стрелкой.'],
  ['Маркер и штампы', 'Обведите главное, подчеркните выделителем, отметьте 👍 и +1 — сразу видно, с чем команда согласна.'],
  ['Рядом с макетами', 'Доска лежит в тех же проектах и открывается тем же людям. Стикеры и схемы копируются в макет и обратно, есть комментарии и история версий.'],
];

/** Diagrams from text (FEAT-090): what they are for, plainly. */
const DIAGRAM_POINTS: [string, string][] = [
  ['Пишете текст — схема строится сама', 'Ветки — отступами, шаги — стрелками между ними. Блоки встают по местам сами, а подсказки под текстом говорят, что поправить в строке.'],
  ['23 типа на все случаи', 'Майнд-карты, блок-схемы, BPMN, диаграмма Ганта, таймлайн, канбан, потоки, тепловые карты и другие. У каждого — пример и статья в справке.'],
  ['От схемы к тексту — одним щелчком', 'Правый щелчок по блоку выделяет его строку. Блоки карт и блок-схем можно подвинуть вручную — они останутся на местах при правке.'],
  ['Экспорт и в макет', 'PNG, SVG, PDF на листе A4 или сам текст. Скопируйте схему в макет — она станет слоями, которые можно доработать.'],
];

/** The kinds, short, for the row of chips. */
const AI_POINTS: [string, string][] = [
  ['Опишите словами', 'Что на экране, для кого и в каком стиле. Подойдут и короткое «лендинг кофейни», и подробное ТЗ.'],
  ['Доработайте текстом', '«Шапку тёмной, добавь четвёртую карточку» — правка ляжет на тот же макет, прежний вариант можно вернуть.'],
  ['Данные из файлов', 'Прикрепите таблицу Excel, CSV или документ Word — в макете будут ваши цены, имена и цифры.'],
  ['Сразу слои', 'Не картинка: фреймы, тексты и иконки на адаптивной раскладке. Дальше — как с любым макетом.'],
];
const DIAGRAM_KINDS = ['Майнд-карта', 'Блок-схема', 'BPMN', 'Последовательность', 'Путь пользователя', 'Гант', 'Таймлайн', 'Роллаут', 'Канбан', 'Потоки', 'Тепловая карта', 'Водопад', 'Плитки', 'и ещё 10'];

/** What comes over from a Figma file: said plainly, nothing promised that does not. */
const FROM_FIGMA = [
  'Страницы, фреймы, группы и секции',
  'Адаптивная раскладка с отступами и выравниванием',
  'Компоненты, варианты и экземпляры — со связью и переопределениями',
  'Стили цвета, текста и эффектов',
  'Текст со смешанными стилями, картинки, векторы',
];

export function showLanding(root: HTMLElement, options: { localFiles?: boolean; signedIn?: boolean } = {}): Promise<LandingChoice> {
  return new Promise((resolve) => {
    const go = (choice: LandingChoice) => () => {
      page.remove();
      resolve(choice);
    };
    const signedIn = !!options.signedIn;
    const filesButton = (cls: string) => h('button', { class: cls, type: 'button', onclick: go('files') }, tr('Мои файлы'));
    const logo = h('img', { src: '/apps/web/icons/logo.svg', alt: '', width: 28, height: 28 });
    const header = h(
      'header',
      { class: 'lp-header' },
      h('a', { class: 'lp-brand', href: '/' }, logo, h('span', {}, tr('Симметрика'))),
      h('nav', { class: 'lp-nav' }, h('a', { href: '#features' }, tr('Возможности')), h('a', { href: '#ai' }, tr('Макет по тексту')), h('a', { href: '#slides' }, tr('Презентации')), h('a', { href: '#board' }, tr('Доска')), h('a', { href: '#diagrams' }, tr('Схемы')), h('a', { href: '#figma' }, tr('Переезд из Figma')), h('a', { href: '#dev' }, tr('Для разработчиков'))),
      h('div', { class: 'lp-actions' }, ...(signedIn ? [filesButton('lp-cta')] : [h('button', { class: 'lp-link', type: 'button', onclick: go('login') }, tr('Войти')), h('button', { class: 'lp-cta', type: 'button', onclick: go('register') }, tr('Начать бесплатно'))])),
    );
    const hero = h(
      'section',
      { class: 'lp-hero' },
      h(
        'div',
        { class: 'lp-hero-text' },
        h('a', { class: 'lp-badge', href: '#ai' }, h('b', {}, tr('Новое')), h('span', {}, tr('Макет по описанию: нейросеть сверстает экран')), h('span', { 'aria-hidden': 'true' }, '→')),
        h('h1', {}, tr('Общее место для идей, схем и макетов')),
        h('p', {}, tr('Макеты и прототипы, презентации, доски для обсуждений и схемы по тексту — для всей команды. Работает в браузере, без установки.')),
        h(
          'div',
          { class: 'lp-hero-buttons' },
          signedIn ? filesButton('lp-cta big') : h('button', { class: 'lp-cta big', type: 'button', onclick: go('register') }, tr('Начать бесплатно')),
          // Who already worked here without an account gets back to those files.
          signedIn ? null : options.localFiles ? h('button', { class: 'lp-secondary', type: 'button', onclick: go('local') }, tr('Мои файлы в этом браузере')) : h('button', { class: 'lp-secondary', type: 'button', onclick: go('try') }, tr('Попробовать без регистрации')),
        ),
      ),
      h(
        'div',
        { class: 'lp-shot' },
        h('div', { class: 'lp-window' }, h('div', { class: 'lp-dots' }, h('i'), h('i'), h('i')), h('img', { src: '/apps/web/landing/editor.webp', alt: tr('Редактор Симметрики: экраны мобильного приложения'), loading: 'eager' })),
        h('div', { class: 'lp-cursor one' }, h('span', {}, 'Аня')),
        h('div', { class: 'lp-cursor two' }, h('span', {}, 'Максим')),
        h('div', { class: 'lp-bubble' }, h('b', {}, 'Аня'), h('span', {}, tr('@Максим, кнопку сделаем крупнее?'))),
      ),
    );
    // A layout from a description (FEAT-172): the request on the left, the layout it became on the right.
    const aiArt = h(
      'div',
      { class: 'lp-ai-art', 'aria-hidden': 'true' },
      h(
        'div',
        { class: 'lp-ai-prompt' },
        h('div', { class: 'lp-ai-head' }, sparkles(14), h('span', {}, tr('Макет по описанию'))),
        h('div', { class: 'lp-ai-text' }, tr('Лендинг кофейни: шапка с меню, большой первый экран, три карточки напитков с ценами из файла')),
        h('div', { class: 'lp-ai-file' }, icon('document', 12), h('span', {}, 'menu.xlsx')),
        h('div', { class: 'lp-ai-button' }, tr('Создать макет')),
        h('div', { class: 'lp-ai-refine' }, h('b', {}, tr('Доработать')), h('span', {}, tr('Сделай кнопки круглыми'))),
      ),
      h(
        'div',
        { class: 'lp-ai-page' },
        h('div', { class: 'lp-ai-bar' }, h('b', {}, 'Кофе & Уют'), h('span', {}, h('i'), h('i'), h('i'))),
        h('div', { class: 'lp-ai-hero' }, h('b', {}, tr('Кофе, ради которого просыпаются')), h('span', {}, tr('Заказать'))),
        h(
          'div',
          { class: 'lp-ai-cards' },
          ...[
            [tr('Капучино'), '220 ₽'],
            [tr('Раф лавандовый'), '290 ₽'],
            [tr('Флэт уайт'), '250 ₽'],
          ].map(([name, price]) => h('div', {}, h('i'), h('b', {}, name), h('span', {}, price))),
        ),
      ),
    );
    const ai = h(
      'section',
      { class: 'lp-ai', id: 'ai' },
      h(
        'div',
        { class: 'lp-board-head' },
        h('span', { class: 'lp-ai-tag' }, sparkles(14), tr('Макет по тексту')),
        h('h2', {}, tr('Опишите экран — получите макет')),
        h('p', {}, tr('Напишите, какой экран нужен, — нейросеть сверстает его за минуту, и он сразу станет редактируемыми слоями. Не понравилось — скажите, что поправить, словами. Это есть и для готовых макетов: выделите фрейм и нажмите ✦.')),
      ),
      h('div', { class: 'lp-board-shot' }, aiArt),
      h('div', { class: 'lp-board-grid' }, ...AI_POINTS.map(([title, text]) => h('article', {}, h('h3', {}, tr(title)), h('p', {}, tr(text))))),
      h(
        'div',
        { class: 'lp-board-cta' },
        signedIn ? h('button', { class: 'lp-cta big', type: 'button', onclick: go('new') }, tr('Новый файл')) : h('button', { class: 'lp-cta big', type: 'button', onclick: go('register') }, tr('Начать бесплатно')),
        h('span', { class: 'lp-board-note' }, tr('Нужен аккаунт: макет создаёт нейросеть на сервере. До 20 макетов в сутки.')),
      ),
    );
    // Presentations: slides made with the whole editor, shown from the browser.
    const slides = h(
      'section',
      { class: 'lp-slides', id: 'slides' },
      h(
        'div',
        { class: 'lp-board-head' },
        h('span', { class: 'lp-slides-tag' }, icon('slides', 16), tr('Презентация')),
        h('h2', {}, tr('Презентации из того же редактора')),
        h('p', {}, tr('Слайды собираются из тех же компонентов, стилей и картинок, что и макеты, и показываются прямо из браузера. Отдельный вид файла: те же проекты, доступ и совместная правка.')),
      ),
      h(
        'div',
        { class: 'lp-board-shot' },
        h('div', { class: 'lp-window flat' }, h('div', { class: 'lp-dots' }, h('i'), h('i'), h('i')), h('img', { src: '/apps/web/landing/slides.webp', alt: tr('Презентация в Симметрике: лента слайдов слева, слайд в центре'), loading: 'lazy' })),
      ),
      h('div', { class: 'lp-board-grid' }, ...SLIDES_POINTS.map(([title, text]) => h('article', {}, h('h3', {}, tr(title)), h('p', {}, tr(text))))),
      h(
        'div',
        { class: 'lp-board-cta' },
        signedIn
          ? h('button', { class: 'lp-cta big', type: 'button', onclick: go('newSlides') }, tr('Новая презентация'))
          : h('button', { class: 'lp-cta big', type: 'button', onclick: go('trySlides') }, tr('Попробовать презентацию')),
        signedIn ? null : h('span', { class: 'lp-board-note' }, tr('Без регистрации — презентация сохранится в этом браузере')),
      ),
    );
    // The board: a product of its own inside Simmetrika.
    const board = h(
      'section',
      { class: 'lp-board', id: 'board' },
      h(
        'div',
        { class: 'lp-board-head' },
        h('span', { class: 'lp-board-tag' }, icon('board', 16), tr('Доска')),
        h('h2', {}, tr('Доска для всей команды')),
        h('p', {}, tr('Обсуждения, ретро и наброски — рядом с макетами. Отдельный вид файла в той же Симметрике: те же люди, проекты и доступ, правки видны всем сразу.')),
      ),
      h(
        'div',
        { class: 'lp-board-shot' },
        h('div', { class: 'lp-window flat' }, h('div', { class: 'lp-dots' }, h('i'), h('i'), h('i')), h('img', { src: '/apps/web/landing/board.webp', alt: tr('Доска Симметрики: ретро на стикерах и блок-схема'), loading: 'lazy' })),
        h('div', { class: 'lp-cursor three' }, h('span', {}, 'Лена')),
        h('div', { class: 'lp-cursor four' }, h('span', {}, 'Олег')),
      ),
      h('div', { class: 'lp-board-grid' }, ...BOARD_POINTS.map(([title, text]) => h('article', {}, h('h3', {}, tr(title)), h('p', {}, tr(text))))),
      h(
        'div',
        { class: 'lp-board-cta' },
        signedIn
          ? h('button', { class: 'lp-cta big', type: 'button', onclick: go('newBoard') }, tr('Новая доска'))
          : h('button', { class: 'lp-cta big', type: 'button', onclick: go('tryBoard') }, tr('Попробовать доску')),
        signedIn ? null : h('span', { class: 'lp-board-note' }, tr('Без регистрации — доска сохранится в этом браузере')),
      ),
    );
    // Diagrams from text: a kind of file of its own.
    const diagrams = h(
      'section',
      { class: 'lp-diagrams', id: 'diagrams' },
      h(
        'div',
        { class: 'lp-board-head' },
        h('span', { class: 'lp-diagram-tag' }, icon('diagram', 16), tr('Схема')),
        h('h2', {}, tr('Схемы по тексту')),
        h('p', {}, tr('Опишите процесс, план или идею словами — схема нарисуется сама и будет меняться вместе с текстом. Отдельный вид файла рядом с макетами, презентациями и досками: те же проекты, доступ и совместная правка.')),
      ),
      h('div', { class: 'lp-diagram-kinds' }, ...DIAGRAM_KINDS.map((k) => h('span', {}, tr(k)))),
      h(
        'div',
        { class: 'lp-board-shot' },
        h('div', { class: 'lp-window flat' }, h('div', { class: 'lp-dots' }, h('i'), h('i'), h('i')), h('img', { src: '/apps/web/landing/diagram.webp', alt: tr('Схема в Симметрике: текст слева, майнд-карта по нему в центре'), loading: 'lazy' })),
      ),
      h('div', { class: 'lp-board-grid' }, ...DIAGRAM_POINTS.map(([title, text]) => h('article', {}, h('h3', {}, tr(title)), h('p', {}, tr(text))))),
      h(
        'div',
        { class: 'lp-board-cta' },
        signedIn
          ? h('button', { class: 'lp-cta big', type: 'button', onclick: go('newDiagram') }, tr('Новая схема'))
          : h('button', { class: 'lp-cta big', type: 'button', onclick: go('tryDiagram') }, tr('Попробовать схему')),
        signedIn ? null : h('span', { class: 'lp-board-note' }, tr('Без регистрации — схема сохранится в этом браузере')),
      ),
    );
    const features = h(
      'section',
      { class: 'lp-features', id: 'features' },
      h('h2', {}, tr('Всё для работы над интерфейсом')),
      h('div', { class: 'lp-grid' }, ...FEATURES.map(([title, text], i) => h('article', { class: 'lp-card', id: i === 3 ? 'dev' : undefined }, h('h3', {}, tr(title)), h('p', {}, tr(text))))),
    );
    const steps = [
      [tr('Сохраните файл в Figma'), tr('«Файл → Сохранить локальную копию» — получится файл .fig.')],
      [tr('Откройте его в Симметрике'), tr('«Импорт из Figma» на главной или просто перетащите .fig в окно.')],
      [tr('Продолжайте работу'), tr('Файл откроется со всеми страницами. Он разбирается прямо в браузере — ни Figma, ни аккаунт в ней не нужны.')],
    ];
    const figma = h(
      'section',
      { class: 'lp-figma', id: 'figma' },
      h('div', { class: 'lp-figma-text' }, h('h2', {}, tr('Переезд из Figma — с вашими файлами')), h('p', {}, tr('Не нужно перерисовывать макеты: откройте свои файлы Figma, и работа продолжится с того же места.'))),
      h('ol', { class: 'lp-steps' }, ...steps.map(([title, text], i) => h('li', {}, h('span', { class: 'lp-step-n' }, String(i + 1)), h('div', {}, h('h3', {}, title), h('p', {}, text))))),
      h('div', { class: 'lp-figma-list' }, h('h3', {}, tr('Что переносится')), h('ul', {}, ...FROM_FIGMA.map((t) => h('li', {}, tr(t))))),
    );
    // A clean screen when one needs to focus, and smart actions computed here, at once.
    const bar = h(
      'div',
      { class: 'lp-mini-bar', 'aria-hidden': 'true' },
      h('span', { class: 'lp-mini-field wide' }, 'Inter'),
      h('span', { class: 'lp-mini-field' }, 'Bold'),
      h('span', { class: 'lp-mini-field' }, '28'),
      h('span', { class: 'lp-mini-sep' }),
      h('b', {}, 'B'),
      h('i', {}, 'I'),
      h('u', {}, 'U'),
      h('span', { class: 'lp-mini-sep' }),
      h('span', { class: 'lp-mini-spark' }, sparkles(14)),
    );
    const calm = h(
      'div',
      { class: 'lp-art lp-art-calm', 'aria-hidden': 'true' },
      h('div', { class: 'lp-art-canvas' }, bar, h('div', { class: 'lp-art-card' }, h('span', { class: 'lp-art-title' }, tr('Куда отправимся?')), h('span', { class: 'lp-art-line' }), h('span', { class: 'lp-art-line short' }))),
      h('div', { class: 'lp-art-panel' }, h('span', {}, tr('свёрнуто'))),
    );
    const smartArt = h(
      'div',
      { class: 'lp-art lp-art-smart', 'aria-hidden': 'true' },
      h(
        'div',
        { class: 'lp-smart-menu' },
        h('div', { class: 'lp-smart-head' }, sparkles(14), h('span', {}, tr('Для «Главная»'))),
        ...[
          [tr('Привести в порядок'), tr('9 имён, 4 отступа, 6 цветов из переменных')],
          [tr('Заполнить данными'), tr('3 текста: цены, даты, места')],
          [tr('Исправить контраст'), tr('2 текста ниже нормы WCAG')],
        ].map(([t, d], i) => h('div', { class: `lp-smart-item${i === 0 ? ' primary' : ''}` }, h('b', {}, t), h('span', {}, d))),
        h('div', { class: 'lp-smart-foot' }, tr('Мгновенно, без интернета, файл никуда не отправляется')),
      ),
    );
    const focus = h(
      'section',
      { class: 'lp-focus', id: 'focus' },
      h('h2', {}, tr('Фокус на макете')),
      h('p', { class: 'lp-focus-lead' }, tr('Меньше лишнего на экране и меньше рутины в работе.')),
      h(
        'div',
        { class: 'lp-focus-grid' },
        h(
          'article',
          { class: 'lp-focus-item' },
          calm,
          h('h3', {}, tr('Чистый интерфейс — когда нужно сосредоточиться')),
          h('p', {}, tr('Сверните правую панель — останутся холст и маленькая панель прямо над выделенным: шрифт, цвет, отступы, скругление. Нужны все свойства — разверните одной кнопкой и снова спрячьте.')),
        ),
        h(
          'article',
          { class: 'lp-focus-item' },
          smartArt,
          h('h3', {}, h('span', { class: 'lp-spark-inline' }, sparkles(22)), tr('Умные действия — без ожидания')),
          h('p', {}, tr('Привести в порядок — мгновенно, на вашем компьютере. Переименовать слои по смыслу, придумать тексты для макета и заметки к слайду — за пару секунд, с нейросетью. Кнопка ✦ предлагает только то, что подходит к выделенному, и заранее пишет, что сделает.')),
        ),
      ),
    );
    const final = h('section', { class: 'lp-final' }, h('h2', {}, tr('Начните первый файл за минуту')), signedIn ? h('button', { class: 'lp-cta big', type: 'button', onclick: go('new') }, tr('Новый файл')) : h('button', { class: 'lp-cta big', type: 'button', onclick: go('register') }, tr('Начать бесплатно')));
    const legal = h(
      'nav',
      { class: 'lp-legal', 'aria-label': tr('Документы') },
      h('a', { href: legalUrl('terms') }, tr('Пользовательское соглашение')),
      h('a', { href: legalUrl('privacy') }, tr('Политика конфиденциальности')),
    );
    const footer = h('footer', { class: 'lp-footer' }, h('span', {}, `© 2026 ${tr('Симметрика')}`), legal, signedIn ? null : h('button', { class: 'lp-link', type: 'button', onclick: go('login') }, tr('Войти')), h('small', { class: 'lp-trademark' }, tr('Figma — товарный знак Figma, Inc. Симметрика не связана с Figma, Inc. и упоминает её только как программу, файлы которой можно открыть.')));
    const page = h('div', { class: 'lp' }, header, h('main', {}, hero, ai, slides, board, diagrams, figma, features, focus, final), footer);
    root.querySelector('.boot')?.remove();
    root.append(page);
  });
}
