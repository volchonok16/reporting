// Variables (section 11, FR-VAR): typed values per mode, kept as
// VARIABLE_COLLECTION nodes (with their modes) holding VARIABLE nodes under the
// document root.
//
// Like styles, a bound layer keeps the resolved value in its ordinary props and
// the binding in `boundVariables` (field → variable id). Renderer, layout and
// export read plain values. The pipeline keeps the copies right:
//  - user phase (before overrides): a bound value edited directly unbinds that
//    field (the edited value stays), as typing over a token in Figma;
//  - resolution phase (after instance sync): every node whose result may have
//    changed gets the value of its variables in its mode — nodes bound in this
//    edit, moved or created nodes, subtrees whose mode changed, and every user of
//    a variable whose value (directly or through aliases) changed. A deleted
//    variable unbinds its fields, keeping the last value.
// Modes are chosen per collection on a page, frame, group or instance and
// inherited by children (FR-VAR-012); an alias resolves the target variable in
// the node's mode of the target's own collection.
//
// An extended collection (FR-VAR-013) is chosen like a mode: a frame that picks
// "Бренд Б · Тёмная" sees every variable of the parent collection in the dark
// mode, with the extension's own values where it has them.
// An expression (FR-VAR-003) is computed in the same context as an alias.

import { tr } from '#core';
import { evaluate, ExprError, formatValue, parseExpr, type Expr, type ExprValue } from './expr.ts';
import {
  cloneValue,
  isAlias,
  isGradient,
  isColorValue,
  isExpression,
  valueRefs,
  valueEquals,
  type Color,
  type Document,
  type Effect,
  type NodeId,
  type NodeType,
  type Paint,
  type PropKey,
  type Transaction,
  type VariableLiteral,
  type VariableScope,
  type VariableType,
  type VariableValue,
} from '#core';

// ---------- fields that can be bound ----------

export interface FieldSpec {
  /** Field name in `boundVariables`. */
  field: string;
  type: VariableType;
  /** The prop that stores the value. */
  prop: PropKey;
  label: string;
  /** Scope this field belongs to (for filtering the variable list). */
  scope(nodeType: NodeType): VariableScope | null;
  read(doc: Document, id: NodeId): VariableLiteral | undefined;
  /** Writes the value; returns false when the field does not apply (e.g. a gradient paint). */
  write(doc: Document, tx: Transaction, id: NodeId, value: VariableLiteral): boolean;
}

const num = (field: string, prop: PropKey, label: string, scope: VariableScope | null, opts: { scale?: number; min?: number } = {}): FieldSpec => ({
  field,
  type: 'FLOAT',
  prop,
  label,
  scope: () => scope,
  read: (doc, id) => {
    const v = doc.get(id, prop);
    return typeof v === 'number' ? v * (opts.scale ?? 1) : undefined;
  },
  write: (doc, tx, id, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const v = Math.max(opts.min ?? -Infinity, value / (opts.scale ?? 1));
    if (doc.get(id, prop) !== v) tx.set(id, prop, v as never);
    return true;
  },
});

const FIXED_FIELDS: FieldSpec[] = [
  num('width', 'width', tr('Ширина'), 'WIDTH_HEIGHT', { min: 0 }),
  num('height', 'height', tr('Высота'), 'WIDTH_HEIGHT', { min: 0 }),
  num('cornerRadius', 'cornerRadius', tr('Скругление'), 'CORNER_RADIUS', { min: 0 }),
  num('itemSpacing', 'itemSpacing', tr('Промежуток'), 'GAP'),
  num('counterAxisSpacing', 'counterAxisSpacing', tr('Промежуток между рядами'), 'GAP'),
  num('paddingTop', 'paddingTop', tr('Отступ сверху'), 'GAP', { min: 0 }),
  num('paddingRight', 'paddingRight', tr('Отступ справа'), 'GAP', { min: 0 }),
  num('paddingBottom', 'paddingBottom', tr('Отступ снизу'), 'GAP', { min: 0 }),
  num('paddingLeft', 'paddingLeft', tr('Отступ слева'), 'GAP', { min: 0 }),
  num('strokeWeight', 'strokeWeight', tr('Толщина обводки'), 'STROKE_WIDTH', { min: 0 }),
  // Opacity variables are percentages, as in Figma.
  { ...num('opacity', 'opacity', tr('Непрозрачность'), 'OPACITY', { scale: 100, min: 0 }), write: (doc, tx, id, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const v = Math.max(0, Math.min(1, value / 100));
    if (doc.get(id, 'opacity') !== v) tx.set(id, 'opacity', v);
    return true;
  } },
  num('fontSize', 'fontSize', tr('Размер шрифта'), 'FONT_SIZE', { min: 1 }),
  num('fontWeight', 'fontWeight', tr('Начертание'), 'FONT_WEIGHT', { min: 1 }),
  num('paragraphSpacing', 'paragraphSpacing', tr('Между абзацами'), 'PARAGRAPH_SPACING', { min: 0 }),
  num('paragraphIndent', 'paragraphIndent', tr('Отступ абзаца'), 'PARAGRAPH_SPACING', { min: 0 }),
  {
    field: 'lineHeight',
    type: 'FLOAT',
    prop: 'lineHeight',
    label: tr('Межстрочный интервал'),
    scope: () => 'LINE_HEIGHT',
    read: (doc, id) => {
      const lh = doc.get(id, 'lineHeight');
      return lh.unit === 'PX' ? lh.value : undefined;
    },
    write: (doc, tx, id, value) => {
      if (typeof value !== 'number') return false;
      const next = { unit: 'PX' as const, value: Math.max(0, value) };
      if (!valueEquals(doc.get(id, 'lineHeight'), next)) tx.set(id, 'lineHeight', next);
      return true;
    },
  },
  {
    field: 'letterSpacing',
    type: 'FLOAT',
    prop: 'letterSpacing',
    label: tr('Межбуквенный интервал'),
    scope: () => 'LETTER_SPACING',
    read: (doc, id) => doc.get(id, 'letterSpacing').value,
    write: (doc, tx, id, value) => {
      if (typeof value !== 'number') return false;
      const cur = doc.get(id, 'letterSpacing');
      if (cur.value !== value) tx.set(id, 'letterSpacing', { unit: cur.unit, value });
      return true;
    },
  },
  {
    field: 'visible',
    type: 'BOOLEAN',
    prop: 'visible',
    label: tr('Видимость'),
    scope: () => null,
    read: (doc, id) => doc.get(id, 'visible'),
    write: (doc, tx, id, value) => {
      if (typeof value !== 'boolean') return false;
      if (doc.get(id, 'visible') !== value) tx.set(id, 'visible', value);
      return true;
    },
  },
  {
    field: 'characters',
    type: 'STRING',
    prop: 'characters',
    label: tr('Текст'),
    scope: () => 'TEXT_CONTENT',
    read: (doc, id) => (doc.type(id) === 'TEXT' ? doc.get(id, 'characters') : undefined),
    write: (doc, tx, id, value) => {
      if (typeof value !== 'string' || doc.type(id) !== 'TEXT') return false;
      if (doc.get(id, 'characters') !== value) {
        tx.set(id, 'characters', value);
        // Character styles refer to offsets of the old text.
        if (doc.get(id, 'textRuns').length > 0) tx.set(id, 'textRuns', []);
      }
      return true;
    },
  },
  {
    field: 'fontFamily',
    type: 'STRING',
    prop: 'fontFamily',
    label: tr('Шрифт'),
    scope: () => 'FONT_FAMILY',
    read: (doc, id) => doc.get(id, 'fontFamily'),
    write: (doc, tx, id, value) => {
      if (typeof value !== 'string' || !value) return false;
      if (doc.get(id, 'fontFamily') !== value) tx.set(id, 'fontFamily', value);
      return true;
    },
  },
];

function paintField(prop: 'fills' | 'strokes', index: number): FieldSpec {
  return {
    field: `${prop}/${index}`,
    type: 'COLOR',
    prop,
    label: prop === 'fills' ? tr('Заливка') : tr('Обводка'),
    scope: (t) => (prop === 'strokes' ? 'STROKE_COLOR' : t === 'TEXT' ? 'TEXT_FILL' : t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE' ? 'FRAME_FILL' : 'SHAPE_FILL'),
    read: (doc, id) => {
      const p = doc.get(id, prop)[index];
      return p && p.type === 'SOLID' ? p.color : undefined;
    },
    write: (doc, tx, id, value) => {
      if (!isColorValue(value)) return false;
      const list = doc.get(id, prop);
      const p = list[index];
      if (!p) return false;
      const next: Paint = p.type === 'SOLID' ? { ...p, color: value } : { type: 'SOLID', color: value, opacity: p.opacity, visible: p.visible };
      if (!valueEquals(p, next)) {
        const copy = [...list];
        copy[index] = next;
        tx.set(id, prop, copy);
      }
      return true;
    },
  };
}

/** A colour stop of a gradient fill or stroke: "fills/0/stops/1" (variables in gradients, as in Figma). */
function stopField(prop: 'fills' | 'strokes', index: number, stop: number): FieldSpec {
  return {
    field: `${prop}/${index}/stops/${stop}`,
    type: 'COLOR',
    prop,
    label: tr('Точка градиента'),
    scope: (t) => (prop === 'strokes' ? 'STROKE_COLOR' : t === 'TEXT' ? 'TEXT_FILL' : t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE' ? 'FRAME_FILL' : 'SHAPE_FILL'),
    read: (doc, id) => {
      const p = doc.get(id, prop)[index];
      return p && isGradient(p) ? p.stops[stop]?.color : undefined;
    },
    write: (doc, tx, id, value) => {
      if (!isColorValue(value)) return false;
      const list = doc.get(id, prop);
      const p = list[index];
      if (!p || !isGradient(p) || !p.stops[stop]) return false;
      if (!valueEquals(p.stops[stop]!.color, value)) {
        const stops = [...p.stops];
        stops[stop] = { ...stops[stop]!, color: value };
        const copy = [...list];
        copy[index] = { ...p, stops };
        tx.set(id, prop, copy);
      }
      return true;
    },
  };
}

function effectField(index: number): FieldSpec {
  return {
    field: `effects/${index}`,
    type: 'COLOR',
    prop: 'effects',
    label: tr('Цвет тени'),
    scope: () => 'EFFECT_COLOR',
    read: (doc, id) => {
      const e = doc.get(id, 'effects')[index];
      return e && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') ? e.color : undefined;
    },
    write: (doc, tx, id, value) => {
      if (!isColorValue(value)) return false;
      const list = doc.get(id, 'effects');
      const e = list[index];
      if (!e || (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW')) return false;
      if (!valueEquals(e.color, value)) {
        const copy: Effect[] = [...list];
        copy[index] = { ...e, color: value };
        tx.set(id, 'effects', copy);
      }
      return true;
    },
  };
}

/** A number of a layout grid: "layoutGrids/0/count" (FR-GRD-004). */
function gridField(index: number, key: 'count' | 'gutterSize' | 'offset' | 'sectionSize'): FieldSpec {
  const labels = { count: tr('Число колонок'), gutterSize: tr('Промежуток сетки'), offset: tr('Поле сетки'), sectionSize: tr('Размер ячейки') };
  return {
    field: `layoutGrids/${index}/${key}`,
    type: 'FLOAT',
    prop: 'layoutGrids',
    label: labels[key],
    scope: () => 'GRID',
    read: (doc, id) => {
      const g = doc.get(id, 'layoutGrids')[index];
      if (!g) return undefined;
      const v = (g as Record<string, unknown>)[key];
      return typeof v === 'number' ? v : undefined;
    },
    write: (doc, tx, id, value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      const list = doc.get(id, 'layoutGrids');
      const g = list[index];
      if (!g || !(key in g)) return false;
      const v = key === 'count' ? Math.max(0, Math.round(value)) : key === 'sectionSize' ? Math.max(1, value) : Math.max(0, value);
      if ((g as Record<string, unknown>)[key] !== v) {
        const copy = [...list];
        copy[index] = { ...g, [key]: v } as typeof g;
        tx.set(id, 'layoutGrids', copy);
      }
      return true;
    },
  };
}

/** A number of an effect: blur, spread and offset of a shadow, radius of a blur (whole effect styles become variables, FR-STY-003). */
function effectNumberField(index: number, key: 'radius' | 'spread' | 'offsetX' | 'offsetY'): FieldSpec {
  const labels = { radius: tr('Размытие'), spread: tr('Разброс тени'), offsetX: tr('Смещение тени по X'), offsetY: tr('Смещение тени по Y') };
  const readOf = (e: Effect | undefined): number | undefined => {
    if (!e || (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW' && e.type !== 'LAYER_BLUR' && e.type !== 'BACKGROUND_BLUR')) return undefined;
    if (key === 'radius') return e.radius;
    if (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW') return undefined;
    return key === 'spread' ? e.spread : key === 'offsetX' ? e.offset.x : e.offset.y;
  };
  return {
    field: `effects/${index}/${key}`,
    type: 'FLOAT',
    prop: 'effects',
    label: labels[key],
    scope: () => null,
    read: (doc, id) => readOf(doc.get(id, 'effects')[index]),
    write: (doc, tx, id, value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      const list = doc.get(id, 'effects');
      const e = list[index];
      if (readOf(e) === undefined) return false;
      const v = key === 'radius' ? Math.max(0, value) : value;
      if (readOf(e) === v) return true;
      const next = (key === 'radius' ? { ...e!, radius: v } : key === 'spread' ? { ...e!, spread: v } : { ...e!, offset: key === 'offsetX' ? { ...(e as { offset: { x: number; y: number } }).offset, x: v } : { ...(e as { offset: { x: number; y: number } }).offset, y: v } }) as Effect;
      const copy: Effect[] = [...list];
      copy[index] = next;
      tx.set(id, 'effects', copy);
      return true;
    },
  };
}

const FIELD_BY_NAME = new Map(FIXED_FIELDS.map((f) => [f.field, f]));

/** Spec of a bindable field by its name, e.g. "width", "fills/0", "effects/1". */
export function fieldSpec(field: string): FieldSpec | null {
  const fixed = FIELD_BY_NAME.get(field);
  if (fixed) return fixed;
  const grid = /^layoutGrids\/(\d+)\/(count|gutterSize|offset|sectionSize)$/.exec(field);
  if (grid) return gridField(Number(grid[1]), grid[2] as 'count' | 'gutterSize' | 'offset' | 'sectionSize');
  const effect = /^effects\/(\d+)\/(radius|spread|offsetX|offsetY)$/.exec(field);
  if (effect) return effectNumberField(Number(effect[1]), effect[2] as 'radius' | 'spread' | 'offsetX' | 'offsetY');
  const stop = /^(fills|strokes)\/(\d+)\/stops\/(\d+)$/.exec(field);
  if (stop) return stopField(stop[1] as 'fills' | 'strokes', Number(stop[2]), Number(stop[3]));
  const m = /^(fills|strokes|effects)\/(\d+)$/.exec(field);
  if (!m) return null;
  const index = Number(m[2]);
  return m[1] === 'effects' ? effectField(index) : paintField(m[1] as 'fills' | 'strokes', index);
}

export const BINDABLE_FIELDS: readonly FieldSpec[] = FIXED_FIELDS;

/** Whether a variable can be offered for a field of a node: type and scopes (FR-VAR-030). */
export function variableFits(doc: Document, variable: NodeId, field: FieldSpec, nodeType: NodeType): boolean {
  if (doc.get(variable, 'varType') !== field.type) return false;
  const scopes = doc.get(variable, 'scopes');
  if (scopes.length === 0) return true;
  const scope = field.scope(nodeType);
  return scope === null || scopes.includes(scope);
}

// ---------- modes and resolution ----------

export function isVariable(doc: Document, id: string | null | undefined): id is NodeId {
  return !!id && doc.store.has(id) && doc.store.isAlive(id) && doc.type(id) === 'VARIABLE';
}

export function defaultMode(doc: Document, collection: NodeId): string | null {
  return doc.get(collection, 'modes')[0]?.id ?? null;
}

// ---------- extended collections (FR-VAR-013) ----------

function isCollection(doc: Document, id: string | null | undefined): id is NodeId {
  return !!id && doc.store.has(id) && doc.store.isAlive(id) && doc.type(id) === 'VARIABLE_COLLECTION';
}

/** The collection an extension builds on, through every level; the collection itself when it extends nothing. */
export function baseCollection(doc: Document, collection: NodeId): NodeId {
  let c = collection;
  const seen = new Set<NodeId>();
  for (;;) {
    const parent = doc.get(c, 'extendsCollection');
    if (!isCollection(doc, parent) || seen.has(parent)) return c;
    seen.add(c);
    c = parent;
  }
}

/** Whether a collection is a live extension (its parent exists). */
export function isExtension(doc: Document, collection: NodeId): boolean {
  return isCollection(doc, doc.get(collection, 'extendsCollection'));
}

/** Extensions of a collection, direct and through other extensions, parents before children. */
export function extensionsOf(doc: Document, collection: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const visit = (c: NodeId) => {
    for (const e of doc.collections()) {
      if (e !== c && doc.get(e, 'extendsCollection') === c && !out.includes(e)) {
        out.push(e);
        visit(e);
      }
    }
  };
  visit(collection);
  return out;
}

/** Where a variable's values come from for a node: the collection (or one of its extensions) and the mode. */
export interface VariableContext {
  scope: NodeId;
  mode: string | null;
}

/** Explicit choices of modes, collection or extension id → mode id (the table's column, a prototype's screen). */
export type ForcedModes = Readonly<Record<string, string>>;

/**
 * Context of a collection for a node: a forced choice, else the nearest choice
 * up the tree of the collection or of one of its extensions (an extension wins
 * on the same layer), else the default mode of the collection itself.
 */
export function contextFor(doc: Document, node: NodeId | null, collection: NodeId, forced?: ForcedModes): VariableContext {
  const base = baseCollection(doc, collection);
  const modes = doc.get(base, 'modes');
  const valid = (m: string | undefined): m is string => !!m && modes.some((x) => x.id === m);
  const pick = (choices: Readonly<Record<string, string>> | null | undefined): VariableContext | null => {
    if (!choices) return null;
    let found: VariableContext | null = null;
    for (const [k, m] of Object.entries(choices)) {
      if (!valid(m) || !isCollection(doc, k) || baseCollection(doc, k) !== base) continue;
      // The deeper extension is the more specific choice.
      if (!found || (k !== base && (found.scope === base || extensionsOf(doc, found.scope).includes(k)))) found = { scope: k, mode: m };
    }
    return found;
  };
  const f = pick(forced);
  if (f) return f;
  let current: NodeId | null = node;
  while (current !== null && doc.store.has(current)) {
    const c = pick(doc.get(current, 'variableModes'));
    if (c) return c;
    current = doc.parent(current);
  }
  return { scope: base, mode: modes[0]?.id ?? null };
}

/** Mode of `collection` that applies to `node`: nearest explicit choice up the tree, else the default. */
export function modeFor(doc: Document, node: NodeId | null, collection: NodeId): string | null {
  return contextFor(doc, node, collection).mode;
}

/**
 * Raw value of a variable in a mode (falls back to the default mode); with
 * `scope` an extension, its own value (or its parents') comes first.
 */
export function rawValue(doc: Document, variable: NodeId, mode: string | null, scope?: NodeId): VariableValue | undefined {
  const values = doc.get(variable, 'varValues');
  const collection = doc.parent(variable)!;
  const fallback = defaultMode(doc, collection) ?? '';
  for (let c: NodeId | null = scope ?? null, n = 0; c && c !== collection && isCollection(doc, c) && n < 32; c = doc.get(c, 'extendsCollection'), n++) {
    // Only the mode it was set in: an extension's light value is not its dark one.
    const v = doc.get(c, 'varOverrides')[variable]?.[mode ?? fallback];
    if (v !== undefined) return v;
  }
  return (mode !== null ? values[mode] : undefined) ?? values[fallback];
}

/** The value an extension sets itself for a variable in a mode (undefined = inherited). */
export function overrideOf(doc: Document, extension: NodeId, variable: NodeId, mode: string): VariableValue | undefined {
  return doc.get(extension, 'varOverrides')[variable]?.[mode];
}

// ---------- expressions (FR-VAR-003) ----------

const parsedCache = new Map<string, Expr | ExprError>();

function parsed(text: string): Expr | ExprError {
  let e = parsedCache.get(text);
  if (e === undefined) {
    try {
      e = parseExpr(text);
    } catch (err) {
      if (!(err instanceof ExprError)) throw err;
      e = err;
    }
    if (parsedCache.size > 2000) parsedCache.clear();
    parsedCache.set(text, e);
  }
  return e;
}

const TYPE_WORDS: Record<VariableType, string> = { COLOR: tr('цвет'), FLOAT: tr('число'), STRING: tr('строка'), BOOLEAN: tr('логическое') };

/** A computed value as the variable's type holds it; null when it does not fit. */
export function coerceComputed(type: VariableType, v: ExprValue): VariableLiteral | null {
  switch (type) {
    case 'FLOAT':
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    case 'BOOLEAN':
      return typeof v === 'boolean' ? v : null;
    case 'STRING':
      return typeof v === 'object' ? null : formatValue(v);
    case 'COLOR':
      return typeof v === 'object' ? v : null;
  }
}

type Outcome = { value: VariableLiteral } | { error: string };

function compute(doc: Document, variable: NodeId, expr: string, node: NodeId | null, seen: Set<NodeId>, forced: ForcedModes | undefined): Outcome {
  const e = parsed(expr);
  if (e instanceof ExprError) return { error: e.message };
  try {
    const result = evaluate(e, (ref) => {
      const id = ref.startsWith('#') ? ref.slice(1) : '';
      if (!isVariable(doc, id)) return undefined;
      if (seen.has(id)) throw new ExprError(tr('Цикл: «{0}» зависит от самой себя', doc.get(id, 'name')), 0, 0);
      const v = resolveVariable(doc, id, node, new Set(seen), forced);
      if (v === undefined) throw new ExprError(tr('В «{0}» нет значения или ошибка', doc.get(id, 'name')), 0, 0);
      return v as ExprValue;
    });
    const type = doc.get(variable, 'varType');
    const out = coerceComputed(type, result);
    return out === null ? { error: tr('Получилось {0}, а переменная — {1}', TYPE_WORDS[typeof result === 'number' ? 'FLOAT' : typeof result === 'boolean' ? 'BOOLEAN' : typeof result === 'string' ? 'STRING' : 'COLOR'], TYPE_WORDS[type]) } : { value: out };
  } catch (err) {
    if (err instanceof ExprError) return { error: err.message };
    throw err;
  }
}

/** Whether an expression text parses; the error message otherwise. */
export function expressionError(expr: string): string | null {
  const e = parsed(expr);
  return e instanceof ExprError ? e.message : null;
}

// ---------- resolution ----------

/**
 * Final value of a variable for a node (null node = default modes), following
 * aliases and computing expressions; undefined for a missing variable, a cycle
 * or an expression error. `forced` fixes modes (and extensions) regardless of the node.
 */
export function resolveVariable(doc: Document, variable: NodeId, node: NodeId | null, seen: Set<NodeId> = new Set(), forced?: ForcedModes): VariableLiteral | undefined {
  const r = resolveOutcome(doc, variable, node, seen, forced);
  return r && 'value' in r ? r.value : undefined;
}

function resolveOutcome(doc: Document, variable: NodeId, node: NodeId | null, seen: Set<NodeId>, forced: ForcedModes | undefined): Outcome | undefined {
  if (!isVariable(doc, variable) || seen.has(variable)) return undefined;
  seen.add(variable);
  const ctx = contextFor(doc, node, doc.parent(variable)!, forced);
  const value = rawValue(doc, variable, ctx.mode, ctx.scope);
  if (value === undefined) return undefined;
  if (isExpression(value)) return compute(doc, variable, value.expr, node, seen, forced);
  if (!isAlias(value)) return { value };
  const target = resolveVariable(doc, value.id, node, seen, forced);
  if (target === undefined) return undefined;
  if (isColorValue(target) && value.opacity !== undefined) return { value: { ...target, a: target.a * value.opacity } };
  return { value: target };
}

/**
 * Variable value in a given mode, for the table: the mode (and `scope`, an
 * extension being shown) holds for its own collection and everything it refers
 * to there; other collections are seen in their default modes.
 */
export function resolveInMode(doc: Document, variable: NodeId, mode: string, scope?: NodeId): VariableLiteral | undefined {
  const r = explainInMode(doc, variable, mode, scope);
  return 'value' in r ? r.value : undefined;
}

/** As resolveInMode, with the reason when there is no value (an expression's error, shown in the cell). */
export function explainInMode(doc: Document, variable: NodeId, mode: string, scope?: NodeId): { value: VariableLiteral } | { error: string } {
  if (!isVariable(doc, variable)) return { error: tr('Нет переменной') };
  const r = resolveOutcome(doc, variable, null, new Set(), { [scope ?? doc.parent(variable)!]: mode });
  return r ?? { error: tr('Ссылка ведёт по кругу или на удалённую переменную') };
}

/** Whether `value` is valid for a variable type. */
export function valueFits(type: VariableType, value: VariableValue): boolean {
  if (isAlias(value) || isExpression(value)) return true;
  switch (type) {
    case 'COLOR':
      return isColorValue(value);
    case 'FLOAT':
      return typeof value === 'number' && Number.isFinite(value);
    case 'STRING':
      return typeof value === 'string';
    case 'BOOLEAN':
      return typeof value === 'boolean';
  }
}

/** All live variables in collection and list order. */
export function allVariables(doc: Document): NodeId[] {
  return doc.collections().flatMap((c) => [...doc.children(c)]);
}

/** Every value a variable may take: its own in each mode and those its collection's extensions set. */
export function allValuesOf(doc: Document, variable: NodeId): VariableValue[] {
  const out = Object.values(doc.get(variable, 'varValues'));
  const collection = doc.parent(variable);
  if (collection) for (const e of extensionsOf(doc, collection)) out.push(...Object.values(doc.get(e, 'varOverrides')[variable] ?? {}));
  return out;
}

/** Variables `variable` refers to directly: alias targets and expression references (FR-VAR-025). */
export function directRefs(doc: Document, variable: NodeId): NodeId[] {
  const out = new Set<NodeId>();
  for (const value of allValuesOf(doc, variable)) for (const id of valueRefs(value)) if (isVariable(doc, id)) out.add(id);
  return [...out];
}

/** Variables `variable` depends on through aliases and expressions (FR-VAR-025, "from what"). */
export function aliasChain(doc: Document, variable: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<NodeId>([variable]);
  const visit = (v: NodeId) => {
    for (const id of directRefs(doc, v)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
        visit(id);
      }
    }
  };
  visit(variable);
  return out;
}

/** Variables that alias `variable` directly or indirectly (FR-VAR-025, "what depends on it"). */
export function aliasDependents(doc: Document, variables: Iterable<NodeId>): Set<NodeId> {
  const reverse = new Map<NodeId, NodeId[]>();
  for (const v of allVariables(doc)) {
    for (const id of directRefs(doc, v)) {
      const list = reverse.get(id);
      if (list) list.push(v);
      else reverse.set(id, [v]);
    }
  }
  const out = new Set<NodeId>();
  const queue = [...variables];
  while (queue.length > 0) {
    const v = queue.pop()!;
    for (const dep of reverse.get(v) ?? []) {
      if (!out.has(dep)) {
        out.add(dep);
        queue.push(dep);
      }
    }
  }
  return out;
}

/** Whether setting `variable` to an alias of `target` would create a cycle. */
export function wouldAliasCycle(doc: Document, variable: NodeId, target: NodeId): boolean {
  return target === variable || aliasChain(doc, target).includes(variable);
}

/** Whether a value (alias or expression) for `variable` would make it depend on itself. */
export function wouldCycle(doc: Document, variable: NodeId, value: VariableValue): boolean {
  return valueRefs(value).some((id) => isVariable(doc, id) && wouldAliasCycle(doc, variable, id));
}

/** Every node (layers on all pages and styles) bound to any of `variables`, with the fields. */
export function variableUsers(doc: Document, variables: ReadonlySet<NodeId>): { id: NodeId; field: string; variable: NodeId }[] {
  const out: { id: NodeId; field: string; variable: NodeId }[] = [];
  const check = (id: NodeId) => {
    const bound = doc.get(id, 'boundVariables');
    if (!bound) return;
    for (const [field, v] of Object.entries(bound)) if (variables.has(v)) out.push({ id, field, variable: v });
  };
  for (const page of doc.pages()) doc.store.walk(page, (id) => check(id));
  for (const style of doc.styles()) check(style);
  return out;
}

// ---------- pipeline ----------

function markChanged(changed: Map<NodeId, Set<PropKey>>, id: NodeId, key: PropKey): void {
  let set = changed.get(id);
  if (!set) changed.set(id, (set = new Set()));
  set.add(key);
}

function withoutField(bound: Record<string, string>, field: string): Record<string, string> | null {
  const next = { ...bound };
  delete next[field];
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * User phase: a bound value the user edited directly (by any route) loses its
 * binding. Runs before overrides are marked so instances record it.
 */
export function unbindEditedFields(doc: Document, tx: Transaction, changed: Map<NodeId, Set<PropKey>>): void {
  for (const [id, keys] of [...changed]) {
    if (!doc.store.isAlive(id) || keys.has('boundVariables')) continue;
    const bound = doc.get(id, 'boundVariables');
    if (!bound) continue;
    let next: Record<string, string> | null = bound;
    for (const [field, variable] of Object.entries(bound)) {
      const spec = fieldSpec(field);
      if (!spec || !keys.has(spec.prop)) continue;
      const expected = resolveVariable(doc, variable, id);
      if (expected === undefined) continue;
      const actual = spec.read(doc, id);
      if (actual === undefined || !valueEquals(actual, expected)) next = next ? withoutField(next, field) : null;
    }
    if (next !== bound) {
      tx.set(id, 'boundVariables', next);
      markChanged(changed, id, 'boundVariables');
    }
  }
}

/** Writes the variables' values into one node; unbinds fields whose variable is gone. */
export function resolveNode(doc: Document, tx: Transaction, id: NodeId): void {
  const bound = doc.get(id, 'boundVariables');
  if (!bound) return;
  let next: Record<string, string> | null = bound;
  for (const [field, variable] of Object.entries(bound)) {
    const spec = fieldSpec(field);
    if (!spec) continue;
    if (!isVariable(doc, variable)) {
      next = next ? withoutField(next, field) : null;
      continue;
    }
    const value = resolveVariable(doc, variable, id);
    if (value !== undefined) spec.write(doc, tx, id, cloneValue(value) as VariableLiteral);
  }
  if (next !== bound) tx.set(id, 'boundVariables', next);
}

/** An extension has its parent's modes: kept equal whenever either changes. */
function syncExtensionModes(doc: Document, tx: Transaction, collection: NodeId): void {
  if (!doc.store.isAlive(collection)) return;
  const base = baseCollection(doc, collection);
  const modes = doc.get(base, 'modes');
  for (const e of extensionsOf(doc, base)) if (doc.store.isAlive(e) && !valueEquals(doc.get(e, 'modes'), modes)) tx.set(e, 'modes', modes.map((m) => ({ ...m })));
}

/** Resolution phase: re-resolves everything the transaction may have affected. */
export function resolveVariables(doc: Document, tx: Transaction): void {
  const changes = tx.changes;
  const affected = new Set<NodeId>();
  const changedVariables = new Set<NodeId>();
  const addSubtree = (root: NodeId) => {
    if (doc.get(root, 'boundVariables')) affected.add(root);
    doc.store.walk(root, (id) => {
      if (doc.get(id, 'boundVariables')) affected.add(id);
    });
  };
  for (const id of changes.touched()) {
    if (!doc.store.has(id)) continue;
    const type = doc.type(id);
    if (type === 'VARIABLE') {
      changedVariables.add(id);
      continue;
    }
    if (type === 'VARIABLE_COLLECTION') {
      // Modes changed or the collection was deleted / restored: all of its variables
      // (an extension: its parent's, which it shows).
      for (const v of doc.store.children(id)) changedVariables.add(v);
      if (doc.store.isAlive(id)) for (const v of doc.store.children(baseCollection(doc, id))) changedVariables.add(v);
      syncExtensionModes(doc, tx, id);
      continue;
    }
    if (!doc.store.isAlive(id)) continue;
    const keys = changes.updated.get(id);
    if (changes.created.has(id) || changes.moved.has(id) || keys?.has('variableModes') || keys?.has('deleted')) addSubtree(id);
    else if (doc.get(id, 'boundVariables')) affected.add(id);
  }
  if (changedVariables.size > 0) {
    const all = new Set<NodeId>([...changedVariables, ...aliasDependents(doc, changedVariables)]);
    for (const u of variableUsers(doc, all)) affected.add(u.id);
  }
  for (const id of affected) if (doc.store.isAlive(id)) resolveNode(doc, tx, id);
}

/** Colour equality with a little tolerance (values typed as hex round to 1/255). */
export function sameColor(a: Color, b: Color): boolean {
  return Math.abs(a.r - b.r) < 1e-3 && Math.abs(a.g - b.g) < 1e-3 && Math.abs(a.b - b.b) < 1e-3 && Math.abs(a.a - b.a) < 1e-3;
}

