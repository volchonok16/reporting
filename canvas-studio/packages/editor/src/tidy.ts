// "Tidy up" (✦ «Привести в порядок»): the routine a designer does before
// handing a file over, in one undo step —
//   names    layers named by what they are («Rectangle 23» → «Кнопка»);
//   pixels   positions and sizes on whole pixels (120.37 after scaling or an import);
//   spacing  auto layout gaps and paddings 1 px off the 4-grid onto it (7 → 8,
//            13 → 12); 10 or 6 look meant and stay;
//   bind     values equal to exactly one variable bound to it.
// The plan is counted first: the menu says what will happen, and offers it
// only when there is something to do.

import { plural, tr, type NodeId } from '#core';
import { suggestNames } from './auto-name.ts';
import type { Editor } from './editor.ts';

const SPACING = ['itemSpacing', 'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
/** Types whose own size is set by hand (a group's or a text's comes from its content). */
const SIZED = new Set(['FRAME', 'COMPONENT', 'RECTANGLE', 'ELLIPSE', 'SECTION', 'POLYGON', 'STAR']);

export interface TidyPlan {
  names: Map<NodeId, string>;
  /** Property changes: whole pixels and the 4-grid. */
  pixels: { id: NodeId; key: 'x' | 'y' | 'width' | 'height'; value: number }[];
  spacing: { id: NodeId; key: (typeof SPACING)[number]; value: number }[];
  /** Values that bind to exactly one variable. */
  bind: number;
}

const offGrid = (v: number) => Math.abs(v - Math.round(v)) > 0.01;

/** 1 px off a multiple of 4 → onto it; anything else stays (0, 4, 8, 10, 6…). */
export function snapSpacing(v: number): number | null {
  if (v <= 0 || !Number.isInteger(v)) return null;
  const r = v % 4;
  if (r === 1) return v - 1 || null;
  if (r === 3) return v + 1;
  return null;
}

export function planTidy(editor: Editor, roots: readonly NodeId[]): TidyPlan {
  const d = editor.doc;
  const plan: TidyPlan = { names: suggestNames(d, roots), pixels: [], spacing: [], bind: 0 };
  const visit = (id: NodeId) => {
    if (editor.isInstanceLayer(id)) return;
    const type = d.type(id);
    if (!editor.inAutoLayoutParent(id)) {
      for (const key of ['x', 'y'] as const) {
        const v = d.get(id, key) as number;
        if (offGrid(v)) plan.pixels.push({ id, key, value: Math.round(v) });
      }
    }
    if (SIZED.has(type)) {
      for (const key of ['width', 'height'] as const) {
        const sizing = d.get(id, key === 'width' ? 'sizingH' : 'sizingV') as { mode: string };
        const v = d.get(id, key) as number;
        if (sizing.mode === 'FIXED' && offGrid(v) && Math.round(v) > 0) plan.pixels.push({ id, key, value: Math.round(v) });
      }
    }
    if ((type === 'FRAME' || type === 'COMPONENT') && d.get(id, 'layoutMode') !== 'NONE') {
      for (const key of SPACING) {
        const v = snapSpacing(d.get(id, key) as number);
        if (v !== null) plan.spacing.push({ id, key, value: v });
      }
    }
    if (type !== 'INSTANCE') for (const c of d.children(id)) visit(c);
  };
  roots.forEach(visit);
  if (d.collections().length > 0) plan.bind = editor.variables.findUnbound(roots).filter((f) => f.variables.length === 1).length;
  return plan;
}

/** How many kinds of work the plan has (the menu offers «Привести в порядок» from two). */
export function tidyKinds(plan: TidyPlan): number {
  return [plan.names.size, plan.pixels.length, plan.spacing.length, plan.bind].filter((n) => n > 0).length;
}

/** The plan in words: «9 имён, 4 дробных пикселя, 2 отступа, 6 привязок к переменным»; '' — nothing to do. */
export function tidySummary(plan: TidyPlan): string {
  const parts: string[] = [];
  const n = plan.names.size;
  if (n) parts.push(`${n} ${plural(n, tr('имя'), tr('имени'), tr('имён'))}`);
  const p = plan.pixels.length;
  if (p) parts.push(`${p} ${plural(p, tr('дробный пиксель'), tr('дробных пикселя'), tr('дробных пикселей'))}`);
  const s = plan.spacing.length;
  if (s) parts.push(`${s} ${plural(s, tr('отступ'), tr('отступа'), tr('отступов'))}`);
  const b = plan.bind;
  if (b) parts.push(`${b} ${plural(b, tr('привязка к переменным'), tr('привязки к переменным'), tr('привязок к переменным'))}`);
  return parts.join(', ');
}

/** Does the plan in one undo step; returns it as done. */
export function applyTidy(editor: Editor, roots: readonly NodeId[]): TidyPlan {
  const plan = planTidy(editor, roots);
  editor.commit(tr('Привести в порядок'), (tx) => {
    for (const [id, name] of plan.names) tx.set(id, 'name', name);
    for (const p of plan.pixels) tx.set(p.id, p.key, p.value);
    for (const p of plan.spacing) tx.set(p.id, p.key, p.value);
    // Its own commit joins this one: one step to undo.
    if (plan.bind > 0) editor.variables.bindUnbound(roots);
  });
  return plan;
}
