// «История просмотров…» (step 9): who opened the file and when, newest first — the owner and editors see it.

import { locale, plural, tr } from '#core';
import { views, type ViewInfo } from '../cloud.ts';
import { openDialog } from './dialog.ts';
import { h } from './dom.ts';
import { when } from './comments.ts';

function row(v: ViewInfo): HTMLElement {
  const name = v.name === null ? tr('Гости по ссылке') : v.me ? tr('{0} (вы)', v.name) : v.name;
  const visits = `${v.visits} ${plural(v.visits, tr('визит'), tr('визита'), tr('визитов'))}`;
  return h(
    'li',
    { class: 'views-row' },
    h('span', { class: 'comment-avatar' }, (v.name ?? '?').trim().charAt(0).toUpperCase() || '?'),
    h('span', { class: 'views-name' }, name),
    h('time', { class: 'views-when', datetime: new Date(v.last).toISOString(), title: tr('Впервые: {0}', new Date(v.first).toLocaleString(locale())) }, `${when(v.last)} · ${visits}`),
  );
}

export async function showViewHistory(fileId: string): Promise<void> {
  const list = await views.list(fileId);
  const body = list.length ? h('ul', { class: 'views-list' }, ...list.map(row)) : h('p', { class: 'hint' }, tr('Файл ещё никто не открывал.'));
  await openDialog({ title: tr('История просмотров'), body: [body], confirm: tr('Закрыть'), cancel: null });
}
