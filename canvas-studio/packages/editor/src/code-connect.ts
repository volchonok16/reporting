// Code Connect (step 7): a component carries its real code from the team's
// repository as a template, and every instance shows that code filled in with
// its own variant and properties — `<Button variant="primary" disabled>Купить</Button>`
// instead of generated CSS. Figma links it from the repository with a CLI; here
// the template is pasted once on the component (or its variant set) in the
// «Код» tab, with the path or link to the file. Pure functions; the panel is
// in ui/code-panel.ts.
//
// Template: `{{Имя}}` — a variant axis or a component property by its name
// (case and spaces do not matter); `{{#Имя}}…{{/Имя}}` — kept when it is on;
// `{{^Имя}}…{{/Имя}}` — kept when it is off. Unknown names stay as written, so a
// typo is seen, not silently dropped.

import { tr, type CodeConnect, type Document, type NodeId } from '#core';
import { componentSetOf, instancePropertyValue, parseVariantName, propertyDefs, variantAxes } from '#components';
import type { Editor } from './editor.ts';

export const CODE_LANGUAGES: { id: string; label: string }[] = [
  { id: 'tsx', label: 'React (TSX)' },
  { id: 'jsx', label: 'React (JSX)' },
  { id: 'vue', label: 'Vue' },
  { id: 'svelte', label: 'Svelte' },
  { id: 'angular', label: 'Angular' },
  { id: 'html', label: 'HTML' },
  { id: 'swift', label: 'SwiftUI' },
  { id: 'kotlin', label: 'Jetpack Compose' },
  { id: 'dart', label: 'Flutter' },
];

const MAX_TEMPLATE = 20_000;
const MAX_SOURCE = 2000;
const OFF = new Set(['false', 'no', 'off', 'нет', 'выкл', '0', '']);

/** The component (or variant set) whose code an instance, a variant or a set shows; null — none of these. */
export function connectOwner(doc: Document, id: NodeId): NodeId | null {
  if (!doc.store.isAlive(id)) return null;
  const type = doc.type(id);
  let component: NodeId | null = null;
  if (type === 'INSTANCE') {
    const main = doc.get(id, 'mainComponent');
    component = typeof main === 'string' && doc.store.isAlive(main) ? main : null;
  } else if (type === 'COMPONENT') component = id;
  else if (type === 'COMPONENT_SET') return id;
  if (!component) return null;
  return componentSetOf(doc, component) ?? component;
}

/** The connected code of an owner, whatever a file put there; null — none. */
export function codeConnectOf(doc: Document, owner: NodeId | null): CodeConnect | null {
  if (!owner || !doc.store.isAlive(owner)) return null;
  const raw = doc.get(owner, 'codeConnect') as unknown;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const template = typeof r.template === 'string' ? r.template.slice(0, MAX_TEMPLATE) : '';
  if (!template.trim()) return null;
  const language = typeof r.language === 'string' && CODE_LANGUAGES.some((l) => l.id === r.language) ? r.language : 'tsx';
  const source = typeof r.source === 'string' ? r.source.slice(0, MAX_SOURCE) : '';
  return { template, language, source };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The values a layer gives the template: variant axes and component properties by name. */
export function connectValues(doc: Document, id: NodeId): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  if (!doc.store.isAlive(id)) return out;
  const type = doc.type(id);
  let component: NodeId | null = null;
  if (type === 'INSTANCE') component = (doc.get(id, 'mainComponent') as NodeId | null) ?? null;
  else if (type === 'COMPONENT') component = id;
  else if (type === 'COMPONENT_SET') component = doc.children(id).find((c) => doc.type(c) === 'COMPONENT') ?? null;
  if (!component || !doc.store.isAlive(component)) return out;
  const set = componentSetOf(doc, component);
  if (set) {
    const own = parseVariantName(String(doc.get(component, 'name') ?? ''));
    for (const axis of variantAxes(doc, set)) out.set(norm(axis.name), own[axis.name] ?? axis.values[0] ?? '');
  }
  for (const def of propertyDefs(doc, component)) {
    // An instance — its own value; a component — what its layers hold.
    let value: string | boolean | null = null;
    if (type === 'INSTANCE') value = instancePropertyValue(doc, id, def);
    else {
      doc.store.walk(component, (n) => {
        if (value !== null) return false;
        const refs = doc.get(n, 'propRefs');
        if (refs?.characters === def.id) value = doc.get(n, 'characters');
        else if (refs?.visible === def.id) value = doc.get(n, 'visible');
        else if (refs?.mainComponent === def.id) value = doc.get(n, 'mainComponent');
        return true;
      });
    }
    if (value === null) continue;
    // A swap: the swapped-in component's name.
    if (def.type === 'INSTANCE_SWAP' && typeof value === 'string') value = doc.store.isAlive(value) ? String(doc.get(value, 'name') ?? '') : '';
    out.set(norm(def.name), value);
  }
  return out;
}

const isOn = (v: string | boolean | undefined) => (typeof v === 'boolean' ? v : v !== undefined && !OFF.has(norm(v)));

/** The template filled in with values. */
export function fillTemplate(template: string, values: ReadonlyMap<string, string | boolean>): string {
  // Sections first (innermost first), then plain names.
  let text = template;
  const section = /\{\{([#^])\s*([^{}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
  for (let guard = 0; guard < 500; guard++) {
    const m = section.exec(text);
    if (!m) break;
    const key = norm(m[2]!);
    const known = values.has(key);
    const keep = known ? (m[1] === '#' ? isOn(values.get(key)) : !isOn(values.get(key))) : true;
    text = text.slice(0, m.index) + (keep ? m[3]! : '') + text.slice(m.index + m[0].length);
  }
  return text.replace(/\{\{\s*([^{}#^/][^{}]*?)\s*\}\}/g, (all, name: string) => {
    const v = values.get(norm(name));
    return v === undefined ? all : String(v);
  });
}

/** The connected code a layer shows, filled in; null — its component has none. */
export function connectedCode(doc: Document, id: NodeId): { code: string; connect: CodeConnect; owner: NodeId } | null {
  const owner = connectOwner(doc, id);
  const connect = codeConnectOf(doc, owner);
  if (!owner || !connect) return null;
  return { code: fillTemplate(connect.template, connectValues(doc, id)), connect, owner };
}

/** Names a template of this owner may use: its variant axes and properties. */
export function connectNames(doc: Document, owner: NodeId): string[] {
  const first = doc.type(owner) === 'COMPONENT_SET' ? doc.children(owner).find((c) => doc.type(c) === 'COMPONENT') : owner;
  if (!first) return [];
  const names: string[] = [];
  if (doc.type(owner) === 'COMPONENT_SET') for (const a of variantAxes(doc, owner)) names.push(a.name);
  for (const def of propertyDefs(doc, first)) names.push(def.name);
  return [...new Set(names)];
}

/** Saves (or, with an empty template, removes) the connected code of an owner — one undo step. */
export function setCodeConnect(editor: Editor, owner: NodeId, value: CodeConnect | null): void {
  const doc = editor.doc;
  if (doc.readOnly || !doc.store.isAlive(owner)) return;
  const next = value && value.template.trim() ? { template: value.template.slice(0, MAX_TEMPLATE), language: value.language, source: value.source.trim().slice(0, MAX_SOURCE) } : null;
  const now = codeConnectOf(doc, owner);
  if (JSON.stringify(now) === JSON.stringify(next)) return;
  editor.commit(next ? tr('Код из репозитория') : tr('Убрать код из репозитория'), (tx) => tx.set(owner, 'codeConnect', next));
}

/** A first template for a component: its name as a tag, axes and properties as attributes. */
export function starterTemplate(doc: Document, owner: NodeId): string {
  const tag = String(doc.get(owner, 'name') ?? 'Component')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('') || 'Component';
  const first = doc.type(owner) === 'COMPONENT_SET' ? doc.children(owner).find((c) => doc.type(c) === 'COMPONENT') : owner;
  const attrs: string[] = [];
  let children = '';
  if (doc.type(owner) === 'COMPONENT_SET') for (const a of variantAxes(doc, owner)) attrs.push(`${camel(a.name)}="{{${a.name}}}"`);
  if (first) {
    for (const def of propertyDefs(doc, first)) {
      if (def.type === 'BOOLEAN') attrs.push(`{{#${def.name}}}${camel(def.name)}{{/${def.name}}}`);
      else if (def.type === 'TEXT' && !children) children = `{{${def.name}}}`;
      else attrs.push(`${camel(def.name)}="{{${def.name}}}"`);
    }
  }
  const open = [tag, ...attrs].join(' ');
  return children ? `<${open}>${children}</${tag}>` : `<${open} />`;
}

function camel(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join('') || 'prop';
}
