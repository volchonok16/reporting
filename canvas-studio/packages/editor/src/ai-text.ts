// Small requests to the language model, the editor's side (28 October): texts
// for a layout, a slide's speaker notes, names for layers the rules left with a
// default name (the rules of auto-name.ts only behind the model). Only texts and the shape of the layers go to the
// server (packages/server/src/ai-text.ts), never the file; the answer is a
// short JSON. Each result is one undo step.

import { lang, tr, type NodeId } from '#core';
import { isDefaultName, suggestNames } from './auto-name.ts';
import { textLayerName, type Editor } from './editor.ts';
import { slideIds, slideInfo } from './slides.ts';

/** Layers in one request — the server takes no more. */
const ITEMS_MAX = 150;

/** Asks the server; throws an Error with words for the person. */
async function ask<T>(body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api/ai/text', { method: 'POST', credentials: 'same-origin', headers: { 'X-CS': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error(tr('Нет связи с сервером Симметрики'));
  }
  if (res.status === 401) throw new Error(tr('Войдите в аккаунт — нейросеть работает на сервере'));
  if (res.status === 404) throw new Error(tr('Этот сервер не умеет работать с нейросетью'));
  const data = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.message ?? tr('Сервер ответил ошибкой {0}', res.status));
  return data;
}

/** Visible layers under the roots, depth first, without going into instances (their layers follow the component). */
function walk(editor: Editor, roots: readonly NodeId[], visit: (id: NodeId) => void): void {
  const d = editor.doc;
  const go = (id: NodeId) => {
    if (!d.get(id, 'visible')) return;
    visit(id);
    if (d.type(id) !== 'INSTANCE') for (const c of d.children(id)) go(c);
  };
  roots.forEach(go);
}

/** «Шапка / Меню»: the two nearest named containers of a layer. */
function where(editor: Editor, id: NodeId): string {
  const d = editor.doc;
  const out: string[] = [];
  for (let p = d.parent(id); p && out.length < 2 && d.type(p) !== 'PAGE'; p = d.parent(p)) {
    const name = String(d.get(p, 'name'));
    if (!isDefaultName(name)) out.unshift(name);
  }
  return out.join(' / ');
}

/** The screen the layers are on: the top-level frame's name. */
function screenOf(editor: Editor, roots: readonly NodeId[]): string {
  const d = editor.doc;
  let id = roots[0];
  while (id && d.parent(id) && d.type(d.parent(id)!) !== 'PAGE' && d.type(d.parent(id)!) !== 'SECTION') id = d.parent(id)!;
  const name = id ? String(d.get(id, 'name')) : '';
  return isDefaultName(name) ? '' : name;
}

/** The texts the model may rewrite: visible, not in an instance, not locked. */
export function writableTexts(editor: Editor, roots: readonly NodeId[]): NodeId[] {
  const d = editor.doc;
  const out: NodeId[] = [];
  walk(editor, roots, (id) => {
    if (d.type(id) === 'TEXT' && d.get(id, 'characters').trim() && !editor.isInstanceLayer(id) && !d.get(id, 'locked')) out.push(id);
  });
  return out.slice(0, ITEMS_MAX);
}

/** Texts for a layout: real headings, labels, prices instead of placeholders; `hint` — what the person wants («короче», «для кофейни»). Returns how many changed. */
export async function writeTexts(editor: Editor, roots: readonly NodeId[], hint: string): Promise<number> {
  const d = editor.doc;
  const ids = writableTexts(editor, roots);
  if (!ids.length) return 0;
  const items = ids.map((id, i) => ({ id: String(i), text: d.get(id, 'characters'), size: d.get(id, 'fontSize'), where: where(editor, id) }));
  const { texts } = await ask<{ texts: Record<string, string> }>({ task: 'texts', hint, screen: screenOf(editor, roots), items });
  const changes = ids.map((id, i) => [id, texts[String(i)]] as const).filter(([id, text]) => text && d.store.isAlive(id) && text !== d.get(id, 'characters'));
  if (!changes.length) return 0;
  editor.commit(tr('Тексты от нейросети'), (tx) => {
    for (const [id, text] of changes) {
      tx.set(id, 'characters', text!);
      tx.set(id, 'textRuns', []);
    }
  });
  return changes.length;
}

/** The last resort, so nothing keeps a markup's name: what a layer looks like — a line, a dot, a frame, a block. */
function shapeName(editor: Editor, id: NodeId): string {
  const d = editor.doc;
  const t = d.type(id);
  if (t === 'TEXT') return tr('Текст');
  const w = d.get(id, 'width');
  const h = d.get(id, 'height');
  const filled = d.get(id, 'fills').some((p) => p.visible !== false);
  const stroked = d.get(id, 'strokes').some((p) => p.visible !== false);
  if (Math.min(w, h) <= 6 && Math.max(w, h) >= 4 * Math.min(w, h)) return w >= h ? tr('Полоса') : tr('Вертикальная полоса');
  if (Math.max(w, h) <= 24 && d.children(id).length === 0) return tr('Точка');
  if (!stroked && !filled && d.children(id).length === 0) return tr('Отступ');
  if (stroked && !filled && d.children(id).length === 0) return tr('Рамка');
  if (t === 'ELLIPSE') return tr('Круг');
  if (d.children(id).length) return tr('Блок');
  return filled ? tr('Плашка') : tr('Фигура');
}

/** A name nobody gave: a default one, or a text's own words (a new text is named so, as in Figma). */
function nameless(editor: Editor, id: NodeId): boolean {
  const d = editor.doc;
  const name = String(d.get(id, 'name'));
  return isDefaultName(name) || (d.type(id) === 'TEXT' && name === textLayerName(d.get(id, 'characters')));
}

/** Layers with a name nobody gave («Rectangle 23», «Фрейм 12», «div», a text named by its words): what the model names. */
export function unnamedLayers(editor: Editor, roots: readonly NodeId[]): NodeId[] {
  const d = editor.doc;
  const out: NodeId[] = [];
  walk(editor, roots, (id) => {
    const t = d.type(id);
    if (t !== 'COMPONENT' && t !== 'COMPONENT_SET' && t !== 'INSTANCE' && !editor.isInstanceLayer(id) && nameless(editor, id)) out.push(id);
  });
  return out;
}

/**
 * Names every layer with a default name by what it is (29 October: the model first, the rules
 * only behind it). The model sees types, sizes, texts, the names around and the rules' guess;
 * what it leaves out takes the rules' name. Many layers go in parts of ITEMS_MAX. One undo
 * step; returns how many got a name. Throws when the model cannot be reached at all.
 */
export async function nameLayers(editor: Editor, roots: readonly NodeId[]): Promise<number> {
  const d = editor.doc;
  const ids = unnamedLayers(editor, roots);
  if (!ids.length) return 0;
  const rules = suggestNames(d, roots);
  const names = new Map<NodeId, string>();
  for (let at = 0; at < ids.length; at += ITEMS_MAX) {
    const part = ids.slice(at, at + ITEMS_MAX);
    const items = part.map((id, i) => {
      const texts: string[] = [];
      walk(editor, [id], (n) => {
        if (texts.length < 5 && d.type(n) === 'TEXT') texts.push(d.get(n, 'characters').trim().split('\n')[0]!.slice(0, 60));
      });
      const p = d.parent(id);
      return {
        id: String(i),
        type: d.type(id),
        w: d.get(id, 'width'),
        h: d.get(id, 'height'),
        texts: texts.filter(Boolean),
        children: d.children(id).map((c) => String(d.get(c, 'name'))).slice(0, 12),
        parent: p && d.type(p) !== 'PAGE' ? String(d.get(p, 'name')) : '',
        // The markup's name says much: «div.accent-bar», «span.chip-dot».
        name: String(d.get(id, 'name')),
        hint: rules.get(id) ?? '',
      };
    });
    let answer: { names: Record<string, string> };
    try {
      answer = await ask<{ names: Record<string, string> }>({ task: 'names', lang, items });
    } catch (error) {
      // Nothing from the model: the caller falls back to the rules; a later part failing keeps what came.
      if (!names.size && at === 0) throw error;
      break;
    }
    part.forEach((id, i) => {
      const name = answer.names?.[String(i)]?.replace(/["«»]/g, '').trim();
      // A markup's name back («border», «spacer») is no name: the rules or the look name it instead.
      if (name && !isDefaultName(name)) names.set(id, name);
    });
  }
  const changes = ids.map((id) => [id, names.get(id) ?? rules.get(id) ?? shapeName(editor, id)] as const).filter(([id, name]) => name && d.store.isAlive(id) && nameless(editor, id) && name !== d.get(id, 'name'));
  if (!changes.length) return 0;
  editor.commit(tr('Имена слоёв от нейросети'), (tx) => {
    for (const [id, name] of changes) tx.set(id, 'name', name!);
  });
  return changes.length;
}

/** Speaker notes for a slide by its texts (the present notes improved, if any). Returns the notes; saved as one step. */
export async function writeNotes(editor: Editor, slide: NodeId, notes: string): Promise<string> {
  const d = editor.doc;
  const slideTexts: string[] = [];
  walk(editor, [slide], (id) => {
    if (d.type(id) === 'TEXT' && d.get(id, 'characters').trim()) slideTexts.push(d.get(id, 'characters').trim());
  });
  const page = d.parent(slide);
  const deck = page ? slideIds(d, page).map((id) => String(d.get(id, 'name'))).slice(0, 60) : [];
  const answer = await ask<{ notes: string }>({ task: 'notes', hint: '', slide: slideTexts, notes, deck });
  if (d.store.isAlive(slide)) editor.commit(tr('Заметки слайда'), (tx) => tx.set(slide, 'slide', { ...slideInfo(d, slide), notes: answer.notes }));
  return answer.notes;
}
