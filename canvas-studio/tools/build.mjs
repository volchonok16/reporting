// Production build: copies the web app into dist/, stripping TypeScript and
// shrinking the JavaScript (comments and indentation go, see minify.mjs).
// No bundler: the output is native ES modules plus an import map.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { ROOT, transformHtml, transformTs } from './transform.mjs';
import { minify } from './minify.mjs';
import { createHash } from 'node:crypto';

const DIST = join(ROOT, 'dist');
const SOURCE_DIRS = ['packages', 'apps'];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Hidden files (.DS_Store of macOS and the like) never ship.
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests and server code never ship to the browser; nor the sources of the diagram engine (built into one file).
      if (entry.name === 'test' || entry.name === 'server' || relative(ROOT, full).split('\\').join('/') === 'packages/diagrams/vendor') continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

async function build() {
  const started = performance.now();
  await rm(DIST, { recursive: true, force: true });
  let modules = 0;
  let before = 0;
  let after = 0;
  const kept = [];
  for (const dir of SOURCE_DIRS) {
    for await (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      // The service worker template becomes dist/sw.js (see writeServiceWorker).
      if (rel.split('\\').join('/') === 'apps/web/sw.js') continue;
      // The neural network and its runtime (70 MB): not in the release, the server serves them from CS_HEAVY.
      if (rel.split('\\').join('/').startsWith('apps/web/heavy/')) continue;
      const ext = extname(file);
      if (ext === '.ts') {
        const out = join(DIST, rel.replace(/\.ts$/, '.js'));
        await mkdir(dirname(out), { recursive: true });
        const js = transformTs(await readFile(file, 'utf8'), { rewriteExtensions: true });
        const small = minify(js);
        if (!small.ok) kept.push(rel);
        before += js.length;
        after += small.code.length;
        await writeFile(out, small.code);
        modules++;
      } else if (rel.split('\\').join('/') === 'packages/diagrams/engine.js') {
        // The diagram engine (a classic script, loaded when a diagram opens): shrunk as the modules are.
        const out = join(DIST, rel);
        await mkdir(dirname(out), { recursive: true });
        const js = await readFile(file, 'utf8');
        const small = minify(js);
        if (!small.ok) kept.push(rel);
        before += js.length;
        after += small.code.length;
        await writeFile(out, small.code);
      } else if (ext === '.css') {
        // Comments out; the stylesheet has no strings that could hold "/*".
        const out = join(DIST, rel);
        await mkdir(dirname(out), { recursive: true });
        const css = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n+/g, '\n');
        await writeFile(out, css);
      } else if (ext !== '.html' || rel.split('\\').join('/').startsWith('apps/web/legal/')) {
        // Pages are built from index.html below; the legal pages (no scripts) are copied as they are.
        const out = join(DIST, rel);
        await mkdir(dirname(out), { recursive: true });
        await cp(file, out);
      }
    }
  }
  const html = await readFile(join(ROOT, 'apps/web/index.html'), 'utf8');
  await writeFile(join(DIST, 'index.html'), transformHtml(html, { extension: '.js' }));
  // Browsers ask for icons at the root whatever the page says (Safari, iOS "Add to Home Screen"):
  // without them they fall back to an icon remembered for the parent domain.
  for (const [from, to] of [
    ['favicon.ico', 'favicon.ico'],
    ['favicon.svg', 'favicon.svg'],
    ['apple-touch-icon.png', 'apple-touch-icon.png'],
    ['apple-touch-icon.png', 'apple-touch-icon-precomposed.png'],
  ]) await cp(join(ROOT, 'apps/web/icons', from), join(DIST, to));
  await writePreloads();
  await writeServiceWorker();
  const ms = Math.round(performance.now() - started);
  console.log(`Сборка готова: модулей — ${modules}, папка dist/, ${ms} мс`);
  console.log(`Скрипты: ${Math.round(before / 1024)} КБ → ${Math.round(after / 1024)} КБ (без комментариев и отступов)`);
  if (kept.length) console.log(`Оставлены как есть (проверка не прошла): ${kept.join(', ')}`);
}

/**
 * Modules the page needs at start, named in its head (PERF-005): without them the browser
 * learns of each module only after loading the one that imports it — a chain of ~250 round
 * trips, seconds on a mobile network. Static imports from the entry are followed (through the
 * import map); `import()` loaded later is left out.
 */
async function writePreloads() {
  const index = join(DIST, 'index.html');
  let html = await readFile(index, 'utf8');
  const map = JSON.parse(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/.exec(html)?.[1] ?? '{"imports":{}}').imports ?? {};
  const entry = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
  if (!entry) return;
  const seen = new Set();
  const order = [];
  const visit = async (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    let code;
    try {
      code = await readFile(join(DIST, url), 'utf8');
    } catch {
      return;
    }
    // import … from '…', export … from '…', import '…' — not import('…').
    const specs = [...code.matchAll(/(?:^|[;\s}])(?:import|export)\s*(?:[\w*${}\s,]+?\s*from\s*)?(['"])([^'"\n]+)\1/g)].map((m) => m[2]);
    for (const spec of specs) {
      const target = map[spec] ?? (spec.startsWith('.') ? new URL(spec, `http://x${url}`).pathname : null);
      if (target) await visit(target);
    }
    if (url !== entry) order.push(url);
  };
  await visit(entry);
  const links = order.map((u) => `    <link rel="modulepreload" href="${u}" />`).join('\n');
  html = html.replace('</head>', `${links}\n  </head>`);
  await writeFile(index, html);
  console.log(`Предзагрузка: модулей на старте — ${order.length}`);
}

/**
 * The service worker (offline start): it keeps every file of this build, so
 * the editor opens without a network. Its version is a hash of the build: a
 * new deploy is a new worker, which replaces the old files.
 */
async function writeServiceWorker() {
  const files = [];
  const hash = createHash('sha256');
  async function* all(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* all(full);
      else yield full;
    }
  }
  for await (const file of all(DIST)) {
    const rel = relative(DIST, file).split('\\').join('/');
    if (rel === 'sw.js') continue;
    hash.update(rel).update(await readFile(file));
    // Font files for OpenType features and outlines (TTF, ~1 MB each) are fetched when needed, not up front.
    if (rel.endsWith('.ttf')) continue;
    files.push(rel === 'index.html' ? '/' : `/${rel}`);
  }
  files.sort();
  const version = hash.digest('hex').slice(0, 12);
  const source = await readFile(join(ROOT, 'apps/web/sw.js'), 'utf8');
  // The page names its build: an older worker seeing a newer page takes the files from the network.
  const index = join(DIST, 'index.html');
  await writeFile(index, (await readFile(index, 'utf8')).replace('<head>', `<head>\n    <meta name="cs-build" content="${version}" />`));
  await writeFile(join(DIST, 'sw.js'), source.replace("'__VERSION__'", JSON.stringify(version)).replace("'__FILES__'", JSON.stringify(files)));
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
