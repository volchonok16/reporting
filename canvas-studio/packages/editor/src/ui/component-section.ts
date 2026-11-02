// Properties-panel sections for components (section 10): instance controls
// (variants, component properties, swap, overrides, detach), component and set
// settings, property bindings of layers inside a component.

import { tr } from '#core';
import {
  componentSetOf,
  countOverrides,
  instancePropertyValue,
  isTopLevelInstance,
  listComponents,
  owningComponent,
  parseVariantName,
  propertyDefs,
  propertyOwner,
  variantAxes,
  variantConflicts,
  wouldCreateCycle,
} from '#components';
import type { ComponentPropDef, NodeId, PropBinding } from '#core';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';
import { CheckboxField, SelectField, TextField, type Choice, type Field } from './fields.ts';
import { libraryOf } from '../library.ts';

export interface ComponentSectionHost {
  editor: Editor;
  section(title: string, ...actions: HTMLElement[]): HTMLElement;
  add<F extends Field>(field: F): F;
}

/** Names of properties as people know them, for the overrides list. */
const PROP_LABELS: Record<string, string> = {
  characters: tr('текст'),
  fills: tr('заливка'),
  strokes: tr('обводка'),
  strokeWeight: tr('толщина обводки'),
  effects: tr('эффекты'),
  opacity: tr('непрозрачность'),
  visible: tr('видимость'),
  locked: tr('закрепление'),
  name: tr('имя'),
  fontSize: tr('размер шрифта'),
  fontWeight: tr('начертание'),
  fontFamily: tr('шрифт'),
  lineHeight: tr('интерлиньяж'),
  letterSpacing: tr('межбуквенный интервал'),
  textAlignH: tr('выравнивание текста'),
  cornerRadius: tr('скругление'),
  mainComponent: tr('компонент'),
  propValues: tr('свойства'),
  width: tr('ширина'),
  height: tr('высота'),
  itemSpacing: tr('интервал'),
  paddingTop: tr('отступы'),
  paddingRight: tr('отступы'),
  paddingBottom: tr('отступы'),
  paddingLeft: tr('отступы'),
};

const BINDING_LABELS: Record<PropBinding, string> = {
  characters: tr('Текст'),
  visible: tr('Видимость'),
  mainComponent: tr('Заменить компонент в копии'),
};

const TYPE_LABELS: Record<ComponentPropDef['type'], string> = {
  TEXT: tr('Текст'),
  BOOLEAN: tr('Да/нет'),
  INSTANCE_SWAP: tr('Замена'),
};

function button(label: string, onclick: () => void, options: { icon?: string; title?: string; wide?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    { class: `text-button${options.wide ? ' wide' : ''}`, type: 'button', title: options.title ?? label, onclick },
    options.icon ? icon(options.icon, 14) : null,
    h('span', {}, label),
  );
}

function iconButton(name: string, title: string, onclick: () => void): HTMLButtonElement {
  return h('button', { class: 'icon-button', type: 'button', title, 'aria-label': title, onclick }, icon(name));
}

/** Component choices for swap selects, labelled "Набор / вариант" for variants. */
function componentChoices(editor: Editor, exclude?: (id: NodeId) => boolean): Choice<string>[] {
  const doc = editor.doc;
  return listComponents(doc)
    .filter(({ id }) => !exclude?.(id))
    .map(({ id, set }) => ({ value: id, label: set ? `${doc.get(set, 'name')} / ${doc.get(id, 'name')}` : doc.get(id, 'name') }));
}

export function buildComponentSection(host: ComponentSectionHost, id: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const type = doc.type(id);
  if (type === 'INSTANCE') {
    buildInstance(host, id);
    return;
  }
  if (type === 'COMPONENT') {
    buildComponent(host, id);
    buildPropertyList(host, propertyOwner(doc, id));
    return;
  }
  if (type === 'COMPONENT_SET') {
    buildSet(host, id);
    buildPropertyList(host, id);
    return;
  }
  if (editor.isInstanceLayer(id)) {
    buildInstanceLayer(host, id);
    return;
  }
  if (owningComponent(doc, id)) buildBindings(host, id);
}

function buildInstance(host: ComponentSectionHost, id: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const main = doc.get(id, 'mainComponent');
  const alive = !!main && doc.store.has(main) && doc.store.isAlive(main);
  const body = host.section(tr('Копия компонента'), iconButton('link', tr('Перейти к компоненту-оригиналу'), () => editor.goToMainComponent()));
  if (!alive) {
    body.append(h('p', { class: 'warning' }, tr('Компонент-оригинал удалён. Копия сохраняет последний вид; её можно заменить другим компонентом или отвязать.')));
  } else {
    const set = componentSetOf(doc, main);
    const label = set ? `${doc.get(set, 'name')}` : doc.get(main, 'name');
    body.append(h('button', { class: 'component-link', type: 'button', title: tr('Перейти к компоненту-оригиналу'), onclick: () => editor.goToMainComponent() }, icon('component', 14), h('span', {}, label)));
    const library = libraryOf(doc, main);
    if (library) body.append(h('p', { class: 'hint small' }, tr('Из библиотеки «{0}» — меняется в её файле', library.name)));
    // Variant properties (FR-CMP-020).
    if (set) {
      for (const axis of variantAxes(doc, set)) {
        const field = host.add(
          new SelectField(
            axis.name,
            axis.values.map((v) => ({ value: v, label: v })),
            () => parseVariantName(doc.get(doc.get(id, 'mainComponent')!, 'name'))[axis.name] ?? axis.values[0] ?? '',
            (value) => editor.switchVariant(id, axis.name, value),
            axis.name,
          ),
        );
        body.append(field.el);
      }
    }
    // Component properties (FR-CMP-010).
    for (const def of propertyDefs(doc, main)) {
      const read = () => instancePropertyValue(doc, id, def);
      if (def.type === 'TEXT') {
        body.append(host.add(new TextField(def.name, () => String(read() ?? ''), (v) => editor.setInstanceProperty(id, def.id, v), { label: def.name })).el);
      } else if (def.type === 'BOOLEAN') {
        body.append(host.add(new CheckboxField(def.name, () => read() === true, (v) => editor.setInstanceProperty(id, def.id, v))).el);
      } else {
        const choices = componentChoices(editor);
        body.append(host.add(new SelectField(def.name, choices, () => String(read() ?? ''), (v) => editor.setInstanceProperty(id, def.id, v), def.name)).el);
      }
    }
  }
  // Swap the component (FR-CMP-040).
  const parent = doc.parent(id);
  const swap = host.add(
    new SelectField(
      tr('Заменить компонент'),
      componentChoices(editor, (c) => parent !== null && wouldCreateCycle(doc, c, parent)),
      () => doc.get(id, 'mainComponent') ?? '',
      (v) => editor.swapInstance(id, v),
      tr('Заменить'),
    ),
  );
  body.append(swap.el);
  const overrides = countOverrides(doc, id);
  const actions = h('div', { class: 'button-row' });
  if (overrides > 0) actions.append(button(tr('Сбросить изменения копии ({0})', overrides), () => editor.resetSelectedOverrides(), { icon: 'reset' }));
  if (isTopLevelInstance(doc, id)) actions.append(button(tr('Отвязать'), () => editor.detachSelection(), { icon: 'detach', title: tr('Отвязать от компонента (⌥⌘B)') }));
  if (actions.childElementCount > 0) body.append(actions);
  if (overrides === 0) body.append(h('p', { class: 'hint' }, tr('Изменений нет: копия полностью повторяет компонент.')));
}

function buildInstanceLayer(host: ComponentSectionHost, id: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const keys = doc.get(id, 'overrides');
  const body = host.section(tr('Слой копии компонента'), iconButton('link', tr('Перейти к компоненту'), () => editor.goToMainComponent()));
  if (keys.length > 0) {
    const names = [...new Set(keys.map((k) => PROP_LABELS[k] ?? k))];
    body.append(h('p', { class: 'overrides-list' }, h('span', { class: 'override-dot' }), tr('Изменено в копии: {0}', names.join(', '))));
    body.append(button(tr('Сбросить изменения этого слоя'), () => editor.resetSelectedOverrides(), { icon: 'reset', wide: true }));
  } else {
  }
  body.append(h('p', { class: 'hint' }, tr('Положение, размер и порядок слоёв задаёт компонент.')));
}

function buildComponent(host: ComponentSectionHost, id: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const set = componentSetOf(doc, id);
  const body = host.section(set ? tr('Вариант') : tr('Компонент'), iconButton('instance', tr('Поставить копию компонента'), () => editor.placeInstance(id)));
  if (set) {
    for (const axis of variantAxes(doc, set)) {
      const field = host.add(
        new TextField(axis.name, () => parseVariantName(doc.get(id, 'name'))[axis.name] ?? '', (v) => editor.setVariantValue(id, axis.name, v), { label: axis.name }),
      );
      body.append(field.el);
    }
    body.append(h('div', { class: 'button-row' }, button(tr('Добавить вариант'), () => editor.addVariant(), { icon: 'plus' })));
  } else {
    body.append(host.add(new TextField(tr('Описание компонента'), () => doc.get(id, 'description'), (v) => editor.commit(tr('Описание'), (tx) => tx.set(id, 'description', v)), { label: tr('Описание') })).el);
    body.append(h('div', { class: 'button-row' }, button(tr('Поставить копию компонента'), () => editor.placeInstance(id), { icon: 'instance' })));
  }
  // The link to instances, so a change here does not come as a surprise (BUG-028).
  const instances = instancesOf(doc, set ? doc.children(set) : [id]);
  if (instances.length > 0) {
    const here = instances.filter((i) => doc.pageOf(i) === editor.pageId);
    body.append(
      h('p', { class: 'hint small' }, tr('Копий: {0}', instances.length)),
      h('div', { class: 'button-row' }, button(here.length > 0 ? tr('Выделить копии ({0})', here.length) : tr('Копии на других страницах'), () => here.length > 0 && editor.setSelection(here), { icon: 'instance' })),
    );
  }
}

/** Instances of any of `components` in the whole file. */
function instancesOf(doc: ComponentSectionHost['editor']['doc'], components: readonly NodeId[]): NodeId[] {
  const set = new Set(components);
  const out: NodeId[] = [];
  for (const page of doc.pages()) {
    doc.store.walk(page, (n) => {
      if (doc.type(n) === 'INSTANCE' && set.has(doc.get(n, 'mainComponent') ?? '')) out.push(n);
    });
  }
  return out;
}

function buildSet(host: ComponentSectionHost, set: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const body = host.section(tr('Набор вариантов'), iconButton('plus', tr('Добавить вариант'), () => editor.addVariant()));
  for (const axis of variantAxes(doc, set)) {
    const field = host.add(new TextField(tr('Свойство варианта'), () => axis.name, (v) => editor.renameVariantAxis(set, axis.name, v), { label: tr('Свойство') }));
    body.append(field.el, h('p', { class: 'hint values' }, tr('Значения: {0}', axis.values.join(', '))));
  }
  for (const problem of variantConflicts(doc, set)) body.append(h('p', { class: 'warning' }, problem));
  body.append(
    h('div', { class: 'button-row' }, button(tr('Добавить вариант'), () => editor.addVariant(), { icon: 'plus' }), button(tr('Новое свойство'), () => editor.addVariantAxis(set), { icon: 'plus' })),
    host.add(new TextField(tr('Описание набора'), () => doc.get(set, 'description'), (v) => editor.commit(tr('Описание'), (tx) => tx.set(set, 'description', v)), { label: tr('Описание') })).el,
  );
}

function buildPropertyList(host: ComponentSectionHost, owner: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const defs = doc.get(owner, 'componentProps');
  const body = host.section(tr('Свойства компонента'));
  if (defs.length === 0) {
    body.append(h('p', { class: 'hint small' }, tr('Свойств пока нет')));
    return;
  }
  for (const def of defs) {
    const name = host.add(new TextField(tr('Имя свойства'), () => def.name, (v) => editor.renameComponentProperty(owner, def.id, v)));
    body.append(
      h(
        'div',
        { class: 'prop-row' },
        name.el,
        h('span', { class: 'prop-type' }, TYPE_LABELS[def.type]),
        iconButton('minus', tr('Удалить свойство'), () => editor.removeComponentProperty(owner, def.id)),
      ),
    );
  }
}

function buildBindings(host: ComponentSectionHost, layer: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const component = owningComponent(doc, layer)!;
  const defs = propertyDefs(doc, component);
  const refs = doc.get(layer, 'propRefs') ?? {};
  const body = host.section(tr('Свойство компонента'));
  for (const [binding, propId] of Object.entries(refs) as [PropBinding, string][]) {
    const def = defs.find((d) => d.id === propId);
    body.append(
      h(
        'div',
        { class: 'prop-row' },
        h('span', { class: 'binding' }, `${BINDING_LABELS[binding]} → «${def?.name ?? tr('удалено')}»`),
        iconButton('detach', tr('Отвязать от свойства'), () => editor.unbindComponentProperty(layer, binding)),
      ),
    );
  }
  const actions = h('div', { class: 'button-row wrap' });
  if (doc.type(layer) === 'TEXT' && !refs.characters) actions.append(button(tr('Текст как свойство'), () => editor.addComponentProperty(layer, 'TEXT'), { icon: 'plus' }));
  if (!refs.visible) actions.append(button(tr('Видимость как свойство'), () => editor.addComponentProperty(layer, 'BOOLEAN'), { icon: 'plus' }));
  if (doc.type(layer) === 'INSTANCE' && !refs.mainComponent) actions.append(button(tr('Замена как свойство'), () => editor.addComponentProperty(layer, 'INSTANCE_SWAP'), { icon: 'plus' }));
  if (actions.childElementCount > 0) body.append(actions);
}
