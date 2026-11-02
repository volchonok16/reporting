// "Import HTML" window (FEAT-036): the "HTML to Layers" Figma plugin, built
// into the editor. Choose an .html file or a whole site folder (pictures, CSS
// and fonts are picked up from it), or paste code; pick the screen width; the
// page renders in a live preview; "Import" turns it into editable layers on
// the current page. Or describe a screen in words (FEAT-172, the ✦ menu): a
// language model on the server writes the page, the preview grows as it comes.
// The page can then be changed in words ("Доработать"), and so can a layout
// already on the canvas (✦ → «Изменить по описанию»): its HTML goes to the
// model with the request, the changed page takes the layer's place.

import { tr, type NodeId } from '#core';
import type { Editor } from '../editor.ts';
import { clear, h, icon } from '../ui/dom.ts';
import { applyEdits, extractHtml, generateLayout, lastCodeLine, layoutStage, packPictures, promptName, workPhrases } from './ai.ts';
import { FILES_CHARS, readAttachment, type Attachment } from './attachments.ts';
import { buildHtmlImport } from './build.ts';
import { createPreparer, readFileBuf } from './prepare.ts';
import { capturePage, renderPage, slideRect, type SlideRect } from './sandbox.ts';
import { isSlides, slideSize } from '../slides.ts';

interface Picked {
  path: string;
  file: File;
  buf?: ArrayBuffer;
}

const WIDTHS = [
  { label: tr('Десктоп — 1440'), w: 1440, h: 900 },
  { label: tr('Ноутбук — 1280'), w: 1280, h: 800 },
  { label: tr('Планшет — 768'), w: 768, h: 1024 },
  { label: tr('Телефон — 390'), w: 390, h: 844 },
];
const MAX_FILE = 60 * 1024 * 1024;
type Mode = 'file' | 'paste' | 'prompt';
/** A layout on the canvas to change by a description. */
export interface LayoutEdit {
  id: NodeId;
  /** The layer as a page, edge to edge (html-export.ts, bare). */
  html: string;
  width: number;
  height: number;
}
const EXAMPLES = [
  tr('Лендинг кофейни: шапка с меню, большой первый экран, три карточки напитков, отзывы, подвал'),
  tr('Экран входа в мобильный банк: логотип, телефон, код из СМС, кнопка «Войти»'),
  tr('Дашборд продаж: боковое меню, четыре карточки с цифрами, график по месяцам, таблица последних заказов'),
];
/** While the model writes, the preview is redrawn so often: a redraw takes ~15 ms, the model adds ~220 characters a second. */
const GROW_MS = 1000;
const isHtml = (p: string) => /\.x?html?$/i.test(p);

/**
 * Windows closed while the model writes: hidden, not stopped (30 October). The model
 * finishes in the background; the same window opens again with the page, ready to import.
 */
const background = new Set<HtmlImportDialog>();

async function readEntry(entry: FileSystemEntry, prefix: string, out: Picked[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push({ path: prefix + file.name, file });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    let batch: FileSystemEntry[];
    do {
      batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await readEntry(e, `${prefix}${entry.name}/`, out);
    } while (batch.length);
  }
}

export class HtmlImportDialog {
  private readonly editor: Editor;
  private readonly overlay: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly status: HTMLElement;
  private readonly importButton: HTMLButtonElement;
  private readonly fileInfo: HTMLElement;
  private readonly code: HTMLTextAreaElement;
  private readonly width: HTMLSelectElement;
  private readonly options: Record<'autoLayout' | 'scroll' | 'expand' | 'simplify', HTMLInputElement>;
  private mode: Mode = 'file';
  private readonly prompt: HTMLTextAreaElement;
  private readonly generateButton: HTMLButtonElement;
  private readonly title: HTMLElement;
  /** The page the model wrote for the description (whole or so far). */
  private generated = '';
  private generatedName = '';
  /** The model is writing: stops it when the window is closed. */
  private generating: AbortController | null = null;
  /** A layout on the canvas being changed by a description: its layer, the page it exports to, its size. */
  private readonly edit: LayoutEdit | null;
  private readonly refineInput: HTMLTextAreaElement;
  private readonly refineButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly refineBox: HTMLElement;
  /** Files for the model (a table of prices, a text), already as text. */
  private attachments: Attachment[] = [];
  /** The chips of the files: under the description and in «Доработать словами», the same list. */
  private readonly filesLists: HTMLElement[] = [];
  /** Earlier versions of the page, for «Вернуть прежний». */
  private versions: string[] = [];
  /** While the page has no body yet: a sketch of a page drawing itself, what the model is busy with, the line it writes. */
  private waiting: { caption: HTMLElement; code: HTMLElement } | null = null;
  private files: Picked[] = [];
  private selected: Picked | null = null;
  private frame: HTMLIFrameElement | null = null;
  private frameKey = '';
  /** In a presentation: the page's block drawn as a slide — the preview shows only it, as only it is imported (BUG-136). */
  private crop: SlideRect | null = null;
  private readonly note: HTMLElement;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = 0;

  /** Opens the window — or the one hidden while the model writes for the same layout (or a new one). */
  static open(editor: Editor, start: Mode = 'file', edit: LayoutEdit | null = null): HtmlImportDialog {
    for (const d of background) {
      if (d.editor === editor && (d.edit?.id ?? null) === (edit?.id ?? null)) {
        d.show();
        return d;
      }
    }
    return new HtmlImportDialog(editor, start, edit);
  }

  constructor(editor: Editor, start: Mode = 'file', edit: LayoutEdit | null = null) {
    this.editor = editor;
    this.edit = edit;
    if (edit) start = 'prompt';
    this.status = h('p', { class: 'hi-status', role: 'status' });
    this.importButton = h('button', { class: 'text-button primary', type: 'button', disabled: true, onclick: () => void this.run() }, tr('Импортировать'));
    this.preview = h('div', { class: 'hi-preview' }, h('p', { class: 'hi-empty' }, tr('Здесь появится превью страницы')));
    this.note = h('p', { class: 'hi-note' }, this.noteText());

    // Source: file/folder or pasted code.
    const fileInput = h('input', { type: 'file', multiple: true, accept: '.html,.htm,text/html', hidden: true });
    const dirInput = h('input', { type: 'file', hidden: true });
    dirInput.setAttribute('webkitdirectory', '');
    const fromInput = (input: HTMLInputElement) => [...(input.files ?? [])].map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
    fileInput.addEventListener('change', () => void this.setFiles(fromInput(fileInput)));
    dirInput.addEventListener('change', () => void this.setFiles(fromInput(dirInput)));
    this.fileInfo = h('p', { class: 'hi-file', hidden: true });
    const drop = h(
      'div',
      { class: 'hi-drop' },
      icon('page', 22),
      h('strong', {}, tr('Перетащите .html или папку сайта')),
      h('span', {}, tr('Картинки, CSS и шрифты из папки подтянутся сами')),
      h('div', { class: 'hi-drop-buttons' }, h('button', { class: 'text-button', type: 'button', onclick: () => fileInput.click() }, tr('Выбрать файлы')), h('button', { class: 'text-button', type: 'button', onclick: () => dirInput.click() }, tr('Выбрать папку'))),
      fileInput,
      dirInput,
    );
    for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); });
    for (const t of ['dragleave', 'drop']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => void this.onDrop(e as DragEvent));
    this.code = h('textarea', { class: 'hi-code', placeholder: tr('Вставьте HTML-код страницы — например, ответ нейросети'), spellcheck: false });
    this.code.addEventListener('input', () => this.schedule(700));
    const filePane = h('div', { class: 'hi-pane' }, drop, this.fileInfo);
    const codePane = h('div', { class: 'hi-pane', hidden: true }, this.code);

    // A description in words: the model writes the page.
    this.prompt = h('textarea', { class: 'hi-code hi-prompt', placeholder: tr('Опишите экран: что на нём, для кого, в каком стиле'), maxLength: 4000 });
    this.prompt.addEventListener('input', () => this.refresh());
    this.prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.generate();
      }
    });
    this.generateButton = h('button', { class: 'text-button primary hi-generate', type: 'button', disabled: true, onclick: () => void this.generate() }, tr('Создать макет'));
    const examples = h('div', { class: 'hi-examples' }, ...EXAMPLES.map((text) => h('button', { class: 'hi-example', type: 'button', title: text, onclick: () => {
      this.prompt.value = text;
      this.prompt.focus({ preventScroll: true });
      this.refresh();
    } }, text.split(':')[0]!)));
    // Changing the page in words: shown once there is a page.
    this.refineInput = h('textarea', { class: 'hi-code hi-prompt hi-refine', placeholder: tr('Что поправить? Например: шапку сделать тёмной, добавить четвёртую карточку, кнопки скруглить сильнее'), maxLength: 4000 });
    this.refineInput.addEventListener('input', () => this.refresh());
    this.refineInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.generate(true);
      }
    });
    this.refineButton = h('button', { class: 'text-button primary hi-generate', type: 'button', disabled: true, onclick: () => void this.generate(true) }, tr('Доработать'));
    this.backButton = h('button', { class: 'text-button hi-back', type: 'button', hidden: true, onclick: () => this.back() }, tr('Вернуть прежний'));
    this.refineBox = h('div', { class: 'hi-refine-box', hidden: !edit }, h('strong', { class: 'hi-refine-title' }, edit ? tr('Что изменить в макете') : tr('Доработать словами')), this.refineInput, h('div', { class: 'hi-refine-buttons' }, this.backButton, this.refineButton));
    // Files: data and texts for the layout, read here into text.
    const attachInput = h('input', { type: 'file', multiple: true, hidden: true, accept: '.xlsx,.xlsm,.csv,.tsv,.txt,.md,.json,.xml,.docx,.pptx,.html,.htm,.yaml,.yml' });
    attachInput.addEventListener('change', () => {
      void this.attach([...(attachInput.files ?? [])]);
      attachInput.value = '';
    });
    const attachRow = () => {
      const list = h('div', { class: 'hi-files' });
      this.filesLists.push(list);
      return h(
        'div',
        { class: 'hi-attach' },
        h('button', { class: 'text-button hi-attach-button', type: 'button', title: tr('Excel, CSV, Word, PowerPoint, текст, JSON — их данные попадут в макет'), onclick: () => attachInput.click() }, icon('document', 14), h('span', {}, tr('Прикрепить файл'))),
        list,
      );
    };
    for (const area of [this.prompt, this.refineInput]) {
      area.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
      });
      area.addEventListener('drop', (e) => {
        if (!e.dataTransfer?.files.length) return;
        e.preventDefault();
        void this.attach([...e.dataTransfer.files]);
      });
    }
    // A change in words takes files too (30 October: there was the button only under the description).
    this.refineBox.insertBefore(attachRow(), this.refineBox.lastElementChild);
    const promptPane = h(
      'div',
      { class: 'hi-pane', hidden: true },
      attachInput,
      ...(edit ? [] : [this.prompt, attachRow(), examples, this.generateButton]),
      this.refineBox,
      h('p', { class: 'hi-privacy' }, tr('Описание и прикреплённые файлы обрабатываются на сервере Симметрики. До 20 макетов в сутки.')),
    );
    const tabFile = h('button', { class: 'auth-tab active', type: 'button', role: 'tab' }, tr('Файлы'));
    const tabCode = h('button', { class: 'auth-tab', type: 'button', role: 'tab' }, tr('Вставить код'));
    const tabPrompt = h('button', { class: 'auth-tab', type: 'button', role: 'tab' }, tr('По описанию'));
    this.title = h('h2', {}, tr('Импорт HTML'));
    // How the page becomes layers: for a page of one's own. A page by the model is written to our rules —
    // the right choice is always the same, so its windows show none (29 October: «зачем там чекбоксы?»).
    const optionsBox = h('div', { class: 'hi-options' });
    const intro = h('p', { class: 'share-muted' });
    const setMode = (m: Mode) => {
      this.mode = m;
      optionsBox.hidden = m === 'prompt';
      // A slide by a description is made in the slide's size: the width of a screen means nothing there.
      widthLabel.hidden = this.slidePrompt();
      intro.textContent = this.edit
        ? tr('Скажите словами, что поправить: нейросеть изменит макет, а вы сравните до и после. Правку можно продолжать, пока не понравится.')
        : m === 'prompt'
          ? this.slidePrompt()
            ? tr('Опишите слайд словами: нейросеть сверстает его точно в размер слайдов презентации — {0} × {1}, и он станет редактируемыми слоями.', slideSize(this.editor.doc, this.editor.pageId).w, slideSize(this.editor.doc, this.editor.pageId).h)
            : tr('Опишите экран словами: нейросеть сверстает его, и он станет редактируемыми слоями.')
          : tr('Превращает HTML-страницу в редактируемые слои: фреймы, текст, картинки, SVG-иконки, градиенты и тени.');
      tabFile.classList.toggle('active', m === 'file');
      tabCode.classList.toggle('active', m === 'paste');
      tabPrompt.classList.toggle('active', m === 'prompt');
      filePane.hidden = m !== 'file';
      codePane.hidden = m !== 'paste';
      promptPane.hidden = m !== 'prompt';
      this.title.textContent = this.edit ? tr('Изменить по описанию') : m === 'prompt' ? tr('Макет по описанию') : tr('Импорт HTML');
      this.schedule(50);
    };
    tabFile.addEventListener('click', () => setMode('file'));
    tabCode.addEventListener('click', () => setMode('paste'));
    tabPrompt.addEventListener('click', () => setMode('prompt'));

    // Settings.
    this.width = h('select', { class: 'share-select hi-width', 'aria-label': tr('Ширина экрана') });
    WIDTHS.forEach((w, i) => this.width.append(h('option', { value: String(i) }, w.label)));
    this.width.addEventListener('change', () => this.schedule(100));
    const widthLabel = h('label', { class: 'share-setting' }, h('span', {}, tr('Ширина')), this.width);
    const check = (label: string, hint: string, checked: boolean) => {
      const input = h('input', { type: 'checkbox', checked });
      return { input, el: h('label', { class: 'hi-check' }, input, h('span', {}, h('strong', {}, label), h('small', {}, hint))) };
    };
    const al = check(tr('Адаптивная раскладка'), tr('Строки на flex и блоки друг под другом станут адаптивной раскладкой: кнопки подстроятся под текст'), true);
    const scroll = check(tr('Прокрутить страницу'), tr('Проявит блоки, которые появляются при прокрутке'), false);
    const expand = check(tr('Развернуть панели с прокруткой'), tr('Для приложений: возьмёт всё содержимое, а не первый экран'), true);
    const simplify = check(tr('Упростить структуру'), tr('Уберёт пустые обёртки без фона, рамок и обрезки; почти равные отступы (до 4 px) станут одним промежутком'), true);
    this.options = { autoLayout: al.input, scroll: scroll.input, expand: expand.input, simplify: simplify.input };
    optionsBox.append(al.el, scroll.el, expand.el, simplify.el);

    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog hi-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Импорт HTML') },
      h('header', { class: 'dialog-header' }, this.title, close),
      h(
        'div',
        { class: 'hi-body' },
        h(
          'div',
          { class: 'hi-side' },
          intro,
          edit ? null : h('div', { class: 'auth-tabs', role: 'tablist' }, tabFile, tabCode, tabPrompt),
          filePane,
          codePane,
          promptPane,
          edit ? null : widthLabel,
          optionsBox,
        ),
        h('div', { class: 'hi-main' }, this.preview, this.note),
      ),
      h('footer', { class: 'dialog-footer hi-footer' }, this.status, this.importButton),
    );
    this.overlay = h('div', { class: 'dialog-overlay' }, dialog);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
    dialog.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !this.busy) this.close();
    });
    document.body.append(this.overlay);
    addEventListener('resize', this.fit);
    if (edit) {
      this.generated = edit.html;
      this.generatedName = '';
      this.importButton.textContent = tr('Заменить макет');
    }
    if (start !== 'file') {
      setMode(start);
      (edit ? this.refineInput : start === 'prompt' ? this.prompt : this.code).focus({ preventScroll: true });
    }
  }

  /** While the model writes, the window only hides: the work goes on, reopening shows it. */
  close(): void {
    if (this.generating) {
      this.overlay.hidden = true;
      background.add(this);
      return;
    }
    background.delete(this);
    removeEventListener('resize', this.fit);
    this.overlay.remove();
  }

  private show(): void {
    if (!this.overlay.hidden) return;
    this.overlay.hidden = false;
    // The preview was not drawn while hidden (no size to fit): drawn now.
    if (this.mode === 'prompt' && this.generated && !this.frame?.isConnected) void this.growPreview(null);
    else this.fit();
    (this.importButton.disabled ? this.refineInput : this.importButton).focus({ preventScroll: true });
  }

  private setStatus(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }

  private async onDrop(e: DragEvent): Promise<void> {
    // Take everything from the event at once: Safari closes access after an await.
    const flat: Picked[] = [...(e.dataTransfer?.files ?? [])].map((f) => ({ path: f.name, file: f }));
    const entries = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.() ?? null).filter((x): x is FileSystemEntry => !!x);
    const dirs = entries.filter((en) => en.isDirectory);
    if (!dirs.length) return this.setFiles(flat);
    const out = flat.filter((f) => !dirs.some((d) => d.name === f.path));
    try {
      for (const d of dirs) await readEntry(d, '', out);
    } catch {
      // what was read is used
    }
    await this.setFiles(out);
  }

  private async setFiles(list: Picked[]): Promise<void> {
    this.setStatus(list.length ? tr('Читаю файлы…') : '');
    await Promise.all(list.filter((f) => f.file.size <= MAX_FILE).map(async (f) => {
      try {
        f.buf = await readFileBuf(f.file);
      } catch {
        // reported below if it is the page itself
      }
    }));
    this.files = list;
    const pages = list.filter((f) => isHtml(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length || (/(^|\/)index\.x?html?$/i.test(a.path) ? -1 : 1));
    this.selected = pages[0] ?? null;
    if (!this.selected) {
      this.fileInfo.hidden = true;
      this.setStatus(list.length ? tr('Среди выбранных файлов нет .html') : '', list.length > 0);
      this.refresh();
      return;
    }
    const assets = list.length - pages.length;
    this.fileInfo.hidden = false;
    this.fileInfo.textContent = `${this.selected.path}${assets ? tr(' и ещё файлов: {0}', assets) : ''}`;
    this.setStatus('');
    this.schedule(10);
  }

  private hasSource(): boolean {
    if (this.mode === 'prompt') return !this.generating && this.generated.length > 0;
    return this.mode === 'paste' ? this.code.value.trim().length > 0 : !!this.selected?.buf;
  }

  private refresh(): void {
    // A layout from the canvas: nothing to replace until it was changed.
    this.importButton.disabled = this.busy || !this.hasSource() || (!!this.edit && !this.versions.length);
    this.refineButton.disabled = this.busy || !!this.generating || !this.generated || this.refineInput.value.trim().length < 3;
    this.refineButton.textContent = this.generating && this.refineInput.value.trim() ? tr('Колдуем…') : tr('Доработать');
    this.backButton.hidden = !this.versions.length;
    this.backButton.disabled = !!this.generating;
    this.generateButton.disabled = this.busy || !!this.generating || this.prompt.value.trim().length < 3;
    this.generateButton.textContent = this.generating ? tr('Колдуем…') : this.generated ? tr('Другой вариант') : tr('Создать макет');
  }

  /** The model writes the page for the description; the preview grows as the text comes. */
  /** Reads chosen files into text for the model; a file that cannot be read says why. */
  private async attach(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        if (file.size > 30 * 1024 * 1024) throw new Error(tr('«{0}» больше 30 МБ', file.name));
        const a = await readAttachment(file.name, new Uint8Array(await readFileBuf(file)));
        const total = this.attachments.reduce((n, x) => n + x.text.length, 0);
        if (total + a.text.length > FILES_CHARS) throw new Error(tr('«{0}» не поместился: нейросеть прочтёт до {1} тыс. знаков из всех файлов вместе', file.name, FILES_CHARS / 1000));
        this.attachments = [...this.attachments.filter((x) => x.name !== a.name), a];
        this.setStatus(a.cut ? tr('«{0}» длинный — нейросеть прочтёт начало, {1} тыс. знаков', a.name, Math.round(a.text.length / 1000)) : '');
      } catch (error) {
        this.setStatus(error instanceof Error ? error.message : String(error), true);
      }
    }
    this.showFiles();
  }

  private showFiles(): void {
    for (const list of this.filesLists) list.replaceChildren(
      ...this.attachments.map((a) =>
        h(
          'span',
          { class: 'hi-file-chip', title: a.text.slice(0, 400) },
          h('span', { class: 'hi-file-name' }, a.name),
          h('button', { class: 'hi-file-remove', type: 'button', title: tr('Убрать файл'), 'aria-label': tr('Убрать файл'), onclick: () => {
            this.attachments = this.attachments.filter((x) => x !== a);
            this.showFiles();
          } }, '×'),
        ),
      ),
    );
  }

  /** Goes back to the page before the last change in words. */
  private back(): void {
    const prev = this.versions.pop();
    if (prev === undefined || this.generating) return;
    this.generated = prev;
    this.code.value = this.edit && !this.versions.length ? '' : prev;
    this.setStatus(this.versions.length || !this.edit ? tr('Вернул прежний вариант.') : tr('Это макет как он есть на холсте.'));
    this.refresh();
    void this.growPreview(null);
  }

  /**
   * The model writes the page for the description; the preview grows as the text comes.
   * `refine` — changes the page there is by the request in the second field (the preview
   * keeps the current page until the changed one is ready).
   */
  private async generate(refine = false): Promise<void> {
    const prompt = (refine ? this.refineInput : this.prompt).value.trim();
    if (this.busy || this.generating || prompt.length < 3 || (refine && !this.generated)) return;
    let base: string | undefined;
    let restore = (text: string) => text;
    if (refine) {
      const packed = packPictures(this.generated);
      base = packed.html;
      restore = packed.restore;
    }
    let missed = 0;
    let blocks = 0;
    const previous = this.generated;
    const previousName = this.generatedName;
    const ctl = new AbortController();
    this.generating = ctl;
    if (!refine) {
      this.generated = '';
      this.generatedName = promptName(prompt);
    }
    this.refresh();
    // Phrases in turn with how far the model got, not «the model is writing» (a change shows no growing preview either).
    const phrases = workPhrases().sort(() => Math.random() - 0.5);
    let phrase = 0;
    let lines = 0;
    const say = () => this.setStatus(lines ? `${phrases[phrase % phrases.length]} ${tr('Строк: {0}', lines)}` : phrases[phrase % phrases.length]!);
    const turn = setInterval(() => (phrase++, say()), 3500);
    say();
    if (!refine) this.showWaiting();
    let shown = 0;
    let drawing: Promise<void> | null = null;
    const grow = () => {
      if (drawing || Date.now() - shown < GROW_MS || this.mode !== 'prompt') return;
      shown = Date.now();
      if (this.overlay.hidden) return;
      drawing = this.growPreview(ctl).finally(() => (drawing = null));
    };
    try {
      // A slide (new or changed) is asked for in its exact size, not a page to be fitted into it.
      const slide = isSlides(this.editor.doc) && (!this.edit || this.editor.isSlide(this.edit.id)) ? this.viewport() : undefined;
      const text = await generateLayout(prompt, this.viewport().w, ctl.signal, (so) => {
        if (refine) {
          // The current page stays in the preview: half of a changed page would look like a loss.
          lines = so.split('\n').length;
          say();
          return;
        }
        this.generated = extractHtml(so);
        lines = so.split('\n').length;
        say();
        if (this.waiting) {
          this.waiting.caption.textContent = layoutStage(so);
          this.waiting.code.textContent = lastCodeLine(so);
        }
        // Something to see only once the page has content past its styles.
        if (/<body[^>]*>[\s\S]*<(div|header|section|main|nav|h1)/i.test(this.generated)) grow();
      }, base, this.attachments.map(({ name, text }) => ({ name, text })), slide);
      if (ctl.signal.aborted) return;
      let html: string;
      if (refine) {
        // Edit blocks applied to the page as it is: the rest stays exactly as it was.
        const result = applyEdits(base!, text);
        if (!result || !result.applied) throw new Error(tr('Нейросеть не поняла, что поменять. Скажите иначе — например, какой текст или блок и на что.'));
        missed = result.missed;
        blocks = result.applied + result.missed;
        html = restore(result.html);
      } else html = extractHtml(text);
      if (!/<(body|div|main|section|header)[\s>]/i.test(html)) throw new Error(refine ? tr('Нейросеть ответила не макетом. Опишите правку иначе.') : tr('Нейросеть ответила не макетом. Опишите экран иначе.'));
      if (previous) this.versions.push(previous);
      this.generated = html;
      // The code is there to tweak by hand, too.
      this.code.value = html;
      this.generating = null;
      if (refine) this.refineInput.value = '';
      this.refineBox.hidden = false;
      this.setStatus(
        missed
          ? tr('Сделана часть правки: {0} из {1} мест нейросеть не нашла. Проверьте превью или скажите точнее.', missed, blocks)
          : this.edit
            ? tr('Готово. Проверьте превью и нажмите «Заменить макет» — или поправьте ещё.')
            : refine
              ? tr('Правка готова. Импортируйте или поправьте ещё.')
              : tr('Готово. Проверьте превью и нажмите «Импортировать» — или доработайте словами.'),
      );
      await drawing;
      if (this.overlay.hidden) {
        this.frame = null;
        this.editor.toast(this.edit ? tr('Правка макета готова: выделите его и снова откройте ✦ → «Изменить по описанию».') : tr('Макет готов: откройте ✦ → «Макет по описанию» и нажмите «Импортировать».'));
        return;
      }
      await this.growPreview(null);
      this.importButton.focus();
    } catch (error) {
      if (ctl.signal.aborted) return;
      if (refine) {
        // A failed change keeps the page there was.
        this.generated = previous;
        this.generatedName = previousName;
      } else {
        this.generated = '';
        this.waiting = null;
        this.preview.replaceChildren(h('p', { class: 'hi-empty' }, tr('Здесь появится превью страницы')));
      }
      this.setStatus(error instanceof Error ? error.message : String(error), true);
      if (this.overlay.hidden) this.editor.toast(tr('Макет по описанию: {0}', error instanceof Error ? error.message : String(error)), 'error');
    } finally {
      clearInterval(turn);
      if (this.generating === ctl) this.generating = null;
      this.refresh();
    }
  }

  /** A new slide by a description: the model makes it in the presentation's slide size (no width to choose). */
  private slidePrompt(): boolean {
    return !this.edit && this.mode === 'prompt' && isSlides(this.editor.doc);
  }

  private viewport(): { w: number; h: number } {
    if (this.edit) return { w: Math.round(this.edit.width), h: Math.round(this.edit.height) };
    if (this.slidePrompt()) {
      const size = slideSize(this.editor.doc, this.editor.pageId);
      return { w: Math.round(size.w), h: Math.round(size.h) };
    }
    const p = WIDTHS[Number(this.width.value)] ?? WIDTHS[0]!;
    return { w: p.w, h: p.h };
  }

  private key(): string {
    const v = this.viewport();
    const src = this.mode === 'prompt' ? `g:${this.generated.length}:${this.generatedName}` : this.mode === 'paste' ? `p:${this.code.value.length}:${this.code.value.slice(0, 200)}` : `f:${this.selected?.path}:${this.selected?.buf?.byteLength}`;
    return `${src}|${v.w}`;
  }

  private async source(): Promise<{ html: string; name: string } | null> {
    if (this.mode === 'prompt') {
      if (!this.generated) return null;
      return { html: await createPreparer([], null).prepareHtml(this.generated, ''), name: this.generatedName };
    }
    if (this.mode === 'paste') {
      const code = this.code.value;
      if (!code.trim()) return null;
      return { html: await createPreparer([], null).prepareHtml(code, ''), name: tr('Вставленный HTML') };
    }
    const sel = this.selected;
    if (!sel?.buf) return null;
    const prep = createPreparer(this.files, sel);
    const raw = await prep.readText(sel);
    return { html: await prep.prepareHtml(raw, sel.path), name: sel.path.split('/').pop()!.replace(/\.x?html?$/i, '') };
  }

  /** Re-renders the preview a moment after the source or the width changed. */
  private schedule(ms: number): void {
    this.refresh();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.renderPreview(), ms);
  }

  /** The sketch of a page drawing itself, in the preview's place, at the screen's proportions. */
  private showWaiting(): void {
    const v = this.viewport();
    const box = this.preview.getBoundingClientRect();
    const s = Math.min((box.width - 16) / v.w, (box.height - 72) / v.h, 1);
    const block = (cls: string, ...children: HTMLElement[]) => h('div', { class: `hi-sk ${cls}` }, ...children);
    const sheet = h(
      'div',
      { class: `hi-wait-sheet${v.w <= 480 ? ' mobile' : ''}`, style: { width: `${Math.round(v.w * s)}px`, height: `${Math.round(v.h * s)}px` } },
      block('hi-sk-bar', block('hi-sk-logo'), block('hi-sk-pill'), block('hi-sk-pill'), block('hi-sk-pill')),
      block('hi-sk-hero', block('hi-sk-line wide'), block('hi-sk-line'), block('hi-sk-button')),
      h('div', { class: 'hi-sk-row' }, block('hi-sk-card'), block('hi-sk-card'), block('hi-sk-card')),
      block('hi-sk-line wide'),
      block('hi-sk-line'),
    );
    const caption = h('p', { class: 'hi-wait-caption' }, layoutStage(''));
    const code = h('code', { class: 'hi-wait-code' });
    this.waiting = { caption, code };
    this.frame = null;
    this.preview.replaceChildren(h('div', { class: 'hi-wait' }, sheet, caption, code));
  }

  /**
   * Draws the page so far (or the whole one) in a new frame hidden behind the
   * current preview and swaps them only when it is ready: no blank flashes
   * while the model writes. `ctl` — the generation it belongs to.
   */
  private async growPreview(ctl: AbortController | null): Promise<void> {
    const src = await this.source();
    if (!src || (ctl && this.generating !== ctl) || this.mode !== 'prompt') return;
    const v = this.viewport();
    const inner = h('div', { class: 'hi-preview-inner hi-preview-next' });
    this.preview.append(inner);
    try {
      const frame = await renderPage(inner, src.html, v.w, v.h);
      if ((ctl && this.generating !== ctl) || !inner.isConnected) {
        inner.remove();
        return;
      }
      for (const el of [...this.preview.children]) if (el !== inner) el.remove();
      inner.classList.remove('hi-preview-next');
      this.waiting = null;
      this.frame = frame;
      this.frameKey = this.key();
      this.crop = null;
      await this.findSlide(frame);
      this.fit();
    } catch {
      // A page cut mid-tag may not render: the previous picture stays.
      inner.remove();
    }
  }

  private async renderPreview(): Promise<void> {
    if (this.busy) return;
    const token = ++this.token;
    try {
      const src = await this.source();
      if (token !== this.token) return;
      if (!src) {
        this.frame = null;
        clear(this.preview);
        this.preview.append(h('p', { class: 'hi-empty' }, tr('Здесь появится превью страницы')));
        return;
      }
      const v = this.viewport();
      const inner = h('div', { class: 'hi-preview-inner' });
      this.preview.replaceChildren(inner);
      const frame = await renderPage(inner, src.html, v.w, v.h);
      if (token !== this.token) return;
      await this.findSlide(frame);
      if (token !== this.token) return;
      this.frame = frame;
      this.frameKey = this.key();
      this.fit();
    } catch (error) {
      if (token === this.token) this.setStatus(tr('Не получилось показать страницу: {0}', error instanceof Error ? error.message : String(error)), true);
    }
  }

  private noteText(): string {
    if (!isSlides(this.editor.doc)) return tr('Превью живое: переключите вкладку или откройте окно на странице — импортируется то, что видно.');
    // A slide changed in place: no new slide comes.
    if (this.edit && this.editor.isSlide(this.edit.id)) return tr('Слайд изменится на месте: его слои заменятся тем, что в превью, а заметки, место в презентации и тема останутся.');
    return this.crop
      ? tr('В презентацию попадёт слайд со страницы — то, что в превью, без фона вокруг; он станет новым слайдом в формате презентации.')
      : tr('Страница станет новым слайдом: она впишется в формат презентации целиком.');
  }

  /** In a presentation: finds the page's block drawn as a slide (the preview then shows only it). */
  private async findSlide(frame: HTMLIFrameElement): Promise<void> {
    this.crop = null;
    if (isSlides(this.editor.doc)) {
      const size = slideSize(this.editor.doc, this.editor.pageId);
      this.crop = await slideRect(frame, size.w / size.h);
      // A slide lower than the first screen: the frame is made tall enough to show it.
      if (this.crop && this.crop.y + this.crop.h > frame.offsetHeight) frame.style.height = `${Math.ceil(this.crop.y + this.crop.h)}px`;
    }
    this.note.textContent = this.noteText();
  }

  /** Scales the page frame to fit the preview area (in a presentation — the page's slide only). */
  private readonly fit = (): void => {
    const frame = this.frame;
    const inner = frame?.parentElement;
    if (!frame || !inner || this.overlay.hidden) return;
    const box = this.preview.getBoundingClientRect();
    const crop = this.crop;
    if (crop) {
      const k = Math.min((box.width - 16) / crop.w, (box.height - 16) / crop.h, 1);
      inner.style.width = `${Math.round(crop.w * k)}px`;
      inner.style.height = `${Math.round(crop.h * k)}px`;
      frame.style.transform = `translate(${-crop.x * k}px, ${-crop.y * k}px) scale(${k})`;
      return;
    }
    const v = this.viewport();
    const s = Math.min((box.width - 16) / v.w, (box.height - 16) / v.h, 1);
    inner.style.width = `${Math.round(v.w * s)}px`;
    inner.style.height = `${Math.round(v.h * s)}px`;
    frame.style.transform = `scale(${s})`;
  };

  private async run(): Promise<void> {
    if (this.busy || !this.hasSource()) return;
    this.busy = true;
    this.refresh();
    try {
      const src = await this.source();
      if (!src) throw new Error(tr('Нет HTML для импорта'));
      // The live preview as it is now (tabs switched, dialogs opened) — or a fresh render.
      if (!this.frame || !this.frame.isConnected || this.frameKey !== this.key()) {
        this.setStatus(tr('Рендерю страницу…'));
        const v = this.viewport();
        const inner = h('div', { class: 'hi-preview-inner' });
        this.preview.replaceChildren(inner);
        this.frame = await renderPage(inner, src.html, v.w, v.h);
        await this.findSlide(this.frame);
        this.frameKey = this.key();
        this.fit();
      }
      // A page by the model: always the defaults (its window has no options to change them).
      const fixed = this.mode === 'prompt';
      const o = fixed ? { scroll: { checked: false }, simplify: { checked: true }, expand: { checked: true }, autoLayout: { checked: true } } : this.options;
      const res = await capturePage(
        this.frame,
        { delay: 0, scroll: o.scroll.checked, simplify: o.simplify.checked, expand: o.expand.checked, autoLayout: o.autoLayout.checked, spacers: o.autoLayout.checked, name: src.name },
        (text) => this.setStatus(text),
      );
      this.setStatus(tr('Создаю слои: {0}…', res.stats.nodes));
      await new Promise((r) => setTimeout(r, 20));
      // A page from the model stays on its frame, to change it in words later without loss.
      const { count } = buildHtmlImport(this.editor, res.tree, res.images, src.name, this.edit?.id, this.mode === 'prompt' ? this.generated : undefined);
      this.editor.zoomToSelection();
      const undo = /Mac/.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z';
      this.editor.toast(this.edit ? tr('Макет изменён. Вернуть как было — {0}.', undo) : tr('Импортировано слоёв: {0}. Отменить — {1}.', count, undo));
      this.close();
    } catch (error) {
      this.setStatus(tr('Ошибка: {0}', error instanceof Error ? error.message : String(error)), true);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }
}
