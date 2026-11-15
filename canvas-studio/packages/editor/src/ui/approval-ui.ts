// Approval (other editors, item 9): the «Согласование» section of the
// properties panel — shown only for a frame or section that has a status —
// and the windows to ask for an approval and to say what to change.

import { locale, tr, type NodeId } from '#core';
import { APPROVAL_COLORS, APPROVAL_LABELS, type Approvals } from '../approvals.ts';
import { approvals as api, comments as commentsApi, CloudError, type ApprovalChange, type ApprovalInfo } from '../cloud.ts';
import type { Editor } from '../editor.ts';
import { h } from './dom.ts';

export interface ApprovalHost {
  editor: Editor;
  approvals: Approvals;
  fileId: () => string;
  userId: () => string | null;
  /** Owner or editor of the file. */
  canEdit: () => boolean;
  toast(text: string, kind?: 'error'): void;
  /** «Что изменилось»: the frame next to the approved version. */
  compare(id: NodeId, version: string): void;
}

function message(error: unknown): string {
  return error instanceof CloudError || error instanceof Error ? error.message : String(error);
}

function when(at: number): string {
  return new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const EVENT_LABELS: Record<string, string> = { ...APPROVAL_LABELS, WITHDRAWN: 'Статус снят' };

/** Applies the server's answer and says when a letter did not go. */
function done(host: ApprovalHost, r: ApprovalChange & { mailFailed?: true }, text: string): void {
  host.approvals.apply(r);
  host.toast(r.mailFailed ? tr('Готово, но письмо не ушло. Напишите человеку сами.') : text, r.mailFailed ? 'error' : undefined);
}

/** A small modal form: the body, the main button, what it does (an error is shown in the form). */
function openForm(title: string, body: HTMLElement[], submitLabel: string, submit: (error: HTMLElement) => Promise<boolean>): HTMLElement {
  const error = h('p', { class: 'dialog-error', role: 'alert' });
  const send = h('button', { class: 'text-button primary', type: 'submit' }, submitLabel) as HTMLButtonElement;
  const cancel = h('button', { class: 'text-button', type: 'button' }, tr('Отмена'));
  const form = h(
    'form',
    { class: 'dialog review-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'dialog-header' }, h('h2', {}, title)),
    h('div', { class: 'dialog-body' }, ...body, error),
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
    error.textContent = '';
    send.disabled = true;
    void submit(error).then((ok) => {
      if (ok) close();
      else send.disabled = false;
    });
  });
  document.body.append(overlay);
  return form;
}

/** «Отправить на согласование…»: one person of the file and a note. */
export async function askApproval(host: ApprovalHost, id: NodeId, again?: ApprovalInfo): Promise<void> {
  const d = host.editor.doc;
  let people: { id: string; name: string }[];
  try {
    people = (await commentsApi.people(host.fileId())).filter((p) => p.id !== host.userId());
  } catch (error) {
    return host.toast(message(error), 'error');
  }
  if (!people.length) return host.toast(tr('Кроме вас, у файла никого нет. Пригласите человека через «Поделиться».'));
  const radios = people.map((p) => ({ p, box: h('input', { type: 'radio', name: 'approval-reviewer', value: p.id }) as HTMLInputElement }));
  const pick = radios.find((r) => r.p.id === again?.reviewer.id) ?? (radios.length === 1 ? radios[0] : undefined);
  if (pick) pick.box.checked = true;
  const note = h('textarea', { class: 'dialog-input branches-desc', rows: 3, maxLength: 2000, placeholder: tr('Что посмотреть'), 'aria-label': tr('Записка') }) as HTMLTextAreaElement;
  const name = String(d.get(id, 'name') ?? '');
  const form = openForm(
    tr('Согласовать «{0}»', name),
    [h('div', { class: 'review-people', role: 'radiogroup', 'aria-label': tr('Кто утвердит') }, ...radios.map(({ p, box }) => h('label', { class: 'review-person' }, box, h('span', {}, p.name)))), note],
    tr('Отправить'),
    async (error) => {
      const reviewer = radios.find((r) => r.box.checked)?.p.id;
      if (!reviewer) {
        error.textContent = tr('Выберите, кто утвердит');
        return false;
      }
      if (!d.store.isAlive(id)) return true;
      const pageId = d.pageOf(id) ?? host.editor.pageId;
      try {
        const r = await api.ask(host.fileId(), { nodeId: id, pageId, name: String(d.get(id, 'name') ?? ''), reviewer, note: note.value.trim() });
        done(host, r, tr('Отправлено на согласование'));
        return true;
      } catch (err) {
        error.textContent = message(err);
        return false;
      }
    },
  );
  requestAnimationFrame(() => (pick?.box ?? radios[0]?.box ?? (form.querySelector('textarea') as HTMLElement | null))?.focus());
}

/** «Нужны правки»: what to change — required. */
function askChanges(host: ApprovalHost, a: ApprovalInfo): void {
  const note = h('textarea', { class: 'dialog-input branches-desc', rows: 4, maxLength: 2000, placeholder: tr('Что поправить'), 'aria-label': tr('Что поправить') }) as HTMLTextAreaElement;
  openForm(tr('Нужны правки'), [note], tr('Отправить'), async (error) => {
    if (!note.value.trim()) {
      error.textContent = tr('Напишите, что поправить');
      return false;
    }
    try {
      done(host, await api.answer(host.fileId(), a.nodeId, 'changes', note.value.trim()), tr('Отправлено'));
      return true;
    } catch (err) {
      error.textContent = message(err);
      return false;
    }
  });
  requestAnimationFrame(() => note.focus());
}

/** The «Согласование» section for the selection, if it is one frame or section with a status. */
export function buildApprovalSection(host: ApprovalHost, section: (title: string, ...actions: HTMLElement[]) => HTMLElement, ids: NodeId[]): void {
  if (ids.length !== 1) return;
  const id = ids[0]!;
  const a = host.approvals.get(id);
  if (!a) return;
  const body = section(tr('Согласование'));
  const edited = a.status === 'APPROVED' && host.approvals.isEdited(id);
  const color = edited ? APPROVAL_COLORS.EDITED : APPROVAL_COLORS[a.status];
  const label = edited ? tr('Изменено после утверждения') : tr(APPROVAL_LABELS[a.status]);
  body.append(h('p', { class: 'approval-status' }, h('i', { class: 'approval-dot', style: `background:${color}` }), h('span', {}, label)));
  const who =
    a.status === 'APPROVED'
      ? `${a.reviewer.name}, ${when(a.approvedAt ?? a.at)}`
      : a.status === 'CHANGES'
        ? `${a.reviewer.name}, ${when(a.history.at(-1)?.at ?? a.at)}`
        : tr('Проверяет {0}', a.reviewer.name);
  body.append(h('p', { class: 'hint small' }, who));
  if (a.note) body.append(h('p', { class: 'approval-note' }, a.note));

  const me = host.userId();
  const buttons: HTMLElement[] = [];
  const act = (text: string, run: () => Promise<void> | void, primary = false) => {
    const b = h('button', { class: `text-button${primary ? ' primary' : ''}`, type: 'button' }, text) as HTMLButtonElement;
    b.addEventListener('click', () => {
      b.disabled = true;
      void Promise.resolve(run()).finally(() => (b.disabled = false));
    });
    buttons.push(b);
  };
  if (a.status === 'REVIEW' && me === a.reviewer.id) {
    act(
      tr('Утвердить'),
      async () => {
        try {
          done(host, await api.answer(host.fileId(), id, 'approved', ''), tr('Утверждено'));
        } catch (error) {
          host.toast(message(error), 'error');
        }
      },
      true,
    );
    act(tr('Нужны правки'), () => askChanges(host, a));
  }
  if (edited && a.version) act(tr('Что изменилось'), () => host.compare(id, a.version!));
  if (host.canEdit() && (a.status === 'CHANGES' || edited)) act(tr('Отправить снова'), () => askApproval(host, id, a), a.status === 'CHANGES');
  if (buttons.length) body.append(h('div', { class: 'button-row wrap' }, ...buttons));
  if (host.canEdit()) {
    const off = h('button', { class: 'link-button approval-off', type: 'button' }, tr('Снять статус'));
    off.addEventListener('click', () => {
      void api
        .withdraw(host.fileId(), id)
        .then((r) => host.approvals.apply(r))
        .catch((error: unknown) => host.toast(message(error), 'error'));
    });
    body.append(off);
  }
  if (a.history.length > 1) {
    const list = h(
      'ol',
      { class: 'approval-history' },
      ...[...a.history].reverse().map((e) => h('li', {}, h('span', {}, `${tr(EVENT_LABELS[e.status] ?? e.status)} · ${e.by}`), h('span', { class: 'hint small' }, when(e.at)), e.note ? h('span', { class: 'review-note' }, e.note) : null)),
    );
    body.append(h('details', { class: 'approval-details' }, h('summary', {}, tr('История')), list));
  }
}
