// "Prototype" tab of the right panel (FR-PRT-001–003): flows of the page,
// the flow start of a screen, and the interactions of the selected layer —
// a trigger and one or more actions run in order. Every change goes through
// PrototypeController, so it is one undo step; the panel is rebuilt when the
// interactions change (see PropertiesPanel's signature).

import { tr } from '#core';
import { isFrameLike, type Easing, type NodeId, type OverlayPosition, type OverlaySettings, type PrototypeAction, type Reaction, type Transition, type TransitionDirection, type TransitionType, type TriggerType } from '#core';
import type { Editor } from '../editor.ts';
import { openColorPicker } from '../ui/color-picker.ts';
import { h, icon } from '../ui/dom.ts';

/** A colour swatch opening our picker (not the browser's system colour window). */
function swatchButton(label: string, value: { r: number; g: number; b: number }, onChange: (c: { r: number; g: number; b: number; a: number }) => void): HTMLButtonElement {
  const b: HTMLButtonElement = h('button', { class: 'color-swatch proto-color', type: 'button', 'aria-label': label, title: label, style: { background: hex(value) } });
  b.addEventListener('click', () =>
    openColorPicker({
      anchor: b,
      color: { ...value, a: 1 },
      opacity: 1,
      noOpacity: true,
      onChange: (c) => {
        b.style.background = hex(c);
        onChange(c);
      },
    }),
  );
  return b;
}
import { PrototypeController } from './controller.ts';
import { curveEditor } from './curve-editor.ts';
import type { OverflowDirection, ScrollBehavior } from '#core';
import { BEZIER_PRESETS, clampDuration, DIRECTIONAL, SPRING_PRESETS, TRANSITION_LABELS } from './easing.ts';
import { allVariables } from '#components';
import type { PrototypeDevice, VariableType } from '#core';
import { DEVICE_LABELS } from './devices.ts';
import { formatValue, tryEvaluate } from '#components';
import { readVariable, toDisplay, toStored } from './vars.ts';
import { ACTION_LABELS, DEFAULT_TRANSITION, MAX_CONDITION_DEPTH, flows, isScreen, screenOf, screens, TRIGGER_LABELS, variantChoices } from './model.ts';

export interface PrototypePanelHost {
  editor: Editor;
  section(title: string, ...actions: HTMLElement[]): HTMLElement;
  /** Opens the viewer at a screen. */
  present(start: NodeId | null, newTab?: boolean): void;
}

/** Triggers offered now; "while hovering / pressing" come with overlays and "Change to". */
const TRIGGERS: TriggerType[] = ['ON_CLICK', 'ON_HOVER', 'ON_PRESS', 'MOUSE_ENTER', 'MOUSE_LEAVE', 'AFTER_TIMEOUT', 'ON_KEY'];
const ACTIONS: PrototypeAction['type'][] = ['NAVIGATE', 'BACK', 'SCROLL_TO', 'URL', 'OPEN_OVERLAY', 'SWAP_OVERLAY', 'CLOSE_OVERLAY', 'CHANGE_TO', 'SET_VARIABLE', 'CONDITIONAL'];

/** What the tab depends on: rebuilt when any of it changes. */
export function prototypeSignature(editor: Editor): string {
  const d = editor.doc;
  const ids = editor.topLevelSelection();
  const page = editor.pageId;
  const screenNames = screens(d, page).map((s) => `${s}=${d.get(s, 'name')}`).join(',');
  return ['proto', page, ids.join(','), ids.map((id) => JSON.stringify(d.get(id, 'reactions'))).join('|'), JSON.stringify(d.get(page, 'flowStartingPoints')), screenNames, JSON.stringify(d.get(page, 'prototypeBackground')), d.get(page, 'prototypeDevice'), allVariables(d).map((v) => `${v}=${d.get(v, 'name')}`).join(',')].join(':');
}

export function buildPrototypePanel(host: PrototypePanelHost): void {
  const { editor } = host;
  const ids = editor.topLevelSelection();
  if (ids.length === 0) {
    buildPage(host);
    return;
  }
  if (ids.length > 1) {
    const body = host.section(tr('Взаимодействия'));
    body.append(h('p', { class: 'hint' }, tr('Выберите один слой, чтобы настроить его взаимодействия.')));
    return;
  }
  const id = ids[0]!;
  if (isScreen(editor.doc, id)) buildFlowStart(host, id);
  buildScrolling(host, id);
  if (editor.prototype.canInteract(id)) buildReactions(host, id);
  else host.section(tr('Взаимодействия')).append(h('p', { class: 'hint' }, tr('У секции нет взаимодействий')));
}

// ---------- page: flows and viewer settings ----------

function buildPage(host: PrototypePanelHost): void {
  const { editor } = host;
  const d = editor.doc;
  const page = editor.pageId;
  const list = flows(d, page);
  const body = host.section(tr('Потоки'));
  if (list.length === 0) {
    body.append(h('p', { class: 'hint' }, tr('Потоков пока нет')));
  }
  for (const flow of list) {
    const play = h('button', { class: 'icon-button', type: 'button', title: tr('Открыть просмотр с этого потока'), 'aria-label': tr('Просмотр: {0}', flow.name) }, icon('play', 14));
    play.addEventListener('click', () => host.present(flow.nodeId));
    const go = h('button', { class: 'text-button flow-screen', type: 'button', title: tr('Показать экран на холсте') }, d.get(flow.nodeId, 'name'));
    go.addEventListener('click', () => {
      editor.setSelection([flow.nodeId]);
      editor.zoomToSelection?.();
    });
    body.append(h('div', { class: 'flow-row' }, play, h('div', { class: 'flow-text' }, h('span', { class: 'flow-name' }, flow.name), go)));
  }
  const view = host.section(tr('Просмотр'));
  const bg = d.get(page, 'prototypeBackground');
  const color = swatchButton(tr('Фон вокруг экрана'), bg ?? { r: 0.118, g: 0.118, b: 0.118 }, (c) => editor.commit(tr('Фон просмотра'), (tx) => tx.set(page, 'prototypeBackground', { ...c, a: 1 })));
  view.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Фон')), color));
  const device = select(tr('Устройство'), (Object.keys(DEVICE_LABELS) as PrototypeDevice[]).map((k) => [k, DEVICE_LABELS[k]]), d.get(page, 'prototypeDevice'), (v) => editor.commit(tr('Устройство просмотра'), (tx) => tx.set(page, 'prototypeDevice', v as PrototypeDevice)));
  view.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Устройство')), device));
  const open = h('button', { class: 'text-button primary proto-present', type: 'button' }, icon('play', 14), h('span', {}, tr('Открыть просмотр')));
  open.addEventListener('click', () => host.present(null));
  const tab = h('button', { class: 'text-button proto-present', type: 'button', title: tr('Отдельная вкладка: удобно показать на втором мониторе') }, h('span', {}, tr('В новой вкладке')));
  tab.addEventListener('click', () => host.present(null, true));
  view.append(h('div', { class: 'proto-buttons' }, open, tab));
}

function hex(c: { r: number; g: number; b: number }): string {
  return '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

// ---------- screen: flow start ----------

function buildFlowStart(host: PrototypePanelHost, screen: NodeId): void {
  const { editor } = host;
  const proto = editor.prototype;
  const flow = proto.flows().find((f) => f.nodeId === screen);
  const toggle = h('button', { class: 'icon-button', type: 'button', title: flow ? tr('Убрать начало потока') : tr('Сделать началом потока'), 'aria-label': flow ? tr('Убрать начало потока') : tr('Сделать началом потока') }, icon(flow ? 'minus' : 'plus', 14));
  toggle.addEventListener('click', () => (flow ? proto.removeFlow(screen) : proto.addFlow(screen)));
  const body = host.section(tr('Начало потока'), toggle);
  if (!flow) {
    return;
  }
  const name = h('input', { class: 'proto-input', type: 'text', value: flow.name, 'aria-label': tr('Название потока'), spellcheck: false });
  name.addEventListener('change', () => {
    const v = name.value.trim();
    if (v && v !== flow.name) proto.updateFlow(screen, { name: v });
  });
  const desc = h('textarea', { class: 'proto-input proto-desc', rows: 2, placeholder: tr('Описание (необязательно)'), 'aria-label': tr('Описание потока') });
  desc.value = flow.description;
  desc.addEventListener('change', () => proto.updateFlow(screen, { description: desc.value }));
  for (const el of [name, desc]) el.addEventListener('keydown', (e) => e.stopPropagation());
  const play = h('button', { class: 'text-button proto-present', type: 'button' }, icon('play', 14), h('span', {}, tr('Просмотр с этого экрана')));
  play.addEventListener('click', () => host.present(screen));
  body.append(name, desc, play);
}

// ---------- scrolling (FR-PRT-030, 031) ----------

function buildScrolling(host: PrototypePanelHost, id: NodeId): void {
  const { editor } = host;
  const d = editor.doc;
  const parent = d.parent(id);
  const isFrame = isFrameLike(d.type(id)) && d.type(id) !== 'COMPONENT_SET';
  // A layer inside a frame can scroll with it, stay fixed or stick (only matters if an ancestor scrolls).
  const inFrame = parent !== null && isFrameLike(d.type(parent)) && !isScreen(d, id);
  if (!isFrame && !inFrame) return;
  const body = host.section(tr('Прокрутка'));
  if (isFrame) {
    const overflow = select(tr('Прокрутка содержимого'), [['NONE', tr('Нет')], ['VERTICAL', tr('По вертикали')], ['HORIZONTAL', tr('По горизонтали')], ['BOTH', tr('В обе стороны')]], d.get(id, 'overflowDirection'), (v) => editor.prototype.setOverflow([id], v as OverflowDirection));
    body.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Содержимое')), overflow));
    if (d.get(id, 'overflowDirection') !== 'NONE' && !d.get(id, 'clipsContent')) {
      body.append(h('p', { class: 'hint small' }, tr('Включите «Обрезать всё, что выходит за рамку» на вкладке «Дизайн»')));
    }
  }
  if (inFrame) {
    const behaviour = select(tr('Положение при прокрутке'), [['SCROLLS', tr('Прокручивается')], ['FIXED', tr('Закреплён')], ['STICKY', tr('Липкий')]], d.get(id, 'scrollBehavior'), (v) => editor.prototype.setScrollBehavior([id], v as ScrollBehavior));
    body.append(h('label', { class: 'proto-line', title: tr('Закреплён — остаётся на месте (шапка, таббар). Липкий — прокручивается, пока не дойдёт до верха, и там остаётся.') }, h('span', { class: 'field-label' }, tr('При прокрутке')), behaviour));
  }
}

// ---------- layer: interactions ----------

function buildReactions(host: PrototypePanelHost, id: NodeId): void {
  const { editor } = host;
  const proto = editor.prototype;
  const add = h('button', { class: 'icon-button', type: 'button', title: tr('Добавить взаимодействие'), 'aria-label': tr('Добавить взаимодействие') }, icon('plus', 14));
  add.addEventListener('click', () => proto.addReaction(id));
  const body = host.section(tr('Взаимодействия'), add);
  const reactions = proto.reactions(id);
  if (reactions.length === 0) {
    body.append(h('p', { class: 'hint' }, tr('Потяните синий «+» с края слоя на экран')));
    return;
  }
  reactions.forEach((reaction, index) => body.append(reactionCard(host, id, reaction, index)));
}

function reactionCard(host: PrototypePanelHost, id: NodeId, reaction: Reaction, index: number): HTMLElement {
  const proto = host.editor.prototype;
  const update = (fn: (r: Reaction) => void, label?: string) => proto.updateReaction(id, index, fn, label);
  const trigger = select(
    tr('Когда'),
    TRIGGERS.map((t) => [t, TRIGGER_LABELS[t]]),
    reaction.trigger.type,
    (v) =>
      update((r) => {
        r.trigger = { type: v as TriggerType };
        if (v === 'AFTER_TIMEOUT') r.trigger.timeout = 800;
        if (v === 'ON_KEY') r.trigger.key = 'Enter';
      }, tr('Изменить триггер')),
  );
  const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить взаимодействие'), 'aria-label': tr('Удалить взаимодействие') }, icon('minus', 14));
  remove.addEventListener('click', () => proto.removeReaction(id, index));
  const head = h('div', { class: 'proto-head' }, trigger, remove);
  const card = h('div', { class: 'proto-card' }, head);
  if (reaction.trigger.type === 'AFTER_TIMEOUT') {
    const ms = h('input', { class: 'proto-input proto-number', type: 'number', min: 0, max: 600000, step: 100, value: String(reaction.trigger.timeout ?? 800), 'aria-label': tr('Задержка, мс') });
    ms.addEventListener('keydown', (e) => e.stopPropagation());
    ms.addEventListener('change', () => update((r) => (r.trigger.timeout = Math.max(0, Math.min(600000, Number(ms.value) || 0))), tr('Задержка')));
    card.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Через, мс')), ms));
  }
  if (reaction.trigger.type === 'ON_KEY') {
    const key = h('input', { class: 'proto-input proto-key', type: 'text', readOnly: true, value: keyName(reaction.trigger.key), 'aria-label': tr('Клавиша: нажмите нужную') });
    key.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      update((r) => (r.trigger.key = e.key), tr('Клавиша'));
    });
    card.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Клавиша')), key));
  }
  const edit: ListEdit = (fn, label) => update((r) => fn(r.actions), label);
  reaction.actions.forEach((action, ai) => card.append(actionRow(host, id, action, ai, reaction.actions.length, edit, 0)));
  const more = h('button', { class: 'text-button proto-add-action', type: 'button' }, icon('plus', 12), h('span', {}, tr('Ещё действие')));
  more.addEventListener('click', () => update((r) => r.actions.push(PrototypeController.makeAction('NAVIGATE')), tr('Добавить действие')));
  card.append(more);
  return card;
}

/** Edits the list of actions a row belongs to (an interaction's, or a condition branch's). */
type ListEdit = (fn: (list: PrototypeAction[]) => void, label?: string) => void;

function actionRow(host: PrototypePanelHost, id: NodeId, action: PrototypeAction, ai: number, count: number, update: ListEdit, depth: number): HTMLElement {
  const { editor } = host;
  const d = editor.doc;
  // Conditions nest up to five levels (FR-PRT-041).
  const kinds = depth + 1 >= MAX_CONDITION_DEPTH ? ACTIONS.filter((t) => t !== 'CONDITIONAL' || action.type === 'CONDITIONAL') : ACTIONS;
  const kind = select(tr('Действие'), kinds.map((t) => [t, ACTION_LABELS[t]]), action.type, (v) => update((list) => (list[ai] = PrototypeController.makeAction(v as PrototypeAction['type'], list[ai])), tr('Изменить действие')));
  const row = h('div', { class: 'proto-action' }, h('div', { class: 'proto-head' }, kind));
  if (count > 1) {
    const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Удалить действие'), 'aria-label': tr('Удалить действие') }, icon('close', 12));
    remove.addEventListener('click', () => update((list) => list.splice(ai, 1), tr('Удалить действие')));
    row.firstElementChild!.append(remove);
  }
  if (action.type === 'NAVIGATE') {
    const own = screenOf(d, id);
    const options: [string, string][] = [['', tr('Выберите экран…')], ...screens(d, editor.pageId).filter((s) => s !== own).map((s): [string, string] => [s, d.get(s, 'name')])];
    const dest = action.destinationId && isScreen(d, action.destinationId) ? action.destinationId : '';
    const target = select(tr('Экран'), options, dest, (v) => update((list) => {
      const a = list[ai];
      if (a?.type === 'NAVIGATE') a.destinationId = v || null;
    }, tr('Изменить экран')));
    if (!dest) target.classList.add('proto-missing');
    row.append(target);
    row.append(transitionEditor(action.transition, (fn, label) => update((list) => {
      const a = list[ai];
      if (a?.type === 'NAVIGATE') a.transition = fn(a.transition ?? { ...DEFAULT_TRANSITION });
    }, label)));
    const keep = h('input', { type: 'checkbox', checked: !!action.preserveScroll });
    keep.addEventListener('change', () => update((list) => {
      const a = list[ai];
      if (a?.type === 'NAVIGATE') a.preserveScroll = keep.checked;
    }, tr('Сохранять прокрутку')));
    row.append(h('label', { class: 'checkbox proto-check', title: tr('Экран откроется там, где его прокрутили в прошлый раз') }, keep, h('span', {}, tr('Сохранять позицию прокрутки'))));
  } else if (action.type === 'URL') {
    const url = h('input', { class: 'proto-input', type: 'url', value: action.url, placeholder: 'https://…', spellcheck: false, 'aria-label': tr('Адрес ссылки') });
    url.addEventListener('keydown', (e) => e.stopPropagation());
    url.addEventListener('change', () => update((list) => {
      const a = list[ai];
      if (a?.type === 'URL') a.url = url.value.trim();
    }, tr('Адрес ссылки')));
    const tab = h('input', { type: 'checkbox', checked: action.newTab });
    tab.addEventListener('change', () => update((list) => {
      const a = list[ai];
      if (a?.type === 'URL') a.newTab = tab.checked;
    }, tr('Где открывать ссылку')));
    row.append(url, h('label', { class: 'checkbox proto-check' }, tab, h('span', {}, tr('В новой вкладке'))));
  } else if (action.type === 'OPEN_OVERLAY' || action.type === 'SWAP_OVERLAY') {
    const own = screenOf(d, id);
    const options: [string, string][] = [['', tr('Выберите фрейм…')], ...screens(d, editor.pageId).filter((s) => s !== own).map((s): [string, string] => [s, d.get(s, 'name')])];
    const dest = action.destinationId && isScreen(d, action.destinationId) ? action.destinationId : '';
    const target = select(tr('Оверлей'), options, dest, (v) => update((list) => {
      const a = list[ai];
      if (a?.type === 'OPEN_OVERLAY' || a?.type === 'SWAP_OVERLAY') a.destinationId = v || null;
    }, tr('Изменить оверлей')));
    if (!dest) target.classList.add('proto-missing');
    row.append(target, overlayEditor(action.overlay, (fn, label) => update((list) => {
      const a = list[ai];
      if (a?.type === 'OPEN_OVERLAY' || a?.type === 'SWAP_OVERLAY') a.overlay = fn(a.overlay);
    }, label)));
    row.append(transitionEditor(action.transition, (fn, label) => update((list) => {
      const a = list[ai];
      if (a?.type === 'OPEN_OVERLAY' || a?.type === 'SWAP_OVERLAY') a.transition = fn(a.transition ?? { ...DEFAULT_TRANSITION });
    }, label), OVERLAY_TRANSITIONS));
  } else if (action.type === 'SCROLL_TO') {
    const screen = screenOf(d, id);
    const layers: [string, string][] = [['', tr('Выберите слой…')]];
    if (screen) {
      d.store.walk(screen, (n, depth) => {
        if (n === screen || layers.length > 400) return;
        layers.push([n, `${' '.repeat(Math.max(0, depth - 1))}${d.get(n, 'name')}`]);
      });
    }
    const dest = action.destinationId && d.store.isAlive(action.destinationId) ? action.destinationId : '';
    const target = select(tr('Слой'), layers, dest, (v) => update((list) => {
      const a = list[ai];
      if (a?.type === 'SCROLL_TO') a.destinationId = v || null;
    }, tr('Куда прокрутить')));
    if (!dest) target.classList.add('proto-missing');
    row.append(target, offsetFields(action.offset, (offset) => update((list) => {
      const a = list[ai];
      if (a?.type === 'SCROLL_TO') a.offset = offset;
    }, tr('Отступ прокрутки')), tr('Отступ от края')));
    row.append(transitionEditor(action.transition, (fn, label) => update((list) => {
      const a = list[ai];
      if (a?.type === 'SCROLL_TO') a.transition = fn(a.transition ?? { ...DEFAULT_TRANSITION });
    }, label), SCROLL_TRANSITIONS));
  } else if (action.type === 'CHANGE_TO') {
    const variants = variantChoices(d, id);
    if (variants.length === 0) {
    } else {
      const options: [string, string][] = [['', tr('Выберите вариант…')], ...variants.map((v): [string, string] => [v, d.get(v, 'name')])];
      const dest = action.destinationId && variants.includes(action.destinationId) ? action.destinationId : '';
      const target = select(tr('Вариант'), options, dest, (v) => update((list) => {
        const a = list[ai];
        if (a?.type === 'CHANGE_TO') a.destinationId = v || null;
      }, tr('Вариант')));
      if (!dest) target.classList.add('proto-missing');
      row.append(target);
      row.append(transitionEditor(action.transition, (fn, label) => update((list) => {
        const a = list[ai];
        if (a?.type === 'CHANGE_TO') a.transition = fn(a.transition ?? { ...DEFAULT_TRANSITION });
      }, label), CHANGE_TRANSITIONS));
    }
  } else if (action.type === 'SET_VARIABLE') {
    const vars = allVariables(d).filter((v) => d.store.isAlive(v));
    if (vars.length === 0) {
      row.append(h('p', { class: 'hint small' }, tr('Переменных пока нет')));
    } else {
      const options: [string, string][] = [['', tr('Выберите переменную…')], ...vars.map((v): [string, string] => [v, `${d.get(v, 'name')} · ${TYPE_LABELS[d.get(v, 'varType')]}`])];
      const current = action.variableId && vars.includes(action.variableId) ? action.variableId : '';
      const target = select(tr('Переменная'), options, current, (v) => update((list) => {
        const a = list[ai];
        if (a?.type === 'SET_VARIABLE') a.variableId = v || null;
      }, tr('Переменная')));
      if (!current) target.classList.add('proto-missing');
      row.append(target, expressionField(host, id, action.expression, current ? d.get(current, 'varType') : null, (text) => update((list) => {
        const a = list[ai];
        if (a?.type === 'SET_VARIABLE') a.expression = text;
      }, tr('Выражение')), tr('Новое значение, например {Счётчик} + 1')));
    }
  } else if (action.type === 'CONDITIONAL') {
    action.branches.forEach((branch, bi) => {
      const isElse = branch.condition === null;
      const label = isElse ? tr('Иначе') : bi === 0 ? tr('Если') : tr('Иначе если');
      const head = h('div', { class: 'proto-branch-head' }, h('span', { class: 'proto-branch-label' }, label));
      if (action.branches.length > 1 && !(bi === 0 && action.branches.length === 2 && action.branches[1]!.condition === null)) {
        const drop = h('button', { class: 'icon-button', type: 'button', title: tr('Убрать ветку'), 'aria-label': tr('Убрать ветку') }, icon('close', 12));
        drop.addEventListener('click', () => update((list) => {
          const a = list[ai];
          if (a?.type === 'CONDITIONAL') a.branches.splice(bi, 1);
        }, tr('Убрать ветку')));
        head.append(drop);
      }
      const box = h('div', { class: 'proto-branch' }, head);
      if (!isElse) {
        box.append(expressionField(host, id, branch.condition ?? '', 'BOOLEAN', (text) => update((list) => {
          const a = list[ai];
          if (a?.type === 'CONDITIONAL') a.branches[bi]!.condition = text;
        }, tr('Условие')), tr('Например {Счётчик} > 3 и не {Открыто}')));
      }
      const inner: ListEdit = (fn, l) => update((list) => {
        const a = list[ai];
        if (a?.type === 'CONDITIONAL') fn(a.branches[bi]!.actions);
      }, l);
      branch.actions.forEach((child, ci) => box.append(actionRow(host, id, child, ci, branch.actions.length + 1, inner, depth + 1)));
      const add = h('button', { class: 'text-button proto-add-action', type: 'button' }, icon('plus', 12), h('span', {}, tr('Действие')));
      add.addEventListener('click', () => inner((list) => list.push(PrototypeController.makeAction('NAVIGATE')), tr('Добавить действие')));
      box.append(add);
      row.append(box);
    });
    const hasElse = action.branches.some((b) => b.condition === null);
    const more = h('div', { class: 'proto-buttons' });
    const elseIf = h('button', { class: 'text-button', type: 'button' }, tr('+ Иначе если'));
    elseIf.addEventListener('click', () => update((list) => {
      const a = list[ai];
      if (a?.type !== 'CONDITIONAL') return;
      const at = a.branches.findIndex((b) => b.condition === null);
      a.branches.splice(at < 0 ? a.branches.length : at, 0, { condition: '', actions: [] });
    }, tr('Добавить ветку')));
    more.append(elseIf);
    if (!hasElse) {
      const addElse = h('button', { class: 'text-button', type: 'button' }, tr('+ Иначе'));
      addElse.addEventListener('click', () => update((list) => {
        const a = list[ai];
        if (a?.type === 'CONDITIONAL') a.branches.push({ condition: null, actions: [] });
      }, tr('Добавить «иначе»')));
      more.append(addElse);
    }
    row.append(more);
  } else if (action.type === 'CLOSE_OVERLAY') {
  } else {
  }
  return row;
}

const OVERLAY_TRANSITIONS: TransitionType[] = ['INSTANT', 'DISSOLVE', 'MOVE_IN', 'SLIDE_IN'];
const SCROLL_TRANSITIONS: TransitionType[] = ['INSTANT', 'SMART_ANIMATE'];
const CHANGE_TRANSITIONS: TransitionType[] = ['INSTANT', 'DISSOLVE', 'SMART_ANIMATE'];

const POSITIONS: [OverlayPosition, string][] = [
  ['CENTER', tr('По центру')],
  ['TOP_LEFT', tr('Сверху слева')],
  ['TOP_CENTER', tr('Сверху по центру')],
  ['TOP_RIGHT', tr('Сверху справа')],
  ['BOTTOM_LEFT', tr('Снизу слева')],
  ['BOTTOM_CENTER', tr('Снизу по центру')],
  ['BOTTOM_RIGHT', tr('Снизу справа')],
  ['MANUAL', tr('Вручную')],
  ['RELATIVE', tr('От слоя-триггера')],
];

/** Overlay placement, closing and dimming (FR-PRT-011). */
function overlayEditor(settings: OverlaySettings, update: (fn: (s: OverlaySettings) => OverlaySettings, label: string) => void): HTMLElement {
  const box = h('div', { class: 'proto-transition' });
  const position = select(tr('Положение'), POSITIONS, settings.position, (v) => update((s) => ({ ...s, position: v as OverlayPosition }), tr('Положение оверлея')));
  box.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Положение')), position));
  if (settings.position === 'MANUAL' || settings.position === 'RELATIVE') {
    box.append(offsetFields(settings.offset, (offset) => update((s) => ({ ...s, offset }), tr('Смещение оверлея')), settings.position === 'MANUAL' ? tr('От угла') : tr('От низа слоя')));
  }
  const outside = h('input', { type: 'checkbox', checked: settings.closeOnClickOutside });
  outside.addEventListener('change', () => update((s) => ({ ...s, closeOnClickOutside: outside.checked }), tr('Закрытие оверлея')));
  box.append(h('label', { class: 'checkbox proto-check' }, outside, h('span', {}, tr('Закрывать щелчком снаружи'))));
  const dim = h('input', { type: 'checkbox', checked: settings.background !== null });
  dim.addEventListener('change', () => update((s) => ({ ...s, background: dim.checked ? { r: 0, g: 0, b: 0, a: 0.4 } : null }), tr('Затемнение фона')));
  const row = h('div', { class: 'proto-line' }, h('label', { class: 'checkbox proto-check' }, dim, h('span', {}, tr('Затемнять фон'))));
  if (settings.background) {
    const bg = settings.background;
    const color = swatchButton(tr('Цвет затемнения'), bg, (c) => update((s) => ({ ...s, background: { r: c.r, g: c.g, b: c.b, a: s.background?.a ?? 0.4 } }), tr('Цвет затемнения')));
    const alpha = h('input', { class: 'proto-input proto-percent', type: 'number', min: 0, max: 100, step: 5, value: String(Math.round(bg.a * 100)), 'aria-label': tr('Непрозрачность затемнения, %') });
    alpha.addEventListener('keydown', (e) => e.stopPropagation());
    alpha.addEventListener('change', () => update((s) => ({ ...s, background: s.background ? { ...s.background, a: Math.max(0, Math.min(100, Number(alpha.value) || 0)) / 100 } : null }), tr('Непрозрачность затемнения')));
    row.append(h('span', { class: 'proto-dim' }, color, alpha, h('span', { class: 'field-label' }, '%')));
  }
  box.append(row);
  return box;
}

function offsetFields(offset: { x: number; y: number }, onChange: (v: { x: number; y: number }) => void, label: string): HTMLElement {
  const make = (axis: 'x' | 'y') => {
    const input = h('input', { class: 'proto-input', type: 'number', step: 1, value: String(offset[axis]), 'aria-label': `${label}: ${axis.toUpperCase()}` });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('change', () => onChange({ ...offset, [axis]: Number(input.value) || 0 }));
    return h('label', { class: 'proto-offset' }, h('span', { class: 'field-label' }, axis.toUpperCase()), input);
  };
  return h('div', { class: 'proto-line' }, h('span', { class: 'field-label' }, label), h('span', { class: 'proto-offsets' }, make('x'), make('y')));
}


type EasingChoice = 'LINEAR' | 'EASE_IN' | 'EASE_OUT' | 'EASE_IN_OUT' | 'EASE_IN_BACK' | 'EASE_OUT_BACK' | 'CUSTOM_BEZIER' | 'GENTLE' | 'QUICK' | 'BOUNCY' | 'SLOW' | 'SPRING';

const EASING_OPTIONS: [EasingChoice, string][] = [
  ['LINEAR', tr('Линейная')],
  ['EASE_IN', tr('Плавный старт')],
  ['EASE_OUT', tr('Плавное завершение')],
  ['EASE_IN_OUT', tr('Плавно в начале и в конце')],
  ['EASE_IN_BACK', tr('С откатом в начале')],
  ['EASE_OUT_BACK', tr('С перелётом в конце')],
  ['CUSTOM_BEZIER', tr('Своя кривая')],
  ['GENTLE', tr('Пружина: мягкая')],
  ['QUICK', tr('Пружина: быстрая')],
  ['BOUNCY', tr('Пружина: упругая')],
  ['SLOW', tr('Пружина: медленная')],
  ['SPRING', tr('Своя пружина')],
];

function easingChoice(e: Easing): EasingChoice {
  if (e.type !== 'SPRING') return e.type;
  for (const [name, params] of Object.entries(SPRING_PRESETS)) {
    if (params.mass === e.mass && params.stiffness === e.stiffness && params.damping === e.damping) return name as EasingChoice;
  }
  return 'SPRING';
}

function easingFor(choice: EasingChoice, previous: Easing): Easing {
  if (choice === 'CUSTOM_BEZIER') {
    const from = previous.type === 'CUSTOM_BEZIER' ? previous.bezier : previous.type === 'SPRING' ? BEZIER_PRESETS.EASE_OUT : BEZIER_PRESETS[previous.type];
    return { type: 'CUSTOM_BEZIER', bezier: [...from] };
  }
  if (choice === 'SPRING') return previous.type === 'SPRING' ? previous : { type: 'SPRING', ...SPRING_PRESETS.GENTLE };
  if (choice in SPRING_PRESETS) return { type: 'SPRING', ...SPRING_PRESETS[choice as keyof typeof SPRING_PRESETS] };
  return { type: choice as Exclude<EasingChoice, 'CUSTOM_BEZIER' | 'SPRING' | keyof typeof SPRING_PRESETS> };
}

const DIRECTIONS: [TransitionDirection, string, string][] = [
  ['LEFT', '←', tr('Влево: новый экран приходит справа')],
  ['RIGHT', '→', tr('Вправо: новый экран приходит слева')],
  ['TOP', '↑', tr('Вверх: новый экран приходит снизу')],
  ['BOTTOM', '↓', tr('Вниз: новый экран приходит сверху')],
];

/** Animation of a navigation: kind, direction, curve and duration (FR-PRT-020, 021). */
function transitionEditor(transition: Transition | null, update: (fn: (t: Transition) => Transition, label: string) => void, allowed: readonly TransitionType[] = Object.keys(TRANSITION_LABELS) as TransitionType[]): HTMLElement {
  const raw = transition ?? { ...DEFAULT_TRANSITION };
  // A kind this action does not offer shows as the nearest one it does.
  const t: Transition = allowed.includes(raw.type) ? raw : { ...raw, type: raw.type === 'INSTANT' ? 'INSTANT' : allowed.includes('SMART_ANIMATE') ? 'SMART_ANIMATE' : (allowed[1] ?? 'INSTANT') };
  const box = h('div', { class: 'proto-transition' });
  const labels: Partial<Record<TransitionType, string>> = allowed === SCROLL_TRANSITIONS ? { INSTANT: tr('Мгновенно'), SMART_ANIMATE: tr('Плавно') } : {};
  const kind = select(tr('Анимация'), allowed.map((k) => [k, labels[k] ?? TRANSITION_LABELS[k]]), t.type, (v) =>
    update((old) => ({ ...old, type: v as TransitionType, direction: DIRECTIONAL.has(v as TransitionType) ? (old.direction ?? 'LEFT') : undefined }), tr('Анимация перехода')),
  );
  box.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Анимация')), kind));
  if (t.type === 'INSTANT') return box;
  if (DIRECTIONAL.has(t.type)) {
    const dirs = h('div', { class: 'proto-dirs', role: 'radiogroup', 'aria-label': tr('Направление') });
    for (const [value, arrow, title] of DIRECTIONS) {
      const b = h('button', { class: `proto-dir${(t.direction ?? 'LEFT') === value ? ' active' : ''}`, type: 'button', title, 'aria-label': title, role: 'radio', 'aria-checked': String((t.direction ?? 'LEFT') === value) }, arrow);
      b.addEventListener('click', () => update((old) => ({ ...old, direction: value }), tr('Направление перехода')));
      dirs.append(b);
    }
    box.append(h('div', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Направление')), dirs));
  }
  const curve = select(tr('Кривая'), EASING_OPTIONS, easingChoice(t.easing), (v) => update((old) => ({ ...old, easing: easingFor(v as EasingChoice, old.easing) }), tr('Кривая анимации')));
  box.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Кривая')), curve));
  if (t.easing.type !== 'SPRING') {
    const ms = h('input', { class: 'proto-input proto-number', type: 'number', min: 1, max: 10000, step: 50, value: String(t.duration), 'aria-label': tr('Длительность, мс') });
    ms.addEventListener('keydown', (e) => e.stopPropagation());
    ms.addEventListener('change', () => update((old) => ({ ...old, duration: clampDuration(Number(ms.value)) }), tr('Длительность')));
    box.append(h('label', { class: 'proto-line' }, h('span', { class: 'field-label' }, tr('Длительность, мс')), ms));
  } else {
    // A spring runs as long as its physics says; mass, stiffness and damping shape it.
    const spring = t.easing;
    const grid = h('div', { class: 'proto-spring' });
    for (const [key, label, min, max, step] of [['mass', tr('Масса'), 0.1, 10, 0.1], ['stiffness', tr('Жёсткость'), 1, 1000, 10], ['damping', tr('Затухание'), 0, 100, 1]] as const) {
      const input = h('input', { class: 'proto-input', type: 'number', min, max, step, value: String(spring[key]), 'aria-label': label });
      input.addEventListener('keydown', (e) => e.stopPropagation());
      input.addEventListener('change', () => update((old) => (old.easing.type === 'SPRING' ? { ...old, easing: { ...old.easing, [key]: Math.max(min, Math.min(max, Number(input.value) || min)) } } : old), label));
      grid.append(h('label', { class: 'proto-spring-field' }, h('span', { class: 'field-label' }, label), input));
    }
    box.append(grid);
  }
  box.append(curveEditor(t.easing, (bezier) => update((old) => ({ ...old, easing: { type: 'CUSTOM_BEZIER', bezier } }), tr('Своя кривая'))));
  return box;
}

const TYPE_LABELS: Record<VariableType, string> = { COLOR: tr('цвет'), FLOAT: tr('число'), STRING: tr('строка'), BOOLEAN: tr('логическое') };

/**
 * Expression input (FR-PRT-040, 041): variables are typed by name in braces,
 * stored by id. Checked as you type: the result or the error, with the wrong
 * part highlighted.
 */
function expressionField(host: PrototypePanelHost, id: NodeId, stored: string, expected: VariableType | null, onCommit: (stored: string) => void, placeholder: string): HTMLElement {
  const d = host.editor.doc;
  const input = h('input', { class: 'proto-input proto-expr', type: 'text', value: toDisplay(d, stored), placeholder, spellcheck: false, 'aria-label': placeholder });
  const status = h('div', { class: 'proto-expr-status', 'aria-live': 'polite' });
  const check = () => {
    status.replaceChildren();
    status.className = 'proto-expr-status';
    const text = input.value;
    if (!text.trim()) return;
    const result = tryEvaluate(toStored(d, text), (ref) => readVariable(d, ref, id));
    if ('error' in result) {
      const { start, end, message } = result.error;
      status.classList.add('error');
      const shown = h('code', { class: 'proto-expr-code' }, text.slice(0, start), h('mark', {}, text.slice(start, Math.max(end, start + 1)) || ' '), text.slice(Math.max(end, start + 1)));
      status.append(h('span', {}, message), shown);
      return;
    }
    const v = result.value;
    const kind: VariableType = typeof v === 'number' ? 'FLOAT' : typeof v === 'string' ? 'STRING' : typeof v === 'boolean' ? 'BOOLEAN' : 'COLOR';
    const fits = !expected || expected === kind || (expected === 'STRING' && kind !== 'COLOR') || (expected === 'FLOAT' && kind === 'BOOLEAN');
    status.classList.add(fits ? 'ok' : 'error');
    status.append(h('span', {}, fits ? tr('Сейчас: {0}', formatValue(v)) : tr('Получится {0}, а нужно {1}', TYPE_LABELS[kind], TYPE_LABELS[expected!])));
  };
  input.addEventListener('input', check);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
  });
  input.addEventListener('change', () => onCommit(toStored(d, input.value.trim())));
  // Inserting a variable by name, at the caret.
  const vars = allVariables(d).filter((v) => d.store.isAlive(v));
  const insert = h('select', { class: 'field-select proto-insert', title: tr('Вставить переменную'), 'aria-label': tr('Вставить переменную') }, h('option', { value: '' }, '{ }'), ...vars.map((v) => h('option', { value: v }, d.get(v, 'name'))));
  insert.addEventListener('keydown', (e) => e.stopPropagation());
  insert.addEventListener('change', () => {
    if (!insert.value) return;
    const name = `{${d.get(insert.value, 'name')}}`;
    const at = input.selectionStart ?? input.value.length;
    input.value = input.value.slice(0, at) + name + input.value.slice(input.selectionEnd ?? at);
    insert.value = '';
    onCommit(toStored(d, input.value.trim()));
  });
  queueMicrotask(check);
  return h('div', { class: 'proto-expr-field' }, h('div', { class: 'proto-head' }, input, insert), status);
}

function select(title: string, options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = h('select', { class: 'field-select proto-select', title, 'aria-label': title });
  for (const [v, label] of options) el.append(h('option', { value: v }, label));
  el.value = value;
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

const KEY_NAMES: Record<string, string> = { ' ': tr('Пробел'), ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace' };

function keyName(key: string | undefined): string {
  if (!key) return tr('Нажмите клавишу');
  return KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}
