// Code layers (Figma's code layers): a frame holding an HTML document — markup,
// <style> and <script> — whose layers are made from the code. The code runs in
// the HTML import's sandbox (an opaque origin: it cannot reach the editor, its
// cookies or its storage), only in the browser of the person who edits it; what
// it draws comes back as ordinary layers, so the canvas, export and the others
// in the file see layers, and nobody else's browser runs the code. «Запустить»
// opens the live page, where its scripts work and its buttons can be pressed.

import { tr, type NodeId } from '#core';
import type { Editor } from './editor.ts';
import { HtmlImportBuilder } from './html-import/build.ts';
import { capturePage, renderPage } from './html-import/sandbox.ts';

export const SAMPLE_CODE = `<style>
  body { margin: 0; font-family: Inter, system-ui, sans-serif; }
  .card { box-sizing: border-box; width: 100%; height: 100vh; padding: 24px;
    display: flex; flex-direction: column; gap: 12px; justify-content: center;
    background: linear-gradient(135deg, #eef0ff, #ffffff); }
  h1 { margin: 0; font-size: 22px; }
  p { margin: 0; color: #555; font-size: 14px; }
  button { align-self: flex-start; padding: 10px 16px; border: 0; border-radius: 8px;
    background: #4f5bd5; color: #fff; font-size: 14px; }
</style>
<div class="card">
  <h1>Код-слой</h1>
  <p id="note">Слои внутри собраны из этого кода.</p>
  <button id="go">Нажато: 0</button>
</div>
<script>
  let n = 0;
  document.getElementById('go').onclick = () => { n++; document.getElementById('go').textContent = 'Нажато: ' + n; };
  document.getElementById('note').textContent = 'Собрано ' + new Date().toLocaleDateString('ru-RU');
</script>`;

/** The page as the sandbox gets it: the frame's size is the viewport. */
function page(code: string): string {
  return /<html[\s>]/i.test(code) ? code : `<!doctype html><html><head><meta charset="utf-8"></head><body>${code}</body></html>`;
}

/** Builds in progress: a newer edit makes an older result void. */
const running = new Map<NodeId, number>();
let counter = 0;

/** What happened the last time a code layer was built (the panel shows it). */
export const lastBuild = new Map<NodeId, { ok: boolean; text: string }>();

/**
 * Runs the layer's code in a hidden sandbox at the layer's size and puts what
 * it draws inside the layer, instead of what was there. Not an undo step: the
 * code is (undoing it builds the layers again).
 */
export async function buildCodeLayer(editor: Editor, id: NodeId): Promise<void> {
  const d = editor.doc;
  const code = d.store.isAlive(id) ? d.get(id, 'code') : null;
  if (code === null || d.readOnly) return;
  const token = ++counter;
  running.set(id, token);
  const w = Math.max(1, Math.round(d.get(id, 'width')));
  const h = Math.max(1, Math.round(d.get(id, 'height')));
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none';
  document.body.append(host);
  try {
    const frame = await renderPage(host, page(code), w, h);
    const result = await capturePage(frame, { delay: 150, scroll: false, simplify: true, expand: false, autoLayout: false, spacers: false, name: '' }, () => {});
    if (running.get(id) !== token || !d.store.isAlive(id) || d.get(id, 'code') !== code) return;
    let count = 0;
    d.transact(
      (tx) => {
        for (const c of [...d.children(id)]) tx.delete(c);
        const b = new HtmlImportBuilder(editor, tx, result.images);
        b.build({ ...result.tree, t: 'FRAME', x: 0, y: 0, rt: undefined, name: tr('Результат') }, id);
        count = b.count;
        editor.postProcess(tx);
      },
      { undoable: false },
    );
    lastBuild.set(id, { ok: true, text: tr('Собрано слоёв: {0}', count) });
  } catch (err) {
    if (running.get(id) === token) lastBuild.set(id, { ok: false, text: tr('Код не собрался: {0}', (err as Error).message) });
  } finally {
    host.remove();
    if (running.get(id) === token) running.delete(id);
    editor.events.emit('codeBuilt', id);
  }
}

/** Builds again every code layer whose code this person changed (typing, undo, redo, a new layer). */
export function watchCodeLayers(editor: Editor): void {
  const timers = new Map<NodeId, ReturnType<typeof setTimeout>>();
  editor.events.on('change', ({ changes, source }) => {
    if (source === 'remote' || source === 'load') return;
    const d = editor.doc;
    const ids = new Set<NodeId>();
    for (const [id, keys] of changes.updated) if (keys.has('code') || ((keys.has('width') || keys.has('height')) && d.store.isAlive(id) && d.get(id, 'code') !== null)) ids.add(id);
    for (const id of changes.created) if (d.store.isAlive(id) && d.get(id, 'code') !== null && d.children(id).length === 0) ids.add(id);
    for (const id of ids) {
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          void buildCodeLayer(editor, id);
        }, 500),
      );
    }
  });
}

/** A new code layer in the middle of the view, with an example to start from. */
export function addCodeLayer(editor: Editor): void {
  const vp = editor.viewport;
  const { width, height } = editor.screenSize;
  const centre = vp.screenToWorld({ x: width / 2, y: height / 2 });
  const w = 360;
  const h = 240;
  editor.commit(
    tr('Код-слой'),
    (tx) =>
      tx.create('FRAME', editor.pageId, {
        name: tr('Код'),
        x: Math.round(centre.x - w / 2),
        y: Math.round(centre.y - h / 2),
        width: w,
        height: h,
        code: SAMPLE_CODE,
        clipsContent: true,
      }),
    () => {
      const last = editor.doc.children(editor.pageId).at(-1);
      return last ? [last] : [];
    },
  );
  editor.setTool('select');
}

/** The live page over the editor: its scripts run, its buttons work. */
export async function runCodeLayer(editor: Editor, id: NodeId): Promise<void> {
  const d = editor.doc;
  const code = d.get(id, 'code');
  if (code === null) return;
  const w = Math.max(1, Math.round(d.get(id, 'width')));
  const h = Math.max(1, Math.round(d.get(id, 'height')));
  const close = () => overlay.remove();
  const host = document.createElement('div');
  host.className = 'code-run-frame';
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay code-run';
  const box = document.createElement('div');
  box.className = 'dialog code-run-dialog';
  const head = document.createElement('header');
  head.className = 'dialog-header';
  const title = document.createElement('h2');
  title.textContent = `${d.get(id, 'name')} — ${w} × ${h}`;
  const x = document.createElement('button');
  x.className = 'text-button';
  x.type = 'button';
  x.textContent = tr('Закрыть');
  x.onclick = close;
  head.append(title, x);
  box.append(head, host);
  overlay.append(box);
  overlay.addEventListener('pointerdown', (e) => e.target === overlay && close());
  overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.body.append(overlay);
  x.focus();
  try {
    await renderPage(host, page(code), w, h);
  } catch (err) {
    host.textContent = tr('Код не запустился: {0}', (err as Error).message);
  }
}
