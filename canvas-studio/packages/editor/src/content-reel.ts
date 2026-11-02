// «Контент» (as the Content Reel plugin): ready sets of plausible data — names,
// e-mails, addresses, dates, prices, texts, avatars, covers — and the user's own
// sets. A click on a set fills the selected layers, each with its own value:
// texts get the text, shapes get the picture as an image fill. Nothing selected
// (or nothing that fits) — a new layer with the value. Everything is our own:
// the names, companies and addresses are invented, the pictures are drawn by code.

import { isFrameLike, tr, type Document, type NodeId, type Paint } from '#core';
import type { Point } from '#geometry';
import type { Editor } from './editor.ts';

export type ContentLang = 'ru' | 'en';
export type ContentCategory = 'people' | 'places' | 'time' | 'numbers' | 'texts' | 'web' | 'images' | 'mine';

export interface TextSet {
  kind: 'text';
  id: string;
  cat: ContentCategory;
  /** The set's name (already translated). */
  name: string;
  items: (lang: ContentLang) => readonly string[];
}

export interface ImageSet {
  kind: 'image';
  id: string;
  cat: ContentCategory;
  name: string;
  count: number;
  /** Shape a new layer gets when nothing is selected. */
  shape: 'circle' | 'rect';
  /** Natural size of a picture of the set (a new layer's size; the picture's pixels are twice that). */
  width: number;
  height: number;
}

export type ContentSet = TextSet | ImageSet;

// ---------- people ----------

const PEOPLE_RU = [
  'Анна Смирнова', 'Илья Кузнецов', 'Мария Волкова', 'Дмитрий Соколов', 'Екатерина Морозова', 'Артём Павлов',
  'Ольга Лебедева', 'Никита Новиков', 'Софья Козлова', 'Максим Орлов', 'Алиса Фёдорова', 'Иван Егоров',
  'Дарья Никитина', 'Алексей Михайлов', 'Полина Захарова', 'Сергей Попов', 'Виктория Белова', 'Михаил Зайцев',
  'Елена Ковалёва', 'Кирилл Медведев', 'Ксения Тарасова', 'Егор Андреев', 'Юлия Голубева', 'Тимур Галиев',
];
const PEOPLE_EN = [
  'Emma Wilson', 'Liam Carter', 'Olivia Brooks', 'Noah Bennett', 'Ava Mitchell', 'Lucas Turner',
  'Mia Collins', 'Ethan Hayes', 'Chloe Foster', 'Mason Reed', 'Lily Parker', 'Jack Morgan',
  'Grace Sullivan', 'Owen Price', 'Zoe Hughes', 'Henry Ward', 'Ella Morris', 'Leo Fisher',
  'Ruby Grant', 'Samuel Ortiz', 'Hannah Kim', 'Daniel Shaw', 'Isla Murphy', 'Aaron Patel',
];
const JOBS_RU = [
  'Дизайнер интерфейсов', 'Продуктовый менеджер', 'Фронтенд-разработчик', 'Бэкенд-разработчик', 'Аналитик данных', 'Руководитель отдела продаж',
  'Маркетолог', 'Тестировщик', 'Арт-директор', 'Специалист поддержки', 'Бухгалтер', 'Менеджер проектов',
  'UX-исследователь', 'Копирайтер', 'Инженер DevOps', 'HR-менеджер', 'Мобильный разработчик', 'Технический писатель',
  'Иллюстратор', 'Финансовый директор', 'Офис-менеджер', 'Системный аналитик', 'Дизайнер-верстальщик', 'Директор по развитию',
];
const JOBS_EN = [
  'Product Designer', 'Product Manager', 'Frontend Developer', 'Backend Developer', 'Data Analyst', 'Head of Sales',
  'Marketing Manager', 'QA Engineer', 'Art Director', 'Support Specialist', 'Accountant', 'Project Manager',
  'UX Researcher', 'Copywriter', 'DevOps Engineer', 'HR Manager', 'Mobile Developer', 'Technical Writer',
  'Illustrator', 'CFO', 'Office Manager', 'Systems Analyst', 'Layout Designer', 'Head of Growth',
];
/** Invented companies: not real brands. */
const COMPANIES_RU = [
  'Северный ветер', 'Квадрат', 'Лесная лавка', 'Технопарк Восход', 'Белый кит', 'Медуница',
  'Сфера', 'Полярная звезда', 'Город мастеров', 'Две реки', 'Тёплый дом', 'Синяя птица',
  'Кедр', 'Маяк', 'Ясное небо', 'Пиксель и код', 'Хлебный двор', 'Тропа',
  'Острова', 'Огонёк', 'Зелёный лист', 'Мастерская света', 'Бумажный змей', 'Сад и огород',
];
const COMPANIES_EN = [
  'Bluebird Labs', 'Cedar & Co', 'Harbor Studio', 'Lumen Works', 'Pinecrest', 'Brightside',
  'Summit Bakery', 'Riverstone', 'Atlas Garden', 'Paper Fox', 'Kite Logistics', 'Oakline',
  'Moonbeam', 'Fieldnote', 'Copperleaf', 'Sunday Studio', 'Northgate', 'Little Lantern',
  'Wavecraft', 'Greenhouse Coffee', 'Maple Street', 'Quiet Owl', 'Red Canoe', 'Silverline',
];
const DOMAINS_RU = [
  'severveter.ru', 'kvadrat.studio', 'lesnaya-lavka.ru', 'voskhod.tech', 'belykit.ru', 'medunitsa.ru',
  'sfera.online', 'polyarnaya.ru', 'gorod-masterov.ru', 'dve-reki.ru', 'teply-dom.ru', 'sinyaya-ptitsa.ru',
];
const DOMAINS_EN = [
  'bluebirdlabs.io', 'cedarandco.com', 'harbor.studio', 'lumenworks.co', 'pinecrest.com', 'brightside.app',
  'summitbakery.com', 'riverstone.io', 'atlasgarden.org', 'paperfox.design', 'kitelogistics.com', 'oakline.co',
];
const MAIL_RU = ['mail.ru', 'yandex.ru', 'gmail.com', 'inbox.ru'];
const MAIL_EN = ['gmail.com', 'outlook.com', 'icloud.com', 'proton.me'];

const TRANSLIT: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '' };
const latinName = (name: string) =>
  name
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('');
const people = (l: ContentLang) => (l === 'en' ? PEOPLE_EN : PEOPLE_RU);
/** «Анна С.» → its initials «АС»: avatars of the names set match its order. */
export function initials(i: number, l: ContentLang): string {
  const name = people(l)[i % PEOPLE_RU.length]!;
  return name
    .split(' ')
    .map((w) => w[0])
    .join('');
}

// ---------- places ----------

const CITIES_RU = [
  'Москва', 'Санкт-Петербург', 'Казань', 'Новосибирск', 'Екатеринбург', 'Нижний Новгород', 'Самара', 'Калининград',
  'Владивосток', 'Сочи', 'Ярославль', 'Томск', 'Иркутск', 'Пермь', 'Воронеж', 'Красноярск',
  'Мурманск', 'Тюмень', 'Уфа', 'Псков', 'Суздаль', 'Петрозаводск', 'Ростов-на-Дону', 'Хабаровск',
];
const CITIES_EN = [
  'Lisbon', 'Kyoto', 'Reykjavik', 'Cape Town', 'Vancouver', 'Marrakesh', 'Dubrovnik', 'Queenstown',
  'Porto', 'Hanoi', 'Bergen', 'Seville', 'Melbourne', 'Montreal', 'Edinburgh', 'Prague',
  'Buenos Aires', 'Copenhagen', 'Valencia', 'Austin', 'Tallinn', 'Singapore', 'Barcelona', 'Helsinki',
];
const COUNTRIES_RU = ['Россия', 'Казахстан', 'Армения', 'Грузия', 'Узбекистан', 'Беларусь', 'Сербия', 'Турция', 'Япония', 'Португалия', 'Италия', 'Вьетнам', 'Аргентина', 'Исландия', 'Норвегия', 'Индия', 'Мексика', 'Канада', 'Египет', 'Монголия', 'Таиланд', 'Чили', 'Марокко', 'Финляндия'];
const COUNTRIES_EN = ['Portugal', 'Japan', 'Iceland', 'South Africa', 'Canada', 'Morocco', 'Croatia', 'New Zealand', 'Vietnam', 'Norway', 'Spain', 'Australia', 'Scotland', 'Czechia', 'Argentina', 'Denmark', 'Estonia', 'Singapore', 'Finland', 'Mexico', 'Chile', 'India', 'Thailand', 'Kenya'];
const STREETS_RU = ['ул. Садовая', 'ул. Лесная', 'пр. Мира', 'ул. Гагарина', 'Набережная ул.', 'ул. Пушкина', 'ул. Молодёжная', 'ул. Школьная', 'Цветной б-р', 'ул. Полевая', 'ул. Речная', 'ул. Солнечная'];
const STREETS_EN = ['Oak Street', 'Maple Avenue', 'Harbor Road', 'Elm Street', 'Park Lane', 'River Drive', 'Hill Street', 'Cedar Court', 'Bay Road', 'Pine Avenue', 'Garden Way', 'Mill Lane'];

// ---------- texts ----------

const TITLES_RU = [
  'Утренний маршрут', 'Новая коллекция', 'Выходные за городом', 'Вечер у моря', 'Горная тропа', 'Лучшее за неделю',
  'Городская прогулка', 'Семейный отдых', 'Летний сезон', 'Тихое место', 'Первый снег', 'Кофе с собой',
  'Всё для дома', 'Скидки недели', 'Начните сегодня', 'Как это работает', 'Наши мастера', 'Поддержка 24/7',
  'Подарки к празднику', 'Сделано вручную', 'Свежий урожай', 'Учиться легко', 'Путь к цели', 'Новое в приложении',
];
const TITLES_EN = [
  'Morning route', 'New collection', 'Weekend away', 'Evening by the sea', 'Mountain trail', 'Best of the week',
  'City walk', 'Family time', 'Summer season', 'Quiet place', 'First snow', 'Coffee to go',
  'Everything for home', 'Deals of the week', 'Start today', 'How it works', 'Meet the makers', 'Support 24/7',
  'Holiday gifts', 'Handmade', 'Fresh harvest', 'Learning made easy', 'Your next step', 'What’s new in the app',
];
const SENTENCES_RU = [
  'Небольшая группа, опытный гид и всё снаряжение — остаётся только взять удобную обувь.',
  'Маршрут подходит новичкам: ровная тропа, частые остановки и красивые виды по пути.',
  'Живём в уютном гостевом доме, ужинаем местной кухней и встречаем рассвет на озере.',
  'Отправление каждую субботу, вернёмся в воскресенье вечером. Трансфер включён.',
  'Ответим на вопросы в чате в течение пятнадцати минут — с девяти утра до десяти вечера.',
  'Отмена бесплатно за три дня до начала. Оплатить можно картой или частями.',
  'Соберите заказ до полудня — привезём сегодня же, курьер позвонит заранее.',
  'Все материалы натуральные: хлопок, лён и дерево из местных мастерских.',
  'Подписка продлевается автоматически, отключить её можно в один щелчок.',
  'Первые две недели — бесплатно, карта для пробного периода не нужна.',
  'Мы бережно храним ваши данные и никому их не передаём.',
  'Расписание обновляется каждый понедельник — следите за новостями.',
];
const SENTENCES_EN = [
  'A small group, an experienced guide and all the gear — just bring comfortable shoes.',
  'The route suits beginners: an even trail, frequent stops and great views on the way.',
  'We stay at a cosy guesthouse, eat local food and watch the sunrise over the lake.',
  'Departures every Saturday, back on Sunday evening. Transfer included.',
  'We answer in the chat within fifteen minutes, from 9 am to 10 pm.',
  'Free cancellation up to three days before. Pay by card or in instalments.',
  'Order before noon and we deliver today; the courier calls ahead.',
  'All materials are natural: cotton, linen and wood from local workshops.',
  'The subscription renews automatically; turn it off in one click.',
  'The first two weeks are free, no card needed for the trial.',
  'We keep your data safe and never share it with anyone.',
  'The schedule is updated every Monday — stay tuned.',
];
const REVIEWS_RU = [
  'Всё пришло вовремя, упаковано аккуратно. Буду заказывать ещё!',
  'Отличный сервис: менеджер ответил за пару минут и помог с выбором.',
  'Качество лучше, чем ожидала. Цвет как на фото.',
  'Гид — настоящий профессионал, вернёмся сюда всей семьёй.',
  'Немного задержали доставку, но предупредили заранее. В целом довольна.',
  'Удобное приложение, всё понятно с первого раза.',
  'Цена соответствует качеству. Рекомендую друзьям.',
  'Заказываю уже третий раз — ни разу не подвели.',
  'Хотелось бы больше размеров, а в остальном всё отлично.',
  'Быстро, вкусно и горячее. Курьер очень вежливый.',
  'Пользуюсь каждый день, батарея держит почти неделю.',
  'Красивое место и тёплая атмосфера. Спасибо за выходные!',
];
const REVIEWS_EN = [
  'Arrived on time and neatly packed. I’ll order again!',
  'Great service: the manager replied in minutes and helped me choose.',
  'Better quality than I expected. The colour is just like the photo.',
  'Our guide was a true pro — we’ll be back with the whole family.',
  'Delivery was a bit late, but they warned us in advance. Happy overall.',
  'Easy app, everything makes sense the first time.',
  'Worth the price. Recommending it to friends.',
  'My third order and they’ve never let me down.',
  'Wish there were more sizes, otherwise perfect.',
  'Fast, tasty and still hot. Very polite courier.',
  'I use it every day; the battery lasts almost a week.',
  'Beautiful place and a warm atmosphere. Thanks for the weekend!',
];
const PRODUCTS_RU = [
  'Кружка керамическая, 350 мл', 'Рюкзак городской', 'Наушники беспроводные', 'Плед шерстяной', 'Свеча ароматическая', 'Термос стальной, 0,5 л',
  'Блокнот в линейку', 'Кроссовки беговые', 'Настольная лампа', 'Чайник заварочный', 'Футболка хлопковая', 'Коврик для йоги',
  'Зонт складной', 'Ваза стеклянная', 'Сумка-шопер', 'Подушка декоративная', 'Часы настенные', 'Набор кистей',
  'Бутылка для воды', 'Шарф вязаный', 'Колонка портативная', 'Фоторамка дубовая', 'Сковорода чугунная', 'Ланч-бокс',
];
const PRODUCTS_EN = [
  'Ceramic mug, 12 oz', 'City backpack', 'Wireless headphones', 'Wool throw', 'Scented candle', 'Steel thermos, 17 oz',
  'Ruled notebook', 'Running shoes', 'Desk lamp', 'Teapot', 'Cotton T-shirt', 'Yoga mat',
  'Folding umbrella', 'Glass vase', 'Tote bag', 'Throw pillow', 'Wall clock', 'Brush set',
  'Water bottle', 'Knitted scarf', 'Portable speaker', 'Oak photo frame', 'Cast iron pan', 'Lunch box',
];
const CATEGORIES_RU = ['Одежда', 'Обувь', 'Электроника', 'Дом и сад', 'Книги', 'Спорт', 'Красота', 'Детям', 'Продукты', 'Зоотовары', 'Путешествия', 'Хобби'];
const CATEGORIES_EN = ['Clothing', 'Shoes', 'Electronics', 'Home & Garden', 'Books', 'Sports', 'Beauty', 'Kids', 'Groceries', 'Pets', 'Travel', 'Hobbies'];
const TAGS_RU = ['#новинка', '#хит', '#скидка', '#подарок', '#эко', '#ручнаяработа', '#лето', '#выходные', '#путешествия', '#дизайн', '#дом', '#спорт'];
const TAGS_EN = ['#new', '#bestseller', '#sale', '#gift', '#eco', '#handmade', '#summer', '#weekend', '#travel', '#design', '#home', '#sport'];
const LOREM = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
  'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.',
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia.',
  'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit.',
  'Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet.',
  'Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse.',
];

// ---------- time ----------

const MONTHS_RU = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS_RU = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WEEKDAYS_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const AGO_RU = ['только что', '2 минуты назад', '5 минут назад', '15 минут назад', 'полчаса назад', '1 час назад', '3 часа назад', 'вчера', '2 дня назад', '5 дней назад', 'неделю назад', 'месяц назад'];
const AGO_EN = ['just now', '2 minutes ago', '5 minutes ago', '15 minutes ago', 'half an hour ago', '1 hour ago', '3 hours ago', 'yesterday', '2 days ago', '5 days ago', 'a week ago', 'a month ago'];

// ---------- helpers ----------

const N = 24;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const pad = (n: number) => String(n).padStart(2, '0');
/** Digits grouped as people write them: «38 000» in Russian (a no-break space), «38,000» in English. */
function group(n: number, l: ContentLang): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, l === 'en' ? ',' : ' ');
}
function pluralRu(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
/** A spread of plausible numbers: not a sequence, the same every time. */
const spread = (i: number) => [1, 0.82, 1.18, 0.64, 1.37, 0.91, 1.09, 0.73, 1.26, 0.55, 1.45, 0.97][i % 12]! * (1 + Math.floor(i / 12) * 0.13);

const by = (ru: readonly string[], en: readonly string[]) => (l: ContentLang) => (l === 'en' ? en : ru);

// ---------- the sets ----------

export function builtInSets(): ContentSet[] {
  const text = (id: string, cat: ContentCategory, name: string, items: (l: ContentLang) => readonly string[]): TextSet => ({ kind: 'text', id, cat, name, items });
  return [
    text('name', 'people', tr('Имя и фамилия'), people),
    text('first', 'people', tr('Имя'), (l) => people(l).map((n) => n.split(' ')[0]!)),
    text('last', 'people', tr('Фамилия'), (l) => people(l).map((n) => n.split(' ')[1]!)),
    text('short', 'people', tr('Имя и инициал'), (l) => people(l).map((n) => `${n.split(' ')[0]} ${n.split(' ')[1]![0]}.`)),
    text('job', 'people', tr('Должность'), by(JOBS_RU, JOBS_EN)),
    text('company', 'people', tr('Компания'), by(COMPANIES_RU, COMPANIES_EN)),
    text('email', 'people', tr('Почта'), (l) => people(l).map((n, i) => `${latinName(n).replace(' ', '.')}@${(l === 'en' ? MAIL_EN : MAIL_RU)[i % 4]}`)),
    text('phone', 'people', tr('Телефон'), (l) =>
      range(N).map((i) => {
        const a = 900 + ((i * 7 + 16) % 100);
        const b = 100 + ((i * 137) % 900);
        return l === 'en' ? `+1 (${200 + ((i * 53) % 700)}) ${b}-${String(1000 + ((i * 731) % 9000))}` : `+7 ${a} ${b}-${pad((23 + i * 31) % 100)}-${pad((45 + i * 17) % 100)}`;
      }),
    ),
    text('city', 'places', tr('Город'), by(CITIES_RU, CITIES_EN)),
    text('country', 'places', tr('Страна'), by(COUNTRIES_RU, COUNTRIES_EN)),
    text('address', 'places', tr('Адрес'), (l) =>
      range(N).map((i) => {
        const house = 1 + ((i * 17 + 3) % 98);
        const flat = 1 + ((i * 29 + 7) % 180);
        return l === 'en' ? `${house * 3 + 10} ${STREETS_EN[i % 12]}, Apt ${flat % 40 + 1}` : `${STREETS_RU[i % 12]}, ${house}, кв. ${flat}`;
      }),
    ),
    text('fullAddress', 'places', tr('Адрес с городом и индексом'), (l) =>
      range(N).map((i) => {
        const house = 1 + ((i * 17 + 3) % 98);
        return l === 'en'
          ? `${house * 3 + 10} ${STREETS_EN[i % 12]}, ${CITIES_EN[i]}, ${String(10000 + ((i * 3917) % 89999))}`
          : `${String(100000 + ((i * 41_237) % 590_000))}, ${CITIES_RU[i]}, ${STREETS_RU[i % 12]}, ${house}`;
      }),
    ),
    text('date', 'time', tr('Дата'), (l) =>
      range(N).map((i) => {
        const d = 1 + ((i * 9 + 4) % 28);
        const m = (i * 5 + 6) % 12;
        return l === 'en' ? `${MONTHS_EN[m]} ${d}, 2026` : `${d} ${MONTHS_RU[m]} 2026`;
      }),
    ),
    text('dateShort', 'time', tr('Дата цифрами'), (l) =>
      range(N).map((i) => {
        const d = 1 + ((i * 9 + 4) % 28);
        const m = 1 + ((i * 5 + 6) % 12);
        return l === 'en' ? `${pad(m)}/${pad(d)}/2026` : `${pad(d)}.${pad(m)}.2026`;
      }),
    ),
    text('time', 'time', tr('Время'), (l) =>
      range(N).map((i) => {
        const h = 7 + ((i * 5) % 15);
        const m = ['00', '30', '15', '45', '10', '50'][i % 6]!;
        return l === 'en' ? `${((h + 11) % 12) + 1}:${m} ${h < 12 ? 'AM' : 'PM'}` : `${pad(h)}:${m}`;
      }),
    ),
    text('weekday', 'time', tr('День недели'), by(WEEKDAYS_RU, WEEKDAYS_EN)),
    text('ago', 'time', tr('Сколько времени назад'), by(AGO_RU, AGO_EN)),
    text('duration', 'time', tr('Продолжительность'), (l) =>
      range(N).map((i) => {
        const total = 5 + ((i * 37) % 175);
        const h = Math.floor(total / 60);
        const m = total % 60;
        if (l === 'en') return h ? `${h} h ${m} min` : `${m} min`;
        return h ? `${h} ч ${m} мин` : `${m} мин`;
      }),
    ),
    text('price', 'numbers', tr('Цена'), (l) =>
      range(N).map((i) => {
        if (l === 'en') return `$${(Math.round(spread(i) * 42) + 0.99).toFixed(2)}`;
        return `${group(Math.max(1, Math.round((spread(i) * 3400) / 10)) * 10 - 10, l)} ₽`;
      }),
    ),
    text('discount', 'numbers', tr('Скидка'), () => range(N).map((i) => `−${[5, 10, 15, 20, 25, 30, 40, 50][i % 8]}%`)),
    text('percent', 'numbers', tr('Проценты'), () => range(N).map((i) => `${Math.min(99, Math.max(1, Math.round(spread(i) * 54)))}%`)),
    text('rating', 'numbers', tr('Оценка'), (l) => range(N).map((i) => (3.6 + ((i * 7) % 15) / 10).toFixed(1).replace('.', l === 'en' ? '.' : ','))),
    text('reviews', 'numbers', tr('Число отзывов'), (l) =>
      range(N).map((i) => {
        const n = Math.round(spread(i) * (i % 3 === 0 ? 1240 : 96));
        return l === 'en' ? `${group(n, l)} ${n === 1 ? 'review' : 'reviews'}` : `${group(n, l)} ${pluralRu(n, 'отзыв', 'отзыва', 'отзывов')}`;
      }),
    ),
    text('number', 'numbers', tr('Число'), (l) => range(N).map((i) => group(Math.round(spread(i) * (i % 2 ? 12_480 : 860)), l))),
    text('order', 'numbers', tr('Номер заказа'), (l) => range(N).map((i) => `${l === 'en' ? '#' : '№ '}${10_000 + ((i * 7919) % 89_999)}`)),
    text('card', 'numbers', tr('Номер карты'), () => range(N).map((i) => `•••• ${String(1000 + ((i * 6271) % 8999))}`)),
    text('title', 'texts', tr('Заголовок'), by(TITLES_RU, TITLES_EN)),
    text('sentence', 'texts', tr('Короткий текст'), by(SENTENCES_RU, SENTENCES_EN)),
    text('paragraph', 'texts', tr('Абзац'), (l) => {
      const s = l === 'en' ? SENTENCES_EN : SENTENCES_RU;
      return range(12).map((i) => `${s[i]} ${s[(i + 5) % 12]} ${s[(i + 9) % 12]}`);
    }),
    text('review', 'texts', tr('Отзыв'), by(REVIEWS_RU, REVIEWS_EN)),
    text('product', 'texts', tr('Товар'), by(PRODUCTS_RU, PRODUCTS_EN)),
    text('category', 'texts', tr('Категория'), by(CATEGORIES_RU, CATEGORIES_EN)),
    text('tag', 'texts', tr('Хештег'), by(TAGS_RU, TAGS_EN)),
    text('lorem', 'texts', 'Lorem ipsum', () => LOREM),
    text('username', 'web', tr('Имя пользователя'), (l) => people(l).map((n, i) => `@${latinName(n).replace(' ', i % 3 ? '.' : '_')}`)),
    text('domain', 'web', tr('Сайт'), by(DOMAINS_RU, DOMAINS_EN)),
    text('url', 'web', tr('Ссылка'), (l) => (l === 'en' ? DOMAINS_EN : DOMAINS_RU).map((d, i) => `https://${d}/${['blog', 'about', 'shop', 'help', 'news', 'contacts'][i % 6]}`)),
    { kind: 'image', id: 'avatarInitials', cat: 'images', name: tr('Аватары с инициалами'), count: N, shape: 'circle', width: 64, height: 64 },
    { kind: 'image', id: 'avatarFigure', cat: 'images', name: tr('Аватары-силуэты'), count: 12, shape: 'circle', width: 64, height: 64 },
    { kind: 'image', id: 'coverGradient', cat: 'images', name: tr('Обложки: градиенты'), count: 12, shape: 'rect', width: 320, height: 200 },
    { kind: 'image', id: 'coverPattern', cat: 'images', name: tr('Обложки: узоры'), count: 12, shape: 'rect', width: 320, height: 200 },
  ];
}

// ---------- order of values ----------

/** The values for `n` layers: in a row from `start`, or shuffled (no repeats until the set runs out). */
export function pickValues<T>(list: readonly T[], n: number, start: number, shuffle: boolean, random: () => number = Math.random): T[] {
  if (list.length === 0) return [];
  if (!shuffle) return range(n).map((i) => list[(start + i) % list.length]!);
  const out: T[] = [];
  while (out.length < n) {
    const deck = [...list];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    // The same value never stands twice in a row across decks.
    if (out.length && deck.length > 1 && deck[0] === out[out.length - 1]) deck.push(deck.shift()!);
    out.push(...deck.slice(0, n - out.length));
  }
  return out;
}

// ---------- targets ----------

const PICTURE_TYPES = new Set(['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'FRAME', 'COMPONENT', 'INSTANCE']);

/** Selected layers a value of the kind goes into, in reading order (rows top to bottom, left to right). */
export function contentTargets(editor: Editor, kind: 'text' | 'image', ids: readonly NodeId[] = editor.selection): NodeId[] {
  const d = editor.doc;
  const fits = (id: NodeId) => !d.get(id, 'locked') && (kind === 'text' ? d.type(id) === 'TEXT' : PICTURE_TYPES.has(d.type(id)));
  return readingOrder(editor, ids.filter(fits));
}

export function readingOrder(editor: Editor, ids: readonly NodeId[]): NodeId[] {
  const boxes = new Map(ids.map((id) => [id, editor.scene.bounds(id)]));
  return [...ids].sort((a, b) => {
    const ba = boxes.get(a)!;
    const bb = boxes.get(b)!;
    // The same row when they overlap vertically by half the lower one.
    const overlap = Math.min(ba.y + ba.height, bb.y + bb.height) - Math.max(ba.y, bb.y);
    if (overlap > Math.min(ba.height, bb.height) / 2) return ba.x - bb.x;
    return ba.y - bb.y;
  });
}

// ---------- putting values in ----------

/** Texts into text layers, one value each; the layer's name follows its text when it was the text. */
export function putTexts(editor: Editor, ids: readonly NodeId[], values: readonly string[], label: string): void {
  const d = editor.doc;
  editor.commit(label, (tx) => {
    ids.forEach((id, i) => {
      const value = values[i % values.length]!;
      const before = d.get(id, 'characters');
      if (d.get(id, 'name') === before || d.get(id, 'name') === before.slice(0, 32)) tx.set(id, 'name', value.slice(0, 32));
      tx.set(id, 'characters', value);
      tx.set(id, 'textRuns', []);
    });
  });
}

export interface PictureBytes {
  bytes: Uint8Array;
  mime: string;
}

/** The picture as the layer's image fill: replaces the layer's image, or all its fills when it had none. */
export function withPicture(doc: Document, id: NodeId, hash: string): Paint[] {
  const image: Paint = { type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', scale: 1, opacity: 1, visible: true };
  const fills = doc.get(id, 'fills');
  const at = fills.findIndex((p) => p.type === 'IMAGE');
  return at >= 0 ? fills.map((p, i) => (i === at ? image : p)) : [image];
}

export function putPictures(editor: Editor, ids: readonly NodeId[], pictures: readonly PictureBytes[], label: string): void {
  const d = editor.doc;
  editor.commit(label, (tx) => {
    const hashes = pictures.map((p) => tx.addBlob(p.bytes, p.mime));
    ids.forEach((id, i) => tx.set(id, 'fills', withPicture(d, id, hashes[i % hashes.length]!)));
  });
}

/** Where a new layer goes: the point, else the middle of the one selected frame, else the middle of the view. */
function placeFor(editor: Editor, at?: Point): { parent: NodeId; centre: Point } {
  const d = editor.doc;
  if (at) return { parent: editor.containerAt(at), centre: at };
  const only = editor.selection.length === 1 ? editor.selection[0]! : null;
  if (only && isFrameLike(d.type(only)) && d.type(only) !== 'INSTANCE' && !editor.isInstanceLayer(only)) {
    const b = editor.scene.bounds(only);
    return { parent: only, centre: { x: b.x + b.width / 2, y: b.y + b.height / 2 } };
  }
  const centre = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
  return { parent: editor.containerAt(centre), centre };
}

/** A new text layer with the value; selected. */
export function newText(editor: Editor, value: string, label: string, at?: Point): NodeId | null {
  const { parent, centre } = placeFor(editor, at);
  const local = editor.toParentSpace(parent, centre);
  let id: NodeId | null = null;
  editor.commit(
    label,
    (tx) => {
      id = tx.create('TEXT', parent, { name: value.slice(0, 32), characters: value, x: Math.round(local.x), y: Math.round(local.y) });
    },
    () => (id ? [id] : []),
  );
  if (id) editor.appear([id]);
  return id;
}

/** A new layer with the picture: a circle for avatars, a rectangle for covers; selected. */
export function newPicture(editor: Editor, picture: PictureBytes, shape: 'circle' | 'rect', width: number, height: number, name: string, label: string, at?: Point): NodeId | null {
  const { parent, centre } = placeFor(editor, at);
  const local = editor.toParentSpace(parent, centre);
  let id: NodeId | null = null;
  editor.commit(
    label,
    (tx) => {
      const hash = tx.addBlob(picture.bytes, picture.mime);
      id = tx.create(shape === 'circle' ? 'ELLIPSE' : 'RECTANGLE', parent, {
        name,
        x: Math.round(local.x - width / 2),
        y: Math.round(local.y - height / 2),
        width,
        height,
        fills: [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FILL', scale: 1, opacity: 1, visible: true }],
        ...(shape === 'rect' ? { cornerRadius: 12 } : {}),
      });
    },
    () => (id ? [id] : []),
  );
  if (id) editor.appear([id]);
  return id;
}

// ---------- the user's own sets ----------

export interface OwnTextSet {
  id: string;
  name: string;
  items: string[];
}

/**
 * A pasted list becomes sets: one value a line; a table (tabs, «;» or «,»
 * between columns in every line, the first line its headings) — a set per column.
 */
export function parseOwnList(text: string, fallbackName: string): { name: string; items: string[] }[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  for (const sep of ['\t', ';', ',']) {
    const rows = lines.map((l) => splitRow(l, sep));
    const cols = rows[0]!.length;
    if (cols > 1 && rows.length > 1 && rows.every((r) => r.length === cols)) {
      return range(cols)
        .map((c) => ({ name: rows[0]![c]! || `${fallbackName} ${c + 1}`, items: rows.slice(1).map((r) => r[c]!).filter(Boolean) }))
        .filter((s) => s.items.length > 0);
    }
  }
  return [{ name: fallbackName, items: lines }];
}

/** A line of a table: quoted cells may hold the separator («"Иванов, Иван"»). */
function splitRow(line: string, sep: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}
