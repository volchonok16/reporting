// Встраивание во вкладку reporting: SSO и тема без отдельного логина Симметрики.

import { cloud, type CloudUser } from './cloud.ts';
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
  return !!(await beginReportingLogin(token));
}

let reportingLogin: Promise<CloudUser | null> | null = null;
const reportingWaiters = new Set<(user: CloudUser | null) => void>();

function notifyReportingLogin(user: CloudUser): void {
  const waiters = [...reportingWaiters];
  reportingWaiters.clear();
  for (const waiter of waiters) waiter(user);
}

/** Один обмен токена на сессию. Имя и фото приходят в ответе и не рисуются раньше. */
function beginReportingLogin(token: string): Promise<CloudUser | null> {
  const run = cloud.loginWithReportingSso(token).then(
    (user) => {
      notifyReportingLogin(user);
      return user;
    },
    () => null,
  );
  reportingLogin = run;
  return run;
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
    void beginReportingLogin(data.token).then((user) => {
      if (user) onDone?.();
    });
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/**
 * Ждёт пользователя из SSO. Если токен уже пришёл, пока шёл другой запрос,
 * возвращает его сразу и не держит экран до таймаута.
 */
export function waitForReportingUser(timeoutMs = 12_000): Promise<CloudUser | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (user: CloudUser | null) => {
      if (settled) return;
      settled = true;
      reportingWaiters.delete(finish);
      window.clearTimeout(timer);
      resolve(user);
    };
    if (reportingLogin) {
      void reportingLogin.then((user) => {
        if (user) finish(user);
      });
    }
    reportingWaiters.add(finish);
    const timer = window.setTimeout(() => finish(null), timeoutMs);
  });
}

/** Ждёт SSO от родителя (для chooseBackend в embed). */
export function waitForReportingSso(timeoutMs = 12_000): Promise<boolean> {
  return waitForReportingUser(timeoutMs).then((user) => user !== null);
}
