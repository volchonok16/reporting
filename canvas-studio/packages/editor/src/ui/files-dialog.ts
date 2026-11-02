// File list (stage "Convenience"): every file kept in this browser, most
// recent first, with search, open, rename, duplicate and delete. The app owns
// the actual switching (FilesHost); this only shows and asks.

import { locale, tr } from '#core';
import type { FileMeta } from '../storage.ts';
import { switchLayout } from '../keyboard.ts';
import { clear, h, icon } from './dom.ts';

/** How a kind of file is shown: its mark's class, icon and name (home screen, file list). */
export function kindLook(kind: 'board' | 'diagram' | 'slides' | undefined | null): { cls: 'design' | 'board' | 'diagram' | 'slides'; icon: string; name: string } {
  if (kind === 'slides') return { cls: 'slides', icon: 'slides', name: tr('Презентация') };
  return kind === 'board' ? { cls: 'board', icon: 'board', name: tr('Доска') } : kind === 'diagram' ? { cls: 'diagram', icon: 'diagram', name: tr('Схема') } : { cls: 'design', icon: 'frame', name: tr('Макет') };
}

export interface FilesHost {
  /** What «create» makes here: a new board from a board (FEAT-083). */
  createsBoard?: boolean;
  createsDiagram?: boolean;
  currentId(): string;
  list(): Promise<FileMeta[]>;
  open(id: string): Promise<void>;
  create(): Promise<void>;
  importFromDisk(): void;
  rename(id: string, name: string): Promise<void>;
  duplicate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Files live on the server (the note and the upload offer change). */
  cloud?: boolean;
  /** Files kept in this browser that could be moved to the server. */
  localCount?(): Promise<number>;
  uploadLocal?(): Promise<void>;
}

const MINUTE = 60_000;

/** "только что", "5 мин назад", "вчера в 14:05", "3 окт." */
export function ago(t: number, now = Date.now()): string {
  const d = now - t;
  if (d < MINUTE) return tr('только что');
  if (d < 60 * MINUTE) return tr('{0} мин назад', Math.floor(d / MINUTE));
  const date = new Date(t);
  const today = new Date(now);
  const time = date.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return tr('сегодня в {0}', time);
  const y = new Date(now - 86_400_000);
  if (date.toDateString() === y.toDateString()) return tr('вчера в {0}', time);
  return date.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export class FilesDialog {
  private readonly host: FilesHost;
  private readonly overlay: HTMLElement;
  private readonly list: HTMLElement;
  private readonly search: HTMLInputElement;
  private files: FileMeta[] = [];
  /** Offer to move files from this browser to the server. */
  private readonly upload: HTMLElement;
  private confirmDelete: string | null = null;

  constructor(host: FilesHost) {
    this.host = host;
    this.search = h('input', { class: 'vars-search', type: 'search', placeholder: tr('Найти файл'), spellcheck: false, 'aria-label': tr('Найти файл') });
    this.search.addEventListener('input', () => this.render());
    this.list = h('div', { class: 'files-list', role: 'list' });
    this.upload = h('div', { class: 'files-upload', hidden: true });
    const create = h('button', { class: 'text-button primary', type: 'button', onclick: () => void this.run(() => host.create()) }, icon('plus', 14), h('span', {}, host.createsBoard ? tr('Новая доска') : host.createsDiagram ? tr('Новая схема') : tr('Новый файл')));
    const fromDisk = h('button', { class: 'text-button', type: 'button', onclick: () => { this.close(); host.importFromDisk(); } }, h('span', {}, tr('Открыть с диска…')));
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'files-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Файлы') },
      h('header', { class: 'vars-header' }, h('h2', {}, tr('Файлы')), h('div', { class: 'vars-search-wrap' }, icon('search', 14), this.search), fromDisk, create, close),
      this.list,
      this.upload,
      h('p', { class: 'hint small files-note' }, host.cloud ? tr('Файлы хранятся на сервере и открываются с любого устройства после входа.') : tr('Файлы хранятся в этом браузере. Чтобы перенести файл на другой компьютер, сохраните его на диск (Mod+S) и откройте там.').replace('Mod', /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl')),
    );
    this.overlay = h('div', { class: 'vars-overlay', hidden: true }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.overlay);
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  async open(): Promise<void> {
    this.overlay.hidden = false;
    this.confirmDelete = null;
    this.search.value = '';
    this.list.replaceChildren(h('p', { class: 'hint', role: 'status' }, h('span', { class: 'spinner' }), tr(' Загружаю файлы…')));
    await this.reload();
    this.search.focus();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private async reload(): Promise<void> {
    try {
      this.files = await this.host.list();
    } catch {
      this.files = [];
    }
    this.render();
    const count = (await this.host.localCount?.().catch(() => 0)) ?? 0;
    this.upload.hidden = count === 0 || !this.host.uploadLocal;
    if (count > 0 && this.host.uploadLocal) {
      const go = h('button', { class: 'text-button', type: 'button' }, tr('Перенести на сервер'));
      go.addEventListener('click', async () => {
        go.setAttribute('disabled', '');
        go.textContent = tr('Переносим…');
        await this.host.uploadLocal!();
        await this.reload();
      });
      this.upload.replaceChildren(h('span', {}, tr('В этом браузере есть файлы, сохранённые без входа: {0}.', count)), go);
    }
  }

  private async run(fn: () => Promise<void>, keepOpen = false): Promise<void> {
    await fn();
    if (keepOpen) await this.reload();
    else this.close();
  }

  private render(): void {
    clear(this.list);
    const q = this.search.value.trim().toLowerCase();
    const alt = switchLayout(q);
    const shown = this.files.filter((f) => !q || f.name.toLowerCase().includes(q) || f.name.toLowerCase().includes(alt));
    if (shown.length === 0) {
      this.list.append(h('p', { class: 'hint' }, q ? tr('Ничего не найдено.') : tr('Файлов пока нет.')));
      return;
    }
    const current = this.host.currentId();
    for (const f of shown) {
      const name = h('span', { class: 'files-name' }, f.name || tr('Без названия'));
      const rename = h('button', { class: 'icon-button', type: 'button', title: tr('Переименовать') }, icon('text', 14));
      const duplicate = h('button', { class: 'icon-button', type: 'button', title: tr('Дублировать') }, icon('page', 14));
      const asking = this.confirmDelete === f.id;
      const remove = h('button', { class: `text-button${asking ? ' danger' : ''} files-delete`, type: 'button', title: tr('Удалить файл из браузера') }, asking ? tr('Точно удалить?') : icon('minus', 14));
      const row = h(
        'div',
        { class: `files-row${f.id === current ? ' current' : ''}`, role: 'listitem', tabindex: 0, title: tr('Создан: {0}', ago(f.createdAt)) },
        // A board and a design look different in the list (FEAT-083): icon and the word in the line under the name.
        h('span', { class: 'files-kind', title: kindLook(f.kind).name }, icon(kindLook(f.kind).icon, 16)),
        h('div', { class: 'files-text' }, name, h('span', { class: 'files-meta' }, tr('{0} · {1}изменён {2}', kindLook(f.kind).name, f.id === current ? tr('Открыт сейчас · ') : '', ago(f.savedAt)))),
        rename,
        duplicate,
        remove,
      );
      const open = () => {
        if (f.id === current) this.close();
        else void this.run(() => this.host.open(f.id));
      };
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        open();
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === row) open();
      });
      const startRename = () => {
        const input = h('input', { class: 'vars-input', type: 'text', value: f.name, spellcheck: false });
        name.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (save: boolean) => {
          if (done) return;
          done = true;
          const v = input.value.trim();
          if (save && v && v !== f.name) void this.run(() => this.host.rename(f.id, v), true);
          else this.render();
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
      };
      rename.addEventListener('click', startRename);
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startRename();
      });
      duplicate.addEventListener('click', () => void this.run(() => this.host.duplicate(f.id), true));
      remove.addEventListener('click', () => {
        if (this.confirmDelete !== f.id) {
          this.confirmDelete = f.id;
          this.render();
          return;
        }
        this.confirmDelete = null;
        void this.run(() => this.host.remove(f.id), true);
      });
      this.list.append(row);
    }
  }
}
