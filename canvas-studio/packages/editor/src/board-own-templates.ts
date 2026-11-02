// Own board templates (roadmap step 10): what is selected on a board is kept
// with the account under a name — on every computer, for every board — and
// put on a free place of any board from «Шаблоны досок» → «Мои шаблоны».
// Kept as the layers' clipboard data (as a copy), so they paste as they were;
// pictures are not kept (they would make the settings heavy) — their places stay.

import { tr, type NodeId } from '#core';
import { freeSpotOnBoard } from './board.ts';
import { toClipboard, type ClipboardData } from './clipboard.ts';
import type { Editor } from './editor.ts';
import { prefsChanged } from './prefs.ts';

export const OWN_TEMPLATES_KEY = 'cs.board-templates';
/** The server keeps up to 300 000 characters of them; a little room is left. */
export const OWN_TEMPLATES_MAX = 290_000;
export const OWN_TEMPLATES_COUNT = 30;

export interface OwnTemplate {
  id: string;
  name: string;
  /** When it was saved. */
  at: number;
  /** Size of what it covers, for the card. */
  width: number;
  height: number;
  /** Layers in clipboard form (JSON of ClipboardData). */
  clip: string;
}

export function ownTemplates(): OwnTemplate[] {
  try {
    const list = JSON.parse(localStorage.getItem(OWN_TEMPLATES_KEY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((t): t is OwnTemplate => !!t && typeof t === 'object' && typeof (t as OwnTemplate).clip === 'string' && typeof (t as OwnTemplate).name === 'string') : [];
  } catch {
    return [];
  }
}

function store(list: OwnTemplate[]): void {
  localStorage.setItem(OWN_TEMPLATES_KEY, JSON.stringify(list));
  prefsChanged();
}

/** Whether a layer or its children show a picture (not kept in a template). */
function hasPictures(editor: Editor, ids: readonly NodeId[]): boolean {
  const d = editor.doc;
  let found = false;
  const look = (id: NodeId) => {
    if (d.get(id, 'fills').some((p) => p.type === 'IMAGE')) found = true;
  };
  for (const id of ids) {
    look(id);
    d.store.walk(id, look);
  }
  return found;
}

/**
 * Keeps the selected top-level layers as a template. Returns what to tell the
 * person: an error, or the result (with a note when pictures were left out).
 */
export function saveOwnTemplate(editor: Editor, name: string): { ok: boolean; message: string } {
  const ids = editor.topLevelSelection();
  if (ids.length === 0) return { ok: false, message: tr('Выделите на доске то, что станет шаблоном') };
  const data: ClipboardData = { ...toClipboard(editor.doc, ids), sources: [] };
  const clip = JSON.stringify(data);
  const boxes = ids.map((id) => editor.scene.bounds(id));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const template: OwnTemplate = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim().slice(0, 80) || tr('Мой шаблон'),
    at: Date.now(),
    width: Math.round(Math.max(...boxes.map((b) => b.x + b.width)) - x),
    height: Math.round(Math.max(...boxes.map((b) => b.y + b.height)) - y),
    clip,
  };
  const list = ownTemplates().filter((t) => t.name !== template.name);
  if (list.length >= OWN_TEMPLATES_COUNT) return { ok: false, message: tr('Шаблонов уже {0} — удалите ненужный в «Шаблонах досок»', OWN_TEMPLATES_COUNT) };
  const next = [template, ...list];
  if (JSON.stringify(next).length > OWN_TEMPLATES_MAX) return { ok: false, message: tr('Шаблон слишком большой: выделите меньше или удалите старые шаблоны') };
  store(next);
  return { ok: true, message: hasPictures(editor, ids) ? tr('Шаблон «{0}» сохранён. Картинки в шаблоны не попадают — на их месте будут пустые рамки.', template.name) : tr('Шаблон «{0}» сохранён: он в «Шаблонах досок» на любом вашем компьютере.', template.name) };
}

export function removeOwnTemplate(id: string): void {
  store(ownTemplates().filter((t) => t.id !== id));
}

/** Puts a template on a free place near the middle of the screen; selects what came. */
export function insertOwnTemplate(editor: Editor, t: OwnTemplate): boolean {
  if (editor.doc.readOnly) return false;
  const { width, height } = editor.screenSize;
  const centre = editor.viewport.screenToWorld({ x: width / 2, y: height / 2 });
  const spot = freeSpotOnBoard(editor, centre, Math.max(1, t.width), Math.max(1, t.height));
  return editor.pasteText(t.clip, false, spot);
}
