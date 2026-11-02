// Assets panel (FR-LIB-007): components of the file with thumbnails and search.
// Click places an instance in the middle of the view; dragging drops it where
// the pointer is; double click opens the main component. Below — the
// components of the libraries switched on for the file ("Libraries" button),
// with "Update" when a library has a newer publication.

import { tr } from '#core';
import { listComponents } from '#components';
import type { NodeId } from '#core';
import { renderThumbnail, type Canvas2DRenderer } from '#render';
import { COMPONENT_DRAG_TYPE } from '../canvas-view.ts';
import { libraries as libraryApi, type LibraryInfo } from '../cloud.ts';
import { importFromLibrary, placeFromLibrary, takenUnits, updateFromLibrary, type LibraryComponent, type LibraryPayload } from '../library.ts';
import type { Editor } from '../editor.ts';
import { freeSpotOnBoard } from '../board.ts';
import { switchLayout } from '../keyboard.ts';
import { clear, h, icon, skeletonRows } from './dom.ts';

interface Entry {
  /** Component to instantiate (the first variant for a set). */
  component: NodeId;
  /** What the entry shows: the component or its set. */
  shown: NodeId;
  name: string;
  page: NodeId;
  variants: number;
}

export interface AssetsHost {
  /** The open file on the server (libraries need it), or null. */
  fileId(): string | null;
  canEdit(): boolean;
}

const THUMB_W = 64;
const THUMB_H = 44;

export class AssetsPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly renderer: Canvas2DRenderer;
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement;
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly host: AssetsHost | null;
  /** Libraries the person can use (null — not loaded yet). */
  private infos: LibraryInfo[] | null = null;
  private readonly payloads = new Map<string, LibraryPayload>();
  private loading: Promise<void> | null = null;
  /** Folded sections: 'page:<id>' and 'lib:<fileId>', remembered per file. */
  private collapsed: Set<string> | null = null;

  constructor(editor: Editor, renderer: Canvas2DRenderer, host?: AssetsHost) {
    this.editor = editor;
    this.renderer = renderer;
    this.host = host ?? null;
    this.search = h('input', { class: 'assets-search', type: 'search', placeholder: tr('Поиск'), spellcheck: false, 'aria-label': tr('Поиск компонентов') });
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.list = h('div', { class: 'assets-list', role: 'list' });
    const intro = h(
      'p',
      { class: 'assets-intro' },
      tr('Компоненты — элементы, которые повторяются в макете: кнопки, карточки, поля. На холст ставится их копия; измените сам компонент — изменятся все копии.'),
    );
    const librariesButton = h('button', { class: 'text-button assets-libraries', type: 'button', title: tr('Опубликовать компоненты этого файла или подключить библиотеку') }, icon('component', 14), h('span', {}, tr('Библиотеки')));
    librariesButton.addEventListener('click', () => void this.openLibraries());
    this.el = h('div', { class: 'assets-panel' }, intro, h('div', { class: 'assets-top' }, h('div', { class: 'assets-search-wrap' }, icon('component', 14), this.search), librariesButton), this.list);
    editor.events.on('change', ({ changes }) => {
      if (this.visible && !changes.isEmpty) this.schedule();
    });
    editor.events.on('document', () => {
      this.payloads.clear();
      this.infos = null;
      this.schedule();
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.render();
      void this.loadLibraries(true);
    }
  }

  private async openLibraries(): Promise<void> {
    const { LibrariesDialog } = await import('./libraries-dialog.ts');
    new LibrariesDialog({
      editor: this.editor,
      renderer: this.renderer,
      fileId: () => this.host?.fileId() ?? null,
      canEdit: () => this.host?.canEdit() ?? false,
      changed: () => void this.loadLibraries(true),
    });
  }

  /** On opening a file: tells when a library used in it has a newer publication. */
  async checkUpdates(): Promise<void> {
    const doc = this.editor.doc;
    if (!this.host?.fileId() || (doc.get(doc.rootId, 'libraries') ?? []).length === 0) return;
    await this.loadLibraries(true);
    const taken = takenUnits(doc);
    const names = (doc.get(doc.rootId, 'libraries') ?? [])
      .filter((link) => {
        const info = this.infos?.find((i) => i.fileId === link.fileId);
        return !!info && (taken.get(link.fileId) ?? []).some((u) => u.ref.publishedAt < info.publishedAt);
      })
      .map((link) => `«${link.name}»`);
    if (names.length && !doc.readOnly) this.editor.toast(tr('Есть обновление библиотеки {0}: вкладка «Компоненты» → «Обновить».', names.join(', ')));
  }

  /** The list of libraries and the publications of those switched on (again when `fresh`). */
  private loadLibraries(fresh = false): Promise<void> {
    if (!this.host?.fileId()) return Promise.resolve();
    if (this.loading && !fresh) return this.loading;
    this.loading = (async () => {
      try {
        this.infos = await libraryApi.list();
        const doc = this.editor.doc;
        for (const link of doc.get(doc.rootId, 'libraries') ?? []) {
          const info = this.infos.find((i) => i.fileId === link.fileId);
          const have = this.payloads.get(link.fileId);
          if (info && (!have || (have.publishedAt ?? 0) < info.publishedAt)) this.payloads.set(link.fileId, await libraryApi.get(link.fileId));
        }
      } catch {
        // Offline or no server: the file's own components still show.
      }
      if (this.visible) this.render();
    })();
    return this.loading;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.visible) this.render();
    }, 250);
  }

  private entries(): Entry[] {
    const doc = this.editor.doc;
    const out: Entry[] = [];
    const seenSets = new Set<NodeId>();
    for (const { id, page, set } of listComponents(doc)) {
      if (set) {
        if (seenSets.has(set)) continue;
        seenSets.add(set);
        out.push({ component: id, shown: set, name: doc.get(set, 'name'), page, variants: doc.children(set).length });
      } else {
        out.push({ component: id, shown: id, name: doc.get(id, 'name'), page, variants: 0 });
      }
    }
    return out;
  }

  private render(): void {
    const doc = this.editor.doc;
    const query = this.search.value.trim().toLowerCase();
    const alt = switchLayout(query);
    const entries = this.entries().filter((e) => {
      if (!query) return true;
      const text = `${e.name} ${doc.get(e.shown, 'description')}`.toLowerCase();
      return text.includes(query) || text.includes(alt);
    });
    clear(this.list);
    const libraryEntries = this.renderLibraries(query, alt);
    if (entries.length === 0 && !query && libraryEntries.length) {
      this.list.append(h('p', { class: 'hint' }, tr('В этом файле своих компонентов нет — ниже компоненты подключённых библиотек.')));
    } else if (entries.length === 0) {
      this.list.append(
        h(
          'p',
          { class: 'hint' },
          query ? tr('Ничего не найдено в этом файле.') : tr('В файле пока нет компонентов. Чтобы сделать компонент, выделите фрейм и нажмите ⌥⌘K (Ctrl+Alt+K) или «Объект → Создать компонент» в главном меню. Готовые компоненты других файлов — кнопка «Библиотеки».'),
        ),
      );
    }
    let currentPage: NodeId | null = null;
    let folded = false;
    for (const entry of entries) {
      if (entry.page !== currentPage) {
        currentPage = entry.page;
        const head = this.groupHead(`page:${entry.page}`, !!query, h('span', {}, doc.get(entry.page, 'name')));
        folded = head.folded;
        this.list.append(head.el);
      }
      if (folded) continue;
      const thumb = h('canvas', { class: 'asset-thumb', width: THUMB_W, height: THUMB_H, style: { width: `${THUMB_W}px`, height: `${THUMB_H}px` } });
      renderThumbnail(this.renderer, this.editor.scene, entry.shown, thumb, THUMB_W, THUMB_H);
      const description = doc.get(entry.shown, 'description');
      const item = h(
        'div',
        {
          class: 'asset-item',
          role: 'listitem',
          tabindex: 0,
          draggable: true,
          title: tr('{0}{1}\nПеретащите на холст или нажмите «Вставить»', entry.name, description ? `\n${description}` : ''),
        },
        thumb,
        h('div', { class: 'asset-text' }, h('span', { class: 'asset-name' }, entry.name), entry.variants > 0 ? h('span', { class: 'asset-meta' }, tr('Вариантов: {0}', entry.variants)) : description ? h('span', { class: 'asset-meta' }, description) : null),
      );
      // Explicit actions instead of "a click silently adds a copy".
      const insertButton = h('button', { class: 'text-button asset-action', type: 'button', title: tr('Поставить копию компонента в центр экрана') }, tr('Вставить'));
      const openButton = h('button', { class: 'text-button asset-action', type: 'button', title: tr('Перейти к самому компоненту, чтобы изменить его (изменятся все копии)') }, tr('Открыть'));
      item.append(h('div', { class: 'asset-actions' }, insertButton, openButton));
      const insert = () => {
        const editor = this.editor;
        const center = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
        const w = doc.get(entry.component, 'width');
        const hgt = doc.get(entry.component, 'height');
        // On a board — beside what is there, not over it.
        const at = editor.isBoardFile() ? freeSpotOnBoard(editor, center, w, hgt) : { x: center.x - w / 2, y: center.y - hgt / 2 };
        editor.placeInstance(entry.component, { x: Math.round(at.x), y: Math.round(at.y) });
      };
      const openMain = () => {
        const editor = this.editor;
        if (entry.page !== editor.pageId) editor.setPage(entry.page);
        editor.setSelection([entry.shown]);
        editor.zoomToSelection();
      };
      insertButton.addEventListener('click', insert);
      openButton.addEventListener('click', openMain);
      item.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        e.preventDefault();
        openMain();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === item) insert();
        e.stopPropagation();
      });
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(COMPONENT_DRAG_TYPE, entry.component);
        e.dataTransfer?.setData('text/plain', entry.name);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });
      this.list.append(item);
    }
    this.list.append(...libraryEntries);
  }

  /** Sections of the libraries switched on: their components, "Update" when there is a newer publication. */
  private renderLibraries(query: string, alt: string): HTMLElement[] {
    const doc = this.editor.doc;
    const out: HTMLElement[] = [];
    const taken = takenUnits(doc);
    for (const link of doc.get(doc.rootId, 'libraries') ?? []) {
      const payload = this.payloads.get(link.fileId);
      const info = this.infos?.find((i) => i.fileId === link.fileId);
      const used = taken.get(link.fileId) ?? [];
      const outdated = !!info && used.some((u) => u.ref.publishedAt < info.publishedAt);
      const group = this.groupHead(`lib:${link.fileId}`, !!query, icon('component', 12), h('span', {}, link.name));
      const head = group.el;
      head.classList.add('library');
      if (outdated && payload && !doc.readOnly) {
        const update = h('button', { class: 'link-button', type: 'button', title: tr('Взять новую публикацию библиотеки: копии в файле изменятся, свои правки копий останутся') }, tr('Обновить'));
        update.addEventListener('click', (e) => {
          e.stopPropagation();
          const n = updateFromLibrary(this.editor, payload);
          this.editor.toast(tr('Обновлено компонентов: {0}. Отменить — Mod+Z.', n).replace('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'));
          this.render();
        });
        head.append(update);
      }
      out.push(head);
      if (group.folded) continue;
      if (!payload) {
        out.push(this.infos && !info ? h('p', { class: 'hint' }, tr('Библиотека недоступна: её сняли с публикации или закрыли доступ.')) : skeletonRows(tr('Загрузка…'), 2, true));
        continue;
      }
      const shown = payload.components.filter((c) => {
        if (!query) return true;
        const text = `${c.name} ${c.description}`.toLowerCase();
        return text.includes(query) || text.includes(alt);
      });
      if (shown.length === 0) out.push(h('p', { class: 'hint' }, query ? tr('Ничего не найдено.') : tr('В библиотеке нет компонентов.')));
      for (const entry of shown) out.push(this.libraryItem(payload, entry));
    }
    return out;
  }

  /** A section's heading: a click folds or unfolds it. While searching, every section is open. */
  private groupHead(key: string, searching: boolean, ...label: (HTMLElement | SVGElement)[]): { el: HTMLElement; folded: boolean } {
    const collapsed = this.collapsedSet();
    const folded = !searching && collapsed.has(key);
    // Not a <button>: a library's heading holds its own «Обновить».
    const el = h('div', { class: 'assets-group foldable', role: 'button', tabindex: searching ? -1 : 0, 'aria-expanded': String(!folded), 'aria-disabled': String(searching), title: searching ? '' : folded ? tr('Развернуть раздел') : tr('Свернуть раздел') }, icon(folded ? 'chevronRight' : 'chevronDown', 12), ...label);
    const toggle = () => {
      if (searching) return;
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      this.saveCollapsed();
      this.render();
      (this.list.querySelector(`[data-group="${CSS.escape(key)}"]`) as HTMLElement | null)?.focus();
    };
    el.dataset.group = key;
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    return { el, folded };
  }

  private collapsedKey(): string {
    return `cs.assetsCollapsed.${this.host?.fileId() ?? 'local'}`;
  }

  private collapsedSet(): Set<string> {
    if (!this.collapsed) {
      let saved: unknown = null;
      try {
        saved = JSON.parse(localStorage.getItem(this.collapsedKey()) ?? 'null');
      } catch {
        // nothing remembered
      }
      this.collapsed = new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : []);
    }
    return this.collapsed;
  }

  private saveCollapsed(): void {
    try {
      localStorage.setItem(this.collapsedKey(), JSON.stringify([...this.collapsedSet()]));
    } catch {
      // private mode: folded until the page reloads
    }
  }

  private libraryItem(payload: LibraryPayload, entry: LibraryComponent): HTMLElement {
    const thumb = entry.thumb ? h('img', { class: 'asset-thumb', src: entry.thumb, width: THUMB_W, height: THUMB_H, alt: '' }) : h('div', { class: 'asset-thumb', style: { width: `${THUMB_W}px`, height: `${THUMB_H}px` } });
    const item = h(
      'div',
      { class: 'asset-item', role: 'listitem', tabindex: 0, draggable: !this.editor.doc.readOnly, title: tr('{0}{1}\nИз библиотеки «{2}». Перетащите на холст или нажмите «Вставить»', entry.name, entry.description ? `\n${entry.description}` : '', payload.name ?? '') },
      thumb,
      h('div', { class: 'asset-text' }, h('span', { class: 'asset-name' }, entry.name), h('span', { class: 'asset-meta' }, entry.variants > 0 ? tr('Вариантов: {0}', entry.variants) : entry.description || (payload.name ?? ''))),
    );
    const insertButton = h('button', { class: 'text-button asset-action', type: 'button', title: tr('Поставить копию компонента в центр экрана') }, tr('Вставить'));
    const openButton = h('button', { class: 'text-button asset-action', type: 'button', title: tr('Открыть библиотеку в новой вкладке, чтобы изменить компонент там') }, tr('Открыть'));
    item.append(h('div', { class: 'asset-actions' }, insertButton, openButton));
    const insert = () => {
      if (this.editor.doc.readOnly) return this.editor.toast(tr('Только просмотр: изменения не сохраняются.'));
      placeFromLibrary(this.editor, payload, entry);
    };
    const open = () => window.open(`/?file=${encodeURIComponent(payload.fileId ?? '')}&node=${encodeURIComponent(entry.id)}`, '_blank', 'noopener');
    insertButton.addEventListener('click', insert);
    openButton.addEventListener('click', open);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target === item) insert();
      e.stopPropagation();
    });
    item.addEventListener('dragstart', (e) => {
      // The component is taken into the file when the drag starts: the drop places a copy of it.
      if (!this.editor.doc.store.isAlive(entry.component)) this.editor.commit(tr('Компонент из библиотеки «{0}»', payload.name ?? ''), (tx) => importFromLibrary(tx, this.editor.doc, payload, [entry.id]));
      e.dataTransfer?.setData(COMPONENT_DRAG_TYPE, entry.component);
      e.dataTransfer?.setData('text/plain', entry.name);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    });
    return item;
  }
}
