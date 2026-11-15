// "Libraries" window (FR-LIB): publish the components of this file for other
// files, and switch on the libraries this person can use. Opened from the
// "Components" tab. Switching a library on is an ordinary change of the file
// (everyone in it sees the same list; undo works); what was already used from
// a library stays in the file when it is switched off.

import { locale, tr, type LibraryLink } from '#core';
import { renderThumbnail, type Canvas2DRenderer } from '#render';
import { CloudError, libraries, type LibraryInfo } from '../cloud.ts';
import type { Editor } from '../editor.ts';
import { buildLibrary, planLibrarySwap, swapLibrary, type LibraryPayload, type LibrarySwapPlan } from '../library.ts';
import { clear, h, icon, skeletonRows } from './dom.ts';

export interface LibrariesHost {
  editor: Editor;
  renderer: Canvas2DRenderer;
  fileId(): string | null;
  canEdit(): boolean;
  /** Something changed: the panel loads the libraries again. */
  changed(): void;
}

const date = (ms: number) => new Date(ms).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A component's picture for the library list (PNG, small). */
function thumbnail(host: LibrariesHost, id: string): string | undefined {
  try {
    const canvas = document.createElement('canvas');
    renderThumbnail(host.renderer, host.editor.scene, id, canvas, 64, 44);
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

export class LibrariesDialog {
  private readonly overlay: HTMLElement;
  private readonly body: HTMLElement;
  private readonly host: LibrariesHost;
  private list: LibraryInfo[] | null = null;
  private busy = false;
  /** «Заменить…» open for a linked library: the one chosen instead, and what the swap would do. */
  private swap: { from: LibraryLink; to: string; payload?: LibraryPayload; plan?: LibrarySwapPlan; loading?: boolean } | null = null;

  constructor(host: LibrariesHost) {
    this.host = host;
    this.body = h('div', { class: 'libraries-body' });
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h('div', { class: 'dialog libraries-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Библиотеки') }, h('header', { class: 'dialog-header' }, h('h2', {}, tr('Библиотеки')), close), this.body);
    this.overlay = h('div', { class: 'dialog-overlay' }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.overlay);
    this.render();
    void this.load();
  }

  close(): void {
    this.overlay.remove();
  }

  private async load(): Promise<void> {
    if (!this.host.fileId()) return;
    try {
      this.list = await libraries.list();
    } catch (error) {
      this.list = [];
      this.host.editor.toast(error instanceof CloudError ? error.message : tr('Не удалось загрузить библиотеки'), 'error');
    }
    this.render();
  }

  private linked(): LibraryLink[] {
    const d = this.host.editor.doc;
    return d.get(d.rootId, 'libraries') ?? [];
  }

  private setLinked(next: LibraryLink[], label: string): void {
    const d = this.host.editor.doc;
    this.host.editor.commit(label, (tx) => tx.set(d.rootId, 'libraries', next));
    this.host.changed();
    this.render();
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await fn();
    } catch (error) {
      this.host.editor.toast(error instanceof CloudError ? error.message : tr('Не получилось: {0}', error instanceof Error ? error.message : String(error)), 'error');
    } finally {
      this.busy = false;
      await this.load();
      this.host.changed();
    }
  }

  private render(): void {
    clear(this.body);
    const fileId = this.host.fileId();
    if (!fileId) {
      this.body.append(h('p', { class: 'libraries-empty' }, tr('Библиотеки работают в файлах на сервере. Войдите и сохраните файл на сервер.')));
      return;
    }
    const editor = this.host.editor;
    const d = editor.doc;
    const mine = this.list?.find((l) => l.fileId === fileId) ?? null;

    // This file.
    const own = h('section', { class: 'libraries-section' }, h('h3', {}, tr('Этот файл')));
    const count = buildLibrary(d).components.length;
    if (mine) own.append(h('p', { class: 'libraries-status' }, tr('Опубликован как библиотека {0}. Компонентов: {1}.', date(mine.publishedAt), mine.components)));
    else own.append(h('p', { class: 'libraries-status' }, count > 0 ? tr('Компонентов в файле: {0}. Опубликуйте их, и их можно будет ставить в других файлах.', count) : tr('В файле нет компонентов, публиковать нечего.')));
    const publish = h(
      'button',
      { class: 'text-button primary', type: 'button', disabled: this.busy || count === 0 || !this.host.canEdit() },
      mine ? tr('Опубликовать изменения') : tr('Опубликовать компоненты'),
    );
    publish.addEventListener('click', () =>
      void this.run(async () => {
        const payload = buildLibrary(d, (id) => thumbnail(this.host, id));
        await libraries.publish(fileId, payload);
        editor.toast(tr('Библиотека опубликована: компонентов {0}. В файлах, где она подключена, появится «Обновить».', payload.components.length));
      }),
    );
    const actions = h('div', { class: 'libraries-actions' }, publish);
    if (mine && this.host.canEdit()) {
      const unpublish = h('button', { class: 'text-button', type: 'button', disabled: this.busy }, tr('Снять с публикации'));
      unpublish.addEventListener('click', () => void this.run(async () => void (await libraries.unpublish(fileId))));
      actions.append(unpublish);
    }
    if (!this.host.canEdit()) own.append(h('p', { class: 'libraries-note' }, tr('Публиковать могут владелец файла и те, кто может редактировать.')));
    own.append(actions);
    this.body.append(own);

    // Libraries to switch on.
    const others = h('section', { class: 'libraries-section' }, h('h3', {}, tr('Подключить к этому файлу')));
    const linked = this.linked();
    const available = (this.list ?? []).filter((l) => l.fileId !== fileId);
    if (this.list === null) others.append(skeletonRows(tr('Загрузка…'), 3, true));
    else if (available.length === 0) others.append(h('p', { class: 'libraries-empty' }, tr('Других библиотек пока нет. Чтобы файл стал библиотекой, выберите в нём «Опубликовать компоненты».')));
    for (const lib of available) {
      const on = linked.some((l) => l.fileId === lib.fileId);
      const toggle = h('button', { class: `text-button${on ? '' : ' primary'}`, type: 'button', disabled: d.readOnly }, on ? tr('Отключить') : tr('Подключить'));
      toggle.addEventListener('click', () =>
        on
          ? this.setLinked(linked.filter((l) => l.fileId !== lib.fileId), tr('Отключить библиотеку'))
          : this.setLinked([...linked, { fileId: lib.fileId, name: lib.name }], tr('Подключить библиотеку')),
      );
      const meta = [tr('компонентов: {0}', lib.components), lib.ownerName ? tr('владелец: {0}', lib.ownerName) : tr('ваш файл'), tr('опубликована {0}', date(lib.publishedAt))].join(' · ');
      const link = linked.find((l) => l.fileId === lib.fileId);
      others.append(h('div', { class: 'library-row' }, icon('component', 16), h('div', { class: 'library-text' }, h('span', { class: 'library-name' }, lib.name), h('span', { class: 'library-meta' }, meta)), ...(link ? [this.swapButton(link)] : []), toggle));
    }
    // Switched on, but no longer available (unpublished, access closed).
    for (const link of linked.filter((l) => this.list && !available.some((a) => a.fileId === l.fileId))) {
      const off = h('button', { class: 'text-button', type: 'button', disabled: d.readOnly }, tr('Отключить'));
      off.addEventListener('click', () => this.setLinked(linked.filter((l) => l.fileId !== link.fileId), tr('Отключить библиотеку')));
      others.append(h('div', { class: 'library-row muted' }, icon('component', 16), h('div', { class: 'library-text' }, h('span', { class: 'library-name' }, link.name), h('span', { class: 'library-meta' }, tr('недоступна: снята с публикации или у вас нет доступа'))), this.swapButton(link), off));
    }
    if (linked.length) others.append(h('p', { class: 'libraries-note' }, tr('Компоненты, которые уже стоят в файле, после отключения остаются на месте.')));
    this.body.append(others);
    if (this.swap) this.body.prepend(this.swapSection(available));
  }

  /** A button «Заменить…» for a linked library. */
  private swapButton(link: LibraryLink): HTMLElement {
    const d = this.host.editor.doc;
    const b = h('button', { class: 'text-button', type: 'button', disabled: d.readOnly || this.busy }, tr('Заменить…'));
    b.addEventListener('click', () => {
      this.swap = { from: link, to: '' };
      this.render();
    });
    return b;
  }

  /** Swapping a linked library for another: choose, compare, swap (one undo step). */
  private swapSection(available: LibraryInfo[]): HTMLElement {
    const sw = this.swap!;
    const editor = this.host.editor;
    const section = h('section', { class: 'libraries-section library-swap' }, h('h3', {}, tr('Заменить библиотеку «{0}» на', sw.from.name)));
    const choices = available.filter((l) => l.fileId !== sw.from.fileId);
    if (choices.length === 0) {
      section.append(h('p', { class: 'libraries-empty' }, tr('Других библиотек для замены нет.')));
    } else {
      const select = h('select', { class: 'library-swap-select', 'aria-label': tr('Выберите библиотеку') }, h('option', { value: '' }, tr('Выберите библиотеку')), ...choices.map((l) => h('option', { value: l.fileId, selected: l.fileId === sw.to }, l.name)));
      select.addEventListener('change', () => {
        this.swap = { from: sw.from, to: (select as HTMLSelectElement).value };
        void this.compare();
      });
      section.append(select);
    }
    if (sw.loading) section.append(h('p', { class: 'libraries-note' }, tr('Сравниваю…')));
    const plan = sw.plan;
    if (plan) {
      section.append(
        h('p', { class: 'libraries-status' }, tr('Копий перейдёт на новую библиотеку: {0}', plan.instances)),
        h('p', { class: 'libraries-note' }, tr('Совпало по именам: компонентов {0}, стилей {1}, переменных {2}', plan.found.components, plan.found.styles, plan.found.variables)),
      );
      if (plan.missing.length) section.append(h('p', { class: 'libraries-note' }, tr('Без пары, останутся из «{0}»: {1}', sw.from.name, plan.missing.slice(0, 12).join(', ') + (plan.missing.length > 12 ? '…' : ''))));
      section.append(h('p', { class: 'libraries-note' }, tr('Свои тексты и цвета в копиях сохранятся, если слои в новой библиотеке называются так же.')));
    }
    const go = h('button', { class: 'text-button primary', type: 'button', disabled: !plan || !sw.payload || editor.doc.readOnly }, tr('Заменить'));
    go.addEventListener('click', () => {
      if (!plan || !sw.payload) return;
      swapLibrary(editor, plan, sw.payload);
      editor.toast(tr('Библиотека заменена на «{0}». Отменить — ⌘Z', sw.payload.name ?? ''));
      this.swap = null;
      this.host.changed();
      this.render();
    });
    const cancel = h('button', { class: 'text-button', type: 'button' }, tr('Отмена'));
    cancel.addEventListener('click', () => {
      this.swap = null;
      this.render();
    });
    section.append(h('div', { class: 'libraries-actions' }, go, cancel));
    return section;
  }

  /** Loads the chosen library and works out what the swap would do. */
  private async compare(): Promise<void> {
    const sw = this.swap;
    if (!sw?.to) return this.render();
    sw.loading = true;
    this.render();
    try {
      // The file's name now (as linking takes it), not the one it had when published.
      const info = this.list?.find((l) => l.fileId === sw.to);
      const fetched = await libraries.get(sw.to);
      const payload = { ...fetched, fileId: sw.to, name: info?.name ?? fetched.name };
      if (this.swap !== sw) return;
      sw.payload = payload;
      sw.plan = planLibrarySwap(this.host.editor.doc, sw.from.fileId, payload);
    } catch (error) {
      this.host.editor.toast(error instanceof CloudError ? error.message : tr('Не удалось загрузить библиотеки'), 'error');
    } finally {
      sw.loading = false;
      if (this.swap === sw) this.render();
    }
  }
}
