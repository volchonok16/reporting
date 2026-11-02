// "Settings" window: interface language, theme, interface size, where the tool
// panel stands, how far the arrows move layers and (signed in) which letters about comments come. Everything is remembered in this browser and, for someone
// signed in, with the account (prefs.ts); the language
// reloads the page (every text is built in it), the rest applies at once.

import { lang, tr, type Lang } from '#core';
import { play, setSoundsEnabled } from '../sounds.ts';
import { changeLang, NUDGE_KEY, prefsChanged, prefsSignedIn, savedNudge } from '../prefs.ts';
import { applyTheme, savedTheme, type ThemeChoice } from '../theme.ts';
import { h, icon } from './dom.ts';

export const UI_SCALE_KEY = 'cs-ui-scale';
export const DOCK_KEY = 'cs-dock-place';
export type DockPlace = 'bottom' | 'top' | 'left';
/** Letters about comments; the server reads the same key from the account. */
export const MAIL_COMMENTS_KEY = 'cs.mail-comments';
type CommentMail = 'all' | 'mentions' | 'none';
/** When the bar over the selection shows: by default only with the right panel folded (it stands in for it). */
export const CONTEXT_BAR_KEY = 'cs-context-bar';
export type ContextBarMode = 'folded' | 'always' | 'never';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
  prefsChanged();
}

export function savedUiScale(): number {
  return Number(read(UI_SCALE_KEY)) || 1;
}
export function savedDock(): DockPlace {
  const v = read(DOCK_KEY);
  return v === 'top' || v === 'left' ? v : 'bottom';
}

export function savedContextBar(): ContextBarMode {
  const v = read(CONTEXT_BAR_KEY);
  return v === 'always' || v === 'never' ? v : 'folded';
}

export interface SettingsOptions {
  /** In the editor: apply at once. On the home screen they apply when a file opens. */
  onUiScale?: (scale: number) => void;
  onDock?: (place: DockPlace) => void;
  onContextBar?: (mode: ContextBarMode) => void;
  /** In the editor: the view settings change there (and are kept by it); elsewhere they are written here. */
  onView?: (patch: Partial<ViewPrefs>) => void;
}

/** The view settings this window offers; the rest of `cs.view` is the editor's (rulers, grids…). */
interface ViewPrefs {
  cursors: boolean;
  propertyLabels: boolean;
  smartSymbols: boolean;
  motion: boolean;
  sounds: boolean;
}
const VIEW_KEY = 'cs.view';

function savedView(): ViewPrefs {
  let saved: Partial<ViewPrefs> = {};
  try {
    saved = (JSON.parse(read(VIEW_KEY) ?? 'null') as Partial<ViewPrefs> | null) ?? {};
  } catch {
    saved = {};
  }
  return { cursors: saved.cursors ?? true, propertyLabels: saved.propertyLabels ?? false, smartSymbols: saved.smartSymbols ?? true, motion: saved.motion ?? true, sounds: saved.sounds ?? false };
}

function choice<T extends string | number>(name: string, label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
  const group = h('div', { class: 'settings-choices', role: 'radiogroup', 'aria-label': label });
  for (const [v, text] of options) {
    const input = h('input', { type: 'radio', name, checked: v === value });
    input.addEventListener('change', () => input.checked && onChange(v));
    group.append(h('label', { class: 'settings-choice' }, input, h('span', {}, text)));
  }
  return h('div', { class: 'settings-row' }, h('div', { class: 'settings-label' }, label), group);
}

/** «Nudge amount» (as in Figma): the steps of an arrow and of Shift+arrow, applied at the next press. */
function nudgeRow(): HTMLElement {
  const field = (label: string, which: 'small' | 'big') => {
    const input = h('input', { class: 'settings-number', type: 'number', min: '0.1', max: '1000', step: 'any', inputmode: 'decimal', value: String(savedNudge()[which]), 'aria-label': label });
    // A click and the new number replaces the old one.
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', () => {
      const now = savedNudge();
      const n = Number(input.value.replace(',', '.'));
      if (!(Number.isFinite(n) && n > 0 && n <= 1000)) {
        input.value = String(now[which]);
        return;
      }
      const next = { ...now, [which]: n };
      write(NUDGE_KEY, `${next.small},${next.big}`);
    });
    return h('label', { class: 'settings-field' }, h('span', {}, label), input);
  };
  return h(
    'div',
    { class: 'settings-row' },
    h('div', { class: 'settings-label' }, tr('Шаг сдвига стрелками')),
    h('div', { class: 'settings-fields' }, field(tr('Стрелка'), 'small'), field(tr('Shift + стрелка'), 'big')),
  );
}

export class SettingsDialog {
  private readonly overlay: HTMLElement;

  constructor(options: SettingsOptions = {}) {
    const language = choice<Lang>('cs-lang', tr('Язык интерфейса'), [['ru', 'Русский'], ['en', 'English']], lang, (v) => {
      // The account gets the new language before the page reloads in it.
      changeLang(v);
    });
    const theme = choice<ThemeChoice>('cs-theme', tr('Тема'), [['system', tr('Как в системе')], ['light', tr('Светлая')], ['dark', tr('Тёмная')]], savedTheme(), (v) => {
      applyTheme(v, true);
      prefsChanged();
    });
    const size = choice<number>('cs-ui', tr('Размер интерфейса'), [[0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%']], savedUiScale(), (v) => {
      write(UI_SCALE_KEY, String(v));
      options.onUiScale?.(v);
    });
    const dock = choice<DockPlace>('cs-dock', tr('Панель инструментов'), [['bottom', tr('Снизу')], ['top', tr('Сверху')], ['left', tr('Слева')]], savedDock(), (v) => {
      write(DOCK_KEY, v);
      options.onDock?.(v);
    });
    const bar = choice<ContextBarMode>('cs-bar', tr('Панель над выделением'), [['folded', tr('Когда правая панель свёрнута')], ['always', tr('Всегда')], ['never', tr('Никогда')]], savedContextBar(), (v) => {
      write(CONTEXT_BAR_KEY, v);
      options.onContextBar?.(v);
    });
    const setView = (patch: Partial<ViewPrefs>) => {
      if (options.onView) return options.onView(patch);
      let all: Record<string, unknown> = {};
      try {
        all = (JSON.parse(read(VIEW_KEY) ?? 'null') as Record<string, unknown> | null) ?? {};
      } catch {
        all = {};
      }
      write(VIEW_KEY, JSON.stringify({ ...all, ...patch }));
    };
    const view = savedView();
    const labels = choice<string>('cs-labels', tr('Поля в панели свойств'), [['icons', tr('Значки')], ['labels', tr('Значки и подписи')]], view.propertyLabels ? 'labels' : 'icons', (v) => setView({ propertyLabels: v === 'labels' }));
    const cursors = choice<string>('cs-cursors', tr('Курсоры участников'), [['show', tr('Показывать')], ['hide', tr('Скрывать')]], view.cursors ? 'show' : 'hide', (v) => setView({ cursors: v === 'show' }));
    const smart = choice<string>('cs-smart', tr('Умные символы при наборе'), [['on', tr('Включены')], ['off', tr('Выключены')]], view.smartSymbols ? 'on' : 'off', (v) => setView({ smartSymbols: v === 'on' }));
    const motion = choice<string>('cs-motion', tr('Анимации интерфейса'), [['on', tr('Включены')], ['off', tr('Выключены')]], view.motion ? 'on' : 'off', (v) => setView({ motion: v === 'on' }));
    const sounds = choice<string>('cs-sounds', tr('Звуки'), [['on', tr('Включены')], ['off', tr('Выключены')]], view.sounds ? 'on' : 'off', (v) => {
      setView({ sounds: v === 'on' });
      // Heard at once: so the choice can be judged.
      if (v === 'on') {
        setSoundsEnabled(true);
        play('snap');
      }
    });
    const saved = read(MAIL_COMMENTS_KEY);
    const mail = prefsSignedIn()
      ? choice<CommentMail>('cs-mail', tr('Письма о комментариях'), [['all', tr('Ответы и упоминания')], ['mentions', tr('Только упоминания')], ['none', tr('Не присылать')]], saved === 'mentions' || saved === 'none' ? saved : 'all', (v) => write(MAIL_COMMENTS_KEY, v))
      : null;
    const close = h('button', { class: 'icon-button', type: 'button', title: tr('Закрыть (Esc)'), 'aria-label': tr('Закрыть'), onclick: () => this.close() }, icon('close'));
    const dialog = h(
      'div',
      { class: 'dialog settings-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('Настройки') },
      h('header', { class: 'dialog-header' }, h('h2', {}, tr('Настройки')), close),
      h(
        'div',
        { class: 'settings-body' },
        language,
        theme,
        size,
        h('p', { class: 'settings-note' }, tr('Размер текста и кнопок панелей; холст не меняется.')),
        dock,
        bar,
        labels,
        cursors,
        h('p', { class: 'settings-note' }, tr('Курсоры других людей в файле; их выделения видны всё равно.')),
        smart,
        h('p', { class: 'settings-note' }, tr('При наборе: -- → —, -> → →, ... → …, кавычки — «ёлочки» в русском тексте. Backspace сразу после замены возвращает набранное.')),
        motion,
        h('p', { class: 'settings-note' }, tr('Объект мягко доезжает до направляющей, вставленное слегка пружинит, переход к объекту — плавный. Если в системе включено «Уменьшить движение», анимаций нет.')),
        sounds,
        h('p', { class: 'settings-note' }, tr('Тихие звуки: прилипание к направляющей, вставка, отмена, готовый экспорт.')),
        nudgeRow(),
        h('p', { class: 'settings-note' }, tr('Насколько стрелки сдвигают выделенные слои, в пикселях.')),
        mail,
        h('p', { class: 'settings-note' }, tr('Настройки запоминаются в вашем аккаунте, а без входа — в этом браузере.')),
      ),
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
    (dialog.querySelector('input:checked') as HTMLElement | null)?.focus();
  }

  close(): void {
    this.overlay.remove();
  }
}
