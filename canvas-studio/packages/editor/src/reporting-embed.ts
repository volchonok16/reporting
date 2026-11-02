// Встраивание во вкладку reporting: SSO и тема без отдельного логина Симметрики.

import { cloud } from './cloud.ts';
import { applyTheme, type ThemeChoice } from './theme.ts';

const EMBED_KEY = 'cs.reporting-embed';

export function isReportingEmbed(): boolean {
  try {
    if (sessionStorage.getItem(EMBED_KEY) === '1') return true;
  } catch {
    /* private mode */
  }
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function markReportingEmbed(): void {
  try {
    sessionStorage.setItem(EMBED_KEY, '1');
  } catch {
    /* ignore */
  }
}

function isFromReportingParent(event: MessageEvent): boolean {
  try {
    return event.source === window.parent && window.parent !== window;
  } catch {
    return false;
  }
}

function applyReportingTheme(theme: unknown): void {
  if (theme !== 'light' && theme !== 'dark') return;
  // В embed не пишем в localStorage — тема следует за reporting.
  applyTheme(theme as ThemeChoice, false);
}

/** Забирает reportingSso / embed / theme из URL; токен обменивает на сессию. */
export async function bootstrapReportingSso(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const token = params.get('reportingSso') || '';
  const embed = params.get('embed') === '1';
  const theme = params.get('theme');
  if (embed) markReportingEmbed();
  if (theme === 'light' || theme === 'dark') applyReportingTheme(theme);
  if (token || embed || theme) {
    params.delete('reportingSso');
    params.delete('embed');
    params.delete('theme');
    const next = `${location.pathname}${params.toString() ? `?${params.toString()}` : ''}${location.hash}`;
    history.replaceState({}, '', next);
  }
  if (!token) return false;
  await cloud.loginWithReportingSso(token);
  return true;
}

export function requestReportingSsoFromParent(): void {
  if (!isReportingEmbed()) return;
  try {
    window.parent.postMessage({ type: 'canvas-auth-required' }, '*');
  } catch {
    /* ignore */
  }
}

/** Слушает SSO и тему от reporting iframe parent. */
export function listenReportingSso(onDone?: () => void): () => void {
  const onMessage = (event: MessageEvent) => {
    if (!isFromReportingParent(event)) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'reporting-theme') {
      applyReportingTheme(data.theme);
      return;
    }
    if (data.type !== 'reporting-sso' || typeof data.token !== 'string') return;
    void cloud
      .loginWithReportingSso(data.token)
      .then(() => onDone?.())
      .catch(() => undefined);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/** Ждёт SSO от родителя (для chooseBackend в embed). */
export function waitForReportingSso(timeoutMs = 12_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      stop();
      window.clearTimeout(timer);
      resolve(ok);
    };
    const stop = listenReportingSso(() => done(true));
    const timer = window.setTimeout(() => done(false), timeoutMs);
  });
}
