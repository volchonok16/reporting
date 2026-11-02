// Styles (section 11, FR-STY): named, reusable values kept as STYLE nodes under
// the document root, next to the pages.
//
// A layer bound to a style keeps a copy of the style's values in its ordinary
// props and the style's id in a binding prop (fillStyleId, …). Everything that
// reads a layer (renderer, export, layout, hit testing) therefore needs no
// knowledge of styles, and the binding only matters for editing:
//  - binding a layer copies the style's values into it;
//  - editing a style writes its new values into every bound layer, in the same
//    transaction (one undo step, the same ops for other participants);
//  - changing a bound value on the layer by any route detaches it (the values
//    stay, the binding is cleared) — as "Detach style" in Figma;
//  - deleting a style detaches its layers; undo restores both.
// The pipeline runs this before overrides and instance sync, so styles applied
// inside instances become overrides and component edits reach instances.

import { cloneValue, TEXT_STYLE_KEYS, valueEquals, type Document, type NodeId, type NodeProps, type NodeType, type PropKey, type StyleType, type TextRun, type Transaction } from '#core';

export type StyleBinding = 'fillStyleId' | 'strokeStyleId' | 'effectStyleId' | 'textStyleId' | 'gridStyleId';

interface BindingSpec {
  binding: StyleBinding;
  styleType: StyleType;
  /** Layer props the style defines. */
  keys: readonly PropKey[];
  /** Layer values from the style. */
  values(doc: Document, style: NodeId): Partial<NodeProps>;
  accepts(type: NodeType): boolean;
  /** Layer field a style's variable binding maps to ("fills/0" → "strokes/0" for strokes), or null. */
  mapField(styleField: string): string | null;
  /** Whether a layer's variable binding belongs to this style binding. */
  ownsField(layerField: string): boolean;
}

const TEXT_FIELDS: ReadonlySet<string> = new Set(TEXT_STYLE_KEYS);

const NO_PAINT: ReadonlySet<NodeType> = new Set(['DOCUMENT', 'PAGE', 'GROUP', 'STYLE']);

export const BINDINGS: readonly BindingSpec[] = [
  {
    binding: 'fillStyleId',
    styleType: 'FILL',
    keys: ['fills'],
    values: (doc, s) => ({ fills: doc.get(s, 'fills') }),
    accepts: (t) => !NO_PAINT.has(t),
    mapField: (f) => (f.startsWith('fills/') ? f : null),
    ownsField: (f) => f.startsWith('fills/'),
  },
  {
    binding: 'strokeStyleId',
    styleType: 'FILL',
    keys: ['strokes'],
    values: (doc, s) => ({ strokes: doc.get(s, 'fills') }),
    accepts: (t) => !NO_PAINT.has(t),
    mapField: (f) => (f.startsWith('fills/') ? `strokes/${f.slice(6)}` : null),
    ownsField: (f) => f.startsWith('strokes/'),
  },
  {
    binding: 'effectStyleId',
    styleType: 'EFFECT',
    keys: ['effects'],
    values: (doc, s) => ({ effects: doc.get(s, 'effects') }),
    accepts: (t) => t !== 'DOCUMENT' && t !== 'PAGE' && t !== 'STYLE',
    mapField: (f) => (f.startsWith('effects/') ? f : null),
    ownsField: (f) => f.startsWith('effects/'),
  },
  {
    binding: 'textStyleId',
    styleType: 'TEXT',
    keys: TEXT_STYLE_KEYS,
    values: (doc, s) => Object.fromEntries(TEXT_STYLE_KEYS.map((k) => [k, doc.get(s, k)])) as Partial<NodeProps>,
    accepts: (t) => t === 'TEXT',
    mapField: (f) => (TEXT_FIELDS.has(f) ? f : null),
    ownsField: (f) => TEXT_FIELDS.has(f),
  },
  {
    binding: 'gridStyleId',
    styleType: 'GRID',
    keys: ['layoutGrids'],
    values: (doc, s) => ({ layoutGrids: doc.get(s, 'layoutGrids') }),
    accepts: (t) => t === 'FRAME' || t === 'COMPONENT' || t === 'COMPONENT_SET' || t === 'INSTANCE',
    mapField: (f) => (f.startsWith('layoutGrids/') ? f : null),
    ownsField: (f) => f.startsWith('layoutGrids/'),
  },
];

/** Variable bindings a style gives a layer (FR-STY-002: values inside a style can come from variables). */
function styleFieldBindings(doc: Document, spec: BindingSpec, style: NodeId): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, v] of Object.entries(doc.get(style, 'boundVariables') ?? {})) {
    const mapped = spec.mapField(field);
    if (mapped) out[mapped] = v;
  }
  return out;
}

function layerFieldBindings(doc: Document, spec: BindingSpec, layer: NodeId): Record<string, string> {
  return Object.fromEntries(Object.entries(doc.get(layer, 'boundVariables') ?? {}).filter(([f]) => spec.ownsField(f)));
}

/** A value with the parts that come from variables blanked (they differ legitimately by mode). */
function withoutBound(key: string, value: unknown, bound: Record<string, string>): unknown {
  if (Array.isArray(value) && (key === 'fills' || key === 'strokes' || key === 'effects')) {
    return value.map((item, i) => {
      if (!item || typeof item !== 'object') return item;
      const copy: Record<string, unknown> = { ...item };
      if (bound[`${key}/${i}`]) copy.color = null;
      // Numbers of an effect from variables (FR-STY-003).
      if (key === 'effects') {
        for (const f of ['radius', 'spread']) if (bound[`effects/${i}/${f}`]) copy[f] = null;
        if (bound[`effects/${i}/offsetX`] || bound[`effects/${i}/offsetY`]) {
          const o = (copy.offset ?? {}) as Record<string, unknown>;
          copy.offset = { x: bound[`effects/${i}/offsetX`] ? null : o.x, y: bound[`effects/${i}/offsetY`] ? null : o.y };
        }
      }
      return copy;
    });
  }
  if (Array.isArray(value) && key === 'layoutGrids') {
    return value.map((item, i) => {
      if (!item || typeof item !== 'object') return item;
      const copy: Record<string, unknown> = { ...item };
      for (const f of ['count', 'gutterSize', 'offset', 'sectionSize']) if (bound[`layoutGrids/${i}/${f}`]) copy[f] = null;
      return copy;
    });
  }
  return bound[key] ? null : value;
}

export function bindingSpec(binding: StyleBinding): BindingSpec {
  return BINDINGS.find((b) => b.binding === binding)!;
}

/** Style props that matter for each style type (what an edit of the style changes). */
export function styleValueKeys(type: StyleType): readonly PropKey[] {
  return type === 'FILL' ? ['fills', 'boundVariables'] : type === 'EFFECT' ? ['effects', 'boundVariables'] : type === 'GRID' ? ['layoutGrids', 'boundVariables'] : [...TEXT_STYLE_KEYS, 'boundVariables'];
}

export function isStyle(doc: Document, id: string | null | undefined): id is NodeId {
  return !!id && doc.store.isAlive(id) && doc.type(id) === 'STYLE';
}

/** Whether `binding` may point at `style`. */
export function canBind(doc: Document, layer: NodeId, binding: StyleBinding, style: NodeId): boolean {
  const spec = bindingSpec(binding);
  return isStyle(doc, style) && doc.get(style, 'styleType') === spec.styleType && spec.accepts(doc.type(layer));
}

/** True when the layer's values equal the style's. */
export function matchesStyle(doc: Document, layer: NodeId, binding: StyleBinding, style: NodeId): boolean {
  const spec = bindingSpec(binding);
  const bound = styleFieldBindings(doc, spec, style);
  if (!valueEquals(layerFieldBindings(doc, spec, layer), bound)) return false;
  const values = spec.values(doc, style);
  return Object.entries(values).every(([k, v]) => valueEquals(withoutBound(k, doc.get(layer, k as PropKey), bound), withoutBound(k, v, bound)));
}

/** Text runs without the character props a text style defines (the style applies to the whole text). */
function stripRuns(runs: readonly TextRun[]): TextRun[] {
  const owned = new Set<string>(TEXT_STYLE_KEYS);
  return runs
    .map((r) => ({ ...r, style: Object.fromEntries(Object.entries(r.style).filter(([k]) => !owned.has(k))) }))
    .filter((r) => Object.keys(r.style).length > 0);
}

/** Copies the style's values into a layer; returns the props it wrote. */
export function applyStyleValues(doc: Document, tx: Transaction, layer: NodeId, binding: StyleBinding, style: NodeId): PropKey[] {
  const written: PropKey[] = [];
  const spec = bindingSpec(binding);
  // Variable bindings travel with the style; the pipeline resolves them in the layer's mode.
  const current = doc.get(layer, 'boundVariables') ?? {};
  const merged = { ...Object.fromEntries(Object.entries(current).filter(([f]) => !spec.ownsField(f))), ...styleFieldBindings(doc, spec, style) };
  const nextBound = Object.keys(merged).length > 0 ? merged : null;
  if (!valueEquals(doc.get(layer, 'boundVariables'), nextBound)) {
    tx.set(layer, 'boundVariables', nextBound);
    written.push('boundVariables');
  }
  for (const [k, v] of Object.entries(spec.values(doc, style))) {
    const key = k as PropKey;
    if (valueEquals(doc.get(layer, key), v)) continue;
    tx.set(layer, key, cloneValue(v) as never);
    written.push(key);
  }
  if (binding === 'textStyleId') {
    const runs = doc.get(layer, 'textRuns');
    const stripped = stripRuns(runs);
    if (!valueEquals(runs, stripped)) {
      tx.set(layer, 'textRuns', stripped);
      written.push('textRuns');
    }
  }
  return written;
}

/** Every live layer bound to `style` (any page, including inside components and instances). */
export function styleUsers(doc: Document, style: NodeId, binding?: StyleBinding): { id: NodeId; binding: StyleBinding }[] {
  const out: { id: NodeId; binding: StyleBinding }[] = [];
  for (const page of doc.pages()) {
    doc.store.walk(page, (id) => {
      for (const b of BINDINGS) {
        if (binding && b.binding !== binding) continue;
        if (doc.get(id, b.binding) === style) out.push({ id, binding: b.binding });
      }
    });
  }
  return out;
}

/** Bindings that point at `style`, with or without a live style (for detaching after deletion). */
function boundTo(doc: Document, style: NodeId): { id: NodeId; binding: StyleBinding }[] {
  return styleUsers(doc, style);
}

/**
 * Keeps bindings and values consistent after a local edit.
 * `changed` holds the user's changes (node → props); keys this step writes on
 * behalf of the user (values copied when binding, the binding cleared when
 * detaching) are added to it so instance layers record them as overrides.
 */
export function syncStyles(doc: Document, tx: Transaction, changed: Map<NodeId, Set<PropKey>>): void {
  const editedStyles = new Set<NodeId>();
  const created = tx.changes.created;
  const entries = [...changed];
  for (const id of created) if (!changed.has(id)) entries.push([id, new Set()]);
  for (const [id, keys] of entries) {
    if (!doc.store.has(id)) continue;
    if (doc.type(id) === 'STYLE') {
      const valueKeys = styleValueKeys(doc.get(id, 'styleType'));
      if (keys.has('deleted') || keys.has('styleType') || valueKeys.some((k) => keys.has(k))) editedStyles.add(id);
      continue;
    }
    if (!doc.store.isAlive(id)) continue;
    const isNew = created.has(id);
    for (const spec of BINDINGS) {
      const style = doc.get(id, spec.binding);
      if (style === null) continue;
      const mark = (k: PropKey) => {
        let set = changed.get(id);
        if (!set) changed.set(id, (set = new Set()));
        set.add(k);
      };
      if (!canBind(doc, id, spec.binding, style)) {
        // A missing style (deleted, pasted from another file) or a wrong kind: keep the values, drop the link.
        tx.set(id, spec.binding, null);
        mark(spec.binding);
        continue;
      }
      if (keys.has(spec.binding) || isNew) {
        for (const k of applyStyleValues(doc, tx, id, spec.binding, style)) mark(k);
      } else if ((spec.keys.some((k) => keys.has(k)) || keys.has('boundVariables')) && !matchesStyle(doc, id, spec.binding, style)) {
        // The value was edited directly: detach (the edited value stays).
        tx.set(id, spec.binding, null);
        mark(spec.binding);
      }
    }
  }
  for (const style of editedStyles) {
    const alive = isStyle(doc, style);
    for (const { id, binding } of boundTo(doc, style)) {
      if (!alive || !canBind(doc, id, binding, style)) tx.set(id, binding, null);
      else applyStyleValues(doc, tx, id, binding, style);
    }
  }
}

/** Display name parts: "Brand/Primary/500" → folders ["Brand", "Primary"] and name "500". */
export function splitStyleName(name: string): { folders: string[]; name: string } {
  const parts = name.split('/').map((p) => p.trim()).filter(Boolean);
  return { folders: parts.slice(0, -1), name: parts[parts.length - 1] ?? name };
}
