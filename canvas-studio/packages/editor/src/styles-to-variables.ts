// "Convert styles to variables" (FR-STY-003): every value of a style becomes a
// variable of a group named after it — a colour style one colour, a text style
// its family, size, weight, line height and letter spacing, a shadow its colour,
// offset, blur and spread, a grid its numbers. The style stays and its fields
// are bound to the new variables, so every layer keeps its style and every
// binding stays as it was; the values now switch with modes.
// Two steps: a plan (for a preview) and its application in one undo step.

import { fieldSpec, isVariable } from '#components';
import { tr, type Document, type NodeId, type StyleType, type VariableLiteral, type VariableScope, type VariableType } from '#core';
import type { Editor } from './editor.ts';

export interface PlannedVariable {
  /** Field of the style ("fills/0", "fontSize", "effects/0/radius"). */
  field: string;
  type: VariableType;
  /** Full name in the collection: "Heading/H1/font-size". */
  name: string;
  value: VariableLiteral;
  /** Where the variable is offered: what the style used it for (FR-VAR-023). */
  scopes: VariableScope[];
}

/** Scopes of a variable made from a style field: offered where the same kind of value goes. */
function scopesFor(field: string): VariableScope[] {
  if (field.startsWith('fills/')) return ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR'];
  if (/^effects\/\d+$/.test(field)) return ['EFFECT_COLOR'];
  if (field.startsWith('layoutGrids/')) return ['GRID'];
  const text: Record<string, VariableScope> = { fontFamily: 'FONT_FAMILY', fontSize: 'FONT_SIZE', fontWeight: 'FONT_WEIGHT', lineHeight: 'LINE_HEIGHT', letterSpacing: 'LETTER_SPACING', paragraphSpacing: 'PARAGRAPH_SPACING' };
  return text[field] ? [text[field]!] : [];
}

export interface StyleConversion {
  style: NodeId;
  styleName: string;
  styleType: StyleType;
  variables: PlannedVariable[];
  /** What stays a plain value of the style, and why (a gradient, line height in %). */
  kept: string[];
}

const join = (base: string, part: string) => (part ? `${base}/${part}` : base);

/** What converting the styles (all of the file by default) would create. */
export function planStylesToVariables(doc: Document, styles: readonly NodeId[] = doc.styles()): StyleConversion[] {
  const out: StyleConversion[] = [];
  for (const style of styles) {
    if (!doc.store.isAlive(style) || doc.type(style) !== 'STYLE') continue;
    const name = doc.get(style, 'name').split('/').map((s) => s.trim()).filter(Boolean).join('/') || tr('Стиль');
    const type = doc.get(style, 'styleType');
    const bound = doc.get(style, 'boundVariables') ?? {};
    const variables: PlannedVariable[] = [];
    const kept: string[] = [];
    const add = (field: string, part: string) => {
      const spec = fieldSpec(field);
      if (!spec) return;
      if (bound[field] && isVariable(doc, bound[field])) {
        kept.push(tr('{0} — уже из переменной «{1}»', spec.label, doc.get(bound[field]!, 'name')));
        return;
      }
      const value = spec.read(doc, style);
      if (value === undefined) return;
      variables.push({ field, type: spec.type, name: join(name, part), value, scopes: scopesFor(field) });
    };
    if (type === 'FILL') {
      const fills = doc.get(style, 'fills');
      const solid = fills.filter((p) => p.type === 'SOLID').length;
      fills.forEach((p, i) => {
        if (p.type === 'SOLID') add(`fills/${i}`, solid > 1 ? String(i + 1) : '');
        else kept.push(p.type === 'IMAGE' ? tr('Картинка — у переменных нет такого типа') : tr('Градиент — у переменных нет такого типа'));
      });
    } else if (type === 'TEXT') {
      add('fontFamily', 'font-family');
      add('fontSize', 'font-size');
      add('fontWeight', 'font-weight');
      if (doc.get(style, 'lineHeight').unit === 'PX') add('lineHeight', 'line-height');
      else kept.push(doc.get(style, 'lineHeight').unit === 'AUTO' ? tr('Межстрочный «Авто» — подбирается по шрифту') : tr('Межстрочный в процентах — переменная хранит пиксели'));
      add('letterSpacing', 'letter-spacing');
      if (doc.get(style, 'paragraphSpacing') !== 0) add('paragraphSpacing', 'paragraph-spacing');
    } else if (type === 'EFFECT') {
      const effects = doc.get(style, 'effects');
      effects.forEach((e, i) => {
        const prefix = effects.length > 1 ? `${i + 1}/` : '';
        if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
          add(`effects/${i}`, `${prefix}color`);
          add(`effects/${i}/offsetX`, `${prefix}x`);
          add(`effects/${i}/offsetY`, `${prefix}y`);
          add(`effects/${i}/radius`, `${prefix}blur`);
          add(`effects/${i}/spread`, `${prefix}spread`);
        } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') add(`effects/${i}/radius`, `${prefix}blur`);
        else kept.push(tr('Шум — у переменных нет такого типа'));
      });
    } else {
      const grids = doc.get(style, 'layoutGrids');
      grids.forEach((g, i) => {
        const prefix = grids.length > 1 ? `${i + 1}/` : '';
        for (const [key, part] of [['count', 'count'], ['gutterSize', 'gutter'], ['offset', 'margin'], ['sectionSize', 'size']] as const) {
          if (key in g) add(`layoutGrids/${i}/${key}`, `${prefix}${part}`);
        }
      });
    }
    if (variables.length > 0 || kept.length > 0) out.push({ style, styleName: name, styleType: type, variables, kept });
  }
  return out;
}

/**
 * Creates the variables in a collection (new or existing, by name) and binds
 * the styles' fields to them. A variable of the same name and type that is
 * already there is used as it is. One undo step; returns what was done.
 */
export function convertStylesToVariables(editor: Editor, plan: readonly StyleConversion[], collectionName: string): { collection: NodeId; created: number; bound: number } {
  const d = editor.doc;
  const wanted = collectionName.trim() || tr('Стили');
  let collection = d.collections().find((c) => d.get(c, 'name') === wanted && !d.get(c, 'extendsCollection')) ?? '';
  let created = 0;
  let bound = 0;
  editor.commit(tr('Преобразовать стили в переменные'), (tx) => {
    if (!collection) collection = tx.create('VARIABLE_COLLECTION', d.rootId, { name: wanted, modes: [{ id: d.ids.next(), name: tr('Режим 1') }] });
    const modes = d.get(collection, 'modes');
    const byName = new Map(d.children(collection).map((v) => [`${d.get(v, 'varType')}|${d.get(v, 'name').toLowerCase()}`, v]));
    for (const item of plan) {
      if (!d.store.isAlive(item.style)) continue;
      const next = { ...(d.get(item.style, 'boundVariables') ?? {}) };
      for (const p of item.variables) {
        const key = `${p.type}|${p.name.toLowerCase()}`;
        let v = byName.get(key);
        if (!v) {
          v = tx.create('VARIABLE', collection, { name: p.name, varType: p.type, scopes: [...p.scopes], varValues: Object.fromEntries(modes.map((m) => [m.id, structuredClone(p.value)])) });
          byName.set(key, v);
          created++;
        }
        next[p.field] = v;
        bound++;
      }
      tx.set(item.style, 'boundVariables', Object.keys(next).length > 0 ? next : null);
    }
  });
  return { collection, created, bound };
}
