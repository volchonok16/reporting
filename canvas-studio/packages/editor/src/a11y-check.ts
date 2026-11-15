// «Проверка доступности» (other editors, item 3; as the Stark plugin): what makes a screen hard to use, found by
// rules, no network —
//   contrast  text against what lies under it below WCAG AA (4.5:1, large text 3:1); fixed in one click;
//   small     text under 12 px;
//   target    something to press (a click in the prototype, or the role «Кнопка» / «Ссылка») smaller than the
//             chosen size: 24 px (WCAG 2.2 AA), 44 px (Apple), 48 px (Android);
//   image     a picture a screen reader would announce without a description.
// And the reading order of a frame for a screen reader — the same order the prototype's screen reader mode reads.
// Pure over the document and the scene: the panel shows the report, the canvas draws the numbers.

import { tr, type NodeId } from '#core';
import type { Editor } from './editor.ts';
import { a11yItems, flatItems, spoken, type A11yItem } from './prototype/a11y.ts';
import { contrastIssues, type ContrastIssue } from './smart-ops.ts';

export type A11yCheckKind = 'contrast' | 'small' | 'target' | 'image';

export interface A11yFinding {
  kind: A11yCheckKind;
  id: NodeId;
  /** The value now, as shown: «2,8 : 1 (нужно 4,5)», «10 px», «32 × 20». */
  now: string;
  /** Contrast: the colour that passes, when the text's own colour may be changed. */
  contrast?: ContrastIssue;
}

export interface A11yReport {
  findings: A11yFinding[];
  /** Texts, things to press and pictures looked at. */
  checked: number;
}

export const A11Y_KIND_LABELS: Record<A11yCheckKind, string> = {
  contrast: tr('Низкий контраст'),
  small: tr('Мелкий текст'),
  target: tr('Маленькая область нажатия'),
  image: tr('Картинка без описания'),
};

/** Sizes a thing to press should reach, by guideline. */
export const TARGET_SIZES: readonly (readonly [number, string])[] = [
  [24, 'WCAG 2.2'],
  [44, 'iOS'],
  [48, 'Android'],
];

/** Text below this is hard to read on a screen. */
export const SMALL_TEXT = 12;

const PRESS = new Set(['ON_CLICK', 'MOUSE_DOWN', 'MOUSE_UP', 'ON_PRESS']);

const num = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

function shown(editor: Editor, id: NodeId): boolean {
  const d = editor.doc;
  return d.get(id, 'visible') !== false && d.get(id, 'opacity') > 0;
}

/** A layer one presses: a click (or press) in the prototype, or the role «Кнопка» / «Ссылка». */
export function isPressable(editor: Editor, id: NodeId): boolean {
  const d = editor.doc;
  const role = d.get(id, 'a11yRole');
  if (role === 'BUTTON' || role === 'LINK') return true;
  if (role === 'DECORATIVE') return false;
  return d.get(id, 'reactions').some((r) => PRESS.has(r.trigger.type) && r.actions.length > 0);
}

/** The smallest font size of a text, its coloured or resized parts included. */
function smallestFont(editor: Editor, id: NodeId): number {
  const d = editor.doc;
  let size = d.get(id, 'fontSize');
  for (const r of d.get(id, 'textRuns')) if (typeof r.style.fontSize === 'number' && r.end > r.start) size = Math.min(size, r.style.fontSize);
  return size;
}

/** Top-level frames the check covers: the selection's (or the page's) frames; loose layers count by themselves. */
function rootsOf(editor: Editor, roots?: readonly NodeId[]): NodeId[] {
  return (roots ?? [...editor.doc.children(editor.pageId)]).filter((id) => editor.doc.store.isAlive(id));
}

export function checkAccessibility(editor: Editor, roots?: readonly NodeId[], target = 44): A11yReport {
  const d = editor.doc;
  const list = rootsOf(editor, roots);
  const report: A11yReport = { findings: [], checked: 0 };
  // Decorative text (role «Не читать», or inside such a layer) is exempt from contrast, as in WCAG 1.4.3.
  const decorative = (id: NodeId): boolean => {
    for (let n: NodeId | null = id; n && n !== editor.pageId; n = d.parent(n)) if (d.get(n, 'a11yRole') === 'DECORATIVE') return true;
    return false;
  };
  for (const issue of contrastIssues(editor, list)) {
    if (decorative(issue.id)) continue;
    report.findings.push({ kind: 'contrast', id: issue.id, now: tr('{0} : 1 (нужно {1})', num(issue.ratio), num(issue.need)), contrast: issue });
  }
  const visit = (id: NodeId) => {
    if (!shown(editor, id)) return;
    if (d.get(id, 'a11yRole') === 'DECORATIVE') return;
    if (d.type(id) === 'TEXT') {
      if (!String(d.get(id, 'characters') ?? '').trim()) return;
      report.checked++;
      const size = smallestFont(editor, id);
      if (size < SMALL_TEXT) report.findings.push({ kind: 'small', id, now: `${num(size)} px` });
    }
    if (isPressable(editor, id)) {
      report.checked++;
      const b = editor.scene.bounds(id);
      if (b.width < target || b.height < target) report.findings.push({ kind: 'target', id, now: `${num(b.width)} × ${num(b.height)}` });
    }
    for (const c of d.children(id)) visit(c);
  };
  list.forEach(visit);
  const rect = (n: NodeId) => editor.scene.bounds(n);
  for (const root of list) {
    for (const item of flatItems(a11yItems(d, root, rect, d.type(root) !== 'TEXT'))) {
      if (item.kind !== 'image') continue;
      report.checked++;
      if (item.unlabeled) report.findings.push({ kind: 'image', id: item.id, now: tr('прочтёт «Изображение, без описания»') });
    }
  }
  return report;
}

export interface ReadingStep {
  item: A11yItem;
  /** What the screen reader says. */
  said: string;
}

/** What a screen reader reads on a frame, one step per item, groups opened. */
export function readingSteps(editor: Editor, frame: NodeId): ReadingStep[] {
  if (!editor.doc.store.isAlive(frame)) return [];
  return flatItems(a11yItems(editor.doc, frame, (n) => editor.scene.bounds(n))).map((item) => ({ item, said: spoken(item) }));
}
