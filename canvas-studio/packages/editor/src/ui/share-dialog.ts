// "Share" dialog (ТЗ 3.4), as in Figma: invite people by email with a role,
// see who has access and change or take it away, and set up the link —
// invite-only, everyone in a team or anyone with the link, its role, password
// and expiry; the link can point at the selected layer (FR-ACL-013). A team
// file can be restricted: the team stops seeing it (FR-ACL-006).

import { locale, tr } from '#core';
import { CloudError, sharing, type GrantRole, type LinkMode, type ShareInfo } from '../cloud.ts';
import { askConfirm } from './dialog.ts';
import { clear, h, icon, skeletonRows } from './dom.ts';

const ROLE_LABELS: Record<GrantRole, string> = {
  editor: tr('может редактировать'),
  commenter: tr('может комментировать'),
  viewer: tr('может смотреть'),
};

export interface ShareTarget {
  fileId: string;
  fileName: string;
  /** Page and selected layer, for a link straight to it. */
  page: string;
  node: string | null;
  nodeName: string | null;
  /** A board: an open link may let guests without an account edit (FEAT-088). */
  board?: boolean;
  toast(message: string, kind?: 'info' | 'error'): void;
}

function roleSelect(value: GrantRole, onChange: (role: GrantRole) => void, label: string): HTMLSelectElement {
  const select = h('select', { class: 'share-select', 'aria-label': label });
  for (const role of ['editor', 'commenter', 'viewer'] as const) select.append(h('option', { value: role, selected: role === value }, ROLE_LABELS[role]));
  select.addEventListener('change', () => onChange(select.value as GrantRole));
  return select;
}

function initial(text: string): string {
  return (text.trim().charAt(0) || '·').toUpperCase();
}

export class ShareDialog {
  private readonly target: ShareTarget;
  private readonly overlay: HTMLElement;
  private readonly body: HTMLElement;
  private readonly error: HTMLElement;
  private info: ShareInfo | null = null;
  private linkToNode = false;

  constructor(target: ShareTarget) {
    this.target = target;
    this.body = h('div', { class: 'share-body' }, skeletonRows(tr('Загружаю настройки доступа…'), 3, true));
    this.error = h('p', { class: 'dialog-error', role: 'alert' });
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog share-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Поделиться «{0}»', target.fileName) },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Поделиться «{0}»', target.fileName)), close),
      this.body,
      h('div', { class: 'share-error' }, this.error),
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
    void this.load();
  }

  close(): void {
    this.overlay.remove();
  }

  private async load(): Promise<void> {
    await this.run(() => sharing.get(this.target.fileId));
  }

  /** Runs a change on the server and shows the fresh state (or the error). */
  private async run(fn: () => Promise<ShareInfo>): Promise<boolean> {
    this.error.textContent = '';
    try {
      this.info = await fn();
      if (this.info.mailFailed) this.target.toast(tr('Доступ выдан, но письмо не отправилось. Пришлите ссылку сами.'), 'error');
      this.render();
      return true;
    } catch (error) {
      this.error.textContent = error instanceof CloudError ? error.message : tr('Не получилось. Проверьте связь и попробуйте ещё раз.');
      return false;
    }
  }

  private render(): void {
    const info = this.info;
    if (!info) return;
    const id = this.target.fileId;
    clear(this.body);

    // Invite by email.
    const email = h('input', { class: 'dialog-input share-email', type: 'email', placeholder: tr('Email коллеги'), 'aria-label': 'Email', autocomplete: 'off', spellcheck: false });
    let role: GrantRole = 'editor';
    const inviteRole = roleSelect(role, (r) => (role = r), tr('Роль для приглашения'));
    const invite = h('button', { class: 'text-button primary', type: 'submit' }, tr('Пригласить'));
    const form = h('form', { class: 'share-invite', novalidate: true }, email, inviteRole, invite);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        this.error.textContent = tr('Проверьте email');
        email.focus();
        return;
      }
      invite.disabled = true;
      if (await this.run(() => sharing.invite(id, value, role))) this.target.toast(tr('Приглашение отправлено: {0}', value));
      invite.disabled = false;
    });

    // People.
    const people = h('div', { class: 'share-people', role: 'list' });
    const row = (avatar: string | SVGSVGElement, title: string, sub: string, ...end: (HTMLElement | string)[]) =>
      // A person without a name is shown by the email once, not twice.
      h('div', { class: 'share-person', role: 'listitem' }, h('span', { class: 'share-avatar' }, avatar), h('span', { class: 'share-person-text' }, h('strong', {}, title), title === sub ? null : h('small', {}, sub)), ...end);
    people.append(row(initial(info.owner.name || info.owner.email), info.owner.name || info.owner.email, info.owner.email, h('span', { class: 'share-muted' }, tr('владелец'))));
    // A file in a team project: the whole team has it, each with their team role — unless it is restricted.
    if (info.team) {
      const sub = info.restricted ? tr('Ограничен: из команды файл видят только админы') : tr('Участников: {0} — каждый с ролью в команде', info.team.people);
      let end: HTMLElement;
      if (info.role === 'owner') {
        const access = h('select', { class: 'share-select', 'aria-label': tr('Доступ команды') });
        access.append(h('option', { value: 'team', selected: !info.restricted }, tr('видит файл')), h('option', { value: 'restricted', selected: info.restricted }, tr('только админы')));
        access.addEventListener('change', async () => {
          const restricted = access.value === 'restricted';
          const ok =
            !restricted ||
            (await askConfirm({
              title: tr('Ограничить файл?'),
              message: tr('Люди из команды «{0}» перестанут видеть «{1}». Останутся владелец, админы команды и те, кого вы пригласите сюда по email.', info.team!.name, this.target.fileName),
              confirm: tr('Ограничить'),
            }));
          if (!ok) access.value = 'team';
          else if (await this.run(() => sharing.setRestricted(id, restricted))) this.target.toast(restricted ? tr('Файл ограничен: команда его больше не видит') : tr('Файл снова виден всей команде'));
        });
        end = access;
      } else end = h('span', { class: 'share-muted' }, info.restricted ? tr('только админы') : tr('команда'));
      people.append(row(icon(info.restricted ? 'lock' : 'people', 14), tr('Команда «{0}»', info.team.name), sub, end));
    }
    for (const m of info.members) {
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть доступ'), 'aria-label': tr('Закрыть доступ: {0}', m.email) }, icon('close', 14));
      remove.addEventListener('click', async () => {
        const ok = await askConfirm({ title: tr('Закрыть доступ?'), message: tr('{0} больше не сможет открыть «{1}».', m.name || m.email, this.target.fileName), confirm: tr('Закрыть доступ'), danger: true });
        if (ok) await this.run(() => sharing.remove(id, m.id));
      });
      people.append(row(initial(m.name || m.email), m.name || m.email, m.email, roleSelect(m.role, (r) => void this.run(() => sharing.setRole(id, m.id, r)), tr('Роль: {0}', m.email)), remove));
    }
    for (const inv of info.invites) {
      const until = new Date(inv.expiresAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Отменить приглашение'), 'aria-label': tr('Отменить приглашение: {0}', inv.email) }, icon('close', 14));
      remove.addEventListener('click', () => void this.run(() => sharing.removeInvite(id, inv.email)));
      const again = roleSelect(inv.role, (r) => void this.run(() => sharing.invite(id, inv.email, r)), tr('Роль: {0}', inv.email));
      people.append(row('✉', inv.email, tr('ждёт регистрации · до {0}', until), again, remove));
    }

    // Link.
    const link = info.link;
    const open = link.mode !== 'invited';
    // One choice per team: "everyone in the team" means one particular team.
    const teams = [...info.teams];
    if (link.team && !teams.some((t) => t.id === link.team!.id)) teams.push(link.team);
    const mode = h('select', { class: 'share-select', 'aria-label': tr('Кому открыта ссылка') });
    mode.append(h('option', { value: 'invited', selected: link.mode === 'invited' }, tr('Только приглашённые')));
    for (const t of teams) mode.append(h('option', { value: `team:${t.id}`, selected: link.mode === 'team' && link.team?.id === t.id }, tr('Все в команде «{0}»', t.name)));
    mode.append(h('option', { value: 'anyone', selected: link.mode === 'anyone' }, tr('Все, у кого есть ссылка')));
    mode.addEventListener('change', () => {
      const [value, teamId] = mode.value.split(':') as [LinkMode, string | undefined];
      void this.run(() => sharing.setLink(id, teamId ? { mode: value, teamId } : { mode: value }));
    });
    const linkRole = roleSelect(link.role, (r) => void this.run(() => sharing.setLink(id, { role: r })), tr('Роль по ссылке'));
    linkRole.hidden = !open;
    const settings = h('div', { class: 'share-link-settings', hidden: !open });
    if (open) {
      const expiry = h('select', { class: 'share-select', 'aria-label': tr('Срок действия ссылки') });
      const days = link.expiresAt === null ? null : Math.max(0, Math.round((link.expiresAt - Date.now()) / 86_400_000));
      expiry.append(h('option', { value: '', selected: link.expiresAt === null }, tr('Без срока')));
      for (const d of [1, 7, 30] as const) expiry.append(h('option', { value: String(d) }, `${d} ${d === 1 ? tr('день') : tr('дней')}`));
      if (link.expiresAt !== null) {
        expiry.append(h('option', { value: 'keep', selected: true }, tr('до {0}{1}', new Date(link.expiresAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long' }), days === 0 ? tr(' (истекает)') : '')));
      }
      expiry.addEventListener('change', () => {
        if (expiry.value === 'keep') return;
        void this.run(() => sharing.setLink(id, { expiresInDays: expiry.value ? (Number(expiry.value) as 1 | 7 | 30) : null }));
      });
      const password = h('input', { class: 'dialog-input', type: 'password', placeholder: link.hasPassword ? tr('Пароль задан — введите новый') : tr('Без пароля'), 'aria-label': tr('Пароль ссылки'), autocomplete: 'new-password' });
      const setPassword = h('button', { class: 'text-button', type: 'button' }, tr('Задать'));
      setPassword.addEventListener('click', async () => {
        if (password.value.length < 4) {
          this.error.textContent = tr('Пароль ссылки — от 4 символов');
          password.focus();
          return;
        }
        if (await this.run(() => sharing.setLink(id, { password: password.value }))) this.target.toast(tr('Пароль ссылки задан. Сообщите его отдельно от ссылки.'));
      });
      const removePassword = link.hasPassword ? h('button', { class: 'text-button', type: 'button', onclick: () => void this.run(() => sharing.setLink(id, { password: null })) }, tr('Убрать')) : '';
      settings.append(
        h('label', { class: 'share-setting' }, h('span', {}, tr('Срок')), expiry),
        h('div', { class: 'share-setting' }, h('span', {}, tr('Пароль')), password, setPassword, removePassword),
        link.mode === 'anyone' && !this.target.board ? h('p', { class: 'share-muted' }, tr('Без аккаунта по ссылке можно только смотреть: чтобы редактировать, нужно войти.')) : '',
      );
      // A board: a retro or a brainstorm people join without signing up.
      if (link.mode === 'anyone' && this.target.board) {
        const guests = link.guests && link.role === 'editor';
        settings.append(
          h(
            'label',
            { class: 'share-check' },
            h('input', { type: 'checkbox', checked: guests, onchange: (e: Event) => void this.run(() => sharing.setLink(id, (e.target as HTMLInputElement).checked ? { guests: true, role: 'editor' } : { guests: false })) }),
            h('span', {}, tr('Гости без аккаунта тоже редактируют')),
          ),
          h('p', { class: 'share-muted' }, guests ? tr('Каждый гость получает имя зверя — его видно у курсора и под стикерами.') : tr('Без аккаунта по ссылке можно только смотреть: чтобы редактировать, нужно войти.')),
        );
      }
    }

    const toNode = this.target.node
      ? h('label', { class: 'share-check' }, h('input', { type: 'checkbox', checked: this.linkToNode, onchange: (e: Event) => (this.linkToNode = (e.target as HTMLInputElement).checked) }), h('span', {}, tr('Ссылка на выделенный слой «{0}»', this.target.nodeName ?? '')))
      : '';
    const copy = h('button', { class: 'text-button primary', type: 'button' }, icon('link', 14), h('span', {}, tr('Копировать ссылку')));
    copy.addEventListener('click', () => void this.copyLink());
    const reset =
      open
        ? h('button', { class: 'text-button', type: 'button', title: tr('Новая ссылка: прежние копии перестанут открывать файл') }, tr('Сбросить ссылку'))
        : '';
    if (reset) {
      reset.addEventListener('click', async () => {
        const ok = await askConfirm({ title: tr('Сбросить ссылку?'), message: tr('Будет создана новая ссылка. Все, кому вы отправляли прежнюю, потеряют доступ по ней (приглашённые люди доступ сохранят).'), confirm: tr('Сбросить'), danger: true });
        if (ok && (await this.run(() => sharing.setLink(id, { reset: true })))) this.target.toast(tr('Ссылка сброшена. Скопируйте новую.'));
      });
    }

    this.body.append(
      form,
      h('h3', { class: 'share-heading' }, tr('Люди с доступом')),
      people,
      h('h3', { class: 'share-heading' }, tr('Доступ по ссылке')),
      h('div', { class: 'share-link-row' }, icon(link.mode === 'anyone' ? 'link' : link.mode === 'team' ? 'people' : 'lock', 16), mode, linkRole),
      h(
        'p',
        { class: 'share-muted' },
        link.mode === 'anyone'
          ? tr('Любой, у кого есть ссылка, {0}.', ROLE_LABELS[link.role])
          : link.mode === 'team'
            ? tr('Люди из команды «{0}», у которых есть ссылка, {1}. Остальным она не откроет файл.', link.team?.name ?? '', ROLE_LABELS[link.role])
            : tr('Открыть файл смогут только люди из списка выше.'),
      ),
      settings,
      toNode,
      h('footer', { class: 'share-footer' }, reset, h('span', { class: 'share-spacer' }), copy),
    );
    requestAnimationFrame(() => {
      if (!this.overlay.contains(document.activeElement)) email.focus();
    });
  }

  private async copyLink(): Promise<void> {
    const info = this.info;
    if (!info) return;
    const target = this.linkToNode && this.target.node ? { page: this.target.page, node: this.target.node } : undefined;
    const link = info.link;
    const url = sharing.url(this.target.fileId, link.mode !== 'invited' ? link.token : null, target);
    try {
      await navigator.clipboard.writeText(url);
      this.target.toast(
        link.mode === 'anyone'
          ? tr('Ссылка скопирована')
          : link.mode === 'team'
            ? tr('Ссылка скопирована. Откроют её люди из команды «{0}» и приглашённые.', link.team?.name ?? '')
            : tr('Ссылка скопирована. Откроют её только приглашённые люди.'),
      );
    } catch {
      // The clipboard API is refused (Safari after a delay, a page in a frame): one field with the
      // address, selected and copied the old way; pressing the button again reuses it (BUG-096).
      let field = this.body.querySelector<HTMLInputElement>('.share-url');
      if (!field) {
        field = h('input', { class: 'dialog-input share-url', type: 'text', readOnly: true, 'aria-label': tr('Ссылка') }) as HTMLInputElement;
        this.body.append(field);
      }
      field.value = url;
      field.focus();
      field.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      this.target.toast(copied ? tr('Ссылка скопирована') : tr('Скопируйте ссылку из поля: ⌘C / Ctrl+C'));
    }
  }
}
