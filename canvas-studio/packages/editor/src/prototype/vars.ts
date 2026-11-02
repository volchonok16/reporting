// Variables in a running prototype (FR-PRT-040–042): reading values for
// expressions in the mode of the screen being shown, converting a result to
// the variable's type, and translating expressions between the names a person
// types (`{Счётчик}`) and the ids stored in the file (`{#id}`).

import { allVariables, modeFor, resolveVariable } from '#components';
import { isColorValue, type Color, type Document, type NodeId, type VariableLiteral } from '#core';
import { mapReferences, type ExprValue } from '#components';

/** "Color/Grey/500", "color.grey.500" and " color / grey / 500 " are the same name. */
export function normName(name: string): string {
  return name.trim().toLowerCase().replace(/\s*[/.]\s*/g, '/');
}

/** A variable by stored ref (`#id`) or by name. */
export function findVariable(doc: Document, ref: string): NodeId | null {
  if (ref.startsWith('#')) {
    const id = ref.slice(1);
    return doc.store.isAlive(id) && doc.type(id) === 'VARIABLE' ? id : null;
  }
  const wanted = normName(ref);
  return allVariables(doc).find((v) => doc.store.isAlive(v) && normName(doc.get(v, 'name')) === wanted) ?? null;
}

/** Value of a variable as seen from a layer (its mode comes from the layer's ancestors). */
export function readVariable(doc: Document, ref: string, context: NodeId | null): ExprValue | undefined {
  const id = findVariable(doc, ref);
  if (!id) return undefined;
  const v = resolveVariable(doc, id, context);
  return v === undefined ? undefined : (v as ExprValue);
}

/** Converts a computed value to what a variable of this type can hold; null when it cannot. */
export function coerce(doc: Document, variable: NodeId, value: ExprValue): VariableLiteral | null {
  switch (doc.get(variable, 'varType')) {
    case 'FLOAT':
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.replace(',', '.')))) return Number(value.replace(',', '.'));
      if (typeof value === 'boolean') return value ? 1 : 0;
      return null;
    case 'BOOLEAN':
      return typeof value === 'boolean' ? value : null;
    case 'STRING':
      if (typeof value === 'string') return value;
      if (typeof value === 'number') return String(Math.round(value * 1000) / 1000);
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      return null;
    case 'COLOR':
      return isColorValue(value) ? (value as Color) : null;
    default:
      return null;
  }
}

/**
 * Writes a variable's value in the mode in effect at `context` (the screen
 * being shown), replacing an alias with the literal, as a running prototype does.
 */
export function variableMode(doc: Document, variable: NodeId, context: NodeId | null): string | null {
  const collection = doc.parent(variable);
  if (!collection) return null;
  return modeFor(doc, context, collection) ?? doc.get(collection, 'modes')[0]?.id ?? null;
}

/** `{Name}` → `{#id}` for storing; names that match nothing stay as typed (and show as errors). */
export function toStored(doc: Document, text: string): string {
  return mapReferences(text, (ref) => {
    if (ref.startsWith('#')) return null;
    const id = findVariable(doc, ref);
    return id ? `#${id}` : null;
  });
}

/** `{#id}` → `{Name}` for showing; a deleted variable shows as `{?}`. */
export function toDisplay(doc: Document, text: string): string {
  return mapReferences(text, (ref) => {
    if (!ref.startsWith('#')) return null;
    const id = findVariable(doc, ref);
    return id ? doc.get(id, 'name') : '?';
  });
}
