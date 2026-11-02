// "Version history" (stage 8, part 5; Figma users' complaint: a long list of
// autosaves, no way to see what changed, only the whole file can be restored).
// On the left — the versions; on the right — the chosen version next to the
// file as it is now, on one page, with what differs outlined: changed frames
// orange, frames deleted since — red, added since — green. A frame can be
// brought back from the version on its own; the whole version too (the file
// as it is now is saved as a version first). Both are ordinary edits:
// everyone in the file sees them, Mod+Z takes them back.

import { compareTopLevel, deserialize, locale, restoreVersion, tr, type Document, type NodeId } from '#core';
import { SceneGraph, type Canvas2DRenderer } from '#render';
import { isDiagram } from '../diagram/model.ts';
import { versions as api, type VersionInfo } from '../cloud.ts';
import { shownPageBackground, type Editor } from '../editor.ts';
import { IS_MAC } from '../keyboard.ts';
import { askConfirm, askText } from './dialog.ts';
import { h, icon, skeletonRows } from './dom.ts';

const COLORS = { changed: '#f59e0b', removed: '#ef4444', added: '#22c55e' } as const;

export interface VersionsHost {
  editor: Editor;
  renderer: Canvas2DRenderer;
  fileId: string;
  canEdit: boolean;
  toast(text: string, kind?: 'error'): void;
}

function when(at: number): string {
  return new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export class VersionsView {
  private readonly host: VersionsHost;
  private readonly overlay: HTMLElement;
  private readonly list: HTMLElement;
  private readonly main: HTMLElement;
  private items: VersionInfo[] = [];
  private selected: string | null = null;
  private page: NodeId;
  private readonly docs = new Map<string, Document>();
  private readonly previousOnLoad: (hash: string) => void;
  private redraw: (() => void) | null = null;

  constructor(host: VersionsHost) {
    this.host = host;
    this.page = host.editor.pageId;
    this.list = h('div', { class: 'versions-list', role: 'listbox', 'aria-label': tr('Версии') });
    this.main = h('div', { class: 'versions-main' });
    const save = host.canEdit ? h('button', { class: 'text-button', type: 'button', onclick: () => void this.saveVersion() }, tr('Сохранить версию…')) : null;
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    this.overlay = h(
      'div',
      { class: 'versions-view', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('История версий') },
      h('header', { class: 'versions-header' }, h('h2', {}, tr('История версий')), h('span', { class: 'versions-file' }, String(host.editor.doc.get(host.editor.doc.rootId, 'name') ?? '')), h('span', { class: 'crop-spacer' }), save, close),
      h('div', { class: 'versions-body' }, this.list, this.main),
    );
    this.overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.overlay);
    close.focus();
    // Pictures of a version decode later: draw again when they are ready.
    this.previousOnLoad = host.renderer.images.onLoad;
    host.renderer.images.onLoad = (hash) => {
      this.previousOnLoad(hash);
      this.redraw?.();
    };
    void this.load();
  }

  private async load(): Promise<void> {
    this.list.replaceChildren(skeletonRows(tr('Загружаю версии…'), 6));
    try {
      this.items = await api.list(this.host.fileId);
    } catch (error) {
      this.list.replaceChildren(h('p', { class: 'hint' }, error instanceof Error ? error.message : String(error)));
      return;
    }
    this.selected ??= this.items[0]?.id ?? null;
    this.renderList();
    await this.show();
  }

  private renderList(): void {
    if (!this.items.length) {
      this.list.replaceChildren(h('p', { class: 'hint' }, tr('Версий пока нет: они появляются, когда вы заканчиваете работу с файлом, и не реже раза в 10 минут во время работы.')));
      return;
    }
    this.list.replaceChildren(
      ...this.items.map((v) => {
        const row = h(
          'button',
          { class: `versions-row${v.id === this.selected ? ' active' : ''}${v.name ? ' named' : ''}`, type: 'button', role: 'option', 'aria-selected': String(v.id === this.selected) },
          h('span', { class: 'versions-name' }, v.name ?? tr('Автосохранение')),
          h('span', { class: 'versions-meta' }, [when(v.at), v.authors.length ? v.authors.join(', ') : v.by].filter(Boolean).join(' · ')),
          v.description ? h('span', { class: 'versions-desc' }, v.description) : null,
        );
        row.addEventListener('click', () => {
          this.selected = v.id;
          this.renderList();
          void this.show();
        });
        if (this.host.canEdit) {
          row.title = tr('Двойной щелчок — дать название');
          row.addEventListener('dblclick', () => void this.nameVersion(v));
        }
        return row;
      }),
    );
  }

  private async versionDoc(id: string): Promise<Document> {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = deserialize(await api.snapshot(this.host.fileId, id));
      this.docs.set(id, doc);
    }
    return doc;
  }

  private async show(): Promise<void> {
    const id = this.selected;
    if (!id) {
      this.main.replaceChildren();
      return;
    }
    this.main.replaceChildren(h('p', { class: 'hint' }, tr('Открываю версию…')));
    let version: Document;
    try {
      version = await this.versionDoc(id);
    } catch (error) {
      this.main.replaceChildren(h('p', { class: 'hint' }, error instanceof Error ? error.message : String(error)));
      return;
    }
    if (this.selected !== id) return;
    const current = this.host.editor.doc;
    const info = this.items.find((v) => v.id === id)!;
    // A diagram has no layers to compare: its picture then and now, and whether the text differs (FEAT-090).
    if (isDiagram(version)) {
      const restore = this.host.canEdit ? h('button', { class: 'text-button primary', type: 'button', onclick: () => void this.restoreAll(info, version) }, tr('Восстановить эту версию')) : null;
      const same = JSON.stringify(version.get(version.rootId, 'diagram')) === JSON.stringify(current.get(current.rootId, 'diagram'));
      const left = h('canvas', { class: 'versions-canvas' });
      const right = h('canvas', { class: 'versions-canvas' });
      this.main.replaceChildren(
        h('div', { class: 'versions-tools' }, h('span', { class: 'versions-summary' }, same ? tr('Схема как сейчас') : tr('Схема отличается от текущей')), h('span', { class: 'crop-spacer' }), restore),
        h('div', { class: 'versions-panes' }, h('figure', {}, h('figcaption', {}, info.name ?? tr('Версия · {0}', when(info.at))), left), h('figure', {}, h('figcaption', {}, tr('Сейчас')), right)),
      );
      this.redraw = () => {
        if (!left.isConnected) return;
        void import('../diagram/preview.ts').then(async ({ drawDiagramPreview }) => {
          await drawDiagramPreview(left, version);
          await drawDiagramPreview(right, current);
        });
      };
      requestAnimationFrame(() => this.redraw?.());
      return;
    }
    const pages = version.pages();
    if (!pages.includes(this.page)) this.page = pages[0] ?? this.page;
    const pageSelect = h('select', { class: 'field-select', 'aria-label': tr('Страница') }, ...pages.map((p) => h('option', { value: p, selected: p === this.page }, String(version.get(p, 'name') ?? ''))));
    pageSelect.addEventListener('change', () => {
      this.page = pageSelect.value;
      void this.show();
    });
    const diff = compareTopLevel(version, current, this.page);
    const restoreAll = this.host.canEdit ? h('button', { class: 'text-button primary', type: 'button', onclick: () => void this.restoreAll(info, version) }, tr('Восстановить эту версию')) : null;

    const left = h('canvas', { class: 'versions-canvas' });
    const right = h('canvas', { class: 'versions-canvas' });
    const sameCount = diff.added.length + diff.removed.length + diff.changed.length;
    const name = (d: Document, n: NodeId) => String(d.get(n, 'name') ?? '');
    const back = (n: NodeId) => (this.host.canEdit ? h('button', { class: 'link-button', type: 'button', onclick: () => this.restoreFrame(version, n) }, tr('Вернуть из версии')) : null);
    const changes = h(
      'ul',
      { class: 'versions-changes' },
      ...diff.changed.map((n) => h('li', {}, h('i', { style: { background: COLORS.changed } }), tr('Изменён «{0}»', name(current, n)), back(n))),
      ...diff.removed.map((n) => h('li', {}, h('i', { style: { background: COLORS.removed } }), tr('Удалён после версии: «{0}»', name(version, n)), back(n))),
      ...diff.added.map((n) => h('li', {}, h('i', { style: { background: COLORS.added } }), tr('Добавлен после версии: «{0}»', name(current, n)))),
    );
    this.main.replaceChildren(
      h('div', { class: 'versions-tools' }, h('div', { class: 'select-wrap' }, pageSelect), h('span', { class: 'versions-summary' }, sameCount ? tr('Отличий на странице: {0}', sameCount) : pages.includes(this.page) && current.store.isAlive(this.page) ? tr('На этой странице как сейчас') : tr('Этой страницы сейчас нет')), h('span', { class: 'crop-spacer' }), restoreAll),
      h('div', { class: 'versions-panes' }, h('figure', {}, h('figcaption', {}, info.name ?? tr('Версия · {0}', when(info.at))), left), h('figure', {}, h('figcaption', {}, tr('Сейчас')), right)),
      ...(sameCount ? [changes] : []),
    );
    const highlight = (n: NodeId, color: string) => ({ id: n, color });
    this.redraw = () => {
      if (!left.isConnected) return;
      this.draw(left, version, [...diff.changed.map((n) => highlight(n, COLORS.changed)), ...diff.removed.map((n) => highlight(n, COLORS.removed))]);
      this.draw(right, current, [...diff.changed.map((n) => highlight(n, COLORS.changed)), ...diff.added.map((n) => highlight(n, COLORS.added))]);
    };
    requestAnimationFrame(() => this.redraw?.());
  }

  private draw(canvas: HTMLCanvasElement, doc: Document, marks: { id: NodeId; color: string }[]): void {
    drawPage(canvas, doc, this.page, this.host.renderer, marks);
  }

  private restoreFrame(version: Document, id: NodeId): void {
    const editor = this.host.editor;
    if (editor.doc.readOnly) return;
    const page = editor.doc.store.isAlive(this.page) ? this.page : editor.pageId;
    editor.commit(tr('Вернуть фрейм из версии'), (tx) => restoreVersion(tx, editor.doc, version, [id], page));
    this.host.toast(tr('«{0}» — как в версии. Отменить — {1}.', String(version.get(id, 'name') ?? ''), IS_MAC ? '⌘Z' : 'Ctrl+Z'));
    void this.show();
  }

  private async restoreAll(info: VersionInfo, version: Document): Promise<void> {
    const editor = this.host.editor;
    const ok = await askConfirm({
      title: tr('Восстановить версию?'),
      message: tr('Файл станет таким, каким был {0}. Нынешнее состояние сохранится отдельной версией, а восстановление можно отменить — {1}.', when(info.at), IS_MAC ? '⌘Z' : 'Ctrl+Z'),
      confirm: tr('Восстановить'),
    });
    if (!ok) return;
    try {
      await api.save(this.host.fileId, tr('Перед восстановлением ({0})', when(Date.now())));
    } catch {
      // The restore can still be undone; the safety version is a bonus.
    }
    editor.commit(tr('Восстановить версию'), (tx) => restoreVersion(tx, editor.doc, version, null, editor.pageId));
    if (!editor.doc.store.isAlive(editor.pageId)) editor.setPage(editor.doc.pages()[0]!);
    this.close();
    this.host.toast(tr('Версия восстановлена. Отменить — {0}.', IS_MAC ? '⌘Z' : 'Ctrl+Z'));
  }

  private async saveVersion(): Promise<void> {
    const name = await askText({ title: tr('Сохранить версию'), label: tr('Название'), placeholder: tr('Например, «Перед показом заказчику»'), confirm: tr('Сохранить'), maxLength: 120, empty: tr('Введите название') });
    if (!name) return;
    try {
      await api.save(this.host.fileId, name);
      this.selected = null;
      this.docs.clear();
      await this.load();
    } catch (error) {
      this.host.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  private async nameVersion(v: VersionInfo): Promise<void> {
    const name = await askText({ title: tr('Название версии'), label: tr('Название'), value: v.name ?? '', confirm: tr('Сохранить'), maxLength: 120, empty: tr('Введите название'), hint: tr('Версия с названием хранится всегда.') });
    if (!name) return;
    try {
      await api.rename(this.host.fileId, v.id, name);
      await this.load();
    } catch (error) {
      this.host.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  close(): void {
    this.host.renderer.images.onLoad = this.previousOnLoad;
    this.redraw = null;
    this.overlay.remove();
  }
}

/** Draws a page of a document fitted into a canvas, with outlines around some of its top-level layers (versions, merges). */
export function drawPage(canvas: HTMLCanvasElement, doc: Document, page: NodeId, renderer: Canvas2DRenderer, marks: { id: NodeId; color: string }[]): void {
  const width = canvas.clientWidth || 400;
  const height = canvas.clientHeight || 300;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!doc.store.isAlive(page)) {
    ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.font = `${13 * dpr}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(tr('Страницы нет'), canvas.width / 2, canvas.height / 2);
    return;
  }
  const bg = shownPageBackground(doc.get(page, 'backgroundColor'));
  ctx.fillStyle = `rgb(${bg.r * 255} ${bg.g * 255} ${bg.b * 255})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scene = new SceneGraph(doc, page);
  const kids = [...doc.children(page)];
  if (!kids.length) return;
  const boxes = kids.map((k) => scene.bounds(k));
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  const pad = 16;
  const k = Math.min((width - pad * 2) / Math.max(1, x1 - x0), (height - pad * 2) / Math.max(1, y1 - y0), 2);
  const ox = (width - (x1 - x0) * k) / 2 - x0 * k;
  const oy = (height - (y1 - y0) * k) / 2 - y0 * k;
  const visible = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  for (const id of kids) {
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    renderer.renderNode(ctx, scene, id, visible, k * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const m of marks) {
    if (!doc.store.isAlive(m.id) || doc.parent(m.id) !== page) continue;
    const b = scene.bounds(m.id);
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(ox + b.x * k - 3, oy + b.y * k - 3, b.width * k + 6, b.height * k + 6);
  }
}
