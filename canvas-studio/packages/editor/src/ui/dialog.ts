// Our own small dialogs in place of the browser's prompt / confirm / alert:
// they look like the rest of the app, follow its theme, work the same in
// every browser and never block the page. Each returns a promise.
//
//   const name = await askText({ title: 'Новый проект', label: 'Название', value: 'Новый проект' });
//   if (await askConfirm({ title: 'Удалить файл?', message: '…', confirm: 'Удалить', danger: true })) …
//   await showMessage({ title: 'Не удалось открыть файл', message: '…' });

import { tr } from '#core';
import { h, icon } from './dom.ts';

export interface Frame {
  title: string;
  body: HTMLElement[];
  confirm: string;
  /** Cancel button text; null — no cancel button (a message). */
  cancel: string | null;
  danger?: boolean;
  /** Checks the input before closing; returns an error text or null. */
  validate?: () => string | null;
  /** Element to focus first. */
  focus?: () => HTMLElement | null;
}

/** Shows a modal dialog; resolves true on confirm, false on cancel / Esc / click outside. */
export function openDialog(frame: Frame): Promise<boolean> {
  return open(frame);
}

function open(frame: Frame): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const error = h('p', { class: 'dialog-error', role: 'alert' });
    const ok = h('button', { class: `text-button ${frame.danger ? 'danger-solid' : 'primary'}`, type: 'submit' }, frame.confirm);
    const cancel = frame.cancel === null ? null : h('button', { class: 'text-button', type: 'button' }, frame.cancel);
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть') }, icon('close'));
    const titleId = `dialog-${Math.random().toString(36).slice(2)}`;
    const form = h(
      'form',
      { class: 'dialog', role: frame.cancel === null ? 'alertdialog' : 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, novalidate: true },
      h('header', { class: 'dialog-header' }, h('h2', { id: titleId }, frame.title), close),
      h('div', { class: 'dialog-body' }, ...frame.body, error),
      h('footer', { class: 'dialog-footer' }, ...(cancel ? [cancel] : []), ok),
    );
    const overlay = h('div', { class: 'dialog-overlay' }, form);
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      overlay.remove();
      previous?.focus?.();
      resolve(result);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const problem = frame.validate?.() ?? null;
      if (problem) {
        error.textContent = problem;
        return;
      }
      finish(true);
    });
    cancel?.addEventListener('click', () => finish(false));
    close.addEventListener('click', () => finish(false));
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(false);
    });
    form.addEventListener('keydown', (e) => {
      // The editor's shortcuts must not fire while typing here.
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
      // Keep Tab inside the dialog.
      if (e.key === 'Tab') {
        const items = [...form.querySelectorAll<HTMLElement>('button, input, textarea, select')].filter((el) => !el.hasAttribute('disabled'));
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    });
    document.body.append(overlay);
    requestAnimationFrame(() => (frame.focus?.() ?? ok).focus());
  });
}

/** Asks for a line of text; resolves the trimmed text, or null if cancelled. */
export async function askText(options: { title: string; label: string; value?: string; placeholder?: string; confirm?: string; maxLength?: number; hint?: string; password?: boolean; empty?: string; allowEmpty?: boolean }): Promise<string | null> {
  const input = h('input', { class: 'dialog-input', type: options.password ? 'password' : 'text', value: options.value ?? '', placeholder: options.placeholder ?? '', maxLength: options.maxLength ?? 120, spellcheck: false });
  const ok = await open({
    title: options.title,
    body: [h('label', { class: 'dialog-field' }, h('span', {}, options.label), input), ...(options.hint ? [h('p', { class: 'dialog-hint' }, options.hint)] : [])],
    confirm: options.confirm ?? tr('Сохранить'),
    cancel: tr('Отмена'),
    validate: () => (input.value.trim() || options.allowEmpty ? null : (options.empty ?? tr('Введите название'))),
    focus: () => {
      requestAnimationFrame(() => input.select());
      return input;
    },
  });
  return ok ? input.value.trim() : null;
}

/** Confirms a dangerous step with the password; `lines` say what will happen, `error` — why the last try failed. */
export async function askPassword(options: { title: string; lines: string[]; label: string; confirm: string; error?: string }): Promise<string | null> {
  const input = h('input', { class: 'dialog-input', type: 'password', autocomplete: 'current-password', spellcheck: false });
  const ok = await open({
    title: options.title,
    body: [
      ...options.lines.map((line) => h('p', { class: 'dialog-message' }, line)),
      h('label', { class: 'dialog-field' }, h('span', {}, options.label), input),
      ...(options.error ? [h('p', { class: 'dialog-error', role: 'alert' }, options.error)] : []),
    ],
    confirm: options.confirm,
    cancel: tr('Отмена'),
    danger: true,
    validate: () => (input.value ? null : tr('Введите пароль')),
    focus: () => input,
  });
  return ok ? input.value : null;
}

/** Asks to confirm an action; resolves true if confirmed. */
export function askConfirm(options: { title: string; message: string; confirm: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return open({
    title: options.title,
    body: [h('p', { class: 'dialog-message' }, options.message)],
    confirm: options.confirm,
    cancel: options.cancel ?? tr('Отмена'),
    danger: options.danger,
  });
}

/** Tells something that needs attention (an error the user must see). */
export async function showMessage(options: { title: string; message: string; confirm?: string }): Promise<void> {
  await open({ title: options.title, body: [h('p', { class: 'dialog-message' }, options.message)], confirm: options.confirm ?? tr('Понятно'), cancel: null });
}
