// Variants (section 10.3): a component set groups components whose names
// encode property values: "Size=M, State=Hover".

import { tr } from '#core';
import type { Document, NodeId, Transaction } from '#core';
import { ensureLayerKeys } from './sync.ts';

export type VariantValues = Record<string, string>;

/** Parses "Size=M, State=Hover". Parts without "=" are ignored. */
export function parseVariantName(name: string): VariantValues {
  const out: VariantValues = {};
  for (const part of name.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function formatVariantName(values: VariantValues, axes: readonly string[]): string {
  return axes.filter((a) => a in values).map((a) => `${a}=${values[a]}`).join(', ');
}

export interface VariantAxis {
  name: string;
  values: string[];
}

/** Axes of a set in first-seen order, with their values in first-seen order. */
export function variantAxes(doc: Document, set: NodeId): VariantAxis[] {
  const axes = new Map<string, string[]>();
  for (const variant of doc.children(set)) {
    for (const [k, v] of Object.entries(parseVariantName(doc.get(variant, 'name')))) {
      const list = axes.get(k) ?? [];
      if (!list.includes(v)) list.push(v);
      axes.set(k, list);
    }
  }
  return [...axes].map(([name, values]) => ({ name, values }));
}

/** Problems that would make variant switching ambiguous (FR-CMP-022). */
export function variantConflicts(doc: Document, set: NodeId): string[] {
  const axes = variantAxes(doc, set).map((a) => a.name);
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const variant of doc.children(set)) {
    const values = parseVariantName(doc.get(variant, 'name'));
    const missing = axes.filter((a) => !(a in values));
    if (missing.length > 0) problems.push(tr('«{0}»: нет значения для {1}', doc.get(variant, 'name'), missing.map((m) => `«${m}»`).join(', ')));
    const key = formatVariantName(values, axes);
    if (seen.has(key)) problems.push(tr('Два варианта с одинаковыми значениями: {0}', key));
    seen.set(key, variant);
  }
  return problems;
}

/**
 * The variant to switch to when `axis` changes to `value`: exact match of all
 * other values first, otherwise the variant matching most of them.
 */
export function findVariant(doc: Document, set: NodeId, current: NodeId, axis: string, value: string): NodeId | null {
  const wanted = { ...parseVariantName(doc.get(current, 'name')), [axis]: value };
  let best: NodeId | null = null;
  let bestScore = -1;
  for (const variant of doc.children(set)) {
    const values = parseVariantName(doc.get(variant, 'name'));
    if (values[axis] !== value) continue;
    const score = Object.keys(wanted).filter((k) => values[k] === wanted[k]).length;
    if (score > bestScore) {
      best = variant;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Combines components into a set (FR-CMP-020). Names without "=" get
 * "Свойство 1=<name>". The set lays variants out with auto layout so new ones wrap neatly.
 */
export function combineAsVariants(doc: Document, tx: Transaction, components: readonly NodeId[], setName?: string): NodeId {
  if (components.length === 0) throw new Error(tr('Нет компонентов'));
  const parent = doc.parent(components[0]!);
  if (!parent || components.some((c) => doc.type(c) !== 'COMPONENT' || doc.parent(c) !== parent)) {
    throw new Error(tr('Объединять можно компоненты с общим родителем'));
  }
  const xs = components.map((c) => doc.get(c, 'x'));
  const ys = components.map((c) => doc.get(c, 'y'));
  const baseName = setName ?? doc.get(components[0]!, 'name').split(/[=/,]/)[0]!.trim() ?? tr('Компонент');
  const totalWidth = components.reduce((s, c) => s + doc.get(c, 'width'), 0) + 20 * (components.length + 1);
  const set = tx.create(
    'COMPONENT_SET',
    parent,
    {
      name: baseName || tr('Компонент'),
      x: Math.min(...xs) - 20,
      y: Math.min(...ys) - 20,
      width: Math.min(totalWidth, 1600),
      layoutMode: 'HORIZONTAL',
      layoutWrap: true,
      sizingH: { mode: 'FIXED' },
      sizingV: { mode: 'HUG' },
      itemSpacing: 20,
      counterAxisSpacing: 20,
      paddingTop: 20,
      paddingRight: 20,
      paddingBottom: 20,
      paddingLeft: 20,
      clipsContent: false,
    },
    { after: components[components.length - 1]! },
  );
  const ordered = [...components].sort((a, b) => doc.get(a, 'x') - doc.get(b, 'x') || doc.get(a, 'y') - doc.get(b, 'y'));
  ordered.forEach((c, i) => {
    tx.move(c, set, { at: 'end' });
    const name = doc.get(c, 'name');
    if (!name.includes('=')) tx.set(c, 'name', tr('Свойство 1={0}', i === 0 ? tr('По умолчанию') : tr('Вариант {0}', i + 1)));
    ensureLayerKeys(doc, tx, c);
  });
  return set;
}

/**
 * Adds a variant by duplicating `variant` (FR-CMP-020). The copy shares layer
 * keys with the original, so instances keep their overrides when switching.
 */
export function addVariant(doc: Document, tx: Transaction, variant: NodeId, duplicate: (tx: Transaction, id: NodeId) => NodeId): NodeId {
  const set = doc.parent(variant);
  if (!set || doc.type(set) !== 'COMPONENT_SET') throw new Error(tr('Компонент не входит в набор вариантов'));
  ensureLayerKeys(doc, tx, variant);
  const copy = duplicate(tx, variant);
  const axes = variantAxes(doc, set);
  const values = parseVariantName(doc.get(variant, 'name'));
  const first = axes[0]?.name ?? tr('Свойство 1');
  let n = (axes[0]?.values.length ?? 1) + 1;
  const taken = new Set(doc.children(set).map((c) => doc.get(c, 'name')));
  let name = formatVariantName({ ...values, [first]: tr('Вариант {0}', n) }, axes.length ? axes.map((a) => a.name) : [first]);
  while (taken.has(name)) name = formatVariantName({ ...values, [first]: tr('Вариант {0}', ++n) }, axes.length ? axes.map((a) => a.name) : [first]);
  tx.set(copy, 'name', name);
  return copy;
}

/** Renames a variant property across all variants of a set. */
export function renameAxis(doc: Document, tx: Transaction, set: NodeId, from: string, to: string): void {
  const axes = variantAxes(doc, set).map((a) => (a.name === from ? to : a.name));
  for (const variant of doc.children(set)) {
    const values = parseVariantName(doc.get(variant, 'name'));
    if (!(from in values)) continue;
    const next: VariantValues = {};
    for (const [k, v] of Object.entries(values)) next[k === from ? to : k] = v;
    tx.set(variant, 'name', formatVariantName(next, axes));
  }
}

/** Sets one value in a variant's name. */
export function setVariantValue(doc: Document, tx: Transaction, variant: NodeId, axis: string, value: string): void {
  const set = doc.parent(variant);
  const axes = set ? variantAxes(doc, set).map((a) => a.name) : [axis];
  if (!axes.includes(axis)) axes.push(axis);
  tx.set(variant, 'name', formatVariantName({ ...parseVariantName(doc.get(variant, 'name')), [axis]: value }, axes));
}

/** Adds a new variant property to every variant with a default value. */
export function addAxis(doc: Document, tx: Transaction, set: NodeId, name: string, value: string): void {
  const axes = [...variantAxes(doc, set).map((a) => a.name), name];
  for (const variant of doc.children(set)) {
    tx.set(variant, 'name', formatVariantName({ ...parseVariantName(doc.get(variant, 'name')), [name]: value }, axes));
  }
}
