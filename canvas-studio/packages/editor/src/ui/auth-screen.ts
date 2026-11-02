// Sign-in and registration (stage "Server", part 1). Shown when the app runs
// with a server and nobody is signed in. "Continue without signing in" keeps
// the old way: files in this browser only.

import { brand, lang, tr } from '#core';
import { cloud, CloudError, type CloudUser } from '../cloud.ts';
import { brandMark, h, icon } from './dom.ts';

export type AuthResult = { mode: 'cloud'; user: CloudUser } | { mode: 'local' } | { mode: 'back' };

/** `back`: a «Назад» link that leaves the screen (to the landing page or where the person came from). */
export function showAuthScreen(root: HTMLElement, options: { allowLocal: boolean; message?: string; register?: boolean; back?: boolean }): Promise<AuthResult> {
  return new Promise((resolve) => {
    // verify: code from the welcome letter; forgot: email → code by mail; reset: code + new password.
    let mode: 'login' | 'register' | 'verify' | 'forgot' | 'reset' = 'login';
    /** Error text to keep when switching mode (the server's explanation of why). */
    let note = '';
    const error = h('p', { class: 'auth-error', role: 'alert' });
    const name = h('input', { class: 'auth-input', type: 'text', name: 'name', autocomplete: 'name', placeholder: tr('Как к вам обращаться'), 'aria-label': tr('Имя (необязательно)'), maxLength: 80 });
    const email = h('input', { class: 'auth-input', type: 'email', name: 'email', autocomplete: 'email', placeholder: 'Email', 'aria-label': 'Email', required: true });
    const password = h('input', { class: 'auth-input', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: tr('Пароль'), 'aria-label': tr('Пароль'), required: true, minLength: 8 });
    const code = h('input', { class: 'auth-input', type: 'text', name: 'code', autocomplete: 'one-time-code', inputMode: 'numeric', placeholder: tr('6 цифр из письма'), 'aria-label': tr('Код из письма'), maxLength: 6 });
    const nameRow = h('label', { class: 'auth-field', hidden: true }, h('span', {}, tr('Имя (необязательно)')), name);
    const codeRow = h('label', { class: 'auth-field', hidden: true }, h('span', {}, tr('Код из письма')), code);
    const passwordLabel = h('span', {}, tr('Пароль'));
    const passwordRow = h('label', { class: 'auth-field' }, passwordLabel, password);
    const forgotLink = h('button', { class: 'auth-link', type: 'button' }, tr('Забыли пароль?'));
    const resendLink = h('button', { class: 'auth-link', type: 'button', hidden: true }, tr('Отправить код ещё раз'));
    const backLink = h('button', { class: 'auth-link', type: 'button', hidden: true }, tr('Назад ко входу'));
    const tabs = h('div', { class: 'auth-tabs', role: 'tablist' });
    const submit = h('button', { class: 'text-button primary auth-submit', type: 'submit' }, tr('Войти'));
    const submitLabel = () => ({ login: tr('Войти'), register: tr('Создать аккаунт'), verify: tr('Подтвердить и войти'), forgot: tr('Прислать код'), reset: tr('Сменить пароль и войти') })[mode];
    const loginTab = h('button', { class: 'auth-tab active', type: 'button', role: 'tab', 'aria-selected': 'true' }, tr('Вход'));
    const registerTab = h('button', { class: 'auth-tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, tr('Регистрация'));
    const hint = h('p', { class: 'auth-hint' });
    // 152-FZ: consent is its own document and its own tick, not implied by signing up.
    const consent = h('input', { type: 'checkbox', name: 'consent' });
    const consentRow = h(
      'label',
      { class: 'auth-consent', hidden: true },
      consent,
      h('span', {}, tr('Даю'), ' ', h('a', { href: legalUrl('consent'), target: '_blank', rel: 'noopener' }, tr('согласие на обработку персональных данных'))),
    );
    const terms = h(
      'p',
      { class: 'auth-terms', hidden: true },
      tr('Создавая аккаунт, вы принимаете'),
      ' ',
      h('a', { href: legalUrl('terms'), target: '_blank', rel: 'noopener' }, tr('пользовательское соглашение')),
      ' ',
      tr('и'),
      ' ',
      h('a', { href: legalUrl('privacy'), target: '_blank', rel: 'noopener' }, tr('политику конфиденциальности')),
      '.',
    );
    const setMode = (m: typeof mode) => {
      mode = m;
      const recovering = m === 'forgot' || m === 'reset' || m === 'verify';
      tabs.hidden = recovering;
      loginTab.classList.toggle('active', m === 'login');
      registerTab.classList.toggle('active', m === 'register');
      loginTab.setAttribute('aria-selected', String(m === 'login'));
      registerTab.setAttribute('aria-selected', String(m === 'register'));
      nameRow.hidden = m !== 'register';
      consentRow.hidden = m !== 'register';
      terms.hidden = m !== 'register';
      codeRow.hidden = m !== 'reset' && m !== 'verify';
      passwordRow.hidden = m === 'forgot' || m === 'verify';
      email.readOnly = m === 'verify';
      resendLink.hidden = m !== 'verify';
      passwordLabel.textContent = m === 'reset' ? tr('Новый пароль') : tr('Пароль');
      password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      forgotLink.hidden = m !== 'login';
      // With the «Назад» at the top it steps back here too: one way back, not two.
      backLink.hidden = !recovering || !!options.back;
      submit.textContent = submitLabel();
      hint.textContent =
        m === 'register' ? tr('Имя видят те, с кем вы работаете над файлами; без него — ваш email. Пароль — не короче 8 символов, на почту придёт код для подтверждения.')
        : m === 'verify' ? tr('Мы отправили код на {0}. Если письма нет — проверьте «Спам».', email.value.trim())
        : m === 'forgot' ? tr('Пришлём на почту код для смены пароля.')
        : m === 'reset' ? tr('Код отправлен на {0}. Если письма нет — проверьте «Спам».', email.value.trim())
        : '';
      error.textContent = note;
      note = '';
      (m === 'register' ? name : m === 'reset' || m === 'verify' ? code : email).focus();
    };
    loginTab.addEventListener('click', () => setMode('login'));
    registerTab.addEventListener('click', () => setMode('register'));
    forgotLink.addEventListener('click', () => setMode('forgot'));
    resendLink.addEventListener('click', async () => {
      resendLink.disabled = true;
      try {
        await cloud.resend(email.value);
        error.textContent = '';
        hint.textContent = tr('Новый код отправлен на {0}. Прежний больше не действует.', email.value.trim());
      } catch (err) {
        error.textContent = err instanceof CloudError ? err.message : tr('Не получилось. Проверьте связь и попробуйте ещё раз.');
      }
      resendLink.disabled = false;
    });
    backLink.addEventListener('click', () => {
      password.value = '';
      code.value = '';
      setMode('login');
    });
    tabs.append(loginTab, registerTab);
    const form = h(
      'form',
      { class: 'auth-form', novalidate: true },
      tabs,
      nameRow,
      h('label', { class: 'auth-field' }, h('span', {}, 'Email'), email),
      codeRow,
      passwordRow,
      hint,
      consentRow,
      error,
      submit,
      terms,
      h('div', { class: 'auth-links' }, forgotLink, resendLink, backLink),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (!email.value.trim() || (mode !== 'forgot' && mode !== 'verify' && !password.value)) {
        error.textContent = mode === 'forgot' ? tr('Укажите email') : tr('Заполните email и пароль');
        return;
      }
      if (mode === 'register' && !consent.checked) {
        error.textContent = tr('Отметьте согласие на обработку персональных данных');
        consent.focus();
        return;
      }
      if ((mode === 'reset' || mode === 'verify') && !/^\d{6}$/.test(code.value.replace(/\s+/g, ''))) {
        error.textContent = tr('Введите 6 цифр из письма');
        code.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = { login: tr('Входим…'), register: tr('Создаём…'), verify: tr('Проверяем…'), forgot: tr('Отправляем…'), reset: tr('Меняем…') }[mode];
      try {
        if (mode === 'forgot' || mode === 'register') {
          if (mode === 'forgot') await cloud.forgotPassword(email.value);
          else email.value = (await cloud.register(email.value, password.value, name.value, consent.checked)).email;
          submit.disabled = false;
          code.value = '';
          setMode(mode === 'forgot' ? 'reset' : 'verify');
          return;
        }
        const user =
          mode === 'login' ? await cloud.login(email.value, password.value)
          : mode === 'verify' ? await cloud.verify(email.value, code.value)
          : await cloud.resetPassword(email.value, code.value, password.value);
        overlay.remove();
        resolve({ mode: 'cloud', user });
      } catch (err) {
        error.textContent = err instanceof CloudError ? err.message : tr('Не получилось. Проверьте связь и попробуйте ещё раз.');
        submit.disabled = false;
        if (err instanceof CloudError && err.code === 'exists') {
          note = err.message;
          setMode('login');
        }
        if (err instanceof CloudError && err.code === 'unverified') {
          // Signed up earlier but never entered the code: a fresh one is on its way.
          note = err.message;
          code.value = '';
          setMode('verify');
          hint.textContent = tr('Если письма нет — проверьте «Спам» или отправьте код ещё раз.');
        }
        submit.textContent = submitLabel();
      }
    });
    const local = options.allowLocal
      ? h('button', { class: 'text-button auth-local', type: 'button', onclick: () => {
          overlay.remove();
          resolve({ mode: 'local' });
        } }, tr('Продолжить без входа — файлы только в этом браузере'))
      : null;
    // «Назад» at the top: on the code and password-reset steps — back to signing in; otherwise — off this screen.
    const back = options.back
      ? h('button', { class: 'auth-back', type: 'button', onclick: () => {
          if (mode === 'forgot' || mode === 'reset' || mode === 'verify') {
            backLink.click();
            return;
          }
          overlay.remove();
          resolve({ mode: 'back' });
        } }, icon('chevronLeft', 14), h('span', {}, tr('Назад')))
      : null;
    const card = h(
      'div',
      { class: 'auth-card' },
      ...(back ? [back] : []),
      h('h1', { class: 'auth-title' }, brandMark(36), h('span', {}, brand())),
      h('p', { class: 'auth-subtitle' }, options.message ?? tr('Войдите, чтобы файлы хранились на сервере и открывались с любого устройства.')),
      form,
      ...(local ? [local] : []),
    );
    const overlay = h('div', { class: 'auth-screen' }, card);
    root.append(overlay);
    if (options.register) setMode('register');
    requestAnimationFrame(() => email.focus());
  });
}

/** The legal pages (apps/web/legal), in the interface language. */
export function legalUrl(doc: 'terms' | 'privacy' | 'consent'): string {
  return lang === 'en' ? `/en/${doc}` : `/${doc}`;
}
