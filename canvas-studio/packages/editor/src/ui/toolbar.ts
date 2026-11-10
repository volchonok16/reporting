// Top bar (spec 5.2): menu, file name, sync status, history, zoom.
// Tools live in a dock at the bottom centre of the canvas (FEAT-004), where the
// pointer already is, grouped like in other editors.

import { tr } from '#core';
import type { Command } from '../commands.ts';
import type { Editor, ToolId } from '../editor.ts';
import { formatShortcut } from '../keyboard.ts';
import { clear, h, icon, sparkles } from './dom.ts';
import { SHAPE_KINDS, STAMPS } from '../board.ts';
import { editableZoom } from './zoom-input.ts';

const toolIcon = (tool: { icon: string; emoji?: string }, size: number): Node => (tool.emoji ? h('span', { class: 'tool-emoji', style: { fontSize: `${size - 2}px` } }, tool.emoji) : icon(tool.icon, size));

/** A photo when reporting has one; the letters stay if it does not load. */
function paintFace(host: HTMLElement, letters: string, avatar: string | undefined): void {
  host.replaceChildren();
  if (!avatar) {
    if (letters) host.textContent = letters;
    return;
  }
  const img = h('img', { src: avatar, alt: '' }) as HTMLImageElement;
  img.addEventListener('error', () => {
    host.replaceChildren();
    if (letters) host.textContent = letters;
    host.classList.remove('has-photo');
  });
  host.append(img);
}

/** `viewers` — also shown when the file is read-only (moving around and commenting). */
type ToolEntry = { id: ToolId | null; icon: string; label: string; command: string; viewers?: true; /** Shown instead of the icon (stamps). */ emoji?: string; /** A heading over the entries of a long list (board shapes). */ section?: string; /** A word next to a small icon, for actions no pictogram explains (HTML in, PPTX out). */ text?: string };
/** A group is either plain buttons or a flyout (one button showing the last used tool + a list). */
type ToolGroup = { kind: 'buttons'; tools: ToolEntry[] } | { kind: 'flyout'; label: string; tools: ToolEntry[] };
const TOOL_GROUPS: ToolGroup[] = [
  // One button with a list, as the shapes (27 Oct): the panel had grown too long.
  {
    kind: 'flyout',
    label: tr('Перемещение, рука, масштаб'),
    tools: [
      { id: 'select', icon: 'select', label: tr('Перемещение'), command: 'tool.select', viewers: true },
      { id: 'hand', icon: 'hand', label: tr('Рука'), command: 'tool.hand', viewers: true },
      { id: 'scale', icon: 'scale', label: tr('Масштаб'), command: 'tool.scale' },
    ],
  },
  {
    kind: 'flyout',
    label: tr('Фрейм и секция'),
    tools: [
      { id: 'frame', icon: 'frame', label: tr('Фрейм'), command: 'tool.frame' },
      { id: 'section', icon: 'section', label: tr('Секция'), command: 'tool.section' },
      { id: null, icon: 'code', label: tr('Код-слой'), command: 'object.codeLayer' },
    ],
  },
  // One button with a list (27 Oct): the panel had grown too long.
  {
    kind: 'flyout',
    label: tr('Макеты, иконки, контент'),
    tools: [
      { id: null, icon: 'phone', label: tr('Макеты устройств'), command: 'design.mockups' },
      { id: null, icon: 'iconSet', label: tr('Иконки'), command: 'design.icons' },
      { id: null, icon: 'contentReel', label: tr('Контент'), command: 'design.content' },
      { id: null, icon: 'templates', label: tr('Шаблоны экранов'), command: 'file.templates' },
    ],
  },
  {
    kind: 'flyout',
    label: tr('Фигуры'),
    tools: [
      { id: 'rectangle', icon: 'rectangle', label: tr('Прямоугольник'), command: 'tool.rectangle' },
      { id: 'ellipse', icon: 'ellipse', label: tr('Эллипс'), command: 'tool.ellipse' },
      { id: 'polygon', icon: 'polygon', label: tr('Многоугольник'), command: 'tool.polygon' },
      { id: 'star', icon: 'star', label: tr('Звезда'), command: 'tool.star' },
      { id: 'line', icon: 'line', label: tr('Линия'), command: 'tool.line' },
      { id: 'arrow', icon: 'arrow', label: tr('Стрелка'), command: 'tool.arrow' },
      { id: null, icon: 'image', label: tr('Изображение…'), command: 'tool.image' },
      { id: null, icon: 'imageTiles', label: tr('Большое изображение…'), command: 'tool.bigImage' },
      { id: null, icon: 'blob', label: tr('Клякса…'), command: 'design.blob' },
      { id: null, icon: 'waves', label: tr('Волны…'), command: 'design.waves' },
      { id: null, icon: 'table', label: tr('Таблица…'), command: 'design.table' },
      { id: null, icon: 'backdrop', label: tr('Градиентный фон…'), command: 'design.backdrop' },
      { id: null, icon: 'doodle', label: tr('Каракули…'), command: 'design.doodle' },
    ],
  },
  {
    kind: 'flyout',
    label: tr('Перо, карандаш и ластик'),
    tools: [
      { id: 'pen', icon: 'pen', label: tr('Перо'), command: 'tool.pen' },
      { id: 'pencil', icon: 'pencil', label: tr('Карандаш'), command: 'tool.pencil' },
      { id: 'eraser', icon: 'eraser', label: tr('Ластик'), command: 'tool.eraser' },
    ],
  },
  { kind: 'buttons', tools: [{ id: 'text', icon: 'text', label: tr('Текст'), command: 'tool.text' }] },
  { kind: 'buttons', tools: [{ id: 'comment', icon: 'comment', label: tr('Комментарий'), command: 'tool.comment', viewers: true }] },
  // Files in, one button with a list (27 Oct): our own .csdoc.json (1 Nov), HTML (FEAT-036), Figma, PowerPoint (FEAT-158). Export to
  // PowerPoint lives with the rest of the export, in the right panel (28 Oct).
  {
    kind: 'flyout',
    label: tr('Импорт'),
    tools: [
      { id: null, icon: 'import', label: tr('Файл Симметрики (.csdoc.json)'), command: 'file.importNative' },
      { id: null, icon: 'import', label: tr('Импорт HTML: страница → слои'), command: 'file.importHtml' },
      { id: null, icon: 'import', label: tr('Импорт из Figma (.fig)'), command: 'file.importFig' },
      { id: null, icon: 'import', label: tr('Импорт PowerPoint (.pptx)'), command: 'file.importPptx' },
    ],
  },
];

/** The board's tools (FEAT-083): FigJam's set, in its order. */
const BOARD_TOOL_GROUPS: ToolGroup[] = [
  {
    kind: 'buttons',
    tools: [
      { id: 'select', icon: 'select', label: tr('Перемещение'), command: 'tool.select', viewers: true },
      { id: 'hand', icon: 'hand', label: tr('Рука'), command: 'tool.hand', viewers: true },
    ],
  },
  { kind: 'buttons', tools: [{ id: 'sticky', icon: 'sticky', label: tr('Стикер'), command: 'tool.sticky' }] },
  { kind: 'flyout', label: tr('Фигуры'), tools: SHAPE_KINDS.map((k) => ({ id: 'shape' as const, icon: k.icon, label: k.label, command: `tool.shape.${k.shape}`, section: k.group })) },
  { kind: 'buttons', tools: [{ id: 'connector', icon: 'connector', label: tr('Связь'), command: 'tool.connector' }] },
  {
    kind: 'flyout',
    label: tr('Рисование'),
    tools: [
      { id: 'marker', icon: 'marker', label: tr('Маркер'), command: 'tool.marker' },
      { id: 'highlighter', icon: 'highlighter', label: tr('Выделитель'), command: 'tool.highlighter' },
      { id: 'eraser', icon: 'eraser', label: tr('Ластик'), command: 'tool.eraser' },
      { id: 'tape', icon: 'tape', label: tr('Скотч'), command: 'tool.tape' },
    ],
  },
  { kind: 'buttons', tools: [{ id: 'text', icon: 'text', label: tr('Текст'), command: 'tool.text' }] },
  { kind: 'buttons', tools: [{ id: 'section', icon: 'section', label: tr('Раздел'), command: 'tool.section' }] },
  { kind: 'flyout', label: tr('Штампы'), tools: STAMPS.map((s) => ({ id: 'stamp' as const, icon: 'stamp', label: s.label, command: `tool.stamp.${s.id}`, emoji: s.id === 'me' ? '' : s.text })) },
  { kind: 'buttons', tools: [{ id: 'comment', icon: 'comment', label: tr('Комментарий'), command: 'tool.comment', viewers: true }] },
  { kind: 'buttons', tools: [{ id: null, icon: 'star', label: tr('Наклейки и компоненты'), command: 'board.stickers' }] },
  { kind: 'buttons', tools: [{ id: null, icon: 'table', label: tr('Таблица'), command: 'board.table' }] },
  { kind: 'buttons', tools: [{ id: null, icon: 'code', label: tr('Блок кода'), command: 'board.code' }] },
  { kind: 'buttons', tools: [{ id: null, icon: 'link', label: tr('Ссылка'), command: 'board.insertLink' }] },
  { kind: 'buttons', tools: [{ id: null, icon: 'templates', label: tr('Шаблоны досок'), command: 'board.templates' }] },
];

export type SaveState = 'saved' | 'saving' | 'error' | 'unsaved';

export class Toolbar {
  readonly el: HTMLElement;
  /** Floating tool dock; the app places it over the canvas. */
  readonly dock: HTMLElement;
  private readonly editor: Editor;
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();

  /** The dock's button of a tool (a board's sticky button becomes a pad of stickies). */
  toolButton(id: ToolId): HTMLButtonElement | undefined {
    return this.toolButtons.get(id);
  }
  private readonly zoomLabel: HTMLButtonElement;
  private readonly fileName: HTMLInputElement;
  /** Opens the file list; set by the app. */
  onFiles: () => void = () => {};
  /** Back to the home screen (file browser); set by the app. */
  onHome: () => void = () => {};
  /** Brings the folded right panel back (the button shows only while it is folded). */
  onShowRight: () => void = () => {};
  /** The layers panel: brought back, or (a narrow window, a tablet upright) opened over the canvas. */
  onShowLeft: () => void = () => {};
  /** Opens the account menu at a point; set by the app. */
  onAccount: (x: number, y: number) => void = () => {};
  /** Files are kept on the server (changes the save status wording). */
  cloud = false;
  /** Opens the main menu at a point; set by the app. */
  onMainMenu: (x: number, y: number) => void = () => {};
  /** Opens the "Share" dialog; set by the app. */
  onShare: () => void = () => {};
  /** Opens the help; set by the app. */
  onHelp: () => void = () => {};
  /** A collaborator's avatar was clicked: follow them (again — stop); set by the app. */
  onPeer: (id: string) => void = () => {};
  private readonly account: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly share: HTMLButtonElement;
  private readonly peers: HTMLElement;
  private readonly viewOnly: HTMLElement;
  private readOnly = false;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly historyButton: HTMLButtonElement;
  private history: { close(): void } | null = null;
  private readonly smartButton: HTMLButtonElement;
  private closeSmart: (() => void) | null = null;
  private readonly commands: Map<string, Command>;

  constructor(editor: Editor, commands: Map<string, Command>, openPalette: () => void, board = false) {
    this.editor = editor;
    const shortcut = (id: string) => formatShortcut(commands.get(id)?.keys?.[0] ?? '');
    this.dock = h('div', { class: 'tool-dock', role: 'toolbar', 'aria-label': tr('Инструменты') });
    (board ? BOARD_TOOL_GROUPS : TOOL_GROUPS).forEach((group, i) => {
      if (i > 0) this.dock.append(h('span', { class: 'dock-separator', 'aria-hidden': 'true' }));
      if (group.kind === 'flyout') {
        this.dock.append(this.buildFlyout(group, commands, shortcut));
        return;
      }
      for (const tool of group.tools) {
        const key = shortcut(tool.command);
        const label = key ? `${tool.label} (${key})` : tool.label;
        const run = () => (tool.id ? editor.setTool(tool.id) : commands.get(tool.command)?.run());
        const face = tool.text ? [icon(tool.icon, 14), h('span', {}, tool.text)] : [icon(tool.icon, 18)];
        const button = h('button', { class: `tool-button${tool.text ? ' text-tool' : ''}${tool.viewers ? ' for-viewers' : ''}`, type: 'button', title: label, 'aria-label': label, onclick: run }, ...face);
        if (tool.id) this.toolButtons.set(tool.id, button);
        this.dock.append(button);
      }
    });
    // Smart actions (✦): the last group of the dock; hidden for viewers, as the drawing tools.
    this.commands = commands;
    const smartKey = shortcut('smart.open');
    this.smartButton = h('button', { class: 'tool-button smart-button', type: 'button', title: smartKey ? tr('Умные действия ({0})', smartKey) : tr('Умные действия'), 'aria-label': tr('Умные действия'), 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => this.toggleSmart() }, sparkles(20));
    // A board has no ✦: its stickies are sorted from the bar over them (BUG-071).
    if (!board) this.dock.append(h('span', { class: 'dock-separator smart-separator', 'aria-hidden': 'true' }), this.smartButton);
    // The model at work: ✦ turns until it settles.
    editor.events.on('work', () => this.smartButton.classList.toggle('busy', editor.works.size > 0));
    this.undoButton = h('button', { class: 'icon-button', type: 'button', title: tr('Отменить ({0})', shortcut('edit.undo')), onclick: () => editor.undo() }, icon('undo'));
    this.redoButton = h('button', { class: 'icon-button', type: 'button', title: tr('Повторить ({0})', shortcut('edit.redo')), onclick: () => editor.redo() }, icon('redo'));
    this.historyButton = h('button', { class: 'icon-button', type: 'button', title: tr('История действий'), 'aria-label': tr('История действий'), onclick: () => this.toggleHistory() }, icon('clock'));
    this.fileName = h('input', { class: 'file-name', type: 'text', spellcheck: false, 'aria-label': tr('Название файла') });
    this.fileName.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape') this.fileName.blur();
    });
    this.fileName.addEventListener('change', () => {
      const v = this.fileName.value.trim();
      if (v) editor.commit(tr('Переименовать файл'), (tx) => tx.set(editor.doc.rootId, 'name', v));
    });
    this.status = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
    const files = h('button', { class: 'icon-button files-button', type: 'button', title: tr('Файлы (список всех файлов)'), 'aria-label': tr('Файлы'), onclick: () => this.onFiles() }, icon('chevronDown', 14));
    this.zoomLabel = h('button', { class: 'zoom-label canvas-zoom', type: 'button', title: tr('Масштаб: щёлкните и введите процент (вписать всё — Shift+1)') });
    editableZoom(this.zoomLabel, () => editor.viewport.zoom, (zoom) => editor.zoomTo(zoom));
    this.peers = h('div', { class: 'peers', 'aria-label': tr('Сейчас в файле') });
    this.share = h('button', { class: 'text-button primary share-button', type: 'button', title: tr('Пригласить людей или открыть доступ по ссылке'), onclick: () => this.onShare() }, tr('Поделиться'));
    this.viewOnly = h('span', { class: 'view-only-badge', hidden: true, title: tr('Владелец открыл вам файл только для просмотра: правки не сохраняются') }, icon('eye', 14), h('span', {}, tr('Только просмотр')));
    this.account = h('button', { class: 'account-button', type: 'button', title: tr('Аккаунт'), 'aria-label': tr('Аккаунт'), 'aria-haspopup': 'menu' }, '·');
    this.account.addEventListener('click', () => {
      const r = this.account.getBoundingClientRect();
      this.onAccount(r.right - 220, r.bottom + 4);
    });
    // Main menu, as in Figma: every command by group (Файл, Правка, Вид…); the palette (⌘K) is its search.
    const menu: HTMLButtonElement = h('button', { class: 'icon-button', type: 'button', title: tr('Главное меню'), 'aria-label': tr('Главное меню'), 'aria-haspopup': 'menu' }, icon('menu'));
    menu.addEventListener('click', () => {
      const r = menu.getBoundingClientRect();
      this.onMainMenu(r.left, r.bottom + 4);
    });
    const home = h('button', { class: 'icon-button home-button', type: 'button', title: tr('Все файлы и проекты'), 'aria-label': tr('К файлам'), onclick: () => this.onHome() }, icon('back'), h('span', {}, tr('Файлы')));
    this.el = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'topbar-left' }, home, menu, h('button', { class: 'icon-button show-left', type: 'button', title: tr('Слои и страницы'), 'aria-label': tr('Слои и страницы'), onclick: () => this.onShowLeft() }, icon('panelLeft', 16))),
      h('div', { class: 'topbar-center' }, this.fileName, files, this.status, this.viewOnly),
      h(
        'div',
        { class: 'topbar-right' },
        this.undoButton,
        this.redoButton,
        this.historyButton,
        h('button', { class: 'icon-button canvas-zoom', type: 'button', title: tr('Отдалить ({0})', shortcut('view.zoomOut')), onclick: () => editor.zoomStep(-1) }, icon('minus')),
        this.zoomLabel,
        h('button', { class: 'icon-button canvas-zoom', type: 'button', title: tr('Приблизить ({0})', shortcut('view.zoomIn')), onclick: () => editor.zoomStep(1) }, icon('plus')),
        this.peers,
        this.share,
        h('button', { class: 'help-button', type: 'button', title: tr('Справка (F1)'), 'aria-label': tr('Справка'), onclick: () => this.onHelp() }, h('span', { class: 'help-mark', 'aria-hidden': 'true' }, '?'), h('span', { class: 'help-label' }, tr('Справка'))),
        this.account,
        // Where the panel's own «fold» button was: the way back is in the same place, with or without a selection.
        h('button', { class: 'icon-button show-right', type: 'button', title: tr('Показать панель свойств ({0})', shortcut('view.toggleRight')), 'aria-label': tr('Показать панель свойств'), onclick: () => this.onShowRight() }, icon('panelRight', 16)),
      ),
    );
    editor.events.on('tool', () => this.sync());
    // Panning and dragging fire these every frame (or more often): the bar follows once per frame.
    editor.events.on('viewport', () => this.syncSoon());
    editor.events.on('change', () => this.syncSoon());
    editor.events.on('document', () => this.sync());
    editor.events.on('history', () => this.sync());
    this.sync();
  }

  private flyouts: { tools: ToolEntry[]; main: HTMLButtonElement; current: ToolEntry; set: (t: ToolEntry) => void }[] = [];

  /** FEAT-024: one button with the last used shape and a list of all shapes. */
  private buildFlyout(group: Extract<ToolGroup, { kind: 'flyout' }>, commands: Map<string, Command>, shortcut: (id: string) => string): HTMLElement {
    const editor = this.editor;
    let current = group.tools[0]!;
    const main = h('button', { class: 'tool-button', type: 'button' });
    const chevron = h('button', { class: 'tool-chevron', type: 'button', title: tr('{0}: все', group.label), 'aria-label': tr('{0}: открыть список', group.label), 'aria-haspopup': 'menu' }, icon('chevronDown', 12));
    const set = (tool: ToolEntry) => {
      current = tool;
      main.replaceChildren(toolIcon(tool, 18));
      const key = shortcut(tool.command);
      const label = key ? `${tool.label} (${key})` : tool.label;
      main.title = label;
      main.setAttribute('aria-label', label);
      entry.current = tool;
    };
    // The command when there is one (it may set more than the tool: a board shape's kind, a stamp).
    const run = (tool: ToolEntry) => {
      const command = commands.get(tool.command);
      if (command) command.run();
      else if (tool.id) editor.setTool(tool.id);
    };
    main.addEventListener('click', () => run(current));
    let menu: HTMLElement | null = null;
    const close = () => {
      menu?.remove();
      menu = null;
      chevron.classList.remove('open');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const outside = (e: Event) => {
      if (menu && !menu.contains(e.target as Node) && !chevron.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    chevron.addEventListener('click', () => {
      if (menu) {
        close();
        return;
      }
      // A long list with headings goes in two columns (it would not fit the height of a laptop screen).
      const sections = group.tools.some((t) => t.section);
      menu = h('div', { class: `tool-flyout${sections ? ' columns' : ''}`, role: 'menu', 'aria-label': group.label });
      let section: string | undefined;
      // View-only: only what moves around (no scaling).
      for (const tool of editor.doc.readOnly ? group.tools.filter((t) => t.viewers) : group.tools) {
        if (tool.section && tool.section !== section) {
          section = tool.section;
          menu.append(h('div', { class: 'tool-flyout-heading' }, section));
        }
        const active = tool.id !== null && tool === current && (tool.id === 'scale' ? editor.scaleMode : tool.id === editor.tool && !editor.scaleMode);
        const item = h(
          'button',
          { class: `tool-flyout-item${active ? ' active' : ''}`, type: 'button', role: 'menuitem' },
          toolIcon(tool, 16),
          h('span', { class: 'tool-flyout-label' }, tool.label),
          h('span', { class: 'tool-flyout-key' }, shortcut(tool.command)),
        );
        item.addEventListener('click', () => {
          close();
          // The button shows the last chosen entry, a panel as a tool: a click on it opens that one again.
          set(tool);
          run(tool);
        });
        menu.append(item);
      }
      document.body.append(menu);
      const r = chevron.getBoundingClientRect();
      const mr = menu.getBoundingClientRect();
      // The list opens towards the canvas: up from a bottom panel, down from a top one, right from a left one.
      const place = this.dock.dataset.place ?? 'bottom';
      const clampX = (x: number) => Math.max(8, Math.min(window.innerWidth - mr.width - 8, x));
      const clampY = (y: number) => Math.max(8, Math.min(window.innerHeight - mr.height - 8, y));
      if (place === 'left') {
        menu.style.left = `${r.right + 8}px`;
        menu.style.top = `${clampY(r.top + r.height / 2 - mr.height / 2)}px`;
      } else {
        menu.style.left = `${clampX(r.left + r.width / 2 - mr.width / 2)}px`;
        menu.style.top = `${place === 'top' ? r.bottom + 8 : r.top - mr.height - 8}px`;
      }
      chevron.classList.add('open');
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
    });
    const entry = { tools: group.tools, main, current, set };
    this.flyouts.push(entry);
    for (const tool of group.tools) if (tool.id) this.toolButtons.set(tool.id, main);
    set(current);
    return h('span', { class: `tool-group${group.tools.some((t) => t.viewers) ? ' for-viewers' : ''}` }, main, chevron);
  }

  /** Opens or closes the ✦ menu (the button, ⌘J). */
  toggleSmart(): void {
    if (this.closeSmart) {
      this.closeSmart();
      return;
    }
    void import('./smart-menu.ts').then(({ openSmartMenu }) => {
      if (this.closeSmart) return;
      this.smartButton.classList.add('open');
      this.smartButton.setAttribute('aria-expanded', 'true');
      this.closeSmart = openSmartMenu(this.smartButton, this.dock.dataset.place ?? 'bottom', this.editor, this.commands, () => {
        this.closeSmart = null;
        this.smartButton.classList.remove('open');
        this.smartButton.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /** Where the tool panel stands over the canvas. */
  setDockPlace(place: 'bottom' | 'top' | 'left'): void {
    this.dock.dataset.place = place;
    this.dock.setAttribute('aria-orientation', place === 'left' ? 'vertical' : 'horizontal');
  }

  /** Puts controls of the file (a board's timer and vote) before the people in it. */
  addControls(el: HTMLElement): void {
    this.peers.before(el);
  }

  /** Who is signed in (null: files in this browser only). */
  setAccount(user: { name: string; email: string; avatar?: string } | null): void {
    const initials = user ? (user.name.trim().split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2) || user.email[0] || '?').toUpperCase() : '';
    paintFace(this.account, user ? initials : '', user?.avatar);
    if (!user) this.account.append(icon('folder', 14));
    this.account.classList.toggle('signed-in', !!user);
    this.account.classList.toggle('has-photo', !!user?.avatar);
    this.account.title = user ? (user.name ? `${user.name} (${user.email})` : user.email) : tr('Файлы только в этом браузере');
  }

  /**
   * Who else is in the file now: up to five avatars in their colours, the rest as "+N".
   * A click follows the person; the one being followed gets a ring.
   */
  setPeers(peers: { id: string; name: string; color: string; role: string; avatar?: string }[], following: string | null = null): void {
    clear(this.peers);
    // The person being followed stays visible even when there are many.
    const ordered = [...peers].sort((a, b) => Number(b.id === following) - Number(a.id === following));
    const shown = ordered.slice(0, 5);
    for (const p of shown) {
      const initials = (p.name.trim().split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2) || '?').toUpperCase();
      const role = p.role === 'viewer' || p.role === 'commenter' ? tr(' · смотрит') : '';
      const on = p.id === following;
      const title = `${p.name}${role} — ${on ? tr('перестать наблюдать') : tr('наблюдать')}`;
      const button = h('button', { class: `peer${on ? ' following' : ''}${p.avatar ? ' has-photo' : ''}`, type: 'button', title, 'aria-label': title, 'aria-pressed': String(on), style: { background: p.avatar ? 'transparent' : p.color, outlineColor: p.color }, onclick: () => this.onPeer(p.id) });
      paintFace(button, initials, p.avatar);
      this.peers.append(button);
    }
    if (ordered.length > shown.length) {
      this.peers.append(h('span', { class: 'peer more', title: ordered.slice(5).map((p) => p.name).join(', ') }, `+${ordered.length - shown.length}`));
    }
  }

  /** View-only file: the badge instead of the save status, the name cannot be edited, no undo. */
  /** Opens or closes the list of undo steps under its button. */
  toggleHistory(): void {
    if (this.history) {
      this.history.close();
      this.history = null;
      return;
    }
    void import('./history-popover.ts').then(({ HistoryPopover }) => {
      const popover = new HistoryPopover(this.editor, this.historyButton);
      const close = popover.close.bind(popover);
      this.history = {
        close: () => {
          close();
          this.history = null;
        },
      };
      popover.close = this.history.close;
    });
  }

  setReadOnly(readOnly: boolean, canShare: boolean): void {
    this.readOnly = readOnly;
    this.viewOnly.hidden = !readOnly;
    this.status.hidden = readOnly;
    this.fileName.readOnly = readOnly;
    this.undoButton.hidden = readOnly;
    this.redoButton.hidden = readOnly;
    this.historyButton.hidden = readOnly;
    this.share.hidden = !canShare;
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Every change is saved at once (as in Figma), so "saving" is the usual
   * state: it is shown only when it lasts (a slow network), otherwise the
   * status stays as it was instead of flickering at each nudge.
   */
  setSaveState(state: SaveState, detail = ''): void {
    if (this.readOnly) return;
    // The real state, whatever is shown (leaving the page asks while changes are unsaved).
    this.status.dataset.actual = state;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if ((state === 'saving' || state === 'unsaved') && this.status.dataset.state !== 'error' && this.status.textContent) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.showSaveState(state, detail);
      }, 1500);
      return;
    }
    this.showSaveState(state, detail);
  }

  private showSaveState(state: SaveState, detail: string): void {
    const text: Record<SaveState, string> = {
      saved: this.cloud ? tr('Сохранено на сервере') : tr('Сохранено на этом устройстве'),
      saving: tr('Сохранение…'),
      unsaved: tr('Есть несохранённые изменения'),
      error: tr('Ошибка сохранения'),
    };
    this.status.textContent = text[state];
    this.status.title = detail || text[state];
    this.status.dataset.state = state;
  }

  private syncFrame = 0;

  private syncSoon(): void {
    if (typeof requestAnimationFrame !== 'function') return this.sync();
    this.syncFrame ||= requestAnimationFrame(() => {
      this.syncFrame = 0;
      this.sync();
    });
  }

  private sync(): void {
    const editor = this.editor;
    // A shape chosen by its shortcut becomes the flyout's button.
    for (const f of this.flyouts) {
      // Scale is the selection tool with a flag: its entry wins while the flag is on.
      const chosen = (editor.scaleMode && f.tools.find((t) => t.id === 'scale')) || f.tools.find((t) => t.id === editor.tool && t.id !== 'scale');
      if (chosen && chosen !== f.current) f.set(chosen);
    }
    const buttons = new Set(this.toolButtons.values());
    for (const b of buttons) {
      const active = [...this.toolButtons].some(([id, btn]) => btn === b && (id === 'scale' ? editor.scaleMode : id === editor.tool && !(id === 'select' && editor.scaleMode)));
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    }
    this.zoomLabel.textContent = `${Math.round(editor.viewport.zoom * 100)}%`;
    if (document.activeElement !== this.fileName) this.fileName.value = editor.doc.get(editor.doc.rootId, 'name');
    this.undoButton.disabled = !editor.doc.canUndo() && !editor.editingText;
    this.redoButton.disabled = !editor.doc.canRedo();
  }
}
