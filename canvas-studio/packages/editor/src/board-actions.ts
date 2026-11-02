// Everyday actions on a board (п.3 «рабочие мелочи»): picking similar objects,
// copying a look from one object to others, sections fitted to their content or
// with their content hidden, locking. The same list serves the «⋯» button over
// the selection and the right-click menu, so the two never differ.

import { plural, solid, tr, type BoardRole, type Color, type NodeId, type Paint } from '#core';
import { boardTextOf, roleOf, STICKY_SIZE, worldBox } from '#components';
import type { Point } from '#geometry';
import { inkFor } from './board.ts';
import type { Editor } from './editor.ts';
import { linkOfCard } from './link-card.ts';
import { openLink } from './text-links.ts';
import type { Command } from './commands.ts';
import type { MenuItem } from './ui/context-menu.ts';

/** Room inside a section around its content; more at the top, under its name (as board-smart.ts sorts). */
export const SECTION_PAD = 40;
export const SECTION_PAD_TOP = 72;

const count = (n: number, one: string, few: string, many: string) => `${n} ${plural(n, tr(one), tr(few), tr(many))}`;

const hexOf = (c: Color) => {
  const p = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`.toUpperCase();
};

const solidHex = (paints: readonly Paint[]): string | null => {
  const f = paints.find((p) => p.visible && p.type === 'SOLID');
  return f && f.type === 'SOLID' ? hexOf(f.color) : null;
};

const child = (editor: Editor, id: NodeId, kind: BoardRole['kind']) => editor.doc.children(id).find((c) => roleOf(editor.doc, c)?.kind === kind) ?? null;

/** The board kind of a layer: a role, or SECTION for a section. */
function kindOf(editor: Editor, id: NodeId): string {
  return roleOf(editor.doc, id)?.kind ?? (editor.doc.type(id) === 'SECTION' ? 'SECTION' : '');
}

// ---------- locking ----------

/** The locked layer that holds `id` (itself or a section around it), if any. */
export function lockedHolder(editor: Editor, id: NodeId): NodeId | null {
  const d = editor.doc;
  for (let cur: NodeId | null = id; cur && cur !== editor.pageId; cur = d.parent(cur)) {
    const t = d.type(cur);
    if (t === 'PAGE' || t === 'DOCUMENT') return null;
    if (d.get(cur, 'locked')) return cur;
  }
  return null;
}

/**
 * A locked object under a page point. On a board a locked object does not move
 * and a marquee passes it by, but a click still selects it — or there would be
 * no way back to it (no layers panel on a board).
 */
export function lockedAt(editor: Editor, at: Point): NodeId | null {
  const hits = editor.scene.hitTest(at, { tolerance: 3 / editor.viewport.zoom, includeLocked: true });
  for (const hit of hits) {
    // The outermost locked layer: a locked section is taken whole.
    let held: NodeId | null = null;
    for (let cur: NodeId | null = hit; cur && cur !== editor.pageId; cur = editor.doc.parent(cur)) if (editor.doc.get(cur, 'locked')) held = cur;
    if (held) return held;
  }
  return null;
}

export function anyLocked(editor: Editor, ids: readonly NodeId[]): boolean {
  return ids.some((id) => lockedHolder(editor, id) !== null);
}

// ---------- similar objects ----------

/** Objects of the page a pick can take: alive, visible, not locked. */
function candidates(editor: Editor): NodeId[] {
  const d = editor.doc;
  const out: NodeId[] = [];
  const walk = (parent: NodeId) => {
    for (const id of d.children(parent)) {
      if (!d.get(id, 'visible') || d.get(id, 'locked')) continue;
      out.push(id);
      // Sections hold board objects; board objects hold only their own parts.
      if (d.type(id) === 'SECTION') walk(id);
    }
  };
  walk(editor.pageId);
  return out;
}

/** What «Выделить похожие» offers for the selection: each with the objects it picks (none new — not offered). */
export function similarOptions(editor: Editor): { label: string; ids: NodeId[] }[] {
  const d = editor.doc;
  const sel = editor.topLevelSelection();
  const first = sel[0];
  if (!first) return [];
  const kind = kindOf(editor, first);
  if (!kind || !sel.every((id) => kindOf(editor, id) === kind)) return [];
  const all = candidates(editor).filter((id) => kindOf(editor, id) === kind);
  const out: { label: string; ids: NodeId[] }[] = [];
  const offer = (label: string, ids: NodeId[]) => {
    const now = new Set(sel);
    if (ids.length > 0 && (ids.length !== now.size || ids.some((id) => !now.has(id))) && !out.some((o) => o.ids.length === ids.length && o.ids.every((id, i) => id === ids[i]))) {
      out.push({ label: `${label} — ${ids.length}`, ids });
    }
  };
  const fill = (id: NodeId) => solidHex(d.get(id, 'fills'));
  switch (kind) {
    case 'STICKY': {
      const colors = new Set(sel.map(fill));
      offer(colors.size === 1 ? tr('Стикеры этого цвета') : tr('Стикеры этих цветов'), all.filter((id) => colors.has(fill(id))));
      const author = (id: NodeId) => (roleOf(d, id) as Extract<BoardRole, { kind: 'STICKY' }>).author.trim();
      const authors = new Set(sel.map(author).filter(Boolean));
      if (authors.size > 0) offer(authors.size === 1 ? tr('Стикеры автора «{0}»', [...authors][0]!) : tr('Стикеры этих авторов'), all.filter((id) => authors.has(author(id))));
      offer(tr('Все стикеры'), all);
      break;
    }
    case 'SHAPE': {
      const look = (id: NodeId) => {
        const o = child(editor, id, 'SHAPE_OUTLINE');
        return `${(roleOf(d, id) as Extract<BoardRole, { kind: 'SHAPE' }>).shape}|${o ? fill(o) : ''}`;
      };
      const looks = new Set(sel.map(look));
      offer(tr('Такие же фигуры (вид и цвет)'), all.filter((id) => looks.has(look(id))));
      offer(tr('Все фигуры'), all);
      break;
    }
    case 'STAMP': {
      const text = (id: NodeId) => d.children(id).map((c) => (d.type(c) === 'TEXT' ? d.get(c, 'characters') : '')).join('');
      const texts = new Set(sel.map(text));
      offer(tr('Такие же штампы'), all.filter((id) => texts.has(text(id))));
      offer(tr('Все штампы'), all);
      break;
    }
    case 'CONNECTOR':
      offer(tr('Все связи'), all);
      break;
    case 'MARKER':
      offer(tr('Все линии маркера и выделителя'), all);
      break;
    case 'SECTION':
      offer(tr('Все разделы'), all);
      break;
  }
  return out;
}

// ---------- a look copied from one object to others ----------

type BoardLook =
  | { kind: 'STICKY'; fill: string }
  | { kind: 'SHAPE'; shape: Extract<BoardRole, { kind: 'SHAPE' }>['shape']; fill: string; stroked: boolean }
  | { kind: 'LINE'; connector: boolean; strokes: Paint[]; weight: number; dash: number[]; route?: Extract<BoardRole, { kind: 'CONNECTOR' }>['route']; startCap?: string; endCap?: string }
  | { kind: 'SECTION'; fills: Paint[] };

let copiedLook: BoardLook | null = null;

/** Copies the look of the first selected board object (Mod+Alt+C on a board); false — nothing to copy. */
export function copyBoardLook(editor: Editor): boolean {
  const d = editor.doc;
  const id = editor.topLevelSelection()[0];
  if (!id) return false;
  const kind = kindOf(editor, id);
  let look: BoardLook | null = null;
  if (kind === 'STICKY') look = { kind: 'STICKY', fill: solidHex(d.get(id, 'fills')) ?? '#FFE27A' };
  else if (kind === 'SHAPE') {
    const o = child(editor, id, 'SHAPE_OUTLINE');
    look = { kind: 'SHAPE', shape: (roleOf(d, id) as Extract<BoardRole, { kind: 'SHAPE' }>).shape, fill: (o && solidHex(d.get(o, 'fills'))) ?? '#FFFFFF', stroked: !!o && d.get(o, 'strokes').some((p) => p.visible) };
  } else if (kind === 'CONNECTOR' || kind === 'MARKER') {
    const r = roleOf(d, id);
    look = {
      kind: 'LINE',
      connector: kind === 'CONNECTOR',
      strokes: structuredClone(d.get(id, 'strokes')),
      weight: d.get(id, 'strokeWeight'),
      dash: [...d.get(id, 'dashPattern')],
      ...(r?.kind === 'CONNECTOR' ? { route: r.route, startCap: d.get(id, 'startCap'), endCap: d.get(id, 'endCap') } : {}),
    };
  } else if (kind === 'SECTION') look = { kind: 'SECTION', fills: structuredClone(d.get(id, 'fills')) };
  if (!look) return false;
  copiedLook = look;
  editor.toast(tr('Оформление скопировано — выделите другие объекты и нажмите ⌥⌘V'));
  return true;
}

export function hasBoardLook(): boolean {
  return copiedLook !== null;
}

/**
 * Puts the copied look on the selection: a colour goes from a sticky to a shape
 * and back; a line's colour, width and dashes go to connectors and marker
 * lines; a connector's route and arrows only to connectors. False — nothing took it.
 */
export function pasteBoardLook(editor: Editor): boolean {
  const look = copiedLook;
  const d = editor.doc;
  const ids = editor.topLevelSelection().filter((id) => !lockedHolder(editor, id));
  if (!look || ids.length === 0) return false;
  const colour = look.kind === 'STICKY' || look.kind === 'SHAPE' ? look.fill : null;
  let applied = 0;
  editor.commit(tr('Вставить оформление'), (tx) => {
    for (const id of ids) {
      const kind = kindOf(editor, id);
      if (kind === 'STICKY' && colour) {
        tx.set(id, 'fills', [solid(hexColor(colour))]);
        const t = boardTextOf(d, id);
        if (t) tx.set(t, 'fills', [solid(hexColor(inkFor(colour)))]);
        applied++;
      } else if (kind === 'SHAPE' && colour) {
        const o = child(editor, id, 'SHAPE_OUTLINE');
        if (look.kind === 'SHAPE') tx.set(id, 'board', { kind: 'SHAPE', shape: look.shape });
        const stroked = look.kind === 'SHAPE' ? look.stroked : !!o && d.get(o, 'strokes').some((p) => p.visible);
        if (o) tx.update(o, { fills: [solid(hexColor(colour))], strokes: stroked ? [solid(hexColor(colour === '#FFFFFF' ? '#1E1E1E' : colour))] : [] });
        const t = boardTextOf(d, id);
        if (t) tx.set(t, 'fills', [solid(hexColor(inkFor(colour)))]);
        applied++;
      } else if ((kind === 'CONNECTOR' || kind === 'MARKER') && look.kind === 'LINE') {
        // A highlighter keeps its see-through ink.
        const opacity = d.get(id, 'strokes')[0]?.opacity ?? 1;
        tx.update(id, { strokes: look.strokes.map((p) => (kind === 'MARKER' ? { ...p, opacity } : p)), strokeWeight: look.weight, dashPattern: look.dash });
        if (kind === 'CONNECTOR' && look.connector) {
          const r = roleOf(d, id) as Extract<BoardRole, { kind: 'CONNECTOR' }>;
          tx.set(id, 'board', { ...r, route: look.route ?? r.route });
          tx.update(id, { startCap: look.startCap as never, endCap: look.endCap as never });
        }
        applied++;
      } else if (kind === 'SECTION' && look.kind === 'SECTION') {
        tx.set(id, 'fills', structuredClone(look.fills));
        applied++;
      }
    }
  });
  if (applied === 0) editor.toast(tr('Это оформление к выделенному не подходит: цвет стикера переносится на стикеры и фигуры, линия — на связи и маркер'));
  return applied > 0;
}

function hexColor(hex: string): Color {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

// ---------- sections ----------

export function selectedSections(editor: Editor): NodeId[] {
  return editor.topLevelSelection().filter((id) => editor.doc.type(id) === 'SECTION');
}

/** A section with its content hidden (it has content, all of it hidden). */
export function contentsHidden(editor: Editor, section: NodeId): boolean {
  const kids = editor.doc.children(section);
  return kids.length > 0 && kids.every((id) => !editor.doc.get(id, 'visible'));
}

/** Resizes sections to what is inside them, with room around and under the name; empty ones stay. */
export function fitSections(editor: Editor, sections = selectedSections(editor)): void {
  const d = editor.doc;
  const work = sections.filter((s) => d.children(s).length > 0 && !d.get(s, 'locked'));
  if (work.length === 0) {
    editor.toast(tr('В разделе ничего нет — подгонять не подо что'));
    return;
  }
  editor.commit(tr('Подогнать раздел'), (tx) => {
    for (const s of work) {
      const origin = worldBox(d, s);
      const boxes = d.children(s).map((c) => worldBox(d, c));
      const x0 = Math.min(...boxes.map((b) => b.x)) - SECTION_PAD;
      const y0 = Math.min(...boxes.map((b) => b.y)) - SECTION_PAD_TOP;
      const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + SECTION_PAD;
      const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + SECTION_PAD;
      const dx = Math.round(x0 - origin.x);
      const dy = Math.round(y0 - origin.y);
      // The section moves, its content stays where it is on the page.
      tx.update(s, { x: d.get(s, 'x') + dx, y: d.get(s, 'y') + dy, width: Math.round(x1 - x0), height: Math.round(y1 - y0) });
      for (const c of d.children(s)) tx.update(c, { x: d.get(c, 'x') - dx, y: d.get(c, 'y') - dy });
    }
  });
}

/**
 * Hides what is in the sections (or shows it back): a long board gets short to
 * read; connectors from the hidden objects hide with them.
 */
export function toggleSectionContents(editor: Editor, sections = selectedSections(editor)): void {
  const d = editor.doc;
  if (sections.length === 0) return;
  const show = sections.every((s) => contentsHidden(editor, s));
  const inside = new Set<NodeId>();
  for (const s of sections) for (const c of d.children(s)) inside.add(c);
  editor.commit(show ? tr('Показать содержимое раздела') : tr('Скрыть содержимое раздела'), (tx) => {
    for (const id of inside) tx.set(id, 'visible', show);
    for (const r of d.store.allRecords()) {
      const role = r.props.board;
      if (role?.kind !== 'CONNECTOR' || !d.store.isAlive(r.id)) continue;
      if ((role.start.node && inside.has(role.start.node)) || (role.end.node && inside.has(role.end.node))) tx.set(r.id, 'visible', show);
    }
  });
}

/** «Скрыто: 12 объектов» for a section with its content hidden. */
export function hiddenLabel(editor: Editor, section: NodeId): string {
  return tr('Содержимое скрыто: {0}', count(editor.doc.children(section).length, 'объект', 'объекта', 'объектов'));
}

// ---------- sticky sizes ----------

/** Sticky sizes, from the standard square one: a wide note for a longer thought, a big one for a heading. */
export const STICKY_SIZES: { id: 'square' | 'wide' | 'big'; label: string; width: number; height: number }[] = [
  { id: 'square', label: tr('Квадратный'), width: STICKY_SIZE, height: STICKY_SIZE },
  { id: 'wide', label: tr('Широкий'), width: STICKY_SIZE * 2, height: STICKY_SIZE },
  { id: 'big', label: tr('Большой'), width: STICKY_SIZE * 2, height: STICKY_SIZE * 2 },
];

export function selectedStickies(editor: Editor): NodeId[] {
  return editor.topLevelSelection().filter((id) => roleOf(editor.doc, id)?.kind === 'STICKY' && !lockedHolder(editor, id));
}

/** The size the stickies have now (all the same one), if it is one of the three. */
export function stickySizeOf(editor: Editor, ids: readonly NodeId[] = selectedStickies(editor)): (typeof STICKY_SIZES)[number]['id'] | null {
  const d = editor.doc;
  const found = ids.map((id) => STICKY_SIZES.find((s) => s.width === d.get(id, 'width') && s.height === d.get(id, 'height'))?.id ?? null);
  return found.length > 0 && found.every((f) => f === found[0]) ? found[0]! : null;
}

/** Makes the selected stickies square, wide or big; each keeps its top left corner. The text refits by itself. */
export function setStickySize(editor: Editor, size: (typeof STICKY_SIZES)[number]['id'], ids: readonly NodeId[] = selectedStickies(editor)): void {
  const s = STICKY_SIZES.find((x) => x.id === size)!;
  if (ids.length === 0) return;
  editor.commit(tr('Размер стикера'), (tx) => {
    for (const id of ids) tx.update(id, { width: s.width, height: s.height });
  });
}

// ---------- the menu ----------

/**
 * The board's menu for the selection: «⋯» over it and the right click show the
 * same. Only what does something now is listed (no dead items).
 */
export function boardMenuItems(editor: Editor, commands: Map<string, Command>, extra: { pasteHere?: MenuItem; copyLink?: MenuItem } = {}): MenuItem[] {
  const d = editor.doc;
  const cmd = (id: string, label?: string): MenuItem => {
    const c = commands.get(id)!;
    return { kind: 'action', label: label ?? c.label, shortcut: c.keys?.[0], run: c.run };
  };
  const sep: MenuItem = { kind: 'separator' };
  const sel = editor.topLevelSelection();
  if (sel.length === 0) {
    return [...(extra.pasteHere ? [extra.pasteHere, sep] : []), cmd('edit.selectAll'), cmd('view.fit', tr('Показать всю доску')), sep, cmd('board.templates', tr('Шаблоны досок…')), cmd('view.palette')];
  }
  const locked = anyLocked(editor, sel);
  const lockItem = cmd('object.toggleLock', sel.every((id) => d.get(id, 'locked')) ? tr('Открепить') : tr('Закрепить'));
  if (locked) {
    // A locked object: only what does not change it, and the way to unlock.
    return [lockItem, sep, cmd('edit.copy'), cmd('view.fitSelection', tr('Показать крупно')), ...(extra.copyLink ? [extra.copyLink] : [])];
  }
  const sections = selectedSections(editor);
  const similar = similarOptions(editor);
  const groups = sel.some((id) => d.type(id) === 'GROUP');
  const link = sel.length === 1 ? linkOfCard(editor, sel[0]!) : null;
  const items: MenuItem[] = [
    ...(link ? [{ kind: 'action', label: tr('Открыть ссылку'), run: () => openLink(link) } as MenuItem, { kind: 'action', label: tr('Копировать адрес ссылки'), run: () => void navigator.clipboard?.writeText(link) } as MenuItem, sep] : []),
    cmd('edit.copy'),
    cmd('edit.cut'),
    ...(extra.pasteHere ? [extra.pasteHere] : []),
    cmd('edit.duplicate'),
    cmd('edit.delete'),
    sep,
  ];
  if (sel.length > 1) {
    items.push({
      kind: 'submenu',
      label: tr('Выравнивание'),
      items: [cmd('align.left'), cmd('align.hcenter'), cmd('align.right'), sep, cmd('align.top'), cmd('align.vcenter'), cmd('align.bottom'), sep, cmd('align.distributeH'), cmd('align.distributeV'), sep, cmd('object.tidyUp')],
    });
  }
  items.push({ kind: 'submenu', label: tr('Порядок'), items: [cmd('object.front'), cmd('object.forward'), cmd('object.backward'), cmd('object.back')] });
  if (sel.length > 1) items.push(cmd('object.group'));
  if (groups) items.push(cmd('object.ungroup'));
  items.push(sep);
  if (similar.length > 0) items.push({ kind: 'submenu', label: tr('Выделить похожие'), items: similar.map((o) => ({ kind: 'action', label: o.label, run: () => editor.setSelection(o.ids) }) as MenuItem) });
  items.push(cmd('props.copy', tr('Копировать оформление')));
  if (hasBoardLook()) items.push(cmd('props.paste', tr('Вставить оформление')));
  if (selectedStickies(editor).length === sel.length) {
    const now = stickySizeOf(editor);
    items.push({ kind: 'submenu', label: tr('Размер стикера'), items: STICKY_SIZES.map((x) => ({ kind: 'action', label: x.id === now ? `✓ ${x.label}` : x.label, disabled: x.id === now, run: () => setStickySize(editor, x.id) }) as MenuItem) });
  }
  if (sections.length > 0) {
    items.push(sep, cmd('board.fitSection'), cmd('board.toggleSectionContents', sections.every((s) => contentsHidden(editor, s)) ? tr('Показать содержимое раздела') : tr('Скрыть содержимое раздела')));
  }
  items.push(sep, lockItem, ...(extra.copyLink ? [extra.copyLink] : []), cmd('view.fitSelection', tr('Показать крупно')));
  return items;
}
