# Simmetrika's own icon set: every icon is drawn here from geometry (lines, arcs,
# circles, rounded boxes) on a 24 × 24 grid, stroke 2, round ends — nothing is
# taken from other icon sets. Run: python3 tools/icons/build-icons.py
# → packages/editor/src/icons/set.ts (the editor reads only that file).

import math, json, os

def n(v):
    v = round(v, 2)
    return str(int(v)) if v == int(v) else str(v)

def pt(x, y):
    return f'{n(x)} {n(y)}'

def line(x1, y1, x2, y2):
    return f'<path d="M{pt(x1, y1)}L{pt(x2, y2)}"/>'

def poly(*p, closed=False):
    d = 'M' + 'L'.join(pt(p[i], p[i + 1]) for i in range(0, len(p), 2))
    return f'<path d="{d}{"Z" if closed else ""}"/>'

def circle(cx, cy, r):
    return f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}"/>'

def dot(cx, cy, r=1):
    return f'<circle cx="{n(cx)}" cy="{n(cy)}" r="{n(r)}" fill="currentColor" stroke="none"/>'

def box(x, y, w, h, r=2):
    return f'<rect x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}" rx="{n(r)}"/>'

def path(d):
    return f'<path d="{d}"/>'

def polar(cx, cy, r, a):
    t = math.radians(a)
    return cx + r * math.cos(t), cy + r * math.sin(t)

def arc_d(cx, cy, r, a0, a1, cw=True):
    """An arc from angle a0 to a1 (degrees, clockwise from +x on screen)."""
    x0, y0 = polar(cx, cy, r, a0)
    x1, y1 = polar(cx, cy, r, a1)
    span = (a1 - a0) % 360 if cw else (a0 - a1) % 360
    large = 1 if span > 180 else 0
    return f'M{pt(x0, y0)}A{n(r)} {n(r)} 0 {large} {1 if cw else 0} {pt(x1, y1)}'

def arc(cx, cy, r, a0, a1, cw=True):
    return path(arc_d(cx, cy, r, a0, a1, cw))

def head(tx, ty, direction, length=4, spread=42):
    """A chevron arrowhead: its tip at (tx, ty), pointing `direction` degrees."""
    a = polar(tx, ty, length, direction + 180 - spread)
    b = polar(tx, ty, length, direction + 180 + spread)
    return poly(a[0], a[1], tx, ty, b[0], b[1])

def arc_arrow(cx, cy, r, a0, a1, cw=True, length=4):
    x1, y1 = polar(cx, cy, r, a1)
    tangent = a1 + 90 if cw else a1 - 90
    return arc(cx, cy, r, a0, a1, cw) + head(x1, y1, tangent, length)

def arrow(x1, y1, x2, y2, length=6):
    d = math.degrees(math.atan2(y2 - y1, x2 - x1))
    return line(x1, y1, x2, y2) + head(x2, y2, d, length, 45)

def gear(cx, cy, teeth=8, outer=9, inner=7, tip=9, base=17):
    """A cog: `teeth` teeth between the radii, each `tip` degrees wide at the top and `base` at the root."""
    pts = []
    for i in range(teeth):
        a = i * 360 / teeth
        for r, d in ((inner, -base), (outer, -tip), (outer, tip), (inner, base)):
            pts += polar(cx, cy, r, a + d)
    return poly(*pts, closed=True)

ICONS = []

def icon(id, ru, en, cat, tags, *parts):
    ICONS.append({'id': id, 'ru': ru, 'en': en, 'cat': cat, 'tags': tags, 'body': ''.join(parts)})

# ---------- Стрелки ----------
C = 'arrows'
icon('arrow-right', 'Стрелка вправо', 'Arrow right', C, 'далее вперёд next', arrow(5, 12, 19, 12))
icon('arrow-left', 'Стрелка влево', 'Arrow left', C, 'назад back', arrow(19, 12, 5, 12))
icon('arrow-up', 'Стрелка вверх', 'Arrow up', C, 'вверх наверх', arrow(12, 19, 12, 5))
icon('arrow-down', 'Стрелка вниз', 'Arrow down', C, 'вниз', arrow(12, 5, 12, 19))
icon('arrow-up-right', 'Стрелка вверх вправо', 'Arrow up right', C, 'наискосок внешняя', arrow(7, 17, 17, 7, 8))
icon('arrow-down-right', 'Стрелка вниз вправо', 'Arrow down right', C, 'наискосок', arrow(7, 7, 17, 17, 8))
icon('arrow-down-left', 'Стрелка вниз влево', 'Arrow down left', C, 'наискосок', arrow(17, 7, 7, 17, 8))
icon('arrow-up-left', 'Стрелка вверх влево', 'Arrow up left', C, 'наискосок', arrow(17, 17, 7, 7, 8))
icon('chevron-right', 'Уголок вправо', 'Chevron right', C, 'шеврон галочка далее', poly(9, 5, 16, 12, 9, 19))
icon('chevron-left', 'Уголок влево', 'Chevron left', C, 'шеврон назад', poly(15, 5, 8, 12, 15, 19))
icon('chevron-up', 'Уголок вверх', 'Chevron up', C, 'шеврон свернуть', poly(5, 15, 12, 8, 19, 15))
icon('chevron-down', 'Уголок вниз', 'Chevron down', C, 'шеврон раскрыть список', poly(5, 9, 12, 16, 19, 9))
icon('chevrons-right', 'Двойной уголок вправо', 'Chevrons right', C, 'перемотка в конец', poly(5, 6, 11, 12, 5, 18), poly(13, 6, 19, 12, 13, 18))
icon('chevrons-left', 'Двойной уголок влево', 'Chevrons left', C, 'перемотка в начало', poly(19, 6, 13, 12, 19, 18), poly(11, 6, 5, 12, 11, 18))
icon('chevrons-up', 'Двойной уголок вверх', 'Chevrons up', C, 'наверх', poly(6, 13, 12, 7, 18, 13), poly(6, 19, 12, 13, 18, 19))
icon('chevrons-down', 'Двойной уголок вниз', 'Chevrons down', C, 'вниз', poly(6, 5, 12, 11, 18, 5), poly(6, 11, 12, 17, 18, 11))
icon('swap-horizontal', 'Обмен влево-вправо', 'Swap horizontal', C, 'поменять обмен перевод', arrow(4, 8, 19, 8, 5), arrow(20, 16, 5, 16, 5))
icon('swap-vertical', 'Обмен вверх-вниз', 'Swap vertical', C, 'сортировка поменять', arrow(8, 20, 8, 5, 5), arrow(16, 4, 16, 19, 5))
icon('rotate-cw', 'Повернуть по часовой', 'Rotate clockwise', C, 'обновить повтор redo', arc_arrow(12, 12, 8, 60, 330, True))
icon('rotate-ccw', 'Повернуть против часовой', 'Rotate counter-clockwise', C, 'отменить назад undo', arc_arrow(12, 12, 8, 120, 210, False))
icon('refresh', 'Обновить', 'Refresh', C, 'перезагрузить синхронизация', arc_arrow(12, 12, 8, 200, 330, True, 3.5), arc_arrow(12, 12, 8, 20, 150, True, 3.5))
icon('undo', 'Отменить', 'Undo', C, 'назад шаг', path('M9 14L4 9L9 4'), path('M4 9H14.5A5.5 5.5 0 0 1 14.5 20H11'))
icon('redo', 'Повторить', 'Redo', C, 'вперёд шаг', path('M15 14L20 9L15 4'), path('M20 9H9.5A5.5 5.5 0 0 0 9.5 20H13'))
icon('corner-down-right', 'Поворот вниз вправо', 'Corner down right', C, 'ответ ввод', path('M5 4V11A4 4 0 0 0 9 15H19'), head(19, 15, 0, 5))
icon('corner-up-left', 'Поворот вверх влево', 'Corner up left', C, 'ответить', path('M19 20V13A4 4 0 0 0 15 9H5'), head(5, 9, 180, 5))
icon('move', 'Переместить', 'Move', C, 'перетащить крестовина', line(12, 3, 12, 21), line(3, 12, 21, 12), head(12, 3, -90, 3.5), head(12, 21, 90, 3.5), head(3, 12, 180, 3.5), head(21, 12, 0, 3.5))
icon('expand', 'Развернуть', 'Expand', C, 'на весь экран увеличить', poly(14, 4, 20, 4, 20, 10), poly(10, 20, 4, 20, 4, 14), line(20, 4, 13.5, 10.5), line(4, 20, 10.5, 13.5))
icon('collapse', 'Свернуть', 'Collapse', C, 'уменьшить выйти', poly(14, 4, 14, 10, 20, 10), poly(10, 20, 10, 14, 4, 14), line(14, 10, 20, 4), line(10, 14, 4, 20))
icon('external-link', 'Внешняя ссылка', 'External link', C, 'открыть новое окно', path('M18 13.5V18A2 2 0 0 1 16 20H6A2 2 0 0 1 4 18V8A2 2 0 0 1 6 6H10.5'), poly(14, 4, 20, 4, 20, 10), line(20, 4, 11, 13))
icon('download', 'Скачать', 'Download', C, 'загрузить сохранить', line(12, 4, 12, 15), poly(7, 10, 12, 15, 17, 10), path('M4 15V18A2 2 0 0 0 6 20H18A2 2 0 0 0 20 18V15'))
icon('upload', 'Загрузить', 'Upload', C, 'отправить выгрузить', line(12, 15, 12, 4), poly(7, 9, 12, 4, 17, 9), path('M4 15V18A2 2 0 0 0 6 20H18A2 2 0 0 0 20 18V15'))
icon('log-in', 'Войти', 'Log in', C, 'вход авторизация', path('M14 4H18A2 2 0 0 1 20 6V18A2 2 0 0 1 18 20H14'), arrow(4, 12, 15, 12, 5))
icon('log-out', 'Выйти', 'Log out', C, 'выход', path('M10 4H6A2 2 0 0 0 4 6V18A2 2 0 0 0 6 20H10'), arrow(9, 12, 20, 12, 5))
icon('trending-up', 'Рост', 'Trending up', C, 'график тренд прибыль', poly(3, 17, 9, 11, 13, 15, 21, 7), poly(15, 7, 21, 7, 21, 13))
icon('trending-down', 'Падение', 'Trending down', C, 'график тренд убыток', poly(3, 7, 9, 13, 13, 9, 21, 17), poly(15, 17, 21, 17, 21, 11))

# ---------- Интерфейс ----------
C = 'ui'
icon('plus', 'Плюс', 'Plus', C, 'добавить создать add', line(12, 5, 12, 19), line(5, 12, 19, 12))
icon('minus', 'Минус', 'Minus', C, 'убрать удалить', line(5, 12, 19, 12))
icon('close', 'Закрыть', 'Close', C, 'крестик отмена x', line(6, 6, 18, 18), line(18, 6, 6, 18))
icon('check', 'Галочка', 'Check', C, 'готово да подтвердить', poly(5, 12.5, 10, 17.5, 19, 7))
icon('check-circle', 'Галочка в круге', 'Check circle', C, 'успех готово', circle(12, 12, 9), poly(8, 12.5, 11, 15.5, 16.5, 9.5))
icon('close-circle', 'Крестик в круге', 'Close circle', C, 'ошибка отмена', circle(12, 12, 9), line(9, 9, 15, 15), line(15, 9, 9, 15))
icon('plus-circle', 'Плюс в круге', 'Plus circle', C, 'добавить', circle(12, 12, 9), line(12, 8, 12, 16), line(8, 12, 16, 12))
icon('minus-circle', 'Минус в круге', 'Minus circle', C, 'убрать', circle(12, 12, 9), line(8, 12, 16, 12))
icon('plus-square', 'Плюс в квадрате', 'Plus square', C, 'добавить', box(3.5, 3.5, 17, 17, 3), line(12, 8, 12, 16), line(8, 12, 16, 12))
icon('info', 'Информация', 'Info', C, 'подсказка справка i', circle(12, 12, 9), line(12, 11, 12, 16.5), dot(12, 7.75, 1.1))
icon('help', 'Вопрос', 'Help', C, 'справка помощь вопрос', circle(12, 12, 9), path('M9.5 9.5A2.5 2.5 0 1 1 13.2 11.7C12.4 12.1 12 12.7 12 13.5V14'), dot(12, 17, 1.1))
icon('alert-circle', 'Внимание в круге', 'Alert circle', C, 'ошибка предупреждение', circle(12, 12, 9), line(12, 7.5, 12, 13), dot(12, 16.5, 1.1))
icon('alert-triangle', 'Внимание', 'Warning', C, 'предупреждение опасность', path('M10.3 4.4L2.9 17.5A2 2 0 0 0 4.6 20.5H19.4A2 2 0 0 0 21.1 17.5L13.7 4.4A2 2 0 0 0 10.3 4.4Z'), line(12, 9.5, 12, 14), dot(12, 17.25, 1.1))
icon('menu', 'Меню', 'Menu', C, 'бургер гамбургер', line(4, 7, 20, 7), line(4, 12, 20, 12), line(4, 17, 20, 17))
icon('more-horizontal', 'Ещё', 'More', C, 'многоточие меню три точки', dot(6, 12, 1.6), dot(12, 12, 1.6), dot(18, 12, 1.6))
icon('more-vertical', 'Ещё вертикально', 'More vertical', C, 'три точки меню', dot(12, 6, 1.6), dot(12, 12, 1.6), dot(12, 18, 1.6))
icon('grid', 'Плитка', 'Grid', C, 'сетка галерея плитки', box(4, 4, 6.5, 6.5, 1.5), box(13.5, 4, 6.5, 6.5, 1.5), box(4, 13.5, 6.5, 6.5, 1.5), box(13.5, 13.5, 6.5, 6.5, 1.5))
icon('list', 'Список', 'List', C, 'перечень пункты', line(9, 6, 20, 6), line(9, 12, 20, 12), line(9, 18, 20, 18), dot(4.5, 6, 1.2), dot(4.5, 12, 1.2), dot(4.5, 18, 1.2))
icon('search', 'Поиск', 'Search', C, 'найти лупа', circle(10.5, 10.5, 6.5), line(15.2, 15.2, 20, 20))
icon('filter', 'Фильтр', 'Filter', C, 'воронка отбор', path('M4 5H20L14 12.5V19L10 17V12.5Z'))
icon('sliders', 'Настройки ползунками', 'Sliders', C, 'параметры регулировка', line(4, 7, 20, 7), line(4, 17, 20, 17), circle(9, 7, 2.2), circle(15, 17, 2.2))
icon('settings', 'Настройки', 'Settings', C, 'шестерёнка параметры', gear(12, 12), circle(12, 12, 3))
icon('home', 'Дом', 'Home', C, 'главная начало', path('M4 10.5L12 4L20 10.5V19A1.5 1.5 0 0 1 18.5 20.5H5.5A1.5 1.5 0 0 1 4 19Z'), path('M9.5 20.5V14.5H14.5V20.5'))
icon('eye', 'Глаз', 'Eye', C, 'показать видно просмотр', path('M2.5 12C5 7.5 8.3 5.5 12 5.5S19 7.5 21.5 12C19 16.5 15.7 18.5 12 18.5S5 16.5 2.5 12Z'), circle(12, 12, 3))
icon('eye-off', 'Глаз перечёркнутый', 'Eye off', C, 'скрыть спрятать', path('M6.3 7.3C4.8 8.4 3.6 10 2.5 12C5 16.5 8.3 18.5 12 18.5C13.8 18.5 15.4 18 16.9 17'), path('M10 5.7C10.7 5.6 11.3 5.5 12 5.5C15.7 5.5 19 7.5 21.5 12C20.9 13.1 20.2 14.1 19.4 14.9'), path('M9.9 9.9A3 3 0 0 0 14.1 14.1'), line(3, 3, 21, 21))
icon('lock', 'Замок', 'Lock', C, 'закрыто защита пароль', box(5, 10.5, 14, 10, 2), path('M8 10.5V7.5A4 4 0 0 1 16 7.5V10.5'))
icon('unlock', 'Открытый замок', 'Unlock', C, 'открыто', box(5, 10.5, 14, 10, 2), path('M8 10.5V7.5A4 4 0 0 1 15.6 5.8'))
icon('key', 'Ключ', 'Key', C, 'пароль доступ', circle(7.5, 15.5, 4), line(10.4, 12.6, 20, 3), line(16, 7, 19, 10), line(18, 5, 20, 7))
icon('bell', 'Колокольчик', 'Bell', C, 'уведомления оповещение', path('M6 16.5V11A6 6 0 0 1 18 11V16.5L19.5 18H4.5Z'), path('M10 20.5A2.2 2.2 0 0 0 14 20.5'))
icon('bell-off', 'Без уведомлений', 'Bell off', C, 'тихо выключить', path('M8.1 5.8A6 6 0 0 1 18 11V14'), path('M6 9.5V16.5L4.5 18H17'), path('M10 20.5A2.2 2.2 0 0 0 14 20.5'), line(3, 3, 21, 21))
icon('star', 'Звезда', 'Star', C, 'избранное рейтинг оценка', poly(*[c for i in range(10) for c in polar(12, 12.6, 9.2 if i % 2 == 0 else 4, -90 + i * 36)], closed=True))
icon('heart', 'Сердце', 'Heart', C, 'нравится любовь лайк', path('M12 20C7 16.5 3.5 13.2 3.5 9.2A4.7 4.7 0 0 1 12 6.4A4.7 4.7 0 0 1 20.5 9.2C20.5 13.2 17 16.5 12 20Z'))
icon('bookmark', 'Закладка', 'Bookmark', C, 'сохранить отметить', path('M6.5 4H17.5V20.5L12 16.5L6.5 20.5Z'))
icon('flag', 'Флаг', 'Flag', C, 'отметка цель', line(5.5, 21, 5.5, 4), path('M5.5 4.5C9 2.5 11.5 6.5 18.5 4.5V13.5C11.5 15.5 9 11.5 5.5 13.5'))
icon('tag', 'Метка', 'Tag', C, 'ярлык цена', path('M3.5 12.5V4.5A1 1 0 0 1 4.5 3.5H12.5L20.5 11.5L11.5 20.5Z'), dot(8, 8, 1.4))
icon('link', 'Ссылка', 'Link', C, 'цепочка url', path('M10 14A4.2 4.2 0 0 0 16 14L19 11A4.2 4.2 0 0 0 13 5L11.5 6.5'), path('M14 10A4.2 4.2 0 0 0 8 10L5 13A4.2 4.2 0 0 0 11 19L12.5 17.5'))
icon('paperclip', 'Скрепка', 'Paperclip', C, 'вложение прикрепить', path('M19 11.5L12 18.5A4.6 4.6 0 0 1 5.5 12L12.5 5A3 3 0 0 1 16.8 9.3L9.9 16.2A1.5 1.5 0 0 1 7.8 14.1L14 7.9'))
icon('share', 'Поделиться', 'Share', C, 'отправить связать', circle(17.5, 5.5, 2.5), circle(6.5, 12, 2.5), circle(17.5, 18.5, 2.5), line(8.7, 10.7, 15.3, 6.8), line(8.7, 13.3, 15.3, 17.2))
icon('trash', 'Корзина', 'Trash', C, 'удалить мусор', line(4, 6.5, 20, 6.5), path('M9 6.5V4.5H15V6.5'), path('M6 6.5L7 19A1.6 1.6 0 0 0 8.6 20.5H15.4A1.6 1.6 0 0 0 17 19L18 6.5'), line(10, 10.5, 10, 16.5), line(14, 10.5, 14, 16.5))
icon('edit', 'Карандаш', 'Edit', C, 'изменить править', path('M15.5 4.5L19.5 8.5L8.5 19.5H4.5V15.5Z'), line(13, 7, 17, 11))
icon('copy', 'Копировать', 'Copy', C, 'дублировать', box(8.5, 8.5, 12, 12, 2), path('M15.5 5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5V14A1.5 1.5 0 0 0 5 15.5'))
icon('clipboard', 'Буфер обмена', 'Clipboard', C, 'вставить планшет', path('M8 5H6.5A1.5 1.5 0 0 0 5 6.5V19A1.5 1.5 0 0 0 6.5 20.5H17.5A1.5 1.5 0 0 0 19 19V6.5A1.5 1.5 0 0 0 17.5 5H16'), box(8, 3.5, 8, 3.5, 1))
icon('save', 'Сохранить', 'Save', C, 'дискета запомнить', path('M4.5 6A1.5 1.5 0 0 1 6 4.5H16L19.5 8V18A1.5 1.5 0 0 1 18 19.5H6A1.5 1.5 0 0 1 4.5 18Z'), path('M8 4.5V9H15V4.5'), box(7.5, 13, 9, 6.5, 1))
icon('print', 'Печать', 'Print', C, 'принтер распечатать', path('M7 9V4H17V9'), path('M7 17H5A1.5 1.5 0 0 1 3.5 15.5V10.5A1.5 1.5 0 0 1 5 9H19A1.5 1.5 0 0 1 20.5 10.5V15.5A1.5 1.5 0 0 1 19 17H17'), box(7, 14, 10, 6.5, 1))
icon('zoom-in', 'Приблизить', 'Zoom in', C, 'увеличить лупа', circle(10.5, 10.5, 6.5), line(15.2, 15.2, 20, 20), line(10.5, 8, 10.5, 13), line(8, 10.5, 13, 10.5))
icon('zoom-out', 'Отдалить', 'Zoom out', C, 'уменьшить лупа', circle(10.5, 10.5, 6.5), line(15.2, 15.2, 20, 20), line(8, 10.5, 13, 10.5))
icon('power', 'Питание', 'Power', C, 'выключить включить', arc(12, 13, 7.5, -50, 230, True), line(12, 3.5, 12, 11))
icon('toggle-on', 'Переключатель вкл', 'Toggle on', C, 'включено тумблер', box(2.5, 6.5, 19, 11, 5.5), circle(16, 12, 3))
icon('toggle-off', 'Переключатель выкл', 'Toggle off', C, 'выключено тумблер', box(2.5, 6.5, 19, 11, 5.5), circle(8, 12, 3))
icon('loader', 'Загрузка', 'Loader', C, 'ожидание спиннер', *[line(*polar(12, 12, 4.5, a), *polar(12, 12, 8.5, a)) for a in range(-90, 270, 45)])
icon('calendar', 'Календарь', 'Calendar', C, 'дата расписание', box(3.5, 5, 17, 15.5, 2), line(3.5, 10, 20.5, 10), line(8, 3, 8, 7), line(16, 3, 16, 7))
icon('clock', 'Часы', 'Clock', C, 'время', circle(12, 12, 9), poly(12, 7, 12, 12, 15.5, 14))
icon('timer', 'Таймер', 'Timer', C, 'секундомер', circle(12, 13.5, 7.5), line(12, 13.5, 12, 9.5), line(9.5, 3, 14.5, 3), line(18.5, 6.5, 19.8, 5.2))
icon('history', 'История', 'History', C, 'прошлое журнал', arc_arrow(12, 12, 8.5, 100, 190, False, 3.5), poly(12, 7.5, 12, 12, 15, 14))
icon('sun', 'Солнце', 'Sun', C, 'светлая тема день', circle(12, 12, 4), *[line(*polar(12, 12, 7, a), *polar(12, 12, 9, a)) for a in range(0, 360, 45)])
icon('moon', 'Луна', 'Moon', C, 'тёмная тема ночь', path('M20 14.5A8.5 8.5 0 1 1 9.5 4A6.8 6.8 0 0 0 20 14.5Z'))
icon('image', 'Изображение', 'Image', C, 'картинка фото', box(3.5, 4.5, 17, 15, 2), circle(9, 9.5, 1.8), poly(3.5, 17, 9, 12, 13, 16, 16, 13, 20.5, 17.5))
icon('layers', 'Слои', 'Layers', C, 'стопка уровни', path('M12 3.5L21 8.5L12 13.5L3 8.5Z'), poly(3, 12.5, 12, 17.5, 21, 12.5), poly(3, 16.5, 12, 21.5, 21, 16.5))
icon('sparkles', 'Искры', 'Sparkles', C, 'магия умные новое', path('M12 3C12.6 7.4 14.1 9.4 18.5 10C14.1 10.6 12.6 12.6 12 17C11.4 12.6 9.9 10.6 5.5 10C9.9 9.4 11.4 7.4 12 3Z'), line(18.5, 15.5, 18.5, 20.5), line(16, 18, 21, 18))

# ---------- Люди и общение ----------
C = 'people'
icon('user', 'Человек', 'User', C, 'профиль аккаунт пользователь', circle(12, 8, 4), path('M4.5 20.5C5.3 16.6 8.3 14.5 12 14.5S18.7 16.6 19.5 20.5'))
icon('users', 'Люди', 'Users', C, 'команда группа', circle(9, 8.5, 3.5), path('M2.5 20C3.2 16.6 5.7 14.8 9 14.8S14.8 16.6 15.5 20'), path('M15.5 5.3A3.5 3.5 0 0 1 15.5 11.7'), path('M17.5 14.9C19.6 15.5 21 17.3 21.5 20'))
icon('user-plus', 'Добавить человека', 'Add user', C, 'пригласить новый', circle(10, 8, 4), path('M3 20.5C3.8 16.6 6.6 14.5 10 14.5C11.8 14.5 13.4 15.1 14.6 16.1'), line(19, 13, 19, 19), line(16, 16, 22, 16))
icon('user-check', 'Человек с галочкой', 'User check', C, 'подтверждён друг', circle(10, 8, 4), path('M3 20.5C3.8 16.6 6.6 14.5 10 14.5C11.8 14.5 13.4 15.1 14.6 16.1'), poly(16, 17, 18, 19, 22, 14.5))
icon('mail', 'Письмо', 'Mail', C, 'почта email конверт', box(3, 5, 18, 14, 2), poly(3.5, 6.5, 12, 13, 20.5, 6.5))
icon('message-circle', 'Сообщение', 'Message', C, 'чат комментарий облачко', path('M12 4C16.7 4 20.5 7.4 20.5 11.5S16.7 19 12 19C10.7 19 9.5 18.8 8.4 18.3L4 19.5L5.2 15.8C4.1 14.6 3.5 13.1 3.5 11.5C3.5 7.4 7.3 4 12 4Z'))
icon('message-square', 'Комментарий', 'Comment', C, 'чат сообщение', path('M5 4.5H19A1.5 1.5 0 0 1 20.5 6V15A1.5 1.5 0 0 1 19 16.5H9L4.5 20V6A1.5 1.5 0 0 1 5 4.5Z'), line(8, 9, 16, 9), line(8, 12.5, 13.5, 12.5))
icon('phone', 'Телефон', 'Phone', C, 'звонок трубка', path('M8.5 3.5L5.5 4C4.4 4.2 3.7 5.2 3.8 6.3C4.6 13.6 10.4 19.4 17.7 20.2C18.8 20.3 19.8 19.6 20 18.5L20.5 15.5L16.5 13.5L14.5 15.5C11.8 14.4 9.6 12.2 8.5 9.5L10.5 7.5Z'))
icon('send', 'Отправить', 'Send', C, 'самолётик сообщение', path('M20.5 3.5L3.5 10.5L10.5 13.5L13.5 20.5Z'), line(20.5, 3.5, 10.5, 13.5))
icon('at-sign', 'Собака', 'At sign', C, 'упоминание email @', circle(12, 12, 3.5), path('M15.5 8.5V13.5A2.5 2.5 0 0 0 20.5 13.5V12A8.5 8.5 0 1 0 17 18.9'))
icon('inbox', 'Входящие', 'Inbox', C, 'почта ящик', path('M3.5 13H8.5L10 15.5H14L15.5 13H20.5'), path('M6.2 5.5H17.8L20.5 13V18A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V13Z'))
icon('smile', 'Улыбка', 'Smile', C, 'эмоция радость', circle(12, 12, 9), path('M8.5 14.5A4.5 4.5 0 0 0 15.5 14.5'), dot(9, 9.5, 1.1), dot(15, 9.5, 1.1))
icon('thumbs-up', 'Нравится', 'Thumbs up', C, 'лайк одобрить', path('M7.5 10.5L11 3.5A2 2 0 0 1 13.5 5.5L13 9.5H18.5A2 2 0 0 1 20.4 12L18.8 18.5A2 2 0 0 1 16.9 20H7.5Z'), box(3.5, 10.5, 4, 9.5, 1))
icon('thumbs-down', 'Не нравится', 'Thumbs down', C, 'дизлайк', path('M16.5 13.5L13 20.5A2 2 0 0 1 10.5 18.5L11 14.5H5.5A2 2 0 0 1 3.6 12L5.2 5.5A2 2 0 0 1 7.1 4H16.5Z'), box(16.5, 4, 4, 9.5, 1))

# ---------- Медиа ----------
C = 'media'
icon('play', 'Воспроизвести', 'Play', C, 'старт пуск видео', path('M7 4.5L19 12L7 19.5Z'))
icon('pause', 'Пауза', 'Pause', C, 'остановить', box(6, 4.5, 4, 15, 1), box(14, 4.5, 4, 15, 1))
icon('stop', 'Стоп', 'Stop', C, 'остановить', box(5.5, 5.5, 13, 13, 2))
icon('skip-forward', 'Следующий', 'Next', C, 'вперёд трек', path('M5 5L15 12L5 19Z'), line(19, 5, 19, 19))
icon('skip-back', 'Предыдущий', 'Previous', C, 'назад трек', path('M19 5L9 12L19 19Z'), line(5, 5, 5, 19))
icon('volume', 'Звук', 'Volume', C, 'громкость динамик', path('M4 9.5H7.5L12 5.5V18.5L7.5 14.5H4Z'), path('M15.5 9A4 4 0 0 1 15.5 15'), path('M18 6.5A7.5 7.5 0 0 1 18 17.5'))
icon('volume-off', 'Без звука', 'Mute', C, 'тихо выключить звук', path('M4 9.5H7.5L12 5.5V18.5L7.5 14.5H4Z'), line(16, 9.5, 21, 14.5), line(21, 9.5, 16, 14.5))
icon('mic', 'Микрофон', 'Microphone', C, 'голос запись', box(9, 3.5, 6, 11, 3), path('M5.5 11.5A6.5 6.5 0 0 0 18.5 11.5'), line(12, 18, 12, 21))
icon('camera', 'Камера', 'Camera', C, 'фото снимок', path('M4.5 7.5H8L9.5 5H14.5L16 7.5H19.5A1.5 1.5 0 0 1 21 9V18A1.5 1.5 0 0 1 19.5 19.5H4.5A1.5 1.5 0 0 1 3 18V9A1.5 1.5 0 0 1 4.5 7.5Z'), circle(12, 13, 3.5))
icon('video', 'Видео', 'Video', C, 'камера запись', box(3, 6.5, 13, 11, 2), path('M16 10.5L21 7.5V16.5L16 13.5'))
icon('music', 'Музыка', 'Music', C, 'нота песня', path('M9 17.5V5.5L19 3.5V15.5'), circle(6.5, 17.5, 2.5), circle(16.5, 15.5, 2.5))
icon('headphones', 'Наушники', 'Headphones', C, 'аудио музыка', path('M4 18V12A8 8 0 0 1 20 12V18'), box(3.5, 13.5, 4, 7, 1.5), box(16.5, 13.5, 4, 7, 1.5))
icon('film', 'Плёнка', 'Film', C, 'кино видео', box(3.5, 3.5, 17, 17, 2), line(8, 3.5, 8, 20.5), line(16, 3.5, 16, 20.5), line(3.5, 12, 20.5, 12), line(3.5, 7.75, 8, 7.75), line(3.5, 16.25, 8, 16.25), line(16, 7.75, 20.5, 7.75), line(16, 16.25, 20.5, 16.25))
icon('repeat', 'Повторять', 'Repeat', C, 'цикл заново', path('M4 11V9.5A2.5 2.5 0 0 1 6.5 7H19'), head(19, 7, 0, 4), path('M20 13V14.5A2.5 2.5 0 0 1 17.5 17H5'), head(5, 17, 180, 4))
icon('shuffle', 'Перемешать', 'Shuffle', C, 'случайно', path('M4 7H7.5C9 7 10 7.7 10.8 9L13.2 15C14 16.3 15 17 16.5 17H20'), head(20, 17, 0, 3.5), path('M4 17H7.5C9 17 10 16.3 10.8 15'), path('M13.2 9C14 7.7 15 7 16.5 7H20'), head(20, 7, 0, 3.5))

# ---------- Файлы ----------
C = 'files'
icon('file', 'Файл', 'File', C, 'документ лист', path('M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5V19A1.5 1.5 0 0 0 7 20.5H17A1.5 1.5 0 0 0 18.5 19V8.5Z'), path('M13.5 3.5V8.5H18.5'))
icon('file-text', 'Документ', 'Document', C, 'текст файл', path('M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5V19A1.5 1.5 0 0 0 7 20.5H17A1.5 1.5 0 0 0 18.5 19V8.5Z'), path('M13.5 3.5V8.5H18.5'), line(9, 12.5, 15, 12.5), line(9, 16, 15, 16))
icon('folder', 'Папка', 'Folder', C, 'каталог', path('M3.5 6.5A1.5 1.5 0 0 1 5 5H9.5L11.5 7.5H19A1.5 1.5 0 0 1 20.5 9V18A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18Z'))
icon('folder-open', 'Открытая папка', 'Open folder', C, 'каталог', path('M3.5 18V6.5A1.5 1.5 0 0 1 5 5H9.5L11.5 7.5H17.5A1.5 1.5 0 0 1 19 9V10.5'), path('M3.5 18L6 11.5A1.5 1.5 0 0 1 7.4 10.5H20.5A1 1 0 0 1 21.4 11.8L19 18.5A1.5 1.5 0 0 1 17.6 19.5H5A1.5 1.5 0 0 1 3.5 18Z'))
icon('archive', 'Архив', 'Archive', C, 'коробка хранение', box(3, 4.5, 18, 4.5, 1), path('M4.5 9V18A1.5 1.5 0 0 0 6 19.5H18A1.5 1.5 0 0 0 19.5 18V9'), line(10, 13, 14, 13))
icon('book', 'Книга', 'Book', C, 'чтение справка', path('M5 18.5V5A1.5 1.5 0 0 1 6.5 3.5H19V16.5H7A2 2 0 0 0 5 18.5A2 2 0 0 0 7 20.5H19'))
icon('book-open', 'Открытая книга', 'Open book', C, 'чтение журнал', path('M12 7C10 5.3 7 4.5 3 4.5V18C7 18 10 18.8 12 20.5C14 18.8 17 18 21 18V4.5C17 4.5 14 5.3 12 7Z'), line(12, 7, 12, 20.5))
icon('cloud', 'Облако', 'Cloud', C, 'хранилище погода', path('M7 18.5A4.5 4.5 0 0 1 6.6 9.5A6 6 0 0 1 18.2 10.5A4 4 0 0 1 17.5 18.5Z'))
icon('cloud-upload', 'Загрузить в облако', 'Cloud upload', C, 'выгрузить', path('M7.5 17.5H7A4.5 4.5 0 0 1 6.6 8.5A6 6 0 0 1 18.2 9.5A4 4 0 0 1 17.5 17.5H16.5'), arrow(12, 20.5, 12, 12, 4))
icon('database', 'База данных', 'Database', C, 'хранилище сервер', path('M4.5 6C4.5 4.6 7.9 3.5 12 3.5S19.5 4.6 19.5 6S16.1 8.5 12 8.5S4.5 7.4 4.5 6Z'), path('M4.5 6V18C4.5 19.4 7.9 20.5 12 20.5S19.5 19.4 19.5 18V6'), path('M4.5 12C4.5 13.4 7.9 14.5 12 14.5S19.5 13.4 19.5 12'))
icon('server', 'Сервер', 'Server', C, 'хостинг', box(3.5, 4, 17, 7, 1.5), box(3.5, 13, 17, 7, 1.5), dot(7.5, 7.5, 1.1), dot(7.5, 16.5, 1.1))
icon('code', 'Код', 'Code', C, 'программирование разработка', poly(8.5, 7, 3.5, 12, 8.5, 17), poly(15.5, 7, 20.5, 12, 15.5, 17), line(13.5, 5, 10.5, 19))
icon('terminal', 'Терминал', 'Terminal', C, 'консоль команда', poly(5, 7, 10, 12, 5, 17), line(12, 17.5, 19, 17.5))

# ---------- Покупки и деньги ----------
C = 'commerce'
icon('cart', 'Корзина покупок', 'Cart', C, 'магазин покупка', path('M3 4H5.5L8 15.5H18.5L20.5 7.5H6.4'), circle(9, 19.5, 1.5), circle(17.5, 19.5, 1.5))
icon('bag', 'Сумка', 'Bag', C, 'покупки магазин пакет', path('M5.5 7.5H18.5L19.5 20.5H4.5Z'), path('M9 10V6.5A3 3 0 0 1 15 6.5V10'))
icon('credit-card', 'Карта', 'Card', C, 'оплата банк', box(3, 5.5, 18, 13, 2), line(3, 10, 21, 10), line(6.5, 15, 10, 15))
icon('wallet', 'Кошелёк', 'Wallet', C, 'деньги оплата', path('M17.5 7V5.5A1.5 1.5 0 0 0 16 4H5.5A2 2 0 0 0 3.5 6V18A2 2 0 0 0 5.5 20H19A1.5 1.5 0 0 0 20.5 18.5V8.5A1.5 1.5 0 0 0 19 7H5.5A2 2 0 0 1 3.5 5'), path('M20.5 11.5H16.5A1.75 1.75 0 0 0 16.5 15H20.5'))
icon('ruble', 'Рубль', 'Ruble', C, 'деньги цена валюта ₽', path('M8 20.5V3.5H13.5A4.5 4.5 0 0 1 13.5 12.5H6'), line(6, 16.5, 14, 16.5))
icon('dollar', 'Доллар', 'Dollar', C, 'деньги цена валюта $', line(12, 2.5, 12, 21.5), path('M16.5 6.5C15.8 5.3 14.2 4.5 12 4.5C9.2 4.5 7.5 5.8 7.5 7.7C7.5 12.4 16.5 10.3 16.5 15.6C16.5 17.8 14.6 19.5 12 19.5C9.6 19.5 7.9 18.6 7.2 17'))
icon('percent', 'Процент', 'Percent', C, 'скидка распродажа', line(18.5, 5.5, 5.5, 18.5), circle(7, 7, 2.5), circle(17, 17, 2.5))
icon('gift', 'Подарок', 'Gift', C, 'бонус праздник', box(3.5, 8, 17, 4.5, 1), path('M5 12.5V19A1.5 1.5 0 0 0 6.5 20.5H17.5A1.5 1.5 0 0 0 19 19V12.5'), line(12, 8, 12, 20.5), path('M12 8C10.5 5 7 4 7 6S9.5 8 12 8C14.5 8 17 8 17 6S13.5 5 12 8Z'))
icon('receipt', 'Чек', 'Receipt', C, 'квитанция счёт', path('M5.5 3.5H18.5V20.5L16 19L14 20.5L12 19L10 20.5L8 19L5.5 20.5Z'), line(9, 8, 15, 8), line(9, 11.5, 15, 11.5), line(9, 15, 12.5, 15))
icon('truck', 'Доставка', 'Delivery', C, 'грузовик перевозка', path('M2.5 5.5H14.5V16H2.5Z'), path('M14.5 9H18.5L21.5 12.5V16H14.5'), circle(6.5, 17.5, 2), circle(17.5, 17.5, 2))
icon('package', 'Посылка', 'Package', C, 'коробка доставка', path('M12 3L20.5 7.5V16.5L12 21L3.5 16.5V7.5Z'), poly(3.5, 7.5, 12, 12, 20.5, 7.5), line(12, 12, 12, 21), line(7.75, 5.25, 16.25, 9.75))
icon('store', 'Магазин', 'Store', C, 'лавка торговля', path('M4 9.5L5.5 4.5H18.5L20 9.5'), path('M4 9.5A2.7 2.7 0 0 0 9.3 9.5A2.7 2.7 0 0 0 14.7 9.5A2.7 2.7 0 0 0 20 9.5'), path('M5.5 12V20.5H18.5V12'), path('M10 20.5V15.5H14V20.5'))

# ---------- Устройства ----------
C = 'devices'
icon('smartphone', 'Смартфон', 'Smartphone', C, 'телефон мобильный', box(6.5, 2.5, 11, 19, 2.5), line(10.5, 18.5, 13.5, 18.5))
icon('tablet', 'Планшет', 'Tablet', C, 'айпад', box(4.5, 2.5, 15, 19, 2.5), line(10.5, 18.5, 13.5, 18.5))
icon('laptop', 'Ноутбук', 'Laptop', C, 'компьютер', box(5, 5, 14, 10, 1.5), path('M2.5 19.5H21.5L19.5 15H4.5Z'))
icon('monitor', 'Монитор', 'Monitor', C, 'компьютер экран десктоп', box(3, 4, 18, 12, 2), line(12, 16, 12, 20), line(8, 20, 16, 20))
icon('watch', 'Часы наручные', 'Watch', C, 'смарт-часы', box(6.5, 6.5, 11, 11, 2.5), path('M9 6.5L9.5 3H14.5L15 6.5'), path('M9 17.5L9.5 21H14.5L15 17.5'))
icon('keyboard', 'Клавиатура', 'Keyboard', C, 'ввод', box(2.5, 6, 19, 12, 2), *[dot(x, y, 0.9) for y in (9.5, 12.5) for x in (6.5, 9.5, 12.5, 15.5, 18.5)], line(8, 15.5, 16, 15.5))
icon('mouse', 'Мышь', 'Mouse', C, 'компьютерная', box(6.5, 3.5, 11, 17, 5.5), line(12, 7, 12, 10))
icon('wifi', 'Вай-фай', 'Wi-Fi', C, 'интернет сеть беспроводная', arc(12, 19.5, 13, 230, 310), arc(12, 19.5, 8.5, 230, 310), arc(12, 19.5, 4, 230, 310), dot(12, 19, 1.2))
icon('bluetooth', 'Блютуз', 'Bluetooth', C, 'беспроводная связь', poly(7, 7.5, 17, 16, 12, 20.5, 12, 3.5, 17, 8, 7, 16.5))
icon('battery', 'Батарея', 'Battery', C, 'заряд аккумулятор', box(2.5, 7, 17, 10, 2), line(22, 10.5, 22, 13.5), line(6, 10.5, 6, 13.5), line(9.5, 10.5, 9.5, 13.5))
icon('battery-charging', 'Зарядка', 'Charging', C, 'батарея заряд', path('M8 7H4.5A2 2 0 0 0 2.5 9V15A2 2 0 0 0 4.5 17H6.5'), path('M14 17H17.5A2 2 0 0 0 19.5 15V9A2 2 0 0 0 17.5 7H15.5'), poly(11.5, 6, 8.5, 12, 13.5, 12, 10.5, 18), line(22, 10.5, 22, 13.5))
icon('cpu', 'Процессор', 'CPU', C, 'чип микросхема', box(6, 6, 12, 12, 1.5), box(9.5, 9.5, 5, 5, 0.5), *[line(x, 3, x, 6) for x in (9.5, 14.5)], *[line(x, 18, x, 21) for x in (9.5, 14.5)], *[line(3, y, 6, y) for y in (9.5, 14.5)], *[line(18, y, 21, y) for y in (9.5, 14.5)])

# ---------- Погода и природа ----------
C = 'nature'
icon('cloud-rain', 'Дождь', 'Rain', C, 'погода ливень', path('M7 15.5A4.5 4.5 0 0 1 6.6 6.5A6 6 0 0 1 18.2 7.5A4 4 0 0 1 17.5 15.5'), line(8, 18, 7, 21), line(12, 18, 11, 21), line(16, 18, 15, 21))
icon('cloud-snow', 'Снег', 'Snow', C, 'погода зима', path('M7 15.5A4.5 4.5 0 0 1 6.6 6.5A6 6 0 0 1 18.2 7.5A4 4 0 0 1 17.5 15.5'), dot(8, 18.5, 1), dot(12, 20, 1), dot(16, 18.5, 1))
icon('lightning', 'Молния', 'Lightning', C, 'энергия быстро гроза', path('M13 2.5L4.5 13.5H11.5L10.5 21.5L19.5 10.5H12.5Z'))
icon('droplet', 'Капля', 'Droplet', C, 'вода цвет жидкость', path('M12 3C12 3 5.5 10 5.5 14.5A6.5 6.5 0 0 0 18.5 14.5C18.5 10 12 3 12 3Z'))
icon('wind', 'Ветер', 'Wind', C, 'погода воздух', path('M3 9H14.5A2.5 2.5 0 1 0 12 6.5'), path('M3 13H18.5A2.5 2.5 0 1 1 16 15.5'), line(3, 17, 10, 17))
icon('thermometer', 'Термометр', 'Thermometer', C, 'температура градусы', path('M10 13.8V5.5A2 2 0 0 1 14 5.5V13.8A4 4 0 1 1 10 13.8Z'), line(12, 10, 12, 17))
icon('umbrella', 'Зонт', 'Umbrella', C, 'дождь защита', path('M3 12A9 9 0 0 1 21 12Z'), path('M12 12V18.5A2 2 0 0 1 8 18.5'))
icon('leaf', 'Лист', 'Leaf', C, 'экология природа', path('M5 19C5 10 10 5 20 4C19 14 14 19 5 19Z'), line(5, 19, 13, 11))
icon('flame', 'Огонь', 'Flame', C, 'пламя горячее популярное', path('M12 21C8.4 21 6 18.6 6 15.4C6 11.5 9.5 9.5 10 4C13.5 6 18 10.5 18 15.4C18 18.6 15.6 21 12 21Z'), path('M12 21C10.6 21 9.5 19.9 9.5 18.5C9.5 16.8 11 15.8 12 14C13 15.8 14.5 16.8 14.5 18.5C14.5 19.9 13.4 21 12 21Z'))
icon('tree', 'Дерево', 'Tree', C, 'лес природа ёлка', path('M12 3L6 11H9L5 16.5H19L15 11H18Z'), line(12, 16.5, 12, 21))
icon('mountain', 'Горы', 'Mountains', C, 'пейзаж природа', path('M2.5 19.5L9 8L13 15L15.5 11L21.5 19.5Z'))

# ---------- Места и транспорт ----------
C = 'places'
icon('map-pin', 'Метка на карте', 'Map pin', C, 'место адрес геолокация', path('M12 21C12 21 5 14.5 5 9.5A7 7 0 0 1 19 9.5C19 14.5 12 21 12 21Z'), circle(12, 9.5, 2.5))
icon('map', 'Карта', 'Map', C, 'маршрут навигация', path('M3.5 6.5L9 4.5L15 6.5L20.5 4.5V17.5L15 19.5L9 17.5L3.5 19.5Z'), line(9, 4.5, 9, 17.5), line(15, 6.5, 15, 19.5))
icon('navigation', 'Навигация', 'Navigation', C, 'направление стрелка компас', path('M20.5 3.5L3.5 11L11 13L13 20.5Z'))
icon('compass', 'Компас', 'Compass', C, 'направление ориентир', circle(12, 12, 9), path('M15.5 8.5L13.5 13.5L8.5 15.5L10.5 10.5Z'))
icon('globe', 'Глобус', 'Globe', C, 'мир язык интернет', circle(12, 12, 9), line(3, 12, 21, 12), path('M12 3C14.5 5.5 15.5 8.7 15.5 12S14.5 18.5 12 21C9.5 18.5 8.5 15.3 8.5 12S9.5 5.5 12 3Z'))
icon('car', 'Автомобиль', 'Car', C, 'машина транспорт', path('M4.5 16.5H3.5V12.5L5.5 7.5A1.5 1.5 0 0 1 6.9 6.5H17.1A1.5 1.5 0 0 1 18.5 7.5L20.5 12.5V16.5H19.5'), line(9.5, 16.5, 14.5, 16.5), circle(7, 16.5, 2), circle(17, 16.5, 2), line(3.5, 12.5, 20.5, 12.5))
icon('plane', 'Самолёт', 'Plane', C, 'полёт путешествие', path('M10.5 13.5L3.5 11L5 9.5L13 9.5L17.5 5A2.1 2.1 0 0 1 20.5 8L16 12.5V20.5L14.5 22L12 15'), path('M7 17L4.5 16L6 14.5'), line(10.5, 13.5, 8, 16))
icon('bus', 'Автобус', 'Bus', C, 'транспорт', box(5, 3.5, 14, 15, 2.5), line(5, 11.5, 19, 11.5), line(7.5, 18.5, 7.5, 21), line(16.5, 18.5, 16.5, 21), dot(8.5, 15, 1.1), dot(15.5, 15, 1.1))
icon('bike', 'Велосипед', 'Bike', C, 'спорт транспорт', circle(5.5, 16.5, 3.5), circle(18.5, 16.5, 3.5), poly(5.5, 16.5, 9.5, 8.5, 15.5, 8.5, 18.5, 16.5), poly(9.5, 8.5, 12.5, 16.5, 15.5, 8.5), line(8, 6, 11, 6))
icon('building', 'Здание', 'Building', C, 'офис компания', box(5, 3, 14, 18, 1), *[dot(x, y, 0.95) for y in (7, 10.5, 14) for x in (9, 12, 15)], path('M10.5 21V17.5H13.5V21'))

# ---------- Текст и дизайн ----------
C = 'design'
icon('type', 'Текст', 'Type', C, 'шрифт буква', poly(5, 7, 5, 4.5, 19, 4.5, 19, 7), line(12, 4.5, 12, 19.5), line(9, 19.5, 15, 19.5))
icon('bold', 'Жирный', 'Bold', C, 'шрифт начертание', path('M7 4.5H13A3.75 3.75 0 0 1 13 12H7Z'), path('M7 12H14A3.75 3.75 0 0 1 14 19.5H7Z'))
icon('italic', 'Курсив', 'Italic', C, 'наклонный шрифт', line(10, 4.5, 18, 4.5), line(6, 19.5, 14, 19.5), line(14, 4.5, 10, 19.5))
icon('underline', 'Подчёркнутый', 'Underline', C, 'шрифт', path('M7 4V11A5 5 0 0 0 17 11V4'), line(5, 20, 19, 20))
icon('align-left', 'По левому краю', 'Align left', C, 'выравнивание текст', line(4, 6, 20, 6), line(4, 10, 14, 10), line(4, 14, 20, 14), line(4, 18, 14, 18))
icon('align-center', 'По центру', 'Align center', C, 'выравнивание текст', line(4, 6, 20, 6), line(7, 10, 17, 10), line(4, 14, 20, 14), line(7, 18, 17, 18))
icon('align-right', 'По правому краю', 'Align right', C, 'выравнивание текст', line(4, 6, 20, 6), line(10, 10, 20, 10), line(4, 14, 20, 14), line(10, 18, 20, 18))
icon('align-justify', 'По ширине', 'Justify', C, 'выравнивание текст', line(4, 6, 20, 6), line(4, 10, 20, 10), line(4, 14, 20, 14), line(4, 18, 20, 18))
icon('pen-tool', 'Перо', 'Pen tool', C, 'вектор кривые рисование', path('M12 3.5L18.5 11L15.5 19H8.5L5.5 11Z'), line(12, 3.5, 12, 11.5), circle(12, 12.5, 1.5), line(8.5, 21, 15.5, 21))
icon('crop', 'Обрезать', 'Crop', C, 'кадрировать', path('M6.5 2.5V16A1.5 1.5 0 0 0 8 17.5H21.5'), path('M2.5 6.5H16A1.5 1.5 0 0 1 17.5 8V21.5'))
icon('scissors', 'Ножницы', 'Scissors', C, 'вырезать', circle(6.5, 6.5, 3), circle(6.5, 17.5, 3), line(8.9, 8.3, 20, 17.5), line(8.9, 15.7, 20, 6.5))
icon('palette', 'Палитра', 'Palette', C, 'цвет краски дизайн', path('M12 3C7 3 3 7 3 12C3 16.4 6.6 21 11.5 21C13 21 13.5 20 13 18.8C12.4 17.4 13.3 16 14.8 16H17C19.2 16 21 14.2 21 12C21 7 17 3 12 3Z'), dot(7.5, 12, 1.2), dot(10, 7.5, 1.2), dot(15, 7.5, 1.2))
icon('frame', 'Фрейм', 'Frame', C, 'рамка артборд', line(8, 3, 8, 21), line(16, 3, 16, 21), line(3, 8, 21, 8), line(3, 16, 21, 16))
icon('layout', 'Макет', 'Layout', C, 'раскладка шаблон', box(3.5, 3.5, 17, 17, 2), line(3.5, 9, 20.5, 9), line(10, 9, 10, 20.5))
icon('eyedropper', 'Пипетка', 'Eyedropper', C, 'цвет взять', line(12.5, 8.5, 15.5, 11.5), path('M13.6 7.4L16.5 4.5A2.47 2.47 0 0 1 20 8L17.1 10.9'), path('M13.2 9.2L5.5 16.9L4 20L7.1 18.5L14.8 10.8'))
icon('ruler', 'Линейка', 'Ruler', C, 'измерение размер', path('M3.5 15.5L15.5 3.5L20.5 8.5L8.5 20.5Z'), line(7.5, 11.5, 9.5, 13.5), line(10.5, 8.5, 12.5, 10.5), line(13.5, 5.5, 15.5, 7.5))

# ---------- Графики ----------
C = 'charts'
icon('bar-chart', 'Столбчатая диаграмма', 'Bar chart', C, 'график статистика', line(6, 20, 6, 12), line(12, 20, 12, 5), line(18, 20, 18, 9), line(3.5, 20.5, 20.5, 20.5))
icon('line-chart', 'Линейный график', 'Line chart', C, 'график статистика', path('M3.5 4V20.5H20.5'), poly(7, 15, 11, 10.5, 14, 13, 19.5, 6.5))
icon('pie-chart', 'Круговая диаграмма', 'Pie chart', C, 'доли статистика', path('M20.4 14.5A9 9 0 1 1 9.5 3.6'), path('M12 3A9 9 0 0 1 21 12H12Z'))
icon('activity', 'Активность', 'Activity', C, 'пульс сердцебиение', poly(3, 12, 7, 12, 10, 4.5, 14, 19.5, 17, 12, 21, 12))
icon('target', 'Цель', 'Target', C, 'мишень фокус', circle(12, 12, 9), circle(12, 12, 5.5), dot(12, 12, 1.6))

# ---------- Разное ----------
C = 'misc'
icon('award', 'Награда', 'Award', C, 'медаль достижение', circle(12, 9, 5.5), poly(8.6, 13.4, 7.5, 21, 12, 18.5, 16.5, 21, 15.4, 13.4))
icon('trophy', 'Кубок', 'Trophy', C, 'победа приз', path('M7 4H17V10A5 5 0 0 1 7 10Z'), path('M7 6H4.5V7.5A3 3 0 0 0 7.5 10.5'), path('M17 6H19.5V7.5A3 3 0 0 1 16.5 10.5'), line(12, 15, 12, 18.5), line(8, 20.5, 16, 20.5))
icon('briefcase', 'Портфель', 'Briefcase', C, 'работа бизнес', box(3, 7, 18, 13, 2), path('M9 7V5A1.5 1.5 0 0 1 10.5 3.5H13.5A1.5 1.5 0 0 1 15 5V7'), line(3, 12.5, 21, 12.5))
icon('coffee', 'Кофе', 'Coffee', C, 'чашка перерыв', path('M4 8.5H17V14A5 5 0 0 1 12 19H9A5 5 0 0 1 4 14Z'), path('M17 10H18.5A2.5 2.5 0 0 1 18.5 15H17'), line(8, 3, 8, 5.5), line(12, 3, 12, 5.5))
icon('lightbulb', 'Лампочка', 'Lightbulb', C, 'идея совет', path('M9 16.5C9 14.5 6 13 6 9.5A6 6 0 0 1 18 9.5C18 13 15 14.5 15 16.5Z'), line(9.5, 19, 14.5, 19), line(10.5, 21.5, 13.5, 21.5))
icon('shield', 'Щит', 'Shield', C, 'защита безопасность', path('M12 21C7.5 19 4.5 15.5 4.5 11V5.5L12 3L19.5 5.5V11C19.5 15.5 16.5 19 12 21Z'))
icon('shield-check', 'Щит с галочкой', 'Shield check', C, 'защищено проверено', path('M12 21C7.5 19 4.5 15.5 4.5 11V5.5L12 3L19.5 5.5V11C19.5 15.5 16.5 19 12 21Z'), poly(8.5, 12, 11, 14.5, 15.5, 9.5))
icon('rocket', 'Ракета', 'Rocket', C, 'запуск старт быстро', path('M12 15.5L8.5 12C10 7 13.5 3.5 20.5 3.5C20.5 10.5 17 14 12 15.5Z'), path('M8.5 12L5 11.5L7.5 8.5H11'), path('M12 15.5L12.5 19L15.5 16.5V13'), path('M6.5 15.5C5 16 4 18 4 20C6 20 8 19 8.5 17.5'), circle(15.5, 8.5, 1.5))
icon('puzzle', 'Пазл', 'Puzzle', C, 'плагин часть', path('M4 7H9A2.5 2.5 0 1 1 14 7H17V10A2.5 2.5 0 1 1 17 15V20H4Z'))
icon('qr-code', 'QR-код', 'QR code', C, 'сканировать код', box(3.5, 3.5, 7, 7, 1), box(13.5, 3.5, 7, 7, 1), box(3.5, 13.5, 7, 7, 1), dot(7, 7, 1), dot(17, 7, 1), dot(7, 17, 1), line(13.5, 13.5, 13.5, 16), line(17, 13.5, 20.5, 13.5), line(17, 17, 17, 20.5), line(20.5, 17, 20.5, 20.5), line(13.5, 20.5, 14, 20.5))
icon('hash', 'Решётка', 'Hash', C, 'хэштег номер', line(9.5, 3.5, 7.5, 20.5), line(16.5, 3.5, 14.5, 20.5), line(4, 9, 20.5, 9), line(3.5, 15, 20, 15))
icon('box', 'Куб', 'Box', C, 'объём 3d', path('M12 3L20.5 7.5V16.5L12 21L3.5 16.5V7.5Z'), poly(3.5, 7.5, 12, 12, 20.5, 7.5), line(12, 12, 12, 21))

out = os.path.join(os.path.dirname(__file__), '..', '..', 'packages', 'editor', 'src', 'icons', 'set.ts')
os.makedirs(os.path.dirname(out), exist_ok=True)
ids = [i['id'] for i in ICONS]
assert len(ids) == len(set(ids)), 'duplicate ids'
with open(out, 'w', encoding='utf-8') as f:
    f.write('// Simmetrika\'s own icons, drawn from geometry by tools/icons/build-icons.py — do not edit by hand.\n')
    f.write('// 24 × 24, stroke 2, round ends; what an icon is drawn with is in its `body` (SVG elements).\n\n')
    f.write('export type IconCategory = ' + ' | '.join(json.dumps(c) for c in dict.fromkeys(i['cat'] for i in ICONS)) + ';\n\n')
    f.write('export interface IconDef {\n  id: string;\n  ru: string;\n  en: string;\n  cat: IconCategory;\n  /** Words people search by, in Russian and English. */\n  tags: string;\n  body: string;\n}\n\n')
    f.write('export const ICONS: IconDef[] = [\n')
    for i in ICONS:
        f.write('  ' + json.dumps(i, ensure_ascii=False) + ',\n')
    f.write('];\n')
print(len(ICONS), 'icons →', os.path.normpath(out))
