// «Проверка по дизайн-системе» (step 6, Figma's Check designs): the values of the layers checked against the
// file's variables and styles, each finding with what to put instead and a fix in one click —
//   unbound  a value equal to a variable, not bound to it (one variable — bind; several — choose);
//   color    a colour from no variable or style: the nearest colour variable or fill style, when it is close;
//   number   a gap, padding, radius or stroke from no variable: the nearest number variable of its kind;
//   text     a text layer without a text style: the style of the same font, exact or the nearest size;
//   effect   a shadow or blur without a style when a style holds the same;
//   orphan   an instance whose component was deleted: bring it back.
// Layers inside instances are not checked: their values are the component's, fixed there. The share of values
// taken from the system is the report's headline.

import { colorToHex, isColorValue, tr, valueEquals, type Color, type NodeId, type Transaction, type VariableLiteral } from '#core';
import { applyStyleValues, BINDABLE_FIELDS, fieldSpec, isStyle, resolveVariable, restoreMainComponent, variableFits, type StyleBinding } from '#components';
import type { Editor } from './editor.ts';

export type CheckKind = 'unbound' | 'color' | 'number' | 'text' | 'effect' | 'orphan';

export type Fix = { kind: 'variable'; field: string; variable: NodeId } | { kind: 'style'; binding: StyleBinding; style: NodeId } | { kind: 'restore' };

export interface Suggestion {
  label: string;
  fix: Fix;
  /** Exactly the same value (else a near one: the look changes a little). */
  exact: boolean;
}

export interface Finding {
  kind: CheckKind;
  id: NodeId;
  /** What of the layer: «Заливка», «Отступ слева»… */
  what: string;
  /** The value now, as shown. */
  now: string;
  color?: Color;
  suggestions: Suggestion[];
}

export interface Report {
  findings: Finding[];
  /** Values looked at, and those already taken from the system. */
  checked: number;
  fromSystem: number;
  /** The file has variables or styles to check against. */
  hasSystem: boolean;
}

export const KIND_LABELS: Record<CheckKind, string> = {
  unbound: tr('Совпадает с переменной, но не привязано'),
  color: tr('Цвет не из системы'),
  number: tr('Число не из шкалы'),
  text: tr('Текст без стиля'),
  effect: tr('Эффект без стиля'),
  orphan: tr('Копия удалённого компонента'),
};

/** How far apart two colours look (0 — the same; ~20 — hardly told apart). */
function colorDistance(a: Color, b: Color): number {
  const dr = (a.r - b.r) * 255;
  const dg = (a.g - b.g) * 255;
  const db = (a.b - b.b) * 255;
  const da = (a.a - b.a) * 255;
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 + da * da * 0.5);
}

const NEAR_COLOR = 18;
const fmt = (v: VariableLiteral) => (isColorValue(v) ? colorToHex(v, (v as Color).a < 1) : typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));

/** The fields of a layer the check looks at: colours of paints, numbers of layout, radius and stroke. */
const NUMBER_FIELDS = new Set(['itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'strokeWeight']);
const LAYOUT_FIELDS = new Set(['itemSpacing', 'counterAxisSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom']);

export function checkDesign(editor: Editor, roots?: readonly NodeId[]): Report {
  const d = editor.doc;
  const vars = d.collections().flatMap((c) => [...d.children(c)]);
  const styles = (type: string) => [...d.children(d.rootId)].filter((s) => isStyle(d, s) && d.get(s, 'styleType') === type);
  const fillStyles = styles('FILL');
  const textStyles = styles('TEXT');
  const effectStyles = styles('EFFECT');
  const report: Report = { findings: [], checked: 0, fromSystem: 0, hasSystem: vars.length > 0 || fillStyles.length + textStyles.length + effectStyles.length > 0 };
  const visit = (id: NodeId) => {
    if (editor.isInstanceLayer(id)) return;
    const type = d.type(id);
    if (['PAGE', 'DOCUMENT', 'STYLE', 'VARIABLE', 'VARIABLE_COLLECTION'].includes(type)) return;
    if (type === 'INSTANCE') {
      const main = d.get(id, 'mainComponent');
      if (main && !d.store.isAlive(main)) report.findings.push({ kind: 'orphan', id, what: tr('Копия компонента'), now: d.get(id, 'name'), suggestions: [{ label: tr('Восстановить компонент'), fix: { kind: 'restore' }, exact: true }] });
    }
    const bound = d.get(id, 'boundVariables') ?? {};
    // Paints.
    for (const list of ['fills', 'strokes'] as const) {
      const paints = d.get(id, list);
      const styled = d.get(id, list === 'fills' ? 'fillStyleId' : 'strokeStyleId');
      paints.forEach((p, i) => {
        if (!p.visible || p.type !== 'SOLID') return;
        report.checked++;
        const field = `${list}/${i}`;
        if (bound[field] || styled) {
          report.fromSystem++;
          return;
        }
        const color = { ...p.color, a: p.color.a * p.opacity };
        const spec = fieldSpec(field);
        const fit = spec ? vars.filter((v) => variableFits(d, v, spec, type)) : [];
        const exact: NodeId[] = [];
        const near: { v: NodeId; dist: number }[] = [];
        for (const v of fit) {
          const r = resolveVariable(d, v, id);
          if (!isColorValue(r)) continue;
          const dist = colorDistance(r as Color, p.color);
          if (colorToHex(r as Color, true) === colorToHex(p.color, true)) exact.push(v);
          else if (dist < NEAR_COLOR) near.push({ v, dist });
        }
        const what = list === 'fills' ? tr('Заливка') : tr('Обводка');
        if (exact.length) {
          report.findings.push({ kind: 'unbound', id, what, now: colorToHex(color, color.a < 1), color, suggestions: exact.map((v) => ({ label: d.get(v, 'name'), fix: { kind: 'variable', field, variable: v }, exact: true })) });
          return;
        }
        const suggestions: Suggestion[] = near.sort((a, b) => a.dist - b.dist).slice(0, 3).map(({ v }) => ({ label: d.get(v, 'name'), fix: { kind: 'variable', field, variable: v }, exact: false }));
        // A fill style of one solid colour, the same or close.
        for (const s of fillStyles) {
          const sp = d.get(s, 'fills');
          if (sp.length !== 1 || sp[0]!.type !== 'SOLID') continue;
          const dist = colorDistance(sp[0]!.color, p.color);
          if (dist < NEAR_COLOR) suggestions.push({ label: tr('Стиль «{0}»', d.get(s, 'name')), fix: { kind: 'style', binding: list === 'fills' ? 'fillStyleId' : 'strokeStyleId', style: s }, exact: dist === 0 });
        }
        report.findings.push({ kind: 'color', id, what, now: colorToHex(color, color.a < 1), color, suggestions });
      });
    }
    // Numbers.
    for (const spec of BINDABLE_FIELDS) {
      if (!NUMBER_FIELDS.has(spec.field) || spec.type !== 'FLOAT') continue;
      // Only what shows: a stroke's weight with a visible stroke, gaps and padding of an adaptive layout.
      if (spec.field === 'strokeWeight' && !d.get(id, 'strokes').some((p) => p.visible)) continue;
      if (LAYOUT_FIELDS.has(spec.field) && (d.get(id, 'layoutMode') ?? 'NONE') === 'NONE') continue;
      if (spec.field === 'counterAxisSpacing' && !d.get(id, 'layoutWrap')) continue;
      const value = spec.read(d, id);
      if (typeof value !== 'number' || value === 0) continue;
      const fit = vars.filter((v) => variableFits(d, v, spec, type));
      if (fit.length === 0 && !bound[spec.field]) continue;
      report.checked++;
      if (bound[spec.field]) {
        report.fromSystem++;
        continue;
      }
      const values = fit.map((v) => ({ v, r: resolveVariable(d, v, id) })).filter((x): x is { v: NodeId; r: number } => typeof x.r === 'number');
      const exact = values.filter((x) => valueEquals(x.r, value));
      if (exact.length) {
        report.findings.push({ kind: 'unbound', id, what: spec.label, now: fmt(value), suggestions: exact.map((x) => ({ label: d.get(x.v, 'name'), fix: { kind: 'variable', field: spec.field, variable: x.v }, exact: true })) });
        continue;
      }
      const near = values
        .map((x) => ({ ...x, diff: Math.abs(x.r - value) }))
        .filter((x) => x.diff <= Math.max(2, value * 0.25))
        .sort((a, b) => a.diff - b.diff)
        .slice(0, 2);
      report.findings.push({ kind: 'number', id, what: spec.label, now: fmt(value), suggestions: near.map((x) => ({ label: `${d.get(x.v, 'name')} (${fmt(x.r)})`, fix: { kind: 'variable', field: spec.field, variable: x.v }, exact: false })) });
    }
    // Text styles.
    if (type === 'TEXT' && textStyles.length) {
      report.checked++;
      if (d.get(id, 'textStyleId')) report.fromSystem++;
      else {
        const family = d.get(id, 'fontFamily');
        const size = d.get(id, 'fontSize');
        const weight = d.get(id, 'fontWeight');
        const same = textStyles.filter((s) => d.get(s, 'fontFamily') === family && d.get(s, 'fontWeight') === weight);
        const exact = same.filter((s) => d.get(s, 'fontSize') === size && valueEquals(d.get(s, 'lineHeight'), d.get(id, 'lineHeight')));
        const near = same
          .filter((s) => !exact.includes(s) && Math.abs(d.get(s, 'fontSize') - size) <= 2)
          .sort((a, b) => Math.abs(d.get(a, 'fontSize') - size) - Math.abs(d.get(b, 'fontSize') - size));
        report.findings.push({
          kind: 'text',
          id,
          what: tr('Текст'),
          now: `${family} ${size}/${weight}`,
          suggestions: [...exact, ...near].slice(0, 3).map((s) => ({ label: tr('Стиль «{0}»', d.get(s, 'name')), fix: { kind: 'style', binding: 'textStyleId', style: s }, exact: exact.includes(s) })),
        });
      }
    }
    // Effect styles.
    const effects = d.get(id, 'effects').filter((e) => e.visible);
    if (effects.length && effectStyles.length) {
      report.checked++;
      if (d.get(id, 'effectStyleId')) report.fromSystem++;
      else {
        const match = effectStyles.filter((s) => valueEquals(d.get(s, 'effects').filter((e) => e.visible), effects));
        report.findings.push({ kind: 'effect', id, what: tr('Эффекты'), now: tr('{0} шт.', effects.length), suggestions: match.map((s) => ({ label: tr('Стиль «{0}»', d.get(s, 'name')), fix: { kind: 'style', binding: 'effectStyleId', style: s }, exact: true })) });
      }
    }
  };
  const starts = roots && roots.length ? roots : [editor.pageId];
  for (const r of starts) {
    visit(r);
    d.store.walk(r, (id) => {
      visit(id);
      return !editor.isInstanceLayer(id) && d.type(id) !== 'INSTANCE';
    });
  }
  return report;
}

/** Puts a suggestion in (inside the caller's transaction). */
export function applyFix(editor: Editor, tx: Transaction, finding: Finding, fix: Fix): void {
  const d = editor.doc;
  const id = finding.id;
  if (!d.store.isAlive(id)) return;
  if (fix.kind === 'variable') {
    tx.set(id, 'boundVariables', { ...(d.get(id, 'boundVariables') ?? {}), [fix.field]: fix.variable });
  } else if (fix.kind === 'style') {
    tx.set(id, fix.binding, fix.style);
    applyStyleValues(d, tx, id, fix.binding, fix.style);
  } else {
    const b = editor.scene.bounds(id);
    restoreMainComponent(d, tx, id, { parent: editor.pageId, x: Math.round(b.x + b.width + 80), y: Math.round(b.y) });
  }
}

/** The fixes of many findings in one undo step: each takes its first exact suggestion (near ones are a choice). */
export function fixAll(editor: Editor, findings: readonly Finding[]): number {
  const sure = findings.filter((f) => f.suggestions.length > 0 && f.suggestions[0]!.exact && (f.kind !== 'unbound' || f.suggestions.length === 1));
  if (!sure.length) return 0;
  editor.commit(tr('Исправить по дизайн-системе'), (tx) => {
    for (const f of sure) applyFix(editor, tx, f, f.suggestions[0]!.fix);
  });
  return sure.length;
}
