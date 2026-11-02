// ✦ «Заполнить данными»: placeholder texts become plausible data. A text is
// replaced when it clearly is data — a price, a date, a time, a phone, an
// e-mail, a percent, a number, a person's name, a city — when it is a
// placeholder («Text», «Заголовок», «Lorem ipsum…»), or when the same text
// repeats across cards («Байкал», «Байкал», «Байкал»). Ordinary labels
// («Забронировать», «Популярное») are left alone. The format is kept: «от
// 38 000 ₽» stays «от … ₽», «14.07.2026» stays digits with dots. Values are
// different for every text and the same every time (no randomness).

import type { Document, NodeId } from '#core';
import { MAX_BLOCK, signature, size } from './repeats.ts';

export type DataKind = 'price' | 'date' | 'time' | 'phone' | 'email' | 'percent' | 'number' | 'name' | 'place' | 'title' | 'text';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const NAMES_RU = ['Анна Смирнова', 'Илья Кузнецов', 'Мария Волкова', 'Дмитрий Соколов', 'Екатерина Морозова', 'Артём Павлов', 'Ольга Лебедева', 'Никита Новиков', 'Софья Козлова', 'Максим Орлов', 'Алиса Фёдорова', 'Иван Егоров'];
const NAMES_EN = ['Emma Wilson', 'Liam Carter', 'Olivia Brooks', 'Noah Bennett', 'Ava Mitchell', 'Lucas Turner', 'Mia Collins', 'Ethan Hayes', 'Chloe Foster', 'Mason Reed', 'Lily Parker', 'Jack Morgan'];
const FIRST_RU = new Set(NAMES_RU.map((n) => n.split(' ')[0]!).concat(['Александр', 'Алексей', 'Андрей', 'Сергей', 'Елена', 'Наталья', 'Татьяна', 'Ирина', 'Павел', 'Михаил', 'Юлия', 'Аня', 'Иван', 'Пётр', 'Олег', 'Виктория', 'Дарья', 'Полина']));
const FIRST_EN = new Set(NAMES_EN.map((n) => n.split(' ')[0]!).concat(['John', 'Jane', 'James', 'Mary', 'Michael', 'Sarah', 'David', 'Anna', 'Alex', 'Kate', 'Tom', 'Emily']));
const PLACES_RU = ['Алтай', 'Байкал', 'Карелия', 'Казань', 'Сочи', 'Калининград', 'Мурманск', 'Камчатка', 'Дагестан', 'Владивосток', 'Суздаль', 'Териберка'];
const PLACES_EN = ['Lisbon', 'Kyoto', 'Reykjavik', 'Cape Town', 'Vancouver', 'Marrakesh', 'Dubrovnik', 'Queenstown', 'Porto', 'Hanoi', 'Bergen', 'Seville'];
const TITLES_RU = ['Утренний маршрут', 'Новая коллекция', 'Выходные за городом', 'Вечер у моря', 'Горная тропа', 'Лучшее за неделю', 'Городская прогулка', 'Семейный отдых', 'Летний сезон', 'Тихое место', 'Первый снег', 'Кофе с собой'];
const TITLES_EN = ['Morning route', 'New collection', 'Weekend away', 'Evening by the sea', 'Mountain trail', 'Best of the week', 'City walk', 'Family time', 'Summer season', 'Quiet place', 'First snow', 'Coffee to go'];
const TEXTS_RU = [
  'Небольшая группа, опытный гид и всё снаряжение — остаётся только взять удобную обувь.',
  'Маршрут подходит новичкам: ровная тропа, частые остановки и красивые виды по пути.',
  'Живём в уютном гостевом доме, ужинаем местной кухней и встречаем рассвет на озере.',
  'Отправление каждую субботу, вернёмся в воскресенье вечером. Трансфер включён.',
  'Ответим на вопросы в чате в течение пятнадцати минут — с девяти утра до десяти вечера.',
  'Отмена бесплатно за три дня до начала. Оплатить можно картой или частями.',
];
const TEXTS_EN = [
  'A small group, an experienced guide and all the gear — just bring comfortable shoes.',
  'The route suits beginners: an even trail, frequent stops and great views on the way.',
  'We stay at a cosy guesthouse, eat local food and watch the sunrise over the lake.',
  'Departures every Saturday, back on Sunday evening. Transfer included.',
  'We answer in the chat within fifteen minutes, from 9 am to 10 pm.',
  'Free cancellation up to three days before. Pay by card or in instalments.',
];
const TRANSLIT: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '' };
const FACTORS = [1, 0.82, 1.18, 0.64, 1.37, 0.91, 1.09, 0.73, 1.26, 0.55, 1.45, 0.97];

const latin = (s: string) => !/[а-яё]/i.test(s);
/** Labels of actions: repeated in every card, yet they are buttons, not data. */
const ACTIONS = /^(подробнее|узнать больше|купить|в корзину|добавить|записаться|забронировать|заказать|оформить|читать( далее| дальше)?|смотреть( все)?|все|ещё|еще|далее|назад|отмена|отменить|сохранить|выбрать|открыть|перейти|войти|ok|ок|more|read more|learn more|buy|add|add to cart|book|book now|order|next|back|cancel|save|view|view all|see all|open|select|choose|sign in|log in|details)$/i;
const PLACEHOLDER: [RegExp, DataKind][] = [
  [/^(имя( и)? фамилия|имя|name|full name|username|user name|пользователь)$/i, 'name'],
  [/^(lorem ipsum|описание|description|текст описания|body text|paragraph)/i, 'text'],
  [/^(text|текст|заголовок|подзаголовок|название|title|subtitle|heading|label|item|элемент|placeholder|заглушка)(\s*\d+)?$/i, 'title'],
];

/** What kind of data a text is; null — an ordinary label (left alone). `repeated` — the same text is elsewhere in the selection. */
export function dataKind(text: string, repeated: boolean): DataKind | null {
  const t = text.trim();
  // 9:41 in a phone's status bar is a convention of mock-ups, not data.
  if (!t || t.length > 300 || t === '9:41') return null;
  for (const [re, kind] of PLACEHOLDER) if (re.test(t)) return kind;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return 'email';
  if (/^\+?\d[\d\s()-]{8,}\d$/.test(t) && t.replace(/\D/g, '').length >= 10) return 'phone';
  if (/^\d{1,2}:\d{2}(\s*[–—-]\s*\d{1,2}:\d{2})?$/.test(t)) return 'time';
  if (/\d/.test(t) && /(₽|руб|\$|€|£|¥|USD|EUR|RUB)/i.test(t) && t.length <= 30) return 'price';
  if (/^[^\d]{0,6}\d+([.,]\d+)?\s?%$/.test(t)) return 'percent';
  if (new RegExp(`^\\d{1,2}\\s(${MONTHS.join('|')}|${MONTHS_EN.join('|')})(\\s\\d{4})?$`, 'i').test(t) || /^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(t)) return 'date';
  if (/^\d[\d\s.,]*$/.test(t) && t.length <= 15) return 'number';
  const words = t.split(/\s+/);
  if (words.length === 2 && words.every((w) => /^[A-ZА-ЯЁ][a-zа-яё'-]+$/.test(w)) && (FIRST_RU.has(words[0]!) || FIRST_EN.has(words[0]!))) return 'name';
  if (PLACES_RU.includes(t) || PLACES_EN.includes(t)) return 'place';
  if (ACTIONS.test(t)) return null;
  if (repeated) return words.length <= 4 && t.length <= 40 ? (words.length === 1 && /^[A-ZА-ЯЁ]/.test(t) ? 'place' : 'title') : 'text';
  return null;
}

/** Digits grouped as people write them: «38 000» in Russian, «38,000» in English. */
function group(n: number, en: boolean): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, en ? ',' : ' ');
}

/** The i-th value of a kind, in the format and language of `like`. */
export function sampleValue(kind: DataKind, i: number, like: string): string {
  const en = latin(like);
  const pick = <T>(list: readonly T[]) => list[i % list.length]!;
  const f = FACTORS[i % FACTORS.length]!;
  switch (kind) {
    case 'name':
      return pick(en ? NAMES_EN : NAMES_RU);
    case 'place':
      return pick(en ? PLACES_EN : PLACES_RU);
    case 'title':
      return pick(en ? TITLES_EN : TITLES_RU);
    case 'text':
      return pick(en ? TEXTS_EN : TEXTS_RU);
    case 'email': {
      const name = pick(NAMES_RU)
        .toLowerCase()
        .split('')
        .map((ch) => TRANSLIT[ch] ?? ch)
        .join('')
        .replace(' ', '.');
      return `${name}@${pick(['mail.ru', 'yandex.ru', 'gmail.com'])}`;
    }
    case 'phone': {
      const d = (n: number) => String(n).padStart(2, '0');
      return `+7 9${d((17 + i * 7) % 100)} ${100 + ((i * 137) % 900)}-${d((23 + i * 31) % 100)}-${d((45 + i * 17) % 100)}`;
    }
    case 'time': {
      const h = 8 + ((i * 3) % 12);
      const m = ['00', '30', '15', '45'][i % 4]!;
      const range = like.match(/[–—-]/);
      return range ? `${h}:${m} ${range[0]} ${h + 2}:${m}` : `${String(h).padStart(2, '0')}:${m}`;
    }
    case 'date': {
      const day = 1 + ((i * 9 + 4) % 28);
      const month = (i * 5 + 6) % 12;
      const numeric = like.match(/^(\d{1,2})([./])(\d{1,2})\2(\d{2,4})$/);
      if (numeric) return `${String(day).padStart(2, '0')}${numeric[2]}${String(month + 1).padStart(2, '0')}${numeric[2]}${numeric[4]}`;
      const year = like.match(/\d{4}$/)?.[0];
      return `${day} ${en ? MONTHS_EN[month] : MONTHS[month]}${year ? ` ${year}` : ''}`;
    }
    case 'percent':
    case 'number':
    case 'price': {
      // The first number in the text is varied; the rest of the text (prefix, currency) stays.
      const m = like.match(/\d[\d\s,.]*\d|\d/);
      if (!m) return like;
      const raw = m[0];
      const value = Number(raw.replace(/[\s,]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
      if (!Number.isFinite(value)) return like;
      let next = value * f;
      const decimals = /[.,]\d{1,2}$/.test(raw) && !/[.,]\d{3}$/.test(raw) ? raw.split(/[.,]/).pop()!.length : 0;
      if (kind === 'percent') next = Math.min(100, Math.max(1, Math.round(next)));
      else if (decimals === 0) {
        const step = value >= 10_000 ? 500 : value >= 1000 ? 100 : value >= 100 ? 10 : 1;
        next = Math.max(step, Math.round(next / step) * step);
      }
      const text = decimals ? next.toFixed(decimals).replace('.', raw.includes(',') ? ',' : '.') : /\s|,/.test(raw) || value >= 10_000 ? group(next, en) : String(Math.round(next));
      return like.slice(0, m.index) + text + like.slice(m.index! + raw.length);
    }
  }
}

/** What would change: text layers under the roots and their new texts. */
export function planFillData(doc: Document, roots: readonly NodeId[], isInstanceLayer: (id: NodeId) => boolean): { id: NodeId; kind: DataKind; text: string }[] {
  const texts: NodeId[] = [];
  // The only text of a rounded, filled frame is a button's label.
  const isButtonLabel = (id: NodeId) => {
    const parent = doc.parent(id);
    if (!parent || (doc.type(parent) !== 'FRAME' && doc.type(parent) !== 'INSTANCE')) return false;
    const kids = doc.children(parent);
    return kids.filter((k) => doc.type(k) === 'TEXT').length === 1 && kids.length <= 3 && doc.get(parent, 'cornerRadius') > 0 && doc.get(parent, 'fills').some((p) => p.visible && p.opacity > 0);
  };
  const walk = (id: NodeId) => {
    if (doc.type(id) === 'TEXT' && !isInstanceLayer(id) && !isButtonLabel(id)) texts.push(id);
    else if (doc.type(id) !== 'INSTANCE') for (const c of doc.children(id)) walk(c);
  };
  roots.forEach(walk);
  // «Repeated» means repeated across cards of a list: inside a small block that has a sibling built the same
  // way. The same labels on two copies of a whole screen (a form drawn twice) are not data.
  // The list a text sits in as part of a card (the parent of the repeated blocks); null — not in a card.
  const listOf = (id: NodeId): NodeId | null => {
    for (let a = doc.parent(id); a !== null && doc.type(a) !== 'PAGE'; a = doc.parent(a)) {
      const parent = doc.parent(a);
      if (!parent || doc.type(parent) === 'PAGE' || doc.type(parent) === 'SECTION' || size(doc, a) > MAX_BLOCK) return null;
      const sig = signature(doc, a);
      if (doc.children(parent).some((s) => s !== a && signature(doc, s) === sig)) return parent;
    }
    return null;
  };
  // Repeated within one list («Байкал» in three cards), not across copies of a screen.
  const keyOf = (id: NodeId) => {
    const list = listOf(id);
    return list ? `${list}\u0000${doc.get(id, 'characters').trim()}` : null;
  };
  const count = new Map<string, number>();
  for (const id of texts) {
    const k = keyOf(id);
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const used = new Map<DataKind, number>();
  const out: { id: NodeId; kind: DataKind; text: string }[] = [];
  for (const id of texts) {
    const now = doc.get(id, 'characters');
    const k = keyOf(id);
    const kind = dataKind(now, k !== null && (count.get(k) ?? 0) > 1);
    if (!kind) continue;
    let i = used.get(kind) ?? 0;
    let text = sampleValue(kind, i, now.trim());
    // Never «replace» a text with itself: the next value then.
    if (text === now.trim()) text = sampleValue(kind, ++i, now.trim());
    used.set(kind, i + 1);
    if (text !== now) out.push({ id, kind, text });
  }
  return out;
}
