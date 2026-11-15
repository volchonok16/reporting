// «Сравнить изменения» (step 7, as Dev Mode's Compare changes): one frame — or
// any layer — in a saved version next to the same frame now. On the left the
// file's versions (the latest one where this frame differs is opened first);
// on the right the two pictures with the changed layers outlined, and below
// either the properties, layer by layer, «было → стало», or the frame's code
// then and now, line by line. Nothing here changes the file, except «Вернуть
// из версии» for those who can edit (one undo step).

import { deserialize, locale, restoreVersion, tr, type Document, type NodeId } from '#core';
import { SceneGraph, type Canvas2DRenderer } from '#render';
import { versions as api, type VersionInfo } from '../cloud.ts';
import { compareCode, compareLayer, layerDiffers, type LayerChange } from '../compare-changes.ts';
import { DEFAULT_CODE_OPTIONS, type CodeLang } from '../dev-code.ts';
import { shownPageBackground, type Editor } from '../editor.ts';
import { IS_MAC } from '../keyboard.ts';
import { h, icon, skeletonRows } from './dom.ts';

const COLORS = { changed: '#f59e0b', removed: '#ef4444', added: '#22c55e' } as const;
/** How many versions are opened, newest first, looking for one where the frame differs. */
const LOOK_BACK = 12;

export interface CompareHost {
  editor: Editor;
  renderer: Canvas2DRenderer;
  fileId: string;
  canEdit: boolean;
  toast(text: string, kind?: 'error'): void;
}

const when = (at: number) => new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function pageOf(doc: Document, id: NodeId): NodeId | null {
  let cur: NodeId | null = id;
  while (cur && doc.type(cur) !== 'PAGE') cur = doc.parent(cur);
  return cur;
}

/** The layer alone, fitted into the canvas, its changed layers outlined. */
export function drawLayer(canvas: HTMLCanvasElement, doc: Document, id: NodeId, renderer: Canvas2DRenderer, marks: { id: NodeId; color: string }[], empty: string): void {
  const width = canvas.clientWidth || 400;
  const height = canvas.clientHeight || 300;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const page = doc.store.isAlive(id) ? pageOf(doc, id) : null;
  if (!page) {
    ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.font = `${13 * dpr}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(empty, canvas.width / 2, canvas.height / 2);
    return;
  }
  const bg = shownPageBackground(doc.get(page, 'backgroundColor'));
  ctx.fillStyle = `rgb(${bg.r * 255} ${bg.g * 255} ${bg.b * 255})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scene = new SceneGraph(doc, page);
  const b = scene.bounds(id);
  const pad = 20;
  const k = Math.min((width - pad * 2) / Math.max(1, b.width), (height - pad * 2) / Math.max(1, b.height), 2);
  const ox = (width - b.width * k) / 2 - b.x * k;
  const oy = (height - b.height * k) / 2 - b.y * k;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
  renderer.renderNode(ctx, scene, id, b, k * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const m of marks) {
    if (m.id === id || !doc.store.isAlive(m.id) || pageOf(doc, m.id) !== page) continue;
    const r = scene.bounds(m.id);
    ctx.strokeStyle = m.color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + r.x * k - 2, oy + r.y * k - 2, r.width * k + 4, r.height * k + 4);
  }
}

export class CompareDialog {
  private readonly host: CompareHost;
  private readonly id: NodeId;
  private readonly overlay: HTMLElement;
  private readonly list: HTMLElement;
  private readonly main: HTMLElement;
  private items: VersionInfo[] = [];
  private selected: string | null = null;
  /** Versions known to have this frame as it is now. */
  private readonly same = new Set<string>();
  private readonly docs = new Map<string, Document>();
  private view: 'props' | 'code' = 'props';
  private lang: CodeLang = 'css';
  private readonly previousOnLoad: (hash: string) => void;
  private redraw: (() => void) | null = null;

  /** A version to open first (the one approved — «Что изменилось»), instead of looking for the latest different one. */
  private readonly preferred: string | null;

  constructor(host: CompareHost, id: NodeId, version: string | null = null) {
    this.host = host;
    this.id = id;
    this.preferred = version;
    this.list = h('div', { class: 'versions-list', role: 'listbox', 'aria-label': tr('Версии') });
    this.main = h('div', { class: 'versions-main' });
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const name = String(host.editor.doc.get(id, 'name') ?? '');
    this.overlay = h(
      'div',
      { class: 'versions-view compare-view', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Сравнить изменения') },
      h('header', { class: 'versions-header' }, h('h2', {}, tr('Сравнить изменения')), h('span', { class: 'versions-file' }, `«${name}»`), h('span', { class: 'crop-spacer' }), close),
      h('div', { class: 'versions-body' }, this.list, this.main),
    );
    this.overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.overlay);
    close.focus();
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
    if (!this.items.length) {
      this.list.replaceChildren(h('p', { class: 'hint' }, tr('Версий пока нет. Они сохраняются сами каждые 10 минут работы и когда все вышли из файла; сохранить сейчас — {0}.', IS_MAC ? '⌥⌘S' : 'Ctrl+Alt+S')));
      this.main.replaceChildren(h('p', { class: 'hint' }, tr('Сравнивать не с чем.')));
      return;
    }
    if (this.preferred && this.items.some((v) => v.id === this.preferred)) {
      this.selected = this.preferred;
      this.renderList();
      await this.show();
      return;
    }
    this.renderList();
    // The latest version where the frame was different: newest first, a few back.
    this.main.replaceChildren(h('p', { class: 'hint' }, tr('Ищу последнюю версию, где «{0}» был другим…', String(this.host.editor.doc.get(this.id, 'name') ?? ''))));
    let found: string | null = null;
    for (const v of this.items.slice(0, LOOK_BACK)) {
      try {
        const doc = await this.versionDoc(v.id);
        if (layerDiffers(doc, this.host.editor.doc, this.id)) {
          found = v.id;
          break;
        }
        this.same.add(v.id);
        this.renderList();
      } catch {
        break;
      }
      if (!this.overlay.isConnected || this.selected) return;
    }
    if (this.selected) return;
    this.selected = found ?? this.items[0]!.id;
    this.renderList();
    await this.show();
  }

  private renderList(): void {
    this.list.replaceChildren(
      ...this.items.map((v) => {
        const row = h(
          'button',
          { class: `versions-row${v.id === this.selected ? ' active' : ''}${v.name ? ' named' : ''}`, type: 'button', role: 'option', 'aria-selected': String(v.id === this.selected) },
          h('span', { class: 'versions-name' }, v.name ?? tr('Автосохранение')),
          h('span', { class: 'versions-meta' }, [when(v.at), v.authors.length ? v.authors.join(', ') : v.by].filter(Boolean).join(' · ')),
          this.same.has(v.id) ? h('span', { class: 'versions-desc' }, tr('Этот слой — как сейчас')) : null,
        );
        row.addEventListener('click', () => {
          this.selected = v.id;
          this.renderList();
          void this.show();
        });
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
    const vid = this.selected;
    if (!vid) return;
    this.main.replaceChildren(h('p', { class: 'hint' }, tr('Открываю версию…')));
    let version: Document;
    try {
      version = await this.versionDoc(vid);
    } catch (error) {
      this.main.replaceChildren(h('p', { class: 'hint' }, error instanceof Error ? error.message : String(error)));
      return;
    }
    if (this.selected !== vid || !this.overlay.isConnected) return;
    const info = this.items.find((v) => v.id === vid)!;
    const current = this.host.editor.doc;
    const id = this.id;
    const changes = compareLayer(version, current, id);
    const existed = version.store.isAlive(id);
    if (!current.store.isAlive(id)) {
      this.main.replaceChildren(h('p', { class: 'hint' }, tr('Слоя уже нет в файле.')));
      return;
    }

    const left = h('canvas', { class: 'versions-canvas' });
    const right = h('canvas', { class: 'versions-canvas' });
    const count = changes.length;
    const summary = !existed ? tr('Слоя ещё не было в этой версии') : count ? tr('Изменено слоёв: {0}', count) : tr('Как сейчас: изменений нет');
    const restore =
      this.host.canEdit && existed && count && !current.readOnly
        ? h('button', { class: 'text-button', type: 'button', onclick: () => this.restore(version, info) }, tr('Вернуть из версии'))
        : null;
    const tabs = h('div', { class: 'segmented', role: 'tablist', 'aria-label': tr('Что показать') });
    const content = h('div', { class: 'compare-content' });
    const lang = h('select', { class: 'field-select', 'aria-label': tr('Язык кода') }, h('option', { value: 'css' }, 'HTML + CSS'), h('option', { value: 'swiftui' }, 'SwiftUI'), h('option', { value: 'compose' }, 'Jetpack Compose'));
    lang.value = this.lang;
    const langWrap = h('div', { class: 'select-wrap' }, lang);
    const render = () => {
      tabs.replaceChildren(
        ...(
          [
            ['props', tr('Свойства')],
            ['code', tr('Код')],
          ] as const
        ).map(([v, label]) => {
          const b = h('button', { class: `segment${this.view === v ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(this.view === v) }, label);
          b.addEventListener('click', () => {
            this.view = v;
            render();
          });
          return b;
        }),
      );
      langWrap.hidden = this.view !== 'code';
      content.replaceChildren(this.view === 'props' ? this.propsList(changes, existed) : this.codeDiff(version));
    };
    lang.addEventListener('change', () => {
      this.lang = lang.value as CodeLang;
      render();
    });
    this.main.replaceChildren(
      h('div', { class: 'versions-tools' }, h('span', { class: 'versions-summary' }, summary), h('span', { class: 'crop-spacer' }), restore),
      h('div', { class: 'versions-panes compare-panes' }, h('figure', {}, h('figcaption', {}, info.name ?? tr('Версия · {0}', when(info.at))), left), h('figure', {}, h('figcaption', {}, tr('Сейчас')), right)),
      h('div', { class: 'versions-tools' }, tabs, langWrap, h('span', { class: 'compare-legend' }, ...legend())),
      content,
    );
    render();
    const marks = (kinds: LayerChange['kind'][]) => changes.filter((c) => kinds.includes(c.kind)).map((c) => ({ id: c.id, color: COLORS[c.kind] }));
    this.redraw = () => {
      if (!left.isConnected) return;
      drawLayer(left, version, id, this.host.renderer, marks(['changed', 'removed']), tr('Слоя ещё не было'));
      drawLayer(right, current, id, this.host.renderer, marks(['changed', 'added']), tr('Слоя нет'));
    };
    requestAnimationFrame(() => this.redraw?.());
  }

  private propsList(changes: LayerChange[], existed: boolean): HTMLElement {
    if (!existed) return h('p', { class: 'hint' }, tr('Слой появился после этой версии: всё в нём новое.'));
    if (!changes.length) return h('p', { class: 'hint' }, tr('В этой версии слой был таким же, как сейчас. Выберите версию раньше.'));
    const kindText = (c: LayerChange) => (c.kind === 'added' ? tr('добавлен') : c.kind === 'removed' ? tr('удалён') : c.moved && !c.props.length ? tr('перемещён') : c.moved ? tr('перемещён и изменён') : '');
    return h(
      'ul',
      { class: 'compare-layers' },
      ...changes.map((c) =>
        h(
          'li',
          { class: `compare-layer ${c.kind}`, style: { paddingLeft: `${Math.min(c.depth, 8) * 14}px` } },
          h('div', { class: 'compare-layer-head' }, h('i', { style: { background: COLORS[c.kind] } }), h('strong', {}, c.name), kindText(c) ? h('span', { class: 'compare-kind' }, kindText(c)) : null),
          c.props.length
            ? h(
                'table',
                { class: 'compare-props' },
                h('tbody', {}, ...c.props.map((p) => h('tr', {}, h('th', { scope: 'row' }, p.label), h('td', { class: 'compare-before' }, p.before), h('td', { class: 'compare-arrow', 'aria-hidden': 'true' }, '→'), h('td', { class: 'compare-after' }, p.after)))),
              )
            : null,
        ),
      ),
    );
  }

  private codeDiff(version: Document): HTMLElement {
    const lines = compareCode(version, this.host.editor.doc, this.id, this.lang, DEFAULT_CODE_OPTIONS);
    if (!lines.some((l) => l.kind !== 'same')) return h('p', { class: 'hint' }, tr('Код тот же, что в этой версии.'));
    const added = lines.filter((l) => l.kind === 'added').length;
    const removed = lines.filter((l) => l.kind === 'removed').length;
    return h(
      'div',
      {},
      h('p', { class: 'compare-code-count' }, h('span', { class: 'compare-plus' }, `+${added}`), ' ', h('span', { class: 'compare-minus' }, `−${removed}`), ' ', tr('строк')),
      h('pre', { class: 'code-block compare-code', tabIndex: 0 }, ...lines.map((l) => h('span', { class: `compare-line ${l.kind}` }, `${l.kind === 'added' ? '+ ' : l.kind === 'removed' ? '− ' : '  '}${l.text}\n`))),
    );
  }

  private restore(version: Document, info: VersionInfo): void {
    const editor = this.host.editor;
    if (editor.doc.readOnly) return;
    const page = pageOf(editor.doc, this.id) ?? editor.pageId;
    editor.commit(tr('Вернуть слой из версии'), (tx) => restoreVersion(tx, editor.doc, version, [this.id], page));
    this.host.toast(tr('«{0}» — как в версии от {1}. Отменить — {2}.', String(version.get(this.id, 'name') ?? ''), when(info.at), IS_MAC ? '⌘Z' : 'Ctrl+Z'));
    void this.show();
  }

  close(): void {
    this.host.renderer.images.onLoad = this.previousOnLoad;
    this.redraw = null;
    this.overlay.remove();
  }
}

function legend(): HTMLElement[] {
  return (
    [
      ['changed', tr('изменён')],
      ['added', tr('добавлен')],
      ['removed', tr('удалён')],
    ] as const
  ).map(([k, label]) => h('span', {}, h('i', { style: { background: COLORS[k] } }), label));
}
