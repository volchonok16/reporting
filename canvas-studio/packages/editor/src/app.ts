// Application shell: lays out the panels and wires keyboard, clipboard,
// persistence and file operations together.

import { brand, plural, tr } from '#core';
import { PrototypePlayer } from './prototype/player.ts';
import { openBlobDialog } from './ui/blob-dialog.ts';
import { openColorKit } from './ui/color-kit-dialog.ts';
import { play, setSoundsEnabled } from './sounds.ts';
import { openWavesDialog } from './ui/waves-dialog.ts';
import { openBackdropDialog } from './ui/backdrop-dialog.ts';
import { openDoodleDialog } from './ui/doodle-dialog.ts';
import { IMAGE_TYPES, isImageFile, pickFiles, pickImageFiles, readImageFile, sliceBigImage, type ImageInput } from './images.ts';
import { DEFAULT_EXPORT, packExports, renderExports } from './exporter.ts';
import { importSvg } from './svg-import.ts';
import { base64ToBytes, colorToHex, Document, deserialize, safeLink, serialize, type Color, type NodeId, type Op } from '#core';
import { applyLayout } from '#layout';
import type { Point } from '#geometry';
import { Canvas2DRenderer, CanvasTextMeasurer, exportSvg, Viewport, layerPicture } from '#render';
import { CanvasView } from './canvas-view.ts';
import { createCommands, type Command } from './commands.ts';
import { layOutMenu, type LaidOut } from './menu-layout.ts';
import { buildDemo } from './demo.ts';
import { Editor, themePageBackground } from './editor.ts';
import { formatShortcut, IS_MAC, isTyping, matches } from './keyboard.ts';
import { Autosaver, newFileId, storage, type Role, type StoredFile } from './storage.ts';
import { CODE_FONT, createBoardDocument, createCodeBlock, guestIdentity, isBoard } from './board.ts';
import { insertLink, linkOfText } from './link-card.ts';
import { createDiagramDocument, isDiagram } from './diagram/model.ts';
import { isDiagramKind } from './diagram/kinds.ts';
import { arrangeSlides, bindOldSlides, buildSlidesExample, createSlidesDocument, isSlides, slideIds, slideInfo } from './slides.ts';
import { SlidesPanel } from './ui/slides-panel.ts';
import { SlideNotesBar } from './ui/slide-notes.ts';
import { openTableDialog, tableMenuItems } from './ui/table-ui.ts';
import { cellPlace, fillCells, insertTable, tableFromClipboard, tableOf } from './tables.ts';
import { buildSlideSection } from './ui/slide-section.ts';
import { DiagramView } from './diagram/view.ts';
import { BoardOptions } from './ui/board-options.ts';
import { IconsPanel } from './ui/icons-panel.ts';
import { ContentPanel } from './ui/content-panel.ts';
import { loadCjkFonts } from './cjk-fonts.ts';
import { padFace, tearOff } from './ui/sticky-pad.ts';
import { FramePresets } from './ui/frame-presets.ts';
import { DeviceMockups } from './ui/device-mockups.ts';
import { BoardSession } from './ui/board-session.ts';

/** A guest's name under their stickies (in this browser); '' — asked, no name. */
const BOARD_NAME_KEY = 'cs.boardName';
import { boardMentions, branches as cloudBranches, cloud, CloudBackend, CloudError, linkOf, localBackend, newCloudId, rememberLink, sharing, type FileBackend } from './cloud.ts';
import type { BranchBar, BranchHost } from './ui/branches.ts';
import { parseClipboard } from './clipboard.ts';
import { attachTouchPinch, attachTouchViewing, isPhone, onPhoneChange } from './ui/touch.ts';
import { LiveSession, type Peer, type Presence } from './live.ts';
import { Comments } from './ui/comments.ts';
import { Emotes } from './ui/emotes.ts';
import { TextMentions } from './ui/text-mentions.ts';
import { FindPanel } from './ui/find-panel.ts';
import { embedGoogleFamilies, embeddedFonts, registerEmbeddedFonts } from './fonts.ts';
import { onFeatureFontsReady, useFeatureFonts } from './font-features.ts';
import { fontsChanged } from './ui/font-picker.ts';
import { prefsChanged } from './prefs.ts';
import { offline } from './offline.ts';
import { CursorChat } from './ui/cursor-chat.ts';
import { Following } from './ui/follow.ts';
import { PeerOverlay } from './ui/peer-overlay.ts';
import { colorPickerHost } from './ui/color-picker.ts';
import { localFilesToUpload, uploadLocalFiles } from './transfer.ts';
import { showAuthScreen } from './ui/auth-screen.ts';
import { isReportingEmbed, requestReportingSsoFromParent, waitForReportingSso } from './reporting-embed.ts';
import { askConfirm, askText, showMessage } from './ui/dialog.ts';
import { ShareDialog } from './ui/share-dialog.ts';
import { fileUrl, Home } from './ui/home.ts';
import { FilesDialog } from './ui/files-dialog.ts';
import { CommandPalette } from './ui/command-palette.ts';
import { ContextMenu, type MenuItem } from './ui/context-menu.ts';
import { boardMenuItems } from './board-actions.ts';
import { textAndPath } from './text-on-path.ts';
import { BoardMinimap } from './ui/board-minimap.ts';
import { download, h } from './ui/dom.ts';
import { AssetsPanel } from './ui/assets-panel.ts';
import { LayersPanel } from './ui/layers-panel.ts';
import { PropertiesPanel } from './ui/properties-panel.ts';
import { selectionCss } from './ui/code-panel.ts';
import { VariablesDialog } from './ui/variables-dialog.ts';
import { Toolbar } from './ui/toolbar.ts';
import { ContextBar } from './ui/context-bar.ts';
import { WorkGlow } from './ui/work-glow.ts';
import { savedContextBar } from './ui/settings-dialog.ts';

/** The file opened last time with a backend (local files saved before the file list used the id "current"). */
function lastFileId(backend: FileBackend): string {
  try {
    return localStorage.getItem(backend.lastFileKey) ?? (backend.kind === 'local' ? 'current' : newFileId());
  } catch {
    return backend.kind === 'local' ? 'current' : newFileId();
  }
}

/** What the editor was asked to open (from the address: ?file=<id> or ?new=1&project=<id>). */
export type EditorRoute = { fileId: string; link?: string | null; page?: string | null; node?: string | null; comment?: string | null } | { create: { projectId: string | null; example?: boolean; board?: boolean; diagram?: boolean; diagramKind?: string | null; slides?: boolean } };

/** Previews are redrawn at most this often while editing (and always on leaving the file). */
const THUMBNAIL_EVERY = 20_000;
/** The offline copy of a server file is written at most this often. */
const OFFLINE_COPY_EVERY = 3000;

/** A copy of a stored file next to it, with "(копия)" in the name (inside the document too). */
async function duplicateIn(backend: FileBackend, id: string): Promise<string | null> {
  const stored = await backend.load(id);
  if (!stored) return null;
  const copyName = tr('{0} (копия)', stored.name);
  const snapshot = JSON.parse(stored.snapshot) as { nodes: { parent: string | null; props: { name?: string } }[] };
  const root = snapshot.nodes.find((n) => n.parent === null);
  if (root) root.props.name = copyName;
  const entry = (await backend.list()).find((f) => f.id === id);
  // Next to the original — unless it is in a team where this person only views: then to Drafts.
  const projectId = entry?.role === 'viewer' || entry?.role === 'commenter' ? null : (entry?.projectId ?? null);
  const copyId = backend.kind === 'cloud' ? newCloudId() : newFileId();
  await backend.save({ ...stored, id: copyId, name: copyName, snapshot: JSON.stringify(snapshot), savedAt: Date.now(), projectId });
  return copyId;
}

/** What an import from Figma brought, shown when the new file opens. */
const IMPORT_NOTE = 'cs.import-note';

/** "Continue without signing in" is remembered, so the sign-in screen does not nag. */
const LOCAL_CHOICE = 'cs.mode';
/** The file browser from inside the app: straight to the files, without the guest's landing page. */
const HOME_URL = '/?local';

/** This address without one query parameter (?login once signed in). */
function withoutParam(name: string): string {
  const url = new URL(location.href);
  url.searchParams.delete(name);
  return url.pathname + url.search.replace(/=(&|$)/g, '$1');
}

/** «Назад» from a sign-in screen opened by its own address: where the person came from, or the site. */
function leaveSignIn(): void {
  const cameFromHere = document.referrer.startsWith(location.origin);
  if (cameFromHere && history.length > 1) history.back();
  else location.assign(withoutParam('login'));
}
/** Commands left to native clipboard events, so pasting needs no permission prompt. */
const NATIVE_CLIPBOARD = new Set(['edit.copy', 'edit.cut', 'edit.paste', 'edit.pasteInPlace']);

/** Where the tool panel stands (bottom, top, left), per browser. */
const DOCK_KEY = 'cs-dock-place';
/** Size of the interface (0.9–1.25), per browser. */
const UI_SCALE_KEY = 'cs-ui-scale';
/** The right panel folded away (only the bar over the selection). */
const RIGHT_KEY = 'cs-right-folded';
/** The hint on how to get the folded panel back was shown. */
const RIGHT_HINT_KEY = 'cs-right-fold-hint';

export class App {
  readonly editor: Editor;
  readonly root: HTMLElement;
  private readonly canvas: CanvasView;
  private readonly toolbar: Toolbar;
  private readonly contextBar: ContextBar;
  private readonly layers: LayersPanel;
  private readonly properties: PropertiesPanel;
  private readonly variables: VariablesDialog;
  private readonly files: FilesDialog;
  /** Where files live: this browser or the server. */
  private readonly backend: FileBackend;
  /** Id of the open file. */
  private fileId: string;
  /** Whether a server is there to sign in to (for the account menu). */
  private readonly serverAvailable: boolean;
  private readonly palette: CommandPalette;
  private readonly toasts: HTMLElement;
  private commands: Command[];
  private readonly commandMap: Map<string, Command>;
  private readonly menu: ContextMenu;
  private boardSession: BoardSession | null = null;
  private minimap: BoardMinimap | null = null;
  private deviceMockups: DeviceMockups | null = null;
  private iconsPanel: IconsPanel | null = null;
  private contentPanel: ContentPanel | null = null;
  private readonly autosaver: Autosaver;
  private readonly measurer: CanvasTextMeasurer;
  private pasteInPlace = false;
  /** Prototype viewer while it is open over the editor. */
  private player: PrototypePlayer | null = null;
  /** Project of a file created from the home screen, sent with its first save. */
  private newFileProject: string | null = null;
  private thumbnailAt = 0;
  /** What this person may do with the open file. */
  private role: Role = 'owner';
  /** Set when the open file is a branch of another (FR-BR-001). */
  private branch: NonNullable<StoredFile['branch']> | null = null;
  private branchBar: BranchBar | null = null;
  private blockedAt = 0;
  /** A phone: viewing only, the canvas moves with the fingers. Follows the window's size. */
  private phone = isPhone();
  private detachTouch: (() => void) | null = null;
  /** The access last applied, re-applied when the window becomes or stops being a phone. */
  private access: Pick<StoredFile, 'role' | 'signedIn'> = { role: 'owner' };
  /** Live editing connection for a server file (others' changes arrive, ours are sent at once). */
  private live: LiveSession | null = null;
  /** Pointers and selections of the others in the file. */
  private readonly peerOverlay: PeerOverlay;
  private readonly emotes: Emotes;
  /** Own pointer in world coordinates (null — off the canvas), sent as presence. */
  private cursor: Presence['cursor'] = null;
  /** The others in the file, and this person as the room sees them (their colour). */
  private others: Peer[] = [];
  private self: Peer | null = null;
  /** Following a collaborator, or showing that everyone follows this person. */
  private readonly following: Following;
  /** Who is in the spotlight now (may be this person). */
  private spotlightBy: string | null = null;
  private readonly chat: CursorChat;
  /** Discussions pinned to the canvas (server files only). */
  private readonly comments: Comments;
  private readonly assets: AssetsPanel;
  /** Changes from an earlier session the server has not confirmed (sent by the live session). */
  private carried: Op[] = [];
  /** "Find and replace" over the canvas (Mod+F). */
  private readonly findPanel: FindPanel;
  /** Own cursor chat message, sent as presence. */
  private chatText: string | null = null;
  /** The open file is a board (FEAT-083): its own tools, no right panel. Fixed for the life of the app. */
  private readonly board: boolean;
  /** The open file is a diagram drawn from text (FEAT-090): its own editor in place of the canvas. */
  private readonly diagramFile: boolean;
  /** A presentation (FEAT-157): a design whose top-level frames are slides. */
  private readonly slidesFile: boolean;
  private slides: SlidesPanel | null = null;
  private slideShow: { close(): void } | null = null;
  private diagram: DiagramView | null = null;

  constructor(root: HTMLElement, doc: Document, backend: FileBackend = localBackend, serverAvailable = false, fileId?: string) {
    this.root = root;
    this.backend = backend;
    this.fileId = fileId ?? lastFileId(backend);
    this.serverAvailable = serverAvailable;
    if (backend instanceof CloudBackend) backend.onConflict = (name) => this.toast(tr('Файл успели изменить в другом окне. Ваша версия сохранена отдельно: «{0}».', name), 'error');
    this.measurer = new CanvasTextMeasurer();
    this.board = isBoard(doc);
    this.diagramFile = isDiagram(doc);
    this.slidesFile = isSlides(doc);
    bindOldSlides(doc);
    this.editor = new Editor(doc, this.measurer);
    // The slides stay in their grid after every edit, in the same undo step.
    if (this.slidesFile) this.editor.editPass = (tx, final) => final && arrangeSlides(this.editor.doc, tx, this.editor.pageId, true);
    if (backend instanceof CloudBackend && backend.user) this.editor.boardPrefs.voter = backend.user.id;
    if (backend instanceof CloudBackend && backend.user) this.editor.boardPrefs.author = backend.user.name || backend.user.email.split('@')[0] || '';
    else if (backend instanceof CloudBackend && this.board) {
      // A guest by a board's link: an animal's name and an id of their own (votes, stickies).
      const guest = guestIdentity();
      this.editor.boardPrefs.author = guest.name;
      this.editor.boardPrefs.voter = guest.id;
    } else {
      try {
        this.editor.boardPrefs.author = localStorage.getItem(BOARD_NAME_KEY) ?? '';
      } catch {
        // no storage: no name
      }
    }
    this.canvas = new CanvasView(this.editor, new Canvas2DRenderer(this.measurer));
    this.setPhone(this.phone);
    onPhoneChange((phone) => {
      if (phone === this.phone) return;
      this.setPhone(phone);
      this.applyAccess(this.access, false);
      if (phone) this.toast(tr('На телефоне файл открыт для просмотра. Править можно на компьютере или планшете.'));
    });
    this.commands = createCommands({
      editor: this.editor,
      openPalette: () => this.palette.open(),
      newFile: () => void this.newFile(),
      openFile: (accept) => this.openFile(accept),
      saveFile: () => this.saveFile(),
      exportSelection: () => void this.exportSelection(),
      toggleUi: (which) => this.toggleUi(which),
      setUiScale: (scale) => {
        this.applyUiScale(scale);
        try {
          localStorage.setItem(UI_SCALE_KEY, String(scale));
          prefsChanged();
        } catch {
          // not remembered
        }
      },
      setDockPlace: (place) => {
        this.toolbar.setDockPlace(place);
        try {
          localStorage.setItem(DOCK_KEY, place);
          prefsChanged();
        } catch {
          // not remembered: the panel goes back to the bottom next time
        }
      },
      // Several layers: one window for all of them (pattern, numbers, find and replace), as in Figma.
      renameSelection: () => (this.editor.selection.length > 1 ? void import('./ui/batch-rename-dialog.ts').then(({ openBatchRename }) => openBatchRename(this.editor)) : this.layers.rename()),
      showAssets: () => this.layers.showTab('assets'),
      openVariables: () => this.variables.open(),
      openFiles: () => void this.files.open(),
      showLayers: () => this.layers.showTab('layers'),
      collapseLayers: () => this.layers.collapseAll(),
      expandLayers: () => this.layers.expandAll(),
      findLayers: () => this.layers.focusSearch(),
      placeImage: () => void this.placeImage(),
      placeBigImage: () => void this.placeBigImage(),
      confirm: () => this.canvas.confirm(),
      copyAs: (format) => void this.copyAs(format),
      importSvg: () => void this.importSvgFiles(),
      importFig: () => this.openFile('.fig,.jam'),
      editLayout: () => void this.editLayoutByDescription(),
      importHtml: (start) => {
        if (this.editor.doc.readOnly) this.toast(tr('Только просмотр: импорт недоступен.'));
        else void import('./html-import/dialog.ts').then(({ HtmlImportDialog }) => HtmlImportDialog.open(this.editor, start));
      },
      openHelp: () => this.openHelp(),
      openSettings: () => this.openSettings(),
      removeBackground: () => void this.removeBackgroundOfSelection(),
      cropImage: () => this.cropSelection(),
      eraseImage: () => this.eraseSelection(),
      showHistory: () => this.toolbar.toggleHistory(),
      findReplace: () => this.findPanel.open(),
      showVersions: () => this.showVersions(),
      showBranches: (create) => this.showBranches(create),
      updateBranch: () => this.updateBranch(),
      mergeBranch: () => void this.mergeIntoMain(),
      editLink: () => void this.editLink(),
      translateText: () => this.translateSelection(),
      openSmart: () => {
        if (!this.editor.doc.readOnly) this.toolbar.toggleSmart();
      },
      findSimilar: () => {
        if (this.editor.selection.length === 0) this.toast(tr('Выделите слой, для которого искать похожие компоненты'));
        else void import('./ui/similar-dialog.ts').then(({ SimilarDialog }) => new SimilarDialog(this.editor, this.canvas.renderer));
      },
      openExample: () => this.openExample(),
      boardNeighbour: () => void this.canvas.addBoardNeighbour(),
      boardName: () => void this.askBoardName(true),
      boardSections: () => this.boardSession?.toggleSections(),
      boardMinimap: () => this.minimap?.toggle(),
      replaceFonts: () => void import('./ui/replace-fonts.ts').then(({ openReplaceFonts }) => openReplaceFonts(this.editor, (m) => this.toast(m))),
      variablesToCode: () => void import('./ui/token-code-dialog.ts').then(({ openTokenCode }) => openTokenCode(this.editor, (m) => this.toast(m))),
      stylesToVariables: () => void import('./ui/styles-to-variables-dialog.ts').then(({ openStylesToVariables }) => openStylesToVariables(this.editor, (m) => this.toast(m), (c) => this.variables.open(undefined, c))),
      toggleComments: () => this.toast(this.comments.togglePins() ? tr('Комментарии показаны на холсте') : tr('Комментарии скрыты. Вернуть — Shift+C')),
      insertLink: async () => {
        if (this.editor.doc.readOnly) return this.toast(tr('Только просмотр: вставка недоступна.'));
        const { askText } = await import('./ui/dialog.ts');
        const raw = await askText({ title: tr('Ссылка на доску'), label: tr('Адрес страницы'), placeholder: 'https://', confirm: tr('Вставить'), maxLength: 2048, empty: tr('Вставьте адрес страницы'), hint: tr('На доске появится карточка с картинкой, заголовком и описанием страницы. Можно и просто вставить ссылку на доску — ⌘V.') });
        if (raw === null) return;
        const link = linkOfText(raw) ?? linkOfText(`https://${raw.trim()}`);
        if (!link) return this.toast(tr('Это не похоже на адрес страницы'));
        await insertLink(this.editor, link, (m) => this.toast(m));
      },
      openStickers: (tab) => {
        const anchor = document.querySelector<HTMLElement>(`.tool-dock button[aria-label^="${tr('Наклейки и компоненты')}"]`) ?? this.canvas.element;
        void import('./ui/board-stickers.ts').then(({ openBoardStickers }) => openBoardStickers(this.editor, anchor, this.assets, tab));
      },
      insertCode: () => {
        const e = this.editor;
        if (e.doc.readOnly) return this.toast(tr('Только просмотр: вставка недоступна.'));
        const id = createCodeBlock(e, e.viewport.screenToWorld({ x: e.screenSize.width / 2, y: e.screenSize.height / 2 }));
        e.setSelection([id]);
        this.canvas.board.editText(id);
        // The monospace font goes into the file once, so everyone sees the code alike (offline — the browser's monospace).
        if (!embeddedFonts(e.doc).some((f) => f.family === CODE_FONT)) void embedGoogleFamilies(e.doc, [CODE_FONT], false).then(() => registerEmbeddedFonts(e.doc));
      },
      openTemplates: () => {
        if (this.editor.doc.readOnly) this.toast(tr('Только просмотр: вставка недоступна.'));
        else if (this.board) void import('./ui/board-templates-dialog.ts').then(({ BoardTemplatesDialog }) => new BoardTemplatesDialog(this.editor));
        else void import('./ui/templates-dialog.ts').then(({ TemplatesDialog }) => new TemplatesDialog(this.editor));
      },
      openDeviceMockups: () => this.deviceMockups?.toggle(),
      openIcons: () => this.iconsPanel?.toggle(),
      openContent: () => this.contentPanel?.toggle(),
      openBlob: () => void openBlobDialog(this.editor),
      openWaves: () => void openWavesDialog(this.editor),
      openBackdrop: () => void openBackdropDialog(this.editor),
      openDoodle: () => void openDoodleDialog(this.editor),
      openTable: () => void openTableDialog(this.editor),
      exportPptx: () => void import('./pptx/dialog.ts').then(({ PptxExportDialog }) => new PptxExportDialog(this.editor, this.canvas.renderer)),
      cancel: () => this.canvas.cancelMode(),
      present: (newTab) => void this.present(null, newTab),
      cursorChat: () => this.openCursorChat(),
      emotes: () => this.emotes.open(),
      spotlight: () => this.toggleSpotlight(),
    }).filter((c) => !c.mode || (!this.diagramFile && c.mode === (this.board ? 'board' : 'design')));
    if (this.diagramFile) {
      // A diagram has no canvas of layers: only what makes sense for it, and its own commands (FEAT-090).
      const keep = new Set(['help.open', 'file.list', 'edit.undo', 'edit.redo', 'file.versions', 'edit.history', 'file.new', 'file.open', 'file.save', 'view.settings', 'view.langRu', 'view.langEn', 'view.toggleUi', 'view.toggleLeft', 'view.toggleRight', 'view.palette']);
      const kept = this.commands.filter((c) => keep.has(c.id) || c.id.startsWith('view.uiScale'));
      const d = () => this.diagram;
      const group = tr('Схема');
      kept.push(
        { id: 'diagram.kind', label: tr('Тип схемы…'), group, keywords: 'вид тип схемы карта блок-схема bpmn гант kind type', run: () => d()?.openKinds() },
        { id: 'diagram.example', label: tr('Вставить пример этого типа'), group, keywords: 'пример example', run: () => void d()?.insertExample() },
        { id: 'diagram.reference', label: tr('Справка: как писать схему этого типа'), group, keywords: 'справочник синтаксис команды help syntax', run: () => this.openHelp() },
        { id: 'diagram.fit', label: tr('Вписать схему в экран'), group, keys: ['Shift+1'], run: () => d()?.fit() },
        { id: 'diagram.png', label: tr('Экспорт схемы: PNG'), group, keywords: 'экспорт картинка export png', run: () => void d()?.exportAs('png') },
        { id: 'diagram.pngClear', label: tr('Экспорт схемы: PNG без фона'), group, keywords: 'экспорт прозрачный export transparent', run: () => void d()?.exportAs('png-clear') },
        { id: 'diagram.svg', label: tr('Экспорт схемы: SVG'), group, keywords: 'экспорт вектор export svg', run: () => void d()?.exportAs('svg') },
        { id: 'diagram.pdf', label: tr('Экспорт схемы: PDF на листе A4'), group, keywords: 'экспорт печать export pdf print', run: () => void d()?.exportAs('pdf') },
        { id: 'diagram.txt', label: tr('Экспорт схемы: текст (.txt)'), group, keywords: 'экспорт текст промпт export text prompt', run: () => void d()?.exportAs('txt') },
        { id: 'diagram.copy', label: tr('Копировать схему для макета'), group, keywords: 'копировать макет слои copy design layers', run: () => void d()?.copyForDesign() },
      );
      this.commands = kept;
    }
    if (this.slidesFile) {
      // A presentation: everything a design has, and its own commands (FEAT-157).
      const sl = () => this.slides;
      const group = tr('Презентация');
      // ⌘⌥Enter is the show here, not the prototype viewer.
      this.commands = this.commands.map((c) => (c.id === 'prototype.present' ? { ...c, keys: undefined } : c));
      this.commands.push(
        { id: 'slides.present', label: tr('Показ презентации с текущего слайда'), group, keys: ['Mod+Alt+Enter'], keywords: 'показ презентация present slideshow', run: () => this.presentSlides(sl()?.currentSlide() ?? null) },
        { id: 'slides.presentStart', label: tr('Показ презентации с начала'), group, keywords: 'показ сначала present start', run: () => this.presentSlides(null) },
        { id: 'slides.new', label: tr('Новый слайд: заголовок и текст'), group, keywords: 'слайд добавить new slide', run: () => sl()?.addSlide('titleText') },
        { id: 'slides.next', label: tr('Следующий слайд'), group, keys: ['PageDown'], run: () => sl()?.next(1) },
        { id: 'slides.prev', label: tr('Предыдущий слайд'), group, keys: ['PageUp'], run: () => sl()?.next(-1) },
        { id: 'slides.pdf', label: tr('Экспорт презентации: PDF'), group, keywords: 'экспорт pdf печать export', run: () => void this.exportSlidesPdf() },
        { id: 'slides.pptx', label: tr('Экспорт презентации: PowerPoint (PPTX)…'), group, keywords: 'экспорт powerpoint pptx keynote export', run: () => void import('./pptx/dialog.ts').then(({ PptxExportDialog }) => new PptxExportDialog(this.editor, this.canvas.renderer)) },
        { id: 'slides.import', label: tr('Импорт PowerPoint (PPTX): слайды после текущего…'), group, keywords: 'импорт powerpoint pptx keynote import', run: () => this.openFile('.pptx') },
        { id: 'slides.grid', label: tr('Слайды: все на одном полотне'), group, keywords: 'сетка все слайды полотно обзор grid view', run: () => sl()?.setView('grid') },
        { id: 'slides.single', label: tr('Слайды: по одному'), group, keywords: 'один слайд single view', run: () => sl()?.setView('slide') },
      );
    }
    // Image fills decode asynchronously; redraw once they are ready.
    this.canvas.renderer.images.onLoad = () => this.canvas.refreshAll();
    this.commandMap = new Map(this.commands.map((c) => [c.id, c]));
    this.palette = new CommandPalette(this.editor, this.commands);
    this.toolbar = new Toolbar(this.editor, this.commandMap, () => this.palette.open(), this.board);
    this.comments = new Comments(this.editor, {
      fileId: () => (this.backend instanceof CloudBackend ? this.fileId : null),
      role: () => this.role,
      userId: () => (this.backend instanceof CloudBackend ? (this.backend.user?.id ?? null) : null),
      toast: (text, kind) => this.toast(text, kind),
    });
    this.canvas.onComment = (world) => this.comments.startAt(world);
    // «@» in board texts and stickers: the people of the file, a letter to the one called.
    this.canvas.mentions = new TextMentions(this.editor, this.canvas.textInput, {
      people: () => (this.backend instanceof CloudBackend && this.backend.user && this.editor.isBoardFile() ? this.comments.loadPeople() : Promise.resolve([])),
      userId: () => (this.backend instanceof CloudBackend ? (this.backend.user?.id ?? null) : null),
      mentioned: (person, object, text) => {
        const fileId = this.backend instanceof CloudBackend ? this.fileId : null;
        if (!fileId) return;
        void boardMentions.notify(fileId, person.id, object, text).then(
          (r) => r.sent && this.toast(tr('{0} получит письмо об упоминании', person.name)),
          () => this.toast(tr('Письмо об упоминании не отправилось'), 'error'),
        );
      },
    });
    this.assets = new AssetsPanel(this.editor, this.canvas.renderer, {
        fileId: () => (this.backend instanceof CloudBackend ? this.fileId : null),
        canEdit: () => this.role === 'owner' || this.role === 'editor',
      });
    if (this.slidesFile) {
      this.slides = new SlidesPanel(this.editor, this.measurer);
      this.slides.onPresent = (from) => this.presentSlides(from);
      this.slides.onExport = (format) => this.commandMap.get(format === 'pdf' ? 'slides.pdf' : 'slides.pptx')?.run();
      this.slides.onImport = () => this.openFile('.pptx');
      this.slides.setPhone(this.phone);
    }
    this.layers = new LayersPanel(this.editor, this.assets, { el: this.comments.panel, setVisible: (v) => this.comments.setPanelVisible(v) }, this.slides ?? undefined);
    this.properties = new PropertiesPanel(this.editor, this.canvas);
    if (this.slides) {
      const slides = this.slides;
      this.properties.slideSection = (section, ids) => {
        const slide = ids.length ? slides.slideOf(ids[0]!) : null;
        if (!slide || ids.some((id) => slides.slideOf(id) !== slide)) return;
        // At once, not loaded later: the section stands right under the header.
        buildSlideSection(this.editor, section, slide, () => this.presentSlides(slide));
      };
    }
    this.variables = new VariablesDialog(this.editor);
    this.files = new FilesDialog({
      currentId: () => this.fileId,
      list: () => this.backend.list(),
      open: (id) => this.openStored(id),
      create: () => this.newFile(),
      createsBoard: this.board,
      createsDiagram: this.diagramFile,
      importFromDisk: () => this.openFile(),
      rename: (id, name) => this.renameStored(id, name),
      duplicate: (id) => this.duplicateStored(id),
      remove: (id) => this.removeStored(id),
      cloud: backend.kind === 'cloud',
      localCount: async () => (await localFilesToUpload(backend)).length,
      uploadLocal: async () => {
        const result = await uploadLocalFiles(backend);
        for (const e of result.errors) this.toast(e, 'error');
        this.toast(result.done > 0 ? tr('Перенесено на сервер: {0}. В браузере они тоже остались.', result.done) : tr('В этом браузере нет файлов для переноса.'));
      },
    });
    this.toolbar.onFiles = () => void this.files.open();
    this.toolbar.onHome = () => void this.goHome();
    this.toolbar.onShare = () => void this.openShare();
    this.toolbar.onHelp = () => this.commandMap.get('help.open')?.run();
    // "?" buttons anywhere in the interface ask for an article by id.
    window.addEventListener('cs-help', (e) => this.openHelp((e as CustomEvent<string>).detail));
    this.toolbar.onMainMenu = (x, y) => this.menu.open(x, y, this.mainMenu());
    this.applyAccess({ role: 'owner' }, false);
    this.toolbar.cloud = backend.kind === 'cloud';
    this.toolbar.setAccount(backend instanceof CloudBackend ? backend.user : null);
    this.toolbar.onAccount = (x, y) => this.openAccountMenu(x, y);
    // Rulers, grids and snapping are this user's preferences (kept between sessions).
    try {
      const saved = JSON.parse(localStorage.getItem('cs.view') ?? 'null') as Partial<typeof this.editor.view> | null;
      // Outline view is switched on for a while, not for good (as in Figma); its options stay.
      if (saved) this.editor.view = { ...this.editor.view, ...saved, outlines: false };
    } catch {
      // storage unavailable: defaults
    }
    // «Масштаб» does nothing visible by itself: say what it is for when it is turned on.
    let scaling = false;
    this.editor.events.on('tool', () => {
      if (this.editor.scaleMode && !scaling) {
        this.toast(
          this.editor.selection.length
            ? tr('Масштаб (K): тяните за угол рамки — слой увеличится целиком: размер текста, толщина обводок, скругления и тени меняются вместе с ним. Точное «во сколько раз» — справа, в разделе «Масштаб». Esc или V — обычное перемещение.')
            : tr('Масштаб (K): выделите слой и тяните за угол рамки — он увеличится целиком, вместе с размером текста, толщиной обводок, скруглениями и тенями. Обычное растягивание меняет только ширину и высоту. Esc или V — обычное перемещение.'),
          'info',
          9000,
        );
      }
      scaling = this.editor.scaleMode;
    });
    this.root.classList.toggle('property-labels', this.editor.view.propertyLabels);
    setSoundsEnabled(this.editor.view.sounds);
    this.editor.events.on('view', (view) => {
      this.root.classList.toggle('property-labels', view.propertyLabels);
      setSoundsEnabled(view.sounds);
      try {
        localStorage.setItem('cs.view', JSON.stringify(view));
        prefsChanged();
      } catch {
        // ignore
      }
    });
    this.properties.openVariables = (variable) => this.variables.open(variable);
    this.properties.present = (start, newTab) => void this.present(start, newTab);
    this.properties.cropImage = (id, index) => this.cropImage(id, index);
    this.properties.eraseImage = (id, index) => this.eraseImage(id, index);
    this.properties.removeImageBackground = (id, index) => this.removeImageBackground(id, index);
    this.properties.editLink = () => void this.editLink();
    this.canvas.onLink = () => void this.editLink();
    this.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });

    this.menu = new ContextMenu(document.body);
    this.canvas.onMenu = (x, y, hits) => this.menu.open(x, y, this.menuItems(x, y, hits));
    this.layers.onMenu = (x, y) => this.menu.open(x, y, this.menuItems(x, y, null));
    this.layers.onPageMenu = (x, y, items) => this.menu.open(x, y, items);

    root.classList.add('app');
    // Colour pickers: the eyedropper takes a colour from the canvas; swatches show the file's colours.
    colorPickerHost.pick = (done) => {
      if (this.editor.doc.readOnly) return;
      this.editor.pickColorFor = done;
      this.editor.setTool('eyedropper');
      this.toast(tr('Щёлкните по холсту, чтобы взять цвет. Esc — отмена.'));
    };
    colorPickerHost.documentColors = () => documentColors(this.editor.doc);
    colorPickerHost.openKit = (color, done) => openColorKit(this.editor, { color, onPick: done });
    this.peerOverlay = new PeerOverlay(this.editor);
    this.chat = new CursorChat();
    this.emotes = new Emotes(this.editor, {
      send: (emote) => this.live?.sendEmote(emote) ?? false,
      self: () => this.live?.self ?? null,
      peers: () => this.others,
      presenceOf: (id) => this.peerOverlay.presenceOf(id),
      cursor: () => this.cursor,
      selfName: () => this.self?.name ?? '',
      selfColor: () => this.self?.color ?? '#4f5bd5',
      toast: (text) => this.toast(text),
    });
    this.canvas.element.append(this.peerOverlay.el, this.chat.el, this.emotes.el);
    this.comments.attach(this.canvas.element);
    this.following = new Following(this.editor, this.canvas.element);
    this.following.onChange = (id) => this.toolbar.setPeers(this.others, id);
    this.following.onStopSpotlight = () => this.toggleSpotlight();
    this.toolbar.onPeer = (id) => {
      const peer = this.others.find((p) => p.id === id);
      if (!peer || this.following.following === id) this.following.stop();
      else this.following.follow(peer, this.peerOverlay.presenceOf(id));
    };
    this.bindPresence();
    this.findPanel = new FindPanel(this.editor);
    this.contextBar = new ContextBar(this.editor, this.canvas, this.commandMap, {
      toggleRight: () => this.foldRight(!this.root.classList.contains('hide-right')),
      rightHidden: () => this.root.classList.contains('hide-right'),
      openSmart: () => this.toolbar.toggleSmart(),
    });
    this.contextBar.mode = savedContextBar();
    // A board has no panel of properties: the bar over the selection is the way to change things.
    if (this.board) {
      this.contextBar.mode = 'always';
      this.contextBar.boardMode = true;
    }
    this.properties.onFold = () => this.foldRight(true);
    this.toolbar.onShowRight = () => this.foldRight(false);
    // Code layers build their layers from their code again when this person changes it.
    void import('./code-layer.ts').then(({ watchCodeLayers }) => watchCodeLayers(this.editor));
    // A narrow window has no room for the layers panel: it opens over the canvas, and a touch on the canvas closes it.
    this.toolbar.onShowLeft = () => {
      if (window.matchMedia('(max-width: 900px)').matches) this.root.classList.toggle('left-open');
      else this.root.classList.remove('hide-left');
    };
    this.canvas.element.addEventListener('pointerdown', () => this.root.classList.remove('left-open'));
    const workGlow = new WorkGlow(this.editor, this.canvas.element);
    const canvasArea = h('main', { class: 'canvas-area' }, this.canvas.element, workGlow.el, this.following.el, this.findPanel.el, this.toolbar.dock, this.contextBar.el);
    if (this.slides) {
      // Speaker's notes under the slide (FEAT-166).
      const slides = this.slides;
      const notes = new SlideNotesBar(this.editor, canvasArea, () => slides.currentSlide());
      canvasArea.append(notes.el);
      slides.onStage = (single) => {
        notes.setShown(single);
        // Nothing selected: the right panel shows the slide on show, which has just changed.
        if (this.editor.selection.length === 0) this.properties?.update();
      };
      notes.setShown(slides.singleView);
    }
    // Ready frame sizes while the Frame tool is on (a design's tool).
    if (!this.board) {
      canvasArea.append(new FramePresets(this.editor, this.toolbar.dock).el);
      this.deviceMockups = new DeviceMockups(this.editor, this.toolbar.dock);
      canvasArea.append(this.deviceMockups.el);
      this.iconsPanel = new IconsPanel(this.editor, this.toolbar.dock);
      canvasArea.append(this.iconsPanel.el);
      this.canvas.onIconDrop = (id, world) => this.iconsPanel?.drop(id, world) ?? false;
      this.contentPanel = new ContentPanel(this.editor, this.toolbar.dock);
      canvasArea.append(this.contentPanel.el);
      this.canvas.onContentDrop = (id, world) => this.contentPanel?.drop(id, world) ?? false;
    }
    // Colour and width of the marker or the pencil, size of the eraser…: next to the tool panel while the tool is on.
    const options = new BoardOptions(this.editor, this.toolbar.dock);
    canvasArea.append(options.el);
    if (this.board) {
      // The sticky button is a pad: stickies are torn off it onto the board, as in Miro.
      const pad = { editor: this.editor, canvas: () => this.canvas.element, edit: (id: string) => this.canvas.board.editText(id) };
      options.pad = pad;
      const stickyButton = this.toolbar.toolButton('sticky');
      if (stickyButton) {
        const face = () => stickyButton.replaceChildren(padFace(this.editor.boardPrefs.stickyColor));
        face();
        options.onStickyColor = face;
        tearOff(stickyButton, pad, () => this.editor.boardPrefs.stickyColor);
        stickyButton.title = tr('Стикер (S) — щёлкните или вытяните стикер из стопки на доску');
      }
      // A guest is asked once how to sign their stickies.
      this.canvas.board.beforeSticky = () => this.askBoardName(false);
      // The shared timer and the vote, in the top bar.
      const session = new BoardSession(this.editor, (text) => this.toast(text));
      this.boardSession = session;
      session.show = (id) => {
        if (!this.editor.doc.store.isAlive(id)) return;
        const page = this.editor.doc.pageOf(id);
        if (page && page !== this.editor.pageId) this.editor.setPage(page);
        this.editor.setSelection([id]);
        this.editor.zoomToSelection();
      };
      this.toolbar.addControls(session.el);
      // The whole board small in the corner (folded to a button until opened).
      this.minimap = new BoardMinimap(this.editor);
      this.canvas.element.parentElement?.append(this.minimap.el);
    }
    try {
      this.applyUiScale(Number(localStorage.getItem(UI_SCALE_KEY)) || 1);
      const place = localStorage.getItem(DOCK_KEY);
      if (place === 'top' || place === 'left') this.toolbar.setDockPlace(place);
      if (localStorage.getItem(RIGHT_KEY) === '1') root.classList.add('hide-right');
    } catch {
      // the default place
    }
    if (this.board) root.classList.add('board-mode', 'hide-right', 'hide-left');
    // The key colour of the kind of file (styles.css, data-kind).
    document.documentElement.dataset.kind = this.board ? 'board' : this.diagramFile ? 'diagram' : this.slidesFile ? 'slides' : 'design';
    root.querySelector('.boot')?.remove();
    root.append(this.toolbar.el, this.layers.el, canvasArea, this.properties.el, this.palette.el, this.toasts);
    if (this.diagramFile) {
      // A diagram: its text on the left, the picture over the canvas, the look on the right (FEAT-090).
      const diagram = new DiagramView(this.editor, {
        toast: (message, kind) => this.toast(message, kind),
        fileName: () => this.editor.doc.get(this.editor.doc.rootId, 'name'),
        toggleText: () => this.toggleUi('left'),
        textHidden: () => this.root.classList.contains('hide-left'),
      });
      this.diagram = diagram;
      root.classList.add('diagram-mode');
      root.classList.remove('hide-right', 'hide-left');
      canvasArea.append(diagram.stage);
      root.append(diagram.source, diagram.panel);
      // DocPlan's manual layout asks its page to save and to draw again after a drag.
      Object.assign(window, { saveState: () => diagram.saveOffsets(), generateMindmap: () => diagram.rerender() });
    }
    this.bindPanelResizers(canvasArea);

    this.autosaver = new Autosaver(() => this.persist());
    // A whole snapshot of a big file takes a moment: not while something is being dragged.
    this.autosaver.ready = () => !this.canvas.busy;
    // With a live connection the connection reports the state, not the autosaver.
    this.autosaver.onState = (state, detail) => {
      if (!this.live) this.toolbar.setSaveState(state, detail);
    };
    this.toolbar.setSaveState('saved');
    this.editor.events.on('change', ({ source }) => {
      if (source !== 'load') this.autosaver.schedule();
    });
    this.editor.events.on('toast', ({ message, kind }) => this.toast(message, kind));
    this.editor.events.on('page', () => this.autosaver.schedule());

    this.bindKeyboard();
    this.bindClipboard();
    this.bindFileDrop();
    window.addEventListener('beforeunload', (e) => {
      void this.autosaver.flush();
      if (this.toolbar.el.querySelector('.save-status')?.getAttribute('data-actual') === 'unsaved' || this.live?.pending) e.preventDefault();
    });
    // The preview on the home screen follows the last edits even when the tab is closed right after them.
    let previewStale = false;
    this.editor.events.on('change', ({ source }) => {
      if (source !== 'remote' && source !== 'load') previewStale = true;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      void this.autosaver.flush();
      if (previewStale) {
        previewStale = false;
        void this.updateThumbnail(true);
      }
    });

    // Web fonts change text metrics: re-measure once they are loaded.
    document.fonts?.ready.then(() => this.remeasureText()).catch(() => undefined);
    // Fonts kept in the file: registered when it opens and whenever someone adds one.
    let fontList: unknown = null;
    const fonts = () => {
      const list = this.editor.doc.get(this.editor.doc.rootId, 'embeddedFonts');
      if (list === fontList) return;
      fontList = list;
      void registerEmbeddedFonts(this.editor.doc).then((added) => {
        if (!added.length) return;
        fontsChanged(added);
        this.remeasureText();
      });
    };
    fonts();
    this.editor.events.on('change', fonts);
    this.editor.events.on('document', fonts);
    // Chinese, Japanese and Korean texts: Noto Sans of their script, loaded when a text needs it.
    const cjk = () =>
      loadCjkFonts(this.editor.doc, (added) => {
        fontsChanged(added);
        this.remeasureText();
      });
    cjk();
    this.editor.events.on('document', cjk);
    let cjkTimer: ReturnType<typeof setTimeout> | null = null;
    this.editor.events.on('change', ({ changes }) => {
      if (cjkTimer || (changes.created.size === 0 && ![...changes.updated.values()].some((k) => k.has('characters')))) return;
      cjkTimer = setTimeout(() => {
        cjkTimer = null;
        cjk();
      }, 600);
    });
    // OpenType features and axes of texts: a font copy with them, re-measured when it is ready (once a frame).
    useFeatureFonts(this.editor.doc);
    this.editor.events.on('document', () => useFeatureFonts(this.editor.doc));
    let remeasure = 0;
    onFeatureFontsReady(() => {
      if (remeasure) return;
      remeasure = requestAnimationFrame(() => {
        remeasure = 0;
        this.remeasureText();
      });
    });
    this.canvas.focus();
  }

  /**
   * Opens the editor for a file from the address (?file=<id>), or makes a new
   * one (?new=1[&project=<id>]). The very first launch gets the demo file.
   */
  static async start(root: HTMLElement, route: EditorRoute): Promise<App | null> {
    // Read before the address is rewritten to the file's own (setFileId).
    const mergeId = new URLSearchParams(location.search).get('merge');
    // Bundled fonts must be ready before the first layout, or text is measured with a fallback (BUG-017).
    await loadBundledFonts();
    if ('fileId' in route && route.link) rememberLink(route.fileId, route.link);
    // A share link opens the file even without an account (for viewing).
    // A visitor without an account sees the landing page first, on a file address too (unless it is a share link).
    const choice = 'fileId' in route && route.link ? await App.linkBackend(root) : await App.chooseBackend(root, new URLSearchParams(location.search).has('login') ? 'login' : 'file');
    const backend = choice.backend;
    if ('create' in route) {
      // The tour only when asked for ("Open the example", "Try without signing up"): «Новый файл» is a new empty file,
      // even the very first one (it used to open the example, which is not what the button says).
      const example = !!route.create.example;
      const id = backend.kind === 'cloud' ? newCloudId() : newFileId();
      // Each kind has its example (29 October): a design tour, a filled board, a deck, a mind map.
      const kind = route.create.slides ? 'slides' : route.create.diagram ? 'diagram' : route.create.board ? 'board' : 'design';
      const created =
        kind === 'slides'
          ? createSlidesDocument(example ? tr('Пример: презентация') : tr('Без названия'))
          : kind === 'diagram'
            ? createDiagramDocument(example ? tr('Пример: схема') : tr('Без названия'), example ? 'classic' : route.create.diagramKind && isDiagramKind(route.create.diagramKind) ? route.create.diagramKind : undefined)
            : kind === 'board'
              ? createBoardDocument(example ? tr('Пример: доска') : tr('Без названия'))
              : Document.createEmpty(example ? tr('Пример: {0}', brand()) : tr('Без названия'), undefined, { backgroundColor: themePageBackground() });
      const app = new App(root, created, backend, choice.server, id);
      app.newFileProject = route.create.projectId;
      // A diagram's example is its kind's own text, shown until edited: nothing to build.
      if (example && kind !== 'diagram') {
        // On a phone the file is already read-only here, which would undo every step of the tour (BUG-087).
        const readOnly = app.editor.doc.readOnly;
        app.editor.doc.readOnly = false;
        if (kind === 'slides') buildSlidesExample(app.editor);
        else if (kind === 'board') {
          const { boardExample, insertBoardTemplate } = await import('./board-templates.ts');
          insertBoardTemplate(app.editor, boardExample());
        }
        else buildDemo(app.editor);
        app.editor.doc.readOnly = readOnly;
      }
      // A new board offers a template (or an empty board) first, as FigJam does.
      if (route.create.board && !example) setTimeout(() => void import('./ui/board-templates-dialog.ts').then(({ BoardTemplatesDialog }) => new BoardTemplatesDialog(app.editor, { fresh: true })), 350);
      app.setFileId(id);
      // After the canvas has taken its size (its first fit would undo this).
      setTimeout(() => {
        // The example opens on its app screens, large; any other new file — fitted.
        const d = app.editor.doc;
        const screens = example ? d.children(app.editor.pageId).filter((n) => d.type(n) === 'FRAME' && d.get(n, 'height') === 844) : [];
        if (screens.length) {
          app.editor.setSelection(screens);
          app.editor.zoomToSelection();
          app.editor.setSelection([]);
        } else if (app.slides) app.slides.restoreView();
        else app.editor.zoomToFit();
      }, 300);
      // Saved once even where it opens read-only (a phone), or a reload of its address finds no file (BUG-151).
      const readOnly = app.editor.doc.readOnly;
      app.editor.doc.readOnly = false;
      await app.autosaver.flush();
      app.editor.doc.readOnly = readOnly;
      app.startLive();
      return app;
    }
    let stored: StoredFile | undefined;
    let problem =
      backend.kind === 'local'
        ? tr('Файла нет в этом браузере. Если он на сервере или вам открыли к нему доступ — войдите.')
        : tr('Файл не найден: его удалили, доступ закрыли или ссылка устарела.');
    for (;;) {
      try {
        stored = await backend.load(route.fileId);
        break;
      } catch (error) {
        if (!(error instanceof CloudError && error.code === 'link_password')) {
          problem = tr('Не удалось открыть файл: {0}', error instanceof Error ? error.message : String(error));
          break;
        }
        // A protected link: ask for the password in our own dialog, then try again.
        const password = await askText({ title: tr('Файл защищён паролем'), label: tr('Пароль'), password: true, confirm: tr('Открыть'), empty: tr('Введите пароль'), hint: tr('Пароль сообщает тот, кто прислал ссылку.') });
        if (password === null) {
          problem = tr('Файл защищён паролем. Чтобы открыть его, нужен пароль от того, кто прислал ссылку.');
          break;
        }
        try {
          await sharing.unlock(route.fileId, password);
        } catch (e) {
          await showMessage({ title: tr('Неверный пароль'), message: e instanceof Error ? e.message : String(e), confirm: tr('Попробовать ещё раз') });
        }
      }
    }
    let doc: Document | null = null;
    try {
      if (stored) doc = deserialize(stored.snapshot);
    } catch (error) {
      problem = tr('Файл повреждён: {0}', error instanceof Error ? error.message : String(error));
    }
    if (!stored || !doc) {
      const signedOut = backend.kind === 'local' || (backend instanceof CloudBackend && !backend.user);
      const signIn = signedOut && choice.server ? h('button', { class: 'text-button', type: 'button', onclick: () => App.openSignIn() }, tr('Войти')) : '';
      root.replaceChildren(h('div', { class: 'home-missing' }, h('p', {}, problem), h('div', { class: 'home-missing-actions' }, signIn, h('a', { class: 'text-button primary', href: HOME_URL }, tr('К файлам')))));
      return null;
    }
    const app = new App(root, doc, backend, choice.server, route.fileId);
    app.setFileId(route.fileId);
    app.applyAccess(stored);
    app.setBranch(stored.branch ?? null);
    // Opened from a branch with «Слить в основной»: the merge window over this (main) file.
    if (mergeId) {
      void import('./ui/branches.ts').then((m) => m.mergeBranch(app.branchHost(), mergeId));
    }
    // Changes made without a network last time: back in the document, and sent when connected.
    if (stored.pending?.length && !doc.readOnly) {
      app.carried = stored.pending as Op[];
      doc.applyRemote(app.carried);
    }
    if (stored.offline) app.toast(tr('Нет связи с сервером — открыта копия из этого браузера. Правки сохраняются и отправятся, когда связь вернётся.'));
    try {
      const note = sessionStorage.getItem(IMPORT_NOTE);
      if (note) {
        sessionStorage.removeItem(IMPORT_NOTE);
        app.toast(note, 'info', 12000);
      }
    } catch {
      // no storage: no note
    }
    const node = route.node && app.editor.doc.store.isAlive(route.node) ? route.node : null;
    const page = node ? app.editor.doc.pageOf(node) : route.page && app.editor.doc.store.isAlive(route.page) ? route.page : null;
    if (page) app.editor.setPage(page);
    else if (stored.pageId && app.editor.doc.store.has(stored.pageId)) app.editor.setPage(stored.pageId);
    if (node) {
      // A link to a layer (FR-ACL-013): select it and fit it in view.
      app.editor.setSelection([node]);
      requestAnimationFrame(() => app.editor.zoomToSelection());
    } else if (app.slides) {
      // A presentation opens in its remembered view: in «Слайд» the first slide fitted (BUG-133).
      // A phone's free canvas does not hold to the slide: after the canvas's first fit, or that would undo it.
      const slides = app.slides;
      if (app.phone) setTimeout(() => slides.restoreView(), 300);
      else requestAnimationFrame(() => slides.restoreView());
    } else if (stored.viewport && !page) {
      app.editor.viewport.restore(stored.viewport);
      app.editor.requestViewport();
    } else requestAnimationFrame(() => app.editor.zoomToFit());
    // A link from a letter about a comment: open that discussion.
    if (route.comment) app.comments.showWhenLoaded(route.comment);
    app.startLive();
    // A preview for the file browser, once images and fonts have had a moment to load.
    setTimeout(() => void app.updateThumbnail(true), 1500);
    return app;
  }

  /** The home screen: sections, projects and files (the start page of the app). */
  static async home(root: HTMLElement): Promise<Home> {
    // "?local" — the files of this browser, straight (from the landing page); "?welcome" — the landing page even for those who work without an account.
    const params = new URLSearchParams(location.search);
    const choice = await App.chooseBackend(root, params.has('login') ? 'login' : params.has('local') ? false : params.has('welcome') ? 'welcome' : 'home');
    // ?local stays in the address: reloading the file list must not bring the landing page back.
    if (params.has('welcome')) history.replaceState(null, '', '/');
    const backend = choice.backend;
    const home = new Home(root, {
      backend,
      user: backend instanceof CloudBackend ? backend.user : null,
      serverAvailable: choice.server,
      signIn: () => App.openSignIn(),
      signOut: () => {
        void cloud.logout().catch(() => undefined).then(() => location.reload());
      },
      duplicate: async (id) => {
        await duplicateIn(backend, id);
      },
      importFromDisk: () => {
        void pickFiles('.json,.csdoc,.fig,.jam,.pptx,application/json').then(async ([file]) => {
          if (!file) return;
          try {
            let doc: Document;
            const fig = await import('./fig/import.ts');
            if (/\.pptx$/i.test(file.name)) {
              // PowerPoint becomes a presentation (FEAT-158).
              home.toast(tr('Импортирую «{0}»…', file.name), 60_000);
              const { pptxToDocument } = await import('./pptx/import-run.ts');
              const result = await pptxToDocument(file, new CanvasTextMeasurer());
              doc = result.doc;
              try {
                sessionStorage.setItem(IMPORT_NOTE, result.note);
              } catch {
                // the note is a courtesy
              }
            } else if (await fig.isFigFile(file)) {
              // Reading a big .fig takes seconds: say it is going on.
              home.toast(tr('Импортирую «{0}»…', file.name), 60_000);
              const result = await fig.importFig(file);
              doc = result.doc;
              // Told in the editor, once the file is open.
              try {
                sessionStorage.setItem(IMPORT_NOTE, result.note);
              } catch {
                // the note is a courtesy
              }
            } else doc = deserialize(await file.text());
            const id = backend.kind === 'cloud' ? newCloudId() : newFileId();
            await backend.save({ id, name: doc.get(doc.rootId, 'name'), snapshot: serialize(doc), savedAt: Date.now() });
            location.assign(fileUrl(id));
          } catch (error) {
            home.clearToasts();
            await showMessage({ title: tr('Не удалось открыть файл'), message: error instanceof Error ? error.message : String(error) });
          }
        });
      },
    });
    await home.reload();
    return home;
  }

  // ---------- prototype ----------

  /** All slides shown in the show (not the skipped ones) as one vector PDF, a page a slide. */
  private async exportSlidesPdf(): Promise<void> {
    const d = this.editor.doc;
    const ids = slideIds(d, this.editor.pageId).filter((id) => !slideInfo(d, id).skip);
    if (!ids.length) return this.toast(tr('Слайдов нет: нечего экспортировать.'));
    this.toast(tr('Собираю PDF…'));
    const { exportVectorPdf } = await import('#render');
    const blob = await exportVectorPdf(this.canvas.renderer, this.editor.scene, this.measurer, ids, 2);
    download(blob, `${d.get(d.rootId, 'name') || tr('Презентация')}.pdf`);
    play('export');
  }

  /** The show of a presentation from a slide (the first when null). */
  presentSlides(from: NodeId | null): void {
    if (this.player) return;
    void import('./ui/slide-show.ts').then(({ SlideShow }) => {
      const show = new SlideShow({ doc: this.editor.doc, pageId: this.editor.pageId, start: from, measurer: this.measurer, onClose: (last) => {
        this.slideShow = null;
        if (last) this.slides?.show(last);
        this.canvas.focus();
      } });
      this.slideShow = show;
    });
  }

  /**
   * Opens the prototype viewer (FR-PRT-050) at `start` or where presenting
   * starts by default. A new tab reads the file from this browser's storage,
   * so the file is saved first.
   */
  async present(start: NodeId | null, newTab = false): Promise<void> {
    const editor = this.editor;
    const screen = start ?? editor.prototype.startScreen();
    if (!screen) {
      editor.toast(tr('На странице нет фреймов: нечего показывать. Нарисуйте фрейм (F) — это будет экран.'));
      return;
    }
    if (newTab) {
      await this.autosaver.flush();
      const url = new URL(location.href);
      url.search = new URLSearchParams({ present: this.fileId, page: editor.pageId, start: screen, src: this.backend.kind }).toString();
      window.open(url.href, '_blank', 'noopener');
      return;
    }
    if (this.player) return;
    this.palette.close?.();
    this.player = new PrototypePlayer({
      doc: editor.doc,
      pageId: editor.pageId,
      start: screen,
      measurer: this.measurer,
      onClose: () => {
        this.player = null;
        this.canvas.focus();
      },
    });
    document.body.append(this.player.el);
  }

  /**
   * Where files live (stage "Server"): signed in → the server; a server but
   * nobody signed in → the sign-in screen (or this browser, if chosen before);
   * no server at all → this browser, as always.
   */
  private static async chooseBackend(root: HTMLElement, landing: 'home' | 'file' | 'welcome' | 'login' | false = false): Promise<{ backend: FileBackend; server: boolean }> {
    const probe = await cloud.probe();
    if (probe.state === 'no-server') return { backend: localBackend, server: false };
    if (probe.state === 'signed-in') {
      // The logo of the file browser (/?welcome) shows the landing page to the signed in too, with «Мои файлы» on it.
      if (landing === 'welcome') {
        const { showLanding } = await import('./ui/landing.ts');
        const choice = await showLanding(root, { signedIn: true });
        if (choice === 'new' || choice === 'newBoard' || choice === 'newDiagram' || choice === 'newSlides') {
          location.assign(choice === 'newBoard' ? '/?new=1&board=1' : choice === 'newDiagram' ? '/?new=1&diagram=1' : choice === 'newSlides' ? '/?new=1&slides=1' : '/?new=1');
          await new Promise(() => undefined);
        }
        history.replaceState(null, '', '/');
      }
      return { backend: new CloudBackend(probe.user), server: true };
    }
    let local = false;
    try {
      local = localStorage.getItem(LOCAL_CHOICE) === 'local';
    } catch {
      local = false;
    }
    // Who chose "without an account" works in this browser from then on: files and the way
    // back to them from the editor (/?local) open straight, not the landing page (BUG-044).
    // The site's own address still shows the landing page to a guest, with «Мои файлы в этом
    // браузере» on it (BUG-048: the remembered choice hid the landing page for good).
    // ?login (a «Войти» button) goes straight to the sign-in screen (BUG-049).
    if (local && landing !== 'welcome' && landing !== 'home' && landing !== 'login') return { backend: localBackend, server: true };
    // Во вкладке reporting отдельный логин не показываем: ждём SSO от родителя.
    if (isReportingEmbed()) {
      // Повторный probe: bootstrap мог уже обменять reportingSso из URL / postMessage.
      const afterBoot = await cloud.probe();
      if (afterBoot.state === 'signed-in') return { backend: new CloudBackend(afterBoot.user), server: true };
      requestReportingSsoFromParent();
      root.replaceChildren(
        h('div', { class: 'home-missing' }, h('p', {}, tr('Входим через reporting…'))),
      );
      await waitForReportingSso(12_000);
      const again = await cloud.probe();
      if (again.state === 'signed-in') return { backend: new CloudBackend(again.user), server: true };
      root.replaceChildren(
        h('div', { class: 'home-missing' }, h('p', {}, tr('Не удалось войти через reporting. Обновите вкладку.'))),
      );
      await new Promise(() => undefined);
    }
    const useLocal = (): { backend: FileBackend; server: boolean } => {
      try {
        localStorage.setItem(LOCAL_CHOICE, 'local');
      } catch {
        // not remembered: the screen shows again next time
      }
      if (landing === 'home' || landing === 'welcome' || landing === 'login') history.replaceState(null, '', HOME_URL);
      return { backend: localBackend, server: true };
    };
    // «Назад» on the sign-in screen: to the landing page it was opened from, or where the person came from.
    const fromLanding = landing === 'home' || landing === 'file' || landing === 'welcome';
    for (;;) {
      let register = false;
      if (fromLanding) {
        const { showLanding } = await import('./ui/landing.ts');
        const choice = await showLanding(root, { localFiles: local });
        if (choice === 'local') return useLocal();
        if (choice === 'try' || choice === 'tryBoard' || choice === 'tryDiagram' || choice === 'trySlides') {
          useLocal();
          // Each kind's «Попробовать» opens its example: something to look at before starting one's own.
          location.assign(choice === 'tryBoard' ? '/?new=1&board=1&example=1' : choice === 'tryDiagram' ? '/?new=1&diagram=1&example=1' : choice === 'trySlides' ? '/?new=1&slides=1&example=1' : '/?new=1&example=1');
          await new Promise(() => undefined);
        }
        register = choice === 'register';
      }
      const result = await showAuthScreen(root, { allowLocal: true, register, back: true });
      if (result.mode === 'back') {
        if (fromLanding) continue;
        leaveSignIn();
        await new Promise(() => undefined);
      }
      if (result.mode === 'local') return useLocal();
      if (result.mode === 'cloud') {
        if (landing === 'login') history.replaceState(null, '', withoutParam('login'));
        return { backend: new CloudBackend(result.user), server: true };
      }
    }
  }

  /** Connects to the file's room on the server: changes of others arrive, ours go at once. */
  private startLive(): void {
    this.live?.close();
    this.live = null;
    this.resetPeers();
    void this.comments.load();
    void this.assets.checkUpdates();
    const backend = this.backend;
    if (!(backend instanceof CloudBackend) || typeof WebSocket === 'undefined') return;
    let wasOffline = false;
    const fileId = this.fileId;
    const texts = { connecting: tr('Подключение…'), synced: tr('Сохранено на сервере'), sending: tr('Сохранение…'), offline: tr('Нет связи — правки отправятся при подключении') } as const;
    this.live = new LiveSession({
      fileId,
      doc: this.editor.doc,
      canEdit: this.role === 'owner' || this.role === 'editor',
      version: backend.versionOf(fileId),
      link: linkOf(fileId),
      ...(backend instanceof CloudBackend && !backend.user && this.board ? { guest: this.editor.boardPrefs.author } : {}),
      pending: this.carried,
      onState: (state) => {
        // Back after a break: discussions changed meanwhile are fetched again.
        if (state === 'synced' && wasOffline) void this.comments.load();
        // Everything confirmed: the copy in this browser has nothing left to send.
        if (state === 'synced') {
          this.carried = [];
          this.saveOfflineCopy();
        }
        wasOffline = state === 'offline' || (wasOffline && state !== 'synced');
        if (state === 'offline') this.toolbar.setSaveState('error', texts.offline);
        else this.toolbar.setSaveState(state === 'synced' ? 'saved' : 'saving', texts[state]);
        if (state === 'synced') void this.updateThumbnail(false);
      },
      onPeers: (peers, you) => {
        this.self = peers.find((p) => p.id === you) ?? null;
        // The same account open on another computer or tab is still you: not a collaborator
        // to show, follow or be shown (BUG-037). Guests cannot be told apart and stay separate.
        const me = this.self?.userId ?? null;
        const others = peers.filter((p) => p.id !== you && !(me && p.userId === me));
        this.others = others;
        const gone = this.following.setPeers(others);
        if (gone) this.toast(tr('{0} больше нет в файле — наблюдение закончено.', gone.name));
        this.toolbar.setPeers(others, this.following.following);
        this.peerOverlay.setPeers(others);
        if (this.self && this.spotlightBy === this.self.id) this.following.setPresenting({ color: this.self.color });
      },
      onPresence: (from, presence) => {
        // Pointers of one's own other sessions are not drawn.
        if (this.self?.userId && !this.others.some((p) => p.id === from)) return;
        this.peerOverlay.setPresence(from, presence);
        this.following.update(from, presence);
      },
      onSpotlight: (from) => this.onSpotlight(from),
      onThread: (change) => this.comments.apply(change),
      onEmote: (from, emote) => this.emotes.receive(from, emote),
      onSnapshot: (snapshot) => {
        const doc = deserialize(snapshot);
        const page = this.editor.pageId;
        const viewport = this.editor.viewport.toJSON();
        this.editor.setDocument(doc);
        this.applyAccess({ role: this.role });
        if (doc.store.isAlive(page)) this.editor.setPage(page);
        this.editor.viewport.restore(viewport);
        this.editor.requestViewport();
        return doc;
      },
      onDeleted: () => {
        this.live = null;
        void offline.remove(fileId);
        void showMessage({ title: tr('Файл удалён'), message: tr('Владелец удалил этот файл. Вы вернётесь к списку файлов.'), confirm: tr('К файлам') }).then(() => location.assign(HOME_URL));
      },
      onRole: (role) => this.roleChanged(role as Role),
      onRevoked: () => {
        this.live = null;
        void offline.remove(fileId);
        this.resetPeers();
        this.editor.doc.readOnly = true;
        void showMessage({ title: tr('Доступ к файлу закрыт'), message: tr('Владелец закрыл вам доступ к этому файлу. Вы вернётесь к списку файлов.'), confirm: tr('К файлам') }).then(() => location.assign(HOME_URL));
      },
      // Signed out elsewhere: the page asks who is here again (what was not sent stays in the offline copy).
      onSignedOut: () => {
        this.live = null;
        location.reload();
      },
    });
    this.sendPresence();
  }

  /** Nobody else is shown: no avatars, pointers, following, spotlight or chat. */
  private resetPeers(): void {
    this.others = [];
    this.self = null;
    this.spotlightBy = null;
    this.following.stop();
    this.following.setPresenting(null);
    this.chat.close(false);
    this.toolbar.setPeers([]);
    this.peerOverlay.setPeers([]);
  }

  /** Someone asked everyone to follow them, or the spotlight ended. */
  private onSpotlight(from: string | null): void {
    const before = this.spotlightBy;
    this.spotlightBy = from;
    const mine = !!from && from === this.live?.self;
    this.following.setPresenting(mine ? { color: this.self?.color ?? '#4f5bd5' } : null);
    if (mine) {
      this.following.stop();
      if (before !== from) this.toast(tr('Спотлайт включён: все в файле наблюдают за вами.'));
      return;
    }
    if (before && before === this.live?.self && from) this.toast(tr('Спотлайт перешёл к другому участнику.'));
    const peer = from ? this.others.find((p) => p.id === from) : undefined;
    if (peer) {
      this.following.follow(peer, this.peerOverlay.presenceOf(peer.id));
      this.toast(tr('Спотлайт: {0} показывает свой экран. Esc — перестать наблюдать.', peer.name));
    } else if (before && this.following.following === before) {
      // The spotlight is over: everyone gets their own view back.
      this.following.stop();
    }
  }

  /** Spotlight: everyone in the file follows this person; again — ends it. */
  private toggleSpotlight(): void {
    const live = this.live;
    if (!live?.self) {
      this.toast(tr('Спотлайт работает в файлах на сервере.'));
      return;
    }
    live.spotlight(this.spotlightBy !== live.self);
  }

  /** Cursor chat ("/"): a bubble at one's pointer, its text goes to everyone at once. */
  private openCursorChat(): void {
    if (!this.live?.self) {
      this.toast(tr('Чат курсором работает в файлах на сервере.'));
      return;
    }
    const size = this.editor.screenSize;
    const at = this.cursor ? this.editor.viewport.worldToScreen(this.cursor) : { x: size.width / 2, y: size.height / 2 };
    this.chat.open(at, this.self?.color ?? '#4f5bd5');
  }

  /** Tells the others where this person is: page, pointer, selection, visible area, chat message. */
  private sendPresence(): void {
    const editor = this.editor;
    const { width, height } = editor.screenSize;
    const center = editor.viewport.screenToWorld({ x: width / 2, y: height / 2 });
    const round = (n: number) => Math.round(n * 100) / 100;
    this.live?.sendPresence({
      page: editor.pageId,
      cursor: this.cursor,
      selection: [...editor.selection],
      view: { x: round(center.x), y: round(center.y), zoom: editor.viewport.zoom, width, height },
      chat: this.chatText,
    });
  }

  /** Sends where this person is (pointer, page, selection) to the others in the file. */
  private bindPresence(): void {
    const send = () => this.sendPresence();
    const el = this.canvas.element;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
      const p = this.editor.viewport.screenToWorld(screen);
      this.cursor = { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
      if (this.chat.isOpen) this.chat.moveTo(screen);
      send();
    });
    this.chat.onMessage = (text) => {
      this.chatText = text;
      send();
    };
    // Those who follow this person see what they see.
    this.editor.events.on('viewport', send);
    el.addEventListener('pointerleave', () => {
      this.cursor = null;
      send();
    });
    this.editor.events.on('selection', send);
    this.editor.events.on('page', send);
  }

  /** The main menu (burger in the top bar): all commands by section, laid out as the menu bar of a desktop app (menu-layout.ts). */
  private mainMenu(): MenuItem[] {
    const palette = this.commandMap.get('view.palette');
    const item = (l: LaidOut<Command>): MenuItem =>
      l.kind === 'separator'
        ? { kind: 'separator' }
        : l.kind === 'submenu'
          ? { kind: 'submenu', label: l.label, items: l.items.map(item) }
          : { kind: 'action', label: l.command.label, shortcut: l.command.keys?.[0] ? formatShortcut(l.command.keys[0]) : undefined, run: () => l.command.run() };
    return [
      { kind: 'action', label: tr('К файлам и проектам'), run: () => void this.goHome() },
      { kind: 'action', label: tr('Настройки…'), run: () => this.openSettings() },
      ...(palette ? [{ kind: 'action', label: tr('Найти команду…'), shortcut: palette.keys?.[0] ? formatShortcut(palette.keys[0]) : undefined, run: () => palette.run() } as MenuItem] : []),
      { kind: 'separator' },
      ...layOutMenu(this.commands.filter((c) => !c.hidden)).map((s): MenuItem => ({ kind: 'submenu', label: s.label, items: s.items.map(item) })),
    ];
  }

  /** «Войти»: the sign-in screen, then back to this same place (the files, or this file). */
  private static openSignIn(): void {
    if (isReportingEmbed()) {
      requestReportingSsoFromParent();
      return;
    }
    const rest = withoutParam('login');
    location.assign(rest + (rest.includes('?') ? '&login' : '?login'));
  }


  /** For a share link: the server as this person (or as a guest without an account). */
  private static async linkBackend(root: HTMLElement): Promise<{ backend: FileBackend; server: boolean }> {
    const probe = await cloud.probe();
    if (probe.state === 'signed-in') return { backend: new CloudBackend(probe.user), server: true };
    if (probe.state === 'signed-out') return { backend: new CloudBackend(null), server: true };
    return App.chooseBackend(root);
  }

  /**
   * Applies what this person may do with the open file: viewers and
   * commenters see it read-only (edits are reverted with a hint), only owners
   * and editors get "Share".
   */
  /** The owner changed this person's role while the file is open: the editor switches at once. */
  private roleChanged(role: Role): void {
    if (role === this.role) return;
    const couldEdit = this.role === 'owner' || this.role === 'editor';
    this.applyAccess({ role }, false);
    const canEdit = role === 'owner' || role === 'editor';
    if (canEdit && !couldEdit) this.toast(tr('Владелец разрешил вам редактировать файл.'));
    else if (!canEdit && couldEdit) this.toast(tr('Владелец оставил вам только просмотр: правки больше не сохраняются.'));
  }

  /** Phone view on or off: panels hidden, touch pans and pinches, the file read-only. Elsewhere two fingers pinch and pan. */
  private setPhone(phone: boolean): void {
    this.phone = phone;
    this.root.classList.toggle('phone-view', phone);
    this.detachTouch?.();
    this.slides?.setPhone(phone);
    this.detachTouch = phone ? attachTouchViewing(this.canvas.element, this.editor) : attachTouchPinch(this.canvas.element, this.editor, () => this.canvas.cancelPointer());
  }

  private applyAccess(stored: Pick<StoredFile, 'role' | 'signedIn'>, announce = true): void {
    this.access = stored;
    const role: Role = stored.role ?? 'owner';
    this.role = role;
    const readOnly = role === 'viewer' || role === 'commenter' || this.phone;
    const doc = this.editor.doc;
    doc.readOnly = readOnly;
    doc.onBlockedEdit = () => this.blockedEdit(stored.signedIn === false);
    this.root.classList.toggle('read-only', readOnly);
    const canShare = this.backend instanceof CloudBackend ? !!this.backend.user && (role === 'owner' || role === 'editor') : this.serverAvailable;
    this.toolbar.setReadOnly(readOnly, canShare);
    this.comments?.refresh();
    if (this.phone && announce) this.toast(tr('На телефоне файл открыт для просмотра. Править можно на компьютере или планшете.'));
    else if (role === 'commenter' && announce) this.toast(tr('Файл открыт для просмотра и комментариев: C — оставить комментарий.'));
    else if (readOnly && announce) this.toast(stored.signedIn === false ? tr('Файл открыт для просмотра. Чтобы редактировать, войдите.') : tr('Файл открыт только для просмотра: правки не сохраняются.'));
  }

  private blockedEdit(guest: boolean): void {
    if (Date.now() - this.blockedAt < 4000) return;
    this.blockedAt = Date.now();
    this.toast(guest ? tr('Только просмотр. Чтобы редактировать, войдите.') : tr('Только просмотр: изменения не сохраняются. Попросите владельца дать доступ на редактирование.'));
  }

  /** "Share": the dialog for a server file; for a file in this browser — an offer to sign in first. */
  private async openShare(): Promise<void> {
    if (!(this.backend instanceof CloudBackend) || !this.backend.user) {
      const ok = await askConfirm({
        title: tr('Войдите, чтобы делиться'),
        message: tr('Сейчас файл хранится только в этом браузере. После входа его можно перенести на сервер и открыть доступ коллегам — по приглашению или по ссылке.'),
        confirm: tr('Войти'),
      });
      if (ok) {
        await this.autosaver.flush();
        App.openSignIn();
      }
      return;
    }
    // The file must exist on the server before it can be shared.
    await this.autosaver.flush();
    const doc = this.editor.doc;
    const node = this.editor.selection.length === 1 ? this.editor.selection[0]! : null;
    new ShareDialog({
      fileId: this.fileId,
      fileName: doc.get(doc.rootId, 'name'),
      page: this.editor.pageId,
      node,
      nodeName: node ? doc.get(node, 'name') : null,
      board: this.board,
      toast: (message, kind) => this.toast(message, kind),
    });
  }

  /** Account menu in the top bar: who is signed in, sign out, or sign in. */
  private openAccountMenu(x: number, y: number): void {
    const items: MenuItem[] = [];
    if (this.backend instanceof CloudBackend && !this.backend.user) {
      items.push({ kind: 'action', label: tr('Вы смотрите файл без входа'), disabled: true, run: () => undefined });
      items.push({ kind: 'separator' });
      items.push({ kind: 'action', label: tr('Войти или зарегистрироваться…'), run: () => App.openSignIn() });
    } else if (this.backend instanceof CloudBackend && this.backend.user) {
      const user = this.backend.user;
      items.push({ kind: 'action', label: user.name ? `${user.name} · ${user.email}` : user.email, disabled: true, run: () => undefined });
      items.push({ kind: 'separator' });
      items.push({ kind: 'action', label: tr('Выйти'), run: () => void this.signOut() });
    } else {
      items.push({ kind: 'action', label: tr('Файлы хранятся только в этом браузере'), disabled: true, run: () => undefined });
      if (this.serverAvailable) {
        items.push({ kind: 'separator' });
        items.push({ kind: 'action', label: tr('Войти или зарегистрироваться…'), run: () => void this.signIn() });
      }
    }
    this.menu.open(x, y, items);
  }

  private async signOut(): Promise<void> {
    await this.autosaver.flush();
    try {
      await cloud.logout();
    } catch {
      // the session ends on reload anyway
    }
    location.reload();
  }

  private async signIn(): Promise<void> {
    await this.autosaver.flush();
    App.openSignIn();
  }


  /** A separate tab showing only the prototype (?present=<file>&page=…&start=…&src=cloud|local). */
  static async presentStandalone(root: HTMLElement, params: URLSearchParams): Promise<PrototypePlayer> {
    await loadBundledFonts();
    let backend: FileBackend = localBackend;
    if (params.get('src') === 'cloud') {
      const probe = await cloud.probe();
      if (probe.state !== 'signed-in') throw new Error(tr('Чтобы открыть этот прототип, войдите в аккаунт'));
      backend = new CloudBackend(probe.user);
    }
    const stored = await backend.load(params.get('present') ?? '');
    if (!stored) throw new Error(backend.kind === 'cloud' ? tr('Файл не найден') : tr('Файл не найден в этом браузере'));
    const doc = deserialize(stored.snapshot);
    const pageParam = params.get('page');
    const pageId = pageParam && doc.store.has(pageParam) && doc.type(pageParam) === 'PAGE' ? pageParam : doc.pages()[0]!;
    const startParam = params.get('start');
    const { screens: list, isScreen } = await import('./prototype/model.ts');
    const start = startParam && isScreen(doc, startParam) ? startParam : (doc.get(pageId, 'flowStartingPoints')[0]?.nodeId ?? list(doc, pageId)[0]);
    if (!start) throw new Error(tr('На странице нет экранов'));
    document.title = tr('{0} — просмотр', doc.get(doc.rootId, 'name'));
    const player = new PrototypePlayer({ doc, pageId, start, measurer: new CanvasTextMeasurer() });
    root.replaceChildren(player.el);
    player.el.classList.add('standalone');
    return player;
  }

  // ---------- keyboard ----------


  private bindKeyboard(): void {
    // Fields with typing not yet committed (Enter, a choice or leaving the field commits it).
    const typedIn = new WeakSet<EventTarget>();
    window.addEventListener('input', (e) => { if (e.target) typedIn.add(e.target); }, true);
    window.addEventListener('change', (e) => { if (e.target) typedIn.delete(e.target); }, true);
    window.addEventListener('focusin', (e) => { if (e.target) typedIn.delete(e.target); }, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target) typedIn.delete(e.target); }, true);
    // Capture phase: no element on the page can swallow a shortcut by stopping propagation.
    window.addEventListener('keydown', (e) => {
      if (this.palette.isOpen || this.menu.isOpen) return;
      // Dialogs handle their own keys (Delete in the variables table must not delete layers).
      if (this.variables.isOpen || this.files.isOpen || this.player) return;
      // A modal window is open (crop, erase, remove background…): its keys are its own — ⌘Z must not undo in the file behind it.
      if ([...document.querySelectorAll<HTMLElement>('.dialog-overlay')].some((el) => !el.hidden)) return;
      // ⌘Z / ⌘⇧Z in a panel field with nothing typed (after Enter, a list's choice): the file's step, as in Figma.
      // While something is being typed there, the field's own undo takes back the typing.
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target && isTyping(target) && !target.isContentEditable && !this.editor.editingText && !typedIn.has(target)) {
        const step = this.commands.find((c) => (c.id === 'edit.undo' || c.id === 'edit.redo') && c.keys?.some((k) => matches(e, k)));
        if (step) {
          e.preventDefault();
          target.blur();
          step.run();
          return;
        }
      }
      if (isTyping(e.target)) return;
      if (e.code === 'Space' && !e.repeat) {
        this.canvas.setSpace(true);
        e.preventDefault();
        return;
      }
      for (const command of this.commands) {
        if (!command.keys?.some((k) => matches(e, k))) continue;
        if (NATIVE_CLIPBOARD.has(command.id)) {
          this.pasteInPlace = command.id === 'edit.pasteInPlace';
          return;
        }
        e.preventDefault();
        if (e.repeat && !command.repeat) return;
        command.run();
        return;
      }
    }, true);
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.canvas.setSpace(false);
    });
    window.addEventListener('blur', () => this.canvas.setSpace(false));
  }

  private bindClipboard(): void {
    document.addEventListener('copy', (e) => {
      // A dialog (variables table, files) handled it already.
      if (e.defaultPrevented || this.variables.isOpen || this.files.isOpen || this.player) return;
      if (isTyping(e.target) || this.editor.editingText) return;
      // A fill, stroke or effect picked in the panel: just that property (as in Figma).
      const property = this.editor.copyPickedProperty();
      if (property && e.clipboardData) {
        e.clipboardData.setData('text/plain', property);
        e.preventDefault();
        this.toast(tr('Свойство скопировано: ⌘V вставит его в выделенные слои'));
        return;
      }
      const flavours = this.editor.copyFlavours();
      if (!flavours || !e.clipboardData) return;
      e.clipboardData.setData('text/html', flavours.html);
      e.clipboardData.setData('text/plain', flavours.text);
      e.preventDefault();
    });
    document.addEventListener('cut', (e) => {
      // A dialog (variables table, files) handled it already.
      if (e.defaultPrevented || this.variables.isOpen || this.files.isOpen || this.player) return;
      if (isTyping(e.target) || this.editor.editingText) return;
      // A picked property is cut from its layer, not the layer itself.
      const property = this.editor.copyPickedProperty();
      if (property && e.clipboardData) {
        e.clipboardData.setData('text/plain', property);
        e.preventDefault();
        this.editor.removePickedProperty();
        return;
      }
      const flavours = this.editor.copyFlavours();
      if (!flavours || !e.clipboardData) return;
      e.clipboardData.setData('text/html', flavours.html);
      e.clipboardData.setData('text/plain', flavours.text);
      e.preventDefault();
      this.editor.deleteSelection();
    });
    document.addEventListener('paste', (e) => {
      // A dialog (variables table, files) handled it already.
      if (e.defaultPrevented || this.variables.isOpen || this.files.isOpen || this.player) return;
      if (isTyping(e.target) || this.editor.editingText) return;
      // Images from the clipboard (screenshots, copied pictures) become image layers.
      const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile);
      if (files.length > 0) {
        e.preventDefault();
        void this.insertImageFiles(files);
        return;
      }
      // Our layers come in the HTML flavour; plain text is everything else (and older copies).
      const html = e.clipboardData?.getData('text/html') ?? '';
      const text = e.clipboardData?.getData('text/plain') ?? null;
      e.preventDefault();
      if (this.editor.pastePropertyText(text)) return;
      const inPlace = this.pasteInPlace;
      this.pasteInPlace = false;
      if ((html && parseClipboard(html) && this.editor.pasteText(html, inPlace)) || this.editor.pasteText(text, inPlace)) return;
      // Cells copied from Excel, Google Sheets, Numbers or Word become a table (FEAT-167), on a board too (FEAT-181).
      const rows = this.editor.doc.readOnly ? null : tableFromClipboard(html, text);
      // Into a table the selection is in: from the selected cell on (the whole table — from its first), as a spreadsheet does.
      const picked = this.editor.selection[0];
      const into = picked && !this.editor.doc.readOnly ? tableOf(this.editor.doc, picked) : null;
      if (into && (rows || text?.trim())) {
        const place = cellPlace(this.editor.doc, picked!);
        fillCells(this.editor, into, place?.row ?? 0, place?.col ?? 0, rows ?? [[text!.trim()]]);
        return;
      }
      if (rows) {
        insertTable(this.editor, rows, { header: true });
        return;
      }
      if (text && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
        this.importSvgText(text);
        return;
      }
      if (text && text.trim()) {
        // On a board, a link becomes its page's card (FEAT-160), other text stickies: one per line (FEAT-086).
        const link = this.board && !this.editor.doc.readOnly ? linkOfText(text) : null;
        if (link) {
          void insertLink(this.editor, link, (m) => this.toast(m));
          return;
        }
        if (this.board && !this.editor.doc.readOnly) {
          const { width, height } = this.editor.screenSize;
          void import('./board-smart.ts').then(({ linesOf, stickiesFromLines }) => stickiesFromLines(this.editor, linesOf(text), this.editor.viewport.screenToWorld({ x: width / 2, y: height / 2 })));
          return;
        }
        this.pastePlainText(text.trim());
      }
    });
  }

  /** Context menu for the canvas (with the layers under the cursor) or the layers panel (`hits` = null). */
  private menuItems(clientX: number, clientY: number, hits: NodeId[] | null): MenuItem[] {
    const editor = this.editor;
    const doc = editor.doc;
    const cmd = (id: string, label?: string, disabled = false): MenuItem => {
      const c = this.commandMap.get(id)!;
      return { kind: 'action', label: label ?? c.label, shortcut: c.keys?.[0], disabled, run: c.run };
    };
    const sep: MenuItem = { kind: 'separator' };
    const rect = this.canvas.element.getBoundingClientRect();
    const world = editor.viewport.screenToWorld({ x: clientX - rect.left, y: clientY - rect.top });
    const pasteHere: MenuItem = { kind: 'action', label: tr('Вставить сюда'), run: () => void editor.paste(false, hits ? world : undefined) };
    const selection = editor.topLevelSelection();
    // A board has its own short menu (no frames, auto layout or components) — the same as «⋯» over the selection.
    if (this.board) return boardMenuItems(editor, this.commandMap, { pasteHere, ...this.boardMenuExtras() });

    if (selection.length === 0) {
      return [pasteHere, sep, cmd('edit.selectAll'), sep, cmd('view.fit'), cmd('view.zoom100'), sep, cmd('view.palette')];
    }
    const layerList: MenuItem[] = (hits ?? []).slice(0, 15).map((id) => ({
      kind: 'action',
      label: `${'  '.repeat(Math.max(0, doc.store.ancestors(id).length - 2))}${doc.get(id, 'name')}`,
      run: () => editor.setSelection([id]),
    }));
    const groupable = selection.length > 0;
    const ungroupable = selection.some((id) => doc.type(id) === 'GROUP' || doc.type(id) === 'SECTION' || (doc.type(id) === 'FRAME' && doc.children(id).length > 0));
    // A frame is not a group: say what really happens to it (BUG-001).
    const framesOnly = ungroupable && !selection.some((id) => doc.type(id) === 'GROUP');
    const allVisible = selection.every((id) => doc.get(id, 'visible'));
    const allLocked = selection.every((id) => doc.get(id, 'locked'));
    const isAuto = selection.length === 1 && doc.type(selection[0]!) === 'FRAME' && doc.get(selection[0]!, 'layoutMode') !== 'NONE';
    return [
      cmd('edit.copy'),
      cmd('edit.cut'),
      pasteHere,
      cmd('edit.pasteReplace'),
      cmd('edit.duplicate'),
      cmd('edit.delete'),
      // As in Figma's «Copy/Paste as».
      {
        kind: 'submenu',
        label: tr('Копировать / вставить как'),
        items: [cmd('edit.copyCss'), cmd('edit.copyPng'), cmd('edit.copySvg'), sep, cmd('props.copy', tr('Копировать свойства')), cmd('props.paste', tr('Вставить свойства'))],
      } as MenuItem,
      sep,
      ...(layerList.length > 1 ? [{ kind: 'submenu', label: tr('Выбрать слой'), items: layerList } as MenuItem, sep] : []),
      ...tableMenuItems(editor, selection),
      cmd('object.group', undefined, !groupable),
      cmd('object.ungroup', framesOnly ? tr('Убрать фрейм, оставить содержимое') : undefined, !ungroupable),
      cmd('object.frame'),
      cmd('object.section'),
      // As in Figma: the bottom layer of the selection crops the ones above it.
      cmd('shape.mask', selection.length > 0 && selection.every((id) => doc.get(id, 'isMask')) ? tr('Убрать маску') : undefined),
      cmd('object.autoLayout', isAuto ? tr('Убрать адаптивную раскладку') : tr('Добавить адаптивную раскладку')),
      ...(selection.some((id) => (doc.type(id) === 'FRAME' || doc.type(id) === 'COMPONENT') && doc.children(id).length > 0) ? [cmd('object.suggestAutoLayout')] : []),
      // Nested layouts too, in one go (as in Figma).
      ...(editor.autoLayoutsInSelection().length > (isAuto ? 1 : 0) ? [cmd('object.removeAllAutoLayout')] : []),
      // A layer inside an auto layout can leave it alone, without turning the layout off (as in Figma).
      ...(selection.length > 0 && selection.every((id) => editor.inAutoLayoutParent(id))
        ? [cmd('layout.absolute', selection.every((id) => editor.doc.get(id, 'positioning') === 'ABSOLUTE') ? tr('Вернуть в адаптивную раскладку') : tr('Вывести из адаптивной раскладки'))]
        : []),
      {
        kind: 'submenu',
        label: tr('Фигуры'),
        disabled: selection.length === 0,
        items: [cmd('shape.union'), cmd('shape.subtract'), cmd('shape.intersect'), cmd('shape.exclude'), sep, cmd('shape.builder'), cmd('shape.flatten'), cmd('shape.outline'), cmd('shape.editPoints'), sep, cmd('brush.createStretch'), cmd('brush.createScatter')],
      } as MenuItem,
      sep,
      ...this.componentMenuItems(selection, cmd),
      sep,
      {
        kind: 'submenu',
        label: tr('Порядок'),
        items: [cmd('object.front'), cmd('object.forward'), cmd('object.backward'), cmd('object.back')],
      },
      {
        kind: 'submenu',
        label: tr('Выравнивание'),
        items: [cmd('align.left'), cmd('align.hcenter'), cmd('align.right'), sep, cmd('align.top'), cmd('align.vcenter'), cmd('align.bottom'), sep, cmd('align.distributeH'), cmd('align.distributeV')],
      },
      // As in Figma's menu: mirror and quarter turns.
      {
        kind: 'submenu',
        label: tr('Отразить и повернуть'),
        disabled: selection.length === 0 || this.board,
        items: [cmd('object.flipH'), cmd('object.flipV'), sep, cmd('object.rotate90'), cmd('object.rotate90back'), cmd('object.rotationOrigin')],
      } as MenuItem,
      sep,
      cmd('object.toggleVisible', allVisible ? tr('Скрыть') : tr('Показать')),
      cmd('object.toggleLock', allLocked ? tr('Открепить') : tr('Закрепить')),
      cmd('edit.rename', selection.length > 1 ? tr('Переименовать слои…') : undefined),
      cmd('edit.selectMatching'),
      ...(textAndPath(editor) ? [cmd('text.onPath', tr('Пустить текст по контуру'))] : []),
      ...(selection.some((id) => doc.type(id) === 'TEXT' && doc.get(id, 'textPath')) ? [cmd('text.flipPath'), cmd('text.offPath')] : []),
      sep,
      cmd('view.fitSelection'),
      cmd('file.export', tr('Экспорт в PNG')),
    ];
  }

  /** Board menu items that live in the app: a link to the selected object (files on the server only). */
  private boardMenuExtras(): { copyLink?: MenuItem } {
    const sel = this.editor.topLevelSelection();
    if (!(this.backend instanceof CloudBackend) || sel.length !== 1) return {};
    return { copyLink: { kind: 'action', label: tr('Копировать ссылку на объект'), run: () => void this.copyObjectLink(sel[0]!) } };
  }

  /**
   * A link that opens the board right at an object (as a link to a layer in a
   * design): with the file's link token when it is shared by link, so those who
   * open the file by its link can open this one too.
   */
  private async copyObjectLink(node: NodeId): Promise<void> {
    let token = linkOf(this.fileId);
    try {
      const info = await sharing.get(this.fileId);
      if (info.link.mode !== 'invited') token = info.link.token;
    } catch {
      // not allowed to see the sharing settings: the link as this person has it
    }
    const url = sharing.url(this.fileId, token, { page: this.editor.pageId, node });
    try {
      await navigator.clipboard.writeText(url);
      this.toast(tr('Ссылка скопирована: откроет доску прямо на этом объекте'));
    } catch {
      this.toast(url, 'info', 15000);
    }
  }

  /** Component actions that make sense for the current selection. */
  private componentMenuItems(selection: NodeId[], cmd: (id: string, label?: string, disabled?: boolean) => MenuItem): MenuItem[] {
    const doc = this.editor.doc;
    const types = selection.map((id) => doc.type(id));
    const items: MenuItem[] = [];
    const inInstance = selection.some((id) => this.editor.isInstanceLayer(id));
    if (types.every((t) => t === 'INSTANCE')) {
      items.push(cmd('component.goToMain'), cmd('component.reset'));
      if (selection.every((id) => doc.get(id, 'componentKey') === null)) items.push(cmd('component.detach'));
    } else if (inInstance) {
      items.push(cmd('component.goToMain', tr('Перейти к компоненту')), cmd('component.reset', tr('Сбросить изменения этого слоя')));
    } else if (types.every((t) => t === 'COMPONENT')) {
      items.push(cmd('component.instance'));
      const inSet = selection.every((id) => doc.type(doc.parent(id)!) === 'COMPONENT_SET');
      if (inSet) items.push(cmd('component.addVariant'));
      else items.push(cmd('component.combine'));
    } else if (types.every((t) => t === 'COMPONENT_SET')) {
      items.push(cmd('component.addVariant'));
    } else {
      items.push(cmd('component.create'));
    }
    return items;
  }

  /** Plain text from another app becomes a text layer in the middle of the view. */
  private pastePlainText(text: string): void {
    const editor = this.editor;
    const center = editor.viewport.screenToWorld({ x: editor.screenSize.width / 2, y: editor.screenSize.height / 2 });
    let id: NodeId = '';
    editor.commit(tr('Вставить текст'), (tx) => {
      id = tx.create('TEXT', editor.pageId, { name: text.slice(0, 32), characters: text, x: Math.round(center.x), y: Math.round(center.y) });
    }, () => [id]);
  }

  private bindFileDrop(): void {
    this.root.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    this.root.addEventListener('drop', (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      const svgs = files.filter((f) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name));
      const rect0 = this.canvas.element.getBoundingClientRect();
      const dropAt = this.editor.viewport.screenToWorld({ x: e.clientX - rect0.left, y: e.clientY - rect0.top });
      if (svgs.length > 0) void this.importSvgFiles(svgs, dropAt);
      const images = files.filter((f) => isImageFile(f) && !svgs.includes(f));
      if (svgs.length > 0 && images.length === 0) return;
      if (images.length > 0) {
        // Dropped images land where the pointer is.
        const rect = this.canvas.element.getBoundingClientRect();
        const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        const at = inside ? this.editor.viewport.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top }) : undefined;
        void this.insertImageFiles(images, at);
        return;
      }
      void this.loadFile(files[0]!);
    });
  }

  /** Drag the inner edge of a side panel to resize it; double click restores the default (FEAT-012). */
  private bindPanelResizers(area: HTMLElement): void {
    const root = this.root;
    // A diagram's text wants more room than a list of layers: its widths are kept apart.
    const DEFAULTS = this.diagramFile ? { left: 420, right: 260 } : this.slidesFile ? { left: 272, right: 260 } : { left: 240, right: 260 };
    const KEY = this.diagramFile ? 'cs.panels.diagram' : this.slidesFile ? 'cs.panels.slides' : 'cs.panels';
    const MIN = 180;
    const MAX = 720;
    const widths = { ...DEFAULTS };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<typeof widths> | null;
      if (saved) for (const side of ['left', 'right'] as const) if (typeof saved[side] === 'number') widths[side] = Math.min(MAX, Math.max(MIN, saved[side]));
    } catch {
      // Storage unavailable or corrupted: defaults.
    }
    const apply = () => {
      root.style.setProperty('--left-w', `${widths.left}px`);
      root.style.setProperty('--right-w', `${widths.right}px`);
    };
    const save = () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(widths));
        prefsChanged();
      } catch {
        // Not remembered.
      }
    };
    apply();
    for (const side of ['left', 'right'] as const) {
      const handle = h('div', { class: `panel-resizer ${side}`, role: 'separator', 'aria-orientation': 'vertical', title: tr('Потяните, чтобы изменить ширину панели. Двойной щелчок — стандартная ширина') });
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        handle.classList.add('dragging');
        const bounds = root.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          // Widths are stored at 100% interface size; a larger interface makes the columns wider.
          const ui = Number(root.style.getPropertyValue('--ui')) || 1;
          const w = (side === 'left' ? ev.clientX - bounds.left : bounds.right - ev.clientX) / ui;
          widths[side] = Math.round(Math.min(MAX, Math.max(MIN, w)));
          apply();
        };
        const up = () => {
          handle.classList.remove('dragging');
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          save();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
      handle.addEventListener('dblclick', () => {
        widths[side] = DEFAULTS[side];
        apply();
        save();
      });
      area.append(handle);
    }
  }

  /** Copy as PNG (2x) or as SVG markup (FR-EXP). */
  private async copyAs(format: 'PNG' | 'SVG' | 'CSS'): Promise<void> {
    const ids = this.editor.topLevelSelection();
    if (ids.length === 0) {
      this.toast(tr('Выделите слои'));
      return;
    }
    try {
      if (format === 'CSS') {
        await navigator.clipboard.writeText(selectionCss(this.editor));
        this.toast(tr('CSS скопирован в буфер обмена'));
      } else if (format === 'SVG') {
        const renderer = this.canvas.renderer;
        const { svg } = exportSvg(this.editor.scene, this.editor.measurer, ids, renderer.images, { picture: (n) => layerPicture(renderer, this.editor.scene, n) });
        await navigator.clipboard.writeText(svg);
        this.toast(tr('SVG скопирован в буфер обмена'));
      } else {
        const result = await renderExports(this.editor, this.canvas.renderer, ids.slice(0, 1), () => [{ format: 'PNG', scale: 2, suffix: '' }]);
        const file = result.files[0];
        if (!file) return;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([file.data as BlobPart], { type: 'image/png' }) })]);
        this.toast(ids.length > 1 ? tr('Скопирован PNG первого слоя (2x)') : tr('PNG скопирован в буфер обмена (2x)'));
      }
    } catch (error) {
      this.toast(tr('Не удалось скопировать: {0}', error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  private async importSvgFiles(files?: File[], at?: Point): Promise<void> {
    const list = files ?? (await pickFiles('.svg,image/svg+xml', true));
    for (const file of list) this.importSvgText(await file.text(), at, file.name.replace(/\.svg$/i, ''));
  }

  /** Builds editable layers from SVG markup (paste, drop, File → Import). */
  private importSvgText(text: string, at?: Point, name?: string): boolean {
    try {
      const id = importSvg(this.editor, text, at, name);
      if (!id) {
        this.toast(tr('В SVG не нашлось фигур для импорта'));
        return false;
      }
      return true;
    } catch (error) {
      this.toast(tr('Не удалось импортировать SVG: {0}', error instanceof Error ? error.message : String(error)), 'error');
      return false;
    }
  }

  /** ✦ «Изменить по описанию» (FEAT-172): the selected frame as a page goes to the model with the request; the changed page takes its place. */
  private async editLayoutByDescription(): Promise<void> {
    const editor = this.editor;
    const ids = editor.topLevelSelection();
    // Nothing selected on a slide on show: the slide itself — made by the model or by hand.
    const id = ids.length === 0 ? editor.slideStage?.current() : ids[0];
    if (editor.doc.readOnly) return this.toast(tr('Только просмотр: изменить нельзя.'));
    if (ids.length > 1 || !id || editor.doc.type(id) !== 'FRAME') return this.toast(tr('Выделите один фрейм с макетом.'));
    const [{ htmlDocument }, { HtmlImportDialog }, { layoutSignature }] = await Promise.all([import('./html-export.ts'), import('./html-import/dialog.ts'), import('./html-import/build.ts')]);
    // The model's own page while the layers are as it made them; else the layers as a page.
    const source = editor.doc.get(id, 'aiSource');
    let html: string;
    if (source && source.sig === layoutSignature(editor.doc, id)) html = source.html;
    else {
      await this.canvas.renderer.images.settled();
      html = htmlDocument(editor, this.canvas.renderer, id, true);
    }
    HtmlImportDialog.open(editor, 'prompt', { id, html, width: editor.doc.get(id, 'width'), height: editor.doc.get(id, 'height') });
  }

  private async placeImage(): Promise<void> {
    const files = await pickImageFiles(true);
    if (files.length > 0) await this.insertImageFiles(files);
  }

  /** Insert Big Image: the picture at its own size, in pieces the browser draws without trouble. */
  private async placeBigImage(): Promise<void> {
    const [file] = await pickFiles(IMAGE_TYPES.filter((t) => t.startsWith('image/') && t !== 'image/svg+xml').join(','));
    if (!file) return;
    try {
      const big = await sliceBigImage(file);
      this.editor.insertImageTiles(big.name, big.width, big.height, big.tiles);
      if (big.tiles.length > 1) this.editor.toast(tr('{0} × {1} px, без ужатия: {2} {3} в группе', big.width, big.height, big.tiles.length, plural(big.tiles.length, 'часть', 'части', 'частей')));
    } catch (err) {
      this.editor.toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  private async insertImageFiles(files: File[], at?: Point): Promise<void> {
    const images: ImageInput[] = [];
    for (const file of files) {
      try {
        images.push(await readImageFile(file));
      } catch (err) {
        // A video says what is wrong with it (too big, a format the browser does not play).
        const reason = file.type.startsWith('video/') && err instanceof Error ? err.message : tr('Не удалось открыть «{0}»: формат не поддерживается', file.name);
        this.editor.toast(reason, 'error');
      }
    }
    if (images.length > 0) this.editor.insertImages(images, at);
  }

  // ---------- files ----------

  private async persist(): Promise<void> {
    // View-only: nothing to save (and the server would refuse).
    if (this.editor.doc.readOnly) return;
    const editor = this.editor;
    // Live: every change already went to the server as an operation; the room saves the file.
    if (this.live) {
      document.title = `${editor.doc.get(editor.doc.rootId, 'name')} — ${brand()}`;
      // The copy for working without a network, with what is not confirmed yet.
      this.saveOfflineCopy();
      return;
    }
    const name = editor.doc.get(editor.doc.rootId, 'name');
    const savedAs = await this.backend.save({
      id: this.fileId,
      name,
      snapshot: serialize(editor.doc),
      viewport: editor.viewport.toJSON(),
      pageId: editor.pageId,
      savedAt: Date.now(),
      ...(this.newFileProject ? { projectId: this.newFileProject } : {}),
    });
    this.newFileProject = null;
    document.title = `${name} — ${brand()}`;
    // A conflicting save went to a copy: keep working in the copy.
    if (savedAs !== this.fileId) this.setFileId(savedAs);
    if (Date.now() - this.thumbnailAt > THUMBNAIL_EVERY) void this.updateThumbnail(false);
  }

  /** Keeps the open server file (and its unconfirmed changes) in this browser. */
  private saveOfflineCopy(): void {
    // At most every few seconds, with the latest state: on a big file each copy is a whole snapshot.
    if (this.offlineTimer) return;
    const wait = Math.max(0, this.offlineAt + OFFLINE_COPY_EVERY - Date.now());
    const write = () => {
      // Not in the middle of a drag: a whole snapshot of a big file takes a noticeable moment.
      if (this.canvas.busy) {
        this.offlineTimer = setTimeout(write, 500);
        return;
      }
      this.offlineTimer = null;
      this.offlineAt = Date.now();
      const backend = this.backend;
      if (!(backend instanceof CloudBackend) || !backend.user || !this.live || this.editor.doc.readOnly) return;
      const doc = this.editor.doc;
      void offline.update(this.fileId, backend.user.id, { snapshot: serialize(doc), name: String(doc.get(doc.rootId, 'name') ?? ''), savedAt: Date.now(), pending: this.live.pendingOps() });
    };
    // When the browser has a quiet moment (or within a few seconds anyway).
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number }).requestIdleCallback;
    this.offlineTimer = setTimeout(() => (idle ? idle(write, { timeout: 3000 }) : write()), wait);
  }
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineAt = 0;

  /**
   * Draws the open page, fitted to its content, into a small picture for the
   * file browser and stores it next to the file. Never gets in the way: a
   * failure only means an older (or no) preview.
   */
  private async updateThumbnail(force: boolean): Promise<void> {
    if (this.editor.doc.readOnly) return;
    if (!force && Date.now() - this.thumbnailAt < THUMBNAIL_EVERY) return;
    this.thumbnailAt = Date.now();
    try {
      if (this.diagram) {
        const url = await this.diagram.thumbnail();
        if (url) await this.backend.saveThumbnail(this.fileId, url);
        return;
      }
      const width = 480;
      const height = 300;
      const canvas = h('canvas', { width, height });
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      const scene = this.editor.scene;
      const viewport = new Viewport();
      const bounds = scene.contentBounds();
      if (bounds) viewport.fit(bounds, width, height, 20, 2);
      else viewport.restore({ zoom: 1, offsetX: width / 2, offsetY: height / 2 });
      // A board's dot grid is for working on the canvas: shrunk into a preview it is coarse spots (BUG-110).
      const renderer = this.canvas.renderer;
      const pattern = renderer.pagePattern;
      renderer.pagePattern = null;
      try {
        renderer.renderPage({ ctx, width, height, dpr: 1 }, scene, viewport);
      } finally {
        renderer.pagePattern = pattern;
      }
      await this.backend.saveThumbnail(this.fileId, canvas.toDataURL('image/jpeg', 0.85));
    } catch (error) {
      console.warn(tr('Превью не сохранено'), error);
    }
  }

  /** Back to the file browser: save, refresh the preview, go. */
  private async goHome(): Promise<void> {
    await this.live?.drain();
    await this.autosaver.flush();
    await this.updateThumbnail(true);
    location.assign(HOME_URL);
  }

  /** Switches the open file id: remembered, and shown in the address so it can be bookmarked or shared. */
  private setFileId(id: string): void {
    this.fileId = id;
    try {
      localStorage.setItem(this.backend.lastFileKey, id);
    } catch {
      // storage unavailable: nothing to remember
    }
    history.replaceState(null, '', fileUrl(id));
  }

  /** Leaves the live room of the open file (its changes are confirmed first). */
  private async stopLive(): Promise<void> {
    await this.live?.drain();
    this.live?.close();
    this.live = null;
    this.resetPeers();
  }

  /** "Translate text": text layers in the selection (and inside it) → a language picked from a menu. */
  private translateSelection(): void {
    const d = this.editor.doc;
    if (d.readOnly) return void this.toast(tr('Только просмотр: изменения не сохраняются.'));
    const texts: NodeId[] = [];
    const walk = (id: NodeId) => {
      if (d.type(id) === 'TEXT' && d.get(id, 'characters').trim()) texts.push(id);
      else if (d.type(id) !== 'INSTANCE') for (const c of d.children(id)) walk(c);
    };
    this.editor.topLevelSelection().forEach(walk);
    if (!texts.length) return void this.toast(tr('Выделите текст или фрейм с текстом'));
    void import('./translate.ts').then(({ TARGET_LANGUAGES, canTranslate, translateTexts }) => {
      if (!canTranslate()) return void this.toast(tr('Этот браузер не умеет переводить на устройстве. Перевод работает в Chrome 138 и новее.'), 'error');
      const items: MenuItem[] = TARGET_LANGUAGES.map(([code, name]) => ({
        kind: 'action',
        label: name,
        run: () => {
          void translateTexts(texts.map((id) => d.get(id, 'characters')), code, (m) => this.toast(m))
            .then((out) => {
              this.editor.commit(tr('Перевести текст'), (tx) => {
                texts.forEach((id, i) => {
                  if (out[i] === d.get(id, 'characters')) return;
                  // Character styles are tied to offsets of the old text: the translation takes the base style.
                  tx.set(id, 'characters', out[i]!);
                  tx.set(id, 'textRuns', []);
                });
              });
              this.toast(tr('Переведено текстов: {0}. Отменить — {1}.', texts.length, IS_MAC ? '⌘Z' : 'Ctrl+Z'));
            })
            .catch((error: unknown) => this.toast(error instanceof Error ? error.message : String(error), 'error'));
        },
      }));
      this.menu.open(innerWidth / 2 - 100, innerHeight / 3, items);
    });
  }

  /** "Remove background" for every selected layer with an image fill (one undo step). */
  private async removeBackgroundOfSelection(): Promise<void> {
    const editor = this.editor;
    const d = editor.doc;
    if (d.readOnly) return void this.toast(tr('Только просмотр: изменения не сохраняются.'));
    // One picture: a photo opens the window with the "Keep" / "Remove" brushes.
    const pictures = editor.selection.filter((id) => d.get(id, 'fills').some((p) => p.visible && p.type === 'IMAGE'));
    if (pictures.length === 1) return this.removeImageBackground(pictures[0]!, d.get(pictures[0]!, 'fills').findLastIndex((p) => p.visible && p.type === 'IMAGE'));
    const { removeBackgroundFromBytes } = await import('./remove-bg.ts');
    const { LOADING_NOTE } = await import('./ai-cutout.ts');
    const jobs: { id: NodeId; index: number; png: Uint8Array }[] = [];
    let error: string | null = null;
    for (const id of editor.selection) {
      const fills = d.get(id, 'fills');
      const index = fills.findLastIndex((p) => p.visible && p.type === 'IMAGE');
      const paint = fills[index];
      if (!paint || paint.type !== 'IMAGE') continue;
      const blob = d.store.blobs.get(paint.imageHash);
      if (!blob) continue;
      const res = await removeBackgroundFromBytes(base64ToBytes(blob.data), blob.mime, () => this.toast(LOADING_NOTE(), 'info', 15000));
      if ('error' in res) error ??= res.error;
      else jobs.push({ id, index, png: res.png });
    }
    if (!jobs.length) return void this.toast(error ?? tr('Выделите слой с картинкой'));
    editor.commit(tr('Удалить фон'), (tx) => {
      for (const job of jobs) {
        const fills = d.get(job.id, 'fills').slice();
        const paint = fills[job.index];
        if (paint?.type === 'IMAGE') fills[job.index] = { ...paint, imageHash: tx.addBlob(job.png, 'image/png'), crop: undefined };
        tx.set(job.id, 'fills', fills);
      }
    });
    this.toast(tr('Фон удалён: {0}. Отменить — {1}.', jobs.length, IS_MAC ? '⌘Z' : 'Ctrl+Z'));
  }

  private removeImageBackground(id: NodeId, index: number): void {
    void import('./ui/remove-bg-dialog.ts').then(({ removeBackgroundOf }) => removeBackgroundOf(this.editor, id, index));
  }

  /** A hyperlink for the selected text (Mod+K while editing, the panel, the palette); empty — remove it. */
  private async editLink(): Promise<void> {
    const editor = this.editor;
    if (editor.doc.readOnly) return void this.toast(tr('Только просмотр: изменения не сохраняются.'));
    // Where it goes is fixed now: the dialog takes the focus away from the text.
    const targets = editor.linkTargets().filter((t) => t.end > t.start);
    if (!targets.length) return void this.toast(tr('Выделите текст, на который поставить ссылку'));
    const current = editor.linkValue();
    const value = await askText({ title: tr('Ссылка'), label: tr('Адрес'), value: typeof current === 'string' ? current : '', placeholder: 'https://', confirm: tr('Сохранить'), maxLength: 2000, allowEmpty: true, hint: tr('Сайт, почта или телефон. Пустое поле — убрать ссылку.') });
    if (value === null) return;
    if (!value.trim()) {
      editor.setLink(null, targets);
      return;
    }
    const url = safeLink(value);
    if (!url) return void this.toast(tr('Такую ссылку нельзя поставить: нужен адрес сайта, почта или телефон'), 'error');
    editor.setLink(url, targets);
  }

  /** What the branch windows need from the open file. */
  private branchHost(): BranchHost {
    return {
      editor: this.editor,
      renderer: this.canvas.renderer,
      fileId: this.fileId,
      fileName: String(this.editor.doc.get(this.editor.doc.rootId, 'name') ?? ''),
      role: this.role,
      branch: this.branch,
      userId: this.backend instanceof CloudBackend ? (this.backend.user?.id ?? null) : null,
      toast: (text, kind) => this.toast(text, kind),
      settle: async () => {
        await this.live?.drain();
        await this.autosaver.flush();
      },
    };
  }

  /** In a branch: the bar over the canvas (whose branch, how far behind, the ways back). */
  private setBranch(branch: NonNullable<StoredFile['branch']> | null): void {
    this.branch = branch;
    this.branchBar?.destroy();
    this.branchBar = null;
    if (!branch) return;
    void import('./ui/branches.ts').then(({ BranchBar }) => {
      this.branchBar = new BranchBar(this.branchHost(), { update: () => this.updateBranch(), merge: () => void this.mergeIntoMain(), branches: () => this.showBranches(false) });
      this.root.querySelector('.canvas-area')?.append(this.branchBar.el);
    });
  }

  /** Branches work with server files: they are for working together. */
  private branchesAvailable(): boolean {
    if (this.backend instanceof CloudBackend && this.backend.user) return true;
    this.toast(tr('Ветки работают для файлов на сервере. Войдите, чтобы перенести файл и создавать ветки.'));
    return false;
  }

  private showBranches(create: boolean): void {
    if (!this.branchesAvailable()) return;
    if (create && this.role !== 'owner' && this.role !== 'editor') return this.toast(tr('Создавать ветки могут те, кто может редактировать файл.'));
    void import('./ui/branches.ts').then(({ BranchesDialog }) => new BranchesDialog(this.branchHost(), create));
  }

  private updateBranch(): void {
    if (!this.branchesAvailable()) return;
    void import('./ui/branches.ts').then((m) => m.updateBranch(this.branchHost(), () => void this.branchBar?.refresh()));
  }

  /** From a branch: the main file opens with the merge window (the merge goes into the main file, live). */
  private async mergeIntoMain(): Promise<void> {
    if (!this.branchesAvailable()) return;
    const branch = this.branch;
    if (!branch) return this.toast(tr('Сливают ветку в основной файл из самой ветки: откройте её через «Файл → Ветки…».'));
    if (branch.merged) return this.toast(tr('Эта ветка уже слита.'));
    try {
      const { main } = await cloudBranches.info(this.fileId);
      if (main.role !== 'owner' && main.role !== 'editor') return this.toast(tr('Сливать в «{0}» могут те, кто может его редактировать; у вас там только просмотр.', main.name), 'error');
    } catch (error) {
      return this.toast(error instanceof Error ? error.message : String(error), 'error');
    }
    await this.live?.drain();
    await this.autosaver.flush();
    location.assign(`/?file=${encodeURIComponent(branch.of)}&merge=${encodeURIComponent(this.fileId)}`);
  }

  /** Version history of a server file: compare with now, bring back a frame or the whole file. */
  private showVersions(): void {
    if (!(this.backend instanceof CloudBackend)) return void this.toast(tr('История версий работает для файлов на сервере. Войдите, чтобы перенести файл.'));
    const canEdit = (this.role === 'owner' || this.role === 'editor') && !this.editor.doc.readOnly;
    void import('./ui/versions-view.ts').then(({ VersionsView }) => new VersionsView({ editor: this.editor, renderer: this.canvas.renderer, fileId: this.fileId, canEdit, toast: (t, k) => this.toast(t, k) }));
  }

  /** "Crop picture" for the first selected layer with a picture. */
  private cropSelection(): void {
    const d = this.editor.doc;
    for (const id of this.editor.selection) {
      const index = d.get(id, 'fills').findLastIndex((p) => p.visible && p.type === 'IMAGE');
      if (index >= 0) return this.cropImage(id, index);
    }
    this.toast(tr('Выделите слой с картинкой'));
  }

  /** "Erase with a brush" for the first selected layer with a picture. */
  private eraseSelection(): void {
    const d = this.editor.doc;
    for (const id of this.editor.selection) {
      const index = d.get(id, 'fills').findLastIndex((p) => p.visible && p.type === 'IMAGE');
      if (index >= 0) return this.eraseImage(id, index);
    }
    this.toast(tr('Выделите слой с картинкой'));
  }

  private eraseImage(id: NodeId, index: number): void {
    if (this.editor.doc.readOnly) return void this.toast(tr('Только просмотр: изменения не сохраняются.'));
    void import('./ui/erase-dialog.ts').then(({ EraseDialog }) => new EraseDialog(this.editor, id, index));
  }

  private cropImage(id: NodeId, index: number): void {
    if (this.editor.doc.readOnly) return void this.toast(tr('Только просмотр: изменения не сохраняются.'));
    void import('./ui/crop-dialog.ts').then(({ CropDialog }) => new CropDialog(this.editor, id, index));
  }

  private openSettings(): void {
    void import('./ui/settings-dialog.ts').then(({ SettingsDialog }) => new SettingsDialog({
        onUiScale: (s) => this.applyUiScale(s),
        onDock: (p) => this.toolbar.setDockPlace(p),
        onContextBar: (mode) => {
          this.contextBar.mode = mode;
          this.contextBar.schedule();
        },
        onView: (patch) => this.editor.setView(patch),
      }));
  }

  /** Opens the help, optionally at an article (the "?" next to panel sections asks for one). */
  private openHelp(article?: string): void {
    // In a diagram, help starts at how to write its kind (DocPlan's reference, now in the help).
    if (!article && this.diagram) article = `diagram-${this.diagram.layout}`;
    void import('./help/dialog.ts').then(({ HelpDialog }) => new HelpDialog({ commands: this.commands, onExample: () => this.openExample(), article }));
  }

  /** A new file with the starter tour, in a new tab (the current file stays open). */
  private openExample(): void {
    window.open('./?new=1&example=1', '_blank', 'noopener');
  }

  private async newFile(): Promise<void> {
    await this.stopLive();
    await this.autosaver.flush();
    this.setFileId(newFileId());
    this.editor.setDocument(this.slidesFile ? createSlidesDocument(tr('Без названия')) : this.diagramFile ? createDiagramDocument(tr('Без названия')) : this.board ? createBoardDocument(tr('Без названия')) : Document.createEmpty(tr('Без названия'), undefined, { backgroundColor: themePageBackground() }));
    this.applyAccess({ role: 'owner' }, false);
    this.editor.zoomToFit();
    this.toast(tr('Создан новый файл. Прежний остался в списке файлов.'));
    await this.autosaver.flush();
    this.startLive();
  }

  /** Opens a file from the browser's storage (the current one is saved first). */
  private async openStored(id: string): Promise<void> {
    await this.live?.drain();
    await this.autosaver.flush();
    let stored: StoredFile | undefined;
    try {
      stored = await this.backend.load(id);
    } catch (error) {
      this.toast(tr('Не удалось открыть файл: {0}', error instanceof Error ? error.message : String(error)), 'error');
      return;
    }
    if (!stored) {
      this.toast(tr('Файл не найден'), 'error');
      return;
    }
    try {
      const doc = deserialize(stored.snapshot);
      // A board, a diagram and a design have different tools and panels: the other kind opens as its own page.
      if (isBoard(doc) !== this.board || isDiagram(doc) !== this.diagramFile || isSlides(doc) !== this.slidesFile) {
        location.assign(`?file=${encodeURIComponent(id)}`);
        return;
      }
      this.setFileId(id);
      bindOldSlides(doc);
      this.editor.setDocument(doc);
      this.applyAccess(stored);
      this.startLive();
      if (stored.pageId && doc.store.has(stored.pageId)) this.editor.setPage(stored.pageId);
      if (stored.viewport) {
        this.editor.viewport.restore(stored.viewport);
        this.editor.requestViewport();
      } else this.editor.zoomToFit();
      this.toolbar.setSaveState('saved');
    } catch (error) {
      this.toast(tr('Не удалось открыть файл: {0}', error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  private async renameStored(id: string, name: string): Promise<void> {
    if (id === this.fileId) {
      this.editor.commit(tr('Переименовать файл'), (tx) => tx.set(this.editor.doc.rootId, 'name', name));
      await this.autosaver.flush();
    } else await this.backend.rename(id, name);
  }

  private async duplicateStored(id: string): Promise<void> {
    if (id === this.fileId) await this.autosaver.flush();
    await duplicateIn(this.backend, id);
  }

  private async removeStored(id: string): Promise<void> {
    await this.backend.remove(id);
    if (id !== this.fileId) return;
    // The open file was deleted: open the most recent other one, or start a new one.
    const next = (await this.backend.list())[0];
    if (next) await this.openStored(next.id);
    else await this.newFile();
  }

  /** Opens a file from disk as a new file: our .csdoc.json, or a .fig from Figma. */
  private openFile(accept = '.json,.csdoc,.fig,.jam,.pptx,application/json'): void {
    void pickFiles(accept).then(([file]) => {
      if (file) void this.loadFile(file);
    });
  }

  private async loadFile(file: File): Promise<void> {
    try {
      let note = '';
      let doc: Document;
      const fig = await import('./fig/import.ts');
      if (/\.pptx$/i.test(file.name)) {
        this.toast(tr('Импортирую «{0}»…', file.name));
        const pptx = await import('./pptx/import-run.ts');
        // Into the open presentation: after the current slide.
        if (this.slidesFile && !this.editor.doc.readOnly) {
          const result = await pptx.importPptxInto(this.editor, file, this.slides?.currentSlide() ?? null);
          if (result.slides[0]) this.slides?.show(result.slides[0]);
          this.toast(result.note, 'info', 12000);
          return;
        }
        const result = await pptx.pptxToDocument(file, this.measurer);
        doc = result.doc;
        note = result.note;
      } else if (await fig.isFigFile(file)) {
        this.toast(tr('Импортирую «{0}»…', file.name));
        const result = await fig.importFig(file);
        doc = result.doc;
        note = result.note;
      } else doc = deserialize(await file.text());
      // A board or a diagram opened from a design (or the other way): saved as a new file and opened as its own page.
      if (isBoard(doc) !== this.board || isDiagram(doc) !== this.diagramFile || isSlides(doc) !== this.slidesFile) {
        const id = this.backend.kind === 'cloud' ? newCloudId() : newFileId();
        await this.backend.save({ id, name: doc.get(doc.rootId, 'name'), snapshot: serialize(doc), savedAt: Date.now() });
        try {
          if (note) sessionStorage.setItem(IMPORT_NOTE, note);
        } catch {
          // the note is a courtesy
        }
        location.assign(`?file=${encodeURIComponent(id)}`);
        return;
      }
      // A file from disk becomes a new file in the list; the open one stays there.
      await this.stopLive();
      await this.autosaver.flush();
      this.setFileId(newFileId());
      this.editor.setDocument(doc);
      this.applyAccess({ role: 'owner' });
      this.editor.zoomToFit();
      if (note) this.toast(note, 'info', 12000);
      else this.toast(tr('Открыт файл «{0}»', doc.get(doc.rootId, 'name')));
      await this.autosaver.flush();
      this.startLive();
    } catch (error) {
      this.toast(tr('Не удалось открыть файл: {0}', error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  private saveFile(): void {
    const doc = this.editor.doc;
    const name = doc.get(doc.rootId, 'name').replace(/[\\/:*?"<>|]+/g, '_') || 'file';
    download(new Blob([serialize(doc)], { type: 'application/json' }), `${name}.csdoc.json`);
  }

  /**
   * Mod+Shift+E (FR-EXP-002): exports every layer of the page that has export
   * settings, in one archive; with nothing marked — the selection as PNG 2x.
   */
  private async exportSelection(): Promise<void> {
    const editor = this.editor;
    const marked: NodeId[] = [];
    editor.doc.store.walk(editor.pageId, (id) => {
      if (id !== editor.pageId && editor.doc.get(id, 'exportSettings').length > 0) marked.push(id);
    });
    const ids = marked.length > 0 ? marked : editor.topLevelSelection();
    if (ids.length === 0) {
      this.toast(tr('Нечего экспортировать: выделите слои или добавьте им настройки экспорта'));
      return;
    }
    try {
      const result = await renderExports(editor, this.canvas.renderer, ids, (id) => (editor.doc.get(id, 'exportSettings').length > 0 ? editor.doc.get(id, 'exportSettings') : [DEFAULT_EXPORT]));
      const packed = await packExports(editor, result);
      if (packed) download(packed.blob, packed.name);
      this.toast(marked.length > 0 ? tr('Экспортировано слоёв с настройками: {0}', marked.length) : tr('Выделение экспортировано (PNG 2x)'));
      for (const note of result.notes) this.toast(note);
    } catch (error) {
      this.toast(tr('Не удалось экспортировать: {0}', error instanceof Error ? error.message : String(error)), 'error');
    }
  }


  private applyUiScale(scale: number): void {
    const s = Math.min(1.25, Math.max(0.9, scale));
    this.root.style.setProperty('--ui', String(s));
    this.root.classList.toggle('ui-scaled', s !== 1);
  }

  /** Folds the right panel away (true) or opens it; remembered in this browser. */
  private foldRight(fold: boolean): void {
    if (this.board) return;
    this.root.classList.toggle('hide-right', fold);
    let hinted = true;
    try {
      localStorage.setItem(RIGHT_KEY, fold ? '1' : '0');
      hinted = localStorage.getItem(RIGHT_HINT_KEY) === '1';
      if (fold) localStorage.setItem(RIGHT_HINT_KEY, '1');
    } catch {
      // not remembered
    }
    // The first time only: where the panel went and how to get it back.
    if (fold && !hinted) this.toast(tr('Панель свёрнута. Вернуть — кнопкой справа вверху или {0}.', formatShortcut(this.commandMap.get('view.toggleRight')?.keys?.[0] ?? '')));
    this.contextBar.schedule();
  }

  /**
   * The name under one's stickies. Signed in — the account's name; a guest is
   * asked once (`again` — from the command, any time) and it stays in this browser.
   */
  private async askBoardName(again: boolean): Promise<void> {
    if (this.backend instanceof CloudBackend && this.backend.user) {
      if (again) this.toast(tr('Под стикерами — имя из аккаунта. Сменить: меню аккаунта на главной → «Изменить имя…».'));
      return;
    }
    // A guest by a link has an animal's name already; the command lets them change it.
    if (this.backend instanceof CloudBackend) {
      if (!again) return;
      const name = await askText({ title: tr('Как вас подписывать?'), label: tr('Имя'), value: this.editor.boardPrefs.author, confirm: tr('Готово'), maxLength: 40, hint: tr('Его видят все на доске: у курсора и под вашими стикерами.') });
      if (!name?.trim()) return;
      this.editor.boardPrefs.author = name.trim();
      try {
        localStorage.setItem('cs.guestName', name.trim());
      } catch {
        // for this visit only
      }
      this.toast(tr('Новое имя появится у курсора после переподключения, под новыми стикерами — сразу.'));
      return;
    }
    let asked = false;
    try {
      asked = localStorage.getItem(BOARD_NAME_KEY) !== null;
    } catch {
      asked = true;
    }
    if (asked && !again) return;
    const name = await askText({
      title: tr('Как подписывать ваши стикеры?'),
      label: tr('Имя'),
      value: this.editor.boardPrefs.author,
      placeholder: tr('Например, Аня'),
      confirm: tr('Готово'),
      maxLength: 40,
      allowEmpty: true,
      hint: tr('Его увидят под вашими стикерами. Можно оставить пустым и сменить потом: палитра команд → «Как подписывать мои стикеры…».'),
    });
    const value = (name ?? this.editor.boardPrefs.author).trim();
    this.editor.boardPrefs.author = value;
    try {
      localStorage.setItem(BOARD_NAME_KEY, value);
    } catch {
      // not remembered: asked again next time
    }
    this.canvas.focus();
  }

  private toggleUi(which: 'all' | 'left' | 'right'): void {
    // The right panel: the same as its buttons, remembered.
    if (which === 'right' && !this.diagramFile) return this.foldRight(!this.root.classList.contains('hide-right'));
    if (which === 'left' && this.board) {
      this.root.classList.toggle('hide-left');
      return;
    }
    // A diagram's panels (text, look) fold for this visit; a design's choice is not touched.
    if (this.diagramFile && which !== 'all') {
      this.root.classList.toggle(which === 'left' ? 'hide-left' : 'hide-right');
      return;
    }
    const cls = which === 'all' ? 'hide-ui' : 'hide-left';
    this.root.classList.toggle(cls);
  }

  private remeasureText(): void {
    this.measurer.reset();
    const doc = this.editor.doc;
    const texts: NodeId[] = [];
    for (const page of doc.pages()) {
      doc.store.walk(page, (id) => {
        if (doc.type(id) === 'TEXT') texts.push(id);
      });
    }
    if (texts.length === 0) return;
    doc.transact((tx) => applyLayout(doc, tx, texts, this.measurer), { undoable: false });
  }

  toast(message: string, kind: 'info' | 'error' = 'info', ms = 4000): void {
    const el = h('div', { class: `toast ${kind}` }, message);
    this.toasts.append(el);
    // Errors stay until dismissed (FR-UI-031).
    if (kind === 'error') {
      el.append(h('button', { class: 'toast-close', type: 'button', 'aria-label': tr('Закрыть'), onclick: () => el.remove() }, '×'));
      return;
    }
    let timer = setTimeout(() => el.remove(), ms);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => {
      timer = setTimeout(() => el.remove(), 1500);
    });
  }
}

/** Solid colours used in the file (fills, strokes, text), most frequent first. */
function documentColors(doc: Document): Color[] {
  const counts = new Map<string, { color: Color; n: number }>();
  const add = (c: Color) => {
    const key = colorToHex({ ...c, a: 1 });
    const cur = counts.get(key);
    if (cur) cur.n++;
    else counts.set(key, { color: { ...c, a: 1 }, n: 1 });
  };
  for (const page of doc.pages()) {
    doc.store.walk(page, (id) => {
      for (const p of [...doc.get(id, 'fills'), ...doc.get(id, 'strokes')]) if (p.type === 'SOLID' && p.visible) add(p.color);
    });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((x) => x.color);
}

/** Loads the fonts that ship with the editor; never blocks start-up for more than a few seconds. */
async function loadBundledFonts(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return;
  const loads = ['400 16px Inter', '700 16px Inter', 'italic 400 16px Inter'].map((font) => document.fonts.load(font, tr('AaЯя')));
  await Promise.race([Promise.allSettled(loads), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
