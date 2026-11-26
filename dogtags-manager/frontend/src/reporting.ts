/** All Dogtags data requests pass through Reporting's session and page ACL. */
export function reportingHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  const session = localStorage.getItem('reportingSessionId');
  if (session) headers.set('X-Session-Id', session);
  return headers;
}

export function dogtagsApiPath(path: string): string {
  return path.replace(/^\/api(?=\/|$)/, '/api/dogtags-manager');
}

export function appPath(search = ''): string {
  return `${import.meta.env.BASE_URL}${search}`;
}

export function initReportingTheme(): void {
  const apply = (theme: unknown) => {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  };
  apply(localStorage.getItem('reporting.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const receive = (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    if (event.data?.type === 'reporting-theme') apply(event.data.theme);
  };
  const storage = (event: StorageEvent) => {
    if (event.key === 'reporting.theme') apply(event.newValue);
  };
  window.addEventListener('message', receive);
  window.addEventListener('storage', storage);
}
