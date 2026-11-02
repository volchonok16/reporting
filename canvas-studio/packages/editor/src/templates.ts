// Screen templates (October list, "AI without AI"): instead of generating a
// first draft, a starting point in one click — common screens built with
// auto layout, so they stretch, wrap and adapt like real ones.

import { hexToColor, solid, tr, type Color, type NodeId, type NodeProps, type Transaction } from '#core';

const c = (hex: string): Color => hexToColor(hex)!;
const INK = '#1E1E1E';
const MUTED = '#5C5C5C';
const LINE = '#E6E6E6';
const BLUE = '#4F5BD5';
const SOFT = '#F5F5F5';

type Props = Partial<NodeProps>;

function frame(tx: Transaction, parent: NodeId, name: string, props: Props): NodeId {
  return tx.create('FRAME', parent, { name, fills: [], clipsContent: false, ...props });
}
const col = (gap: number, extra: Props = {}): Props => ({ layoutMode: 'VERTICAL', itemSpacing: gap, sizingH: { mode: 'FILL' }, sizingV: { mode: 'HUG' }, ...extra });
const row = (gap: number, extra: Props = {}): Props => ({ layoutMode: 'HORIZONTAL', itemSpacing: gap, counterAlign: 'CENTER', sizingH: { mode: 'FILL' }, sizingV: { mode: 'HUG' }, ...extra });
const pad = (v: number, hz = v): Props => ({ paddingTop: v, paddingBottom: v, paddingLeft: hz, paddingRight: hz });

function text(tx: Transaction, parent: NodeId, characters: string, size: number, weight = 400, color = INK, fill = true): NodeId {
  return tx.create('TEXT', parent, {
    name: characters,
    characters,
    fontSize: size,
    fontWeight: weight,
    lineHeight: { unit: 'PERCENT', value: 140 },
    textAutoResize: fill ? 'HEIGHT' : 'WIDTH_AND_HEIGHT',
    ...(fill ? { sizingH: { mode: 'FILL' as const } } : {}),
    fills: [solid(c(color))],
  });
}

function button(tx: Transaction, parent: NodeId, label: string, primary = true): NodeId {
  const b = frame(tx, parent, tr('Кнопка {0}', `«${label}»`), {
    ...row(8, { primaryAlign: 'CENTER' }),
    ...pad(14, 20),
    cornerRadius: 12,
    fills: primary ? [solid(c(BLUE))] : [],
    strokes: primary ? [] : [solid(c(LINE))],
  });
  text(tx, b, label, 16, 600, primary ? '#FFFFFF' : INK, false);
  return b;
}

function field(tx: Transaction, parent: NodeId, label: string, placeholder: string): NodeId {
  const f = frame(tx, parent, tr('Поле {0}', `«${label}»`), col(6));
  text(tx, f, label, 13, 500, MUTED);
  const box = frame(tx, f, tr('Ввод'), { ...row(8), ...pad(14, 16), cornerRadius: 10, fills: [solid(c('#FFFFFF'))], strokes: [solid(c(LINE))] });
  text(tx, box, placeholder, 15, 400, '#9A9A9A');
  return f;
}

function screen(tx: Transaction, parent: NodeId, name: string, x: number, y: number, width = 390, height = 844, gap = 24): NodeId {
  return frame(tx, parent, name, { x, y, width, height, layoutMode: 'VERTICAL', itemSpacing: gap, ...pad(56, 24), fills: [solid(c('#FFFFFF'))], clipsContent: true });
}

function avatar(tx: Transaction, parent: NodeId, size: number): NodeId {
  return tx.create('ELLIPSE', parent, { name: tr('Аватар'), width: size, height: size, fills: [{ type: 'GRADIENT_LINEAR', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, stops: [{ position: 0, color: c('#7B61FF') }, { position: 1, color: c(BLUE) }], opacity: 1, visible: true }] });
}

export interface ScreenTemplate {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  build(tx: Transaction, parent: NodeId, x: number, y: number): NodeId;
}

export function screenTemplates(): ScreenTemplate[] {
  return [
    {
      id: 'login',
      name: tr('Вход'),
      description: tr('Заголовок, email и пароль, кнопка, ссылки «Забыли пароль?» и «Регистрация».'),
      width: 390,
      height: 844,
      build(tx, parent, x, y) {
        const s = screen(tx, parent, tr('Экран «Вход»'), x, y);
        const head = frame(tx, s, tr('Заголовок'), col(8));
        text(tx, head, tr('С возвращением'), 30, 700);
        text(tx, head, tr('Войдите, чтобы продолжить'), 16, 400, MUTED);
        const form = frame(tx, s, tr('Форма'), col(16));
        field(tx, form, 'Email', 'name@example.com');
        field(tx, form, tr('Пароль'), '••••••••');
        text(tx, form, tr('Забыли пароль?'), 14, 500, BLUE);
        button(tx, s, tr('Войти'));
        const foot = frame(tx, s, tr('Регистрация'), row(4, { primaryAlign: 'CENTER' }));
        text(tx, foot, tr('Нет аккаунта?'), 14, 400, MUTED, false);
        text(tx, foot, tr('Зарегистрироваться'), 14, 600, BLUE, false);
        return s;
      },
    },
    {
      id: 'signup',
      name: tr('Регистрация'),
      description: tr('Имя, email, пароль, согласие с условиями и кнопка.'),
      width: 390,
      height: 844,
      build(tx, parent, x, y) {
        const s = screen(tx, parent, tr('Экран «Регистрация»'), x, y);
        text(tx, s, tr('Создайте аккаунт'), 30, 700);
        const form = frame(tx, s, tr('Форма'), col(16));
        field(tx, form, tr('Имя'), tr('Анна'));
        field(tx, form, 'Email', 'name@example.com');
        field(tx, form, tr('Пароль'), tr('Не короче 8 символов'));
        const agree = frame(tx, s, tr('Согласие'), row(10));
        tx.create('RECTANGLE', agree, { name: tr('Флажок'), width: 20, height: 20, cornerRadius: 6, fills: [solid(c(BLUE))] });
        text(tx, agree, tr('Принимаю условия и политику конфиденциальности'), 13, 400, MUTED);
        button(tx, s, tr('Создать аккаунт'));
        return s;
      },
    },
    {
      id: 'profile',
      name: tr('Профиль'),
      description: tr('Аватар, имя, статистика в три колонки и список действий.'),
      width: 390,
      height: 844,
      build(tx, parent, x, y) {
        const s = screen(tx, parent, tr('Экран «Профиль»'), x, y);
        const head = frame(tx, s, tr('Шапка профиля'), col(12, { counterAlign: 'CENTER' }));
        avatar(tx, head, 88);
        text(tx, head, tr('Анна Смирнова'), 22, 700, INK, false);
        text(tx, head, tr('Продуктовый дизайнер'), 14, 400, MUTED, false);
        const stats = frame(tx, s, tr('Статистика'), row(12));
        for (const [v, l] of [['128', tr('проектов')], ['4,9', tr('рейтинг')], ['2 года', tr('с нами')]] as const) {
          const box = frame(tx, stats, l, { ...col(2, { counterAlign: 'CENTER' }), ...pad(14, 8), cornerRadius: 12, fills: [solid(c(SOFT))] });
          text(tx, box, v, 20, 700, INK, false);
          text(tx, box, l, 12, 400, MUTED, false);
        }
        const list = frame(tx, s, tr('Действия'), col(0, { cornerRadius: 12, strokes: [solid(c(LINE))], clipsContent: true }));
        for (const item of [tr('Мои заказы'), tr('Избранное'), tr('Уведомления'), tr('Выйти')]) {
          const it = frame(tx, list, item, { ...row(8), ...pad(16), strokes: [solid(c(LINE))], strokeWeights: [0, 0, 1, 0] });
          text(tx, it, item, 15, 500, item === tr('Выйти') ? '#D93025' : INK);
          text(tx, it, '›', 18, 400, MUTED, false);
        }
        return s;
      },
    },
    {
      id: 'list',
      name: tr('Список с поиском'),
      description: tr('Заголовок, поле поиска, фильтры-чипы и карточки товаров.'),
      width: 390,
      height: 844,
      build(tx, parent, x, y) {
        const s = screen(tx, parent, tr('Экран «Каталог»'), x, y, 390, 844, 16);
        text(tx, s, tr('Каталог'), 28, 700);
        const search = frame(tx, s, tr('Поиск'), { ...row(8), ...pad(12, 14), cornerRadius: 12, fills: [solid(c(SOFT))] });
        text(tx, search, tr('Найти товар'), 15, 400, '#9A9A9A');
        const chips = frame(tx, s, tr('Фильтры'), { ...row(8), layoutWrap: true, counterAxisSpacing: 8 });
        for (const [label, on] of [[tr('Все'), true], [tr('Наушники'), false], [tr('Колонки'), false], [tr('Часы'), false]] as const) {
          const chip = frame(tx, chips, label, { layoutMode: 'HORIZONTAL', sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' }, ...pad(8, 14), cornerRadius: 99, fills: [solid(c(on ? INK : SOFT))] });
          text(tx, chip, label, 14, 500, on ? '#FFFFFF' : INK, false);
        }
        for (const [title, price] of [[tr('Беспроводные наушники'), '12 990 ₽'], [tr('Умная колонка'), '7 490 ₽'], [tr('Фитнес-браслет'), '3 990 ₽']] as const) {
          const card = frame(tx, s, tr('Карточка {0}', `«${title}»`), { ...row(14), ...pad(12), cornerRadius: 14, strokes: [solid(c(LINE))] });
          tx.create('RECTANGLE', card, { name: tr('Изображение'), width: 72, height: 72, cornerRadius: 10, fills: [solid(c('#E8F4FF'))] });
          const info = frame(tx, card, tr('Описание'), col(4));
          text(tx, info, title, 15, 600);
          text(tx, info, price, 15, 700, BLUE);
        }
        return s;
      },
    },
    {
      id: 'settings',
      name: tr('Настройки'),
      description: tr('Группы настроек с переключателями и подписями.'),
      width: 390,
      height: 844,
      build(tx, parent, x, y) {
        const s = screen(tx, parent, tr('Экран «Настройки»'), x, y);
        text(tx, s, tr('Настройки'), 28, 700);
        for (const [group, items] of [
          [tr('Уведомления'), [tr('Push-уведомления'), tr('Письма о заказах'), tr('Новости и акции')]],
          [tr('Приватность'), [tr('Показывать профиль'), tr('Двухфакторный вход')]],
        ] as const) {
          const g = frame(tx, s, group, col(8));
          text(tx, g, group.toUpperCase(), 12, 600, MUTED);
          const box = frame(tx, g, tr('Список'), col(0, { cornerRadius: 12, strokes: [solid(c(LINE))], clipsContent: true }));
          items.forEach((item, i) => {
            const it = frame(tx, box, item, { ...row(12), ...pad(14, 16), strokes: [solid(c(LINE))], strokeWeights: [0, 0, i < items.length - 1 ? 1 : 0, 0] });
            text(tx, it, item, 15, 400);
            const sw = frame(tx, it, tr('Переключатель'), { layoutMode: 'HORIZONTAL', sizingH: { mode: 'FIXED' }, sizingV: { mode: 'FIXED' }, width: 44, height: 26, primaryAlign: i % 2 ? 'MIN' : 'MAX', counterAlign: 'CENTER', ...pad(3), cornerRadius: 99, fills: [solid(c(i % 2 ? '#D9D9D9' : '#34C759'))] });
            tx.create('ELLIPSE', sw, { name: tr('Ручка'), width: 20, height: 20, fills: [solid(c('#FFFFFF'))] });
          });
        }
        return s;
      },
    },
    {
      id: 'landing',
      name: tr('Лендинг'),
      description: tr('Десктоп 1440: меню, главный экран с заголовком и кнопками, три преимущества.'),
      width: 1440,
      height: 900,
      build(tx, parent, x, y) {
        const s = frame(tx, parent, tr('Экран «Лендинг»'), { x, y, width: 1440, height: 900, layoutMode: 'VERTICAL', itemSpacing: 0, fills: [solid(c('#FFFFFF'))], clipsContent: true });
        const nav = frame(tx, s, tr('Меню'), { ...row(32), ...pad(20, 80), strokes: [solid(c(LINE))], strokeWeights: [0, 0, 1, 0] });
        text(tx, nav, 'Brand', 22, 800, INK, false);
        const links = frame(tx, nav, tr('Ссылки'), row(28, { primaryAlign: 'MAX' }));
        for (const l of [tr('Продукт'), tr('Цены'), tr('Блог')]) text(tx, links, l, 15, 500, MUTED, false);
        button(tx, nav, tr('Начать'));
        const hero = frame(tx, s, tr('Главный экран'), { ...col(24, { counterAlign: 'CENTER' }), ...pad(120, 240) });
        const title = text(tx, hero, tr('Делайте интерфейсы вместе — быстро и без лишнего'), 56, 800);
        tx.set(title, 'textAlignH', 'CENTER');
        const sub = text(tx, hero, tr('Макеты, компоненты и прототипы в одном месте. Работает в браузере.'), 20, 400, MUTED);
        tx.set(sub, 'textAlignH', 'CENTER');
        const ctas = frame(tx, hero, tr('Кнопки'), { layoutMode: 'HORIZONTAL', itemSpacing: 12, sizingH: { mode: 'HUG' }, sizingV: { mode: 'HUG' } });
        button(tx, ctas, tr('Попробовать бесплатно'));
        button(tx, ctas, tr('Посмотреть демо'), false);
        const features = frame(tx, s, tr('Преимущества'), { ...row(24, { counterAlign: 'MIN' }), ...pad(0, 160) });
        for (const [h, d] of [[tr('Быстро'), tr('Всё работает в браузере, без установки.')], [tr('Вместе'), tr('Правки команды видны сразу.')], [tr('Аккуратно'), tr('Адаптивная раскладка и компоненты держат порядок.')]] as const) {
          const f = frame(tx, features, h, { ...col(8), ...pad(24), cornerRadius: 16, fills: [solid(c(SOFT))] });
          text(tx, f, h, 20, 700);
          text(tx, f, d, 15, 400, MUTED);
        }
        return s;
      },
    },
  ];
}
