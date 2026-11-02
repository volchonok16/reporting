// Branches (FR-BR-001, 002, 004, 005): a branch is a copy of a file that goes
// its own way and is merged back. Three windows here:
//   — the branch bar: in a branch, whose branch it is, how much the main file
//     has changed since, "Get changes" and "Merge into the main file";
//   — "Branches": the branches of a file, a new one, undoing a merge;
//   — the merge: what comes in, the conflicts decided property by property,
//     the page before and after; nothing changes until "Merge".
// A merge is a three-way merge of snapshots (core/merge.ts) put into the open
// document as ordinary edits: everyone in the file sees it, Mod+Z takes it back.

import { colorToHex, compareTopLevel, countChanges, fromSnapshot, locale, mergeSnapshots, restoreVersion, toSnapshot, tr, type MergeChoice, type MergeConflict, type NodeId, type Paint, type Snapshot } from '#core';
import type { Canvas2DRenderer } from '#render';
import { branches as api, comments as commentsApi, versions, CloudError, type BranchInfo, type BranchReview } from '../cloud.ts';
import type { Editor } from '../editor.ts';
import { IS_MAC } from '../keyboard.ts';
import type { Role, StoredFile } from '../storage.ts';
import { askConfirm, askText, showMessage } from './dialog.ts';
import { h, icon, skeletonRows } from './dom.ts';
import { drawPage } from './versions-view.ts';

export type BranchMetaOf = NonNullable<StoredFile['branch']>;

export interface BranchHost {
  editor: Editor;
  renderer: Canvas2DRenderer;
  fileId: string;
  fileName: string;
  role: Role;
  /** Set in a branch. */
  branch: BranchMetaOf | null;
  /** Who is working (the signed-in person), for the review buttons. */
  userId: string | null;
  toast(text: string, kind?: 'error' | 'info'): void;
  /** Everything edited here has reached the server (the live room and the autosave): before versions and merges. */
  settle(): Promise<void>;
}

const UNDO = () => (IS_MAC ? '⌘Z' : 'Ctrl+Z');
const canEdit = (role: Role) => role === 'owner' || role === 'editor';

function when(at: number): string {
  return new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function message(error: unknown): string {
  return error instanceof CloudError || error instanceof Error ? error.message : String(error);
}

/** What a merge result's error means and how to get past it (FR-BR-006). */
function integrityText(error: string): string {
  if (error.startsWith('cycle:')) {
    return tr('Слияние сейчас невозможно: слой «{0}» оказался бы внутри самого себя — в основном файле и в ветке слои вложены друг в друга по-разному. Как исправить: в ветке перенесите этот слой туда, где он лежит в основном файле, и повторите слияние.', error.slice(6) || '…');
  }
  return tr('Слияние сейчас невозможно: файл повреждён ({0}). Сохраните копию файла и напишите нам.', error);
}

// ---------- how a conflict is shown ----------

const PROP_LABELS: Record<string, string> = {
  name: 'Название', x: 'X', y: 'Y', width: 'Ширина', height: 'Высота', rotation: 'Поворот', opacity: 'Непрозрачность', visible: 'Видимость',
  fills: 'Заливка', strokes: 'Обводка', strokeWeight: 'Толщина обводки', cornerRadius: 'Скругление', effects: 'Эффекты',
  characters: 'Текст', textRuns: 'Стили части текста', fontSize: 'Размер шрифта', fontFamily: 'Шрифт', fontWeight: 'Начертание',
  layoutMode: 'Адаптивная раскладка', itemSpacing: 'Промежуток', paddingLeft: 'Отступ слева', paddingRight: 'Отступ справа', paddingTop: 'Отступ сверху', paddingBottom: 'Отступ снизу',
  backgroundColor: 'Фон страницы', reactions: 'Связи прототипа', locked: 'Закреплён',
};

function propLabel(c: MergeConflict): string {
  if (c.kind === 'exists') return tr('Слой');
  if (c.kind === 'place') return tr('Место в слоях');
  const label = PROP_LABELS[c.prop ?? ''];
  return label ? tr(label) : String(c.prop);
}

function swatches(paints: Paint[]): HTMLElement {
  const solid = paints.filter((p) => p.type === 'SOLID' && p.visible !== false) as Extract<Paint, { type: 'SOLID' }>[];
  if (!paints.length) return h('span', {}, tr('нет'));
  if (!solid.length) return h('span', {}, tr('градиент или картинка'));
  return h('span', { class: 'merge-swatches' }, ...solid.slice(0, 3).map((p) => h('i', { style: { background: `#${colorToHex(p.color)}` }, title: `#${colorToHex(p.color)}` })), h('span', {}, `#${colorToHex(solid[0]!.color)}`));
}

function valueView(c: MergeConflict, value: unknown): HTMLElement {
  if (c.kind === 'exists') return h('span', {}, value ? tr('остаётся') : tr('удалён'));
  if (c.kind === 'place') return h('span', {}, tr('в «{0}»', String(value || '…')));
  if ((c.prop === 'fills' || c.prop === 'strokes') && Array.isArray(value)) return swatches(value as Paint[]);
  if (typeof value === 'number') return h('span', {}, String(Math.round(value * 100) / 100));
  if (typeof value === 'boolean') return h('span', {}, value ? tr('да') : tr('нет'));
  if (typeof value === 'string') return h('span', { class: 'merge-text', title: value }, value.length > 80 ? `«${value.slice(0, 80)}…»` : `«${value}»`);
  return h('span', { title: JSON.stringify(value)?.slice(0, 400) ?? '' }, tr('другое значение'));
}

// ---------- the merge window ----------

export interface MergeOptions {
  title: string;
  /** The common ancestor and the incoming side; "ours" is the open document. */
  base: Snapshot;
  theirs: Snapshot;
  labels: { ours: string; theirs: string };
  applyLabel: string;
  /** Edit name in the history (Mod+Z shows it). */
  historyLabel: string;
  /** Before the edits go in (a version "before"). */
  before?: () => Promise<void>;
  /** After they went in (a version "after", the branch marked). */
  after?: () => Promise<void>;
  /** Nothing to bring and nothing to decide: said instead of opening. */
  nothingText: string;
  /** Shown under the summary (the merge: "carry the branch's comments over"). */
  extra?: HTMLElement;
}

export class MergeView {
  private readonly host: BranchHost;
  private readonly options: MergeOptions;
  private readonly overlay: HTMLElement;
  private readonly side: HTMLElement;
  private readonly main: HTMLElement;
  private readonly apply: HTMLButtonElement;
  private readonly choices = new Map<string, MergeChoice>();
  private conflicts: MergeConflict[] = [];
  private page: NodeId;
  private redraw: (() => void) | null = null;
  private readonly previousOnLoad: (hash: string) => void;

  /** Opens the window, or says there is nothing to merge. */
  static open(host: BranchHost, options: MergeOptions): MergeView | null {
    const first = mergeSnapshots(options.base, toSnapshot(host.editor.doc), options.theirs);
    if (!first.error && first.conflicts.length === 0 && first.incoming.length === 0) {
      host.toast(options.nothingText);
      return null;
    }
    return new MergeView(host, options);
  }

  private constructor(host: BranchHost, options: MergeOptions) {
    this.host = host;
    this.options = options;
    this.page = host.editor.pageId;
    this.side = h('div', { class: 'versions-list merge-side' });
    this.main = h('div', { class: 'versions-main' });
    const cancel = h('button', { class: 'text-button', type: 'button', onclick: () => this.close() }, tr('Отмена'));
    this.apply = h('button', { class: 'text-button primary', type: 'button', onclick: () => void this.run() }, options.applyLabel);
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    this.overlay = h(
      'div',
      { class: 'versions-view merge-view', role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
      h('header', { class: 'versions-header' }, h('h2', {}, options.title), h('span', { class: 'crop-spacer' }), cancel, this.apply, close),
      h('div', { class: 'versions-body' }, this.side, this.main),
    );
    this.overlay.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.overlay);
    this.previousOnLoad = host.renderer.images.onLoad;
    host.renderer.images.onLoad = (hash) => {
      this.previousOnLoad(hash);
      this.redraw?.();
    };
    this.render();
  }

  private result() {
    return mergeSnapshots(this.options.base, toSnapshot(this.host.editor.doc), this.options.theirs, this.choices);
  }

  private render(): void {
    const r = this.result();
    this.conflicts = r.conflicts;
    const undecided = r.conflicts.filter((c) => !this.choices.has(c.key)).length;
    this.apply.disabled = !!r.error || undecided > 0;
    this.apply.title = r.error ? '' : undecided ? tr('Решите конфликты: осталось {0}', undecided) : '';
    const { ours, theirs } = this.options.labels;
    const summary = h(
      'div',
      { class: 'merge-summary' },
      h('p', {}, tr('Придёт изменений: {0}.', r.incoming.length)),
      r.conflicts.length ? h('p', {}, tr('Конфликтов: {0} — одно и то же свойство изменено и в «{1}», и в «{2}». Выберите, что оставить.', r.conflicts.length, ours, theirs)) : h('p', {}, tr('Конфликтов нет: всё соединится само.')),
      r.error ? h('p', { class: 'merge-error', role: 'alert' }, integrityText(r.error)) : null,
    );
    const list = r.conflicts.map((c) => this.conflictRow(c));
    this.side.replaceChildren(summary, ...(this.options.extra ? [this.options.extra] : []), ...(r.conflicts.length ? [h('div', { class: 'merge-bulk' }, h('button', { class: 'link-button', type: 'button', onclick: () => this.decideAll('ours') }, tr('Везде «{0}»', ours)), h('button', { class: 'link-button', type: 'button', onclick: () => this.decideAll('theirs') }, tr('Везде «{0}»', theirs)))] : []), ...list);
    this.preview(r.snapshot);
  }

  private decideAll(side: 'ours' | 'theirs'): void {
    for (const c of this.conflicts) this.choices.set(c.key, side);
    this.render();
  }

  private conflictRow(c: MergeConflict): HTMLElement {
    const { ours, theirs } = this.options.labels;
    const choice = this.choices.get(c.key);
    const option = (side: 'ours' | 'theirs', label: string, value: unknown) =>
      h(
        'label',
        { class: `merge-option${choice === side ? ' chosen' : ''}` },
        h('input', { type: 'radio', name: c.key, checked: choice === side, onchange: () => this.decide(c.key, side) }),
        h('span', { class: 'merge-side-name' }, label),
        valueView(c, value),
      );
    const rows: HTMLElement[] = [option('ours', ours, c.ours), option('theirs', theirs, c.theirs)];
    if (c.prop === 'characters') {
      const custom = typeof choice === 'object' ? choice.text : null;
      const area = h('textarea', { class: 'merge-custom', rows: 2, hidden: custom === null, 'aria-label': tr('Свой текст') }, custom ?? String(c.ours ?? ''));
      area.addEventListener('change', () => this.decide(c.key, { text: area.value }));
      rows.push(
        h('label', { class: `merge-option${custom !== null ? ' chosen' : ''}` }, h('input', { type: 'radio', name: c.key, checked: custom !== null, onchange: () => this.decide(c.key, { text: area.value }) }), h('span', { class: 'merge-side-name' }, tr('Свой текст'))),
        area,
      );
    }
    return h(
      'div',
      { class: `merge-conflict${choice === undefined ? ' open' : ''}` },
      h('div', { class: 'merge-where' }, h('strong', {}, c.name || tr('Без названия')), ' · ', propLabel(c)),
      c.path.length ? h('div', { class: 'merge-path' }, c.path.filter(Boolean).join(' / ')) : null,
      ...rows,
    );
  }

  private decide(key: string, choice: MergeChoice): void {
    this.choices.set(key, choice);
    this.render();
  }

  private preview(snapshot: Snapshot | null): void {
    const current = this.host.editor.doc;
    if (!snapshot) {
      this.main.replaceChildren();
      this.redraw = null;
      return;
    }
    const merged = fromSnapshot(snapshot);
    const pages = merged.pages();
    if (!pages.includes(this.page)) this.page = pages[0] ?? this.page;
    const pageSelect = h('select', { class: 'field-select', 'aria-label': tr('Страница') }, ...pages.map((p) => h('option', { value: p, selected: p === this.page }, String(merged.get(p, 'name') ?? ''))));
    pageSelect.addEventListener('change', () => {
      this.page = pageSelect.value;
      this.preview(snapshot);
    });
    const diff = compareTopLevel(current, merged, this.page);
    const n = diff.added.length + diff.removed.length + diff.changed.length;
    const left = h('canvas', { class: 'versions-canvas' });
    const right = h('canvas', { class: 'versions-canvas' });
    this.main.replaceChildren(
      h('div', { class: 'versions-tools' }, h('div', { class: 'select-wrap' }, pageSelect), h('span', { class: 'versions-summary' }, n ? tr('На этой странице изменится фреймов: {0}', n) : tr('Эта страница не изменится'))),
      h('div', { class: 'versions-panes' }, h('figure', {}, h('figcaption', {}, tr('Сейчас')), left), h('figure', {}, h('figcaption', {}, tr('После')), right)),
    );
    this.redraw = () => {
      if (!left.isConnected) return;
      drawPage(left, current, this.page, this.host.renderer, [...diff.changed.map((id) => ({ id, color: '#f59e0b' })), ...diff.removed.map((id) => ({ id, color: '#ef4444' }))]);
      drawPage(right, merged, this.page, this.host.renderer, [...diff.changed.map((id) => ({ id, color: '#f59e0b' })), ...diff.added.map((id) => ({ id, color: '#22c55e' }))]);
    };
    requestAnimationFrame(() => this.redraw?.());
  }

  private async run(): Promise<void> {
    this.apply.disabled = true;
    const editor = this.host.editor;
    try {
      await this.options.before?.();
      // Merged with the document as it is at this moment (others may have edited meanwhile).
      const r = this.result();
      if (r.error || !r.snapshot) throw new Error(integrityText(r.error ?? ''));
      if (r.conflicts.some((c) => !this.choices.has(c.key))) {
        // A new conflict appeared while deciding (someone edited the same thing): show it.
        this.render();
        this.host.toast(tr('Пока вы решали, файл изменился — появился новый конфликт. Решите его и нажмите ещё раз.'), 'error');
        return;
      }
      const merged = fromSnapshot(r.snapshot);
      editor.commit(this.options.historyLabel, (tx) => restoreVersion(tx, editor.doc, merged, null, editor.pageId));
      if (!editor.doc.store.isAlive(editor.pageId)) editor.setPage(editor.doc.pages()[0]!);
      await this.options.after?.();
      this.close();
    } catch (error) {
      this.apply.disabled = false;
      await showMessage({ title: this.options.title, message: message(error) });
    }
  }

  close(): void {
    this.host.renderer.images.onLoad = this.previousOnLoad;
    this.redraw = null;
    this.overlay.remove();
  }
}

// ---------- flows ----------

const parse = (text: string) => JSON.parse(text) as Snapshot;
/** The common ancestor is only compared, never shown: kept without pictures (and small enough to send). */
const ancestor = (s: Snapshot): string => JSON.stringify({ ...s, blobs: undefined });

/** In the main file: merge a branch into it (opened from the branch with ?merge=<id>). */
export async function mergeBranch(host: BranchHost, branchId: string): Promise<void> {
  if (!canEdit(host.role) || host.editor.doc.readOnly) return host.toast(tr('Сливать ветки в файл могут те, кто может его редактировать.'), 'error');
  let info: Awaited<ReturnType<typeof api.info>>;
  let theirs: Snapshot;
  try {
    info = await api.info(branchId);
    if (info.main.id !== host.fileId) return host.toast(tr('Эта ветка создана от другого файла.'), 'error');
    theirs = parse(await api.fresh(branchId));
  } catch (error) {
    return host.toast(message(error), 'error');
  }
  const name = (await api.list(host.fileId).catch(() => [] as BranchInfo[])).find((b) => b.id === branchId)?.name ?? '';
  // The branch's discussions (review remarks and others) can come along (FR-BR-002).
  const threads = (await commentsApi.list(branchId).catch(() => [])).length;
  const carry = h('input', { type: 'checkbox', checked: true });
  const extra = threads ? h('label', { class: 'merge-carry' }, carry, h('span', {}, tr('Перенести комментарии ветки в основной файл ({0})', threads))) : undefined;
  let before = '';
  MergeView.open(host, {
    title: tr('Слить ветку «{0}» в «{1}»', name, host.fileName),
    base: parse(info.base),
    theirs,
    labels: { ours: tr('Основной'), theirs: tr('Ветка') },
    applyLabel: tr('Слить'),
    historyLabel: tr('Слияние ветки «{0}»', name),
    nothingText: tr('В ветке «{0}» нет изменений по сравнению с основным файлом.', name),
    extra,
    before: async () => {
      await host.settle();
      before = (await versions.save(host.fileId, tr('До слияния ветки «{0}»', name))).version?.id ?? '';
    },
    after: async () => {
      await host.settle();
      const after = (await versions.save(host.fileId, tr('После слияния ветки «{0}»', name))).version?.id ?? '';
      if (before && after) await api.merged(host.fileId, branchId, before, after);
      if (extra && carry.checked) await api.carryComments(host.fileId, branchId).catch((error: unknown) => host.toast(message(error), 'error'));
      host.toast(tr('Ветка «{0}» слита. Отменить — {1} сейчас или «Файл → Ветки…» в течение 30 дней.', name, UNDO()), 'info');
    },
  });
}

/** In a branch: bring the main file's changes in; that state becomes the new common ancestor. */
export async function updateBranch(host: BranchHost, onDone: () => void): Promise<void> {
  const branch = host.branch;
  if (!branch) return host.toast(tr('Это не ветка: получать изменения можно в ветке.'));
  if (!canEdit(host.role) || host.editor.doc.readOnly) return host.toast(tr('Только просмотр: получить изменения может тот, кто редактирует ветку.'), 'error');
  let base: Snapshot;
  let text: string;
  try {
    base = parse((await api.info(host.fileId)).base);
    text = await api.fresh(branch.of);
  } catch (error) {
    return host.toast(message(error), 'error');
  }
  const theirs = parse(text);
  const view = MergeView.open(host, {
    title: tr('Изменения из «{0}»', branch.mainName),
    base,
    theirs,
    labels: { ours: tr('Ветка'), theirs: tr('Основной') },
    applyLabel: tr('Получить изменения'),
    historyLabel: tr('Изменения из основного файла'),
    nothingText: tr('Основной файл не менялся с тех пор, как ветка взяла из него изменения.'),
    after: async () => {
      await api.setBase(host.fileId, ancestor(theirs));
      host.toast(tr('Изменения из основного файла получены. Отменить — {0}.', UNDO()), 'info');
      onDone();
    },
  });
  // Nothing new and nothing to decide — the branch is up to date: remember that.
  if (!view && countChanges(base, theirs) > 0) {
    await api.setBase(host.fileId, ancestor(theirs)).catch(() => undefined);
    onDone();
  }
}

/** In the main file: take a merge back (within 30 days) — only what the branch brought. */
export async function undoMerge(host: BranchHost, branch: BranchInfo, onDone: () => void): Promise<void> {
  if (!branch.merged) return;
  let after: Snapshot;
  let before: Snapshot;
  try {
    [after, before] = await Promise.all([versions.snapshot(host.fileId, branch.merged.after).then(parse), versions.snapshot(host.fileId, branch.merged.before).then(parse)]);
  } catch (error) {
    return host.toast(message(error), 'error');
  }
  MergeView.open(host, {
    title: tr('Отменить слияние ветки «{0}»', branch.name),
    base: after,
    theirs: before,
    labels: { ours: tr('Сейчас'), theirs: tr('До слияния') },
    applyLabel: tr('Отменить слияние'),
    historyLabel: tr('Отмена слияния ветки «{0}»', branch.name),
    nothingText: tr('Слияние уже отменено: того, что принесла ветка, в файле нет.'),
    after: async () => {
      await host.settle();
      await versions.save(host.fileId, tr('Отменено слияние ветки «{0}»', branch.name)).catch(() => undefined);
      await api.unmerged(host.fileId, branch.id);
      host.toast(tr('Слияние отменено, ветка «{0}» снова открыта.', branch.name), 'info');
      onDone();
    },
  });
}

// ---------- "Branches" ----------

export class BranchesDialog {
  private readonly host: BranchHost;
  private readonly overlay: HTMLElement;
  private readonly list: HTMLElement;
  private readonly mainId: string;

  constructor(host: BranchHost, focusNew = false) {
    this.host = host;
    this.mainId = host.branch?.of ?? host.fileId;
    this.list = h('div', { class: 'branches-list' });
    const mainName = host.branch?.mainName ?? host.fileName;
    const editable = canEdit(host.role);
    const name = h('input', { class: 'dialog-input', type: 'text', maxLength: 120, placeholder: tr('Например, «Новая шапка»'), 'aria-label': tr('Название ветки') });
    const description = h('textarea', { class: 'dialog-input branches-desc', rows: 2, maxLength: 1000, placeholder: tr('Что будете пробовать (необязательно)'), 'aria-label': tr('Описание') });
    const create = h('button', { class: 'text-button primary', type: 'submit' }, tr('Создать ветку'));
    const error = h('p', { class: 'dialog-error', role: 'alert' });
    const form = editable
      ? h(
          'form',
          { class: 'branches-new' },
          h('h3', {}, tr('Новая ветка')),
          h('p', { class: 'dialog-hint' }, tr('Копия «{0}», в которой можно пробовать, не трогая основной файл. Потом её можно слить обратно — по свойствам, с выбором при конфликтах.', mainName)),
          name,
          description,
          error,
          create,
        )
      : null;
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!name.value.trim()) {
        error.textContent = tr('Введите название ветки');
        name.focus();
        return;
      }
      create.disabled = true;
      void (async () => {
        try {
          if (host.fileId === this.mainId) await host.settle();
          const made = await api.create(this.mainId, name.value.trim(), description.value.trim());
          location.assign(`/?file=${encodeURIComponent(made.id)}`);
        } catch (err) {
          error.textContent = message(err);
          create.disabled = false;
        }
      })();
    });
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog branches-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Ветки') },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Ветки «{0}»', mainName)), close),
      h('div', { class: 'dialog-body' }, ...(form ? [form] : []), this.list),
    );
    this.overlay = h('div', { class: 'dialog-overlay' }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    document.body.append(this.overlay);
    requestAnimationFrame(() => (focusNew && form ? name : close).focus());
    void this.load();
  }

  private async load(): Promise<void> {
    this.list.replaceChildren(skeletonRows(tr('Загружаю ветки…'), 3));
    let items: BranchInfo[];
    try {
      items = await api.list(this.mainId);
    } catch (error) {
      this.list.replaceChildren(h('p', { class: 'hint' }, message(error)));
      return;
    }
    const inMain = this.host.fileId === this.mainId;
    const rows: HTMLElement[] = [];
    if (!inMain) rows.push(h('a', { class: 'branches-row main', href: `/?file=${encodeURIComponent(this.mainId)}` }, h('strong', {}, this.host.branch?.mainName ?? ''), h('span', { class: 'branches-meta' }, tr('основной файл'))));
    for (const b of items) {
      const here = b.id === this.host.fileId;
      const review = b.review && !b.merged ? (b.review.reviewers.some((x) => x.verdict === 'changes') ? tr('нужны правки') : tr('ревью: одобрили {0} из {1}', b.review.reviewers.filter((x) => x.verdict === 'approved').length, b.review.reviewers.length)) : '';
      const status = [b.merged ? tr('слита {0}', when(b.merged.at)) : tr('изменена {0}', when(b.updatedAt)), review].filter(Boolean).join(' · ');
      const undo = b.merged && inMain && canEdit(this.host.role) ? h('button', { class: 'link-button', type: 'button', onclick: () => void this.undo(b) }, tr('Отменить слияние')) : null;
      const remove = canEdit(this.host.role) && !here ? h('button', { class: 'link-button danger', type: 'button', onclick: () => void this.remove(b) }, tr('Удалить')) : null;
      rows.push(
        h(
          'div',
          { class: `branches-row${here ? ' here' : ''}${b.merged ? ' merged' : ''}` },
          h('a', { href: `/?file=${encodeURIComponent(b.id)}` }, h('strong', {}, b.name), here ? h('span', { class: 'branches-meta' }, tr('вы здесь')) : null),
          h('span', { class: 'branches-meta' }, [b.author, status].filter(Boolean).join(' · ')),
          b.description ? h('span', { class: 'branches-desc-text' }, b.description) : null,
          undo || remove ? h('span', { class: 'branches-actions' }, undo, remove) : null,
        ),
      );
    }
    if (!items.length) rows.push(h('p', { class: 'hint' }, tr('Веток пока нет.')));
    this.list.replaceChildren(h('h3', {}, tr('Ветки')), ...rows);
  }

  private async undo(b: BranchInfo): Promise<void> {
    this.close();
    await undoMerge(this.host, b, () => undefined);
  }

  private async remove(b: BranchInfo): Promise<void> {
    const ok = await askConfirm({ title: tr('Удалить ветку?'), message: b.merged ? tr('Ветка «{0}» уже слита; после удаления отменить слияние будет нельзя.', b.name) : tr('Ветка «{0}» и её правки удалятся. В основной файл они не попадут.', b.name), confirm: tr('Удалить'), danger: true });
    if (!ok) return;
    try {
      await api.remove(b.id);
      await this.load();
    } catch (error) {
      this.host.toast(message(error), 'error');
    }
  }

  close(): void {
    this.overlay.remove();
  }
}

// ---------- review (FR-BR-003) ----------

/** "Ask for a review": people of the main file to choose, and what to look at. */
export async function askReview(host: BranchHost, onDone: (review: BranchReview) => void): Promise<void> {
  if (!host.branch) return;
  let people: { id: string; name: string }[];
  try {
    people = (await commentsApi.people(host.fileId)).filter((p) => p.id !== host.userId);
  } catch (error) {
    return host.toast(message(error), 'error');
  }
  if (!people.length) return host.toast(tr('Кроме вас, у основного файла никого нет. Пригласите людей через «Поделиться» в основном файле.'));
  const checks = people.map((p) => ({ p, box: h('input', { type: 'checkbox' }) as HTMLInputElement }));
  const description = h('textarea', { class: 'dialog-input branches-desc', rows: 3, maxLength: 2000, placeholder: tr('Что посмотреть: например, «новая шапка и отступы в карточках»'), 'aria-label': tr('Что посмотреть') });
  const error = h('p', { class: 'dialog-error', role: 'alert' });
  const send = h('button', { class: 'text-button primary', type: 'submit' }, tr('Попросить посмотреть'));
  const cancel = h('button', { class: 'text-button', type: 'button' }, tr('Отмена'));
  const form = h(
    'form',
    { class: 'dialog review-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Запросить ревью') },
    h('header', { class: 'dialog-header' }, h('h2', {}, tr('Запросить ревью'))),
    h(
      'div',
      { class: 'dialog-body' },
      h('p', { class: 'dialog-hint' }, tr('Им придёт письмо со ссылкой на ветку. В ветке они увидят «Изменения», смогут комментировать и ответить «Одобрить» или «Нужны правки».')),
      h('div', { class: 'review-people' }, ...checks.map(({ p, box }) => h('label', { class: 'review-person' }, box, h('span', {}, p.name)))),
      description,
      error,
    ),
    h('footer', { class: 'dialog-footer' }, cancel, send),
  );
  const overlay = h('div', { class: 'dialog-overlay' }, form);
  const close = () => overlay.remove();
  cancel.addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  form.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const ids = checks.filter((c) => c.box.checked).map((c) => c.p.id);
    if (!ids.length) {
      error.textContent = tr('Отметьте, кто посмотрит');
      return;
    }
    send.disabled = true;
    void api
      .requestReview(host.fileId, ids, description.value.trim())
      .then((r) => {
        close();
        host.toast(r.mailFailed ? tr('Ревью запрошено, но часть писем не ушла — напишите рецензентам сами.') : tr('Ревью запрошено: письма отправлены ({0}).', ids.length), r.mailFailed ? 'error' : 'info');
        onDone(r.review);
      })
      .catch((err: unknown) => {
        error.textContent = message(err);
        send.disabled = false;
      });
  });
  document.body.append(overlay);
  requestAnimationFrame(() => checks[0]?.box.focus());
}

/** In a branch: what it changed, next to the main file as it is now (read only — for reviewers and the author). */
export async function showChanges(host: BranchHost): Promise<void> {
  const b = host.branch;
  if (!b) return;
  let base: Snapshot;
  let main: Snapshot;
  try {
    [base, main] = await Promise.all([api.info(host.fileId).then((i) => parse(i.base)), api.fresh(b.of).then(parse)]);
  } catch (error) {
    return host.toast(message(error), 'error');
  }
  const branchDoc = host.editor.doc;
  const mainDoc = fromSnapshot(main);
  const mine = countChanges(base, toSnapshot(branchDoc));
  const theirs = countChanges(base, main);
  const previousOnLoad = host.renderer.images.onLoad;
  let redraw: (() => void) | null = null;
  host.renderer.images.onLoad = (hash) => {
    previousOnLoad(hash);
    redraw?.();
  };
  const closeButton = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть') }, icon('close'));
  const side = h('div', { class: 'versions-list merge-side' });
  const mainPane = h('div', { class: 'versions-main' });
  const overlay = h(
    'div',
    { class: 'versions-view merge-view', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Изменения ветки') },
    h('header', { class: 'versions-header' }, h('h2', {}, tr('Изменения ветки «{0}»', host.fileName)), h('span', { class: 'versions-file' }, tr('от «{0}»', b.mainName)), h('span', { class: 'crop-spacer' }), closeButton),
    h('div', { class: 'versions-body' }, side, mainPane),
  );
  const close = () => {
    host.renderer.images.onLoad = previousOnLoad;
    redraw = null;
    overlay.remove();
  };
  closeButton.addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
  });
  const review = b.review;
  side.replaceChildren(
    h('div', { class: 'merge-summary' }, h('p', {}, tr('В ветке изменено слоёв: {0}.', mine)), h('p', {}, theirs ? tr('В основном файле с тех пор изменено: {0} — они придут в ветку через «Получить изменения».', theirs) : tr('Основной файл с тех пор не менялся.'))),
    ...(b.description ? [h('div', { class: 'merge-conflict' }, h('div', { class: 'merge-where' }, h('strong', {}, tr('Описание ветки'))), h('div', {}, b.description))] : []),
    ...(review ? [reviewBlock(review)] : []),
  );
  let page = host.editor.pageId;
  const render = () => {
    const pages = branchDoc.pages();
    if (!pages.includes(page)) page = pages[0] ?? page;
    const select = h('select', { class: 'field-select', 'aria-label': tr('Страница') }, ...pages.map((p) => h('option', { value: p, selected: p === page }, String(branchDoc.get(p, 'name') ?? ''))));
    select.addEventListener('change', () => {
      page = select.value;
      render();
    });
    const diff = compareTopLevel(mainDoc, branchDoc, page);
    const n = diff.added.length + diff.removed.length + diff.changed.length;
    const left = h('canvas', { class: 'versions-canvas' });
    const right = h('canvas', { class: 'versions-canvas' });
    const name = (d: typeof branchDoc, id: NodeId) => String(d.get(id, 'name') ?? '');
    const list = h(
      'ul',
      { class: 'versions-changes' },
      ...diff.changed.map((id) => h('li', {}, h('i', { style: { background: '#f59e0b' } }), tr('Изменён «{0}»', name(branchDoc, id)))),
      ...diff.added.map((id) => h('li', {}, h('i', { style: { background: '#22c55e' } }), tr('Добавлен в ветке: «{0}»', name(branchDoc, id)))),
      ...diff.removed.map((id) => h('li', {}, h('i', { style: { background: '#ef4444' } }), tr('Удалён в ветке: «{0}»', name(mainDoc, id)))),
    );
    mainPane.replaceChildren(
      h('div', { class: 'versions-tools' }, h('div', { class: 'select-wrap' }, select), h('span', { class: 'versions-summary' }, n ? tr('Отличий на странице: {0}', n) : tr('На этой странице как в основном файле'))),
      h('div', { class: 'versions-panes' }, h('figure', {}, h('figcaption', {}, tr('Основной файл')), left), h('figure', {}, h('figcaption', {}, tr('Ветка')), right)),
      ...(n ? [list] : []),
    );
    redraw = () => {
      if (!left.isConnected) return;
      drawPage(left, mainDoc, page, host.renderer, [...diff.changed.map((id) => ({ id, color: '#f59e0b' })), ...diff.removed.map((id) => ({ id, color: '#ef4444' }))]);
      drawPage(right, branchDoc, page, host.renderer, [...diff.changed.map((id) => ({ id, color: '#f59e0b' })), ...diff.added.map((id) => ({ id, color: '#22c55e' }))]);
    };
    requestAnimationFrame(() => redraw?.());
  };
  document.body.append(overlay);
  render();
  closeButton.focus();
}

/** Who was asked, and what each answered. */
function reviewBlock(r: BranchReview): HTMLElement {
  const state = (x: BranchReview['reviewers'][number]) => (x.verdict === 'approved' ? tr('одобрено') : x.verdict === 'changes' ? tr('нужны правки') : tr('ещё не смотрел(а)'));
  return h(
    'div',
    { class: 'merge-conflict' },
    h('div', { class: 'merge-where' }, h('strong', {}, tr('Ревью')), ' · ', tr('просит {0}', r.byName)),
    r.description ? h('div', {}, r.description) : null,
    ...r.reviewers.map((x) => h('div', { class: `review-row ${x.verdict ?? 'pending'}` }, h('span', {}, x.name), h('span', { class: 'review-state' }, state(x)), x.note ? h('div', { class: 'review-note' }, x.note) : null)),
  );
}

// ---------- the branch bar ----------

/** In a branch, over the canvas: whose branch it is, how much the main file changed since, the review, and the ways back. */
export class BranchBar {
  readonly el: HTMLElement;
  private readonly host: BranchHost;
  private readonly changes: HTMLElement;
  private readonly getButton: HTMLButtonElement;
  private readonly reviewEl: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(host: BranchHost, actions: { update(): void; merge(): void; branches(): void }) {
    this.host = host;
    const b = host.branch!;
    const editable = canEdit(host.role);
    this.changes = h('span', { class: 'branch-bar-changes' });
    this.getButton = h('button', { class: 'link-button', type: 'button', hidden: true, onclick: () => actions.update() }, tr('Получить изменения'));
    this.reviewEl = h('span', { class: 'branch-bar-review' });
    const merge = h('button', { class: 'text-button primary branch-bar-merge', type: 'button', onclick: () => actions.merge() }, tr('Слить в основной…'));
    this.el = h(
      'div',
      { class: 'branch-bar', role: 'status' },
      icon('branch', 14),
      h('button', { class: 'link-button branch-bar-name', type: 'button', title: tr('Ветка от «{0}» — все ветки файла', b.mainName), onclick: () => actions.branches() }, tr('Ветка от «{0}»', b.mainName)),
      this.changes,
      h('button', { class: 'link-button', type: 'button', title: tr('Что изменено в ветке — рядом с основным файлом'), onclick: () => void showChanges(this.host) }, tr('Изменения')),
      this.reviewEl,
      ...(editable ? [this.getButton, merge] : []),
    );
    if (b.merged) {
      this.changes.textContent = tr('слита {0}', when(b.merged.at));
      merge.hidden = true;
      return;
    }
    this.renderReview();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 120_000);
    window.addEventListener('focus', this.onFocus);
  }

  private readonly onFocus = () => void this.refresh();

  /** The review part: ask for one (the author's side), the answers so far, and the reviewer's two buttons. */
  private renderReview(): void {
    const b = this.host.branch!;
    const r = b.review;
    const me = this.host.userId;
    const parts: (HTMLElement | string)[] = [];
    if (!r) {
      if (canEdit(this.host.role)) parts.push(h('button', { class: 'link-button', type: 'button', onclick: () => void askReview(this.host, (review) => this.setReview(review)) }, tr('Запросить ревью…')));
    } else {
      const approved = r.reviewers.filter((x) => x.verdict === 'approved').length;
      const changes = r.reviewers.filter((x) => x.verdict === 'changes');
      const status = changes.length ? tr('Нужны правки: {0}', changes.map((x) => x.name).join(', ')) : tr('Ревью: одобрили {0} из {1}', approved, r.reviewers.length);
      parts.push(h('button', { class: `link-button branch-bar-status${changes.length ? ' behind' : approved === r.reviewers.length ? ' done' : ''}`, type: 'button', title: tr('Подробнее — в «Изменениях»'), onclick: () => void showChanges(this.host) }, status));
      const mine = r.reviewers.find((x) => x.id === me);
      if (mine) {
        parts.push(
          h('button', { class: 'link-button', type: 'button', onclick: () => void this.answer('approved') }, mine.verdict === 'approved' ? tr('Одобрено ✓') : tr('Одобрить')),
          h('button', { class: 'link-button', type: 'button', onclick: () => void this.answer('changes') }, tr('Нужны правки…')),
        );
      }
    }
    this.reviewEl.replaceChildren(...parts);
  }

  private setReview(review: BranchReview | undefined): void {
    const b = this.host.branch!;
    if (review) b.review = review;
    else delete b.review;
    this.renderReview();
  }

  private async answer(verdict: 'approved' | 'changes'): Promise<void> {
    let note = '';
    if (verdict === 'changes') {
      const text = await askText({ title: tr('Нужны правки'), label: tr('Что поправить'), placeholder: tr('Например, «заголовок крупнее, отступы как в основном»'), confirm: tr('Отправить'), maxLength: 2000, empty: tr('Напишите, что поправить'), hint: tr('Автор ветки получит письмо. Подробные замечания удобнее оставить комментариями на холсте.') });
      if (text === null) return;
      note = text;
    }
    try {
      this.setReview(await api.verdict(this.host.fileId, verdict, note));
      this.host.toast(verdict === 'approved' ? tr('Ветка одобрена: автор получит письмо.') : tr('Автор ветки получит письмо с вашими замечаниями.'), 'info');
    } catch (error) {
      this.host.toast(message(error), 'error');
    }
  }

  /** How much the main file changed since the branch last took its changes. */
  async refresh(): Promise<void> {
    const b = this.host.branch;
    if (!b || b.merged) return;
    try {
      const [{ base, branch }, main] = await Promise.all([api.info(this.host.fileId), api.fresh(b.of)]);
      const n = countChanges(parse(base), parse(main));
      // Said only when there is something to take: the bar stays short.
      this.changes.textContent = n ? tr('Основной файл изменён: {0}', n) : '';
      this.changes.classList.toggle('behind', n > 0);
      this.getButton.hidden = n === 0;
      // Answers of reviewers that came meanwhile.
      if (JSON.stringify(branch.review ?? null) !== JSON.stringify(b.review ?? null)) this.setReview(branch.review);
    } catch {
      this.changes.textContent = '';
      this.getButton.hidden = true;
    }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    window.removeEventListener('focus', this.onFocus);
    this.el.remove();
  }
}
