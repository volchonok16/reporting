// Design tokens in the W3C DTCG JSON format (FR-VAR-040): export and import of
// variables and styles, with modes kept in an extension.
//
// Layout of a file:
//   { "<collection>": { "$extensions": { "canvas-studio": { "modes": ["Светлая", "Тёмная"] } },
//       "surface": { "bg": { "$type": "color", "$value": "#FFFFFF",
//         "$extensions": { "canvas-studio": { "modes": { "Светлая": "#FFFFFF", "Тёмная": "{Тема.base.grey} @ 50%" } } } } } },
//     "Стили": { "$extensions": { "canvas-studio": { "styles": true } }, … colour, typography and shadow tokens … } }
// `$value` holds the default mode, so other tools read a plain token file; the
// extension carries every mode, scopes, code names and the "hidden" flag. An
// alias is "{collection.group.name}"; an expression (FR-VAR-003) is
// "= {collection.group.name} * 2" in the modes, its result in `$value`. An
// extended collection (FR-VAR-013) is a group with "extends": "<parent>" holding
// only the values it overrides.
// Import is two-step: plan (what will be added or changed, for a preview) and apply.

import { isGradient, tr } from '#core';
import { baseCollection, isExtension, isVariable, mapReferences, resolveInMode } from '#components';
import {
  colorToHex,
  isAlias,
  isColorValue,
  isExpression,
  TEXT_STYLE_KEYS,
  valueEquals,
  type Document,
  type Effect,
  type NodeId,
  type NodeProps,
  type Paint,
  type VariableScope,
  type VariableType,
  type VariableValue,
} from '#core';
import type { Editor } from './editor.ts';
import { parseColor } from './variables.ts';

const EXT = 'canvas-studio';
const STYLES_GROUP = tr('Стили');

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const DTCG_TYPE: Record<VariableType, string> = { COLOR: 'color', FLOAT: 'number', STRING: 'string', BOOLEAN: 'boolean' };

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Puts `value` at a path of nested groups. "primary" and "primary/pressed" both
 * live: the token keeps its `$` fields and holds the deeper one beside them.
 */
function setPath(root: JsonObject, path: string[], value: JsonObject): void {
  let node = root;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (!isObject(next)) node[part] = {};
    node = node[part] as JsonObject;
  }
  const last = path[path.length - 1]!;
  const existing = node[last];
  node[last] = isObject(existing) ? { ...existing, ...value } : value;
}

function splitName(name: string): string[] {
  return name.split('/').map((s) => s.trim()).filter(Boolean);
}

// ---------- export ----------

function aliasRef(doc: Document, id: NodeId): string {
  return `{${[doc.get(doc.parent(id)!, 'name'), ...splitName(doc.get(id, 'name'))].join('.')}}`;
}

function literal(value: VariableValue, doc: Document): Json {
  if (isExpression(value)) return `= ${mapReferences(value.expr, (ref) => (ref.startsWith('#') && isVariable(doc, ref.slice(1)) ? aliasRef(doc, ref.slice(1)).slice(1, -1) : null))}`;
  if (isAlias(value)) return isVariable(doc, value.id) ? `${aliasRef(doc, value.id)}${value.opacity !== undefined ? ` @ ${Math.round(value.opacity * 100)}%` : ''}` : null;
  if (isColorValue(value)) return colorToHex(value, value.a < 1);
  return value;
}

function paintToken(paints: readonly Paint[]): JsonObject | null {
  const p = paints.find((x) => x.visible) ?? paints[0];
  if (!p) return null;
  if (p.type === 'SOLID') return { $type: 'color', $value: colorToHex({ ...p.color, a: p.color.a * p.opacity }, p.color.a * p.opacity < 1) };
  if (isGradient(p)) {
    return {
      $type: 'gradient',
      $value: p.stops.map((s) => ({ color: colorToHex(s.color, s.color.a < 1), position: Math.round(s.position * 1000) / 1000 })),
      $extensions: { [EXT]: { paint: structuredClone(p) as unknown as Json } },
    };
  }
  return { $type: 'color', $value: '#CCCCCC', $extensions: { [EXT]: { paint: structuredClone(p) as unknown as Json } } };
}

function shadowToken(effects: readonly Effect[]): JsonObject {
  const shadows = effects.filter((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');
  const value: JsonObject[] = [];
  for (const e of shadows) {
    if (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW') continue;
    value.push({ color: colorToHex(e.color, e.color.a < 1), offsetX: `${e.offset.x}px`, offsetY: `${e.offset.y}px`, blur: `${e.radius}px`, spread: `${e.spread}px`, inset: e.type === 'INNER_SHADOW' });
  }
  return { $type: 'shadow', $value: value.length === 1 ? value[0]! : value, $extensions: { [EXT]: { effects: structuredClone(effects) as unknown as Json } } };
}

function typographyToken(doc: Document, style: NodeId): JsonObject {
  const lh = doc.get(style, 'lineHeight');
  const ls = doc.get(style, 'letterSpacing');
  return {
    $type: 'typography',
    $value: {
      fontFamily: doc.get(style, 'fontFamily'),
      fontWeight: doc.get(style, 'fontWeight'),
      fontSize: `${doc.get(style, 'fontSize')}px`,
      lineHeight: lh.unit === 'AUTO' ? 'normal' : lh.unit === 'PX' ? `${lh.value}px` : lh.unit === 'PERCENT' ? lh.value / 100 : lh.value,
      letterSpacing: ls.unit === 'PX' ? `${ls.value}px` : `${ls.value / 100}em`,
    },
    $extensions: { [EXT]: { text: Object.fromEntries(TEXT_STYLE_KEYS.map((k) => [k, structuredClone(doc.get(style, k)) as unknown as Json])) } },
  };
}

/** The whole file's variables and styles as a DTCG document. */
export function exportTokens(doc: Document): JsonObject {
  const root: JsonObject = {};
  for (const c of doc.collections()) {
    const modes = doc.get(c, 'modes');
    const extension = isExtension(doc, c);
    const group: JsonObject = { $extensions: { [EXT]: { modes: modes.map((m) => m.name), ...(extension ? { extends: doc.get(doc.get(c, 'extendsCollection')!, 'name') } : {}) } } };
    // An extension lists the variables it overrides, under their names in the parent.
    const overrides = doc.get(c, 'varOverrides');
    const variables = extension ? doc.children(baseCollection(doc, c)).filter((v) => overrides[v] && Object.keys(overrides[v]!).length > 0) : doc.children(c);
    for (const v of variables) {
      const type = doc.get(v, 'varType');
      const values = extension ? overrides[v]! : doc.get(v, 'varValues');
      const def = values[modes[0]?.id ?? ''];
      const ext: JsonObject = { modes: Object.fromEntries(modes.map((m) => [m.name, values[m.id] !== undefined ? literal(values[m.id]!, doc) : null])) };
      if (doc.get(v, 'scopes').length > 0) ext.scopes = [...doc.get(v, 'scopes')];
      if (Object.keys(doc.get(v, 'codeSyntax')).length > 0) ext.codeSyntax = { ...doc.get(v, 'codeSyntax') };
      if (doc.get(v, 'hiddenFromPublishing')) ext.hidden = true;
      // An alias with changed opacity and an expression are not plain DTCG: $value gets the result.
      let value: Json = def === undefined ? null : literal(def, doc);
      if (def !== undefined && ((isAlias(def) && def.opacity !== undefined) || isExpression(def))) {
        const resolved = resolveInMode(doc, v, modes[0]!.id, extension ? c : undefined);
        value = resolved === undefined ? null : isColorValue(resolved) ? colorToHex(resolved, resolved.a < 1) : resolved;
      }
      const token: JsonObject = { $type: DTCG_TYPE[type], $value: value, $extensions: { [EXT]: ext } };
      if (doc.get(v, 'description')) token.$description = doc.get(v, 'description');
      setPath(group, splitName(doc.get(v, 'name')), token);
    }
    root[doc.get(c, 'name')] = group;
  }
  if (doc.styles().length > 0) {
    const styles: JsonObject = { $extensions: { [EXT]: { styles: true } } };
    for (const s of doc.styles()) {
      const type = doc.get(s, 'styleType');
      // Layout grids have no DTCG type: they travel in our extension under "grid".
      const token =
        type === 'FILL'
          ? paintToken(doc.get(s, 'fills'))
          : type === 'TEXT'
            ? typographyToken(doc, s)
            : type === 'GRID'
              ? ({ $type: 'grid', $value: structuredClone(doc.get(s, 'layoutGrids')) as unknown as Json } as JsonObject)
              : shadowToken(doc.get(s, 'effects'));
      if (!token) continue;
      if (doc.get(s, 'description')) token.$description = doc.get(s, 'description');
      setPath(styles, splitName(doc.get(s, 'name')), token);
    }
    root[STYLES_GROUP] = styles;
  }
  return root;
}

// ---------- import ----------

export interface TokenChange {
  kind: 'collection' | 'mode' | 'variable' | 'value' | 'style';
  /** True for additions, false for changes of something that exists. */
  added: boolean;
  label: string;
}

export interface ImportPlan {
  changes: TokenChange[];
  /** Problems found while reading (unknown types, broken aliases); the rest still imports. */
  warnings: string[];
  apply(): void;
}

interface ParsedToken {
  collection: string;
  name: string;
  type: VariableType;
  /** Values by mode name; strings starting with "{" are aliases. */
  values: Map<string, Json>;
  description?: string;
  scopes?: VariableScope[];
  codeSyntax?: Record<string, string>;
  hidden?: boolean;
}

const TYPE_FROM_DTCG: Record<string, VariableType> = {
  color: 'COLOR',
  number: 'FLOAT',
  dimension: 'FLOAT',
  fontWeight: 'FLOAT',
  duration: 'FLOAT',
  string: 'STRING',
  fontFamily: 'STRING',
  boolean: 'BOOLEAN',
};

function dimension(v: Json): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof v.value === 'number') return v.unit === 'rem' || v.unit === 'em' ? v.value * 16 : v.value;
  if (typeof v !== 'string') return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*(px|rem|em|ms|s)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : m[2] === 's' ? n * 1000 : n;
}

/** Reads a DTCG document and plans the changes it would make (FR-VAR-040). */
export function planImport(editor: Editor, json: unknown): ImportPlan {
  const doc = editor.doc;
  const warnings: string[] = [];
  const changes: TokenChange[] = [];
  if (!isObject(json)) return { changes, warnings: [tr('Файл не похож на токены: ожидается JSON-объект')], apply: () => {} };
  const tokens: ParsedToken[] = [];
  const collectionModes = new Map<string, string[]>();
  /** Extended collections: name → parent's name (FR-VAR-013). */
  const collectionExtends = new Map<string, string>();
  const styleTokens: { name: string; type: string; value: Json; ext: JsonObject; description?: string }[] = [];

  const walk = (node: JsonObject, path: string[], inheritedType: string | undefined, collection: string, styles: boolean) => {
    const groupType = typeof node.$type === 'string' ? node.$type : inheritedType;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !isObject(child)) continue;
      if (!('$value' in child)) {
        walk(child, [...path, key], groupType, collection, styles);
        continue;
      }
      const dtcgType = typeof child.$type === 'string' ? child.$type : groupType;
      const ext = isObject(child.$extensions) && isObject(child.$extensions[EXT]) ? (child.$extensions[EXT] as JsonObject) : {};
      const name = [...path, key].join('/');
      const description = typeof child.$description === 'string' ? child.$description : undefined;
      // Composite tokens (shadow, typography, gradient) become styles wherever they are.
      if (styles || dtcgType === 'shadow' || dtcgType === 'typography' || dtcgType === 'gradient' || dtcgType === 'grid') {
        styleTokens.push({ name, type: dtcgType ?? '', value: child.$value!, ext, ...(description ? { description } : {}) });
        walk(child, [...path, key], groupType, collection, styles);
        continue;
      }
      const type = dtcgType ? TYPE_FROM_DTCG[dtcgType] : undefined;
      if (!type) {
        warnings.push(tr('«{0}/{1}»: тип «{2}» пока не поддерживается для переменных — пропущено', collection, name, dtcgType ?? tr('не указан')));
        continue;
      }
      const values = new Map<string, Json>();
      if (isObject(ext.modes)) for (const [mode, v] of Object.entries(ext.modes)) values.set(mode, v);
      const modes = collectionModes.get(collection) ?? [];
      if (values.size === 0) values.set(modes[0] ?? '', child.$value!);
      tokens.push({
        collection,
        name,
        type,
        values,
        ...(description ? { description } : {}),
        ...(Array.isArray(ext.scopes) ? { scopes: ext.scopes.filter((s): s is VariableScope => typeof s === 'string') } : {}),
        ...(isObject(ext.codeSyntax) ? { codeSyntax: Object.fromEntries(Object.entries(ext.codeSyntax).filter((e): e is [string, string] => typeof e[1] === 'string')) } : {}),
        ...(ext.hidden === true ? { hidden: true } : {}),
      });
      // Deeper tokens under this one ("primary" holding "pressed").
      walk(child, [...path, key], groupType, collection, styles);
    }
  };
  for (const [key, group] of Object.entries(json)) {
    if (key.startsWith('$') || !isObject(group)) continue;
    const ext = isObject(group.$extensions) && isObject(group.$extensions[EXT]) ? (group.$extensions[EXT] as JsonObject) : {};
    if (ext.styles === true) {
      walk(group, [], undefined, key, true);
      continue;
    }
    if ('$value' in group) {
      warnings.push(tr('«{0}»: токен на верхнем уровне — положите его в группу-коллекцию', key));
      continue;
    }
    const modes = Array.isArray(ext.modes) ? ext.modes.filter((m): m is string => typeof m === 'string') : [];
    collectionModes.set(key, modes);
    if (typeof ext.extends === 'string') collectionExtends.set(key, ext.extends);
    walk(group, [], undefined, key, false);
  }

  // What exists now.
  const existingCollection = (name: string) => doc.collections().find((c) => doc.get(c, 'name') === name);
  for (const [name, modes] of collectionModes) {
    const c = existingCollection(name);
    if (!c) changes.push({ kind: 'collection', added: true, label: tr('Коллекция «{0}»{1}', name, modes.length > 1 ? tr(' с режимами {0}', modes.join(', ')) : '') });
    else for (const m of modes) if (!doc.get(c, 'modes').some((x) => x.name === m)) changes.push({ kind: 'mode', added: true, label: tr('Режим «{0}» в «{1}»', m, name) });
  }
  const findVar = (collection: string, name: string) => {
    // An extension's tokens are its parent's variables.
    let parent = collection;
    for (let i = 0; collectionExtends.has(parent) && i < 32; i++) parent = collectionExtends.get(parent)!;
    const c = existingCollection(parent);
    return c ? doc.children(baseCollection(doc, c)).find((v) => doc.get(v, 'name') === name) : undefined;
  };
  // An extension's variable may come in the same file with its parent.
  const rootOf = (collection: string) => {
    let k = collection;
    for (let i = 0; collectionExtends.has(k) && i < 32; i++) k = collectionExtends.get(k)!;
    return k;
  };
  const inFile = (collection: string, name: string) => tokens.some((x) => x.collection === rootOf(collection) && x.name === name);
  for (const t of tokens) {
    const v = findVar(t.collection, t.name);
    if (collectionExtends.has(t.collection)) {
      if (v || inFile(t.collection, t.name)) changes.push({ kind: 'value', added: false, label: `${t.collection} / ${t.name}` });
      else warnings.push(tr('«{0}/{1}»: в родительской коллекции нет такой переменной — пропущено', t.collection, t.name));
    } else if (!v) changes.push({ kind: 'variable', added: true, label: `${t.collection} / ${t.name}` });
    else if (doc.get(v, 'varType') !== t.type) warnings.push(tr('«{0}/{1}»: в файле другой тип — пропущено', t.collection, t.name));
    else changes.push({ kind: 'value', added: false, label: `${t.collection} / ${t.name}` });
  }
  for (const s of styleTokens) {
    const exists = doc.styles().some((id) => doc.get(id, 'name') === s.name);
    changes.push({ kind: 'style', added: !exists, label: tr('Стиль {0}', s.name) });
  }

  const apply = () => {
    editor.commit(tr('Импорт токенов'), (tx) => {
      const ids = new Map<string, NodeId>(); // "collection/name" → variable
      const modeIds = new Map<NodeId, Map<string, string>>();
      // Parents first: an extension takes its parent's modes.
      const order = [...collectionModes.keys()].sort((a, b) => depth(a) - depth(b));
      function depth(name: string): number {
        let n = 0;
        for (let k = name; collectionExtends.has(k) && n < 32; k = collectionExtends.get(k)!) n++;
        return n;
      }
      for (const name of order) {
        const modes = collectionModes.get(name)!;
        let c = existingCollection(name);
        const parent = collectionExtends.has(name) ? existingCollection(collectionExtends.get(name)!) : undefined;
        if (collectionExtends.has(name) && !parent) {
          warnings.push(tr('«{0}»: нет родительской коллекции «{1}» — пропущено', name, collectionExtends.get(name)!));
          continue;
        }
        if (parent) {
          if (!c) c = tx.create('VARIABLE_COLLECTION', doc.rootId, { name, extendsCollection: parent, modes: doc.get(parent, 'modes').map((m) => ({ ...m })) });
          else if (doc.get(c, 'extendsCollection') !== parent) tx.update(c, { extendsCollection: parent, modes: doc.get(parent, 'modes').map((m) => ({ ...m })) });
        } else if (!c) c = tx.create('VARIABLE_COLLECTION', doc.rootId, { name, modes: (modes.length > 0 ? modes : [tr('Режим 1')]).map((m) => ({ id: doc.ids.next(), name: m })) });
        else {
          const current = doc.get(c, 'modes');
          const added = modes.filter((m) => !current.some((x) => x.name === m)).map((m) => ({ id: doc.ids.next(), name: m }));
          if (added.length > 0) tx.set(c, 'modes', [...current, ...added]);
        }
        const map = new Map(doc.get(c, 'modes').map((m) => [m.name, m.id]));
        // Tokens without per-mode values use the default mode.
        map.set('', doc.get(c, 'modes')[0]!.id);
        modeIds.set(c, map);
      }
      const pending: { v: NodeId; t: ParsedToken; c: NodeId }[] = [];
      // Parents' tokens first: an extension's values need its parent's variables.
      const extensionTokens: ParsedToken[] = [];
      for (const t of tokens) {
        const c = existingCollection(t.collection);
        if (!c || !modeIds.has(c)) continue;
        if (isExtension(doc, c)) {
          extensionTokens.push(t);
          continue;
        }
        let v = doc.children(c).find((x) => doc.get(x, 'name') === t.name);
        if (v && doc.get(v, 'varType') !== t.type) continue;
        const props: Partial<NodeProps> = {};
        if (t.description !== undefined) props.description = t.description;
        if (t.scopes) props.scopes = t.scopes;
        if (t.codeSyntax) props.codeSyntax = t.codeSyntax;
        if (t.hidden !== undefined) props.hiddenFromPublishing = t.hidden;
        if (!v) v = tx.create('VARIABLE', c, { name: t.name, varType: t.type, varValues: {}, ...props });
        else tx.update(v, props);
        ids.set(`${t.collection}/${t.name}`.toLowerCase(), v);
        pending.push({ v, t, c });
      }
      for (const t of extensionTokens) {
        const c = existingCollection(t.collection)!;
        const v = findVar(t.collection, t.name);
        if (v && doc.get(v, 'varType') === t.type) pending.push({ v, t, c });
      }
      // Values after every variable exists, so aliases can point forward.
      const resolveRef = (ref: string): NodeId | null => {
        const parts = ref.replace(/^\{|\}$/g, '').split('.');
        const direct = ids.get(`${parts[0]}/${parts.slice(1).join('/')}`.toLowerCase());
        if (direct) return direct;
        const c = existingCollection(parts[0]!);
        const found = c ? doc.children(c).find((x) => doc.get(x, 'name').toLowerCase() === parts.slice(1).join('/').toLowerCase()) : undefined;
        return found ?? editor.variables.findByName(parts.join('/'));
      };
      for (const { v, t, c } of pending) {
        const modes = modeIds.get(c)!;
        const extension = isExtension(doc, c);
        const values: Record<string, VariableValue> = extension ? { ...(doc.get(c, 'varOverrides')[v] ?? {}) } : { ...doc.get(v, 'varValues') };
        for (const [modeName, raw] of t.values) {
          const mode = modes.get(modeName);
          if (!mode || raw === null) continue;
          let value: VariableValue | null = null;
          if (typeof raw === 'string' && raw.trim().startsWith('=')) {
            // An expression: names → ids; an unknown name keeps the whole expression out.
            let missing = '';
            const expr = mapReferences(raw.trim().slice(1).trim(), (ref) => {
              const target = resolveRef(ref);
              if (!target) missing ||= ref;
              return target ? `#${target}` : null;
            });
            if (missing) warnings.push(tr('«{0}/{1}»: в выражении нет переменной {{2}}', t.collection, t.name, missing));
            else value = { type: 'EXPRESSION', expr };
          } else if (typeof raw === 'string' && raw.trim().startsWith('{')) {
            const m = /^\{([^}]+)\}\s*(?:@\s*(\d+(?:\.\d+)?)\s*%)?$/.exec(raw.trim());
            const target = m ? resolveRef(m[1]!) : null;
            if (target && target !== v) value = { type: 'ALIAS', id: target, ...(m?.[2] !== undefined ? { opacity: Number(m[2]) / 100 } : {}) };
            else warnings.push(tr('«{0}/{1}»: ссылка {2} не найдена', t.collection, t.name, raw));
          } else if (t.type === 'COLOR') value = typeof raw === 'string' ? parseColor(raw) : null;
          else if (t.type === 'FLOAT') value = dimension(raw);
          else if (t.type === 'BOOLEAN') value = typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : null;
          else value = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null;
          if (value !== null) values[mode] = value;
        }
        if (extension) {
          // An extension keeps only what it overrides.
          const all = doc.get(c, 'varOverrides');
          if (!valueEquals(values, all[v] ?? {})) tx.set(c, 'varOverrides', { ...all, [v]: values });
          continue;
        }
        // Modes the token does not mention take the default mode's value.
        const def = values[modes.get('') ?? ''];
        for (const id of modes.values()) if (values[id] === undefined && def !== undefined) values[id] = structuredClone(def);
        if (!valueEquals(values, doc.get(v, 'varValues'))) tx.set(v, 'varValues', values);
      }
      for (const s of styleTokens) {
        const props = styleProps(s);
        if (!props) continue;
        const existing = doc.styles().find((id) => doc.get(id, 'name') === s.name && doc.get(id, 'styleType') === props.styleType);
        if (existing) tx.update(existing, props);
        else tx.create('STYLE', doc.rootId, { name: s.name, ...props });
      }
    });
  };
  return { changes, warnings, apply };
}

/** Style props from a style token (our extension wins: it is exact). */
function styleProps(s: { type: string; value: Json; ext: JsonObject; description?: string }): Partial<NodeProps> | null {
  const base: Partial<NodeProps> = s.description ? { description: s.description } : {};
  if (s.type === 'color' || s.type === 'gradient') {
    if (isObject(s.ext.paint)) return { ...base, styleType: 'FILL', fills: [s.ext.paint as unknown as Paint] };
    const c = typeof s.value === 'string' ? parseColor(s.value) : null;
    return c ? { ...base, styleType: 'FILL', fills: [{ type: 'SOLID', color: c, opacity: 1, visible: true }] } : null;
  }
  if (s.type === 'shadow') {
    if (Array.isArray(s.ext.effects)) return { ...base, styleType: 'EFFECT', effects: s.ext.effects as unknown as Effect[] };
    const list = Array.isArray(s.value) ? s.value : [s.value];
    const effects: Effect[] = [];
    for (const v of list) {
      if (!isObject(v)) continue;
      const color = typeof v.color === 'string' ? parseColor(v.color) : null;
      effects.push({ type: v.inset === true ? 'INNER_SHADOW' : 'DROP_SHADOW', color: color ?? { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: dimension(v.offsetX ?? 0) ?? 0, y: dimension(v.offsetY ?? 0) ?? 0 }, radius: dimension(v.blur ?? 0) ?? 0, spread: dimension(v.spread ?? 0) ?? 0, visible: true });
    }
    return { ...base, styleType: 'EFFECT', effects };
  }
  if (s.type === 'grid') return Array.isArray(s.value) ? { ...base, styleType: 'GRID', layoutGrids: s.value as unknown as NodeProps['layoutGrids'] } : null;
  if (s.type === 'typography') {
    if (isObject(s.ext.text)) return { ...base, styleType: 'TEXT', ...(s.ext.text as unknown as Partial<NodeProps>) };
    if (!isObject(s.value)) return null;
    const v = s.value;
    const props: Partial<NodeProps> = { ...base, styleType: 'TEXT' };
    if (typeof v.fontFamily === 'string') props.fontFamily = v.fontFamily;
    else if (Array.isArray(v.fontFamily) && typeof v.fontFamily[0] === 'string') props.fontFamily = v.fontFamily[0];
    const weight = dimension(v.fontWeight ?? null);
    if (weight !== null) props.fontWeight = weight;
    const size = dimension(v.fontSize ?? null);
    if (size !== null) props.fontSize = size;
    if (typeof v.lineHeight === 'number') props.lineHeight = { unit: 'MULTIPLIER', value: v.lineHeight };
    else if (typeof v.lineHeight === 'string' && v.lineHeight !== 'normal') {
      const px = dimension(v.lineHeight);
      if (px !== null) props.lineHeight = { unit: 'PX', value: px };
    }
    if (typeof v.letterSpacing === 'string') {
      const m = /^(-?\d+(?:\.\d+)?)(px|em)?$/.exec(v.letterSpacing.trim());
      if (m) props.letterSpacing = m[2] === 'em' ? { unit: 'PERCENT', value: Number(m[1]) * 100 } : { unit: 'PX', value: Number(m[1]) };
    }
    return props;
  }
  return null;
}
