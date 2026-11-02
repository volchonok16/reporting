// Service worker: the editor starts without a network. The build puts its
// version and the list of its files in place of the two markers below. The
// page itself is asked from the network first (a new deploy shows at once)
// and taken from here when there is none; the other files are fixed per
// build, so they come from here. The API is never touched: files and their
// changes without a network are handled by the editor (offline.ts).

const VERSION = '__VERSION__';
const FILES = '__FILES__';
const CACHE = `cs-${VERSION}`;
/** The server has a newer build than this worker keeps: files go to the network. */
let newerBuild = false;

/**
 * A file from the network that does not hang (BUG-130): no answer begun in 8 s — once more
 * on a fresh connection, 15 s; a stuck connection kept the start on its skeleton for good.
 */
async function fetchAnswered(request) {
  for (const wait of [8000, 15000]) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), wait);
    try {
      return await fetch(request, { signal: ctl.signal });
    } catch {
      // the next try, or the kept copy
    } finally {
      clearTimeout(timer);
    }
  }
  throw new TypeError('no answer');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cs-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/html-sandbox') return;
  if (request.mode === 'navigate') {
    // The page: from the network when there is one, else the kept copy (?file=… opens the same page).
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          // A page of another build (a deploy since this worker came): its scripts come from the
          // network until the new worker takes over — else the page would still run the old code.
          // Known before the page is handed over: its scripts are asked for right after.
          if (response.ok && (response.headers.get('Content-Type') ?? '').startsWith('text/html')) {
            const html = await response.clone().text().catch(() => '');
            const build = /<meta name="cs-build" content="([^"]+)"/.exec(html)?.[1];
            if (build && build !== VERSION) {
              newerBuild = true;
              // The new worker is on its way: check for it now rather than at the next visit.
              self.registration.update().catch(() => undefined);
            }
          }
          return response;
        })
        .catch(() => caches.match('/', { cacheName: CACHE }).then((r) => r || Response.error())),
    );
    return;
  }
  if (newerBuild) {
    event.respondWith(fetchAnswered(request).catch(() => caches.match(request, { cacheName: CACHE, ignoreSearch: true }).then((r) => r || Response.error())));
    return;
  }
  event.respondWith(caches.match(request, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit || fetchAnswered(request)));
});
