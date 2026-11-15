// «Сайт дизайн-системы» (FEAT-226, other editors, item 8; as zeroheight, Supernova): one self-contained HTML page
// from the file — colours, typography, effects, numbers, components with pictures, descriptions, variants and
// properties, and the tokens as CSS. Names are the same as in «Переменные в код» (token-code.ts), so a developer
// finds `var(--…)` as written. No network: fonts by name, pictures as data URLs, a little script for search and copy.

import { colorToHex, cssNoTags, isColorValue, tr, type Color, type Document, type NodeId, type Paint, type VariableLiteral } from '#core';
import { isStyle } from '#components';
import { ownUnits } from './library.ts';
import { defaultTokenOptions, tokenModel, tokensToCode, type Token } from './token-code.ts';

export interface SiteInput {
  doc: Document;
  /** A picture of a component or set (data URL), when it can be drawn. */
  picture?: (id: NodeId) => string | undefined;
  /** When the page was made (for the footer); the caller's clock. */
  now?: Date;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => String(Math.round(v * 100) / 100);
const cssColor = (c: Color) => colorToHex(c, c.a < 1);

function paintCss(p: Paint | undefined): string {
  if (!p) return 'transparent';
  if (p.type === 'SOLID') return cssColor({ ...p.color, a: p.color.a * p.opacity });
  if (p.type.startsWith('GRADIENT_') && 'stops' in p) {
    const stops = [...p.stops].sort((a, b) => a.position - b.position).map((s) => `${cssColor(s.color)} ${num(s.position * 100)}%`).join(', ');
    return p.type === 'GRADIENT_LINEAR' ? `linear-gradient(90deg, ${stops})` : `radial-gradient(circle, ${stops})`;
  }
  return '#ccc';
}

function valueText(v: VariableLiteral | undefined, t: Token): string {
  if (v === undefined) return tr('ошибка');
  if (isColorValue(v)) return cssColor(v as Color);
  if (typeof v === 'number') return t.dimension ? `${num(v)} px` : num(v);
  return String(v);
}

function swatch(v: VariableLiteral | undefined): string {
  return v !== undefined && isColorValue(v) ? `<span class="sw" style="background:${cssColor(v as Color)}"></span>` : '';
}

const copyButton = (text: string) => `<button class="copy" type="button" data-copy="${esc(text)}" title="${esc(tr('Копировать'))}">${esc(text)}</button>`;

/** The HTML page; `sections` — how many sections have something (0 — the file has no system yet). */
export function buildDsSite(input: SiteInput): { html: string; sections: number } {
  const { doc } = input;
  const name = String(doc.get(doc.rootId, 'name') || tr('Дизайн-система'));
  const model = tokenModel(doc, defaultTokenOptions('css'));
  const styles = [...doc.children(doc.rootId)].filter((s) => isStyle(doc, s));
  const byType = (t: string) => styles.filter((s) => doc.get(s, 'styleType') === t);
  const parts: { id: string; title: string; body: string }[] = [];

  // Colours: colour variables by collection (a column per mode), then fill styles.
  const colorGroups = model.map((g) => ({ g, tokens: g.tokens.filter((t) => t.type === 'COLOR') })).filter((x) => x.tokens.length);
  const fills = byType('FILL');
  if (colorGroups.length || fills.length) {
    let body = '';
    for (const { g, tokens } of colorGroups) {
      const cols = g.columns.map((c) => esc(c.extName ? `${c.extName} · ${c.modeName}` : c.modeName));
      body += `<h3>${esc(g.name)}</h3><table class="tokens"><thead><tr><th>${esc(tr('Имя'))}</th>${cols.map((c) => `<th>${c}</th>`).join('')}<th>CSS</th></tr></thead><tbody>`;
      for (const t of tokens) {
        body += `<tr data-q="${esc(`${doc.get(t.v, 'name')} ${t.name}`.toLowerCase())}"><td>${esc(doc.get(t.v, 'name'))}${doc.get(t.v, 'description') ? `<small>${esc(doc.get(t.v, 'description'))}</small>` : ''}</td>${t.values.map((v) => `<td>${swatch(v.value)}<code>${esc(valueText(v.value, t))}</code></td>`).join('')}<td>${copyButton(`var(--${t.name})`)}</td></tr>`;
      }
      body += '</tbody></table>';
    }
    if (fills.length) {
      body += `<h3>${esc(tr('Стили цвета'))}</h3><div class="cards">`;
      for (const s of fills) {
        const paint = doc.get(s, 'fills').find((p) => p.visible);
        body += `<div class="card" data-q="${esc(String(doc.get(s, 'name')).toLowerCase())}"><div class="chip" style="background:${paintCss(paint)}"></div><b>${esc(doc.get(s, 'name'))}</b><code>${esc(paint && paint.type === 'SOLID' ? cssColor(paint.color) : paint?.type.replace('GRADIENT_', '').toLowerCase() ?? '')}</code></div>`;
      }
      body += '</div>';
    }
    parts.push({ id: 'colors', title: tr('Цвета'), body });
  }

  // Typography: text styles shown in their own font.
  const texts = byType('TEXT');
  if (texts.length) {
    let body = '';
    for (const s of texts) {
      const size = doc.get(s, 'fontSize');
      const lh = doc.get(s, 'lineHeight');
      const ls = doc.get(s, 'letterSpacing');
      const family = String(doc.get(s, 'fontFamily'));
      const line = lh.unit === 'PX' ? `${num(lh.value)}px` : lh.unit === 'PERCENT' ? `${num(lh.value)}%` : 'normal';
      const spacing = ls.unit === 'PX' ? `${num(ls.value)}px` : `${num(ls.value / 100)}em`;
      const css = `font-family: ${cssNoTags(`"${family}"`)}; font-size: ${num(size)}px; font-weight: ${doc.get(s, 'fontWeight')}; line-height: ${line}; letter-spacing: ${spacing};`;
      body += `<div class="type" data-q="${esc(String(doc.get(s, 'name')).toLowerCase())}"><div class="sample" style="${esc(css.replace(/^font-family: ([^;]+);/, 'font-family: $1, system-ui, sans-serif;'))}${doc.get(s, 'italic') ? ' font-style: italic;' : ''}">${esc(tr('Съешь же ещё этих мягких французских булок'))}</div><div class="spec"><b>${esc(doc.get(s, 'name'))}</b><span>${esc(family)} · ${doc.get(s, 'fontWeight')} · ${num(size)}/${esc(line)}</span>${copyButton(css)}</div></div>`;
    }
    parts.push({ id: 'type', title: tr('Типографика'), body });
  }

  // Effects: shadows as CSS on a card; blurs as a note.
  const effects = byType('EFFECT');
  if (effects.length) {
    let body = '<div class="cards">';
    for (const s of effects) {
      const shadows = doc
        .get(s, 'effects')
        .filter((e) => e.visible && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'))
        .map((e) => (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' ? `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${num(e.offset.x)}px ${num(e.offset.y)}px ${num(e.radius)}px ${num(e.spread)}px ${cssColor(e.color)}` : ''))
        .join(', ');
      body += `<div class="card" data-q="${esc(String(doc.get(s, 'name')).toLowerCase())}"><div class="chip lift" style="box-shadow:${esc(shadows || 'none')}"></div><b>${esc(doc.get(s, 'name'))}</b>${shadows ? copyButton(`box-shadow: ${shadows};`) : `<code>${esc(tr('размытие'))}</code>`}</div>`;
    }
    parts.push({ id: 'effects', title: tr('Эффекты'), body: `${body}</div>` });
  }

  // Numbers and strings: spacing and radii drawn as bars.
  const otherGroups = model.map((g) => ({ g, tokens: g.tokens.filter((t) => t.type !== 'COLOR') })).filter((x) => x.tokens.length);
  if (otherGroups.length) {
    let body = '';
    for (const { g, tokens } of otherGroups) {
      body += `<h3>${esc(g.name)}</h3><table class="tokens"><thead><tr><th>${esc(tr('Имя'))}</th>${g.columns.map((c) => `<th>${esc(c.modeName)}</th>`).join('')}<th>CSS</th></tr></thead><tbody>`;
      for (const t of tokens) {
        const first = t.values[0]?.value;
        const bar = t.dimension && typeof first === 'number' ? `<span class="bar" style="width:${Math.min(240, Math.max(1, first))}px"></span>` : '';
        body += `<tr data-q="${esc(`${doc.get(t.v, 'name')} ${t.name}`.toLowerCase())}"><td>${esc(doc.get(t.v, 'name'))}</td>${t.values.map((v) => `<td><code>${esc(valueText(v.value, t))}</code></td>`).join('')}<td>${bar}${copyButton(`var(--${t.name})`)}</td></tr>`;
      }
      body += '</tbody></table>';
    }
    parts.push({ id: 'numbers', title: tr('Размеры и значения'), body });
  }

  // Components: picture, description, variants, properties.
  const units = ownUnits(doc);
  if (units.length) {
    let body = '';
    for (const u of units) {
      const set = doc.type(u) === 'COMPONENT_SET';
      const variants = set ? doc.children(u).filter((c) => doc.type(c) === 'COMPONENT') : [];
      const axes = new Map<string, Set<string>>();
      for (const v of variants) {
        for (const pair of String(doc.get(v, 'name')).split(',')) {
          const [k, val] = pair.split('=').map((x) => x.trim());
          if (k && val) axes.set(k, (axes.get(k) ?? new Set()).add(val));
        }
      }
      const props = doc.get(u, 'componentProps') ?? [];
      const pic = input.picture?.(u);
      const description = String(doc.get(u, 'description') ?? '').trim();
      body += `<article class="comp" data-q="${esc(String(doc.get(u, 'name')).toLowerCase())}"><div class="pic">${pic ? `<img src="${pic}" alt="${esc(doc.get(u, 'name'))}">` : ''}</div><div><h3>${esc(doc.get(u, 'name'))}</h3>${description ? `<p>${esc(description)}</p>` : `<p class="muted">${esc(tr('Без описания'))}</p>`}`;
      if (axes.size) body += `<dl>${[...axes].map(([k, vals]) => `<dt>${esc(k)}</dt><dd>${[...vals].map((x) => `<span class="pill">${esc(x)}</span>`).join('')}</dd>`).join('')}</dl>`;
      if (props.length) {
        const kind: Record<string, string> = { TEXT: tr('текст'), BOOLEAN: tr('да/нет'), INSTANCE_SWAP: tr('замена') };
        body += `<table class="props"><tbody>${props.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(kind[p.type] ?? p.type)}</td><td class="muted">${esc(p.description ?? '')}</td></tr>`).join('')}</tbody></table>`;
      }
      body += '</div></article>';
    }
    parts.push({ id: 'components', title: tr('Компоненты'), body });
  }

  const tokens = tokensToCode(doc, defaultTokenOptions('css'));
  if (tokens.count) parts.push({ id: 'code', title: tr('Код токенов'), body: `<p class="muted">tokens.css · ${tokens.count}</p><div class="code">${copyButton(tr('Копировать всё'))}<pre>${esc(tokens.text)}</pre></div>`.replace(`data-copy="${esc(tr('Копировать всё'))}"`, `data-copy="${esc(tokens.text)}"`) });

  // The file's own fonts, for the families the text styles use: the samples look as in the file.
  const families = new Set(texts.map((t) => String(doc.get(t, 'fontFamily'))));
  const faces = ((doc.get(doc.rootId, 'embeddedFonts') ?? []) as { family: string; weight: number; italic: boolean; hash: string }[])
    .filter((f) => families.has(f.family))
    .flatMap((f) => {
      const blob = doc.store.blobs.get(f.hash);
      return blob ? [`@font-face{font-family:${cssNoTags(JSON.stringify(f.family))};font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};src:url(data:${blob.mime};base64,${blob.data})}`] : [];
    })
    .join('');
  const sections = parts.length;
  const made = (input.now ?? new Date()).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const nav = parts.map((p) => `<a href="#${p.id}">${esc(p.title)}</a>`).join('');
  const main = sections
    ? parts.map((p) => `<section id="${p.id}"><h2>${esc(p.title)}</h2>${p.body}</section>`).join('')
    : `<section><p class="muted">${esc(tr('В файле пока нет переменных, стилей и компонентов.'))}</p></section>`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)}</title><style>${faces}${CSS}</style></head><body><header><b>${esc(name)}</b><input type="search" placeholder="${esc(tr('Найти'))}" aria-label="${esc(tr('Найти'))}"></header><nav>${nav}</nav><main>${main}<footer>${esc(tr('Собрано из файла {0}', made))}</footer></main><script>${SCRIPT}</script></body></html>`;
  return { html, sections };
}

const CSS = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--soft:#f5f5f7;--accent:#4f5bd5;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f2f2f4;--muted:#9a9aa0;--line:#2c2c30;--soft:#202024;--accent:#8b93f0}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);display:grid;grid-template-columns:200px 1fr;grid-template-rows:auto 1fr;min-height:100vh}
header{grid-column:1/-1;display:flex;gap:16px;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:1}
header input{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--soft);color:var(--fg);width:min(260px,50vw)}
nav{padding:20px 16px;border-right:1px solid var(--line);position:sticky;top:57px;align-self:start;display:flex;flex-direction:column;gap:4px}
nav a{color:var(--fg);text-decoration:none;padding:6px 10px;border-radius:6px}nav a:hover{background:var(--soft)}
main{padding:24px 32px 64px;min-width:0}section{margin-bottom:48px}h2{font-size:22px;margin:0 0 16px}h3{font-size:15px;margin:24px 0 8px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:middle}th{color:var(--muted);font-weight:500}
td small{display:block;color:var(--muted)}code{font:13px ui-monospace,Menlo,monospace}
.sw{display:inline-block;width:18px;height:18px;border-radius:5px;border:1px solid var(--line);vertical-align:middle;margin-right:8px}
.copy{font:12px ui-monospace,Menlo,monospace;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:6px;padding:3px 7px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copy.done{border-color:var(--accent);color:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}.card{display:flex;flex-direction:column;gap:6px}
.chip{height:72px;border-radius:10px;border:1px solid var(--line)}.chip.lift{background:var(--bg);margin:12px}
.type{padding:14px 0;border-bottom:1px solid var(--line)}.sample{margin-bottom:6px;overflow-wrap:anywhere}.spec{display:flex;gap:12px;align-items:center;flex-wrap:wrap;color:var(--muted)}.spec b{color:var(--fg)}
.bar{display:inline-block;height:10px;background:var(--accent);border-radius:3px;margin-right:10px;vertical-align:middle;opacity:.6}
.comp{display:grid;grid-template-columns:minmax(0,240px) 1fr;gap:24px;padding:20px 0;border-bottom:1px solid var(--line)}
.pic{background:var(--soft);border-radius:12px;min-height:120px;display:flex;align-items:center;justify-content:center;padding:16px}.pic img{max-width:100%;max-height:200px}
.comp h3{margin-top:0}dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:12px 0}dt{color:var(--muted)}dd{margin:0;display:flex;flex-wrap:wrap;gap:6px}
.pill{border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:13px}.muted{color:var(--muted)}
.code{position:relative}.code .copy{position:absolute;right:8px;top:8px}pre{background:var(--soft);border-radius:10px;padding:16px;overflow:auto;font:13px/1.5 ui-monospace,Menlo,monospace;max-height:480px}
footer{color:var(--muted);font-size:13px}.hidden{display:none}
@media (max-width:720px){body{grid-template-columns:1fr}nav{position:static;flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line);padding:8px 16px}main{padding:16px}.comp{grid-template-columns:1fr}table{display:block;overflow-x:auto}}
`;

const SCRIPT = `
document.addEventListener('click',function(e){var b=e.target.closest('.copy');if(!b)return;var t=b.getAttribute('data-copy');
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).catch(function(){var a=document.createElement('textarea');a.value=t;document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(_){}a.remove()});
b.classList.add('done');setTimeout(function(){b.classList.remove('done')},900)});
document.querySelector('header input').addEventListener('input',function(e){var q=e.target.value.trim().toLowerCase();
document.querySelectorAll('[data-q]').forEach(function(n){n.classList.toggle('hidden',!!q&&n.getAttribute('data-q').indexOf(q)<0)})});
`;
