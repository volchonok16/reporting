// Home screen (file browser), as the start screen of Figma: on the left —
// Recents, Drafts, one's own projects and the teams with their projects; on the right — the files of the chosen
// section as cards with previews. A file opens in the editor at ?file=<id>
// (so it can be opened in a new tab and bookmarked); "New file" goes to
// ?new=1[&project=<id>].

import { brand, tr } from '#core';
import { loadBrandFonts } from '../t2-fonts.ts';
import { cloud, CloudError, teams as teamApi, type CloudUser, type FileBackend, type TeamInfo } from '../cloud.ts';
import { switchLayout } from '../keyboard.ts';
import type { FileMeta, ProjectMeta } from '../storage.ts';
import { localFilesToUpload, uploadLocalFiles } from '../transfer.ts';
import { ContextMenu, type MenuItem } from './context-menu.ts';
import { askConfirm, askText, showMessage } from './dialog.ts';
import { brandMark, clear, h, icon } from './dom.ts';
import { ago, kindLook } from './files-dialog.ts';
import { isPhone, onPhoneChange } from './touch.ts';

/** Where the editor opens a file, and where a new file is made. */
export function fileUrl(id: string): string {
  return `./?file=${encodeURIComponent(id)}`;
}

export type NewKind = 'design' | 'board' | 'diagram' | 'slides';

export function newFileUrl(projectId: string | null, kind: NewKind | boolean = 'design', template?: string): string {
  const k = kind === true ? 'board' : kind === false ? 'design' : kind;
  return `./?new=1${k === 'board' ? '&board=1' : k === 'diagram' ? '&diagram=1' : k === 'slides' ? '&slides=1' : ''}${template ? `&template=${encodeURIComponent(template)}` : ''}${projectId ? `&project=${encodeURIComponent(projectId)}` : ''}`;
}

const KIND_HINTS: Record<NewKind, string> = {
  design: 'Экраны, компоненты, прототипы',
  board: 'Стикеры и обсуждения — для работы вместе',
  diagram: 'Майнд-карты, блок-схемы, BPMN, Гант — по тексту',
  slides: 'Слайды с темами, показ с заметками',
};

/** One kind of new file to choose: a design, a board or a diagram. */
/** A small picture of what the kind of file looks like inside (drawn here, 64 × 44). */
const KIND_PICTURES: Record<NewKind, string> = {
  design:
    '<rect x="8" y="6" width="20" height="32" rx="3" fill="#fff" stroke="currentColor" stroke-width="1.5"/><rect x="12" y="11" width="12" height="7" rx="1.5" fill="currentColor" opacity=".35"/><rect x="12" y="21" width="12" height="2" rx="1" fill="currentColor" opacity=".5"/><rect x="12" y="25" width="8" height="2" rx="1" fill="currentColor" opacity=".35"/><rect x="36" y="6" width="20" height="32" rx="3" fill="#fff" stroke="currentColor" stroke-width="1.5"/><rect x="40" y="11" width="12" height="2" rx="1" fill="currentColor" opacity=".5"/><rect x="40" y="16" width="12" height="12" rx="2" fill="currentColor" opacity=".25"/><rect x="40" y="31" width="12" height="3" rx="1.5" fill="currentColor"/>',
  board:
    '<rect x="7" y="9" width="16" height="16" rx="1.5" fill="#FDE68A" transform="rotate(-6 15 17)"/><rect x="25" y="6" width="16" height="16" rx="1.5" fill="#FBCFE8" transform="rotate(4 33 14)"/><rect x="42" y="12" width="16" height="16" rx="1.5" fill="#BBF7D0" transform="rotate(-3 50 20)"/><rect x="18" y="26" width="16" height="13" rx="1.5" fill="#BFDBFE" transform="rotate(3 26 32)"/><path d="M38 34c4-1 8-4 10-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  slides:
    '<rect x="6" y="7" width="36" height="22" rx="2" fill="#fff" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="12" width="16" height="3" rx="1.5" fill="currentColor"/><rect x="10" y="18" width="22" height="2" rx="1" fill="currentColor" opacity=".45"/><rect x="10" y="22" width="14" height="2" rx="1" fill="currentColor" opacity=".45"/><rect x="46" y="7" width="12" height="7" rx="1.5" fill="#fff" stroke="currentColor" stroke-width="1.2"/><rect x="46" y="17" width="12" height="7" rx="1.5" fill="#fff" stroke="currentColor" stroke-width="1.2"/><rect x="46" y="27" width="12" height="7" rx="1.5" fill="#fff" stroke="currentColor" stroke-width="1.2"/><path d="M20 33v4M14 37h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  diagram:
    '<path d="M18 22h10M36 22l6-8M36 22l6 8" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="6" y="16" width="14" height="12" rx="3" fill="#fff" stroke="currentColor" stroke-width="1.5"/><rect x="27" y="16" width="10" height="12" rx="6" fill="currentColor"/><rect x="42" y="8" width="16" height="10" rx="2" fill="#fff" stroke="currentColor" stroke-width="1.5"/><rect x="42" y="26" width="16" height="10" rx="2" fill="#fff" stroke="currentColor" stroke-width="1.5"/>',
};

function identityOption(target: string | null): HTMLElement {
  return h(
    'a',
    { class: 'new-kind-option slides', role: 'menuitem', href: newFileUrl(target, 'slides', 'identity') },
    h('span', { class: 'new-kind-picture' }, icon('slides', 22)),
    h('span', { class: 'new-kind-text' }, h('strong', {}, tr('Новая айдентика')), h('span', {}, tr('Шаблон презентации репрайса'))),
    h('span', { class: 'new-kind-go', 'aria-hidden': 'true' }, icon('chevronRight', 14)),
  );
}

function kindOption(target: string | null, kind: NewKind): HTMLElement {
  const look = kindLook(kind === 'design' ? null : kind);
  const picture = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  picture.setAttribute('viewBox', '0 0 64 44');
  picture.setAttribute('aria-hidden', 'true');
  picture.innerHTML = KIND_PICTURES[kind];
  return h(
    'a',
    { class: `new-kind-option ${look.cls}`, role: 'menuitem', href: newFileUrl(target, kind) },
    h('span', { class: 'new-kind-picture' }, picture),
    h('span', { class: 'new-kind-text' }, h('strong', {}, look.name), h('span', {}, tr(KIND_HINTS[kind]))),
    h('span', { class: 'new-kind-go', 'aria-hidden': 'true' }, icon('chevronRight', 14)),
  );
}

type Section = { kind: 'recent' } | { kind: 'drafts' } | { kind: 'shared' } | { kind: 'sharedOut' } | { kind: 'project'; id: string } | { kind: 'team'; id: string };

/** Team roles that may make files and projects in the team. */
const canEditTeam = (t: TeamInfo | undefined) => !!t && t.role !== 'viewer' && t.role !== 'commenter';
const isTeamAdmin = (t: TeamInfo | undefined) => !!t && (t.role === 'owner' || t.role === 'admin');
const ROLE_SHORT: Record<string, string> = { editor: tr('редактирование'), commenter: tr('комментарии'), viewer: tr('просмотр') };

export interface HomeOptions {
  backend: FileBackend;
  /** Signed-in user; null — files in this browser. */
  user: CloudUser | null;
  /** A server is there to sign in to. */
  serverAvailable: boolean;
  signIn(): void;
  signOut(): void;
  /** Duplicates a stored file (the app knows how to rename it inside the document). */
  duplicate(id: string): Promise<void>;
  /** Opens a .csdoc.json file from disk as a new file. */
  importFromDisk(): void;
  /** Загружает .pptx как презентацию, без ручной перерисовки слайдов. */
  uploadPresentation(): void;
}

const SECTION_KEY = 'cs.home.section';
const FOLDED_KEY = 'cs.home.folded';

/** Kinds of files (design, board, diagram) whose section is folded on the start screen. */
function loadFoldedKinds(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? 'null') as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveFoldedKinds(kinds: Set<string>): void {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...kinds]));
  } catch {
    // private mode: folded until the page reloads
  }
}
/** Recents show the files touched lately, not the whole archive. */
const RECENT_LIMIT = 48;

export class Home {
  readonly el: HTMLElement;
  private readonly options: HomeOptions;
  private readonly menu: ContextMenu;
  private readonly nav: HTMLElement;
  private readonly main: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly banner: HTMLElement;
  private files: FileMeta[] = [];
  private projects: ProjectMeta[] = [];
  private teams: TeamInfo[] = [];
  private section: Section = { kind: 'recent' };

  constructor(root: HTMLElement, options: HomeOptions) {
    this.options = options;
    loadBrandFonts();
    this.menu = new ContextMenu(document.body);
    try {
      const saved = JSON.parse(sessionStorage.getItem(SECTION_KEY) ?? 'null') as Section | null;
      if (saved) this.section = saved;
    } catch {
      // default section
    }
    this.search = h('input', { class: 'home-search-input', type: 'search', placeholder: tr('Поиск файлов'), spellcheck: false, 'aria-label': tr('Поиск файлов') });
    this.search.addEventListener('input', () => this.renderMain());
    this.nav = h('nav', { class: 'home-nav', 'aria-label': tr('Разделы') });
    this.main = h('main', { class: 'home-main' });
    // Until the list arrives: grey cards where the files will be.
    this.main.append(
      h('div', { class: 'home-skeleton-title' }),
      h('div', { class: 'home-grid', 'aria-busy': 'true', 'aria-label': tr('Загружаю файлы…') }, ...Array.from({ length: 6 }, () => h('div', { class: 'home-skeleton-card' }, h('div', { class: 'home-skeleton-thumb' }), h('div', { class: 'home-skeleton-line' })))),
    );
    this.banner = h('div', { class: 'home-banner', hidden: true });
    const account = this.accountButton();
    const sidebar = h(
      'aside',
      { class: 'home-sidebar' },
      // The logo leads to the landing page: what the editor is, signing up (FEAT: one could not get back to it).
      h('a', { class: 'home-brand', href: '/?welcome', title: tr('О Симметрике: возможности и регистрация') }, brandMark(), h('span', {}, brand())),
      account,
      h('label', { class: 'home-search' }, icon('search', 14), this.search),
      this.nav,
      h(
        'div',
        { class: 'home-sidebar-footer' },
        h('button', { class: 'home-nav-item home-disk', type: 'button', onclick: () => options.importFromDisk() }, icon('folder', 16), h('span', {}, tr('Открыть с диска…'))),
        this.examplesButton(),
        // Signed in, the settings are in the account menu (with the name, sign-out…); a guest has no such menu.
        options.user ? null : h('button', { class: 'home-nav-item', type: 'button', onclick: () => this.openSettings() }, icon('sliders', 16), h('span', {}, tr('Настройки'))),
      ),
    );
    const content = h('div', { class: 'home-content' }, this.banner, this.main);
    this.el = h('div', { class: 'home' }, sidebar, content);
    // The pinned header gets a line under it once the list has scrolled beneath.
    content.addEventListener('scroll', () => this.main.querySelector('.home-header')?.classList.toggle('stuck', content.scrollTop > 4), { passive: true });
    try {
      this.applyUiScale(Number(localStorage.getItem('cs-ui-scale')) || 1);
    } catch {
      // the default size
    }
    root.replaceChildren(this.el);
    document.title = brand();
    // Coming back from the editor (browser "Back"): the list may have changed.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) void this.reload();
    });
    // Widened past a phone (or narrowed to one): «Новый файл» appears or goes.
    onPhoneChange(() => this.renderMain());
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== this.search && !(e.target as HTMLElement).closest('input, textarea')) {
        e.preventDefault();
        this.search.focus();
      }
    });
  }

  async reload(): Promise<void> {
    const { backend } = this.options;
    try {
      [this.files, this.projects, this.teams] = await Promise.all([
        backend.list(),
        backend.projects(),
        // Teams live on the server; without a network the files are still there.
        backend.kind === 'cloud' && this.options.user ? teamApi.list().catch(() => []) : Promise.resolve([]),
      ]);
    } catch (error) {
      this.files = [];
      this.projects = [];
      this.teams = [];
      this.main.replaceChildren(h('p', { class: 'home-empty' }, tr('Не удалось загрузить файлы: {0}', error instanceof Error ? error.message : String(error))));
      return;
    }
    if (this.section.kind === 'project' && !this.projects.some((p) => p.id === (this.section as { id: string }).id)) this.section = { kind: 'recent' };
    if (this.section.kind === 'team' && !this.teams.some((t) => t.id === (this.section as { id: string }).id)) this.section = { kind: 'recent' };
    this.renderNav();
    this.renderMain();
    void this.updateBanner();
  }

  private go(section: Section): void {
    this.section = section;
    this.search.value = '';
    try {
      sessionStorage.setItem(SECTION_KEY, JSON.stringify(section));
    } catch {
      // not remembered
    }
    this.renderNav();
    this.renderMain();
  }

  // ---------- files, projects and teams ----------

  /** The team a project belongs to; none — one's own project. */
  private teamOf(projectId: string | null | undefined): TeamInfo | undefined {
    const teamId = projectId ? this.projects.find((p) => p.id === projectId)?.teamId : undefined;
    return teamId ? this.teams.find((t) => t.id === teamId) : undefined;
  }

  /** Someone else's file, opened to this person by itself (not through a team). */
  private isShared(f: FileMeta): boolean {
    return !!f.role && f.role !== 'owner' && !this.teamOf(f.projectId);
  }

  /** One's own file others have access to (people, invitations or a link): "Shared by me". */
  private isSharedOut(f: FileMeta): boolean {
    return !!f.shared && !f.ownerName && (!f.role || f.role === 'owner');
  }

  /** One's own file outside the projects one sees (a team one has left included): Drafts. */
  private isDraft(f: FileMeta): boolean {
    return !this.isShared(f) && !f.ownerName && !this.projects.some((p) => p.id === f.projectId);
  }

  private teamFiles(teamId: string): FileMeta[] {
    return this.files.filter((f) => this.teamOf(f.projectId)?.id === teamId);
  }

  // ---------- sidebar ----------

  private accountButton(): HTMLElement {
    const { user, serverAvailable } = this.options;
    // Not signed in: a plain "Sign in" button and where the files are kept — not a "No sign-in" account.
    if (!user) {
      return h(
        'div',
        { class: 'home-guest' },
        serverAvailable ? h('button', { class: 'text-button primary home-signin', type: 'button', onclick: () => this.options.signIn() }, tr('Войти')) : '',
        h('small', {}, serverAvailable ? tr('Без входа файлы хранятся только в этом браузере. Войдите, чтобы открывать их с любого устройства и делиться.') : tr('Файлы хранятся в этом браузере.')),
      );
    }
    const label = user ? user.name || user.email : tr('Без входа');
    // Without a name the email is the label already: the line under it offers to add a name instead.
    const sub = user ? (user.name ? user.email : tr('Без имени')) : tr('Файлы только в этом браузере');
    const avatar = h('span', { class: `home-avatar${user ? ' signed-in' : ''}` }, (user?.name || user?.email || '·').trim().charAt(0).toUpperCase());
    const button = h('button', { class: 'home-account', type: 'button', 'aria-haspopup': 'menu' }, avatar, h('span', { class: 'home-account-text' }, h('strong', {}, label), h('small', {}, sub)), icon('chevronDown', 12));
    button.addEventListener('click', () => {
      const r = button.getBoundingClientRect();
      const items: MenuItem[] = user
        ? [
            { kind: 'action', label: tr('Настройки…'), run: () => this.openSettings() },
            { kind: 'action', label: tr('Изменить имя…'), run: () => void this.rename(user) },
            { kind: 'action', label: tr('Выйти'), run: () => this.options.signOut() },
            { kind: 'separator' },
            { kind: 'action', label: tr('Удалить аккаунт…'), run: () => void import('./account-delete.ts').then((m) => m.deleteAccount()) },
          ]
        : serverAvailable
          ? [{ kind: 'action', label: tr('Войти или зарегистрироваться…'), run: () => this.options.signIn() }]
          : [{ kind: 'action', label: tr('Сервера нет: файлы хранятся в этом браузере'), disabled: true, run: () => undefined }];
      this.menu.open(r.left, r.bottom + 4, items);
    });
    return button;
  }

  private openSettings(): void {
    void import('./settings-dialog.ts').then(({ SettingsDialog }) => new SettingsDialog({ onUiScale: (v) => this.applyUiScale(v) }));
  }

  /** «Открыть пример»: one of each kind, to see what it is before making one's own. */
  private examplesButton(): HTMLElement {
    const button = h('button', { class: 'home-nav-item', type: 'button', 'aria-haspopup': 'menu' }, icon('play', 16), h('span', {}, tr('Открыть пример')));
    button.addEventListener('click', () => {
      const r = button.getBoundingClientRect();
      const go = (q: string) => () => location.assign(`./?new=1${q}&example=1`);
      this.menu.open(r.left, r.top - 4, [
        { kind: 'action', label: tr('Холст: макеты приложения'), run: go('') },
        { kind: 'action', label: tr('Доска: ретро и блок-схема'), run: go('&board=1') },
        { kind: 'action', label: tr('Презентация: итоги запуска'), run: go('&slides=1') },
        { kind: 'action', label: tr('Схема: карта мыслей'), run: go('&diagram=1') },
      ]);
    });
    return button;
  }

  private navItem(label: string, iconName: string, section: Section, count?: number): HTMLElement {
    const active = sameSection(section, this.section);
    const item = h(
      'button',
      { class: `home-nav-item${active ? ' active' : ''}`, type: 'button', 'aria-current': active ? 'page' : undefined },
      icon(iconName, 16),
      h('span', { class: 'home-nav-label' }, label),
      count !== undefined ? h('span', { class: 'home-nav-count' }, String(count)) : '',
    );
    item.addEventListener('click', () => this.go(section));
    // Drop a file card here to move it (Drafts or a project).
    if (section.kind !== 'recent' && section.kind !== 'shared' && section.kind !== 'sharedOut' && section.kind !== 'team') {
      const target = section.kind === 'project' ? section.id : null;
      item.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('application/x-cs-file')) return;
        e.preventDefault();
        item.classList.add('drop');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop'));
      item.addEventListener('drop', (e) => {
        item.classList.remove('drop');
        const id = e.dataTransfer?.getData('application/x-cs-file');
        if (id) {
          e.preventDefault();
          void this.move(id, target);
        }
      });
    }
    return item;
  }

  private renderNav(): void {
    clear(this.nav);
    const drafts = this.files.filter((f) => this.isDraft(f)).length;
    const shared = this.files.filter((f) => this.isShared(f)).length;
    const sharedOut = this.files.filter((f) => this.isSharedOut(f)).length;
    this.nav.append(
      this.navItem(tr('Недавние'), 'clock', { kind: 'recent' }),
      this.navItem(tr('Без проекта'), 'page', { kind: 'drafts' }, drafts),
      ...(this.options.user ? [this.navItem(tr('Доступные мне'), 'link', { kind: 'shared' }, shared), this.navItem(tr('Доступные другим'), 'people', { kind: 'sharedOut' }, sharedOut)] : []),
      h(
        'div',
        { class: 'home-nav-heading' },
        h('span', {}, tr('Проекты')),
        h('button', { class: 'icon-button', type: 'button', title: tr('Новый проект'), 'aria-label': tr('Новый проект'), onclick: () => void this.createProject() }, icon('plus', 14)),
      ),
    );
    const own = this.projects.filter((p) => !p.teamId);
    if (own.length === 0) {
      this.nav.append(h('p', { class: 'home-nav-hint' }, tr('Проекты — папки для файлов: по продукту, клиенту или задаче.')));
    }
    for (const p of own) this.nav.append(this.projectItem(p));
    if (!this.options.user || this.options.backend.kind !== 'cloud') return;
    for (const t of this.teams) {
      const people = h('button', { class: 'icon-button', type: 'button', title: tr('Участники команды'), 'aria-label': tr('Участники команды «{0}»', t.name), onclick: () => void this.openTeam(t) }, icon('people', 14));
      const add = canEditTeam(t) ? h('button', { class: 'icon-button', type: 'button', title: tr('Новый проект команды'), 'aria-label': tr('Новый проект команды «{0}»', t.name), onclick: () => void this.createProject(undefined, t) }, icon('plus', 14)) : '';
      const active = this.section.kind === 'team' && this.section.id === t.id;
      const name = h('button', { class: `home-team-name${active ? ' active' : ''}`, type: 'button', title: tr('Все файлы команды'), 'aria-current': active ? 'page' : undefined, onclick: () => this.go({ kind: 'team', id: t.id }) }, t.name);
      const heading = h('div', { class: 'home-nav-heading home-team-heading' }, name, h('span', { class: 'home-team-actions' }, people, add));
      heading.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.menu.open(e.clientX, e.clientY, this.teamMenu(t));
      });
      this.nav.append(heading);
      const projects = this.projects.filter((p) => p.teamId === t.id);
      if (projects.length === 0) this.nav.append(h('p', { class: 'home-nav-hint' }, canEditTeam(t) ? tr('Создайте проект — его файлы увидят все в команде.') : tr('Проектов пока нет.')));
      for (const p of projects) this.nav.append(this.projectItem(p));
    }
    this.nav.append(h('button', { class: 'home-nav-item home-new-team', type: 'button', onclick: () => void this.createTeam() }, icon('people', 16), h('span', {}, tr('Создать команду'))));
  }

  private projectItem(p: ProjectMeta): HTMLElement {
    const count = this.files.filter((f) => f.projectId === p.id).length;
    const item = this.navItem(p.name, 'folder', { kind: 'project', id: p.id }, count);
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.menu.open(e.clientX, e.clientY, this.projectMenu(p));
    });
    return item;
  }

  /** Interface size from the settings: the sidebar and the file list grow or shrink, as the editor's panels do. */
  private applyUiScale(scale: number): void {
    const s = Math.min(1.25, Math.max(0.9, scale));
    this.el.style.setProperty('--ui', String(s));
    this.el.classList.toggle('ui-scaled', s !== 1);
  }

  // ---------- main area ----------

  private renderMain(): void {
    clear(this.main);
    const q = this.search.value.trim().toLowerCase();
    const alt = switchLayout(q);
    let title: string;
    let files: FileMeta[];
    let project: ProjectMeta | undefined;
    let team: TeamInfo | undefined;
    if (q) {
      title = tr('Результаты поиска');
      files = this.files.filter((f) => f.name.toLowerCase().includes(q) || f.name.toLowerCase().includes(alt));
    } else if (this.section.kind === 'recent') {
      title = tr('Недавние');
      files = this.files.slice(0, RECENT_LIMIT);
    } else if (this.section.kind === 'drafts') {
      title = tr('Без проекта');
      files = this.files.filter((f) => this.isDraft(f));
    } else if (this.section.kind === 'shared') {
      title = tr('Доступные мне');
      files = this.files.filter((f) => this.isShared(f));
    } else if (this.section.kind === 'sharedOut') {
      title = tr('Доступные другим');
      files = this.files.filter((f) => this.isSharedOut(f));
    } else if (this.section.kind === 'team') {
      team = this.teams.find((t) => t.id === (this.section as { id: string }).id);
      title = team?.name ?? tr('Команда');
      files = team ? this.teamFiles(team.id) : [];
    } else {
      const id = this.section.id;
      project = this.projects.find((p) => p.id === id);
      title = project?.name ?? tr('Проект');
      files = this.files.filter((f) => f.projectId === id);
    }
    const target = this.section.kind === 'project' && !q ? this.section.id : null;
    // In a team where one only views or comments, nothing is made.
    const projectTeam = project ? this.teamOf(project.id) : undefined;
    const canCreate = project?.teamId ? canEditTeam(projectTeam) : !team;
    const heading = h('h1', { class: 'home-title' }, title);
    if (project && (!project.teamId || canEditTeam(projectTeam))) {
      const p = project;
      heading.title = tr('Дважды щёлкните, чтобы переименовать');
      heading.addEventListener('dblclick', () => this.renameInPlace(heading, p.name, (v) => this.renameProject(p.id, v)));
    }
    const phone = isPhone();
    const header = h(
      'header',
      { class: 'home-header' },
      heading,
      project && this.projectMenu(project).length > 0 ? h('button', { class: 'icon-button', type: 'button', title: tr('Проект: переименовать, удалить'), 'aria-label': tr('Действия с проектом'), onclick: (e: MouseEvent) => this.menu.open(e.clientX, e.clientY, this.projectMenu(project!)) }, icon('menu', 16)) : '',
      team ? h('button', { class: 'icon-button', type: 'button', title: tr('Команда: переименовать, выйти, удалить'), 'aria-label': tr('Действия с командой'), onclick: (e: MouseEvent) => this.menu.open(e.clientX, e.clientY, this.teamMenu(team!)) }, icon('menu', 16)) : '',
      projectTeam && !q ? h('span', { class: 'home-header-team' }, projectTeam.name) : '',
      h('span', { class: 'home-header-spacer' }),
      team ? h('button', { class: 'text-button', type: 'button', onclick: () => void this.openTeam(team!) }, icon('people', 14), h('span', {}, tr('Участники: {0}', team.members.length))) : '',
      team && canEditTeam(team) && !phone ? h('button', { class: 'text-button primary home-new', type: 'button', onclick: () => void this.createProject(undefined, team) }, icon('plus', 14), h('span', {}, tr('Новый проект'))) : '',
      // On a phone files are only viewed: nothing to create there.
      // One button; what kind of file — a design or a board — is chosen under it.
      phone || !canCreate ? '' : h('button', { class: 'text-button home-new', type: 'button', title: tr('Файл PowerPoint станет презентацией: слайды, тексты и картинки переносятся как есть'), onclick: () => this.options.uploadPresentation() }, h('span', {}, tr('Загрузить презентацию'))),
      phone || !canCreate ? '' : this.newFileButton(target, project ? tr('Новый файл в проекте') : tr('Новый файл')),
    );
    this.main.append(header);
    if (files.length === 0) {
      this.main.append(
        h(
          'div',
          { class: 'home-empty' },
          h('p', {}, q ? tr('Ничего не найдено.') : this.emptyText(project, team, canCreate)),
          q || this.section.kind === 'shared' || this.section.kind === 'sharedOut' || team || !canCreate
            ? ''
            : phone
              ? h('p', {}, tr('Создавать и править файлы можно на компьютере или планшете.'))
              : h('div', { class: 'home-empty-actions new-kind-list' }, kindOption(target, 'design'), kindOption(target, 'slides'), identityOption(target), kindOption(target, 'board'), kindOption(target, 'diagram')),
        ),
      );
      return;
    }
    // Designs, presentations, boards and diagrams apart, each under its heading (one kind only — no headings).
    const showProject = this.section.kind === 'recent' || this.section.kind === 'sharedOut' || this.section.kind === 'team' || !!q;
    const groups: { kind: NewKind; title: string }[] = [
      { kind: 'design', title: tr('Макеты') },
      { kind: 'slides', title: tr('Презентации') },
      { kind: 'board', title: tr('Доски') },
      { kind: 'diagram', title: tr('Схемы') },
    ];
    const kindOf = (f: FileMeta) => f.kind ?? 'design';
    const present = groups.filter((g) => files.some((f) => kindOf(f) === g.kind));
    const foldedKinds = loadFoldedKinds();
    for (const g of present) {
      const list = files.filter((f) => kindOf(f) === g.kind);
      const grid = h('div', { class: 'home-grid', role: 'list', 'aria-label': g.title });
      for (const f of list) grid.append(this.card(f, showProject));
      if (present.length > 1) {
        // A heading folds its files away; remembered in this browser. While searching, everything shows.
        const folded = !q && foldedKinds.has(g.kind);
        const chevron = h('span', { class: 'home-group-chevron', 'aria-hidden': 'true' }, icon(folded ? 'chevronRight' : 'chevronDown', 14));
        const toggle = h(
          'button',
          { class: 'home-group-toggle', type: 'button', disabled: !!q, 'aria-expanded': String(!folded), title: folded ? tr('Развернуть раздел') : tr('Свернуть раздел') },
          chevron,
          h('span', { class: `home-kind-mark ${g.kind}`, 'aria-hidden': 'true' }, icon(kindLook(g.kind === 'design' ? null : g.kind).icon, 11)),
          h('span', {}, g.title),
          h('span', { class: 'home-group-count' }, String(list.length)),
        );
        grid.hidden = folded;
        toggle.addEventListener('click', () => {
          const fold = !grid.hidden;
          grid.hidden = fold;
          if (fold) foldedKinds.add(g.kind);
          else foldedKinds.delete(g.kind);
          saveFoldedKinds(foldedKinds);
          toggle.setAttribute('aria-expanded', String(!fold));
          toggle.title = fold ? tr('Развернуть раздел') : tr('Свернуть раздел');
          chevron.replaceChildren(icon(fold ? 'chevronRight' : 'chevronDown', 14));
        });
        this.main.append(h('h2', { class: `home-group-title ${g.kind}` }, toggle));
      }
      this.main.append(grid);
    }
  }

  /** What an empty section is for and what to do there, in one line. */
  private emptyText(project: ProjectMeta | undefined, team: TeamInfo | undefined, canCreate: boolean): string {
    if (this.section.kind === 'sharedOut') return tr('Здесь появятся ваши файлы, к которым вы открыли доступ другим людям: по приглашению или по ссылке. Откройте файл и нажмите «Поделиться».');
    if (this.section.kind === 'shared') return tr('Здесь появятся файлы, к которым вам откроют доступ: по приглашению на ваш email или по ссылке.');
    if (team) {
      if (this.projects.some((p) => p.teamId === team.id)) return tr('В проектах команды пока нет файлов.');
      return canEditTeam(team) ? tr('В команде пока нет проектов. Создайте проект — его файлы увидят все в команде.') : tr('В команде пока нет проектов: их создают редакторы команды.');
    }
    if (project) return canCreate ? tr('В проекте пока нет файлов. Создайте новый или перетащите сюда файл из «Недавних».') : tr('В проекте пока нет файлов.');
    if (this.section.kind === 'drafts') return tr('Файлов без проекта нет. Новые файлы попадают сюда, пока вы не перенесёте их в проект.');
    return tr('Файлов пока нет.');
  }

  private closeChooser: (() => void) | null = null;

  /** "New file": a small choice under the button — a design or a board. */
  private newFileButton(target: string | null, label: string): HTMLElement {
    const button = h('button', { class: 'text-button primary home-new', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('plus', 14), h('span', {}, label));
    button.addEventListener('click', () => {
      if (this.closeChooser) {
        this.closeChooser();
        return;
      }
      const pop = h('div', { class: 'new-kind-popover new-kind-list', role: 'menu', 'aria-label': label }, h('div', { class: 'new-kind-title' }, label), kindOption(target, 'design'), kindOption(target, 'slides'), identityOption(target), kindOption(target, 'board'), kindOption(target, 'diagram'));
      document.body.append(pop);
      const r = button.getBoundingClientRect();
      pop.style.top = `${r.bottom + 6}px`;
      pop.style.right = `${Math.max(8, innerWidth - r.right)}px`;
      button.setAttribute('aria-expanded', 'true');
      const outside = (e: Event) => {
        if (!pop.contains(e.target as Node) && !button.contains(e.target as Node)) close();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          close();
          button.focus();
        }
      };
      const close = () => {
        pop.remove();
        button.setAttribute('aria-expanded', 'false');
        removeEventListener('pointerdown', outside, true);
        removeEventListener('keydown', onKey, true);
        this.closeChooser = null;
      };
      addEventListener('pointerdown', outside, true);
      addEventListener('keydown', onKey, true);
      this.closeChooser = close;
      pop.querySelector<HTMLElement>('a')?.focus();
    });
    return button;
  }

  private card(f: FileMeta, showProject: boolean): HTMLElement {
    const projectName = f.projectId ? this.projects.find((p) => p.id === f.projectId)?.name : null;
    const shared = this.isShared(f);
    const thumb = f.thumb
      ? h('img', { class: 'home-thumb-img', src: f.thumb, alt: '', loading: 'lazy', draggable: false })
      : h('span', { class: 'home-thumb-empty' }, icon(kindLook(f.kind).icon, 28));
    const look = kindLook(f.kind);
    const board = f.kind === 'board';
    // What the file is, at a glance: a coloured mark by the name and a label on the picture.
    const name = h('span', { class: 'home-card-name' }, h('span', { class: `home-kind-mark ${look.cls}`, 'aria-hidden': 'true' }, icon(look.icon, 11)), h('span', { class: 'home-card-title' }, f.name || tr('Без названия')));
    const more = h('button', { class: 'icon-button home-card-more', type: 'button', title: tr('Действия'), 'aria-label': tr('Действия с файлом «{0}»', f.name) }, icon('menu', 14));
    const link = h(
      'a',
      { class: 'home-card', href: fileUrl(f.id), role: 'listitem', draggable: f.role === undefined || f.role === 'owner', title: tr('Создан {0}', ago(f.createdAt)) },
      h('span', { class: `home-thumb${board ? ' board' : ''}` }, thumb),
      h(
        'span',
        { class: 'home-card-text' },
        name,
        h('span', { class: 'home-card-meta' }, shared ? `${f.ownerName || tr('Чужой файл')} · ${ROLE_SHORT[f.role!] ?? ''}` : tr('{0}изменён {1}', showProject ? `${projectName ?? tr('Без проекта')} · ` : '', ago(f.savedAt))),
        f.branches ? h('span', { class: 'home-card-branches', title: tr('Ветки открываются из файла: «Файл → Ветки…»') }, icon('branch', 11), tr('Веток: {0}', f.branches)) : '',
      ),
      f.restricted
        ? h('span', { class: 'home-card-badge', title: tr('Ограниченный файл: команда его не видит, только приглашённые и админы') }, icon('lock', 12))
        : f.shared && !shared
          ? h('span', { class: 'home-card-badge', title: tr('Файлом поделились: есть люди с доступом или ссылка') }, icon('link', 12))
          : '',
      more,
    );
    link.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('application/x-cs-file', f.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    link.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.home-card-more, input')) e.preventDefault();
    });
    const openMenu = (x: number, y: number) => this.menu.open(x, y, this.fileMenu(f, name));
    more.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4);
    });
    link.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(e.clientX, e.clientY);
    });
    return link;
  }

  private fileMenu(f: FileMeta, nameEl: HTMLElement): MenuItem[] {
    const team = this.teamOf(f.projectId);
    // A team file one does not manage: open, rename (editors), copy.
    if (team && f.role && f.role !== 'owner') {
      return [
        { kind: 'action', label: tr('Открыть'), run: () => location.assign(fileUrl(f.id)) },
        { kind: 'action', label: tr('Открыть в новой вкладке'), run: () => window.open(fileUrl(f.id), '_blank') },
        ...this.shareItem(f),
        ...(f.role === 'editor' ? [{ kind: 'action', label: tr('Переименовать'), run: () => this.renameInPlace(nameEl, f.name, (v) => this.renameFile(f.id, v)) } as MenuItem] : []),
        { kind: 'action', label: tr('Сделать копию себе'), run: () => void this.act(() => this.options.duplicate(f.id)) },
      ];
    }
    if (this.isShared(f)) {
      return [
        { kind: 'action', label: tr('Открыть'), run: () => location.assign(fileUrl(f.id)) },
        { kind: 'action', label: tr('Открыть в новой вкладке'), run: () => window.open(fileUrl(f.id), '_blank') },
        ...this.shareItem(f),
        ...(f.role === 'editor' ? [{ kind: 'action', label: tr('Переименовать'), run: () => this.renameInPlace(nameEl, f.name, (v) => this.renameFile(f.id, v)) } as MenuItem] : []),
        { kind: 'action', label: tr('Сделать копию себе'), run: () => void this.act(() => this.options.duplicate(f.id)) },
        { kind: 'separator' },
        { kind: 'action', label: tr('Убрать из моих файлов…'), run: () => void this.leave(f) },
      ];
    }
    // Another person's team file (managed as an admin) moves only within teams: their own projects are theirs.
    const mine = !f.ownerName;
    const own = mine ? this.projects.filter((p) => !p.teamId) : [];
    const teamMenus = this.teams
      .filter((t) => canEditTeam(t) && this.projects.some((p) => p.teamId === t.id))
      .map((t): MenuItem => ({
        kind: 'submenu',
        label: t.name,
        items: this.projects.filter((p) => p.teamId === t.id).map((p): MenuItem => ({ kind: 'action', label: p.name, disabled: f.projectId === p.id, run: () => void this.move(f.id, p.id) })),
      }));
    const moveItems: MenuItem[] = [
      { kind: 'action', label: mine ? tr('Без проекта') : tr('Без проекта (у автора)'), disabled: !f.projectId, run: () => void this.move(f.id, null) },
      ...(own.length > 0 ? [{ kind: 'separator' } as MenuItem] : []),
      ...own.map((p): MenuItem => ({ kind: 'action', label: p.name, disabled: f.projectId === p.id, run: () => void this.move(f.id, p.id) })),
      ...(teamMenus.length > 0 ? [{ kind: 'separator' } as MenuItem, ...teamMenus] : []),
      ...(mine ? [{ kind: 'separator' } as MenuItem, { kind: 'action', label: tr('Новый проект…'), run: () => void this.createProject(f.id) } as MenuItem] : []),
    ];
    return [
      { kind: 'action', label: tr('Открыть'), run: () => location.assign(fileUrl(f.id)) },
      { kind: 'action', label: tr('Открыть в новой вкладке'), run: () => window.open(fileUrl(f.id), '_blank') },
      { kind: 'separator' },
      ...this.shareItem(f),
      { kind: 'action', label: tr('Переименовать'), run: () => this.renameInPlace(nameEl, f.name, (v) => this.renameFile(f.id, v)) },
      { kind: 'action', label: tr('Дублировать'), run: () => void this.act(() => this.options.duplicate(f.id)) },
      { kind: 'submenu', label: tr('Переместить в'), items: moveItems },
      { kind: 'separator' },
      { kind: 'action', label: tr('Удалить…'), run: () => void this.removeFile(f) },
    ];
  }

  /** «Поделиться…» without opening the file: server files the person owns or edits (as the button in the editor). */
  private shareItem(f: FileMeta): MenuItem[] {
    const can = this.options.backend.kind === 'cloud' && !!this.options.user && (!f.role || f.role === 'owner' || f.role === 'editor');
    if (!can) return [];
    const open = () =>
      void import('./share-dialog.ts').then(({ ShareDialog }) => {
        new ShareDialog({ fileId: f.id, fileName: f.name, page: '', node: null, nodeName: null, board: f.kind === 'board', toast: (m) => this.toast(m) });
      });
    return [{ kind: 'action', label: tr('Поделиться…'), run: open }];
  }

  private projectMenu(p: ProjectMeta): MenuItem[] {
    const team = p.teamId ? this.teams.find((t) => t.id === p.teamId) : undefined;
    const edit = !p.teamId || canEditTeam(team);
    const remove = !p.teamId || isTeamAdmin(team);
    if (!edit) return [];
    return [
      {
        kind: 'submenu',
        label: tr('Новый файл в проекте'),
        items: [
          { kind: 'action', label: tr('Макет'), run: () => location.assign(newFileUrl(p.id)) },
          { kind: 'action', label: tr('Доска'), run: () => location.assign(newFileUrl(p.id, 'board')) },
          { kind: 'action', label: tr('Схема'), run: () => location.assign(newFileUrl(p.id, 'diagram')) },
        ],
      },
      { kind: 'action', label: tr('Переименовать…'), run: () => void this.promptRenameProject(p) },
      ...(remove ? [{ kind: 'separator' } as MenuItem, { kind: 'action', label: tr('Удалить проект…'), run: () => void this.removeProject(p) } as MenuItem] : []),
    ];
  }

  private teamMenu(t: TeamInfo): MenuItem[] {
    return [
      { kind: 'action', label: tr('Участники…'), run: () => void this.openTeam(t) },
      ...(canEditTeam(t) ? [{ kind: 'action', label: tr('Новый проект…'), run: () => void this.createProject(undefined, t) } as MenuItem] : []),
      ...(isTeamAdmin(t) ? [{ kind: 'action', label: tr('Переименовать…'), run: () => void this.promptRenameTeam(t) } as MenuItem] : []),
      { kind: 'separator' },
      t.role === 'owner' ? { kind: 'action', label: tr('Удалить команду…'), run: () => void this.removeTeam(t) } : { kind: 'action', label: tr('Выйти из команды…'), run: () => void this.leaveTeam(t) },
    ];
  }

  // ---------- actions ----------

  /** Runs a change, then shows the fresh list; errors are shown, not thrown. */
  private async act(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.toast(tr('Не получилось: {0}', error instanceof Error ? error.message : String(error)));
    }
    await this.reload();
  }

  private move(id: string, projectId: string | null): Promise<void> {
    const name = projectId ? this.projects.find((p) => p.id === projectId)?.name : null;
    return this.act(async () => {
      await this.options.backend.move(id, projectId);
      this.toast(name === null ? tr('Файл убран из проекта') : tr('Перемещено в «{0}»', name));
    });
  }

  private renameFile(id: string, name: string): Promise<void> {
    return this.act(() => this.options.backend.rename(id, name));
  }

  private renameProject(id: string, name: string): Promise<void> {
    return this.act(() => this.options.backend.renameProject(id, name));
  }

  private async removeFile(f: FileMeta): Promise<void> {
    const where = this.options.user ? tr('с сервера') : tr('из этого браузера');
    const ok = await askConfirm({ title: tr('Удалить файл?'), message: tr('Файл «{0}» будет удалён {1}. Это нельзя отменить.', f.name, where), confirm: tr('Удалить'), danger: true });
    if (!ok) return;
    await this.act(() => this.options.backend.remove(f.id));
  }

  private async leave(f: FileMeta): Promise<void> {
    const ok = await askConfirm({
      title: tr('Убрать файл из ваших?'),
      message: tr('Вы откажетесь от доступа к «{0}». Файл останется у владельца{1}; вернуть доступ сможет только он.', f.name, f.ownerName ? ` (${f.ownerName})` : ''),
      confirm: tr('Убрать'),
      danger: true,
    });
    if (ok) await this.act(() => this.options.backend.leave(f.id));
  }

  private async createProject(moveFileId?: string, team?: TeamInfo): Promise<void> {
    const name = await askText({
      title: team ? tr('Новый проект в «{0}»', team.name) : tr('Новый проект'),
      label: tr('Название'),
      value: tr('Новый проект'),
      confirm: tr('Создать'),
      hint: moveFileId ? tr('Файл сразу переместится в новый проект.') : team ? tr('Файлы проекта увидят все в команде.') : tr('Проект — папка для файлов: по продукту, клиенту или задаче.'),
    });
    if (!name) return;
    await this.act(async () => {
      const project = await this.options.backend.createProject(name, team?.id);
      if (moveFileId) await this.options.backend.move(moveFileId, project.id);
      this.section = { kind: 'project', id: project.id };
      sessionStorage.setItem(SECTION_KEY, JSON.stringify(this.section));
    });
  }

  private async promptRenameProject(p: ProjectMeta): Promise<void> {
    const name = await askText({ title: tr('Переименовать проект'), label: tr('Название'), value: p.name, confirm: tr('Переименовать') });
    if (name && name !== p.name) await this.renameProject(p.id, name);
  }

  private async removeProject(p: ProjectMeta): Promise<void> {
    const count = this.files.filter((f) => f.projectId === p.id).length;
    const files = count > 0 ? tr(' Файлы ({0}) не удалятся — они перейдут в раздел «Без проекта».', count) : '';
    const ok = await askConfirm({ title: tr('Удалить проект?'), message: tr('Проект «{0}» будет удалён.{1}', p.name, files), confirm: tr('Удалить проект'), danger: true });
    if (!ok) return;
    await this.act(() => this.options.backend.removeProject(p.id));
  }

  private async createTeam(): Promise<void> {
    const name = await askText({ title: tr('Новая команда'), label: tr('Название'), value: '', placeholder: tr('Например, «Дизайн» или название компании'), confirm: tr('Создать'), hint: tr('Следующим шагом пригласите людей по email.') });
    if (!name) return;
    const made: { team?: TeamInfo } = {};
    await this.act(async () => {
      made.team = await teamApi.create(name);
      this.section = { kind: 'team', id: made.team.id };
      sessionStorage.setItem(SECTION_KEY, JSON.stringify(this.section));
    });
    // Next step right away: whom to invite.
    if (made.team) await this.openTeam(made.team);
  }

  private async openTeam(t: TeamInfo): Promise<void> {
    const { TeamDialog } = await import('./team-dialog.ts');
    new TeamDialog({
      team: t,
      me: this.options.user!.id,
      toast: (m) => this.toast(m),
      // Roles or people changed: projects, files and counts may change too.
      changed: () => void this.reload(),
      left: () => {
        this.section = { kind: 'recent' };
        void this.reload();
      },
    });
  }

  private async promptRenameTeam(t: TeamInfo): Promise<void> {
    const name = await askText({ title: tr('Переименовать команду'), label: tr('Название'), value: t.name, confirm: tr('Переименовать') });
    if (name && name !== t.name) await this.act(() => teamApi.rename(t.id, name));
  }

  private async removeTeam(t: TeamInfo): Promise<void> {
    const count = this.teamFiles(t.id).length;
    const ok = await askConfirm({
      title: tr('Удалить команду?'),
      message: tr('Команда «{0}» и её проекты будут удалены, участники потеряют доступ.{1}', t.name, count > 0 ? tr(' Файлы ({0}) не удалятся — каждый перейдёт в раздел «Без проекта» того, кто его создал.', count) : ''),
      confirm: tr('Удалить команду'),
      danger: true,
    });
    if (!ok) return;
    await this.act(() => teamApi.remove(t.id));
  }

  /** The name others see in files, comments and invitations; empty — they see the email address. */
  private async rename(user: CloudUser): Promise<void> {
    const name = await askText({ title: tr('Ваше имя'), label: tr('Имя (необязательно)'), value: user.name, placeholder: user.email, maxLength: 80, allowEmpty: true, hint: tr('Его видят те, с кем вы работаете над файлами. Без имени они видят ваш email.') });
    if (name === null || name === user.name) return;
    try {
      await cloud.rename(name);
      location.reload();
    } catch (err) {
      await showMessage({ title: tr('Не удалось сохранить имя'), message: err instanceof CloudError ? err.message : tr('Не получилось. Проверьте связь и попробуйте ещё раз.') });
    }
  }

  private async leaveTeam(t: TeamInfo): Promise<void> {
    const ok = await askConfirm({
      title: tr('Выйти из команды?'),
      message: tr('Файлы команды «{0}» перестанут быть вам доступны (кроме созданных вами — они останутся в ваших). Вернуться можно по новому приглашению.', t.name),
      confirm: tr('Выйти'),
      danger: true,
    });
    if (!ok) return;
    await this.act(() => teamApi.removeMember(t.id, this.options.user!.id));
  }

  /** Turns a label into a text field; Enter or leaving saves, Esc cancels. */
  private renameInPlace(label: HTMLElement, value: string, save: (v: string) => Promise<void>): void {
    const input = h('input', { class: 'home-rename', type: 'text', value, spellcheck: false, 'aria-label': tr('Новое название') });
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (ok && v && v !== value) void save(v);
      else input.replaceWith(label);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('click', (e) => e.preventDefault());
    input.addEventListener('blur', () => finish(true));
  }

  /** Signed in with files left in this browser: offer to take them to the server. */
  private async updateBanner(): Promise<void> {
    const { backend } = this.options;
    if ((backend as { offline?: boolean }).offline) {
      this.banner.hidden = false;
      const retry = h('button', { class: 'text-button', type: 'button', onclick: () => void this.reload() }, tr('Проверить снова'));
      this.banner.replaceChildren(h('span', {}, tr('Нет связи с сервером. Показаны файлы, открывавшиеся в этом браузере, — их можно открыть и править, правки отправятся при подключении.')), retry);
      return;
    }
    const count = (await localFilesToUpload(backend).catch(() => [])).length;
    this.banner.hidden = count === 0;
    if (count === 0) return;
    const go = h('button', { class: 'text-button', type: 'button' }, tr('Перенести на сервер'));
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = tr('Переносим…');
      const result = await uploadLocalFiles(backend);
      for (const e of result.errors) this.toast(e);
      this.toast(tr('Перенесено на сервер: {0}. В браузере они тоже остались.', result.done));
      await this.reload();
    });
    const dismiss = h('button', { class: 'icon-button', type: 'button', 'aria-label': tr('Закрыть'), style: 'margin-left: auto; flex-shrink: 0' }, '×');
    dismiss.addEventListener('click', () => { this.banner.hidden = true; });
    this.banner.replaceChildren(h('span', {}, tr('В этом браузере есть файлы, созданные без входа: {0}.', count)), go, dismiss);
  }

  toast(message: string, ms = 4000): void {
    let box = document.querySelector<HTMLElement>('.toasts');
    if (!box) {
      box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(box);
    }
    const el = h('div', { class: 'toast info' }, message);
    box.append(el);
    setTimeout(() => el.remove(), ms);
  }

  clearToasts(): void {
    document.querySelector('.toasts')?.replaceChildren();
  }
}

function sameSection(a: Section, b: Section): boolean {
  return a.kind === b.kind && (!('id' in a) || a.id === (b as { id: string }).id);
}

