// Left panel: pages and the layer tree (spec 9.1).
// Top of the list = top-most layer, as in every design tool.

import { tr } from '#core';
import type { MenuItem } from './context-menu.ts';
import { base64ToBytes, isFrameLike, type NodeId } from '#core';
import type { Editor } from '../editor.ts';
import { IS_MAC } from '../keyboard.ts';
import { clear, h, icon, typeIcon } from './dom.ts';
import { switchLayout } from '../keyboard.ts';

type DropZone = 'before' | 'after' | 'inside';

export type LeftTab = 'layers' | 'assets' | 'comments' | 'slides';
export type TabContent = { el: HTMLElement; setVisible(visible: boolean): void };

export class LayersPanel {
  readonly el: HTMLElement;
  private readonly editor: Editor;
  private readonly pagesEl: HTMLElement;
  private readonly treeEl: HTMLElement;
  private readonly collapsed = new Set<NodeId>();
  private readonly rows = new Map<NodeId, HTMLElement>();
  /**
   * The tree as a flat list (collapsed branches left out). Only the rows in
   * view (and a margin) are in the DOM: a file with tens of thousands of
   * layers made tens of thousands of rows the browser laid out for minutes.
   */
  private flat: { id: NodeId; depth: number }[] = [];
  private tree = false;
  private scroller: HTMLElement | null = null;
  private windowFrame = 0;
  /** Picture thumbnails by image hash (images never change under a hash). */
  private readonly thumbUrls = new Map<string, string>();
  private frame = 0;
  private renaming: NodeId | null = null;
  /** Opens the context menu for layer rows; set by the app. */
  onMenu: ((clientX: number, clientY: number) => void) | null = null;
  /** Right click on a page: the app opens its menu with these items. */
  onPageMenu: ((clientX: number, clientY: number, items: MenuItem[]) => void) | null = null;
  /** The last click on a page: a second one on the same page soon after renames it (the list is redrawn in between). */
  private pageClick: { page: NodeId; at: number } | null = null;
  private draggingPage: NodeId | null = null;
  /** A page to rename on the next drawing of the list (the list is redrawn a frame after a page switch). */
  private renamingPage: NodeId | null = null;
  private dragging: NodeId[] | null = null;
  private lastClicked: NodeId | null = null;
  /** Search and type filter of the layers list. */
  private readonly search: HTMLInputElement;
  private readonly filter: HTMLSelectElement;
  /** Collapses or expands the whole tree (whichever is the more useful now). */
  private readonly foldAll: HTMLButtonElement;
  /** Switches the left panel between layers and assets. */
  showTab: (tab: LeftTab) => void = () => undefined;

  constructor(editor: Editor, assets?: TabContent, comments?: TabContent, slides?: TabContent) {
    this.editor = editor;
    this.pagesEl = h('div', { class: 'pages', role: 'listbox', 'aria-label': tr('Страницы') });
    this.treeEl = h('div', { class: 'layer-tree', role: 'tree', 'aria-label': tr('Слои') });
    const addPage = h('button', { class: 'icon-button', type: 'button', title: tr('Добавить страницу'), onclick: () => editor.addPage() }, icon('plus'));
    // Tabs: layers of the page / assets of the file.
    const layersTab = h('button', { class: 'panel-tab active', type: 'button', role: 'tab', 'aria-selected': 'true' }, tr('Слои'));
    // A presentation: its slides first (FEAT-157).
    const slidesTab = h('button', { class: 'panel-tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, tr('Слайды'));
    const assetsTab = h('button', { class: 'panel-tab', type: 'button', role: 'tab', 'aria-selected': 'false', title: tr('Компоненты файла: повторяющиеся элементы — кнопки, карточки') }, tr('Компоненты'));
    // Three words do not fit the panel: comments are an icon at the right end of the tabs.
    const commentsTab = h('button', { class: 'panel-tab panel-tab-icon', type: 'button', role: 'tab', 'aria-selected': 'false', title: tr('Комментарии'), 'aria-label': tr('Комментарии') }, icon('comment'));
    // Search by name or text, filter by kind.
    this.search = h('input', { class: 'layers-search', type: 'search', placeholder: tr('Найти слой'), spellcheck: false, 'aria-label': tr('Поиск слоёв') });
    this.filter = h(
      'select',
      { class: 'layers-filter', 'aria-label': tr('Тип слоёв'), title: tr('Тип слоёв') },
      ...FILTERS.map((f) => h('option', { value: f.value }, f.label)),
    );
    this.search.addEventListener('input', () => this.render());
    this.filter.addEventListener('change', () => this.render());
    this.search.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        this.search.value = '';
        this.filter.value = '';
        this.render();
        this.search.blur();
      }
      if (e.key === 'Enter') {
        // Enter selects every match.
        const ids = [...this.rows.keys()];
        if (ids.length > 0) editor.setSelection(ids);
      }
    });
    this.foldAll = h('button', { class: 'icon-button layers-fold', type: 'button', onclick: () => (this.anyOpen() ? this.collapseAll() : this.expandAll()) });
    const searchBar = h('div', { class: 'layers-search-bar' }, icon('search', 14), this.search, h('div', { class: 'select-wrap' }, this.filter), this.foldAll);
    const body = h('div', { class: 'tab-body' }, searchBar, this.treeEl);
    const pagesSection = h('section', { class: 'panel-section' }, h('header', { class: 'section-header' }, h('h3', {}, tr('Страницы')), addPage), this.pagesEl);
    const show = (wanted: LeftTab) => {
      const tab: LeftTab = (wanted === 'assets' && !assets) || (wanted === 'comments' && !comments) || (wanted === 'slides' && !slides) ? 'layers' : wanted;
      for (const [id, button] of [['slides', slidesTab], ['layers', layersTab], ['assets', assetsTab], ['comments', commentsTab]] as const) {
        button.classList.toggle('active', tab === id);
        button.setAttribute('aria-selected', String(tab === id));
      }
      pagesSection.hidden = tab === 'assets' || tab === 'slides';
      clear(body);
      if (tab === 'slides') body.append(slides!.el);
      else if (tab === 'assets') body.append(assets!.el);
      else if (tab === 'comments') body.append(comments!.el);
      else body.append(searchBar, this.treeEl);
      assets?.setVisible(tab === 'assets');
      comments?.setVisible(tab === 'comments');
      slides?.setVisible(tab === 'slides');
      // A presentation always opens on its slides: the remembered tab is the design's.
      if (slides) return;
      try {
        localStorage.setItem('cs.leftTab', tab);
      } catch {
        // Storage unavailable: the tab is not remembered.
      }
    };
    layersTab.addEventListener('click', () => show('layers'));
    assetsTab.addEventListener('click', () => show('assets'));
    commentsTab.addEventListener('click', () => show('comments'));
    slidesTab.addEventListener('click', () => show('slides'));
    this.el = h(
      'aside',
      { class: 'panel layers-panel', 'aria-label': tr('Страницы, слои и ресурсы') },
      h('div', { class: 'panel-tabs', role: 'tablist' }, slides ? slidesTab : null, layersTab, assets ? assetsTab : null, comments ? commentsTab : null),
      pagesSection,
      (this.scroller = h('section', { class: 'panel-section grow' }, body)),
    );
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('cs.leftTab');
    } catch {
      saved = null;
    }
    if (slides) queueMicrotask(() => show('slides'));
    else if (saved === 'assets' || saved === 'comments') queueMicrotask(() => show(saved));
    this.showTab = show;
    editor.events.on('change', ({ changes }) => {
      // Only names, visibility, locking and structure affect this panel.
      let relevant = changes.structural;
      if (!relevant) {
        for (const keys of changes.updated.values()) {
          if (keys.has('name') || keys.has('visible') || keys.has('locked') || keys.has('layoutMode')) {
            relevant = true;
            break;
          }
        }
      }
      if (relevant) this.schedule();
    });
    editor.events.on('selection', (sel) => {
      // A layer picked on the canvas is the anchor of the next Shift+click range.
      if (sel.length === 1) this.lastClicked = sel[0]!;
      this.syncSelection(true);
    });
    editor.events.on('page', () => this.schedule());
    editor.events.on('document', () => this.schedule());
    editor.events.on('overlay', () => this.syncHover());
    this.scroller?.addEventListener('scroll', () => {
      if (!this.tree || this.windowFrame) return;
      this.windowFrame = requestAnimationFrame(() => {
        this.windowFrame = 0;
        this.renderWindow();
      });
    });
    this.render();
  }

  /** Starts renaming the first selected layer (Mod+R). */
  rename(): void {
    const id = this.editor.selection[0];
    if (!id) return;
    this.renaming = id;
    this.render();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const editor = this.editor;
    const doc = editor.doc;
    clear(this.pagesEl);
    for (const page of doc.pages()) {
      const active = page === editor.pageId;
      const item = h(
        'div',
        { class: `page-item${active ? ' active' : ''}`, role: 'option', 'aria-selected': String(active), tabindex: 0, draggable: !doc.readOnly },
        icon('page', 14),
        h('span', { class: 'label' }, doc.get(page, 'name')),
      );
      item.addEventListener('click', () => {
        const now = performance.now();
        const again = this.pageClick?.page === page && now - this.pageClick.at < 450;
        this.pageClick = again ? null : { page, at: now };
        editor.setPage(page);
        if (again && !doc.readOnly) this.renamePageAt(page);
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') editor.setPage(page);
        if (e.key === 'F2') this.renamePageAt(page);
      });
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        editor.setPage(page);
        const ro = doc.readOnly;
        this.onPageMenu?.(e.clientX, e.clientY, [
          { kind: 'action', label: tr('Переименовать'), disabled: ro, run: () => this.renamePageAt(page) },
          { kind: 'action', label: tr('Дублировать страницу'), disabled: ro, run: () => editor.duplicatePage(page) },
          { kind: 'separator' },
          { kind: 'action', label: tr('Удалить страницу'), disabled: ro || doc.pages().length <= 1, run: () => editor.deletePage(page) },
        ]);
      });
      // Order of pages: drag one above or below another.
      item.addEventListener('dragstart', (e) => {
        this.draggingPage = page;
        e.dataTransfer?.setData('text/plain', doc.get(page, 'name'));
      });
      item.addEventListener('dragend', () => {
        this.draggingPage = null;
        for (const el of this.pagesEl.children) el.classList.remove('drop-before', 'drop-after');
      });
      item.addEventListener('dragover', (e) => {
        if (!this.draggingPage || this.draggingPage === page) return;
        e.preventDefault();
        const r = item.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        item.classList.toggle('drop-before', before);
        item.classList.toggle('drop-after', !before);
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
      item.addEventListener('drop', (e) => {
        const moving = this.draggingPage;
        if (!moving || moving === page) return;
        e.preventDefault();
        const r = item.getBoundingClientRect();
        const others = doc.pages().filter((p) => p !== moving);
        const at = others.indexOf(page) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
        this.draggingPage = null;
        editor.movePage(moving, at);
      });
      this.pagesEl.append(item);
      if (this.renamingPage === page) {
        this.renamingPage = null;
        this.startRename(item.querySelector('.label') as HTMLElement, page);
      }
    }

    clear(this.treeEl);
    this.rows.clear();
    const query = this.search.value.trim().toLowerCase();
    const kind = this.filter.value;
    if (query || kind) {
      this.tree = false;
      this.renderMatches(query, kind);
      this.syncSelection(false);
      this.syncHover();
      return;
    }
    const children = [...doc.children(editor.pageId)].reverse();
    if (children.length === 0) {
      this.tree = false;
      this.treeEl.append(h('p', { class: 'hint' }, tr('На странице пока пусто. Нарисуйте фрейм (F) или прямоугольник (R).')));
      return;
    }
    // Top-most first, as on the canvas.
    this.flat = [];
    const visit = (id: NodeId, depth: number) => {
      this.flat.push({ id, depth });
      // A repeat group shows its own layers; the copies it makes are not edited by hand.
      if (!this.collapsed.has(id)) for (const child of [...doc.children(id)].reverse()) if (!doc.get(child, 'repeatCopy')) visit(child, depth + 1);
    };
    for (const id of children) visit(id, 0);
    this.tree = true;
    this.syncFoldButton();
    this.renderWindow();
  }

  /** Where the tree starts inside the scrolling section. */
  private treeTop(): number {
    const scroller = this.scroller!;
    return this.treeEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  /** The rows in view (and a margin around), with spacers for the rest. */
  private renderWindow(): void {
    if (!this.tree) return;
    const scroller = this.scroller!;
    const total = this.flat.length;
    const top = this.treeTop();
    const view = Math.max(scroller.clientHeight, 600);
    const start = Math.max(0, Math.floor((scroller.scrollTop - top) / ROW) - MARGIN);
    const end = Math.min(total, Math.max(start, Math.floor((scroller.scrollTop - top) / ROW)) + Math.ceil(view / ROW) + MARGIN);
    clear(this.treeEl);
    this.rows.clear();
    if (start > 0) this.treeEl.append(h('div', { class: 'tree-spacer', style: { height: `${start * ROW}px` } }));
    for (let i = start; i < end; i++) this.renderNode(this.flat[i]!.id, this.flat[i]!.depth);
    if (end < total) this.treeEl.append(h('div', { class: 'tree-spacer', style: { height: `${(total - end) * ROW}px` } }));
    this.syncSelection(false);
    this.syncHover();
  }

  /** Search results: a flat list of matching layers with their path (FR-LAY search). */
  private renderMatches(query: string, kind: string): void {
    const editor = this.editor;
    const doc = editor.doc;
    const alt = switchLayout(query);
    const filter = FILTERS.find((f) => f.value === kind);
    const matches: NodeId[] = [];
    doc.store.walk(editor.pageId, (id) => {
      if (filter && filter.value && !filter.types.includes(doc.type(id)) && !(filter.value === 'IMAGE' && doc.get(id, 'fills').some((p) => p.type === 'IMAGE'))) return;
      // Status filter (FR-CNV-071).
      if (filter?.value === 'READY' && doc.get(id, 'devStatus') !== 'READY_FOR_DEV') return;
      if (query) {
        const text = `${doc.get(id, 'name')} ${doc.type(id) === 'TEXT' ? doc.get(id, 'characters') : ''}`.toLowerCase();
        if (!text.includes(query) && !text.includes(alt)) return;
      }
      matches.push(id);
    });
    // Images are paints, not a layer type: check them separately.
    const shown = filter?.value === 'IMAGE' ? matches.filter((id) => doc.get(id, 'fills').some((p) => p.type === 'IMAGE')) : matches;
    this.treeEl.append(h('div', { class: 'layers-found' }, shown.length > 0 ? tr('Найдено: {0}. Enter — выделить все', shown.length) : tr('Ничего не найдено')));
    for (const id of shown.slice(0, 500)) {
      const path = doc.store
        .ancestors(id)
        .filter((a) => a !== editor.pageId && doc.type(a) !== 'PAGE' && doc.type(a) !== 'DOCUMENT')
        .reverse()
        .map((a) => doc.get(a, 'name'))
        .join(' / ');
      const row = h(
        'div',
        { class: 'layer-row found', role: 'treeitem', dataset: { id }, title: path ? `${path} / ${doc.get(id, 'name')}` : doc.get(id, 'name') },
        h('span', { class: 'type-icon' }, typeIcon(doc.type(id), isFrameLike(doc.type(id)) && doc.get(id, 'layoutMode') !== 'NONE')),
        h('span', { class: 'label' }, doc.get(id, 'name'), path ? h('span', { class: 'layer-path' }, path) : null),
      );
      this.bindSelect(row, id);
      row.addEventListener('dblclick', () => editor.zoomToSelection());
      row.addEventListener('mouseenter', () => editor.setHover(id));
      row.addEventListener('mouseleave', () => editor.setHover(null));
      this.rows.set(id, row);
      this.treeEl.append(row);
    }
    if (shown.length > 500) this.treeEl.append(h('p', { class: 'hint small' }, tr('…и ещё {0}. Уточните поиск.', shown.length - 500)));
  }

  /** Collapses every layer of the page to its top level (Alt+L, as in Figma). */
  collapseAll(): void {
    this.showTab('layers');
    for (const id of this.editor.doc.children(this.editor.pageId)) this.setSubtree(id, false);
    this.render();
    if (this.scroller) this.scroller.scrollTop = 0;
  }

  /** Expands every layer of the page (Shift+Alt+L). */
  expandAll(): void {
    this.showTab('layers');
    this.collapsed.clear();
    this.render();
    this.syncSelection(true);
  }

  /** Whether any top-level layer is expanded: then the button collapses, otherwise it expands. */
  private anyOpen(): boolean {
    const doc = this.editor.doc;
    return doc.children(this.editor.pageId).some((id) => doc.children(id).length > 0 && !this.collapsed.has(id));
  }

  private syncFoldButton(): void {
    const open = this.anyOpen();
    const title = open ? tr('Свернуть все слои') : tr('Развернуть все слои');
    this.foldAll.title = `${title} (${open ? (IS_MAC ? '⌥L' : 'Alt+L') : IS_MAC ? '⇧⌥L' : 'Shift+Alt+L'})`;
    this.foldAll.setAttribute('aria-label', title);
    clear(this.foldAll);
    this.foldAll.append(icon(open ? 'collapseAll' : 'expandAll', 14));
  }

  /** Puts the cursor in the layer search (palette: "Найти слой"). */
  focusSearch(): void {
    this.showTab('layers');
    this.search.focus();
    this.search.select();
  }

  private renderNode(id: NodeId, depth: number): void {
    const editor = this.editor;
    const doc = editor.doc;
    const type = doc.type(id);
    const kids = doc.children(id);
    const hasKids = kids.length > 0;
    const open = hasKids && !this.collapsed.has(id);
    const visible = doc.get(id, 'visible');
    const locked = doc.get(id, 'locked');

    const toggle = h(
      'button',
      {
        class: 'tree-toggle',
        type: 'button',
        tabindex: -1,
        'aria-label': open ? tr('Свернуть') : tr('Развернуть'),
        style: { visibility: hasKids ? 'inherit' : 'hidden' },
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          if (e.altKey) this.setSubtree(id, !open);
          else if (open) this.collapsed.add(id);
          else this.collapsed.delete(id);
          this.render();
        },
      },
      icon(open ? 'chevronDown' : 'chevronRight', 12),
    );
    const label = h('span', { class: 'label', title: doc.get(id, 'name') }, doc.get(id, 'name'));
    const eye = h(
      'button',
      { class: `row-action${visible ? '' : ' on'}`, type: 'button', tabindex: -1, title: visible ? tr('Скрыть') : tr('Показать'), onclick: (e: MouseEvent) => {
        e.stopPropagation();
        editor.commit(tr('Видимость'), (tx) => tx.set(id, 'visible', !visible));
      } },
      icon(visible ? 'eye' : 'eyeOff', 14),
    );
    const lock = h(
      'button',
      { class: `row-action${locked ? ' on' : ''}`, type: 'button', tabindex: -1, title: locked ? tr('Открепить') : tr('Закрепить'), onclick: (e: MouseEvent) => {
        e.stopPropagation();
        editor.commit(tr('Закрепление'), (tx) => tx.set(id, 'locked', !locked));
      } },
      icon(locked ? 'lock' : 'unlock', 14),
    );
    const row = h(
      'div',
      {
        class: `layer-row type-${type.toLowerCase().replace('_', '-')}${visible ? '' : ' hidden-layer'}${editor.isInstanceLayer(id) ? ' in-instance' : ''}`,
        role: 'treeitem',
        'aria-level': String(depth + 1),
        'aria-expanded': hasKids ? String(open) : undefined,
        draggable: true,
        // Deep nesting: after six levels each step is narrower, so names stay readable.
        style: { paddingLeft: `${8 + Math.min(depth, 6) * 14 + Math.max(0, depth - 6) * 5}px` },
        dataset: { id },
      },
      toggle,
      this.thumbOf(id) ?? h('span', { class: `type-icon${doc.get(id, 'isMask') ? ' mask' : ''}`, title: doc.get(id, 'isMask') ? tr('Маска: обрезает слои над собой в этой группе') : undefined }, doc.get(id, 'isMask') ? icon('mask', 14) : typeIcon(type, isFrameLike(type) && doc.get(id, 'layoutMode') !== 'NONE')),
      label,
      this.effectBadges(id),
      lock,
      eye,
    );
    this.bindSelect(row, id);
    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.startRename(label, id);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // On a Mac, Ctrl+click arrives as a context menu: it adds to the selection (as Ctrl does on Windows);
      // a real right click (button 2, or two fingers on a trackpad) opens the menu.
      if (IS_MAC && e.ctrlKey && e.button === 0) return;
      if (!editor.selection.includes(id)) editor.setSelection([id]);
      this.onMenu?.(e.clientX, e.clientY);
    });
    row.addEventListener('mouseenter', () => editor.setHover(id));
    row.addEventListener('mouseleave', () => editor.setHover(null));
    this.attachDrag(row, id);
    this.rows.set(id, row);
    this.treeEl.append(row);
    if (this.renaming === id) {
      this.renaming = null;
      queueMicrotask(() => this.startRename(label, id));
    }
  }

  /** A picture layer shows its picture instead of a type icon. */
  private thumbOf(id: NodeId): HTMLElement | null {
    const doc = this.editor.doc;
    const paint = doc.get(id, 'fills').find((p) => p.visible && p.type === 'IMAGE');
    if (!paint || paint.type !== 'IMAGE') return null;
    // A video: the play sign (as Figma marks a video layer), not a picture.
    if (doc.store.blobs.get(paint.imageHash)?.mime.startsWith('video/')) return h('span', { class: 'type-icon', title: tr('Видео') }, icon('play'));
    let url = this.thumbUrls.get(paint.imageHash);
    if (!url) {
      const blob = doc.store.blobs.get(paint.imageHash);
      if (!blob) return null;
      url = URL.createObjectURL(new Blob([base64ToBytes(blob.data) as BlobPart], { type: blob.mime }));
      this.thumbUrls.set(paint.imageHash, url);
    }
    return h('span', { class: 'type-icon layer-thumb' }, h('img', { src: url, alt: '', draggable: false }));
  }

  /** Effects right in the row (shadow, blur), so they are seen without opening the properties. */
  private effectBadges(id: NodeId): HTMLElement | string {
    const effects = this.editor.doc.get(id, 'effects').filter((e) => e.visible);
    if (!effects.length) return '';
    const shadow = effects.filter((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW').length;
    const blur = effects.filter((e) => e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR').length;
    const names = [shadow ? tr('тень{0}', shadow > 1 ? ` ×${shadow}` : '') : '', blur ? tr('размытие') : '', effects.some((e) => e.type === 'NOISE') ? tr('шум') : ''].filter(Boolean);
    return h('span', { class: 'layer-effects', title: tr('Эффекты: {0}', names.join(', ')) }, shadow ? icon('shadow', 12) : '', blur ? icon('blur', 12) : '');
  }

  private setSubtree(id: NodeId, open: boolean): void {
    const doc = this.editor.doc;
    const visit = (n: NodeId) => {
      if (open) this.collapsed.delete(n);
      else this.collapsed.add(n);
      for (const c of doc.children(n)) visit(c);
    };
    visit(id);
  }

  /**
   * Selection happens on press, as in Figma — not on click: Safari turns
   * Shift+click on a draggable row into extending the text selection and the
   * click never comes, and on a Mac Ctrl+click is a context menu, not a click.
   */
  private bindSelect(row: HTMLElement, id: NodeId): void {
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return;
      const modifier = e.shiftKey || e.metaKey || e.ctrlKey;
      // No text selection and no drag while picking several layers. Safari extends a text selection
      // across the whole panel on Shift+click even so: drop any text selection on every press.
      if (modifier) e.preventDefault();
      window.getSelection()?.removeAllRanges();
      // A plain press on an already selected layer keeps the selection, so several layers can be dragged.
      if (!modifier && this.editor.selection.includes(id) && this.editor.selection.length > 1) {
        row.addEventListener('click', () => this.onClick(new MouseEvent('click'), id), { once: true });
        return;
      }
      this.onClick(e, id);
    });
  }

  private onClick(e: MouseEvent, id: NodeId): void {
    const editor = this.editor;
    // ⌘ on a Mac, Ctrl elsewhere; Ctrl+click on a Mac works too (see the context menu handler).
    const mod = e.metaKey || e.ctrlKey;
    const order = this.tree ? this.flat.map((f) => f.id) : [...this.rows.keys()];
    if (e.shiftKey && this.lastClicked && order.includes(this.lastClicked)) {
      // Range selection in list order.
      const a = order.indexOf(this.lastClicked);
      const b = order.indexOf(id);
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      // As in Figma: Shift selects the range from the last clicked layer; with Mod it adds to the selection.
      editor.setSelection(mod ? [...new Set([...editor.selection, ...range])] : range);
      return;
    } else if (mod || e.shiftKey) {
      editor.toggleSelection(id);
    } else {
      editor.setSelection([id]);
    }
    this.lastClicked = id;
  }

  /** Renames a page in place, once the list is drawn again. */
  private renamePageAt(page: NodeId): void {
    this.renamingPage = page;
    this.schedule();
  }

  private startRename(label: HTMLElement, id: NodeId): void {
    const doc = this.editor.doc;
    const input = h('input', { class: 'rename-input', type: 'text', value: doc.get(id, 'name'), spellcheck: false });
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (save && value && value !== doc.get(id, 'name')) this.editor.commit(tr('Переименовать'), (tx) => tx.set(id, 'name', value));
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  private attachDrag(row: HTMLElement, id: NodeId): void {
    const editor = this.editor;
    row.addEventListener('dragstart', (e) => {
      this.dragging = editor.selection.includes(id) ? editor.topLevelSelection() : [id];
      // Layers of an instance keep the component's order.
      if (this.dragging.some((m) => editor.isInstanceLayer(m))) {
        e.preventDefault();
        this.dragging = null;
        editor.toast(tr('Порядок слоёв копии задаёт компонент'));
        return;
      }
      e.dataTransfer?.setData('text/plain', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      this.dragging = null;
      this.clearDropMarks();
    });
    row.addEventListener('dragover', (e) => {
      if (!this.dragging) return;
      const zone = this.zone(e, row, id);
      if (!zone) return;
      e.preventDefault();
      this.clearDropMarks();
      row.classList.add(`drop-${zone}`);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const moving = this.dragging;
      const zone = this.zone(e, row, id);
      this.clearDropMarks();
      if (!moving || !zone) return;
      const doc = editor.doc;
      editor.commit(tr('Переместить слой'), (tx) => {
        // The list is shown top-most first, so "before" in the list means "after" in paint order.
        for (const m of moving) {
          if (zone === 'inside') editor.reparentKeepingPosition(tx, m, id, { at: 'end' });
          else {
            const parent = doc.parent(id)!;
            const position = zone === 'before' ? { after: id } : { before: id };
            if (doc.parent(m) === parent) tx.move(m, parent, position);
            else editor.reparentKeepingPosition(tx, m, parent, position);
          }
        }
      });
    });
  }

  private zone(e: DragEvent, row: HTMLElement, id: NodeId): DropZone | null {
    const moving = this.dragging ?? [];
    if (moving.some((m) => this.editor.doc.store.isAncestorOrSelf(m, id))) return null;
    const rect = row.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const doc = this.editor.doc;
    const canInside = this.editor.acceptsChildren(id) && !(doc.type(id) === 'COMPONENT_SET' && moving.some((m) => doc.type(m) !== 'COMPONENT'));
    const parent = doc.parent(id);
    const canBeside = parent !== null && !this.editor.isInstanceLayer(id) && this.editor.acceptsChildren(parent);
    if (canInside && (!canBeside || (y > 0.25 && y < 0.75))) return 'inside';
    if (!canBeside) return null;
    return y < 0.5 ? 'before' : 'after';
  }

  private clearDropMarks(): void {
    for (const r of this.rows.values()) r.classList.remove('drop-before', 'drop-after', 'drop-inside');
  }

  /** Highlights selected rows; expands and scrolls to them (FR-LYR-006). */
  private syncSelection(reveal: boolean): void {
    const editor = this.editor;
    const selected = new Set(editor.selection);
    let needsRender = false;
    if (reveal) {
      for (const id of editor.selection) {
        for (const a of editor.doc.store.ancestors(id)) {
          if (this.collapsed.delete(a)) needsRender = true;
        }
      }
    }
    // Expanding re-renders the rows; the scroll below still has to bring the layer into view (BUG-061).
    if (needsRender) this.render();
    // A structural re-render may be pending (rAF-scheduled) while reveal runs synchronously — the
    // selected layer may not be in `flat` yet (e.g. just created). Flush it now so findIndex works.
    if (reveal && this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.render();
    }
    for (const [id, row] of this.rows) {
      row.classList.toggle('selected', selected.has(id));
      row.setAttribute('aria-selected', String(selected.has(id)));
      const parentSelected = editor.doc.store.ancestors(id).some((a) => selected.has(a));
      row.classList.toggle('child-of-selected', parentSelected && !selected.has(id));
    }
    if (reveal && editor.selection.length > 0) {
      const last = editor.selection[editor.selection.length - 1]!;
      if (this.tree && this.scroller) {
        // The row may not be in the DOM: scroll by its place in the list.
        const index = this.flat.findIndex((f) => f.id === last);
        if (index < 0) return;
        const scroller = this.scroller;
        const y = this.treeTop() + index * ROW;
        // Out of view: to the middle of the panel, not flush with its edge, so the layer and what is around it are seen (BUG-063).
        if (y < scroller.scrollTop || y + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW / 2 - scroller.clientHeight / 2;
        if (!this.rows.has(last)) this.renderWindow();
      } else this.rows.get(last)?.scrollIntoView({ block: 'nearest' });
    }
  }

  private syncHover(): void {
    for (const [id, row] of this.rows) row.classList.toggle('hovered', id === this.editor.hover);
  }
}

/** Height of a layer row (as in the styles) and how many rows are kept above and below the view. */
const ROW = 28;
const MARGIN = 30;

/** Kinds for the layer filter. */
const FILTERS: { value: string; label: string; types: string[] }[] = [
  { value: '', label: tr('Все'), types: [] },
  { value: 'FRAME', label: tr('Фреймы'), types: ['FRAME'] },
  { value: 'SECTION', label: tr('Секции'), types: ['SECTION'] },
  { value: 'READY', label: tr('Готово к разработке'), types: ['SECTION'] },
  { value: 'COMPONENT', label: tr('Компоненты'), types: ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'] },
  { value: 'GROUP', label: tr('Группы'), types: ['GROUP', 'BOOLEAN_OPERATION'] },
  { value: 'TEXT', label: tr('Текст'), types: ['TEXT'] },
  { value: 'SHAPE', label: tr('Фигуры'), types: ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'VECTOR'] },
  { value: 'IMAGE', label: tr('Изображения'), types: ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'FRAME'] },
];
