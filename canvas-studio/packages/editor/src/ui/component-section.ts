// Properties-panel sections for components (section 10): instance controls
// (variants, component properties, swap, overrides, detach), component and set
// settings, property bindings of layers inside a component.

import { tr } from '#core';
import {
  componentSetOf,
  countOverrides,
  exposedIn,
  instancePropertyValue,
  isTopLevelInstance,
  listComponents,
  nestedInstancesOf,
  owningComponent,
  parseVariantName,
  preferredFor,
  propertyDefs,
  propertyOwner,
  variantAxes,
  variantConflicts,
  wouldCreateCycle,
} from '#components';
import type { ComponentPropDef, NodeId, PropBinding } from '#core';
import type { Editor } from '../editor.ts';
import { h, icon } from './dom.ts';
import { CHOICE_SEPARATOR, CheckboxField, SelectField, TextField, type Choice, type Field } from './fields.ts';
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

/** Component choices for swap selects, labelled "Набор / вариант" for variants; `preferred` first, then a line, then the rest. */
function componentChoices(editor: Editor, exclude?: (id: NodeId) => boolean, preferred: readonly NodeId[] = []): Choice<string>[] {
  const doc = editor.doc;
  const all = listComponents(doc)
    .filter(({ id }) => !exclude?.(id))
    .map(({ id, set }) => ({ value: id, label: set ? `${doc.get(set, 'name')} / ${doc.get(id, 'name')}` : doc.get(id, 'name') }));
  const first = preferred.flatMap((id) => all.filter((c) => c.value === id).map((c) => ({ ...c, label: `★ ${c.label}` })));
  if (first.length === 0) return all;
  return [...first, CHOICE_SEPARATOR, ...all.filter((c) => !preferred.includes(c.value))];
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
    buildNestedList(host, id);
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
  if (owningComponent(doc, id)) {
    buildBindings(host, id);
    if (doc.type(id) === 'FRAME') buildSlotToggle(host, id);
  }
}

/** «Слот» of a frame in a component (step 6, Figma's slots): instances may put layers of their own there. */
function buildSlotToggle(host: ComponentSectionHost, frame: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const body = host.section(tr('Слот'));
  body.append(host.add(new CheckboxField(tr('Слот: в копиях сюда можно класть свои слои'), () => doc.get(frame, 'slot'), (v) => editor.setSlot(frame, v))).el);
  if (doc.get(frame, 'slot')) body.append(h('p', { class: 'hint small' }, tr('Копии показывают это содержимое, пока в их слот ничего не положили. С адаптивной раскладкой вложенное выстраивается само.')));
}

function buildInstance(host: ComponentSectionHost, id: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const main = doc.get(id, 'mainComponent');
  const alive = !!main && doc.store.has(main) && doc.store.isAlive(main);
  const body = host.section(tr('Копия компонента'), iconButton('link', tr('Перейти к компоненту-оригиналу'), () => editor.goToMainComponent()));
  if (!alive) {
    body.append(h('p', { class: 'warning' }, tr('Компонент-оригинал удалён. Копия сохраняет последний вид; компонент можно восстановить, копию — заменить другим компонентом или отвязать.')));
    if (isTopLevelInstance(doc, id) && !doc.readOnly) body.append(h('div', { class: 'button-row' }, button(tr('Восстановить компонент'), () => editor.restoreMainComponent(), { icon: 'reset', title: tr('Вернуть главный компонент: все его копии снова связаны с ним') })));
  } else {
    const set = componentSetOf(doc, main);
    const label = set ? `${doc.get(set, 'name')}` : doc.get(main, 'name');
    body.append(h('button', { class: 'component-link', type: 'button', title: tr('Перейти к компоненту-оригиналу'), onclick: () => editor.goToMainComponent() }, icon('component', 14), h('span', {}, label)));
    const library = libraryOf(doc, main);
    if (library) body.append(h('p', { class: 'hint small' }, tr('Из библиотеки «{0}» — меняется в её файле', library.name)));
    instanceControls(host, body, id);
    // Properties of nested instances exposed in the component (step 6, Figma's Expose nested instances).
    for (const nested of exposedIn(doc, id)) {
      const block = h('div', { class: 'exposed' }, h('div', { class: 'exposed-title' }, icon('instance', 12), h('span', {}, doc.get(nested, 'name'))));
      instanceControls(host, block, nested);
      if (block.childElementCount > 1) body.append(block);
    }
  }
  // Swap the component (FR-CMP-040).
  const parent = doc.parent(id);
  const swap = host.add(
    new SelectField(
      tr('Заменить компонент'),
      componentChoices(editor, (c) => parent !== null && wouldCreateCycle(doc, c, parent), preferredFor(doc, id)),
      () => doc.get(id, 'mainComponent') ?? '',
      (v) => editor.swapInstance(id, v),
      tr('Заменить'),
    ),
  );
  body.append(swap.el);
  const overrides = countOverrides(doc, id);
  const actions = h('div', { class: 'button-row' });
  if (overrides > 0 && isTopLevelInstance(doc, id) && !editor.pushBlocker(id)) body.append(h('div', { class: 'button-row' }, button(tr('Перенести в компонент'), () => editor.pushOverridesToMain(), { icon: 'component', title: tr('Перенести изменения копии в главный компонент: другие копии их получат') })));
  if (overrides > 0) actions.append(button(tr('Сбросить'), () => editor.resetSelectedOverrides(), { icon: 'reset', title: tr('Сбросить изменения копии ({0})', overrides) }));
  if (isTopLevelInstance(doc, id)) actions.append(button(tr('Отвязать'), () => editor.detachSelection(), { icon: 'detach', title: tr('Отвязать от компонента (⌥⌘B)') }));
  if (actions.childElementCount > 0) body.append(actions);
  if (overrides === 0) body.append(h('p', { class: 'hint' }, tr('Изменений нет: копия полностью повторяет компонент.')));
}

/** Variants and component properties of an instance, as fields into `body`. */
function instanceControls(host: ComponentSectionHost, body: HTMLElement, id: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const main = doc.get(id, 'mainComponent');
  if (!main || !doc.store.isAlive(main)) return;
  const set = componentSetOf(doc, main);
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
      const choices = componentChoices(editor, (c) => wouldCreateCycle(doc, c, id), (def.preferred ?? []).filter((c) => doc.store.isAlive(c)));
      body.append(host.add(new SelectField(def.name, choices, () => String(read() ?? ''), (v) => editor.setInstanceProperty(id, def.id, v), def.name)).el);
    }
  }
}

function buildInstanceLayer(host: ComponentSectionHost, id: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const keys = doc.get(id, 'overrides');
  const body = host.section(tr('Слой копии компонента'), iconButton('link', tr('Перейти к компоненту'), () => editor.goToMainComponent()));
  // A slot (step 6): layers of this instance's own go here.
  if (doc.get(id, 'slot')) {
    if (doc.get(id, 'slotFilled')) {
      body.append(h('p', { class: 'hint' }, tr('Слот: здесь свои слои этой копии.')));
      body.append(button(tr('Вернуть содержимое компонента'), () => editor.resetSelectedOverrides(), { icon: 'reset', wide: true, title: tr('Убрать свои слои из слота и показать то, что в нём лежит в компоненте') }));
    } else {
      body.append(h('p', { class: 'hint' }, tr('Перетащите или вставьте слои в слот. Они будут только у этой копии.')));
    }
  }
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
    if (def.type === 'INSTANCE_SWAP') body.append(buildPreferred(host, owner, def));
  }
}

/**
 * Nested instances of a component (step 6, Figma's Expose nested instances): ticked ones show their variants and
 * properties in the panel of this component's instances, without going inside.
 */
function buildNestedList(host: ComponentSectionHost, component: NodeId): void {
  const { editor } = host;
  const doc = editor.doc;
  const nested = nestedInstancesOf(doc, component).filter((n) => {
    const main = doc.get(n, 'mainComponent');
    return !!main && doc.store.isAlive(main) && (componentSetOf(doc, main) !== null || propertyDefs(doc, main).length > 0);
  });
  if (nested.length === 0) return;
  const body = host.section(tr('Вложенные копии'));
  body.append(h('p', { class: 'hint small' }, tr('Отмеченные показывают свои варианты и свойства в панели копий этого компонента')));
  for (const n of nested) {
    body.append(host.add(new CheckboxField(tr('{0}: показывать в копиях', doc.get(n, 'name')), () => doc.get(n, 'exposedInstance'), (v) => editor.setExposedInstance(n, v))).el);
  }
}

/** Preferred components of a swap property (step 6): offered first when an instance swaps that layer. */
function buildPreferred(host: ComponentSectionHost, owner: NodeId, def: ComponentPropDef): HTMLElement {
  const { editor } = host;
  const doc = editor.doc;
  const current = (def.preferred ?? []).filter((c) => doc.store.isAlive(c));
  const wrap = h('div', { class: 'preferred' }, h('span', { class: 'field-label' }, tr('Предпочтительные')));
  const name = (c: NodeId) => {
    const set = componentSetOf(doc, c);
    return set ? `${doc.get(set, 'name')} / ${doc.get(c, 'name')}` : doc.get(c, 'name');
  };
  const chips = h('div', { class: 'chips' });
  for (const c of current) {
    chips.append(h('span', { class: 'chip' }, h('span', {}, name(c)), h('button', { class: 'chip-remove', type: 'button', title: tr('Убрать «{0}» из предпочтительных', name(c)), 'aria-label': tr('Убрать «{0}» из предпочтительных', name(c)), disabled: doc.readOnly, onclick: () => editor.setPreferredValues(owner, def.id, current.filter((x) => x !== c)) }, icon('close', 10))));
  }
  if (current.length === 0) chips.append(h('span', { class: 'hint small' }, tr('Не выбраны — в копиях предлагаются все компоненты')));
  wrap.append(chips);
  // Not the component itself (or its variants): a component never goes inside itself.
  const own = new Set(doc.type(owner) === 'COMPONENT_SET' ? [owner, ...doc.children(owner)] : [owner]);
  const offer = componentChoices(editor, (c) => own.has(c) || current.includes(c) || wouldCreateCycle(doc, c, owner));
  if (offer.length > 0 && !doc.readOnly) {
    wrap.append(host.add(new SelectField(tr('Добавить предпочтительный'), [{ value: '', label: tr('+ Добавить…') }, ...offer], () => '', (v) => v && editor.setPreferredValues(owner, def.id, [...current, v]))).el);
  }
  return wrap;
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
