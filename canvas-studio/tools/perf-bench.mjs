// Perf bench (PERF-008): real files opened in the editor of one or more running servers (`--dev`, e.g. this
// version and an older one from a git worktree), in Chromium (CPU ×4, a modest laptop) and WebKit (Safari's
// engine). Measured: opening, frames while panning, zooming and dragging, an edit's way to the screen.
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node tools/perf-bench.mjs <out.json> now=http://127.0.0.1:8080 [old=…] -- <file> …
// Playwright is not a dependency of the project: point PLAYWRIGHT at any copy (npx playwright install keeps one).
const { chromium, webkit } = await import(process.env.PLAYWRIGHT ?? 'playwright');
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const out = args.shift();
const split = args.indexOf('--');
const versions = args.slice(0, split).map((a) => a.split('='));
const files = args.slice(split + 1);
const RUNS = [
  ['chromium×4', chromium, 4],
  ['webkit', webkit, 1],
];

const stats = (iv) => {
  if (!iv.length) return null;
  const s = [...iv].sort((a, b) => a - b);
  const total = iv.reduce((a, b) => a + b, 0);
  return { fps: Math.round((iv.length / total) * 1000), p95: Math.round(s[Math.floor(s.length * 0.95)]), max: Math.round(s.at(-1)), long: iv.filter((x) => x > 50).length };
};

async function measure(page, file) {
  const fig = file.endsWith('.fig');
  const t0 = Date.now();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), page.evaluate((id) => { const a = window.canvasStudio; return a.runCommand ? a.runCommand(id) : a.commands.find((c) => c.id === id).run(); }, fig ? 'file.importFig' : 'file.importNative')]);
  await chooser.setFiles(file);
  await page.waitForFunction(() => {
    const e = window.canvasStudio?.editor;
    return e && e.doc.children(e.pageId).length > 0 && !document.querySelector('.boot');
  }, null, { timeout: 120000 });
  // Drawn: two frames after the document is there.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const open = Date.now() - t0;
  await page.waitForTimeout(1500);
  const nodes = await page.evaluate(() => {
    const e = window.canvasStudio.editor;
    let n = 0;
    const walk = (id) => { n++; for (const c of e.doc.children(id) ?? []) walk(c); };
    walk(e.pageId);
    return n;
  });
  await page.keyboard.press('Shift+1');
  await page.waitForTimeout(800);
  const box = await page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const rec = async (fn) => {
    await page.evaluate(() => { window.__iv = []; let last = performance.now(); window.__on = true; const tick = (t) => { window.__iv.push(t - last); last = t; if (window.__on) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    await fn();
    await page.waitForTimeout(150);
    return stats(await page.evaluate(() => { window.__on = false; return window.__iv.slice(1); }));
  };
  await page.mouse.move(cx, cy);
  const pan = await rec(async () => { for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, i < 30 ? 40 : -40); await page.waitForTimeout(16); } });
  const zoom = await rec(async () => {
    await page.keyboard.down('Control');
    for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, i < 15 ? -20 : 20); await page.waitForTimeout(16); }
    await page.keyboard.up('Control');
  });
  // Drag the largest top-level layer by 300 px, as a hand would.
  const at = await page.evaluate(() => {
    const e = window.canvasStudio.editor; const d = e.doc;
    const ids = d.children(e.pageId);
    const id = ids.slice().sort((a, b) => d.get(b, 'width') * d.get(b, 'height') - d.get(a, 'width') * d.get(a, 'height'))[0];
    const r = document.querySelector('canvas').getBoundingClientRect();
    const p = e.viewport.worldToScreen({ x: d.get(id, 'x') + Math.min(40, d.get(id, 'width') / 2), y: d.get(id, 'y') + Math.min(40, d.get(id, 'height') / 2) });
    e.setSelection([id]);
    return { x: r.x + p.x, y: r.y + p.y };
  });
  await page.waitForTimeout(300);
  const drag = await rec(async () => {
    await page.mouse.move(at.x, at.y); await page.mouse.down();
    for (let i = 1; i <= 40; i++) { await page.mouse.move(at.x + i * 7, at.y + i * 3); await page.waitForTimeout(16); }
    await page.mouse.up();
  });
  // An edit's way to the screen: 20 small changes, each until it is drawn.
  const edit = await page.evaluate(async () => {
    const e = window.canvasStudio.editor; const d = e.doc; const id = e.selection[0];
    const t = [];
    for (let i = 0; i < 20; i++) {
      const s = performance.now();
      e.commit('bench', (tx) => tx.set(id, 'x', d.get(id, 'x') + 1));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      t.push(performance.now() - s);
    }
    t.sort((a, b) => a - b);
    return { p50: Math.round(t[10]), p95: Math.round(t[18]), max: Math.round(t[19]) };
  });
  return { file: basename(file), nodes, open, pan, zoom, drag, edit };
}

const results = [];
for (const [run, type, cpu] of RUNS) {
  const browser = await type.launch();
  for (const [version, base] of versions) {
    for (const file of files) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await ctx.addInitScript(() => { try { localStorage.setItem('cs.mode', 'local'); } catch {} });
      const page = await ctx.newPage();
      if (cpu > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu }); }
      page.on('dialog', (d) => d.accept().catch(() => {}));
      try {
        await page.goto(base + '/?new=1', { waitUntil: 'load' });
        await page.waitForFunction(() => window.canvasStudio?.editor, null, { timeout: 60000 });
        await page.waitForTimeout(1000);
        const r = await measure(page, file);
        results.push({ run, version, ...r });
        console.log(JSON.stringify({ run, version, ...r }));
      } catch (err) {
        results.push({ run, version, file: basename(file), error: String(err.message || err).slice(0, 200) });
        console.log('ERR', run, version, basename(file), String(err.message || err).slice(0, 200));
      }
      await ctx.close();
      writeFileSync(out, JSON.stringify(results, null, 1));
    }
  }
  await browser.close();
}
