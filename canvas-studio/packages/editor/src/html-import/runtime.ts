// @ts-nocheck — ported as is from the "HTML to Layers" Figma plugin (html-to-figma/ui.html).
// This function never runs in the editor: its source text is put into the
// sandboxed page that renders the imported HTML (see sandbox.ts). It waits for
// the page, reads the computed layout and styles of every element and sends
// back a tree of layers (frames, text, images, SVG) in Figma's terms; build.ts
// turns that tree into our document. Kept untyped on purpose: it must be
// plain JavaScript that a browser can run from its source text.

export function H2D_CHILD() {
  'use strict';
  if (window.__h2dInstalled) return;
  window.__h2dInstalled = true;

  // --- В песочнице нет localStorage/cookie: подставляем заглушки, чтобы скрипты страницы не падали
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try { window[name].getItem('__h2d'); ok = true; } catch (e) { /* no storage */ }
    if (ok) return;
    var m = new Map();
    var store = {
      getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(String(k), String(v)); },
      removeItem: function (k) { m.delete(String(k)); },
      clear: function () { m.clear(); },
      key: function (i) { var a = Array.from(m.keys()); return i < a.length ? a[i] : null; },
      get length() { return m.size; }
    };
    try { Object.defineProperty(window, name, { value: store, configurable: true }); } catch (e) { /* ignore */ }
  });
  try {
    var cookieJar = '';
    Object.defineProperty(document, 'cookie', { configurable: true, get: function () { return cookieJar; }, set: function (v) { cookieJar = String(v).split(';')[0]; } });
  } catch (e) { /* ignore */ }

  function post(msg, transfer) {
    msg.h2d = true;
    try { parent.postMessage(msg, '*', transfer || []); }
    catch (e) { parent.postMessage(msg, '*'); }
  }

  // The block drawn as a slide (a presentation imports only it, BUG-136): as wide as 40 % of the page
  // or more, the nearest to the asked proportions (within 3 %), of equals the largest; the same choice as
  // build.ts makes from the layers.
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.h2dCmd !== 'slideRect' || ev.source !== parent) return;
    var pageW = Math.max(document.documentElement.scrollWidth, innerWidth);
    var best = null;
    document.querySelectorAll('body *').forEach(function (el) {
      var r = el.getBoundingClientRect();
      var off = r.height > 0 ? Math.abs(r.width / r.height / d.aspect - 1) : 1;
      if (r.width < pageW * 0.4 || off >= 0.03) return;
      if (getComputedStyle(el).display === 'table') return;
      if (!best || off < best.off - 0.005 || (Math.abs(off - best.off) <= 0.005 && r.width * r.height > best.w * best.h)) best = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, el: el, off: off };
    });
    // What only floats over the slide (a toolbar, a «download» button) is not in it: the preview does not show it either.
    if (best) {
      document.querySelectorAll('body *').forEach(function (el) {
        if (el === best.el || best.el.contains(el) || el.contains(best.el)) return;
        var pos = getComputedStyle(el).position;
        if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') return;
        var r = el.getBoundingClientRect();
        var x = r.left + scrollX, y = r.top + scrollY;
        if (x < best.x + best.w && x + r.width > best.x && y < best.y + best.h && y + r.height > best.y) el.style.setProperty('visibility', 'hidden', 'important');
      });
    }
    post({ kind: 'slideRect', rect: best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null });
  });

  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.h2dCmd !== 'capture' || ev.source !== parent) return;
    run(d.opts || {}).then(function (res) {
      post({ kind: 'result', tree: res.tree, images: res.images, stats: res.stats }, res.transfer);
    }, function (err) {
      post({ kind: 'error', message: (err && (err.stack || err.message)) || String(err) });
    });
  });

  // =======================================================================
  // Утилиты
  // =======================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const px = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const r2 = (v) => Math.round(v * 100) / 100;
  const status = (text) => post({ kind: 'status', text: text });
  const CHILD_I18N = {
    ru: { wait: 'Жду загрузку страницы, шрифтов и картинок…', waitApp: 'Жду, пока приложение загрузится…', scroll: 'Прокручиваю страницу…', analyze: 'Анализирую вёрстку…',
      images: (a, b) => 'Загружаю изображения: ' + a + ' из ' + b, layers: 'Собираю слои…', vectors: 'Готовлю векторные иконки…',
      notLoaded: ' (не загрузилось)', embedded: ' (встроенный контент)', group: 'Блок' },
    en: { wait: 'Waiting for the page, fonts and images…', waitApp: 'Waiting for the app to finish loading…', scroll: 'Scrolling the page…', analyze: 'Analyzing the layout…',
      images: (a, b) => 'Loading images: ' + a + ' of ' + b, layers: 'Building layers…', vectors: 'Preparing vector icons…',
      notLoaded: ' (failed to load)', embedded: ' (embedded content)', group: 'Block' }
  };
  const TT = (k, ...a) => { const d = CHILD_I18N[OPTS && OPTS.lang] || CHILD_I18N.en; const v = d[k]; return typeof v === 'function' ? v(...a) : v; };

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'option',
    'optgroup', 'datalist', 'param', 'source', 'track', 'area', 'map', 'dialog:not([open])']);
  const NOT_INLINE = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'input', 'textarea', 'select',
    'button', 'picture', 'audio', 'math', 'meter', 'progress', 'hr', 'table']);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let csCache = new Map();
  function gcs(el) {
    let c = csCache.get(el);
    if (!c) { c = getComputedStyle(el); csCache.set(el, c); }
    return c;
  }

  function splitTop(s, sep) {
    const out = [];
    let depth = 0, cur = '', q = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        cur += ch;
        if (ch === '\\') { cur += s[++i] || ''; continue; }
        if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      const isSep = sep === ' ' ? /\s/.test(ch) : ch === sep;
      if (depth === 0 && isSep) {
        if (sep !== ' ' || cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function families(ff) {
    return splitTop(ff || '', ',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }

  // --- Цвета. Быстрый путь для rgb(); всё остальное (oklch, color(), lab…) — через canvas.
  const colorCache = new Map();
  let colorCtx = null;
  function parseColor(s) {
    if (!s) return null;
    s = String(s).trim();
    if (!s || s === 'transparent' || s === 'none' || s === 'currentcolor' || s === 'auto') return null;
    if (colorCache.has(s)) return colorCache.get(s);
    let res = null;
    const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/i);
    if (m) {
      const a = m[4] == null ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
      res = { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: a };
    } else {
      let alpha = 1, opaque = s;
      const am = s.match(/\/\s*([\d.]+)(%?)\s*\)$/);
      if (am) { alpha = parseFloat(am[1]) / (am[2] ? 100 : 1); opaque = s.slice(0, am.index) + ')'; }
      if (!colorCtx) {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        colorCtx = c.getContext('2d', { willReadFrequently: true });
      }
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#010203';
      colorCtx.fillStyle = opaque;
      if (String(colorCtx.fillStyle).toLowerCase() === '#010203' && !/^#010203$/i.test(opaque)) {
        res = null;
      } else {
        colorCtx.fillRect(0, 0, 1, 1);
        const d = colorCtx.getImageData(0, 0, 1, 1).data;
        res = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: alpha * d[3] / 255 };
      }
    }
    colorCache.set(s, res);
    return res;
  }
  function solid(c) { return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a }; }
  function hex(c) {
    const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return '#' + h(c.r) + h(c.g) + h(c.b);
  }

  // --- Матрицы 2×3
  function inv(A) {
    const a = A[0][0], b = A[0][1], tx = A[0][2], c = A[1][0], d = A[1][1], ty = A[1][2];
    let det = a * d - b * c;
    if (Math.abs(det) < 1e-12) det = 1e-12;
    return [[d / det, -b / det, (b * ty - d * tx) / det], [-c / det, a / det, (c * tx - a * ty) / det]];
  }

  // --- Градиенты
  function parseAngle(tok) {
    const m = String(tok).match(/^(-?[\d.]+)(deg|rad|turn|grad)$/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return m[2] === 'deg' ? v : m[2] === 'rad' ? v * 180 / Math.PI : m[2] === 'turn' ? v * 360 : v * 0.9;
  }

  function parseStops(args) {
    const out = [];
    for (const a of args) {
      const toks = splitTop(a, ' ');
      const pos = [];
      while (toks.length > 1 && /^-?[\d.]+(px|%|em|rem)?$/.test(toks[toks.length - 1])) pos.unshift(toks.pop());
      if (toks.length === 1 && /^-?[\d.]+(px|%)?$/.test(toks[0])) continue; // подсказка интерполяции
      const c = parseColor(toks.join(' '));
      if (!c) continue;
      if (!pos.length) out.push({ c: c, p: null });
      else pos.forEach((p) => out.push({ c: c, p: p }));
    }
    return out;
  }

  function resolveStops(stops, L) {
    const vals = stops.map((s) => {
      if (s.p == null) return null;
      const n = parseFloat(s.p);
      if (/%$/.test(s.p)) return n / 100;
      if (/r?em$/.test(s.p)) return (n * 16) / L;
      return n / L;
    });
    if (vals[0] == null) vals[0] = 0;
    if (vals[vals.length - 1] == null) vals[vals.length - 1] = 1;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] == null) {
        let j = i;
        while (vals[j] == null) j++;
        const a = vals[i - 1], b = vals[j];
        for (let k = i; k < j; k++) vals[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
      }
      if (vals[i] < vals[i - 1]) vals[i] = vals[i - 1];
    }
    return stops.map((s, i) => ({
      position: Math.max(0, Math.min(1, vals[i])),
      color: { r: s.c.r, g: s.c.g, b: s.c.b, a: s.c.a }
    }));
  }

  function posToken(tok, size, isX) {
    if (tok == null) return size / 2;
    if (tok === 'center') return size / 2;
    if (tok === 'left' || tok === 'top') return 0;
    if (tok === 'right' || tok === 'bottom') return size;
    if (/%$/.test(tok)) return (size * parseFloat(tok)) / 100;
    return px(tok);
  }

  function repeatStops(res, repeating) {
    if (!repeating || res.length < 2) return res;
    const a = res[0].position, b = res[res.length - 1].position, p = b - a;
    if (p <= 0.001 || p >= 0.999 || 1 / p > 60) return res;
    const out = [];
    for (let k = 0; a + k * p < 1; k++) {
      for (const s of res) {
        const pos = s.position + k * p;
        if (pos > 1) break;
        out.push({ position: pos, color: s.color });
      }
    }
    return out;
  }

  function gradientPaint(str, w, h) {
    const m = String(str).match(/^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i);
    if (!m) return null;
    const kind = m[2].toLowerCase();
    let args = splitTop(m[3], ',');
    if (!args.length) return null;
    w = Math.max(w, 0.01); h = Math.max(h, 0.01);
    let dir = null;
    const first = args[0].replace(/\bin\s+[a-z0-9-]+(\s+(shorter|longer|increasing|decreasing)\s+hue)?/i, '').trim();
    const firstTok = splitTop(first, ' ')[0];
    if (!first || !parseColor(firstTok)) { dir = first; args = args.slice(1); }
    const stops = parseStops(args);
    if (!stops.length) return null;

    if (kind === 'linear') {
      let ang = 180;
      if (dir) {
        if (/^to\s/.test(dir)) {
          const t = /top/.test(dir), b = /bottom/.test(dir), l = /left/.test(dir), r = /right/.test(dir);
          const A = (Math.atan2(h, w) * 180) / Math.PI;
          if (t && r) ang = A; else if (b && r) ang = 180 - A; else if (b && l) ang = 180 + A; else if (t && l) ang = 360 - A;
          else if (t) ang = 0; else if (r) ang = 90; else if (b) ang = 180; else if (l) ang = 270;
        } else {
          const a = parseAngle(dir);
          if (a != null) ang = a;
        }
      }
      const th = (ang * Math.PI) / 180;
      const dx = Math.sin(th), dy = -Math.cos(th);
      const L = Math.abs(w * dx) + Math.abs(h * dy) || 1;
      const sx = w / 2 - (dx * L) / 2, sy = h / 2 - (dy * L) / 2;
      const ex = w / 2 + (dx * L) / 2, ey = h / 2 + (dy * L) / 2;
      const s = [sx / w, sy / h], e = [ex / w, ey / h];
      const u = [e[0] - s[0], e[1] - s[1]];
      const v = [-u[1], u[0]];
      const A = [[u[0], v[0], s[0] - 0.5 * v[0]], [u[1], v[1], s[1] - 0.5 * v[1]]];
      return { type: 'GRADIENT_LINEAR', gradientTransform: inv(A), gradientStops: repeatStops(resolveStops(stops, L), !!m[1]) };
    }

    if (kind === 'radial') {
      let shape = 'ellipse', size = 'farthest-corner', lens = [], cx = w / 2, cy = h / 2;
      if (dir) {
        const parts = dir.split(/\bat\b/);
        for (const t of splitTop(parts[0] || '', ' ')) {
          if (t === 'circle' || t === 'ellipse') shape = t;
          else if (/^(closest|farthest)-(side|corner)$/.test(t)) size = t;
          else if (/^-?[\d.]+(px|%)?$/.test(t)) lens.push(t);
        }
        if (parts[1]) {
          const pt = splitTop(parts[1].trim(), ' ');
          let xt = pt[0], yt = pt[1];
          if (xt === 'top' || xt === 'bottom') { const tmp = xt; xt = yt || 'center'; yt = tmp; }
          cx = posToken(xt, w, true);
          cy = posToken(yt, h, false);
        }
        if (lens.length === 1 && shape !== 'ellipse') shape = 'circle';
      }
      let rx, ry;
      if (lens.length) {
        rx = /%$/.test(lens[0]) ? (w * parseFloat(lens[0])) / 100 : px(lens[0]);
        ry = lens[1] ? (/%$/.test(lens[1]) ? (h * parseFloat(lens[1])) / 100 : px(lens[1])) : rx;
      } else {
        const dxs = [cx, w - cx].map(Math.abs), dys = [cy, h - cy].map(Math.abs);
        const minX = Math.min(...dxs), maxX = Math.max(...dxs), minY = Math.min(...dys), maxY = Math.max(...dys);
        if (shape === 'circle') {
          if (size === 'closest-side') rx = ry = Math.min(minX, minY);
          else if (size === 'farthest-side') rx = ry = Math.max(maxX, maxY);
          else if (size === 'closest-corner') rx = ry = Math.hypot(minX, minY);
          else rx = ry = Math.hypot(maxX, maxY);
        } else {
          if (size === 'closest-side') { rx = minX; ry = minY; }
          else if (size === 'farthest-side') { rx = maxX; ry = maxY; }
          else if (size === 'closest-corner') { rx = minX * Math.SQRT2; ry = minY * Math.SQRT2; }
          else { rx = maxX * Math.SQRT2; ry = maxY * Math.SQRT2; }
        }
      }
      rx = Math.max(rx, 0.01); ry = Math.max(ry, 0.01);
      const A = [[(2 * rx) / w, 0, (cx - rx) / w], [0, (2 * ry) / h, (cy - ry) / h]];
      return { type: 'GRADIENT_RADIAL', gradientTransform: inv(A), gradientStops: repeatStops(resolveStops(stops, rx), !!m[1]) };
    }

    // conic → angular
    let from = 0, cx = w / 2, cy = h / 2;
    if (dir) {
      const fm = dir.match(/from\s+(-?[\d.]+(?:deg|rad|turn|grad))/);
      if (fm) from = parseAngle(fm[1]) || 0;
      const at = dir.split(/\bat\b/)[1];
      if (at) { const pt = splitTop(at.trim(), ' '); cx = posToken(pt[0], w, true); cy = posToken(pt[1], h, false); }
    }
    const phi = ((from - 90) * Math.PI) / 180;
    const c = Math.cos(phi), s = Math.sin(phi);
    const ncx = cx / w, ncy = cy / h;
    const A = [[c, -s, ncx - 0.5 * c + 0.5 * s], [s, c, ncy - 0.5 * s - 0.5 * c]];
    return { type: 'GRADIENT_ANGULAR', gradientTransform: inv(A), gradientStops: resolveStops(stops, 360) };
  }

  function extractUrls(str) {
    const out = [];
    let i = 0;
    while ((i = str.indexOf('url(', i)) !== -1) {
      i += 4;
      while (str[i] === ' ') i++;
      let u = '';
      const q = str[i];
      if (q === '"' || q === "'") {
        i++;
        while (i < str.length && str[i] !== q) {
          if (str[i] === '\\') { u += str[i + 1] || ''; i += 2; continue; }
          u += str[i++];
        }
        i++;
      } else {
        while (i < str.length && str[i] !== ')') u += str[i++];
      }
      out.push(u.trim());
    }
    return out;
  }

  function parseShadows(str, isText) {
    if (!str || str === 'none') return [];
    const out = [];
    for (const part of splitTop(str, ',')) {
      const toks = splitTop(part, ' ');
      const inset = toks.includes('inset');
      const lens = [], colorToks = [];
      for (const t of toks) {
        if (t === 'inset') continue;
        if (/^-?[\d.]+(px)?$/.test(t)) lens.push(px(t)); else colorToks.push(t);
      }
      const c = parseColor(colorToks.join(' ') || 'rgb(0,0,0)');
      if (!c || c.a < 0.01) continue;
      out.push({
        type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
        color: c, x: lens[0] || 0, y: lens[1] || 0, radius: lens[2] || 0, spread: isText ? 0 : (lens[3] || 0)
      });
    }
    return out;
  }

  function parseFilters(cs) {
    const out = [];
    const f = cs.filter;
    if (f && f !== 'none') {
      const b = f.match(/blur\(([\d.]+)px\)/);
      if (b && px(b[1]) > 0) out.push({ type: 'LAYER_BLUR', radius: px(b[1]) * 2 });
      const re = /drop-shadow\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
      let m;
      while ((m = re.exec(f))) out.push(...parseShadows(m[1], true));
    }
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    if (bf && bf !== 'none') {
      const b = bf.match(/blur\(([\d.]+)px\)/);
      if (b && px(b[1]) > 0) out.push({ type: 'BACKGROUND_BLUR', radius: px(b[1]) * 2 });
    }
    return out;
  }

  // =======================================================================
  // Подготовка страницы
  // =======================================================================
  async function waitReady() {
    if (document.readyState !== 'complete') {
      await Promise.race([new Promise((r) => window.addEventListener('load', r, { once: true })), sleep(15000)]);
    }
    try { await Promise.race([document.fonts.ready, sleep(5000)]); } catch (e) { /* ignore */ }
  }

  async function waitImages(timeout) {
    const imgs = Array.from(document.images).filter((i) => !i.complete);
    if (!imgs.length) return;
    await Promise.race([
      Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      sleep(timeout)
    ]);
  }

  function eagerImages() {
    for (const img of document.querySelectorAll('img[loading]')) img.loading = 'eager';
    for (const f of document.querySelectorAll('iframe[loading]')) f.loading = 'eager';
  }

  async function scrollThrough() {
    const se = document.scrollingElement || document.documentElement;
    const H = Math.max(se.scrollHeight, document.body ? document.body.scrollHeight : 0);
    const step = Math.max(200, window.innerHeight * 0.5);
    for (let y = 0; y < H; y += step) {
      window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      await sleep(45);
    }
    window.scrollTo({ top: H, left: 0, behavior: 'instant' });
    await sleep(200);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await sleep(250);
  }

  function freezeAnimations() {
    try {
      for (const a of document.getAnimations()) {
        try {
          const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
          if (t && t.iterations === Infinity) { a.pause(); a.currentTime = 0; }
          else a.finish();
        } catch (e) {
          try { a.pause(); } catch (e2) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
    const st = document.createElement('style');
    st.textContent = '*,*::before,*::after{transition:none!important;animation-play-state:paused!important;caret-color:transparent!important}';
    (document.head || document.documentElement).appendChild(st);
  }

  // ::before / ::after превращаем в настоящие элементы, чтобы у них были координаты.
  function parseContent(content, el) {
    if (!content || content === 'none' || content === 'normal') return null;
    let text = '', url = null, i = 0;
    const s = content;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        i++;
        while (i < s.length && s[i] !== ch) {
          if (s[i] === '\\') {
            const hm = s.slice(i + 1).match(/^([0-9a-fA-F]{1,6})\s?/);
            if (hm) { text += String.fromCodePoint(parseInt(hm[1], 16)); i += 1 + hm[0].length; continue; }
            text += s[i + 1] || ''; i += 2; continue;
          }
          text += s[i++];
        }
        i++;
      } else if (s.startsWith('attr(', i)) {
        const end = s.indexOf(')', i);
        const name = s.slice(i + 5, end).trim().split(/\s/)[0];
        text += el.getAttribute(name) || '';
        i = end + 1;
      } else if (s.startsWith('url(', i)) {
        const end = s.indexOf(')', i);
        url = extractUrls(s.slice(i, end + 1))[0] || null;
        i = end + 1;
      } else if (s.startsWith('counter', i)) {
        let depth = 0, j = i;
        for (; j < s.length; j++) { if (s[j] === '(') depth++; if (s[j] === ')') { depth--; if (!depth) break; } }
        i = j + 1;
      } else if (s.startsWith('open-quote', i)) { text += '“'; i += 10; }
      else if (s.startsWith('close-quote', i)) { text += '”'; i += 11; }
      else if (ch === '/') break;
      else i++;
    }
    return { text: text, url: url };
  }

  function snapshot(el) {
    const list = [el.getBoundingClientRect()];
    for (const c of el.children) if (c.tagName !== 'H2D-PSEUDO') list.push(c.getBoundingClientRect());
    return list;
  }
  function sameSnap(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i].left - b[i].left) > 0.6 || Math.abs(a[i].top - b[i].top) > 0.6 ||
        Math.abs(a[i].width - b[i].width) > 0.6 || Math.abs(a[i].height - b[i].height) > 0.6) return false;
    }
    return true;
  }

  const PSEUDO_SKIP = new Set(['IMG', 'INPUT', 'TEXTAREA', 'SELECT', 'BR', 'HR', 'IFRAME', 'VIDEO', 'CANVAS', 'OPTION',
    'SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'OBJECT', 'EMBED', 'AUDIO', 'H2D-PSEUDO']);

  function materializePseudos() {
    const st = document.createElement('style');
    st.textContent = '[data-h2d-nb]::before{content:none!important;display:none!important}' +
      '[data-h2d-na]::after{content:none!important;display:none!important}' +
      'h2d-pseudo{animation:none!important;transition:none!important}';
    (document.head || document.documentElement).appendChild(st);
    const els = document.body ? [document.body, ...document.body.querySelectorAll('*')] : [];
    let count = 0;
    for (const el of els) {
      if (el.namespaceURI === SVG_NS || PSEUDO_SKIP.has(el.tagName)) continue;
      for (const which of ['::before', '::after']) {
        const cs = getComputedStyle(el, which);
        const content = cs.content;
        if (!content || content === 'none' || content === 'normal' || cs.display === 'none') continue;
        const parsed = parseContent(content, el);
        if (!parsed) continue;
        const before = snapshot(el);
        const p = document.createElement('h2d-pseudo');
        for (let i = 0; i < cs.length; i++) {
          const prop = cs[i];
          if (prop === 'content' || prop.startsWith('animation') || prop.startsWith('transition')) continue;
          p.style.setProperty(prop, cs.getPropertyValue(prop));
        }
        p.setAttribute('data-h2d-pseudo', which);
        if (parsed.text) p.textContent = parsed.text;
        if (parsed.url) {
          const img = document.createElement('img');
          img.src = parsed.url;
          img.style.cssText = 'display:inline-block;vertical-align:baseline';
          p.appendChild(img);
        }
        if (which === '::before') el.insertBefore(p, el.firstChild); else el.appendChild(p);
        el.setAttribute(which === '::before' ? 'data-h2d-nb' : 'data-h2d-na', '');
        const after = snapshot(el);
        if (!sameSnap(before, after)) {
          p.remove();
          el.removeAttribute(which === '::before' ? 'data-h2d-nb' : 'data-h2d-na');
        } else count++;
      }
    }
    return count;
  }

  // Повёрнутые элементы: снимаем трансформацию, запоминаем её и потом применяем в Figma.
  const rotMap = new Map();
  function stripRotations() {
    const els = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of els) {
      if (el.namespaceURI === SVG_NS && el.tagName.toLowerCase() !== 'svg') continue;
      if (el.closest && el.parentElement && el.parentElement.closest('svg')) continue;
      const cs = getComputedStyle(el);
      const hasRotate = cs.rotate && cs.rotate !== 'none';
      if (cs.transform === 'none' && !hasRotate) continue;
      let M;
      try {
        M = new DOMMatrix();
        if (cs.translate && cs.translate !== 'none') {
          const t = cs.translate.split(/\s+/);
          const tx = /%$/.test(t[0]) ? (el.offsetWidth * parseFloat(t[0])) / 100 : px(t[0]);
          const ty = t[1] ? (/%$/.test(t[1]) ? (el.offsetHeight * parseFloat(t[1])) / 100 : px(t[1])) : 0;
          M = M.translate(tx, ty);
        }
        if (hasRotate) {
          const a = parseAngle(cs.rotate.trim());
          if (a == null) continue;
          M = M.rotate(a);
        }
        if (cs.scale && cs.scale !== 'none') {
          const sc = cs.scale.split(/\s+/).map(parseFloat);
          M = M.scale(sc[0], sc[1] == null ? sc[0] : sc[1]);
        }
        if (cs.transform !== 'none') M = M.multiply(new DOMMatrix(cs.transform));
      } catch (e) { continue; }
      if (!M.is2D) continue;
      const ang = Math.atan2(M.b, M.a);
      if (Math.abs(ang) < 0.004) continue;
      const o = cs.transformOrigin.split(/\s+/).map(px);
      rotMap.set(el, { cos: Math.cos(ang), sin: Math.sin(ang), e: M.e, f: M.f, ox: o[0] || 0, oy: o[1] || 0 });
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('rotate', 'none', 'important');
      el.style.setProperty('translate', 'none', 'important');
      el.style.setProperty('scale', 'none', 'important');
    }
  }

  // =======================================================================
  // Картинки
  // =======================================================================
  const imageCache = new Map(); // url -> record
  const images = [];            // [{id, bytes}]

  function b64ToBytes(dataUrl) {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function registerBytes(bytes) {
    const id = images.length;
    images.push({ id: id, bytes: bytes });
    return id;
  }

  function imageId(rec) {
    if (!rec || rec.failed || !rec.bytes) return null;
    if (rec.id == null) rec.id = registerBytes(rec.bytes);
    return rec.id;
  }

  function loadImgEl(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }

  function canvasBytes(canvas) { return b64ToBytes(canvas.toDataURL('image/png')); }

  function svgIntrinsic(text) {
    try {
      const d = new DOMParser().parseFromString(text, 'image/svg+xml');
      const s = d.documentElement;
      if (!s || s.nodeName.toLowerCase() !== 'svg') return null;
      const abs = (v) => (v && /^[\d.]+(px)?$/.test(v.trim()) ? parseFloat(v) : null);
      let w = abs(s.getAttribute('width')), h = abs(s.getAttribute('height'));
      const vb = (s.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(parseFloat);
      if ((!w || !h) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        if (w && !h) h = (w * vb[3]) / vb[2];
        else if (h && !w) w = (h * vb[2]) / vb[3];
        else { w = vb[2]; h = vb[3]; }
      }
      return { w: w || 0, h: h || 0 };
    } catch (e) { return null; }
  }

  function sizeSvg(text, w, h, stretch) {
    try {
      const d = new DOMParser().parseFromString(text, 'image/svg+xml');
      const s = d.documentElement;
      if (!s || s.nodeName.toLowerCase() !== 'svg' || d.getElementsByTagName('parsererror').length) return null;
      const abs = (v) => (v && /^[\d.]+(px)?$/.test(v.trim()) ? parseFloat(v) : null);
      const ow = abs(s.getAttribute('width')), oh = abs(s.getAttribute('height'));
      if (!s.getAttribute('viewBox') && ow && oh) s.setAttribute('viewBox', '0 0 ' + ow + ' ' + oh);
      s.setAttribute('width', r2(w));
      s.setAttribute('height', r2(h));
      if (stretch) s.setAttribute('preserveAspectRatio', 'none');
      return new XMLSerializer().serializeToString(s);
    } catch (e) { return null; }
  }

  async function rasterSvg(svgText, w, h) {
    try {
      const scale = Math.min(3, 2048 / Math.max(w, h, 1));
      const img = await loadImgEl('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return canvasBytes(c);
    } catch (e) { return null; }
  }

  function isSupportedRaster(b) {
    if (b.length < 4) return false;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true; // PNG
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;                 // JPEG
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;                 // GIF
    return false;
  }

  async function loadImage(url) {
    let blob = null;
    try {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (r.ok) blob = await r.blob();
    } catch (e) { /* CORS или сеть */ }

    if (!blob) {
      // Картинка могла загрузиться в <img>, но без CORS — пробуем через canvas.
      try {
        const el = Array.from(document.images).find((i) => (i.currentSrc || i.src) === url && i.complete && i.naturalWidth);
        const img = el || (await loadImgEl(url));
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return { bytes: canvasBytes(c), w: c.width, h: c.height };
      } catch (e) {
        return { failed: true };
      }
    }

    const head = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
    if (/svg/i.test(blob.type) || (/^\s*(<\?xml|<\!--|<\!doctype svg|<svg)/i.test(head) && /<svg/i.test(head))) {
      const text = await blob.text();
      const dim = svgIntrinsic(text) || { w: 0, h: 0 };
      const rw = dim.w || 256, rh = dim.h || 256;
      const bytes = await rasterSvg(text, rw, rh);
      const scale = Math.min(3, 2048 / Math.max(rw, rh, 1));
      return { svgText: text, w: dim.w, h: dim.h, pw: Math.max(1, Math.round(rw * scale)), bytes: bytes };
    }

    let bytes = new Uint8Array(await blob.arrayBuffer());
    let w = 0, h = 0;
    try {
      const bmp = await createImageBitmap(blob);
      w = bmp.width; h = bmp.height;
      if (!isSupportedRaster(bytes) || w > 4096 || h > 4096) {
        const s = Math.min(1, 4096 / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        bytes = canvasBytes(c);
      }
      bmp.close && bmp.close();
    } catch (e) {
      if (!isSupportedRaster(bytes)) return { failed: true };
    }
    return { bytes: bytes, w: w, h: h };
  }

  function collectImageUrls() {
    const urls = new Set();
    for (const el of document.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'img') { const u = el.currentSrc || el.src; if (u) urls.add(u); }
      else if (tag === 'video' && el.poster) urls.add(el.poster);
      else if (tag === 'input' && (el.type || '').toLowerCase() === 'image' && el.src) urls.add(el.src);
      if (el.namespaceURI === SVG_NS && tag !== 'svg') continue;
      const cs = gcs(el);
      if (cs.display === 'none') continue;
      if (cs.backgroundImage && cs.backgroundImage !== 'none') for (const u of extractUrls(cs.backgroundImage)) if (u) urls.add(u);
    }
    return Array.from(urls);
  }

  async function loadAllImages(urls) {
    let idx = 0, done = 0;
    const worker = async () => {
      while (idx < urls.length) {
        const u = urls[idx++];
        try { imageCache.set(u, await loadImage(u)); } catch (e) { imageCache.set(u, { failed: true }); }
        done++;
        if (done % 5 === 0) status(TT('images', done, urls.length));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  }

  // =======================================================================
  // Обход DOM
  // =======================================================================
  let OPTS = {};
  let PAGE_H = 0;

  // Экран загрузки: fixed/absolute-слой почти на весь экран со спиннером или «load» в названии
  function findLoader() {
    const vw = innerWidth, vh = innerHeight;
    const pts = [[vw / 2, vh / 2], [vw / 4, vh / 3], [vw * 0.75, vh * 0.66]];
    for (const [x, y] of pts) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (el === document.documentElement || el === document.body) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.9 || r.height < vh * 0.9) continue;
        if (cs.visibility !== 'visible' || parseFloat(cs.opacity) < 0.05) continue;
        const name = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
        if (/load|spinner|splash|preload|boot|progress|skeleton/.test(name)) return el;
        if (el.querySelector('[class*="spin" i],[class*="load" i],[role="progressbar"],[aria-busy="true"],progress')) return el;
      }
    }
    return null;
  }

  // Ждём, пока страница «успокоится»: нет новых загрузок и изменений DOM, нет экрана загрузки
  async function waitQuiet(maxMs) {
    const start = performance.now();
    let last = performance.now();
    const mo = new MutationObserver(() => { last = performance.now(); });
    try { mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch (e) { /* ignore */ }
    let po = null;
    try { po = new PerformanceObserver(() => { last = performance.now(); }); po.observe({ type: 'resource' }); } catch (e) { po = null; }
    let announced = false;
    while (performance.now() - start < maxMs) {
      await sleep(150);
      const loader = findLoader();
      if (loader && !announced && performance.now() - start > 1200) { status(TT('waitApp')); announced = true; }
      if (!loader && performance.now() - last > 700) break;
    }
    mo.disconnect();
    if (po) po.disconnect();
  }

  // Приложения с высотой «в экран»: разворачиваем прокручиваемые панели на всю высоту содержимого
  function expandScrollers() {
    const SKIP_EXPAND = /^(textarea|select|iframe|input|video|canvas|svg)$/i;
    const relax = (el) => {
      const cs = getComputedStyle(el);
      const h = el.getBoundingClientRect().height;
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      if (h > 0) el.style.setProperty('min-height', h + 'px', 'important');
      if (cs.overflowY !== 'visible') el.style.setProperty('overflow-y', 'visible', 'important');
    };
    let total = 0;
    for (let pass = 0; pass < 4; pass++) {
      let changed = 0;
      const all = [document.documentElement].concat(document.body ? [document.body, ...document.body.querySelectorAll('*')] : []);
      for (const el of all) {
        if (el.namespaceURI === SVG_NS || SKIP_EXPAND.test(el.tagName) || el.hasAttribute('data-h2d-expanded')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.position === 'fixed') continue;
        const root = el === document.documentElement || el === document.body;
        const oy = cs.overflowY;
        const scrolls = oy === 'auto' || oy === 'scroll' || (root && oy === 'hidden');
        if (!scrolls || el.scrollHeight <= el.clientHeight + 4) continue;
        el.setAttribute('data-h2d-expanded', '');
        el.style.setProperty('overflow-y', 'visible', 'important');
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        for (let a = el.parentElement; a; a = a.parentElement) relax(a);
        changed++;
      }
      total += changed;
      if (!changed) break;
    }
    return total;
  }
  let ord = 0;
  let sx = 0, sy = 0;
  const svgTasks = [];     // растровые запасные варианты для SVG
  const skipBgFor = new Set();

  function absRect(r) { return { ax: r.left + sx, ay: r.top + sy, w: r.width, h: r.height }; }

  /** A text exported for a change by a description keeps its layer's name (frames get theirs in nameOf). */
  function ownName(node, el) {
    const own = el && el.getAttribute && el.getAttribute('data-name');
    if (own) node.name = own.length > 64 ? own.slice(0, 63) + '…' : own;
  }

  function nameOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'h2d-pseudo') return el.getAttribute('data-h2d-pseudo') || '::before';
    // A layer exported for a change by a description carries its own name.
    const own = el.getAttribute && el.getAttribute('data-name');
    if (own) return own.length > 64 ? own.slice(0, 63) + '…' : own;
    let n = tag;
    if (el.id) n += '#' + el.id;
    else if (el.classList && el.classList.length) n += '.' + Array.from(el.classList).slice(0, 2).join('.');
    if (tag === 'img' && el.alt) n = 'img: ' + el.alt;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && tag !== 'img') n += ' — ' + aria;
    return n.length > 64 ? n.slice(0, 63) + '…' : n;
  }

  function zKey(el, cs) {
    const positioned = cs.position !== 'static';
    let zi = cs.zIndex === 'auto' ? null : parseInt(cs.zIndex, 10);
    if (zi != null && !positioned) {
      const p = el.parentElement ? gcs(el.parentElement).display : '';
      if (!/flex|grid/.test(p)) zi = null;
    }
    const o = ord++;
    if (zi != null && zi < 0) return [0, zi, o];
    if (!positioned && zi == null) return [1, 0, o];
    if (zi != null && zi > 0) return [3, zi, o];
    return [2, 0, o];
  }
  function cmpZ(a, b) {
    const x = a.z || [1, 0, 0], y = b.z || [1, 0, 0];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }
  function createsStacking(el, cs) {
    return (cs.position !== 'static' && cs.zIndex !== 'auto') || parseFloat(cs.opacity) < 1 ||
      cs.transform !== 'none' || cs.isolation === 'isolate' || cs.mixBlendMode !== 'normal' || cs.filter !== 'none';
  }

  function hasBoxVisuals(cs) {
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a > 0.004) return true;
    if (cs.backgroundImage !== 'none') return true;
    if (cs.boxShadow !== 'none') return true;
    for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
      if (px(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && cs['border' + s + 'Style'] !== 'hidden') {
        const c = parseColor(cs['border' + s + 'Color']);
        if (c && c.a > 0.01) return true;
      }
    }
    return false;
  }

  function isIconFont(cs) {
    const f = (families(cs.fontFamily)[0] || '').toLowerCase();
    return /awesome|icon|symbols|glyph|feather|remix|ionic|lucide|phosphor|boxicons|bootstrap-icons|line-awesome|typicons|dashicons|octicon|fontello|icomoon/.test(f);
  }
  const PUA = /[-]|[\uDB80-\uDBFF][\uDC00-\uDFFF]/;

  // --- Стили текста
  const TC = { uppercase: 'UPPER', lowercase: 'LOWER', capitalize: 'TITLE' };

  function textFills(el, cs) {
    const c = parseColor(cs.webkitTextFillColor || cs.color);
    if (c && c.a >= 0.01) return [solid(c)];
    for (let a = el, i = 0; a && i < 8; a = a.parentElement, i++) {
      const acs = gcs(a);
      if (acs.webkitBackgroundClip === 'text' || acs.backgroundClip === 'text') {
        const r = a.getBoundingClientRect();
        const paints = [];
        const bc = parseColor(acs.backgroundColor);
        if (bc && bc.a > 0.01) paints.push(solid(bc));
        for (const layer of splitTop(acs.backgroundImage, ',').reverse()) {
          const g = gradientPaint(layer, r.width, r.height);
          if (g) paints.push(g);
        }
        if (paints.length) return paints;
      }
    }
    return null;
  }

  function decoFor(el, stopEl) {
    let under = false, strike = false;
    for (let a = el; a; a = a.parentElement) {
      const acs = gcs(a);
      const l = acs.textDecorationLine || acs.textDecoration || '';
      if (l.includes('underline')) under = true;
      if (l.includes('line-through')) strike = true;
      if (a === stopEl) break;
      if (acs.display !== 'inline' && acs.display !== 'contents') break;
    }
    return under ? 'UNDERLINE' : strike ? 'STRIKETHROUGH' : 'NONE';
  }

  function textStyle(el, cs, stopEl) {
    const a = el.closest && el.closest('a[href]');
    const href = a && /^https?:/i.test(a.href) ? a.href : null;
    return {
      fam: families(cs.fontFamily),
      w: parseInt(cs.fontWeight, 10) || 400,
      it: cs.fontStyle !== 'normal',
      size: r2(px(cs.fontSize)),
      fills: textFills(el, cs),
      deco: decoFor(el, stopEl || el),
      ls: cs.letterSpacing === 'normal' ? 0 : r2(px(cs.letterSpacing)),
      lh: cs.lineHeight === 'normal' ? null : r2(px(cs.lineHeight)),
      tc: TC[cs.textTransform] || 'ORIGINAL',
      href: href
    };
  }

  function wsMode(cs) {
    if (cs.whiteSpaceCollapse) {
      return cs.whiteSpaceCollapse === 'preserve' || cs.whiteSpaceCollapse === 'break-spaces' ? 'preserve' :
        cs.whiteSpaceCollapse === 'preserve-breaks' ? 'preserve-breaks' : 'collapse';
    }
    const ws = cs.whiteSpace;
    return ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces' ? 'preserve' : ws === 'pre-line' ? 'preserve-breaks' : 'collapse';
  }
  function isNowrap(cs) {
    return cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre' || cs.textWrapMode === 'nowrap' || cs.textWrap === 'nowrap';
  }

  function alignOf(cs) {
    const a = cs.textAlign;
    if (a === 'center' || a === '-webkit-center') return 'CENTER';
    if (a === 'right' || a === 'end' || a === '-webkit-right') return cs.direction === 'rtl' && a === 'end' ? 'LEFT' : 'RIGHT';
    if (a === 'justify') return 'JUSTIFIED';
    if (a === 'start' && cs.direction === 'rtl') return 'RIGHT';
    return 'LEFT';
  }

  function contentBox(cs, box) {
    const bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth), bt = px(cs.borderTopWidth), bb = px(cs.borderBottomWidth);
    const pl = px(cs.paddingLeft), pr = px(cs.paddingRight), pt = px(cs.paddingTop), pb = px(cs.paddingBottom);
    return { x: box.ax + bl + pl, y: box.ay + bt + pt, w: Math.max(0, box.w - bl - br - pl - pr), h: Math.max(0, box.h - bt - bb - pt - pb) };
  }

  // --- Иконочные шрифты рисуем картинкой (в Figma таких шрифтов обычно нет)
  function rasterTextNode(text, cs, rect, z) {
    try {
      const scale = 4;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(rect.width * scale));
      c.height = Math.max(1, Math.ceil(rect.height * scale));
      const ctx = c.getContext('2d');
      ctx.scale(scale, scale);
      ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      const fills = parseColor(cs.color);
      ctx.fillStyle = fills ? 'rgba(' + Math.round(fills.r * 255) + ',' + Math.round(fills.g * 255) + ',' + Math.round(fills.b * 255) + ',' + fills.a + ')' : '#000';
      ctx.textBaseline = 'alphabetic';
      const m = ctx.measureText(text);
      const asc = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || px(cs.fontSize) * 0.8;
      const desc = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || px(cs.fontSize) * 0.2;
      ctx.fillText(text, 0, asc + (rect.height - asc - desc) / 2);
      const id = registerBytes(canvasBytes(c));
      return {
        t: 'RECT', name: 'icon', ax: rect.left + sx, ay: rect.top + sy, w: rect.width, h: rect.height,
        fills: [{ type: 'IMAGE', imageId: id, scaleMode: 'FILL' }], z: z
      };
    } catch (e) { return null; }
  }

  // --- Можно ли собрать содержимое элемента в один текстовый слой?
  function isInlineContent(el, depth) {
    if (depth > 12) return false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 || n.nodeType === 8) continue;
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (tag === 'br' || tag === 'wbr') continue;
      if (n.namespaceURI === SVG_NS || NOT_INLINE.has(tag)) return false;
      const cs = gcs(n);
      if (cs.display === 'none') continue;
      if (cs.display !== 'inline' && cs.display !== 'contents') return false;
      if (hasBoxVisuals(cs) || parseFloat(cs.opacity) < 1 || rotMap.has(n)) return false;
      if (isIconFont(cs) || PUA.test(n.textContent || '')) return false;
      if (cs.position === 'absolute' || cs.position === 'fixed') return false;
      if (!isInlineContent(n, depth + 1)) return false;
    }
    return true;
  }

  function collectRuns(el, runs) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { runs.push({ text: n.data, el: el, node: n }); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (tag === 'br') { runs.push({ br: true, el: el }); continue; }
      if (tag === 'wbr') continue;
      const cs = gcs(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const before = px(cs.marginLeft) + px(cs.paddingLeft), after = px(cs.marginRight) + px(cs.paddingRight);
      if (before > 1.5) runs.push({ gap: before, el: n });
      collectRuns(n, runs);
      if (after > 1.5) runs.push({ gap: after, el: n });
    }
  }

  function buildText(runs, stopEl) {
    const parts = [];   // {ch, si, coll}
    const styles = [], styleKeys = new Map(), elStyle = new Map();
    const styleIdx = (el) => {
      if (elStyle.has(el)) return elStyle.get(el);
      const st = textStyle(el, gcs(el), stopEl);
      const key = JSON.stringify(st);
      let i = styleKeys.get(key);
      if (i == null) { i = styles.length; styles.push(st); styleKeys.set(key, i); }
      elStyle.set(el, i);
      return i;
    };
    const last = () => parts[parts.length - 1];
    for (const run of runs) {
      if (run.gap) {
        const sw = spaceWidth(run.el);
        let k = Math.round(run.gap / sw);
        if (!k && run.gap >= sw * 0.35) k = 1;
        const si = styleIdx(run.el);
        for (let j = 0; j < k; j++) parts.push({ ch: '\u00a0', si: si, coll: false });
        continue;
      }
      if (run.sep) {
        while (parts.length && last().ch === ' ' && last().coll) parts.pop();
        const si = styleIdx(run.el);
        for (let k = 0; k < run.sep; k++) parts.push({ ch: ' ', si: si, coll: false });
        continue;
      }
      if (run.br) {
        while (parts.length && last().ch === ' ' && last().coll) parts.pop();
        parts.push({ ch: '\n', si: parts.length ? last().si : styleIdx(run.el), coll: false });
        continue;
      }
      const mode = wsMode(gcs(run.el));
      let t = run.text.replace(/\r\n?/g, '\n');
      if (mode === 'collapse') t = t.replace(/[\t\n\f ]+/g, ' ');
      else if (mode === 'preserve-breaks') t = t.replace(/[\t\f ]+/g, ' ').replace(/ ?\n ?/g, '\n');
      const si = styleIdx(run.el);
      const coll = mode !== 'preserve';
      for (const ch of t) {
        if (ch === ' ' && coll && (!parts.length || last().ch === ' ' || last().ch === '\n')) continue;
        parts.push({ ch: ch, si: si, coll: coll });
      }
    }
    while (parts.length && ((parts[parts.length - 1].ch === ' ' && parts[parts.length - 1].coll) || parts[parts.length - 1].ch === '\n')) parts.pop();
    let chars = '';
    const ranges = [];
    const count = new Map();
    for (const p of parts) {
      const start = chars.length;
      chars += p.ch;
      const lr = ranges[ranges.length - 1];
      if (lr && lr[2] === p.si) lr[1] = chars.length; else ranges.push([start, chars.length, p.si]);
      count.set(p.si, (count.get(p.si) || 0) + p.ch.length);
    }
    let base = 0, best = -1;
    count.forEach((v, k) => { if (v > best) { best = v; base = k; } });
    return { chars: chars, ranges: ranges, styles: styles, base: base };
  }

  function textRects(nodes) {
    const range = document.createRange();
    const rects = [];
    for (const tn of nodes) {
      range.selectNodeContents(tn);
      for (const r of range.getClientRects()) if (r.width > 0.1 && r.height > 0.1) rects.push(r);
    }
    return rects;
  }

  function groupLines(rects) {
    const sorted = rects.slice().sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of sorted) {
      const cy = r.top + r.height / 2;
      const l = lines[lines.length - 1];
      if (l && cy >= l.top && cy <= l.bottom) {
        l.left = Math.min(l.left, r.left); l.right = Math.max(l.right, r.right);
        l.top = Math.min(l.top, r.top); l.bottom = Math.max(l.bottom, r.bottom);
      } else {
        lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
    }
    return lines;
  }

  function textBlock(el, cs, box, z) {
    const runs = [];
    collectRuns(el, runs);
    const txt = buildText(runs, el);
    if (!txt.chars.trim()) return null;
    if (txt.styles.every((s) => !s.fills)) return null;
    const rects = textRects(runs.filter((r) => r.node).map((r) => r.node));
    if (!rects.length) return null;
    const lines = groupLines(rects);
    const first = lines[0];
    const union = lines.reduce((u, l) => ({ left: Math.min(u.left, l.left), right: Math.max(u.right, l.right) }), { left: Infinity, right: -Infinity });

    if (isIconFont(cs) || (PUA.test(txt.chars) && txt.chars.replace(/\s/g, '').length <= 3)) {
      return rasterTextNode(txt.chars.trim(), cs, { left: union.left, top: first.top, width: union.right - union.left, height: lines[lines.length - 1].bottom - first.top }, z);
    }

    let lh = cs.lineHeight === 'normal' ? null : px(cs.lineHeight);
    const firstH = first.bottom - first.top;
    const cb = contentBox(cs, box);
    if (!lh) {
      // line-height: normal — берём фактическую высоту строки из браузера, чтобы Figma совпала
      const nl = Math.max(lines.length, txt.chars.split('\n').length);
      const per = cb.h / nl;
      if (per >= firstH * 0.9 && per <= firstH * 1.6 && Math.abs(cb.y - first.top) < firstH * 0.5) {
        lh = r2(per);
      } else {
        lh = r2(firstH);
      }
      txt.styles.forEach((st) => { if (st.lh == null) st.lh = lh; });
    }
    const y = first.top - (lh ? (lh - firstH) / 2 : 0);
    let align = alignOf(cs);
    const node = {
      t: 'TEXT', ay: y + sy, chars: txt.chars, styles: txt.styles, ranges: txt.ranges, base: txt.base,
      align: align, z: z
    };
    ownName(node, el);
    const effects = parseShadows(cs.textShadow, true);
    if (effects.length) node.effects = effects;

    const multi = lines.length > 1 || txt.chars.includes('\n');
    const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none' ? parseInt(cs.webkitLineClamp, 10) : 0;
    const ellipsis = cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible';

    if (!multi && ellipsis && isNowrap(cs)) {
      node.auto = 'HEIGHT'; node.ax = cb.x + sx; node.w = cb.w; node.maxLines = 1;
    } else if (!multi) {
      const tw = union.right - union.left;
      if (align === 'LEFT' || align === 'JUSTIFIED' || isNowrap(cs)) {
        node.align = align === 'JUSTIFIED' ? 'LEFT' : align;
        node.auto = 'WIDTH_AND_HEIGHT';
        node.ax = (align === 'LEFT' || align === 'JUSTIFIED' ? union.left : union.left) + sx;
        if (align !== 'LEFT' && align !== 'JUSTIFIED') node.align = 'LEFT';
      } else {
        node.auto = 'HEIGHT';
        let w = cb.w, x = cb.x;
        if (tw > cb.w - 2 || cb.w <= 0) {
          w = tw + 6;
          x = align === 'CENTER' ? (union.left + union.right) / 2 - w / 2 : union.right - w + 1;
        }
        node.ax = x + sx; node.w = w;
      }
    } else {
      node.auto = 'HEIGHT';
      const x = Math.min(cb.x, union.left);
      node.ax = x + sx;
      node.w = Math.max(cb.w, union.right - x) + 1;
      if (clamp) node.maxLines = clamp;
    }
    const nLines = Math.max(lines.length, txt.chars.split('\n').length);
    node.h = lh ? lh * nLines : lines[lines.length - 1].bottom - first.top;
    if (node.maxLines && lh) node.h = lh * Math.min(nLines, node.maxLines);
    if (node.w == null) node.w = union.right - union.left;
    return node;
  }

  // Flex-строка из нескольких текстовых кусочков («800» + «₽», «Текст» + «−10%»)
  // собираем в один текстовый слой: так она не разваливается при подмене шрифта.
  function flexTextRow(el, cs) {
    if (!/flex/.test(cs.display) || !/^row/.test(cs.flexDirection)) return null;
    const jc = cs.justifyContent;
    if (/space-|stretch/.test(jc)) return null;
    const items = [];
    for (const n of childList(el)) {
      if (n.nodeType === 3) { if (/\S/.test(n.data)) items.push({ node: n }); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      const ccs = gcs(n);
      if (ccs.display === 'none') continue;
      if (n.namespaceURI === SVG_NS || NOT_INLINE.has(tag)) return null;
      if (hasBoxVisuals(ccs) || parseFloat(ccs.opacity) < 1 || rotMap.has(n) || ccs.visibility !== 'visible') return null;
      if (ccs.position === 'absolute' || ccs.position === 'fixed') return null;
      if (isIconFont(ccs) || PUA.test(n.textContent || '')) return null;
      if (!/\S/.test(n.textContent || '')) return null;
      if (!isInlineContent(n, 0)) return null;
      items.push({ el: n });
    }
    if (items.length < 2) return null;
    const range = document.createRange();
    const all = [];
    for (const it of items) {
      range.selectNodeContents(it.node || it.el);
      const rs = Array.from(range.getClientRects()).filter((r) => r.width > 0.1 && r.height > 0.1);
      if (!rs.length) return null;
      it.l = Math.min(...rs.map((r) => r.left)); it.r = Math.max(...rs.map((r) => r.right));
      it.t = Math.min(...rs.map((r) => r.top)); it.b = Math.max(...rs.map((r) => r.bottom));
      all.push(...rs);
    }
    if (groupLines(all).length !== 1) return null;
    const fs = px(cs.fontSize) || 16;
    for (let i = 1; i < items.length; i++) {
      const gap = items[i].l - items[i - 1].r;
      if (gap < -1 || gap > Math.max(48, fs * 3)) return null;
      items[i].gap = gap;
    }
    return items;
  }

  let spaceCtx = null;
  function spaceWidth(el) {
    const c = gcs(el);
    if (!spaceCtx) spaceCtx = document.createElement('canvas').getContext('2d');
    spaceCtx.font = c.fontStyle + ' ' + c.fontWeight + ' ' + c.fontSize + ' ' + c.fontFamily;
    return spaceCtx.measureText(' ').width || px(c.fontSize) * 0.28;
  }

  function flexRowText(el, cs, box, items, z) {
    const runs = [];
    items.forEach((it, i) => {
      if (i > 0 && it.gap > 0.5) {
        const sEl = it.el || el;
        runs.push({ sep: Math.max(1, Math.round(it.gap / spaceWidth(sEl))), el: sEl });
      }
      if (it.node) runs.push({ text: it.node.data, el: el, node: it.node });
      else collectRuns(it.el, runs);
    });
    const txt = buildText(runs, el);
    if (!txt.chars.trim() || txt.styles.every((s) => !s.fills)) return null;
    const left = items[0].l, right = items[items.length - 1].r;
    const top = Math.min(...items.map((i) => i.t)), bottom = Math.max(...items.map((i) => i.b));
    const maxH = Math.max(...items.map((i) => i.b - i.t));
    txt.styles.forEach((st) => { st.lh = r2(maxH); });
    const node = {
      t: 'TEXT', chars: txt.chars, styles: txt.styles, ranges: txt.ranges, base: txt.base, z: z,
      ay: (top + bottom) / 2 - maxH / 2 + sy, h: maxH
    };
    ownName(node, el);
    const effects = parseShadows(cs.textShadow, true);
    if (effects.length) node.effects = effects;
    const jc = cs.justifyContent;
    const cb = contentBox(cs, box);
    const tw = right - left;
    if (jc === 'center') {
      node.align = 'CENTER'; node.auto = 'HEIGHT';
      node.w = Math.max(cb.w, tw + 8); node.ax = (left + right) / 2 - node.w / 2 + sx;
    } else if (/end|right/.test(jc)) {
      node.align = 'RIGHT'; node.auto = 'HEIGHT';
      node.w = Math.max(cb.w, tw + 8); node.ax = right - node.w + sx;
    } else {
      node.align = 'LEFT'; node.auto = 'WIDTH_AND_HEIGHT'; node.ax = left + sx; node.w = tw;
    }
    return node;
  }

  // Текст в «смешанном» контейнере: режем по строкам, чтобы точно попасть в позиции.
  function textLines(tn, out) {
    const pe = tn.parentElement;
    if (!pe) return;
    const cs = gcs(pe);
    if (cs.visibility !== 'visible') return;
    const data = tn.data;
    if (!/\S/.test(data)) return;
    const range = document.createRange();
    range.selectNodeContents(tn);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.1 && r.height > 0.1);
    if (!rects.length) return;
    const z = [1, 0, ord++];

    if (isIconFont(cs) || (PUA.test(data) && data.trim().length <= 3)) {
      const u = rects.reduce((a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
      const n = rasterTextNode(data.trim(), cs, { left: u.left, top: u.top, width: u.right - u.left, height: u.bottom - u.top }, z);
      if (n) out.push(n);
      return;
    }

    const style = textStyle(pe, cs, pe);
    if (!style.fills) return;
    let lh = cs.lineHeight === 'normal' ? null : px(cs.lineHeight);
    if (!lh) { lh = r2(rects[0].height); style.lh = lh; }
    const effects = parseShadows(cs.textShadow, true);
    const lines = [];
    const collapse = wsMode(cs) !== 'preserve';

    // Текст — самостоятельный элемент flex/grid (анонимная ячейка) и занимает несколько строк:
    // делаем один многострочный слой фиксированной ширины, чтобы Figma переносила его сама.
    if (rects.length > 1 && /flex|grid/.test(cs.display)) {
      const gl = groupLines(rects);
      if (gl.length > 1) {
        const left = Math.min(...gl.map((l) => l.left));
        let right = Math.max(...gl.map((l) => l.right));
        let isLast = true;
        for (let n = tn.nextSibling; n; n = n.nextSibling) {
          if ((n.nodeType === 3 && /\S/.test(n.data)) || (n.nodeType === 1 && gcs(n).display !== 'none' && n.tagName !== 'H2D-PSEUDO')) { isLast = false; break; }
          if (n.nodeType === 1 && n.tagName === 'H2D-PSEUDO' && gcs(n).position !== 'absolute') { isLast = false; break; }
        }
        if (isLast) {
          const pr = pe.getBoundingClientRect();
          const contentRight = pr.right - px(cs.borderRightWidth) - px(cs.paddingRight);
          if (contentRight > right) right = contentRight;
        }
        const text = collapse ? data.replace(/[ \t\n\r\f]+/g, ' ').replace(/^ | $/g, '') : data.replace(/^\n|\n$/g, '');
        const firstH = gl[0].bottom - gl[0].top;
        const node = {
          t: 'TEXT', ax: left + sx, ay: gl[0].top - (lh ? (lh - firstH) / 2 : 0) + sy, w: right - left + 1,
          h: lh ? lh * gl.length : gl[gl.length - 1].bottom - gl[0].top, chars: text, styles: [style], ranges: [[0, text.length, 0]], base: 0,
          align: alignOf(cs) === 'JUSTIFIED' ? 'JUSTIFIED' : alignOf(cs), auto: 'HEIGHT', z: z
        };
        if (effects.length) node.effects = effects;
        out.push(node);
        return;
      }
    }
    if (rects.length === 1) {
      lines.push({ text: collapse ? data.replace(/[ \t\n\r\f]+/g, ' ').replace(/^ | $/g, '') : data.replace(/^\n|\n$/g, ''), r: rects[0] });
    } else {
      // куски слов: переносы бывают и по дефису («ИИ-» / «инструменты»)
      const re = /[^\s\-\u2010\u00ad]+[\-\u2010\u00ad]?|[\-\u2010]/g;
      let m, cur = null;
      while ((m = re.exec(data))) {
        range.setStart(tn, m.index);
        range.setEnd(tn, m.index + m[0].length);
        const rs = range.getClientRects();
        if (!rs.length) continue;
        const r = rs[0];
        if (!cur || r.top > cur.top + cur.h * 0.5) {
          cur = { start: m.index, end: m.index + m[0].length, left: r.left, right: r.right, top: r.top, h: r.height };
          lines.push(cur);
        } else {
          cur.end = m.index + m[0].length;
          cur.right = Math.max(cur.right, rs[rs.length - 1].right);
        }
      }
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        const text = data.slice(l.start, l.end).replace(/[ \t\n\r\f]+/g, ' ').replace(/\u00ad/g, '').replace(/^ | $/g, '');
        lines[i] = { text: text, r: { left: l.left, top: l.top, width: l.right - l.left, height: l.h } };
      }
    }
    for (const l of lines) {
      if (!l.text) continue;
      const y = l.r.top - (lh ? (lh - l.r.height) / 2 : 0);
      const node = {
        t: 'TEXT', ax: l.r.left + sx, ay: y + sy, w: l.r.width, h: lh || l.r.height, chars: l.text,
        styles: [style], ranges: [[0, l.text.length, 0]], base: 0, align: 'LEFT', auto: 'WIDTH_AND_HEIGHT', z: z
      };
      if (effects.length) node.effects = effects;
      out.push(node);
    }
  }

  // --- Визуальные свойства блока: фон, рамки, скругления, тени
  function radiusVal(v, w, h) {
    const t = String(v).split(/\s+/)[0];
    if (/%$/.test(t)) return (Math.min(w, h) * parseFloat(t)) / 100;
    return px(t);
  }

  function bgPlacement(cs, i, area, rec) {
    const sizes = splitTop(cs.backgroundSize, ',');
    const repeats = splitTop(cs.backgroundRepeat, ',');
    const pxs = splitTop(cs.backgroundPositionX, ',');
    const pys = splitTop(cs.backgroundPositionY, ',');
    const size = sizes[i % sizes.length] || 'auto';
    const repeat = repeats[i % repeats.length] || 'repeat';
    let nw = rec.w || area.w, nh = rec.h || area.h;
    let W, H, mode = null;
    if (size === 'cover') { mode = 'cover'; const s = Math.max(area.w / nw, area.h / nh); W = nw * s; H = nh * s; }
    else if (size === 'contain') { mode = 'contain'; const s = Math.min(area.w / nw, area.h / nh); W = nw * s; H = nh * s; }
    else {
      const t = size.split(/\s+/);
      const dim = (tok, a) => (tok == null || tok === 'auto' ? null : /%$/.test(tok) ? (a * parseFloat(tok)) / 100 : px(tok));
      W = dim(t[0], area.w); H = dim(t[1], area.h);
      if (W == null && H == null) { W = nw; H = nh; }
      else if (W == null) W = (H * nw) / nh;
      else if (H == null) H = (W * nh) / nw;
    }
    const pos = (tok, free) => {
      if (!tok) return 0;
      const calc = tok.match(/calc\((-?[\d.]+)%\s*([+-])\s*(-?[\d.]+)px\)/);
      if (calc) return (free * parseFloat(calc[1])) / 100 + (calc[2] === '-' ? -1 : 1) * parseFloat(calc[3]);
      if (/%$/.test(tok)) return (free * parseFloat(tok)) / 100;
      return px(tok);
    };
    const x = pos(pxs[i % pxs.length], area.w - W);
    const y = pos(pys[i % pys.length], area.h - H);
    const noRepeat = /no-repeat/.test(repeat) || (repeat.split(/\s+/).every((r) => r === 'no-repeat'));
    return { W: W, H: H, x: x, y: y, mode: mode, repeat: !noRepeat && repeat !== 'space' && repeat !== 'round' ? true : !noRepeat };
  }

  /** Заходит ли кто-то из детей элемента на его рамку (sides — ширины сторон в px вёрстки). */
  function childCrossesBorder(el, sides) {
    const r = el.getBoundingClientRect();
    const s = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
    const [t, rt, b, l] = sides.map((side) => side.w * s);
    for (const c of el.children) {
      const cr = c.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) continue;
      if (cr.right <= r.left || cr.left >= r.right || cr.bottom <= r.top || cr.top >= r.bottom) continue;
      if ((t > 0 && cr.top < r.top + t) || (b > 0 && cr.bottom > r.bottom - b) || (l > 0 && cr.left < r.left + l) || (rt > 0 && cr.right > r.right - rt)) return true;
    }
    return false;
  }

  function boxVisuals(node, el, cs, box, childrenOut) {
    let has = false;
    const fills = [];
    const bgClipText = cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
    const bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth), bt = px(cs.borderTopWidth), bb = px(cs.borderBottomWidth);
    const area = { x: bl, y: bt, w: Math.max(0.01, box.w - bl - br), h: Math.max(0.01, box.h - bt - bb) };

    if (!bgClipText && !skipBgFor.has(el)) {
      const bc = parseColor(cs.backgroundColor);
      if (bc && bc.a > 0.004) fills.push(solid(bc));
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        const layers = splitTop(cs.backgroundImage, ',');
        const top = [];
        layers.forEach((layer, i) => {
          if (/gradient\(/i.test(layer)) {
            const g = gradientPaint(layer, box.w, box.h);
            if (g) top.push(g);
            return;
          }
          const u = extractUrls(layer)[0];
          const rec = u && imageCache.get(u);
          if (!rec || rec.failed) return;
          const pl = bgPlacement(cs, i, area, rec);
          if (pl.mode === 'cover') {
            const id = imageId(rec);
            if (id != null) top.push({ type: 'IMAGE', imageId: id, scaleMode: 'FILL' });
          } else if (pl.repeat && (pl.W < area.w - 1 || pl.H < area.h - 1) && rec.w) {
            const id = imageId(rec);
            if (id != null) top.push({ type: 'IMAGE', imageId: id, scaleMode: 'TILE', scalingFactor: pl.W / (rec.pw || rec.w) });
          } else if (Math.abs(pl.W - area.w) < 1 && Math.abs(pl.H - area.h) < 1 && Math.abs(pl.x) < 1 && Math.abs(pl.y) < 1) {
            const id = imageId(rec);
            if (id != null) top.push({ type: 'IMAGE', imageId: id, scaleMode: 'CROP' });
          } else {
            // Отдельный слой с картинкой в точной позиции (иконки на фоне и т.п.)
            const ax = box.ax + area.x + pl.x, ay = box.ay + area.y + pl.y;
            if (rec.svgText) {
              const s = sizeSvg(rec.svgText, pl.W, pl.H);
              if (s) {
                const n = { ci: { helper: true }, t: 'SVG', name: 'background', svg: s, ax: ax, ay: ay, w: pl.W, h: pl.H, z: [-2, 0, ord++] };
                svgTasks.push(n);
                childrenOut.push(n);
              }
            } else {
              const id = imageId(rec);
              if (id != null) childrenOut.push({ ci: { helper: true }, t: 'RECT', name: 'background', ax: ax, ay: ay, w: pl.W, h: pl.H, fills: [{ type: 'IMAGE', imageId: id, scaleMode: 'FILL' }], z: [-2, 0, ord++] });
            }
            if (pl.x < 0 || pl.y < 0 || pl.x + pl.W > area.w + 0.5 || pl.y + pl.H > area.h + 0.5) node.clip = true;
          }
        });
        fills.push(...top.reverse());
      }
    }
    if (fills.length) { node.fills = fills; has = true; }

    // Рамки
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => {
      const w = px(cs['border' + s + 'Width']);
      const style = cs['border' + s + 'Style'];
      const c = parseColor(cs['border' + s + 'Color']);
      const vis = w > 0 && style !== 'none' && style !== 'hidden' && c && c.a > 0.01;
      return { w: vis ? w : 0, style: style, c: c, vis: vis };
    });
    const visible = sides.filter((s) => s.vis);
    let borderLayer = null;
    if (visible.length) {
      has = true;
      const c0 = visible[0].c;
      const same = visible.every((s) => Math.abs(s.c.r - c0.r) < 0.01 && Math.abs(s.c.g - c0.g) < 0.01 && Math.abs(s.c.b - c0.b) < 0.01 && Math.abs(s.c.a - c0.a) < 0.01 && s.style === visible[0].style);
      if (same) {
        const stroke = { paint: solid(c0), w: sides.map((s) => r2(s.w)), align: 'INSIDE' };
        const wmax = Math.max(...visible.map((s) => s.w));
        if (visible[0].style === 'dashed') stroke.dash = [wmax * 3, wmax * 2];
        else if (visible[0].style === 'dotted') stroke.dash = [wmax, wmax];
        // В браузере рамка под детьми, а у фрейма обводка поверх них: если ребёнок
        // заходит на рамку (плашка «top:-9px» на краю карточки), рамка — отдельный слой снизу.
        if (childCrossesBorder(el, sides)) {
          borderLayer = { ci: { helper: true }, t: 'RECT', name: 'border', ax: box.ax, ay: box.ay, w: box.w, h: box.h, stroke: stroke, z: [-1, 0, ord++] };
          childrenOut.push(borderLayer);
        } else {
          node.stroke = stroke;
        }
      } else {
        // Разные цвета сторон — отдельные полоски
        const geo = [
          [0, 0, box.w, sides[0].w], [box.w - sides[1].w, 0, sides[1].w, box.h],
          [0, box.h - sides[2].w, box.w, sides[2].w], [0, 0, sides[3].w, box.h]
        ];
        sides.forEach((s, i) => {
          if (!s.vis) return;
          childrenOut.push({ ci: { helper: true }, t: 'RECT', name: 'border-' + ['top', 'right', 'bottom', 'left'][i], ax: box.ax + geo[i][0], ay: box.ay + geo[i][1], w: geo[i][2], h: geo[i][3], fills: [solid(s.c)], z: [-1, 0, ord++] });
        });
      }
    } else if (cs.outlineStyle && cs.outlineStyle !== 'none' && px(cs.outlineWidth) > 0) {
      const oc = parseColor(cs.outlineColor);
      if (oc && oc.a > 0.01) {
        has = true;
        const ow = r2(px(cs.outlineWidth));
        node.stroke = { paint: solid(oc), w: [ow, ow, ow, ow], align: 'OUTSIDE' };
      }
    }

    // Скругления
    const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
      .map((v) => r2(Math.min(radiusVal(v, box.w, box.h), Math.min(box.w, box.h) / 2)));
    if (radii.some((r) => r > 0)) {
      node.radii = radii;
      if (borderLayer) borderLayer.radii = radii;
    }

    // Тени и фильтры
    const effects = parseShadows(cs.boxShadow, false).concat(parseFilters(cs));
    if (effects.length) { node.effects = effects; has = true; }

    return has;
  }

  // --- SVG
  const SVG_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'stop-color', 'stop-opacity',
    'clip-rule', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'visibility'];
  const DEF_LIKE = /^(defs|symbol|clippath|mask|marker|pattern|lineargradient|radialgradient|filter)$/i;

  function paintAttr(clone, prop, val, opacityProp, baseOpacity) {
    if (val == null || val === '') return;
    if (/^url\(/.test(val)) {
      const frag = val.match(/#([^"')]+)/);
      if (frag) clone.setAttribute(prop, 'url(#' + frag[1] + ')');
      return;
    }
    if (val === 'none') { clone.setAttribute(prop, 'none'); return; }
    const c = parseColor(val);
    if (!c) { clone.setAttribute(prop, 'none'); return; }
    clone.setAttribute(prop, hex(c));
    if (c.a < 1) clone.setAttribute(opacityProp, r2((baseOpacity == null ? 1 : baseOpacity) * c.a));
  }

  function serializeSvg(svg, box) {
    const clone = svg.cloneNode(true);
    const orig = [svg, ...svg.querySelectorAll('*')];
    const copy = [clone, ...clone.querySelectorAll('*')];
    const remove = [];
    for (let i = 0; i < orig.length; i++) {
      const o = orig[i], c = copy[i];
      const tag = o.tagName.toLowerCase();
      if (tag === 'style' || tag === 'script') { remove.push(c); continue; }
      if (o.closest('symbol') && o.tagName.toLowerCase() !== 'symbol') continue;
      let cs;
      try { cs = getComputedStyle(o); } catch (e) { continue; }
      const inDefs = !!(o.parentElement && o.parentElement.closest('defs,symbol,clipPath,mask,marker,pattern,linearGradient,radialGradient,filter'));
      if (cs.display === 'none' && !inDefs && !DEF_LIKE.test(tag)) { remove.push(c); continue; }
      for (const p of SVG_PROPS) {
        const v = cs.getPropertyValue(p);
        if (!v) continue;
        if (p === 'fill') paintAttr(c, 'fill', v, 'fill-opacity', parseFloat(cs.getPropertyValue('fill-opacity')));
        else if (p === 'stroke') paintAttr(c, 'stroke', v, 'stroke-opacity', parseFloat(cs.getPropertyValue('stroke-opacity')));
        else if (p === 'stop-color') {
          if (tag === 'stop') paintAttr(c, 'stop-color', v, 'stop-opacity', parseFloat(cs.getPropertyValue('stop-opacity')));
        } else if (p === 'fill-opacity' || p === 'stroke-opacity' || p === 'stop-opacity') {
          if (!c.hasAttribute(p)) c.setAttribute(p, v);
        } else if (p === 'opacity') {
          if (v !== '1') c.setAttribute(p, v);
        } else if (p === 'stroke-dasharray') {
          if (v !== 'none') c.setAttribute(p, v.replace(/px/g, ''));
        } else if (p === 'font-family' || p === 'font-size' || p === 'font-weight' || p === 'font-style' || p === 'text-anchor') {
          if (/^(text|tspan|textpath)$/i.test(tag)) c.setAttribute(p, v);
        } else if (p === 'visibility') {
          if (v !== 'visible') c.setAttribute(p, v);
        } else {
          c.setAttribute(p, String(v).replace(/px$/, ''));
        }
      }
      if (i > 0 && cs.transform && cs.transform !== 'none' && !o.hasAttribute('transform') && /^0px 0px/.test(cs.transformOrigin)) {
        c.setAttribute('transform', cs.transform);
      }
      c.removeAttribute('class');
      c.removeAttribute('style');
    }
    remove.forEach((n) => n.remove());

    // <use> на символы (в т.ч. из спрайта вне этого svg) — разворачиваем
    const origUses = [...svg.querySelectorAll('use')];
    const cloneUses = [...clone.querySelectorAll('use')];
    cloneUses.forEach((cu, i) => {
      const ou = origUses[i];
      const href = cu.getAttribute('href') || cu.getAttribute('xlink:href') || '';
      const id = href.split('#')[1];
      if (!id) return;
      const ref = svg.ownerDocument.getElementById(id);
      if (!ref) return;
      let ucs;
      try { ucs = getComputedStyle(ou); } catch (e) { return; }
      const color = parseColor(ucs.color);
      const colorHex = color ? hex(color) : '#000000';
      const isSymbol = ref.tagName.toLowerCase() === 'symbol';
      const wrap = document.createElementNS(SVG_NS, isSymbol ? 'svg' : 'g');
      paintAttr(wrap, 'fill', ucs.fill, 'fill-opacity');
      paintAttr(wrap, 'stroke', ucs.stroke, 'stroke-opacity');
      if (ucs.strokeWidth) wrap.setAttribute('stroke-width', String(ucs.strokeWidth).replace(/px$/, ''));
      const x = cu.getAttribute('x') || '0', y = cu.getAttribute('y') || '0';
      if (isSymbol) {
        if (ref.getAttribute('viewBox')) wrap.setAttribute('viewBox', ref.getAttribute('viewBox'));
        wrap.setAttribute('x', x); wrap.setAttribute('y', y);
        wrap.setAttribute('width', cu.getAttribute('width') || '100%');
        wrap.setAttribute('height', cu.getAttribute('height') || '100%');
        for (const ch of ref.childNodes) wrap.appendChild(ch.cloneNode(true));
      } else {
        wrap.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
        wrap.appendChild(ref.cloneNode(true));
      }
      wrap.querySelectorAll('*').forEach((n) => {
        for (const a of ['fill', 'stroke', 'stop-color']) if ((n.getAttribute(a) || '').toLowerCase() === 'currentcolor') n.setAttribute(a, colorHex);
        n.removeAttribute('class');
      });
      if (cu.getAttribute('transform')) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('transform', cu.getAttribute('transform'));
        g.appendChild(wrap);
        cu.replaceWith(g);
      } else cu.replaceWith(wrap);
    });

    // Ссылки url(#id) на определения вне этого svg
    const have = new Set([...clone.querySelectorAll('[id]')].map((n) => n.id));
    const need = new Set();
    clone.querySelectorAll('*').forEach((n) => {
      for (const a of ['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-end', 'marker-mid']) {
        const v = n.getAttribute(a);
        const m = v && v.match(/url\(#([^)]+)\)/);
        if (m && !have.has(m[1])) need.add(m[1]);
      }
    });
    if (need.size) {
      const defs = document.createElementNS(SVG_NS, 'defs');
      need.forEach((id) => { const r = svg.ownerDocument.getElementById(id); if (r) defs.appendChild(r.cloneNode(true)); });
      clone.insertBefore(defs, clone.firstChild);
    }

    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    const aw = svg.getAttribute('width'), ah = svg.getAttribute('height');
    if (!clone.getAttribute('viewBox') && aw && ah && /^[\d.]+(px)?$/.test(aw) && /^[\d.]+(px)?$/.test(ah)) {
      clone.setAttribute('viewBox', '0 0 ' + parseFloat(aw) + ' ' + parseFloat(ah));
    }
    clone.setAttribute('width', r2(box.w));
    clone.setAttribute('height', r2(box.h));
    clone.removeAttribute('x'); clone.removeAttribute('y');
    return new XMLSerializer().serializeToString(clone);
  }

  // --- Элементы форм
  function checkboxSvg(type, checked, s, accent) {
    const a = accent || '#0075ff';
    const head = '<svg xmlns="http://www.w3.org/2000/svg" width="' + r2(s) + '" height="' + r2(s) + '" viewBox="0 0 16 16">';
    if (type === 'radio') {
      return head + (checked
        ? '<circle cx="8" cy="8" r="7.5" fill="' + a + '"/><circle cx="8" cy="8" r="3.2" fill="#ffffff"/>'
        : '<circle cx="8" cy="8" r="7" fill="#ffffff" stroke="#767676" stroke-width="1"/>') + '</svg>';
    }
    return head + (checked
      ? '<rect x="0.5" y="0.5" width="15" height="15" rx="2.5" fill="' + a + '"/><path d="M4 8.3l2.6 2.6L12 5.4" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<rect x="1" y="1" width="14" height="14" rx="2" fill="#ffffff" stroke="#767676" stroke-width="1"/>') + '</svg>';
  }

  function formNode(el, cs, box, z) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && type === 'hidden') return null;
    if (tag === 'input' && (type === 'checkbox' || type === 'radio') && cs.appearance !== 'none') {
      const acc = parseColor(cs.accentColor);
      const n = { t: 'SVG', name: type, svg: checkboxSvg(type, el.checked, Math.min(box.w, box.h), acc ? hex(acc) : null), ax: box.ax + (box.w - Math.min(box.w, box.h)) / 2, ay: box.ay + (box.h - Math.min(box.w, box.h)) / 2, w: Math.min(box.w, box.h), h: Math.min(box.w, box.h), z: z };
      svgTasks.push(n);
      return n;
    }
    const node = { t: 'FRAME', name: nameOf(el), ax: box.ax, ay: box.ay, w: box.w, h: box.h, children: [], z: z, clip: true };
    boxVisuals(node, el, cs, box, node.children);
    const op = parseFloat(cs.opacity);
    if (op < 1) node.opacity = op;

    let text = '', placeholder = false;
    if (tag === 'select') {
      const o = el.options && el.options[el.selectedIndex];
      text = o ? o.text : '';
    } else if (tag === 'textarea') {
      text = el.value;
      if (!text && el.placeholder) { text = el.placeholder; placeholder = true; }
    } else if (/^(submit|button|reset)$/.test(type)) {
      text = el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    } else if (!/^(range|color|file|checkbox|radio|image)$/.test(type)) {
      text = type === 'password' ? '•'.repeat((el.value || '').length) : el.value;
      if (!text && el.placeholder) { text = el.placeholder; placeholder = true; }
    }

    const cb = contentBox(cs, box);
    if (text) {
      const st = textStyle(el, cs, el);
      if (placeholder) {
        const pc = parseColor(getComputedStyle(el, '::placeholder').color);
        st.fills = pc ? [solid(pc)] : [solid({ r: 0.46, g: 0.46, b: 0.46, a: 1 })];
      }
      st.href = null;
      st.deco = 'NONE';
      const lh = cs.lineHeight === 'normal' ? r2(px(cs.fontSize) * 1.2) : px(cs.lineHeight);
      st.lh = lh;
      const isArea = tag === 'textarea';
      const center = /^(submit|button|reset)$/.test(type);
      const oneLine = isArea ? text : text.replace(/\n/g, ' ');
      const tn = {
        t: 'TEXT', chars: oneLine, styles: [st], ranges: [[0, oneLine.length, 0]], base: 0, z: [1, 0, ord++],
        align: center ? 'CENTER' : alignOf(cs)
      };
      if (isArea || center) { tn.auto = 'HEIGHT'; tn.ax = cb.x + sx; tn.w = cb.w; }
      else { tn.auto = 'WIDTH_AND_HEIGHT'; tn.ax = cb.x + sx; tn.w = cb.w; if (tn.align !== 'LEFT') { tn.auto = 'HEIGHT'; } }
      tn.ay = isArea ? cb.y + sy : cb.y + sy + (cb.h - lh) / 2;
      tn.h = lh;
      node.children.push(tn);
    }
    if (tag === 'select' && cs.appearance !== 'none') {
      const c = parseColor(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
      const size = 10;
      const n = {
        t: 'SVG', name: 'chevron', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 3.5L5 7l3.5-3.5" fill="none" stroke="' + hex(c) + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        ax: box.ax + box.w - px(cs.borderRightWidth) - 6 - size, ay: box.ay + (box.h - size) / 2, w: size, h: size, z: [3, 0, ord++]
      };
      svgTasks.push(n);
      node.children.push(n);
    }
    return node;
  }

  // --- Маркеры списков
  function toRoman(n) {
    const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let s = '';
    for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
    return s;
  }
  function toAlpha(n) { let s = ''; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; }

  function markerNode(el, cs, box) {
    const type = cs.listStyleType;
    if (!type || type === 'none' || cs.listStylePosition !== 'outside') return null;
    if (cs.listStyleImage && cs.listStyleImage !== 'none') return null;
    let idx = 1;
    const list = el.parentElement;
    if (list) {
      let start = 1;
      if (list.tagName === 'OL' && list.hasAttribute('start')) start = parseInt(list.getAttribute('start'), 10) || 1;
      idx = start;
      for (const sib of list.children) {
        if (sib === el) break;
        if (gcs(sib).display === 'list-item') idx++;
      }
      if (el.hasAttribute('value')) idx = parseInt(el.getAttribute('value'), 10) || idx;
    }
    let text;
    switch (type) {
      case 'disc': text = '•'; break;
      case 'circle': text = '◦'; break;
      case 'square': text = '▪'; break;
      case 'decimal': text = idx + '.'; break;
      case 'decimal-leading-zero': text = (idx < 10 ? '0' : '') + idx + '.'; break;
      case 'lower-alpha': case 'lower-latin': text = toAlpha(idx) + '.'; break;
      case 'upper-alpha': case 'upper-latin': text = toAlpha(idx).toUpperCase() + '.'; break;
      case 'lower-roman': text = toRoman(idx) + '.'; break;
      case 'upper-roman': text = toRoman(idx).toUpperCase() + '.'; break;
      default:
        if (/^["']/.test(type)) text = type.slice(1, -1);
        else text = '•';
    }
    const mcs = getComputedStyle(el, '::marker');
    const st = textStyle(el, cs, el);
    const mc = parseColor(mcs.color);
    if (mc) st.fills = [solid(mc)];
    st.deco = 'NONE'; st.href = null; st.tc = 'ORIGINAL';
    if (mcs.fontSize) st.size = r2(px(mcs.fontSize));
    // первая строка содержимого
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.1 && r.height > 0.1);
    const first = rects.length ? rects.reduce((a, r) => (r.top < a.top ? r : a)) : null;
    const fs = px(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? null : px(cs.lineHeight);
    let y = box.ay + px(cs.borderTopWidth) + px(cs.paddingTop);
    if (first) y = first.top + sy - (lh ? (lh - first.height) / 2 : 0);
    const W = Math.ceil(fs * (0.65 * text.length + 0.5));
    return {
      t: 'TEXT', chars: text, styles: [st], ranges: [[0, text.length, 0]], base: 0, align: 'RIGHT', auto: 'HEIGHT',
      ax: box.ax - W - fs * (/^(disc|circle|square)$/.test(type) ? 0.6 : 0.28), ay: y, w: W, h: lh || fs * 1.2, z: [1, 0, ord++], name: 'marker', ci: { helper: true }
    };
  }

  // --- Главный рекурсивный обход
  function childList(el) {
    if (el.tagName === 'SLOT' && el.assignedNodes) {
      const a = el.assignedNodes({ flatten: true });
      if (a.length) return a;
    }
    return el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
  }

  function childInfo(el) {
    const cs = gcs(el);
    return { pos: cs.position, grow: px(cs.flexGrow), as: cs.alignSelf, disp: cs.display, fl: cs.cssFloat || cs.float || 'none', mw: /px$/.test(cs.maxWidth) ? px(cs.maxWidth) : 0 };
  }

  function processChildren(el, out) {
    for (const n of childList(el)) {
      const start = out.length;
      if (n.nodeType === 3) textLines(n, out);
      else if (n.nodeType === 1) processElement(n, out);
      else continue;
      const ci = n.nodeType === 1 ? childInfo(n) : { anon: true, pos: 'static', grow: 0, as: 'auto', disp: 'inline', fl: 'none' };
      for (let i = start; i < out.length; i++) {
        if (!out[i].ci) out[i].ci = ci;
        if (!out[i]._el && n.nodeType === 1) out[i]._el = n;
      }
    }
  }

  // =======================================================================
  // Auto Layout: подбираем параметры и проверяем, что Figma расставит детей
  // туда же, где их поставил браузер. Не сходится — оставляем абсолютные координаты.
  // =======================================================================
  const AL_T = 1.5;
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? AL_T : t);

  function isAbsChild(c) {
    const ci = c.ci || {};
    return !!(c.forceAbs || ci.helper || ci.pos === 'absolute' || ci.pos === 'fixed' || c.rot || c.rt);
  }

  function counterFit(items, C, Q0, Q1, prefer) {
    const maxc = Math.max(...items.map((i) => i.cs));
    const order = [prefer].concat(['MIN', 'CENTER', 'MAX'].filter((x) => x !== prefer));
    for (const mode of order) {
      if (mode === 'MIN') {
        const k = Math.min(...items.map((i) => i.q));
        if (!items.every((i) => near(i.q, k))) continue;
        let q0 = k, q1 = Q1;
        if (C - q0 - q1 < maxc - AL_T) q1 = Math.max(0, C - q0 - maxc);
        if (q0 < -AL_T) continue;
        return { align: 'MIN', q0: Math.max(0, q0), q1: q1 };
      }
      if (mode === 'CENTER') {
        const m = items[0].q + items[0].cs / 2;
        if (!items.every((i) => near(i.q + i.cs / 2, m))) continue;
        let q0 = Q0, q1 = C + q0 - 2 * m;
        if (q1 < 0) { q0 -= q1; q1 = 0; }
        if (q0 < -0.5 || C - q0 - q1 < maxc - AL_T) continue;
        return { align: 'CENTER', q0: Math.max(0, q0), q1: q1 };
      }
      if (mode === 'MAX') {
        const e = items[0].q + items[0].cs;
        if (!items.every((i) => near(i.q + i.cs, e))) continue;
        const q1 = C - e;
        let q0 = Math.min(Q0, e - maxc);
        if (q1 < -0.5 || q0 < -0.5) continue;
        return { align: 'MAX', q0: Math.max(0, q0), q1: Math.max(0, q1) };
      }
    }
    return null;
  }

  /**
   * Items along a row or column with gaps between them → the list for the frame and its gap: runs
   * separated by the largest gap become nested blocks (recursively) whose own gaps are smaller.
   * Gaps within `tol` of each other count as one (their middle value).
   */
  function nestByGaps(node, items, gaps, H, cnt, innerC, tol) {
    const middle = (xs) => { const v = xs.slice().sort((a, b) => a - b); return v[Math.floor(v.length / 2)] || 0; };
    const nest = (run, rg) => {
      if (run.length === 1) return { list: [run[0].c], gap: 0 };
      const G = Math.max(...rg);
      if (rg.every((x) => G - x <= tol)) return { list: run.map((it) => it.c), gap: Math.max(0, middle(rg)) };
      const segs = [];
      const outer = [];
      let cur = [run[0]], curG = [];
      for (let i = 1; i < run.length; i++) {
        if (G - rg[i - 1] <= tol) { segs.push([cur, curG]); outer.push(rg[i - 1]); cur = [run[i]]; curG = []; }
        else { cur.push(run[i]); curG.push(rg[i - 1]); }
      }
      segs.push([cur, curG]);
      return { list: segs.map(([sr, sg]) => (sr.length === 1 ? sr[0].c : block(sr, sg))), gap: Math.max(0, middle(outer)) };
    };
    const block = (sr, sg) => {
      const inner = nest(sr, sg);
      const first = sr[0], last = sr[sr.length - 1];
      const p = first.p, size = last.p + last.s - first.p;
      // A layer stretched across the frame stretches the block too.
      const fills = sr.some((it) => (H ? it.c.fillV : it.c.fillH));
      const q = fills ? cnt.q0 : Math.min(...sr.map((it) => it.q));
      const cs = fills ? innerC : Math.max(...sr.map((it) => it.q + it.cs)) - q;
      const g = {
        t: 'FRAME', name: TT('group'), children: inner.list, z: first.c.z, ci: { pos: 'static', disp: 'block' },
        ax: H ? node.ax + p : node.ax + q, ay: H ? node.ay + q : node.ay + p, w: H ? size : cs, h: H ? cs : size,
        al: { mode: H ? 'HORIZONTAL' : 'VERTICAL', wrap: false, pad: [0, 0, 0, 0], gap: r2(inner.gap), cgap: 0, primary: 'MIN', counter: cnt.align,
          hugH: H ? true : !fills, hugV: H ? !fills : true }
      };
      if (fills) { if (H) g.fillV = true; else g.fillH = true; }
      return g;
    };
    return nest(items, gaps);
  }

  function primaryFit(items, L, P0, P1, jc) {
    const n = items.length;
    const gaps = [];
    for (let i = 1; i < n; i++) gaps.push(items[i].p - (items[i - 1].p + items[i - 1].s));
    if (gaps.some((g) => g < -AL_T)) return null;
    const sorted = gaps.slice().sort((a, b) => a - b);
    let g = n > 1 ? Math.max(0, sorted[Math.floor(sorted.length / 2)]) : 0;
    let spacers = null;
    if (gaps.some((x) => !near(x, g))) {
      // неравные отступы: gap 0 + распорки точной величины
      if (!OPTS.spacers || gaps.some((x) => x < -0.5)) return null;
      spacers = gaps.map((x) => Math.max(0, x));
      g = 0;
    }
    const lead = items[0].p, trail = L - (items[n - 1].p + items[n - 1].s);
    if (lead < -AL_T || trail < -AL_T) return null;
    let align, p0 = P0, p1 = P1, exact = false;
    if (near(lead, P0) && near(trail, P1)) {
      align = n > 1 && /space-between/.test(jc) ? 'SPACE_BETWEEN' : 'MIN';
      p0 = lead; p1 = trail; exact = true;
    } else if (near(lead, P0)) { align = 'MIN'; p0 = lead; }
    else if (near(trail, P1)) { align = 'MAX'; p1 = trail; }
    else if (near(lead - P0, trail - P1)) { align = 'CENTER'; }
    else { align = 'MIN'; p0 = lead; }
    if (spacers && align === 'SPACE_BETWEEN') align = 'MIN';
    return { align: align, gap: g, p0: Math.max(0, p0), p1: Math.max(0, p1), exact: exact, lead: lead, trail: trail, spacers: spacers };
  }

  // --- CSS grid → Figma GRID
  function trackList(v) {
    if (!v || v === 'none') return null;
    const toks = splitTop(v.replace(/\[[^\]]*\]/g, ' '), ' ');
    if (!toks.length || toks.some((t) => !/^-?[\d.]+px$/.test(t))) return null;
    return toks.map(px);
  }

  function tryGrid(node, flow, cs, el) {
    const cols = trackList(cs.gridTemplateColumns), rows = trackList(cs.gridTemplateRows);
    if (!cols || !rows || cols.length < 1 || rows.length < 1 || cols.length * rows.length > 400) return null;
    const cg = cs.columnGap === 'normal' ? 0 : px(cs.columnGap), rg = cs.rowGap === 'normal' ? 0 : px(cs.rowGap);
    const pad = node.css.pad;
    const innerW = node.w - pad[1] - pad[3], innerH = node.h - pad[0] - pad[2];
    const totW = cols.reduce((a, b) => a + b, 0) + cg * (cols.length - 1);
    const totH = rows.reduce((a, b) => a + b, 0) + rg * (rows.length - 1);
    if (!near(totW, innerW, 2)) return null;           // сетка должна занимать всю ширину
    if (totH > innerH + 2) return null;
    const cs0 = [], rs0 = [];
    let x = pad[3]; cols.forEach((w) => { cs0.push([x, x + w]); x += w + cg; });
    let y = pad[0]; rows.forEach((h) => { rs0.push([y, y + h]); y += h + rg; });
    const cellOf = (a, b, tracks) => {
      let i = -1, j = -1;
      for (let k = 0; k < tracks.length; k++) if (tracks[k][0] <= a + AL_T) i = k;
      for (let k = tracks.length - 1; k >= 0; k--) if (tracks[k][1] >= b - AL_T) j = k;
      return i >= 0 && j >= i ? [i, j] : null;
    };
    const occ = new Set();
    const placed = [];
    for (const c of flow) {
      const l = c.ax - node.ax, t = c.ay - node.ay;
      const cc = cellOf(l, l + c.w, cs0), rr = cellOf(t, t + c.h, rs0);
      if (!cc || !rr) return null;
      for (let r = rr[0]; r <= rr[1]; r++) for (let k = cc[0]; k <= cc[1]; k++) {
        const key = r + ':' + k;
        if (occ.has(key)) return null;
        occ.add(key);
      }
      const cl = cs0[cc[0]][0], cr = cs0[cc[1]][1], ct = rs0[rr[0]][0], cb = rs0[rr[1]][1];
      const g = { r: rr[0], c: cc[0], rs: rr[1] - rr[0] + 1, cs: cc[1] - cc[0] + 1, ha: 'AUTO', va: 'AUTO', fillH: false, fillV: false };
      if (near(c.w, cr - cl, 1)) g.fillH = true;
      else if (near(l, cl)) g.ha = 'MIN';
      else if (near(l + c.w, cr)) g.ha = 'MAX';
      else if (near(l + c.w / 2, (cl + cr) / 2)) g.ha = 'CENTER';
      else return null;
      if (near(c.h, cb - ct, 1)) g.fillV = true;
      else if (near(t, ct)) g.va = 'MIN';
      else if (near(t + c.h, cb)) g.va = 'MAX';
      else if (near(t + c.h / 2, (ct + cb) / 2)) g.va = 'CENTER';
      else return null;
      if (g.fillH && g.ha === 'AUTO') g.ha = 'MIN';
      if (g.fillV && g.va === 'AUTO') g.va = 'MIN';
      if (c.t === 'TEXT' && g.fillV) { g.fillV = false; g.va = 'MIN'; }
      placed.push({ c: c, g: g });
    }

    // Какие колонки «резиновые»: на мгновение расширяем сетку и смотрим, какие треки выросли
    let colTracks = cols.map((w) => ({ type: 'FIXED', value: r2(w) }));
    try {
      const prevW = el.style.getPropertyValue('width'), prevP = el.style.getPropertyPriority('width');
      const prevMax = el.style.getPropertyValue('max-width'), prevMaxP = el.style.getPropertyPriority('max-width');
      const bs = cs.boxSizing === 'border-box';
      el.style.setProperty('max-width', 'none', 'important');
      el.style.setProperty('width', ((bs ? node.w : innerW) + 120) + 'px', 'important');
      const grown = trackList(getComputedStyle(el).gridTemplateColumns);
      if (prevW) el.style.setProperty('width', prevW, prevP); else el.style.removeProperty('width');
      if (prevMax) el.style.setProperty('max-width', prevMax, prevMaxP); else el.style.removeProperty('max-width');
      if (grown && grown.length === cols.length) {
        const d = grown.map((w, i) => w - cols[i]);
        const flexIdx = d.map((v, i) => (v > 0.5 ? i : -1)).filter((i) => i >= 0);
        if (flexIdx.length) {
          const minD = Math.min(...flexIdx.map((i) => d[i]));
          const fixedSum = cols.reduce((a, w, i) => a + (d[i] > 0.5 ? 0 : w), 0);
          const free = innerW - fixedSum - cg * (cols.length - 1);
          const fr = cols.map((w, i) => (d[i] > 0.5 ? r2(d[i] / minD) : 0));
          const frSum = fr.reduce((a, b) => a + b, 0);
          // проверяем, что Figma с такими долями даст те же ширины
          const ok = cols.every((w, i) => d[i] <= 0.5 || near(free * fr[i] / frSum, w, 1.5));
          if (ok) colTracks = cols.map((w, i) => (d[i] > 0.5 ? { type: 'FLEX', value: fr[i] } : { type: 'FIXED', value: r2(w) }));
        }
      }
    } catch (e) { /* оставляем FIXED */ }

    // Строки: по содержимому → HUG, иначе FIXED
    const fillsContainer = near(totH, innerH, 1.5);
    const rowTracks = rows.map((h, ri) => {
      // высоту строки должен задавать элемент, который сам не растягивается по высоте
      const sizers = placed.filter((p) => p.g.r === ri && p.g.rs === 1 && !p.g.fillV);
      const maxH = sizers.length ? Math.max(...sizers.map((p) => p.c.h)) : 0;
      if (sizers.length && near(maxH, h, 1)) return { type: 'HUG' };
      if (rows.length === 1 && fillsContainer) return { type: 'FLEX', value: 1 };
      return { type: 'FIXED', value: r2(h) };
    });
    const allHug = rowTracks.every((t) => t.type === 'HUG');
    const hugV = allHug && fillsContainer && !node.clip;

    placed.forEach((p) => {
      p.c.grid = { r: p.g.r, c: p.g.c, rs: p.g.rs, cs: p.g.cs, ha: p.g.ha, va: p.g.va };
      p.c.fillH = p.g.fillH; p.c.fillV = p.g.fillV;
    });
    placed.sort((a, b) => a.g.r - b.g.r || a.g.c - b.g.c);
    return {
      al: { mode: 'GRID', pad: pad.map(r2), rowGap: r2(rg), colGap: r2(cg), cols: colTracks, rows: rowTracks, hugH: false, hugV: hugV },
      order: placed.map((p) => p.c)
    };
  }

  function planAutoLayout(node, el, cs) {
    if (!OPTS.autoLayout || node.t !== 'FRAME' || !node.children.length) return;
    const kids = node.children;
    const flow = kids.filter((c) => !isAbsChild(c));
    if (!flow.length || flow.length > 400) return;
    if (flow.some((c) => (c.ci && c.ci.fl && c.ci.fl !== 'none'))) return;
    const d = cs.display;
    const isFlex = /flex/.test(d), isGrid = /grid/.test(d);
    const tableRow = d === 'table-row';
    const row = (isFlex && !/^column/.test(cs.flexDirection)) || tableRow;
    const pad = node.css.pad; // [t,r,b,l] с рамкой
    let modes;
    if (isFlex) modes = row ? (cs.flexWrap !== 'nowrap' ? ['H', 'HW'] : ['H']) : ['V'];
    else if (tableRow) modes = ['H'];
    else if (isGrid) modes = ['V', 'H', 'HW'];
    else modes = ['V'];
    if (flow.length === 1) modes = row ? ['H', 'V'] : ['V', 'H'];

    const pcs = el.parentElement ? gcs(el.parentElement) : null;
    const parentRowFlex = pcs && /flex/.test(pcs.display) && !/^column/.test(pcs.flexDirection);
    const shrinkWrapW = /^inline/.test(d) || parentRowFlex || (node.ci && node.ci.fl && node.ci.fl !== 'none') ||
      cs.position === 'absolute' || cs.position === 'fixed' || /max-content|fit-content/.test(cs.width);

    const gridMin = isGrid ? responsiveGridMin(el) : 0;
    if (gridMin) modes = ['HW', 'H'];
    else if (isGrid) {
      const nCols = (trackList(cs.gridTemplateColumns) || []).length;
      if (nCols >= 2) modes = ['G'].concat(modes); else modes = modes.concat(['G']);
    }
    const isDeco = (c) => c.t !== 'TEXT' && !c.children?.some?.((k) => k.t === 'TEXT') && c.w <= 40 && c.h <= 40;
    const attempts = [flow];
    const deco = flow.filter(isDeco);
    if (deco.length && deco.length < flow.length) attempts.push(flow.filter((c) => !isDeco(c)));
    for (let ai = 0; ai < attempts.length; ai++) {
    const fl = attempts[ai];
    for (const mode of modes) {
      const plan = mode === 'G' ? tryGrid(node, fl, cs, el) : tryPlan(node, fl, mode, pad, cs, isFlex, row, shrinkWrapW, el);
      if (plan && ai > 0) deco.forEach((c) => { c.forceAbs = true; });
      if (plan) {
        node.al = plan.al;
        if (gridMin && mode !== 'G') {
          // Cards of a responsive grid: fill the row, as tall as the row, at least the grid's min width.
          plan.al.wrap = true;
          plan.al.mode = 'HORIZONTAL';
          plan.al.cgap = r2(px(cs.rowGap) || plan.al.cgap || 0);
          plan.al.gap = r2(px(cs.columnGap) || plan.al.gap || 0);
          plan.al.hugH = false;
          for (const c of plan.order) if (!c.spacer) { c.fillH = true; c.fillV = true; c.minW = gridMin; }
        }
        // порядок: абсолютные «сзади», поток по оси, абсолютные «спереди»
        const absK = kids.filter(isAbsChild);
        const behind = absK.filter((c) => (c.z || [1])[0] < 1);
        const front = absK.filter((c) => (c.z || [1])[0] >= 1);
        absK.forEach((c) => { c.abs = true; });
        node.children = behind.concat(plan.order, front);
        return;
      }
    }
    }
  }

  // The grid-template-columns the page wrote (computed styles only give the px tracks):
  // inline style first, then the last matching rule (media queries that apply included).
  function specifiedColumns(el) {
    if (el.style && el.style.gridTemplateColumns) return el.style.gridTemplateColumns;
    let found = '';
    const scan = (rules) => {
      for (const r of rules) {
        if (r.cssRules && r.media && !matchMedia(r.media.mediaText).matches) continue;
        if (r.cssRules && !r.selectorText) { scan(r.cssRules); continue; }
        try {
          if (r.selectorText && r.style && r.style.gridTemplateColumns && el.matches(r.selectorText)) found = r.style.gridTemplateColumns;
        } catch (e) { /* a selector the browser cannot match */ }
      }
    };
    for (const sheet of document.styleSheets) {
      try { scan(sheet.cssRules); } catch (e) { /* another origin */ }
    }
    return found;
  }

  // "repeat(auto-fit, minmax(280px, 1fr))": as many columns as fit — in Figma terms a wrapping row
  // whose cards fill their row and never get narrower than 280.
  function responsiveGridMin(el) {
    const m = /repeat\(\s*auto-(?:fit|fill)\s*,\s*minmax\(\s*([\d.]+)px/.exec(specifiedColumns(el));
    return m ? parseFloat(m[1]) : 0;
  }

  // Height set by the content (CSS height: auto): a row whose layers stretch to it may still hug them.
  function heightByContent(el) {
    if (!el || !el.isConnected) return false;
    const was = [el.style.getPropertyValue('height'), el.style.getPropertyPriority('height')];
    const h0 = el.getBoundingClientRect().height;
    el.style.setProperty('height', 'auto', 'important');
    const h1 = el.getBoundingClientRect().height;
    if (was[0]) el.style.setProperty('height', was[0], was[1]); else el.style.removeProperty('height');
    if (Math.abs(h1 - h0) >= 0.5) return false;
    // Grown by a column around it: its height is the column's, not its content's.
    const pcs = el.parentElement ? gcs(el.parentElement) : null;
    return !(pcs && /flex/.test(pcs.display) && /^column/.test(pcs.flexDirection) && parseFloat(gcs(el).flexGrow) > 0);
  }

  // Какие промежутки «резиновые» (margin: auto, space-between): расширяем контейнер и смотрим
  function probeGaps(el, H, items) {
    if (!el || items.some((it) => !it.c._el || !it.c._el.isConnected)) return null;
    const dim = H ? 'width' : 'height';
    const save = (p) => [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)];
    const restore = (p, v) => { if (v[0]) el.style.setProperty(p, v[0], v[1]); else el.style.removeProperty(p); };
    const sDim = save(dim), sMax = save('max-' + dim), sFlex = save('flex');
    try {
      const r0 = el.getBoundingClientRect();
      const ecs = getComputedStyle(el);
      const extra = ecs.boxSizing === 'border-box' ? 0 :
        (H ? px(ecs.paddingLeft) + px(ecs.paddingRight) + px(ecs.borderLeftWidth) + px(ecs.borderRightWidth)
           : px(ecs.paddingTop) + px(ecs.paddingBottom) + px(ecs.borderTopWidth) + px(ecs.borderBottomWidth));
      el.style.setProperty('max-' + dim, 'none', 'important');
      const pcs = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const parentMainIsDim = pcs && /flex/.test(pcs.display) && (/^column/.test(pcs.flexDirection) ? !H : H);
      if (parentMainIsDim) el.style.setProperty('flex', 'none', 'important');
      el.style.setProperty(dim, ((H ? r0.width : r0.height) - extra + 160) + 'px', 'important');
      const r1 = el.getBoundingClientRect();
      const pos = items.map((it) => {
        const r = it.c._el.getBoundingClientRect();
        return H ? { p: r.left - r1.left, s: r.width } : { p: r.top - r1.top, s: r.height };
      });
      const res = { gaps: [], lead: 0, trail: 0 };
      for (let i = 1; i < pos.length; i++) res.gaps.push(pos[i].p - (pos[i - 1].p + pos[i - 1].s) - (items[i].p - (items[i - 1].p + items[i - 1].s)));
      res.lead = pos[0].p - items[0].p;
      const L1 = H ? r1.width : r1.height, L0 = H ? r0.width : r0.height;
      res.trail = (L1 - (pos[pos.length - 1].p + pos[pos.length - 1].s)) - (L0 - (items[items.length - 1].p + items[items.length - 1].s));
      res.sizeGrow = pos.some((p, i) => Math.abs(p.s - items[i].s) > 1);
      return res;
    } catch (e) {
      return null;
    } finally {
      restore(dim, sDim); restore('max-' + dim, sMax); restore('flex', sFlex);
    }
  }

  function tryPlan(node, flow, mode, pad, cs, isFlex, row, shrinkWrapW, el) {
    const H = mode !== 'V';
    const L = H ? node.w : node.h, C = H ? node.h : node.w;
    const P0 = H ? pad[3] : pad[0], P1 = H ? pad[1] : pad[2];
    const Q0 = H ? pad[0] : pad[3], Q1 = H ? pad[2] : pad[1];
    const items = flow.map((c) => ({
      c: c,
      p: H ? c.ax - node.ax : c.ay - node.ay, s: H ? c.w : c.h,
      q: H ? c.ay - node.ay : c.ax - node.ax, cs: H ? c.h : c.w
    }));
    const ai = isFlex || /grid/.test(cs.display) ? cs.alignItems : 'normal';
    const preferC = /center/.test(ai) ? 'CENTER' : /end/.test(ai) ? 'MAX' : 'MIN';
    let prim, cnt, order, lines = null, cgap = 0;

    if (mode === 'HW') {
      const sorted = items.slice().sort((a, b) => a.q - b.q || a.p - b.p);
      lines = [];
      for (const it of sorted) {
        const l = lines[lines.length - 1];
        if (l && it.q < l.bottom - AL_T) { l.items.push(it); l.bottom = Math.max(l.bottom, it.q + it.cs); l.top = Math.min(l.top, it.q); }
        else lines.push({ items: [it], top: it.q, bottom: it.q + it.cs });
      }
      if (lines.length < 2) return null;
      lines.forEach((l) => l.items.sort((a, b) => a.p - b.p));
      const fits = lines.map((l) => primaryFit(l.items, L, P0, P1, 'normal'));
      if (fits.some((f) => !f || f.spacers || f.align !== 'MIN' && f.align !== 'SPACE_BETWEEN')) return null;
      const g = fits.find((f, i) => lines[i].items.length > 1);
      const gap = g ? g.gap : 0;
      if (fits.some((f, i) => lines[i].items.length > 1 && !near(f.gap, gap))) return null;
      if (fits.some((f) => !near(f.lead, fits[0].lead))) return null;
      const p0 = Math.max(0, fits[0].lead);
      const inner = L - p0 - P1;
      // Figma переносит строку, когда следующий элемент не помещается — проверяем точки переноса
      for (let i = 0; i < lines.length; i++) {
        const w = lines[i].items.reduce((a, it) => a + it.s, 0) + gap * (lines[i].items.length - 1);
        if (w > inner + AL_T) return null;
        if (i < lines.length - 1 && w + gap + lines[i + 1].items[0].s <= inner - 0.5) return null;
      }
      const rgaps = [];
      for (let i = 1; i < lines.length; i++) rgaps.push(lines[i].top - lines[i - 1].bottom);
      cgap = rgaps[0];
      if (cgap < -0.5 || rgaps.some((x) => !near(x, cgap))) return null;
      for (const l of lines) for (const it of l.items) if (!near(it.q, l.top)) return null;
      prim = { align: 'MIN', gap: gap, p0: p0, p1: P1, exact: false };
      cnt = { align: 'MIN', q0: Math.max(0, lines[0].top), q1: Q1 };
      order = lines.flatMap((l) => l.items.map((it) => it.c));
    } else {
      items.sort((a, b) => a.p - b.p);
      prim = primaryFit(items, L, P0, P1, isFlex ? cs.justifyContent : 'normal');
      if (!prim) return null;
      cnt = counterFit(items, C, Q0, Q1, preferC);
      if (!cnt) return null;
      order = items.map((it) => it.c);
      if (prim.spacers) {
        const withSp = [];
        items.forEach((it, i) => {
          if (i > 0 && prim.spacers[i - 1] > 0.5) {
            const v = prim.spacers[i - 1];
            const prev = items[i - 1];
            const sp = { t: 'FRAME', name: 'spacer', spacer: true, _gapIndex: i - 1, ci: { spacer: true }, children: [],
              ax: H ? node.ax + prev.p + prev.s : node.ax + cnt.q0, ay: H ? node.ay + cnt.q0 : node.ay + prev.p + prev.s,
              w: H ? v : 0.01, h: H ? 0.01 : v };
            withSp.push(sp);
          }
          withSp.push(it.c);
        });
        order = withSp;
      }
    }

    // margin: auto / space-between → Space between или растягивающиеся распорки
    let flexSpacers = false;
    if (isFlex && mode !== 'HW' && (H === row) && items.length >= 2 && !node.clip) {
      const pr = probeGaps(el, H, items);
      if (pr && !pr.sizeGrow) {
        const grow = pr.gaps.map((d) => d > 1);
        const edgesGrow = pr.lead > 1 || pr.trail > 1;
        if (grow.some(Boolean) && !edgesGrow) {
          if (!prim.spacers && grow.every(Boolean)) {
            prim.align = 'SPACE_BETWEEN';
          } else if (prim.spacers) {
            const flexVals = prim.spacers.filter((v, i) => grow[i]);
            const growVals = pr.gaps.filter((d, i) => grow[i]);
            // CSS делит место поровну между auto-отступами — как Figma между распорками Fill
            if (flexVals.every((v) => near(v, flexVals[0])) && growVals.every((d) => near(d, growVals[0], 2))) {
              let gi = 0;
              order.forEach((c) => { if (c.spacer) { const gIdx = c._gapIndex; if (grow[gIdx]) { if (H) c.fillH = true; else c.fillV = true; flexSpacers = true; } gi++; } });
            }
          }
        }
      }
    }

    // Размеры детей: растягивание по поперечной оси и заполнение по основной
    const innerC = C - cnt.q0 - cnt.q1;
    let anyFillC = false, anyFillP = false;
    for (const it of items) {
      const c = it.c, ci = c.ci || {};
      c.fillH = false; c.fillV = false; c.frH = undefined;
      let stretchable;
      if (isFlex) stretchable = ci.as === 'stretch' || ((ci.as === 'auto' || ci.as === 'normal' || !ci.as) && /stretch|normal/.test(cs.alignItems));
      else stretchable = H ? false : (c.t === 'TEXT' || !/^inline/.test(ci.disp || 'block'));
      // A block with a max-width narrower than the column: as wide as the column, but not wider (FILL + max).
      if (!H && c.t === 'FRAME' && ci.mw && near(it.cs, ci.mw, 1) && it.cs < innerC - 1 && !/^inline/.test(ci.disp || 'block')) {
        c.fillH = true;
        c.maxW = ci.mw;
        anyFillC = true;
        continue;
      }
      // Only a block as wide as the column (a max-width keeps a paragraph narrower), and not when its lines
      // reach the column's edge: measured a hair wider here, they would wrap where the page did not
      // (a one-line text needs a few px to spare).
      const spare = c.auto === 'WIDTH_AND_HEIGHT' ? 4 : -0.5;
      if (!H && c.t === 'TEXT' && c.blockW && near(c.blockW, innerC, 1) && (!isFlex || stretchable) && it.cs <= innerC - spare) {
        c.fillH = true;
        anyFillC = true;
        continue;
      }
      if (mode !== 'HW' && stretchable && near(it.cs, innerC, 1) && !(c.t === 'TEXT' && H)) {
        if (H) c.fillV = true; else c.fillH = true;
        anyFillC = true;
      }
      // Table cells: as tall as the row, as wide as a share of it (fr = the column's width),
      // so the table stretches with the page and its columns stay lined up row to row.
      if (cs.display === 'table-row' && H && mode === 'H') {
        c.fillV = true;
        c.frH = r2(it.s);
        anyFillP = true;
        anyFillC = true;
        continue;
      }
      if (isFlex && mode === 'H' === row && ci.grow > 0 && prim.exact && prim.align !== 'SPACE_BETWEEN') {
        if (H) c.fillH = true; else c.fillV = true;
        anyFillP = true;
      }
    }

    // Unequal gaps without spacers (as a designer would build it): the largest gaps split the run into
    // blocks, each block is a nested row or column with its own smaller gap — exact, and no empty layers.
    // Stretching spacers (margin: auto) stay: free room is not a gap.
    if (prim.spacers && !flexSpacers) {
      const nested = nestByGaps(node, items, prim.spacers, H, cnt, innerC, OPTS.simplify ? 4 : AL_T);
      order = nested.list;
      prim.gap = nested.gap;
      prim.spacers = null;
    }

    // Hug для самого контейнера
    const contentC = Math.max(...items.map((i) => i.cs));
    let hugP = prim.exact && !anyFillP && !flexSpacers && prim.align === 'MIN' && mode !== 'HW';
    let hugC = (!anyFillC || (H && heightByContent(el))) && near(contentC + cnt.q0 + cnt.q1, C, 1) && mode !== 'HW';
    if (H) { if (hugP && !shrinkWrapW) hugP = false; }
    else { if (hugC && !shrinkWrapW) hugC = false; }
    if (node.clip) { hugP = false; hugC = false; }

    const padding = H ? [cnt.q0, prim.p1, cnt.q1, prim.p0] : [prim.p0, cnt.q1, prim.p1, cnt.q0];
    return {
      al: {
        mode: H ? 'HORIZONTAL' : 'VERTICAL', wrap: mode === 'HW', pad: padding.map(r2), gap: r2(prim.gap), cgap: r2(cgap),
        primary: prim.align, counter: H && isFlex && /baseline/.test(cs.alignItems) ? 'BASELINE' : cnt.align, hugH: H ? hugP : hugC, hugV: H ? hugC : hugP,
        acont: mode === 'HW' && /space-between/.test(cs.alignContent || '') ? 'SPACE_BETWEEN' : undefined
      },
      order: order
    };
  }

  function processElement(el, out, forceFlatten) {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (el.hasAttribute && el.hasAttribute('data-h2d')) return;
    const cs = gcs(el);
    if (cs.display === 'none') return;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      // потомки могут быть видимы (visibility: visible) — проверяем их
      const tmp = [];
      processChildren(el, tmp);
      out.push(...tmp);
      return;
    }
    const op = parseFloat(cs.opacity);
    if (op < 0.01) return;
    if (cs.display === 'contents') { processChildren(el, out); return; }

    const r = el.getBoundingClientRect();
    const box = absRect(r);
    // фон на position: fixed во весь экран растягиваем на всю страницу
    if (cs.position === 'fixed' && box.w >= innerWidth - 1 && box.h >= innerHeight - 1 && PAGE_H > innerHeight + 1 &&
      tag !== 'canvas' && !(el.textContent || '').trim() && !el.querySelector('img,svg,video,canvas,input,button')) {
      box.ay = sy; box.h = PAGE_H;
    }
    const z = zKey(el, cs);
    const rot = rotMap.get(el);

    if (tag === 'svg' || el.namespaceURI === SVG_NS) {
      if (tag !== 'svg' || box.w < 0.5 || box.h < 0.5) return;
      const n = { t: 'SVG', name: nameOf(el) === 'svg' ? 'icon' : nameOf(el), svg: serializeSvg(el, box), ax: box.ax, ay: box.ay, w: box.w, h: box.h, z: z };
      if (op < 1) n.opacity = op;
      if (rot) n.rot = rot;
      svgTasks.push(n);
      out.push(n);
      return;
    }

    if (box.w < 0.5 || box.h < 0.5) {
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
      if (clips) return;
      // элемент без размеров, но с «вылезающими» детьми
      const tmp = [];
      processChildren(el, tmp);
      out.push(...tmp);
      return;
    }

    if (tag === 'img' || tag === 'canvas' || tag === 'video' || (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'image')) {
      const n = mediaNode(el, cs, box, z, tag);
      if (n) { if (op < 1) n.opacity = op; if (rot) n.rot = rot; out.push(n); }
      return;
    }
    if (tag === 'iframe' || tag === 'object' || tag === 'embed') {
      out.push({ t: 'RECT', name: tag + TT('embedded'), ax: box.ax, ay: box.ay, w: box.w, h: box.h, fills: [solid({ r: 0.93, g: 0.93, b: 0.94, a: 1 })], z: z });
      return;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const n = formNode(el, cs, box, z);
      if (n) { if (rot) n.rot = rot; out.push(n); }
      return;
    }
    if (tag === 'table' && !rot) {
      const n = tableNode(el, cs, box, z);
      if (n) {
        if (op < 1) n.opacity = op;
        // The caption stays a text of its own, above the table as on the page.
        for (const cap of el.children) if (cap.tagName.toLowerCase() === 'caption') processElement(cap, out);
        out.push(n);
        return;
      }
    }

    const node = { t: 'FRAME', name: nameOf(el), ax: box.ax, ay: box.ay, w: box.w, h: box.h, children: [], z: z };
    const visual = boxVisuals(node, el, cs, box, node.children);
    const clip = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /paint|strict|content/.test(cs.contain || '');
    if (clip && !(tag === 'body' || tag === 'html')) node.clip = true;
    if (op < 1) node.opacity = op;
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') node.blend = cs.mixBlendMode;
    if (rot) node.rot = rot;
    // A table cell keeps its box even without a background: its width is the column's.
    const special = visual || node.clip || node.opacity != null || node.rot || node.blend || cs.display === 'table-cell';
    const cb0 = contentBox(cs, box);
    node.css = { pad: [cb0.y - box.ay, box.ax + box.w - cb0.x - cb0.w, box.ay + box.h - cb0.y - cb0.h, cb0.x - box.ax] };

    if (cs.display === 'list-item') {
      const mk = markerNode(el, cs, box);
      if (mk) node.children.push(mk);
    }

    const isBlockish = cs.display !== 'inline';
    if (isBlockish && isInlineContent(el, 0)) {
      const tn = textBlock(el, cs, box, [1, 0, ord++]);
      // Text of a block (a paragraph, a heading, a list item, a cell) is as wide as its column in CSS.
      if (tn && tn.t === 'TEXT' && /^(block|list-item|table-cell|table-caption|flow-root)$/.test(cs.display)) tn.blockW = box.w;
      if (tn && !special && !forceFlatten) {
        tn.z = z;
        if (tn.t === 'RECT') tn.name = nameOf(el);
        out.push(tn);
        node.children.filter((c) => c.name === 'marker').forEach((m) => { m.z = [z[0], z[1], z[2] + 0.5]; out.push(m); });
        return;
      }
      if (tn) node.children.push(tn);
    } else {
      const items = flexTextRow(el, cs);
      const tn = items ? flexRowText(el, cs, box, items, [1, 0, ord++]) : null;
      if (tn) {
        if (!special && !forceFlatten) {
          tn.z = z;
          out.push(tn);
          node.children.filter((c) => c.name === 'marker').forEach((m) => { m.z = [z[0], z[1], z[2] + 0.5]; out.push(m); });
          return;
        }
        node.children.push(tn);
      } else {
        processChildren(el, node.children);
      }
    }

    node.children.sort(cmpZ);
    const stack = createsStacking(el, cs);

    // "Simplify" drops empty wrappers, but not one that lays out its children (flex, grid, a column of blocks,
    // a table row): without it the page loses its auto layout and stops adapting to the width.
    // Only when its layers paint with it: a positioned layer with its own z-index inside a wrapper that makes
    // no stacking context goes between layers outside it (a heading over the sky), so that wrapper still goes.
    const paintsWithIt = stack || node.children.every((c) => !c.z || c.z[0] === 1 || (c.z[0] === z[0] && c.z[1] === z[1]));
    if (!special && !forceFlatten && OPTS.simplify && node.children.length > 0 && paintsWithIt) {
      planAutoLayout(node, el, cs);
      const p = node.css.pad;
      if (node.al && (node.children.filter((c) => !c.abs).length > 1 || p.some((v) => v > 0.5))) {
        out.push(node);
        return;
      }
      node.al = undefined;
      node.children.forEach((c) => { c.abs = undefined; c.fillH = false; c.fillV = false; c.frH = undefined; });
    }
    if (!special && (forceFlatten || OPTS.simplify || node.children.length === 0)) {
      if (node.children.length === 0) return;
      const n = node.children.length;
      node.children.forEach((c, i) => {
        if (stack) c.z = [z[0], z[1], z[2] + (i + 1) / (n + 1)];
        out.push(c);
      });
      return;
    }
    planAutoLayout(node, el, cs);
    out.push(node);
  }

  // --- Tables: a table of data becomes a real table (build.ts), not frames of rows and border strips.
  // A layout table (pictures, forms, tables inside) stays as it was.

  /** The colour behind a layer: the first background up the tree (a gradient gives its first stop). */
  function backdrop(el) {
    for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
      const c = gcs(p);
      const bc = parseColor(c.backgroundColor);
      if (bc && bc.a > 0.5) return { r: bc.r, g: bc.g, b: bc.b, a: 1 };
      if (c.backgroundImage && /gradient\(/i.test(c.backgroundImage)) {
        const g = gradientPaint(splitTop(c.backgroundImage, ',')[0], 100, 100);
        const s = g && g.gradientStops && g.gradientStops[0];
        if (s) return { r: s.color.r, g: s.color.g, b: s.color.b, a: 1 };
      }
    }
    return { r: 1, g: 1, b: 1, a: 1 };
  }

  function isDataTable(el) {
    if ((el.getAttribute('role') || '').toLowerCase() === 'presentation') return false;
    if (el.querySelector('table, video, canvas, iframe, object, embed, input, select, textarea, button')) return false;
    // Small pictures (flags, icons) may be in cells; a big one means the table lays out a page.
    for (const m of el.querySelectorAll('img, svg, picture')) {
      const r = m.getBoundingClientRect();
      if (r.width > 64 || r.height > 64) return false;
    }
    return true;
  }

  function tableNode(el, cs, box, z) {
    if (!isDataTable(el)) return null;
    const rows = Array.from(el.rows).filter((tr) => gcs(tr).display !== 'none' && tr.getBoundingClientRect().height > 0.5);
    if (rows.length < 2 || rows.length > 300) return null;
    // Places of the cells, merged ones taking all theirs (as the browser lays them out).
    const occ = rows.map(() => []);
    const cells = [];
    rows.forEach((tr, r) => {
      let c = 0;
      for (const td of tr.cells) {
        if (gcs(td).display === 'none') continue;
        while (occ[r][c]) c++;
        const span = Math.min(50, Math.max(1, td.colSpan || 1));
        const rs = td.rowSpan === 0 ? rows.length - r : Math.max(1, Math.min(td.rowSpan || 1, rows.length - r));
        const cell = { td: td, r: r, c: c, rs: rs, cs: span, rect: absRect(td.getBoundingClientRect()) };
        for (let i = r; i < r + rs; i++) for (let j = c; j < c + span; j++) occ[i][j] = cell;
        cells.push(cell);
        c += span;
      }
    });
    const nCols = Math.max(...occ.map((row) => row.length));
    if (nCols < 2 || nCols > 50 || cells.length > 3000) return null;
    // Column and row edges: where their cells begin; the last ones end where the cells do.
    const xs = [], ys = [];
    let right = -Infinity, bottom = -Infinity;
    for (const cell of cells) {
      if (xs[cell.c] == null || cell.rect.ax < xs[cell.c]) xs[cell.c] = cell.rect.ax;
      if (ys[cell.r] == null || cell.rect.ay < ys[cell.r]) ys[cell.r] = cell.rect.ay;
      right = Math.max(right, cell.rect.ax + cell.rect.w);
      bottom = Math.max(bottom, cell.rect.ay + cell.rect.h);
    }
    const colW = [], rowH = [];
    for (let c = 0; c < nCols; c++) colW.push((c + 1 < nCols ? xs[c + 1] : right) - xs[c]);
    for (let r = 0; r < rows.length; r++) rowH.push((r + 1 < rows.length ? ys[r + 1] : bottom) - ys[r]);
    if (colW.some((w) => !(w > 0.5)) || rowH.some((h) => !(h > 0.5))) return null;

    // The lines: the commonest colour of the cells' borders.
    const votes = new Map();
    for (const cell of cells) {
      const ccs = gcs(cell.td);
      for (const s of ['Top', 'Right', 'Bottom', 'Left']) {
        if (px(ccs['border' + s + 'Width']) <= 0 || /none|hidden/.test(ccs['border' + s + 'Style'])) continue;
        const c = parseColor(ccs['border' + s + 'Color']);
        if (!c || c.a < 0.05) continue;
        const k = hex(c);
        const v = votes.get(k) || { c: c, n: 0 };
        v.n++;
        votes.set(k, v);
      }
    }
    let line = null;
    for (const v of votes.values()) if (!line || v.n > line.n) line = v;

    const ax = xs[0], ay = ys[0];
    const empty = (r, c, hidden) => ({ t: 'FRAME', name: 'td', ax: xs[c], ay: ys[r], w: colW[c], h: rowH[r], children: [],
      fills: hidden ? [] : [solid(backdrop(rows[r]))], cell: { rs: 1, cs: 1, hidden: hidden, pad: [0, 0, 0, 0], va: 'MIN', minH: hidden ? 0 : rowH[r] } });
    const kids = [];
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < nCols; c++) {
        const cell = occ[r][c];
        if (!cell) kids.push(empty(r, c, false));
        else if (cell.r !== r || cell.c !== c) kids.push(empty(r, c, true));
        else kids.push(tableCell(cell, rowH[r]));
      }
    }
    const head = rows[0].parentElement === el.tHead || Array.from(rows[0].cells).every((td) => td.tagName === 'TH');
    return { t: 'FRAME', name: nameOf(el), ax: ax, ay: ay, w: right - ax, h: bottom - ay, z: z, children: kids,
      tbl: { cols: colW.map(r2), header: head, line: line ? solid(line.c) : null } };
  }

  /** One cell: its fill (what shows through it when it has none), padding, vertical alignment and content. */
  function tableCell(cell, rowH) {
    const td = cell.td;
    const ccs = gcs(td);
    const tmp = [];
    processElement(td, tmp);
    const n = tmp.length === 1 && tmp[0].t === 'FRAME' && !tmp[0].tbl ? tmp[0] : { children: tmp };
    const under = backdrop(td.parentElement);
    let fills = (n.fills || []).filter((f) => f.type !== 'IMAGE');
    const top = fills[fills.length - 1];
    if (!fills.length) fills = [solid(under)];
    else if (fills.length === 1 && top.type === 'SOLID' && top.opacity < 1) {
      // A see-through background over the row's: the colour one sees.
      const a = top.opacity;
      fills = [solid({ r: top.color.r * a + under.r * (1 - a), g: top.color.g * a + under.g * (1 - a), b: top.color.b * a + under.b * (1 - a), a: 1 })];
    }
    const va = ccs.verticalAlign === 'middle' ? 'CENTER' : ccs.verticalAlign === 'bottom' ? 'MAX' : 'MIN';
    const pad = n.css ? n.css.pad.map(r2) : [px(ccs.paddingTop), px(ccs.paddingRight), px(ccs.paddingBottom), px(ccs.paddingLeft)];
    return { t: 'FRAME', name: nameOf(td), ax: cell.rect.ax, ay: cell.rect.ay, w: cell.rect.w, h: cell.rect.h, fills: fills,
      cell: { rs: cell.rs, cs: cell.cs, hidden: false, pad: pad, va: va, minH: cell.rs === 1 ? r2(rowH) : 0 },
      children: (n.children || []).filter((k) => !(k.ci && k.ci.helper)) };
  }

  function mediaNode(el, cs, box, z, tag) {
    const cb = contentBox(cs, box);
    const node = { t: 'RECT', name: nameOf(el), ax: box.ax, ay: box.ay, w: box.w, h: box.h, z: z };
    const extra = [];
    boxVisuals(node, el, cs, box, extra);
    const fills = node.fills || [];
    let id = null, rec = null;
    if (tag === 'canvas') {
      try {
        const probe = document.createElement('canvas');
        probe.width = probe.height = 24;
        const pc = probe.getContext('2d');
        pc.drawImage(el, 0, 0, 24, 24);
        const d = pc.getImageData(0, 0, 24, 24).data;
        let alpha = 0;
        for (let i = 3; i < d.length; i += 4) alpha += d[i];
        if (!alpha) return null;
      } catch (e) { /* tainted — оставляем */ }
      try { id = registerBytes(canvasBytes(el)); } catch (e) { id = null; }
    } else if (tag === 'video') {
      if (el.poster) rec = imageCache.get(el.poster);
      if (!rec || rec.failed) {
        try {
          const c = document.createElement('canvas');
          c.width = el.videoWidth || box.w; c.height = el.videoHeight || box.h;
          c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
          id = registerBytes(canvasBytes(c));
        } catch (e) { id = null; }
      }
    } else {
      rec = imageCache.get(el.currentSrc || el.src);
    }
    const fit = cs.objectFit;
    if (rec && rec.svgText && tag === 'img' && !fills.length && !node.stroke && !node.radii) {
      const s = sizeSvg(rec.svgText, cb.w, cb.h, fit === 'fill' && false);
      if (s) {
        const n = { t: 'SVG', name: nameOf(el), svg: s, ax: cb.x, ay: cb.y, w: cb.w, h: cb.h, z: z };
        if (node.effects) n.effects = node.effects;
        svgTasks.push(n);
        return n;
      }
    }
    if (id == null && rec) id = imageId(rec);
    if (id != null) {
      const mode = fit === 'cover' ? 'FILL' : fit === 'contain' || fit === 'scale-down' || fit === 'none' ? 'FIT' : 'CROP';
      fills.push({ type: 'IMAGE', imageId: id, scaleMode: rec && rec.svgText && mode === 'CROP' ? 'FIT' : mode });
    } else if (!fills.length) {
      fills.push(solid({ r: 0.87, g: 0.87, b: 0.89, a: 1 }));
      node.name = nameOf(el) + TT('notLoaded');
    }
    node.fills = fills;
    return node;
  }

  // --- Относительные координаты, трансформации, округление
  function finalize(n, pax, pay) {
    const out = { t: n.t };
    if (n.name) out.name = n.name;
    const x = n.ax - pax, y = n.ay - pay;
    if (n.rot) {
      const R = n.rot;
      const Px = R.ox - (R.cos * R.ox - R.sin * R.oy) + R.e;
      const Py = R.oy - (R.sin * R.ox + R.cos * R.oy) + R.f;
      out.rt = [[R.cos, -R.sin, r2(x + Px)], [R.sin, R.cos, r2(y + Py)]];
    }
    out.x = r2(x); out.y = r2(y);
    out.w = r2(Math.max(0.01, n.w || 0)); out.h = r2(Math.max(0.01, n.h || 0));
    for (const k of ['fills', 'stroke', 'radii', 'effects', 'opacity', 'blend', 'clip', 'svg', 'raster', 'chars', 'styles', 'ranges', 'base', 'align', 'auto', 'maxLines', 'al', 'abs', 'fillH', 'fillV', 'frH', 'maxW', 'minW', 'spacer', 'grid', 'tbl', 'cell']) {
      if (n[k] != null) out[k] = n[k];
    }
    if (n.children && n.children.length) out.children = n.children.map((c) => finalize(c, n.ax, n.ay));
    return out;
  }

  function countTree(n) { let c = 1; if (n.children) for (const ch of n.children) c += countTree(ch); return c; }

  // =======================================================================
  async function run(opts) {
    OPTS = opts;
    status(TT('wait'));
    eagerImages();
    await waitReady();
    await waitImages(6000);
    if (opts.delay) await sleep(opts.delay);
    await waitQuiet(20000);
    if (opts.expand !== false) {
      if (expandScrollers()) { await sleep(120); await waitImages(3000); }
    }
    if (opts.scroll) {
      status(TT('scroll'));
      await scrollThrough();
      await waitImages(3000);
    }
    freezeAnimations();
    await sleep(60);
    try { await Promise.race([document.fonts.ready, sleep(2000)]); } catch (e) { /* ignore */ }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

    status(TT('analyze'));
    materializePseudos();
    stripRotations();
    csCache = new Map();
    sx = window.scrollX; sy = window.scrollY;

    const urls = collectImageUrls();
    if (urls.length) {
      status(TT('images', 0, urls.length));
      await loadAllImages(urls);
    }

    status(TT('layers'));
    const de = document.documentElement, body = document.body;
    const dcs = gcs(de), bcs = body ? gcs(body) : null;
    const pageW = window.innerWidth;
    const pageH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0, window.innerHeight);
    PAGE_H = pageH;
    let rootFills = [solid({ r: 1, g: 1, b: 1, a: 1 })];
    const hasBg = (cs) => { const c = parseColor(cs.backgroundColor); return (c && c.a > 0.004) || cs.backgroundImage !== 'none'; };
    let canvasEl = null;
    if (hasBg(dcs)) canvasEl = de; else if (bcs && hasBg(bcs)) canvasEl = body;
    if (canvasEl) {
      const tmp = { children: [] };
      const cs = gcs(canvasEl);
      boxVisuals(tmp, canvasEl, cs, { ax: 0, ay: 0, w: pageW, h: pageH }, []);
      const base = parseColor(cs.backgroundColor);
      rootFills = [solid({ r: 1, g: 1, b: 1, a: 1 })].concat((tmp.fills || []).filter((f) => f.type !== 'IMAGE' || true));
      if (base && base.a >= 0.999) rootFills = tmp.fills;
      skipBgFor.add(canvasEl);
    }

    const title = (document.title || '').trim() || opts.name || 'HTML';
    const root = { t: 'FRAME', name: title + ' — ' + pageW + 'px', ax: 0, ay: 0, w: pageW, h: pageH, fills: rootFills, clip: true, children: [] };
    processElement(de, root.children, true);
    root.children.sort(cmpZ);
    // The page itself is a column of sections, as the body lays them out: narrowing it reflows them.
    if (body && bcs) {
      root.css = { pad: [0, 0, 0, 0] };
      planAutoLayout(root, body, bcs);
      if (root.al) { root.al.hugH = false; root.al.hugV = true; }
    }

    status(TT('vectors'));
    await Promise.all(svgTasks.map(async (n) => {
      const bytes = await rasterSvg(n.svg, n.w, n.h);
      if (bytes) n.raster = registerBytes(bytes);
    }));

    const tree = finalize(root, 0, 0);
    tree.x = 0; tree.y = 0;
    const transfer = [];
    const seen = new Set();
    for (const im of images) if (im.bytes && !seen.has(im.bytes.buffer)) { seen.add(im.bytes.buffer); transfer.push(im.bytes.buffer); }
    return { tree: tree, images: images, stats: { nodes: countTree(tree), images: images.length }, transfer: transfer };
  }
  // Simmetrika: tell the editor the runtime is in place, so it can send "capture".
  post({ kind: 'installed' });
}
