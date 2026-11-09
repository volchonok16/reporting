import { lang, tr } from '#core';
import { App, applyTheme, bootstrapReportingSso, isReportingEmbed, listenReportingSso } from '#editor';

// The chosen theme before anything is drawn.
applyTheme();

const bootParams = new URLSearchParams(location.search);
const reportingEmbed = bootParams.has('embed') || isReportingEmbed();

// Service worker в iframe reporting мешает SSO/обновлениям — только для standalone.
if ('serviceWorker' in navigator && import.meta.url.endsWith('.js') && !reportingEmbed) {
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
  // A new deploy: its service worker takes over in the background, but this page still runs the
  // previous scripts. Outside an open file (nothing to interrupt) the page reloads once into the new version.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !new URLSearchParams(location.search).has('file')) location.reload();
  });
}

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

document.documentElement.lang = lang;
listenReportingSso();

const bootText = root.querySelector('.boot-text');
const params = bootParams;
if (bootText) bootText.textContent = params.has('present') ? tr('Открываю прототип…') : params.has('file') || params.has('new') ? tr('Открываю файл…') : tr('Загружаю файлы…');

void bootstrapReportingSso()
  .catch((error: unknown) => {
    console.warn('reporting SSO', error);
  })
  .then(() => {
    const q = new URLSearchParams(location.search);
    const fileId = q.get('file');
    // A prototype opened in its own tab shows only the viewer (FR-PRT-050); a file
    // (?file=<id>) or a new one (?new=1[&project=<id>]) opens the editor; anything
    // else is the home screen with sections, projects and files.
    const started: Promise<unknown> = q.has('present')
      ? App.presentStandalone(root, q)
      : fileId
        ? App.start(root, { fileId, link: q.get('t'), page: q.get('page'), node: q.get('node'), comment: q.get('comment') })
        : q.has('new')
          ? App.start(root, { create: { projectId: q.get('project'), example: q.has('example'), board: q.has('board'), diagram: q.has('diagram'), diagramKind: q.get('diagram'), slides: q.has('slides'), template: q.get('template') } })
          : App.home(root);
    return started;
  })
  .finally(() => root.querySelector('.boot')?.remove())
  .then((app) => {
    // Handy for debugging from the browser console.
    (window as unknown as { canvasStudio: unknown }).canvasStudio = app;
  })
  .catch((error: unknown) => {
    console.error(error);
    const q = new URLSearchParams(location.search);
    const fileId = q.get('file');
    const what = q.has('present') ? tr('Не удалось открыть прототип') : fileId || q.has('new') ? tr('Не удалось запустить редактор') : tr('Не удалось открыть список файлов');
    root.textContent = `${what}: ${error instanceof Error ? error.message : String(error)}`;
  });
