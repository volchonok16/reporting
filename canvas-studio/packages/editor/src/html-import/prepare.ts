// @ts-nocheck — ported as is from the "HTML to Layers" Figma plugin (html-to-figma/ui.html).
// Prepares the HTML of a page chosen from files or a folder: pictures, CSS,
// fonts and SVG sprites the page refers to are found among the chosen files
// and put inline as data: URLs, so the sandboxed page renders without a
// server. Plain JavaScript (like runtime.ts), wrapped in a factory over the
// chosen files.

import { tr } from '#core';
/** Reads a File into memory; Safari sometimes refuses one way, so try several. */
export async function readFileBuf(file) {
  try { return await file.arrayBuffer(); } catch (e) { /* next */ }
  try {
    return await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsArrayBuffer(file);
    });
  } catch (e) { /* next */ }
  try { return await new Response(file).arrayBuffer(); } catch (e) { /* next */ }
  const u = URL.createObjectURL(file);
  try { const r = await fetch(u); return await r.arrayBuffer(); }
  finally { URL.revokeObjectURL(u); }
}

/**
 * files: [{ path, file, buf? }] — everything chosen (the page and its assets);
 * selected: the HTML file among them (or null for pasted code).
 */
export function createPreparer(files, selected) {
  const t = (key, name) => tr('Браузер не дал прочитать «') + name + tr('». Выберите файл ещё раз или вставьте код страницы.');
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
    mp4: 'video/mp4', webm: 'video/webm', html: 'text/html', htm: 'text/html' };
  const dataUrlCache = new Map();

  function normPath(p) {
    const out = [];
    for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
    return out.join('/');
  }
  function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  function isExternal(ref) { return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref); }

  function findAsset(ref, baseDir) {
    let clean = ref.split('#')[0].split('?')[0];
    try { clean = decodeURIComponent(clean); } catch (e) { /* ignore */ }
    if (!clean) return null;
    const byPath = new Map(files.map((f) => [f.path, f]));
    const candidates = [];
    if (clean.startsWith('/')) {
      const rootDir = selected ? selected.path.split('/')[0] : '';
      candidates.push(normPath(clean), normPath(rootDir + '/' + clean));
    } else {
      candidates.push(normPath((baseDir ? baseDir + '/' : '') + clean));
    }
    for (const c of candidates) if (byPath.has(c)) return byPath.get(c);
    const tail = '/' + normPath(clean.replace(/^(\.\.\/)+/, ''));
    const suffix = files.filter((f) => ('/' + f.path).endsWith(tail));
    if (suffix.length) return suffix.sort((a, b) => a.path.length - b.path.length)[0];
    const base = clean.split('/').pop();
    const same = files.filter((f) => f.path.split('/').pop() === base);
    return same.length === 1 ? same[0] : null;
  }

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function fileBuf(f) {
    if (f.buf) return f.buf;
    try { f.buf = await readFileBuf(f.file); return f.buf; }
    catch (e) { throw new Error(t('unreadable', f.path.split('/').pop())); }
  }

  function fileToDataUrl(f) {
    if (dataUrlCache.has(f)) return dataUrlCache.get(f);
    const ext = (f.path.split('.').pop() || '').toLowerCase();
    const type = MIME[ext] || f.file.type || 'application/octet-stream';
    const p = fileBuf(f).then((buf) => 'data:' + type + ';base64,' + bytesToB64(new Uint8Array(buf))).catch(() => null);
    dataUrlCache.set(f, p);
    return p;
  }

  async function readText(f) {
    const buf = await fileBuf(f);
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(buf);
    const head = new TextDecoder('latin1').decode(buf.slice(0, 4096));
    const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i) || head.match(/@charset\s+["']([\w-]+)/i);
    const label = m ? m[1].toLowerCase() : 'utf-8';
    try { return new TextDecoder(label).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
  }

  async function replaceAsync(str, re, fn) {
    const jobs = [];
    str.replace(re, (...args) => { jobs.push(fn(...args)); return args[0]; });
    const vals = await Promise.all(jobs);
    let i = 0;
    return str.replace(re, () => vals[i++]);
  }

  async function rewriteUrl(ref, baseDir) {
    const r = ref.trim();
    if (!r) return ref;
    if (r.startsWith('//')) return 'https:' + r;
    if (isExternal(r)) return ref;
    const f = findAsset(r, baseDir);
    if (!f) return ref;
    const hash = r.includes('#') ? '#' + r.split('#')[1] : '';
    const du = await fileToDataUrl(f);
    if (!du) return ref;
    return du + (/\.svg$/i.test(f.path) ? hash : '');
  }

  async function processCss(css, cssPath, depth, hoist) {
    const top = !hoist;
    hoist = hoist || [];
    depth = depth || 0;
    const baseDir = dirOf(cssPath || '');
    css = css.replace(/@charset\s+["'][^"']*["']\s*;/gi, '');
    css = await replaceAsync(css, /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi, async (m, q, ref, media) => {
      if (ref.startsWith('//')) { hoist.push(m.replace(ref, 'https:' + ref)); return ''; }
      if (isExternal(ref)) { hoist.push(m); return ''; }
      const f = depth < 6 ? findAsset(ref, baseDir) : null;
      if (!f) return '';
      let text; try { text = await readText(f); } catch (e) { return ''; }
      const inner = await processCss(text, f.path, depth + 1, hoist);
      return media && media.trim() ? '@media ' + media.trim() + '{' + inner + '}' : inner;
    });
    css = await replaceAsync(css, /url\(\s*(["']?)([^"')]*?)\1\s*\)/gi, async (m, q, ref) => {
      if (/^data:/i.test(ref)) return m;
      const u = await rewriteUrl(ref, baseDir);
      return u === ref ? m : 'url("' + u + '")';
    });
    return top ? hoist.join('\n') + '\n' + css : css;
  }

  async function prepareHtml(html, htmlPath) {
    const baseDir = dirOf(htmlPath || '');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('meta[http-equiv]').forEach((m) => { if (/content-security-policy|refresh/i.test(m.getAttribute('http-equiv'))) m.remove(); });
    doc.querySelectorAll('base').forEach((b) => b.remove());

    for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      const href = link.getAttribute('href') || '';
      if (!/stylesheet/.test(rel)) continue;
      if (href.startsWith('//')) { link.setAttribute('href', 'https:' + href); continue; }
      if (isExternal(href)) continue;
      const f = findAsset(href, baseDir);
      if (!f) { link.remove(); continue; }
      const st = doc.createElement('style');
      if (link.getAttribute('media')) st.setAttribute('media', link.getAttribute('media'));
      let cssText = '';
      try { cssText = await readText(f); } catch (e) { /* пропускаем нечитаемый CSS */ }
      st.textContent = await processCss(cssText, f.path);
      st.setAttribute('data-h2d-inlined', '');
      link.replaceWith(st);
    }
    for (const st of doc.querySelectorAll('style:not([data-h2d-inlined])')) st.textContent = await processCss(st.textContent, htmlPath);
    doc.querySelectorAll('[data-h2d-inlined]').forEach((s) => s.removeAttribute('data-h2d-inlined'));

    const attrs = [['img', 'src'], ['img', 'srcset'], ['source', 'src'], ['source', 'srcset'], ['script', 'src'], ['video', 'src'],
      ['video', 'poster'], ['audio', 'src'], ['input', 'src'], ['embed', 'src'], ['object', 'data'], ['image', 'href'], ['image', 'xlink:href']];
    for (const [sel, attr] of attrs) {
      for (const el of doc.querySelectorAll(sel)) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        if (attr === 'srcset') {
          const parts = await Promise.all(v.split(',').map(async (c) => {
            const t = c.trim().split(/\s+/);
            t[0] = await rewriteUrl(t[0], baseDir);
            return t.join(' ');
          }));
          el.setAttribute(attr, parts.join(', '));
        } else {
          el.setAttribute(attr, await rewriteUrl(v, baseDir));
        }
      }
    }
    // SVG-спрайты: <use href="sprite.svg#id"> — вставляем спрайт в документ
    const sprites = new Map();
    for (const use of doc.querySelectorAll('use')) {
      const attr = use.hasAttribute('href') ? 'href' : 'xlink:href';
      const v = use.getAttribute(attr) || '';
      if (!v || v.startsWith('#') || !v.includes('#')) continue;
      const [file, frag] = v.split('#');
      if (isExternal(file)) continue;
      const f = findAsset(file, baseDir);
      if (!f) continue;
      if (!sprites.has(f)) { try { sprites.set(f, await readText(f)); } catch (e) { continue; } }
      use.setAttribute(attr, '#' + frag);
    }
    if (sprites.size && doc.body) {
      const holder = doc.createElement('div');
      holder.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
      holder.setAttribute('aria-hidden', 'true');
      holder.setAttribute('data-h2d', '');
      holder.innerHTML = Array.from(sprites.values()).join('\n').replace(/<\?xml[^>]*>/g, '');
      doc.body.insertBefore(holder, doc.body.firstChild);
    }
    for (const el of doc.querySelectorAll('[style]')) {
      const s = el.getAttribute('style');
      if (/url\(/i.test(s)) el.setAttribute('style', await processCss(s, htmlPath));
    }
    doc.querySelectorAll('img[loading]').forEach((i) => i.removeAttribute('loading'));
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  return { prepareHtml, readText };
}
