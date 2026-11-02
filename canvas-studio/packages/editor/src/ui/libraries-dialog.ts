// "Libraries" window (FR-LIB): publish the components of this file for other
// files, and switch on the libraries this person can use. Opened from the
// "Components" tab. Switching a library on is an ordinary change of the file
// (everyone in it sees the same list; undo works); what was already used from
// a library stays in the file when it is switched off.

import { locale, tr, type LibraryLink } from '#core';
import { renderThumbnail, type Canvas2DRenderer } from '#render';
import { CloudError, libraries, type LibraryInfo } from '../cloud.ts';
import type { Editor } from '../editor.ts';
import { buildLibrary } from '../library.ts';
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
    else own.append(h('p', { class: 'libraries-status' }, count > 0 ? tr('Компонентов в файле: {0}. Опубликуйте их — и их можно будет ставить в других файлах.', count) : tr('В файле нет компонентов — публиковать нечего.')));
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
    else if (available.length === 0) others.append(h('p', { class: 'libraries-empty' }, tr('Других библиотек пока нет. Библиотекой становится любой ваш файл (или файл, к которому вам дали доступ) после «Опубликовать компоненты».')));
    for (const lib of available) {
      const on = linked.some((l) => l.fileId === lib.fileId);
      const toggle = h('button', { class: `text-button${on ? '' : ' primary'}`, type: 'button', disabled: d.readOnly }, on ? tr('Отключить') : tr('Подключить'));
      toggle.addEventListener('click', () =>
        on
          ? this.setLinked(linked.filter((l) => l.fileId !== lib.fileId), tr('Отключить библиотеку'))
          : this.setLinked([...linked, { fileId: lib.fileId, name: lib.name }], tr('Подключить библиотеку')),
      );
      const meta = [tr('компонентов: {0}', lib.components), lib.ownerName ? tr('владелец: {0}', lib.ownerName) : tr('ваш файл'), tr('опубликована {0}', date(lib.publishedAt))].join(' · ');
      others.append(h('div', { class: 'library-row' }, icon('component', 16), h('div', { class: 'library-text' }, h('span', { class: 'library-name' }, lib.name), h('span', { class: 'library-meta' }, meta)), toggle));
    }
    // Switched on, but no longer available (unpublished, access closed).
    for (const link of linked.filter((l) => this.list && !available.some((a) => a.fileId === l.fileId))) {
      const off = h('button', { class: 'text-button', type: 'button', disabled: d.readOnly }, tr('Отключить'));
      off.addEventListener('click', () => this.setLinked(linked.filter((l) => l.fileId !== link.fileId), tr('Отключить библиотеку')));
      others.append(h('div', { class: 'library-row muted' }, icon('component', 16), h('div', { class: 'library-text' }, h('span', { class: 'library-name' }, link.name), h('span', { class: 'library-meta' }, tr('недоступна: снята с публикации или у вас нет доступа'))), off));
    }
    if (linked.length) others.append(h('p', { class: 'libraries-note' }, tr('Компоненты, которые уже стоят в файле, после отключения остаются на месте.')));
    this.body.append(others);
  }
}
