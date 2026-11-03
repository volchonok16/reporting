// "Team members" dialog: who is in the team and with what role; admins
// invite people by email, change roles, take people out and cancel
// invitations; anyone but the owner may leave. Built like the "Share" dialog.

import { locale, tr } from '#core';
import { CloudError, teams, type TeamInfo, type TeamRole } from '../cloud.ts';
import { colleagueEmailField } from './colleague-picker.ts';
import { askConfirm } from './dialog.ts';
import { clear, h, icon } from './dom.ts';

const ROLE_LABELS: Record<TeamRole, string> = {
  admin: tr('администратор'),
  editor: tr('может редактировать'),
  commenter: tr('может комментировать'),
  viewer: tr('может смотреть'),
};

const ROLE_HINTS: Record<TeamRole, string> = {
  admin: tr('правит все файлы, приглашает людей, удаляет проекты'),
  editor: tr('правит все файлы, создаёт файлы и проекты'),
  commenter: tr('смотрит и комментирует все файлы'),
  viewer: tr('смотрит все файлы'),
};

export interface TeamTarget {
  team: TeamInfo;
  /** The signed-in person's id. */
  me: string;
  toast(message: string): void;
  /** People or roles changed: the home screen reloads. */
  changed(): void;
  /** This person left the team. */
  left(): void;
}

function roleSelect(value: TeamRole, onChange: (role: TeamRole) => void, label: string): HTMLSelectElement {
  const select = h('select', { class: 'share-select', 'aria-label': label });
  for (const role of ['admin', 'editor', 'commenter', 'viewer'] as const) select.append(h('option', { value: role, selected: role === value, title: ROLE_HINTS[role] }, ROLE_LABELS[role]));
  select.addEventListener('change', () => onChange(select.value as TeamRole));
  return select;
}

function initial(text: string): string {
  return (text.trim().charAt(0) || '·').toUpperCase();
}

export class TeamDialog {
  private readonly target: TeamTarget;
  private team: TeamInfo;
  private readonly overlay: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly error: HTMLElement;
  private dirty = false;

  constructor(target: TeamTarget) {
    this.target = target;
    this.team = target.team;
    this.title = h('h2', {}, tr('Команда «{0}»', this.team.name));
    this.body = h('div', { class: 'share-body' });
    this.error = h('p', { class: 'dialog-error', role: 'alert' });
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog share-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Команда «{0}»', this.team.name) },
      h('header', { class: 'dialog-header' }, this.title, close),
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
    this.render();
    // The list on the home screen may be old: show the team as it is now.
    void this.run(async () => (await teams.list()).find((t) => t.id === this.team.id) ?? this.team, false);
  }

  close(): void {
    this.overlay.remove();
    if (this.dirty) this.target.changed();
  }

  /** Runs a change on the server and shows the fresh team (or the error). */
  private async run(fn: () => Promise<TeamInfo>, change = true): Promise<boolean> {
    this.error.textContent = '';
    try {
      this.team = await fn();
      if (change) this.dirty = true;
      this.render();
      return true;
    } catch (error) {
      this.error.textContent = error instanceof CloudError ? error.message : tr('Не получилось. Проверьте связь и попробуйте ещё раз.');
      return false;
    }
  }

  private render(): void {
    const team = this.team;
    const id = team.id;
    const admin = team.role === 'owner' || team.role === 'admin';
    this.title.textContent = tr('Команда «{0}»', team.name);
    clear(this.body);

    let form: HTMLElement | string = '';
    let email: HTMLInputElement | null = null;
    if (admin) {
      const who = colleagueEmailField(tr('Фамилия или email'), tr('Фамилия или email'));
      email = who.input;
      let role: TeamRole = 'editor';
      const inviteRole = roleSelect(role, (r) => (role = r), tr('Роль для приглашения'));
      const invite = h('button', { class: 'text-button primary', type: 'submit' }, tr('Пригласить'));
      form = h('form', { class: 'share-invite', novalidate: true }, who.wrap, inviteRole, invite);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const value = who.email();
        if (!value) {
          this.error.textContent = tr('Выберите коллегу из списка или введите email');
          who.input.focus();
          return;
        }
        invite.disabled = true;
        let mailFailed = false;
        const ok = await this.run(async () => {
          const result = await teams.invite(id, value, role);
          mailFailed = !!result.mailFailed;
          return result.team;
        });
        if (ok) this.target.toast(mailFailed ? tr('{0} в команде, но письмо не отправилось. Сообщите сами.', value) : tr('Приглашение отправлено: {0}', value));
        invite.disabled = false;
      });
    }

    const people = h('div', { class: 'share-people', role: 'list' });
    const row = (avatar: string, title: string, sub: string, ...end: (HTMLElement | string)[]) =>
      h('div', { class: 'share-person', role: 'listitem' }, h('span', { class: 'share-avatar' }, avatar), h('span', { class: 'share-person-text' }, h('strong', {}, title), h('small', {}, sub)), ...end);
    for (const m of team.members) {
      const name = m.name || m.email;
      const you = m.id === this.target.me ? tr(' (вы)') : '';
      if (m.role === 'owner') {
        people.append(row(initial(name), name + you, m.email, h('span', { class: 'share-muted' }, tr('владелец'))));
        continue;
      }
      if (!admin || m.id === this.target.me) {
        people.append(row(initial(name), name + you, m.email, h('span', { class: 'share-muted', title: ROLE_HINTS[m.role] }, ROLE_LABELS[m.role])));
        continue;
      }
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Убрать из команды'), 'aria-label': tr('Убрать из команды: {0}', m.email) }, icon('close', 14));
      remove.addEventListener('click', async () => {
        const ok = await askConfirm({ title: tr('Убрать из команды?'), message: tr('{0} потеряет доступ к файлам команды «{1}». Файлы, созданные этим участником, останутся у их автора.', name, team.name), confirm: tr('Убрать'), danger: true });
        if (ok) await this.run(async () => (await teams.removeMember(id, m.id)).team ?? this.team);
      });
      people.append(row(initial(name), name, m.email, roleSelect(m.role, (r) => void this.run(() => teams.setRole(id, m.id, r)), tr('Роль: {0}', m.email)), remove));
    }
    for (const inv of team.invites ?? []) {
      const until = new Date(inv.expiresAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
      const remove = h('button', { class: 'icon-button', type: 'button', title: tr('Отменить приглашение'), 'aria-label': tr('Отменить приглашение: {0}', inv.email) }, icon('close', 14));
      remove.addEventListener('click', () => void this.run(() => teams.removeInvite(id, inv.email)));
      const again = roleSelect(inv.role, (r) => void this.run(async () => (await teams.invite(id, inv.email, r)).team), tr('Роль: {0}', inv.email));
      people.append(row('✉', inv.email, tr('ждёт регистрации · до {0}', until), again, remove));
    }

    let footer: HTMLElement | string = '';
    if (team.role !== 'owner') {
      const leave = h('button', { class: 'text-button', type: 'button' }, tr('Выйти из команды'));
      leave.addEventListener('click', async () => {
        const ok = await askConfirm({ title: tr('Выйти из команды?'), message: tr('Файлы команды «{0}» перестанут быть вам доступны (кроме созданных вами — они останутся в ваших). Вернуться можно по новому приглашению.', team.name), confirm: tr('Выйти'), danger: true });
        if (!ok) return;
        try {
          await teams.removeMember(id, this.target.me);
        } catch (error) {
          this.error.textContent = error instanceof CloudError ? error.message : tr('Не получилось. Проверьте связь и попробуйте ещё раз.');
          return;
        }
        this.overlay.remove();
        this.target.left();
      });
      footer = h('footer', { class: 'share-footer' }, leave, h('span', { class: 'share-spacer' }), h('span', { class: 'share-muted' }, tr('Ваша роль: {0}', ROLE_LABELS[team.role])));
    }

    this.body.append(
      form,
      h('p', { class: 'share-muted' }, admin ? tr('Все в команде видят её проекты и файлы — с правами своей роли.') : tr('Приглашать людей могут администраторы команды.')),
      h('h3', { class: 'share-heading' }, tr('Участники: {0}', team.members.length)),
      people,
      footer,
    );
    if (email) {
      const field = email;
      requestAnimationFrame(() => {
        if (!this.overlay.contains(document.activeElement)) field.focus();
      });
    }
  }
}
