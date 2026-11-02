// Вычисление размеров узла (с переносом длинных подписей)
function getUiFontFamily() {
    try {
        const d = getComputedStyle(document.documentElement).getPropertyValue('--diagram-font').trim();
        if (d) return d;
        const v = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim();
        if (v) return v;
    } catch (_) { /* ignore */ }
    return 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
}

/** Шрифт для экспорта SVG→PNG/PDF — тот же стек, что у диаграммы */
function getResolvedUiFontFamily() {
    return getUiFontFamily();
}

function computeSizes(node) {
    const isRoot = node.level === 0;
    const fontSize = isRoot ? 19 : 17;
    const maxTextW = isRoot ? 220 : 180;
    const padX = isRoot ? 42 : 32;
    const lineH = isRoot ? 24 : 21;
    const padY = isRoot ? 24 : 16;
    const fontFamily = (typeof getUiFontFamily === 'function') ? getUiFontFamily() : 'system-ui, sans-serif';

    const lines = wrapTextLines(node.text, maxTextW, fontSize, fontFamily);
    node.lines = lines;

    let measure;
    if (typeof document !== 'undefined') {
        const canvas = computeSizes._canvas || (computeSizes._canvas = document.createElement('canvas'));
        const ctx = canvas.getContext('2d');
        ctx.font = `${isRoot ? 700 : 600} ${fontSize}px ${fontFamily}`;
        measure = (s) => ctx.measureText(s).width;
    } else {
        measure = (s) => String(s).length * fontSize * 0.55;
    }
    const textW = Math.max(...lines.map(measure), 20);
    let extraH = 0;
    if (node.assignee || node.initials || node.deadlineLabel) extraH = isRoot ? 18 : 16;
    node.width = Math.ceil(Math.min(maxTextW + padX, Math.max(isRoot ? 90 : 70, textW + padX)));
    node.height = Math.ceil(lines.length * lineH + padY + extraH);
    // Шильдики @/!: аватар ~r ниже низа, chip ~h/2 — подпись ниже них
    const metaClearance = (node.assignee || node.initials || node.deadlineLabel) ? 22 : 0;
    if (node.note) {
        const noteFs = 11;
        const noteLh = 13;
        const noteMaxW = Math.max(80, node.width + 24);
        node.noteLines = typeof wrapTextLines === 'function'
            ? wrapTextLines(String(node.note), noteMaxW, noteFs, fontFamily).slice(0, 3)
            : [String(node.note)];
        node.noteGap = metaClearance + 6;
        // +6: подложка подписи (padY) и небольшой зазор до следующего блока
        node.noteHeight = node.noteGap + node.noteLines.length * noteLh + 6;
    } else {
        node.noteLines = null;
        node.noteGap = 0;
        node.noteHeight = 0;
    }
    // Высота для раскладки: прямоугольник + зона подписи (и зазор под шильдики)
    node.layoutHeight = node.height + (node.noteHeight || 0);
    for (const child of node.children) computeSizes(child);
}

/** Доп. высота подписи // под блоком (для bounds / коллизий / рёбер). */
function diagramNodeNoteExtra(node) {
    if (!node) return 0;
    if (typeof node.noteHeight === 'number' && node.noteHeight > 0) return node.noteHeight;
    if (!node.note) return 0;
    const lines = node.noteLines;
    const n = (lines && lines.length) ? lines.length : 1;
    const gap = (typeof node.noteGap === 'number') ? node.noteGap : 8;
    return gap + n * 13 + 6;
}

/** Высота узла в раскладке: блок + подпись. */
function diagramNodeLayoutHeight(node) {
    if (!node) return 0;
    if (typeof node.layoutHeight === 'number' && node.layoutHeight > 0) return node.layoutHeight;
    return (node.height || 0) + diagramNodeNoteExtra(node);
}

/**
 * Radial / Classic: node.x/y — центр слота layoutHeight.
 * Верх визуального прямоугольника (подпись занимает низ слота).
 */
function diagramNodeCenteredBoxTop(node) {
    if (!node) return 0;
    return node.y - diagramNodeLayoutHeight(node) / 2;
}

/** Центр визуального блока (без зоны //). */
function diagramNodeCenteredVisualCY(node) {
    if (!node) return 0;
    return diagramNodeCenteredBoxTop(node) + (node.height || 0) / 2;
}

/** Y низа «занятой» зоны узла (блок + подпись), top-left система. */
function diagramNodeBottomY(node) {
    if (!node) return 0;
    return node.y + diagramNodeLayoutHeight(node);
}

/** Y старта подписи (под блоком и шильдиками). boxBottom — низ прямоугольника. */
function diagramNodeNoteTopY(boxBottom, node) {
    const gap = (node && typeof node.noteGap === 'number' && node.noteGap > 0)
        ? node.noteGap
        : ((node && (node.assignee || node.initials || node.deadlineLabel)) ? 28 : 8);
    return boxBottom + gap;
}

/**
 * Нормализация CSS-цвета в #rrggbb для SVG/mixHex.
 * Soft UI задаёт --panel-bg как rgba(...); старый mixHex ломался → #NaN… → чёрные блоки.
 */
function cssColorToHex(input, fallback) {
    const fb = (typeof fallback === 'string' && /^#[0-9a-fA-F]{6}$/.test(fallback))
        ? fallback
        : '#ffffff';
    if (input == null) return fb;
    let s = String(input).trim();
    if (!s) return fb;
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
    if (/^#[0-9a-fA-F]{8}$/.test(s)) return s.slice(0, 7).toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
        const r = s[1], g = s[2], b = s[3];
        return ('#' + r + r + g + g + b + b).toLowerCase();
    }
    let m = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*[0-9.]+\s*)?\)$/i);
    if (m) {
        const clamp = (n) => Math.max(0, Math.min(255, Math.round(Number(n))));
        const hex = (n) => clamp(n).toString(16).padStart(2, '0');
        return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
    }
    // color-mix / oklch / var(): через canvas (браузер)
    try {
        if (typeof document !== 'undefined') {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.fillStyle = '#000000';
                ctx.fillStyle = s;
                const got = String(ctx.fillStyle || '');
                m = got.match(/^#([0-9a-fA-F]{6})$/);
                if (m) return '#' + m[1].toLowerCase();
                m = got.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
                if (m) {
                    const hex = (n) => Number(n).toString(16).padStart(2, '0');
                    return '#' + hex(m[1]) + hex(m[2]) + hex(m[3]);
                }
            }
        }
    } catch (_) { /* ignore */ }
    return fb;
}

// Relative luminance by WCAG (0 — black, 1 — white).
function relativeLuminance(hex) {
    const h = cssColorToHex(hex, '#888888');
    const ch = (i) => {
        const v = parseInt(h.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
}

// WCAG contrast of two colours (1…21).
function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Text on a fill: white while it reads (3:1, the labels are bold and short — saturated chips keep
// white), else dark (Simmetrika: the old brightness threshold put white on pastel fills of the soft palette).
function getContrastColor(hex) {
    return contrastRatio(hex, '#ffffff') >= 3 ? '#ffffff' : '#222222';
}

// A coloured text on a background: the colour, darkened (lightened on dark) until it reads (4.5:1).
function readableTextColor(hex, bg) {
    const back = cssColorToHex(bg, '#ffffff');
    const toward = relativeLuminance(back) > 0.4 ? '#000000' : '#ffffff';
    let c = cssColorToHex(hex, '#888888');
    for (let t = 0.1; contrastRatio(c, back) < 4.5 && t <= 1; t += 0.1) c = mixHex(hex, toward, t);
    return c;
}

/** CSS-переменная с body (тёмная тема задаётся на body.dark, не на :root) */
function readCssColor(varName, fallback) {
    try {
        const el = document.body || document.documentElement;
        const v = getComputedStyle(el).getPropertyValue(varName).trim();
        const raw = v || fallback || '#ffffff';
        return cssColorToHex(raw, fallback || '#ffffff');
    } catch (_) {
        return cssColorToHex(fallback, '#ffffff');
    }
}

// Смешивание двух hex-цветов (t = 0..1 к other); принимает rgba/color-mix через cssColorToHex
function mixHex(hex, other, t) {
    const aHex = cssColorToHex(hex, '#888888');
    const bHex = cssColorToHex(other, '#ffffff');
    const parse = (h) => [
        parseInt(h.slice(1, 3), 16),
        parseInt(h.slice(3, 5), 16),
        parseInt(h.slice(5, 7), 16)
    ];
    const a = parse(aHex);
    const b = parse(bHex);
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

// Стили узла со статусом «готово»
function getDoneNodeStyle(baseColor) {
    return {
        fill: mixHex(baseColor, '#ecfdf5', 0.78),
        stroke: '#15803d',
        strokeWidth: 2.75,
        text: '#14532d',
        checkBg: '#16a34a',
        checkFg: '#ffffff'
    };
}

/** Круглая галочка на углу блока (выполненная задача) */
function appendDoneCheckmark(svgNS, parent, cx, cy, r) {
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', r);
    circle.setAttribute('fill', '#16a34a');
    circle.setAttribute('stroke', '#ffffff');
    circle.setAttribute('stroke-width', '2');
    parent.appendChild(circle);

    const s = r / 8;
    const check = document.createElementNS(svgNS, 'path');
    check.setAttribute('d', `M ${cx - 4 * s} ${cy + 0.2 * s} L ${cx - 1.1 * s} ${cy + 3.4 * s} L ${cx + 4.6 * s} ${cy - 3.2 * s}`);
    check.setAttribute('fill', 'none');
    check.setAttribute('stroke', '#ffffff');
    check.setAttribute('stroke-width', String(Math.max(1.8, r * 0.3)));
    check.setAttribute('stroke-linecap', 'round');
    check.setAttribute('stroke-linejoin', 'round');
    parent.appendChild(check);
}

/**
 * Границы диаграммы.
 * @param {{ centered?: boolean }} options — для radial x/y это центр узла
 */
function getBounds(root, padding = 80, options = {}) {
    const centered = !!(options && options.centered);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function noteExtra(node) {
        return typeof diagramNodeNoteExtra === 'function'
            ? diagramNodeNoteExtra(node)
            : 0;
    }
    function traverse(node) {
        const layoutH = typeof diagramNodeLayoutHeight === 'function'
            ? diagramNodeLayoutHeight(node)
            : ((node.height || 0) + noteExtra(node));
        if (centered) {
            minX = Math.min(minX, node.x - node.width / 2);
            maxX = Math.max(maxX, node.x + node.width / 2);
            minY = Math.min(minY, node.y - layoutH / 2);
            maxY = Math.max(maxY, node.y + layoutH / 2);
        } else {
            minX = Math.min(minX, node.x);
            maxX = Math.max(maxX, node.x + node.width);
            minY = Math.min(minY, node.y);
            maxY = Math.max(maxY, node.y + layoutH);
        }
        for (const child of node.children) traverse(child);
    }
    traverse(root);
    return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
}

/** Высота блока многострочного SVG-текста (tspan сверху вниз). Возвращает высоту в px. */
function appendSvgTextBlock(svgNS, parent, opts) {
    const {
        x, y, lines, fill, fontSize = 11, fontWeight = '600',
        lineHeight, textAnchor = 'start',
        dataLabel = null
    } = opts;
    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    const rows = (lines && lines.length) ? lines : [''];
    const fs = typeof fontSize === 'number' ? fontSize : parseFloat(fontSize) || 11;
    const lh = lineHeight || fs * 1.28;
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('fill', fill);
    text.setAttribute('font-family', fontFam);
    text.setAttribute('font-size', fs + 'px');
    text.setAttribute('font-weight', fontWeight);
    text.setAttribute('text-anchor', textAnchor);
    if (dataLabel != null && String(dataLabel)) {
        text.setAttribute('data-label', String(dataLabel));
    }
    rows.forEach((line, i) => {
        const tspan = document.createElementNS(svgNS, 'tspan');
        tspan.setAttribute('x', String(x));
        tspan.setAttribute('y', String(y + i * lh));
        tspan.textContent = line;
        text.appendChild(tspan);
    });
    parent.appendChild(text);
    return rows.length * lh;
}

/** Многострочный SVG text из node.lines / wrapTextLines */
function appendWrappedSvgText(svgNS, parent, opts) {
    const {
        x, y, lines, fill, fontSize, fontWeight = '600',
        textAnchor = 'middle', dominantBaseline = 'central', lineHeight,
        underline = false,
        dataLabel = null,
        dataNodeId = null,
        dataSourceLine = null,
        href = null
    } = opts;
    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    const rows = (lines && lines.length) ? lines : [''];
    const lh = lineHeight || (parseFloat(fontSize) * 1.2 || 16);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', y);
    text.setAttribute('fill', fill);
    text.setAttribute('font-family', fontFam);
    text.setAttribute('text-anchor', textAnchor);
    text.setAttribute('font-size', typeof fontSize === 'number' ? fontSize + 'px' : fontSize);
    text.setAttribute('font-weight', fontWeight);
    const stableLabel = dataLabel != null
        ? String(dataLabel)
        : rows.filter(Boolean).join(' ').trim();
    if (stableLabel) text.setAttribute('data-label', stableLabel);
    if (dataNodeId) text.setAttribute('data-node-id', String(dataNodeId));
    if (dataSourceLine != null && dataSourceLine !== '') {
        if (typeof setDiagramSourceLine === 'function') setDiagramSourceLine(text, dataSourceLine);
        else text.setAttribute('data-source-line', String(dataSourceLine));
    }
    if (href) text.setAttribute('data-pdf-href', String(href));
    if (underline) {
        text.setAttribute('text-decoration', 'underline');
        text.style.textDecoration = 'underline';
    }
    if (rows.length === 1) {
        text.setAttribute('dominant-baseline', dominantBaseline);
        text.textContent = rows[0];
    } else {
        const startY = y - ((rows.length - 1) * lh) / 2;
        rows.forEach((line, i) => {
            const tspan = document.createElementNS(svgNS, 'tspan');
            tspan.setAttribute('x', x);
            tspan.setAttribute('y', startY + i * lh);
            tspan.setAttribute('dominant-baseline', 'middle');
            tspan.textContent = line;
            text.appendChild(tspan);
        });
    }
    parent.appendChild(text);
    return text;
}

/**
 * Markdown-ссылка в подписи узла: [текст](https://…) или mailto:.
 * В превью остаётся только текст; URL — для PDF-аннотаций.
 * Не путать с маркером [готово] (без скобок URL).
 */
function parseMindmapNodeLink(str) {
    let text = String(str == null ? '' : str);
    let href = null;
    const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/gi;
    text = text.replace(re, (_, label, url) => {
        if (!href) href = String(url || '').trim();
        return label;
    });
    return { text: text.replace(/\s+/g, ' ').trim(), href };
}

// Сдвиг поддерева по вертикали
function shiftSubtreeY(node, delta) {
    node.y += delta;
    for (const child of node.children) shiftSubtreeY(child, delta);
}

// Сдвиг поддерева по горизонтали
function shiftSubtreeX(node, delta) {
    node.x += delta;
    for (const child of node.children) shiftSubtreeX(child, delta);
}

/** Разбить текст на строки по ширине (px). Не меняет исходные слова без необходимости. */
function wrapTextLines(text, maxWidth, fontSize = 11, fontFamily) {
    fontFamily = fontFamily || ((typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif');
    const raw = String(text ?? '').trim();
    if (!raw) return [''];

    let measure;
    if (typeof document !== 'undefined') {
        const canvas = wrapTextLines._canvas || (wrapTextLines._canvas = document.createElement('canvas'));
        const ctx = canvas.getContext('2d');
        ctx.font = `${fontSize}px ${fontFamily}`;
        measure = (s) => ctx.measureText(s).width;
    } else {
        const approx = fontSize * 0.55;
        measure = (s) => String(s).length * approx;
    }

    // A word wider than the line is hyphenated (Simmetrika: it was cut anywhere, «Распараллеливан / ие»):
    // between syllables near the end of what fits, never before ь ъ й, never leaving under 3 letters.
    const VOWEL = /[аеёиоуыэюяaeiouy]/i;
    const breakWord = (word) => {
        if (measure(word) <= maxWidth) return [word];
        const parts = [];
        let rest = word;
        while (rest.length > 4 && measure(rest) > maxWidth) {
            let k = 1;
            while (k < rest.length && measure(rest.slice(0, k + 1) + '-') <= maxWidth) k++;
            k = Math.min(k, rest.length - 3);
            if (k < 2) break;
            let cut = k;
            const v = (i) => VOWEL.test(rest[i] || '');
            for (let j = k; j >= Math.max(2, k - 5); j--) {
                if (/[ьъй]/i.test(rest[j]) || rest.length - j < 3 || !/[аеёиоуыэюяaeiouy]/i.test(rest.slice(0, j))) continue;
                // Syllables: «ли-вание», «мес-сенджеры», «ре-ак-ция».
                if ((v(j - 1) && !v(j) && v(j + 1)) || (!v(j - 1) && !v(j) && v(j - 2)) || (v(j - 1) && v(j))) {
                    cut = j;
                    break;
                }
            }
            parts.push(rest.slice(0, cut) + '-');
            rest = rest.slice(cut);
        }
        parts.push(rest);
        return parts;
    };

    const words = raw.split(/\s+/).flatMap(breakWord);
    const lines = [];
    let line = '';
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        // After a hyphenated part the word goes on below.
        if (line && (measure(test) > maxWidth || line.endsWith('-'))) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/* ========== Диагностики диаграмм (глобальные function — как остальной utils) ========== */
function diag(severity, message, opts) {
    opts = opts || {};
    const out = {
        severity: severity === 'error' ? 'error' : (severity === 'info' ? 'info' : 'warning'),
        message: String(message || ''),
        line: Number.isFinite(opts.line) ? opts.line : null,
        code: opts.code || null,
        hint: opts.hint || null
    };
    if (opts.fix) out.fix = opts.fix;
    return out;
}

function mergeDiagnostics() {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < arguments.length; i++) {
        const list = arguments[i];
        if (!list) continue;
        const arr = Array.isArray(list) ? list : (list.diagnostics || []);
        arr.forEach(function (d) {
            if (!d) return;
            const key = [
                d.severity || '',
                d.code || '',
                d.line != null ? String(d.line) : '',
                d.message || ''
            ].join('\0');
            if (seen.has(key)) return;
            seen.add(key);
            out.push(d);
        });
    }
    return out;
}

function attachDiagnostics(result, diagnostics) {
    const list = diagnostics || [];
    if (!result) {
        return { diagnostics: list.slice(), __empty: true };
    }
    const prev = Array.isArray(result.diagnostics) ? result.diagnostics : [];
    result.diagnostics = prev.concat(list);
    return result;
}

/** Критические ошибки целостности — не монтировать «успешный» SVG. */
function diagnosticsBlockRender(diagnostics) {
    const list = diagnostics || [];
    // Коды должны совпадать с тем, что реально шлют парсеры (не алиасы).
    const blockingCodes = {
        wave_balance: 1,
        sankey_balance: 1,
        pulsewave_length_mismatch: 1,
        fan_length_mismatch: 1,
        orphan_from: 1,
        orphan_to: 1,
        duplicate_element: 1,
        cycle: 1,
        self_loop: 1,
        gantt_cycle: 1,
        treemap_empty: 1
    };
    return list.some(function (d) {
        if (!d || d.severity !== 'error') return false;
        const code = String(d.code || d.id || '');
        return !!blockingCodes[code];
    });
}

try {
    window.attachDiagnostics = attachDiagnostics;
    window.diagnosticsBlockRender = diagnosticsBlockRender;
} catch (_) { /* ignore */ }

function analyzeDirectedGraph(nodeNames, edges, opts) {
    opts = opts || {};
    const diagnostics = [];
    const nodes = new Set((nodeNames || []).filter(Boolean));
    const edgeList = Array.isArray(edges) ? edges : [];
    const allowMissingNodes = !!opts.allowMissingNodes;

    edgeList.forEach(function (e) {
        const from = e.from || e.source;
        const to = e.to || e.target;
        if (!from || !to) return;
        if (from === to) {
            diagnostics.push(diag('warning', 'Петля: «' + from + '» → «' + to + '»', {
                code: 'self_loop',
                line: e.line || null
            }));
        }
        if (!allowMissingNodes && !nodes.has(from)) {
            diagnostics.push(diag('error', 'Неизвестный источник связи: «' + from + '»', {
                code: 'orphan_from',
                line: e.line || null,
                hint: 'Проверьте имя элемента/задачи'
            }));
        }
        if (!allowMissingNodes && !nodes.has(to)) {
            diagnostics.push(diag('error', 'Неизвестная цель связи: «' + to + '»', {
                code: 'orphan_to',
                line: e.line || null,
                hint: 'Проверьте имя элемента/задачи'
            }));
        }
    });

    const seen = new Map();
    (nodeNames || []).forEach(function (name) {
        if (!name) return;
        seen.set(name, (seen.get(name) || 0) + 1);
    });
    seen.forEach(function (count, name) {
        if (count > 1) {
            diagnostics.push(diag('error', 'Дублируется имя «' + name + '» (' + count + ')', {
                code: 'duplicate_node',
                hint: 'Имена должны быть уникальны'
            }));
        }
    });

    const adj = new Map();
    nodes.forEach(function (n) { adj.set(n, []); });
    edgeList.forEach(function (e) {
        const from = e.from || e.source;
        const to = e.to || e.target;
        if (!from || !to || !adj.has(from)) return;
        adj.get(from).push(to);
    });

    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    nodes.forEach(function (n) { color.set(n, WHITE); });
    const cycles = [];

    function dfs(u, stack) {
        color.set(u, GRAY);
        stack.push(u);
        (adj.get(u) || []).forEach(function (v) {
            if (!color.has(v)) return;
            if (color.get(v) === GRAY) {
                const idx = stack.indexOf(v);
                cycles.push(stack.slice(idx).concat(v));
            } else if (color.get(v) === WHITE) {
                dfs(v, stack);
            }
        });
        stack.pop();
        color.set(u, BLACK);
    }

    nodes.forEach(function (n) {
        if (color.get(n) === WHITE) dfs(n, []);
    });

    if (cycles.length) {
        diagnostics.push(diag('error', 'Обнаружен цикл зависимостей: ' + cycles[0].join(' → '), {
            code: 'cycle',
            hint: cycles.length > 1 ? ('Ещё циклов: ' + (cycles.length - 1)) : 'Уберите циклические ссылки'
        }));
    }

    return { diagnostics: diagnostics, cycles: cycles, hasCycle: cycles.length > 0 };
}

function renderDiagnosticsPanel(diagnostics) {
    function severityRank(s) {
        if (s === 'error') return 0;
        if (s === 'warning') return 1;
        return 2;
    }
    const list = (diagnostics || []).slice().sort(function (a, b) {
        return severityRank(a.severity) - severityRank(b.severity);
    });
    if (!list.length) return null;

    const panel = document.createElement('div');
    panel.className = 'diagram-diagnostics';
    panel.setAttribute('role', 'status');
    if (list.length > 3) panel.classList.add('is-collapsed');

    const head = document.createElement('div');
    head.className = 'diagram-diagnostics-head';
    const errors = list.filter(function (d) { return d.severity === 'error'; }).length;
    const warnings = list.filter(function (d) { return d.severity === 'warning'; }).length;
    const infos = list.filter(function (d) { return d.severity === 'info'; }).length;
    const fixable = list.filter(function (d) { return d.fix && d.fix.newLine != null && d.line != null; });
    if (errors) {
        head.textContent = 'Проблемы: ' + errors + ' ошиб. / ' + warnings + ' предупр.';
    } else if (warnings) {
        head.textContent = 'Предупреждения: ' + warnings + (infos ? (' · подсказки: ' + infos) : '');
    } else {
        head.textContent = 'Подсказки по синтаксису: ' + infos;
    }
    head.title = 'Свернуть / развернуть';
    head.style.cursor = 'pointer';
    head.addEventListener('click', function (ev) {
        if (ev.target.closest('button')) return;
        panel.classList.toggle('is-collapsed');
    });
    if (fixable.length > 1) {
        const fixAll = document.createElement('button');
        fixAll.type = 'button';
        fixAll.className = 'diagram-diagnostics-fix-all';
        fixAll.textContent = 'Исправить все';
        fixAll.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            if (typeof window.applyDiagramSyntaxFixes === 'function') {
                window.applyDiagramSyntaxFixes(fixable);
            }
        });
        head.appendChild(fixAll);
    }
    panel.appendChild(head);

    const ul = document.createElement('ul');
    ul.className = 'diagram-diagnostics-list';
    list.slice(0, 12).forEach(function (d) {
        const li = document.createElement('li');
        li.className = 'diagram-diagnostics-item is-' + d.severity;
        const row = document.createElement('div');
        row.className = 'diagram-diagnostics-row';
        const msg = document.createElement('span');
        msg.className = 'diagram-diagnostics-msg';
        msg.textContent = d.line != null ? ('стр. ' + d.line + ': ' + d.message) : d.message;
        if (d.line != null) {
            msg.title = 'Перейти к строке ' + d.line;
            msg.style.cursor = 'pointer';
            const goLine = function (ev) {
                if (ev) { ev.preventDefault(); ev.stopPropagation(); }
                const ta = document.getElementById('textInput');
                if (!ta || typeof diagramLineRange !== 'function') {
                    // fallback without helper
                    const val = String(ta && ta.value || '');
                    const lines = val.split('\n');
                    const idx = d.line - 1;
                    if (!ta || idx < 0 || idx >= lines.length) return;
                    let start = 0;
                    for (let i = 0; i < idx; i++) start += lines[i].length + 1;
                    const end = start + lines[idx].length;
                    try { ta.focus(); } catch (_) { /* ignore */ }
                    try { ta.setSelectionRange(start, end); } catch (_) { /* ignore */ }
                    try { ta.scrollTop = Math.max(0, (ta.scrollHeight / lines.length) * idx - 40); } catch (_) { /* ignore */ }
                    return;
                }
                const range = diagramLineRange(ta, d.line);
                if (!range) return;
                try { ta.focus(); } catch (_) { /* ignore */ }
                try { ta.setSelectionRange(range.start, range.end); } catch (_) { /* ignore */ }
                try {
                    const lines = String(ta.value || '').split('\n');
                    ta.scrollTop = Math.max(0, (ta.scrollHeight / Math.max(1, lines.length)) * (d.line - 1) - 40);
                } catch (_) { /* ignore */ }
            };
            msg.addEventListener('click', goLine);
            row.addEventListener('dblclick', goLine);
        }
        row.appendChild(msg);
        if (d.fix && d.fix.newLine != null && d.line != null) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'diagram-diagnostics-fix';
            btn.textContent = d.fix.label || 'Исправить';
            btn.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                if (typeof window.applyDiagramSyntaxFix === 'function') {
                    window.applyDiagramSyntaxFix(d);
                }
            });
            row.appendChild(btn);
        }
        li.appendChild(row);
        if (d.hint) {
            const hint = document.createElement('span');
            hint.className = 'diagram-diagnostics-hint';
            hint.textContent = d.hint;
            li.appendChild(hint);
        }
        ul.appendChild(li);
    });
    if (list.length > 12) {
        const more = document.createElement('li');
        more.className = 'diagram-diagnostics-item is-info';
        more.textContent = '…и ещё ' + (list.length - 12);
        ul.appendChild(more);
    }
    panel.appendChild(ul);
    return panel;
}

/**
 * Мягкие подсказки: устаревшие ключи/аббревиатуры → современный русский DSL.
 * Не ломает разбор (старые формы работают), только предлагает «Исправить».
 */
function collectDiagramStyleHints(text, mode) {
    const out = [];
    const lines = String(text || '').split('\n');
    const m = String(mode || '');

    function pushFix(lineNo, message, hint, newLine, code) {
        out.push(diag('info', message, {
            line: lineNo,
            code: code || 'style_hint',
            hint: hint,
            fix: { label: 'Исправить', newLine: newLine }
        }));
    }

    function modernizeDepValue(val) {
        const raw = String(val || '').trim();
        if (!raw) return null;
        // Уже по-русски в скобках — не трогаем
        if (/\(.*начало|окончание|через|за\s+\d|одновремен/i.test(raw)) return null;
        const parts = [];
        let buf = '';
        let depth = 0;
        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];
            if (ch === '(') depth++;
            if (ch === ')') depth = Math.max(0, depth - 1);
            if ((ch === ',' || ch === ';') && depth === 0) {
                if (buf.trim()) parts.push(buf.trim());
                buf = '';
                continue;
            }
            buf += ch;
        }
        if (buf.trim()) parts.push(buf.trim());
        let changed = false;
        const next = parts.map(function (p) {
            const glued = p.match(/^(.*?)(?:\s+)?(FS|SS|FF|SF)(?:\s*([+\−\-]\s*\d+(?:\.\d+)?)\s*([днм])?)?\s*$/i);
            if (!glued || !glued[2]) return p;
            const name = (glued[1] || '').trim();
            if (!name) return p;
            const type = glued[2].toUpperCase();
            let lag = '';
            if (glued[3]) {
                const sign = glued[3].replace(/\s/g, '').replace('−', '-').startsWith('-') ? -1 : 1;
                let d = parseFloat(String(glued[3]).replace(/[+\−\-]/g, '').trim());
                const u = (glued[4] || 'д').toLowerCase();
                if (u === 'н') d *= 7;
                if (u === 'м') d *= 30;
                const n = Math.round(Math.abs(d));
                const unit = n === 1 ? 'день' : (n < 5 ? 'дня' : 'дней');
                lag = sign < 0
                    ? (', за ' + n + ' ' + unit + ' до окончания')
                    : (', через ' + n + ' ' + (n === 1 ? 'день' : (n < 5 ? 'дня' : 'дней')));
            }
            const typeRu = type === 'SS' ? 'начало-начало'
                : type === 'FF' ? 'окончание-окончание'
                : type === 'SF' ? 'начало-окончание'
                : 'окончание-начало';
            // FS без лага и без явного типа — достаточно «после: Имя»; с лагом/типом — скобки
            if (type === 'FS' && !lag) {
                changed = true;
                return name;
            }
            changed = true;
            const inside = type === 'FS' && lag
                ? lag.replace(/^,\s*/, '')
                : (typeRu + lag);
            return name + ' (' + inside + ')';
        });
        return changed ? next.join(', ') : null;
    }

    lines.forEach(function (line, idx) {
        const lineNo = idx + 1;
        const trimmed = line.trim();
        if (!trimmed || trimmed.charAt(0) === '#' || trimmed.slice(0, 2) === '//') return;
        const indent = line.match(/^[ \t]*/)[0];

        // Общий заголовок
        const titleOld = trimmed.match(/^(заголовок|title)\s*:\s*(.*)$/i);
        if (titleOld) {
            pushFix(lineNo, 'Лучше «название:» вместо «' + titleOld[1] + ':»',
                'Единое слово для всех типов диаграмм',
                indent + 'название: ' + titleOld[2],
                'style_title');
        }

        if (m === 'gantt') {
            const mapKeys = [
                [/^дата-начала\s*:\s*(.*)$/i, 'старт'],
                [/^длительность\s*:\s*(.*)$/i, 'длится'],
                [/^комментарий\s*:\s*(.*)$/i, 'примечание'],
                [/^праздники\s*:\s*(.*)$/i, 'нерабочие'],
                [/^масштаб\s*:\s*(.*)$/i, 'шаг']
            ];
            for (let k = 0; k < mapKeys.length; k++) {
                const mm = trimmed.match(mapKeys[k][0]);
                if (mm) {
                    pushFix(lineNo, 'Лучше «' + mapKeys[k][1] + ':»',
                        'Более естественное русское поле',
                        indent + mapKeys[k][1] + ': ' + mm[1],
                        'style_gantt_key');
                    break;
                }
            }
            const cal = trimmed.match(/^календарь\s*:\s*(рабочие)\s*$/i);
            if (cal) {
                pushFix(lineNo, 'Лучше «календарь: будни»',
                    'То же самое, понятнее',
                    indent + 'календарь: будни',
                    'style_gantt_cal');
            }
            const afterM = trimmed.match(/^(после)\s*:\s*(.+)$/i);
            if (afterM) {
                const modern = modernizeDepValue(afterM[2]);
                if (modern != null) {
                    pushFix(lineNo, 'Связь лучше писать по-русски',
                        'Вместо FS/SS/FF/+2д — «(через 2 дня)» / «(начало-начало)»',
                        indent + 'после: ' + modern,
                        'style_gantt_dep');
                }
            }
        }

        if (m === 'sequence') {
            const seqMap = [
                [/^Начало опционально(?:\s+(.*))?$/i, function (rest) { return 'если' + (rest ? ' ' + rest : ''); }],
                [/^Начало ветки(?:\s+(.*))?$/i, function (rest) { return 'выбор' + (rest ? ' ' + rest : ''); }],
                [/^Начало альтернативы(?:\s+(.*))?$/i, function (rest) { return 'выбор' + (rest ? ' ' + rest : ''); }],
                [/^конец ветки\s*$/i, function () { return 'конец'; }],
                [/^конец альтернативы\s*$/i, function () { return 'конец'; }],
                [/^Начало цикла(?:\s+(.*))?$/i, function (rest) { return 'цикл' + (rest ? ' ' + rest : ''); }],
                [/^конец цикла\s*$/i, function () { return 'конец'; }],
                [/^Начало параллельных действий(?:\s+(.*))?$/i, function (rest) { return 'параллельно' + (rest ? ' ' + rest : ''); }],
                [/^конец параллельных действий\s*$/i, function () { return 'конец'; }]
                // «иначе» и «конец опционально» — валидный DSL, не переписываем
            ];
            for (let s = 0; s < seqMap.length; s++) {
                const mm = trimmed.match(seqMap[s][0]);
                if (mm) {
                    const neu = seqMap[s][1](mm[1] ? mm[1].trim() : '');
                    pushFix(lineNo, 'Лучше короткий синтаксис: «' + neu.split(/\s/)[0] + '»',
                        'Старая форма ещё работает; новый DSL короче',
                        indent + neu,
                        'style_seq_block');
                    break;
                }
            }
        }
    });

    return out;
}

function showDiagramEmpty(container, message) {
    container.textContent = '';
    const p = document.createElement('p');
    p.className = 'diagram-empty-msg';
    p.textContent = message || 'Введите данные для диаграммы';
    container.appendChild(p);
}

function showDiagramError(container, message) {
    container.textContent = '';
    const p = document.createElement('p');
    p.className = 'diagram-error-msg';
    p.textContent = message || 'Ошибка построения диаграммы';
    container.appendChild(p);
}

function mountDiagramCanvas(container, opts) {
    opts = opts || {};
    const svg = opts.svg;
    const width = opts.width;
    const height = opts.height;
    container.textContent = '';

    if (opts.errorMessage) {
        showDiagramError(container, opts.errorMessage);
        return { scalable: null, width: 0, height: 0 };
    }
    if (!svg) {
        showDiagramEmpty(container, opts.emptyMessage);
        return { scalable: null, width: 0, height: 0 };
    }

    if (svg.getAttribute && !svg.getAttribute('role')) {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', opts.ariaLabel || 'Диаграмма');
    }
    // Логический размер в data-* — zoom меняет только CSS/атрибуты width/height
    if (width) svg.setAttribute('data-logical-w', String(width));
    if (height) svg.setAttribute('data-logical-h', String(height));
    if (!svg.getAttribute('viewBox') && width && height) {
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    const fontFam = (typeof getUiFontFamily === 'function') ? getUiFontFamily() : '';
    if (fontFam) {
        svg.style.fontFamily = fontFam;
        svg.setAttribute('font-family', fontFam);
    }

    let diagnostics = opts.diagnostics;
    try {
        if (typeof collectDiagramStyleHints === 'function') {
            const mode = opts.mode
                || (typeof currentLayout !== 'undefined' ? currentLayout : '')
                || (typeof currentEditorMode !== 'undefined' ? currentEditorMode : '');
            const text = (typeof getRawText === 'function')
                ? getRawText()
                : ((typeof getText === 'function') ? getText() : '');
            if (mode && text != null && text !== '') {
                diagnostics = typeof mergeDiagnostics === 'function'
                    ? mergeDiagnostics(diagnostics, collectDiagramStyleHints(text, mode))
                    : [].concat(diagnostics || [], collectDiagramStyleHints(text, mode));
            }
        }
    } catch (_) { /* ignore */ }

    const wrap = document.createElement('div');
    wrap.className = 'scalable-content';
    wrap.appendChild(svg);
    container.appendChild(wrap);

    try {
        svg.querySelectorAll('[data-pdf-href]').forEach(function (el) {
            el.style.cursor = 'pointer';
        });
        svg.addEventListener('click', function (ev) {
            const linkEl = ev.target && ev.target.closest
                ? ev.target.closest('[data-pdf-href]')
                : null;
            if (!linkEl) return;
            const href = String(linkEl.getAttribute('data-pdf-href') || '').trim();
            if (!href) return;
            ev.preventDefault();
            ev.stopPropagation();
            window.open(href, '_blank', 'noopener,noreferrer');
        });
    } catch (_) { /* ignore */ }

    const panel = renderDiagnosticsPanel(diagnostics);
    if (panel) container.appendChild(panel);

    try {
        if (typeof bindDiagramSourceLineNav === 'function') bindDiagramSourceLineNav(container);
        if (typeof bindDiagramEditorCaretHighlight === 'function') {
            bindDiagramEditorCaretHighlight(document.getElementById('textInput'), container);
        }
        if (typeof highlightDiagramSourceLine === 'function'
            && (typeof isDiagramCaretHighlightEnabled !== 'function' || isDiagramCaretHighlightEnabled())) {
            const ta = document.getElementById('textInput');
            if (ta) highlightDiagramSourceLine(lineNumberFromTextareaCaret(ta), container);
        } else if (typeof highlightDiagramSourceLine === 'function') {
            highlightDiagramSourceLine(0, container);
        }
    } catch (_) { /* ignore */ }

    return {
        scalable: wrap,
        width: width || 0,
        height: height || 0
    };
}

function parseIsoDate(str) {
    const m = String(str || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    const dt = new Date(y, mo, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
    dt.setHours(0, 0, 0, 0);
    return dt;
}

/**
 * Единый синтаксис заголовка диаграммы: «название: …» (синонимы: заголовок/title).
 * aliases — доп. ключи (например title для совместимости, процесс для BPMN).
 * Без template literals: javascript-obfuscator ломал RegExp с хвостовым `$`.
 * @returns {string|null}
 */
function parseDiagramTitleLine(trimmed, aliases) {
    const keys = (aliases && aliases.length)
        ? aliases
        : ['название', 'заголовок', 'title', 'name'];
    const esc = keys.map(function (k) {
        return String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('|');
    const re = new RegExp('^(' + esc + ')\\s*:\\s*(.+)$', 'i');
    const m = String(trimmed || '').match(re);
    if (!m) return null;
    const value = m[2].trim();
    return value || null;
}

function isDiagramTitleLine(trimmed, aliases) {
    return parseDiagramTitleLine(trimmed, aliases) != null;
}

/** Комментарий DSL: `# …` или `// …` (пустая строка — тоже «пропустить»). */
function isDiagramCommentLine(trimmed) {
    const t = String(trimmed || '').trim();
    if (!t) return true;
    return t.charAt(0) === '#' || t.slice(0, 2) === '//';
}

/**
 * Разбор вставки из Excel / Google Sheets (TSV или CSV с `;`).
 * Возвращает null, если текст не похож на таблицу.
 *
 * @returns {{
 *   colLabels: string[],
 *   rows: Array<{ name: string, values: Array<number|null>, rawValues: string[], line: number }>,
 *   hasHeader: boolean
 * }|null}
 */
function parseSpreadsheetMatrix(text) {
    const rawLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const content = [];
    rawLines.forEach((l, idx) => {
        const t = l.trim();
        if (isDiagramCommentLine(t)) return;
        // однословные маркеры типа диаграммы — пропускаем
        if (/^(тепловая|heatmap|heat|теплокарта|pulsewave|динамика\s*волны|waterfall|водопад|ridgeline|хребты?)\s*$/i.test(t)) return;
        // мета-строки DSL с двоеточием без табов — не таблица
        content.push({ text: l, line: idx + 1 });
    });
    if (content.length < 1) return null;

    const tabHeavy = content.filter((e) => e.text.indexOf('\t') >= 0).length
        >= Math.max(1, Math.ceil(content.length * 0.5));
    const semicolonHeavy = !tabHeavy && content.filter((e) => (e.text.match(/;/g) || []).length >= 1).length
        >= Math.max(1, Math.ceil(content.length * 0.5));
    if (!tabHeavy && !semicolonHeavy) return null;

    const sep = tabHeavy ? '\t' : ';';
    function parseNum(tok) {
        const s = String(tok || '').trim().replace(/\s/g, '').replace('−', '-').replace(',', '.');
        if (s === '' || s === '—' || s === '–' || s.toLowerCase() === 'n/a') return null;
        // +120 / -15
        const m = s.match(/^([+\-])?([0-9]+(?:\.[0-9]+)?)$/);
        if (!m) return null;
        const abs = parseFloat(m[2]);
        if (!Number.isFinite(abs)) return null;
        return m[1] === '-' ? -abs : abs;
    }
    function looksNumericCell(tok) {
        return parseNum(tok) != null;
    }

    const grid = content.map((e) => ({
        line: e.line,
        cells: e.text.split(sep).map((c) => c.trim())
    }));
    const maxCols = Math.max(...grid.map((r) => r.cells.length), 0);
    if (maxCols < 2 && grid.length < 2) return null;
    grid.forEach((r) => {
        while (r.cells.length < maxCols) r.cells.push('');
    });

    let startR = 0;
    let startC = 0;
    let colLabels = [];
    let hasHeader = false;

    if (grid.length >= 1 && maxCols >= 2) {
        const first = grid[0].cells;
        const restHeader = first.slice(1);
        const headerLooksLabels = restHeader.some((h) => h && !looksNumericCell(h));
        const headerLooksNums = restHeader.filter(looksNumericCell).length >= Math.ceil(restHeader.length * 0.6);
        const corner = first[0];
        const firstColBody = grid.slice(1).map((r) => r.cells[0]);
        const bodyNames = firstColBody.some((h) => h && !looksNumericCell(h));

        if ((!corner || /^(ряд|строка|row|y|ось|даты|срезы|name|имя|статья|показатель)$/i.test(corner))
            && headerLooksLabels && bodyNames) {
            colLabels = restHeader.map((h, i) => h || ('C' + (i + 1)));
            startR = 1;
            startC = 1;
            hasHeader = true;
        } else if (headerLooksLabels && !headerLooksNums && bodyNames) {
            colLabels = first.map((h, i) => (i === 0 ? '' : (h || ('C' + i)))).slice(1);
            startR = 1;
            startC = 1;
            hasHeader = true;
        } else if (headerLooksNums && !corner) {
            colLabels = restHeader.map((_, i) => String(i + 1));
            startR = 0;
            startC = 1;
        }
    }

    const rows = [];
    for (let r = startR; r < grid.length; r++) {
        const cells = grid[r].cells;
        let name;
        let valsRaw;
        if (startC === 1) {
            name = cells[0] || ('R' + (rows.length + 1));
            valsRaw = cells.slice(1);
        } else {
            // вся строка числа — синтетическое имя
            if (cells.every((c) => !c || looksNumericCell(c))) {
                name = 'R' + (rows.length + 1);
                valsRaw = cells;
            } else {
                name = cells[0] || ('R' + (rows.length + 1));
                valsRaw = cells.slice(1);
            }
        }
        // пропуск чистых заголовков без чисел
        const values = valsRaw.map(parseNum);
        const hasAnyNum = values.some((v) => v != null);
        const nameIsMeta = /^(название|заголовок|title|единицы|units|ось|axis|даты|срезы|dates|slices)$/i.test(name);
        if (nameIsMeta && !hasAnyNum) continue;
        if (!hasAnyNum && /^(итог|всего|итого|total|подытог|checkpoint)$/i.test(name)) {
            rows.push({ name, values: [], rawValues: valsRaw, line: grid[r].line, bareTotal: true });
            continue;
        }
        if (!hasAnyNum) continue;
        rows.push({ name, values, rawValues: valsRaw, line: grid[r].line });
    }

    if (!rows.length) return null;
    const w = Math.max(colLabels.length, ...rows.map((row) => row.values.length), 1);
    while (colLabels.length < w) colLabels.push(String(colLabels.length + 1));
    colLabels = colLabels.slice(0, w);
    rows.forEach((row) => {
        while (row.values.length < w) row.values.push(null);
        if (row.values.length > w) row.values.length = w;
    });

    return { colLabels, rows, hasHeader };
}

/**
 * Связь «A -> B: значение» / «A --> B: значение» (без семантики BPMN).
 * --> принимается как синоним -> в потоках/обратимости/волне.
 * @returns {{ from: string, to: string, valueRaw: string, arrow: string }|null}
 */
function matchDiagramValueLink(trimmed) {
    const m = String(trimmed || '').match(
        /^(.+?)\s*(->|-->)\s*(.+?)\s*:\s*([0-9]+(?:[.,][0-9]+)?)\s*$/
    );
    if (!m) return null;
    return {
        from: m[1].trim(),
        to: m[3].trim(),
        valueRaw: m[4],
        arrow: m[2]
    };
}

/** Слова «готово» для деревьев (radial/horizontal) — один набор везде. */
var DIAGRAM_DONE_WORD =
    'готово|выполнено|done|ok|готов|сделано';

/**
 * Снять маркер статуса с текста узла дерева.
 * @returns {{ text: string, done: boolean }}
 */
function parseDiagramDoneMarker(str) {
    let done = false;
    let text = String(str || '');

    const statusRe = new RegExp('(?:Статус|Status)\\s*:\\s*(' + DIAGRAM_DONE_WORD + ')\\b', 'i');
    if (statusRe.test(text)) {
        done = true;
        text = text.replace(statusRe, '').trim();
    }

    if (!done) {
        const suffixRe = new RegExp(
            '\\s*(?:[\\(\\[]\\s*(' + DIAGRAM_DONE_WORD + '|x|✓|✔)\\s*[\\)\\]]|\\((' + DIAGRAM_DONE_WORD + ')\\)|\\[(' + DIAGRAM_DONE_WORD + ')\\]|(?:^|\\s)(' + DIAGRAM_DONE_WORD + ')\\s*)$',
            'i'
        );
        const m = text.match(suffixRe);
        if (m) {
            done = true;
            text = text.replace(suffixRe, '').trim();
        }
    }

    if (!done && /\s*[✓✔]\s*$/.test(text)) {
        done = true;
        text = text.replace(/\s*[✓✔]\s*$/, '').trim();
    }

    return { text: text.trim(), done: done };
}

/** Инициалы для кружка: @АМ → АМ, @Иванов → ИВ, @Иван_Петров → ИП */
function diagramAssigneeInitials(raw) {
    const s = String(raw || '').trim().replace(/^@+/, '');
    if (!s) return '?';
    if (/^[A-Za-zА-Яа-яЁё]{1,3}$/u.test(s) && s === s.toUpperCase()) {
        return s.slice(0, 2).toUpperCase();
    }
    const parts = s.split(/[\s_\-.]+/).filter(Boolean);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    const letters = s.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 2) return letters.slice(0, 2).toUpperCase();
    return (letters || s).slice(0, 2).toUpperCase() || '?';
}

function diagramAssigneeColor(raw) {
    const s = String(raw || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    const palette = ['#2F5BA7', '#0f766e', '#a16207', '#be123c', '#7c3aed', '#0369a1', '#c2410c', '#15803d'];
    return palette[Math.abs(h) % palette.length];
}

/**
 * Парсинг дедлайна: !15.03 | !15.03.2026 | !2026-04-01 | !пт
 * @returns {{ label: string, date: Date|null, overdue: boolean }|null}
 */
function parseDiagramDeadlineToken(raw) {
    const s = String(raw || '').trim().replace(/^!+/, '');
    if (!s) return null;

    const weekMap = {
        пн: 'пн', вт: 'вт', ср: 'ср', чт: 'чт', пт: 'пт', сб: 'сб', вс: 'вс',
        mon: 'пн', tue: 'вт', wed: 'ср', thu: 'чт', fri: 'пт', sat: 'сб', sun: 'вс'
    };
    const wk = weekMap[s.toLowerCase()];
    if (wk) return { label: wk, date: null, overdue: false };

    let y;
    let mo;
    let d;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
        y = +m[1]; mo = +m[2]; d = +m[3];
    } else {
        m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        if (m) {
            d = +m[1]; mo = +m[2]; y = +m[3];
        } else {
            m = s.match(/^(\d{1,2})\.(\d{1,2})$/);
            if (m) {
                d = +m[1]; mo = +m[2];
                const today = typeof startOfToday === 'function' ? startOfToday() : new Date();
                y = today.getFullYear();
                const cand = new Date(y, mo - 1, d);
                cand.setHours(0, 0, 0, 0);
                if (cand.getTime() < today.getTime() - 180 * 86400000) y += 1;
            }
        }
    }
    if (y == null || mo == null || d == null) {
        return { label: s.slice(0, 8), date: null, overdue: false };
    }
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
        return { label: s.slice(0, 8), date: null, overdue: false };
    }
    dt.setHours(0, 0, 0, 0);
    const today = typeof startOfToday === 'function' ? startOfToday() : new Date();
    today.setHours(0, 0, 0, 0);
    const label = String(d).padStart(2, '0') + '.' + String(mo).padStart(2, '0');
    return { label: label, date: dt, overdue: dt.getTime() < today.getTime() };
}

/**
 * Снять хвостовые @ответственный и !дедлайн с подписи узла.
 * Порядок маркеров свободный в конце строки.
 * @returns {{ text, assignee, initials, deadlineLabel, deadlineDate, overdue }}
 */
function parseDiagramNodeMeta(str) {
    let text = String(str == null ? '' : str).trim();
    let assignee = null;
    let deadlineRaw = null;

    for (let i = 0; i < 6; i++) {
        let m = text.match(/^(.*)\s+@([^\s@!]+)\s*$/u);
        if (m) {
            text = m[1].trim();
            if (!assignee) assignee = m[2];
            continue;
        }
        m = text.match(/^(.*)\s+!([^\s@!]+)\s*$/u);
        if (m) {
            text = m[1].trim();
            if (!deadlineRaw) deadlineRaw = m[2];
            continue;
        }
        break;
    }

    const dl = deadlineRaw ? parseDiagramDeadlineToken(deadlineRaw) : null;
    return {
        text: text,
        assignee: assignee,
        initials: assignee ? diagramAssigneeInitials(assignee) : null,
        deadlineLabel: dl ? dl.label : null,
        deadlineDate: dl ? dl.date : null,
        overdue: !!(dl && dl.overdue)
    };
}

function applyDiagramNodeMetaFields(target, meta) {
    if (!target || !meta) return target;
    if (meta.assignee) {
        target.assignee = meta.assignee;
        target.initials = meta.initials;
    }
    if (meta.deadlineLabel) {
        target.deadlineLabel = meta.deadlineLabel;
        target.deadlineDate = meta.deadlineDate;
        target.overdue = !!meta.overdue;
    }
    return target;
}

/** Кружок с инициалами ответственного (угол блока). */
function appendAssigneeAvatar(svgNS, parent, cx, cy, opts) {
    opts = opts || {};
    const initials = String(opts.initials || '?').slice(0, 2);
    const r = opts.r != null ? opts.r : 18;
    const fill = opts.fill || diagramAssigneeColor(opts.assignee || initials);
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'diagram-assignee');
    if (opts.title) {
        const t = document.createElementNS(svgNS, 'title');
        t.textContent = opts.title;
        g.appendChild(t);
    }
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', r);
    circle.setAttribute('fill', fill);
    circle.setAttribute('stroke', '#ffffff');
    circle.setAttribute('stroke-width', '2.5');
    g.appendChild(circle);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', cy + 1);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('font-size', String(Math.max(10, Math.round(r * 0.78))));
    text.setAttribute('font-weight', '800');
    text.style.fontFamily = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';
    text.textContent = initials;
    g.appendChild(text);
    parent.appendChild(g);
    return g;
}

/** Плашка дедлайна на блоке — заметный chip с акцентом. */
function appendDeadlineChip(svgNS, parent, x, y, opts) {
    opts = opts || {};
    const raw = String(opts.label || '').slice(0, 8);
    if (!raw) return null;
    const overdue = !!opts.overdue;
    const fontSize = opts.fontSize || 12;
    const padX = 8;
    const h = opts.h || 20;
    const mark = overdue ? '⚠ ' : '';
    const label = mark + raw;
    const approxW = Math.max(36, label.length * (fontSize * 0.64) + padX * 2);
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'diagram-deadline' + (overdue ? ' is-overdue' : ''));
    if (opts.title || raw) {
        const tip = document.createElementNS(svgNS, 'title');
        tip.textContent = overdue ? ('Просрочено: ' + raw) : ('Дедлайн: ' + raw);
        g.appendChild(tip);
    }
    // лёгкая тень
    const shadow = document.createElementNS(svgNS, 'rect');
    shadow.setAttribute('x', x + 1);
    shadow.setAttribute('y', y - h / 2 + 1.5);
    shadow.setAttribute('width', approxW);
    shadow.setAttribute('height', h);
    shadow.setAttribute('rx', h / 2);
    shadow.setAttribute('fill', 'rgba(15, 23, 42, 0.18)');
    g.appendChild(shadow);
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y - h / 2);
    rect.setAttribute('width', approxW);
    rect.setAttribute('height', h);
    rect.setAttribute('rx', h / 2);
    rect.setAttribute('fill', overdue ? '#dc2626' : '#f59e0b');
    rect.setAttribute('stroke', overdue ? '#991b1b' : '#b45309');
    rect.setAttribute('stroke-width', '1.5');
    g.appendChild(rect);
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', x + approxW / 2);
    text.setAttribute('y', y + 1);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('font-size', String(fontSize));
    text.setAttribute('font-weight', '800');
    text.style.fontFamily = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';
    text.textContent = label;
    g.appendChild(text);
    parent.appendChild(g);
    return g;
}

/**
 * Бейджи @ / ! на прямоугольном узле.
 * left/top — левый верх блока; width/height — размер.
 * opts.pill — капсула (Классика): якорь внутрь скругления, иначе бейджи «улетают» за угол bbox.
 */
function appendDiagramNodeMeta(svgNS, parent, box, node, opts) {
    if (!node || (!node.assignee && !node.deadlineLabel && !node.initials)) return;
    opts = opts || {};
    const left = box.x;
    const top = box.y;
    const w = box.width;
    const h = box.height;
    const ar = opts.avatarR != null ? opts.avatarR : 18;
    const pill = !!(opts.pill || opts.cornerStyle === 'pill');

    // У капсулы угол bbox вне заливки — якорим ближе к дуге правого/левого торца
    const avatarInset = pill
        ? Math.max(10, Math.min(h * 0.3, ar * 0.78, w * 0.28))
        : 1;
    const chipInsetY = pill ? Math.min(8, Math.max(3, h * 0.14)) : 1;
    const chipInsetX = pill ? Math.max(4, Math.min(12, h * 0.18)) : 2;

    if (node.assignee || node.initials) {
        appendAssigneeAvatar(svgNS, parent, left + w - avatarInset, top + h - avatarInset, {
            initials: node.initials || diagramAssigneeInitials(node.assignee),
            assignee: node.assignee,
            r: ar,
            title: node.assignee ? ('@' + node.assignee) : ''
        });
    }
    if (node.deadlineLabel) {
        appendDeadlineChip(svgNS, parent, left + chipInsetX, top + h - chipInsetY, {
            label: node.deadlineLabel,
            overdue: !!node.overdue,
            fontSize: opts.deadlineFontSize || 12,
            h: opts.deadlineH || 20
        });
    }
}

/** Атрибут data-source-line для перехода к строке в редакторе (ПКМ / ⌘+клик). */
function setDiagramSourceLine(el, line) {
    if (!el) return;
    const n = parseInt(line, 10);
    if (!Number.isFinite(n) || n < 1) return;
    el.setAttribute('data-source-line', String(n));
    try {
        if (!el.style.cursor || el.style.cursor === 'auto') el.style.cursor = 'pointer';
    } catch (_) { /* ignore */ }
}

/** Показать редактор схем, если свёрнут / на мобилке режим «Диаграмма». */
function revealDiagramEditorForLineJump(ta) {
    if (!ta || ta.id !== 'textInput') return;
    try {
        if (typeof window.setDiagramsMobileMode === 'function') {
            const shell = document.getElementById('diagramsContainer');
            if (shell && shell.classList.contains('diagrams-mode-diagram')) {
                window.setDiagramsMobileMode('text');
            }
        }
    } catch (_) { /* ignore */ }
    try {
        if (typeof window.setDiagramEditorDrawerOpen === 'function') {
            // Не fitDiagramToView: ПКМ по приближённому куску схемы не должен сбрасывать масштаб
            window.setDiagramEditorDrawerOpen(true, { fit: false });
        } else {
            const panel = document.getElementById('inputPanel');
            if (panel && panel.classList.contains('is-collapsed')) {
                panel.classList.remove('is-collapsed');
                if (typeof window.syncEditorCanvasInset === 'function') window.syncEditorCanvasInset();
            }
        }
    } catch (_) { /* ignore */ }
}

/** Выделить строку N (1-based) в textarea диаграмм и прокрутить к ней. */
function selectDiagramEditorLine(lineNo, opts) {
    opts = opts || {};
    const ta = opts.textarea || document.getElementById('textInput');
    if (!ta) return false;
    const n = parseInt(lineNo, 10);
    if (!Number.isFinite(n) || n < 1) return false;
    const text = String(ta.value || '');
    const lines = text.split('\n');
    const idx = n - 1;
    if (idx < 0 || idx >= lines.length) return false;
    let start = 0;
    for (let i = 0; i < idx; i++) start += lines[i].length + 1;
    let end = start + lines[idx].length;
    // Пустая строка: selection нулевой длины часто невидим — захватим \n
    if (end <= start && start < text.length) end = start + 1;

    revealDiagramEditorForLineJump(ta);

    // Надёжная подсветка в highlight-layer (transparent textarea::selection в WebKit нестабилен)
    if (ta.id === 'textInput' && typeof window.setEditorJumpLine === 'function') {
        try { window.setEditorJumpLine(n); } catch (_) { /* ignore */ }
    }

    const apply = () => {
        try {
            ta.focus({ preventScroll: true });
        } catch (_) {
            try { ta.focus(); } catch (__) { /* ignore */ }
        }
        try {
            ta.setSelectionRange(start, Math.max(start, end));
        } catch (_) { /* ignore */ }
        try {
            const cs = getComputedStyle(ta);
            let lh = parseFloat(cs.lineHeight);
            if (!Number.isFinite(lh) || lh < 8) {
                const fs = parseFloat(cs.fontSize) || 14;
                lh = fs * 1.45;
            }
            // soft-wrap: приблизительный скролл; highlight-layer mark всё равно виден
            ta.scrollTop = Math.max(0, lh * idx - ta.clientHeight / 3);
        } catch (_) { /* ignore */ }
        try {
            if (ta.id === 'textInput') {
                const hl = document.getElementById('highlightLayer');
                if (hl) {
                    const mark = hl.querySelector('.hl-jump-line');
                    if (mark) {
                        // Не scrollIntoView — он иногда уводит панель/слой в конец.
                        const markTop = mark.offsetTop;
                        const target = Math.max(0, markTop - hl.clientHeight / 3);
                        hl.scrollTop = target;
                        ta.scrollTop = target;
                    } else {
                        hl.scrollTop = ta.scrollTop;
                        hl.scrollLeft = ta.scrollLeft;
                    }
                }
            }
        } catch (_) { /* ignore */ }
    };

    apply();
    // Drawer: transform/opacity ~220ms — selection после появления панели
    [32, 80, 160, 280, 420].forEach((ms) => {
        setTimeout(apply, ms);
    });
    requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
    });

    if (opts.toast !== false && typeof window.showToast === 'function') {
        window.showToast('Строка ' + n + ' в редакторе');
    }
    return true;
}

/** ПКМ или ⌘/Ctrl+клик по блоку с data-source-line → строка в редакторе. */
function bindDiagramSourceLineNav(container, opts) {
    opts = opts || {};
    const root = container || document.getElementById('diagram');
    const flag = opts.flag || 'sourceLineNavBound';
    if (!root || root.dataset[flag] === '1') return;
    root.dataset[flag] = '1';

    function lineFromEl(el) {
        if (!el || !root.contains(el)) return null;
        const n = parseInt(el.getAttribute('data-source-line'), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    function findSourceLineEl(start) {
        let node = start;
        while (node && node !== root) {
            if (node.getAttribute) {
                const raw = node.getAttribute('data-source-line');
                if (raw != null && raw !== '') return node;
            }
            node = node.parentElement || node.parentNode;
        }
        if (start && start.closest) {
            const hit = start.closest('[data-source-line]');
            if (hit && root.contains(hit)) return hit;
        }
        return null;
    }

    function nearestSourceLine(clientX, clientY) {
        if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
        let bestEl = null;
        let bestD = Infinity;
        let insideEl = null;
        let nodes;
        try {
            nodes = root.querySelectorAll('[data-source-line]');
        } catch (_) { return null; }
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            let r;
            try { r = el.getBoundingClientRect(); } catch (_) { continue; }
            if (!r || (r.width < 0.5 && r.height < 0.5)) continue;
            const inside = clientX >= r.left && clientX <= r.right
                && clientY >= r.top && clientY <= r.bottom;
            if (inside) {
                // Предпочитаем самый маленький hit-box (текст/rect узла, не «широкий» предок)
                if (!insideEl) insideEl = el;
                else {
                    let prev;
                    try { prev = insideEl.getBoundingClientRect(); } catch (_) { prev = null; }
                    const area = r.width * r.height;
                    const prevArea = prev ? prev.width * prev.height : Infinity;
                    if (area < prevArea) insideEl = el;
                }
                continue;
            }
            const cx = Math.min(Math.max(clientX, r.left), r.right);
            const cy = Math.min(Math.max(clientY, r.top), r.bottom);
            const d = Math.hypot(clientX - cx, clientY - cy);
            if (d < bestD) {
                bestD = d;
                bestEl = el;
            }
        }
        if (insideEl) return lineFromEl(insideEl);
        // Узкий допуск — только клик «рядом», не через всё полотно
        if (bestEl && bestD <= 28) return lineFromEl(bestEl);
        return null;
    }

    function hitSourceLine(target, clientX, clientY) {
        let line = lineFromEl(findSourceLineEl(target));
        if (line) return line;
        if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
            try {
                const stack = document.elementsFromPoint(clientX, clientY) || [];
                for (let i = 0; i < stack.length; i++) {
                    line = lineFromEl(findSourceLineEl(stack[i]));
                    if (line) return line;
                }
            } catch (_) { /* ignore */ }
            line = nearestSourceLine(clientX, clientY);
            if (line) return line;
        }
        return null;
    }

    function jump(line) {
        const ta = typeof opts.getTextarea === 'function'
            ? opts.getTextarea()
            : (opts.textarea || document.getElementById(opts.textareaId || 'textInput'));
        selectDiagramEditorLine(line, {
            textarea: ta || undefined,
            toast: opts.toast !== false
        });
    }

    root.addEventListener('contextmenu', (e) => {
        if (opts.skipTarget && opts.skipTarget(e.target)) return;
        const line = hitSourceLine(e.target, e.clientX, e.clientY);
        if (!line) return;
        e.preventDefault();
        e.stopPropagation();
        jump(line);
    }, true);

    root.addEventListener('click', (e) => {
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.target.closest && e.target.closest('[data-pdf-href]')) return;
        if (opts.skipTarget && opts.skipTarget(e.target)) return;
        const line = hitSourceLine(e.target, e.clientX, e.clientY);
        if (!line) return;
        e.preventDefault();
        e.stopPropagation();
        jump(line);
    }, true);
}

/** Номер строки (1-based) по caret в textarea. */
function lineNumberFromTextareaCaret(ta) {
    if (!ta) return 0;
    const pos = Math.max(0, ta.selectionStart | 0);
    const text = String(ta.value || '');
    let line = 1;
    for (let i = 0; i < pos && i < text.length; i++) {
        if (text.charAt(i) === '\n') line++;
    }
    return line;
}

/** Подсветка узлов схемы по data-source-line. */
function isDiagramCaretHighlightEnabled() {
    try {
        return localStorage.getItem('diagramEditorCaretHighlight') !== '0';
    } catch (_) {
        return true;
    }
}

function setDiagramCaretHighlightEnabled(on) {
    const next = !!on;
    try {
        localStorage.setItem('diagramEditorCaretHighlight', next ? '1' : '0');
    } catch (_) { /* ignore */ }
    if (!next) {
        highlightDiagramSourceLine(0);
    } else {
        try {
            const ta = document.getElementById('textInput');
            if (ta) highlightDiagramSourceLine(lineNumberFromTextareaCaret(ta));
        } catch (_) { /* ignore */ }
    }
    try {
        document.dispatchEvent(new CustomEvent('diagram-caret-highlight-changed', {
            detail: { enabled: next }
        }));
    } catch (_) { /* ignore */ }
    return next;
}

function highlightDiagramSourceLine(lineNo, container) {
    const root = container || document.getElementById('diagram');
    if (!root) return;
    try {
        root.querySelectorAll('.is-source-line-active').forEach((el) => {
            el.classList.remove('is-source-line-active');
        });
    } catch (_) { /* ignore */ }
    if (!isDiagramCaretHighlightEnabled()) return;
    const n = parseInt(lineNo, 10);
    if (!Number.isFinite(n) || n < 1) return;
    let nodes = [];
    try {
        nodes = Array.prototype.slice.call(root.querySelectorAll('[data-source-line="' + n + '"]'));
    } catch (_) { nodes = []; }
    if (!nodes.length) {
        // ближайшая строка ≤ caret (вложенные узлы часто на своих строках)
        let best = null;
        let bestLine = -1;
        try {
            root.querySelectorAll('[data-source-line]').forEach((el) => {
                const ln = parseInt(el.getAttribute('data-source-line'), 10);
                if (!Number.isFinite(ln) || ln > n) return;
                if (ln >= bestLine) {
                    bestLine = ln;
                    best = el;
                }
            });
        } catch (_) { /* ignore */ }
        if (best) nodes = [best];
    }
    nodes.forEach((el) => {
        try { el.classList.add('is-source-line-active'); } catch (_) { /* ignore */ }
    });
}

/** Курсор в редакторе схем → подсветка узла на превью. */
function bindDiagramEditorCaretHighlight(textarea, container) {
    const ta = textarea || document.getElementById('textInput');
    if (!ta || ta.dataset.caretHighlightBound === '1') return;
    ta.dataset.caretHighlightBound = '1';
    let raf = 0;
    const sync = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            raf = 0;
            if (!isDiagramCaretHighlightEnabled()) {
                highlightDiagramSourceLine(0, container);
                return;
            }
            highlightDiagramSourceLine(lineNumberFromTextareaCaret(ta), container);
        });
    };
    ['keyup', 'click', 'select', 'focus', 'input'].forEach((ev) => {
        ta.addEventListener(ev, sync);
    });
    document.addEventListener('selectionchange', () => {
        if (document.activeElement === ta) sync();
    });
    document.addEventListener('diagram-caret-highlight-changed', sync);
    sync();
}

/**
 * Серая подпись под блоком дерева (Радиал / Классика / Иерарх).
 * cx — центр по X, topY — верх первой строки (уже с учётом зазора под шильдики).
 * Лёгкая подложка, чтобы текст читался поверх линий.
 */
function appendDiagramNodeNote(svgNS, parent, cx, topY, node, opts) {
    opts = opts || {};
    const note = node && (node.note || null);
    if (!note) return null;
    const rows = (node.noteLines && node.noteLines.length)
        ? node.noteLines
        : [String(note)];
    const fill = opts.fill
        || (typeof readCssColor === 'function' ? readCssColor('--secondary-text', '#64748b') : '#64748b');
    const fontSize = opts.fontSize || 11;
    const lh = opts.lineHeight || 13;
    const fontFam = (typeof getUiFontFamily === 'function')
        ? getUiFontFamily()
        : 'system-ui, sans-serif';

    let maxW = 40;
    try {
        const canvas = appendDiagramNodeNote._canvas
            || (appendDiagramNodeNote._canvas = document.createElement('canvas'));
        const ctx = canvas.getContext('2d');
        ctx.font = '500 ' + fontSize + 'px ' + fontFam;
        rows.forEach((r) => { maxW = Math.max(maxW, ctx.measureText(r).width); });
    } catch (_) {
        maxW = Math.max(...rows.map((r) => String(r).length * fontSize * 0.55), 40);
    }
    const padX = 6;
    const padY = 3;
    const blockH = rows.length * lh + padY * 2;
    const blockW = maxW + padX * 2;
    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('x', cx - blockW / 2);
    bg.setAttribute('y', topY - padY);
    bg.setAttribute('width', blockW);
    bg.setAttribute('height', blockH);
    bg.setAttribute('rx', 4);
    const isDark = typeof document !== 'undefined'
        && document.body
        && document.body.classList.contains('dark');
    bg.setAttribute('fill', isDark ? 'rgba(15, 23, 42, 0.82)' : 'rgba(248, 250, 252, 0.92)');
    parent.appendChild(bg);

    if (typeof appendSvgTextBlock === 'function') {
        return appendSvgTextBlock(svgNS, parent, {
            x: cx,
            y: topY + fontSize,
            lines: rows,
            fill,
            fontSize,
            fontWeight: '500',
            lineHeight: lh,
            textAnchor: 'middle',
            dataLabel: note
        });
    }
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', topY + fontSize);
    text.setAttribute('fill', fill);
    text.setAttribute('font-size', fontSize + 'px');
    text.setAttribute('font-weight', '500');
    text.setAttribute('text-anchor', 'middle');
    text.textContent = rows[0];
    parent.appendChild(text);
    return text;
}

function startOfDay(date) {
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
}

/** Календарные дни между двумя датами (локальная дата, без сдвига из-за DST). */
function diffCalendarDays(fromDate, toDate) {
    const a = startOfDay(fromDate);
    const b = startOfDay(toDate);
    if (!a || !b) return 0;
    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((utcB - utcA) / 86400000);
}

function addCalendarDays(date, days) {
    const d = startOfDay(date);
    if (!d) return null;
    d.setDate(d.getDate() + (days | 0));
    return d;
}

function startOfToday() {
    return startOfDay(new Date());
}

/**
 * Замена диапазона в textarea с сохранением нативного undo (Cmd/Ctrl+Z), когда это возможно.
 * Safari часто врёт с execCommand('insertText') и вставляет в конец поля — поэтому
 * результат всегда сверяем с ожидаемым value; при расхождении откатываем и идём в setRangeText.
 */
function replaceTextareaRange(ta, from, to, text, selStart, selEnd) {
    if (!ta) return;
    const inserted = text == null ? '' : String(text);
    const start = Math.max(0, Number(from) || 0);
    const end = Math.max(start, Number(to) || 0);
    const before = String(ta.value || '');
    const expected = before.slice(0, start) + inserted + before.slice(end);
    const nextStart = selStart != null ? Number(selStart) : (start + inserted.length);
    const nextEnd = selEnd != null ? Number(selEnd) : nextStart;

    const restoreCaret = () => {
        try { ta.focus(); } catch (_) { /* ignore */ }
        try { ta.setSelectionRange(nextStart, nextEnd); } catch (_) { /* ignore */ }
    };

    // 1) undo-friendly path, но только если value совпал с ожидаемым
    try {
        ta.focus();
        ta.setSelectionRange(start, end);
        let ok = false;
        try {
            ok = document.execCommand('insertText', false, inserted);
        } catch (_) {
            ok = false;
        }
        if (!ok && inserted === '') {
            try { ok = document.execCommand('delete', false, null); } catch (_) { ok = false; }
        }
        if (ok && String(ta.value || '') === expected) {
            restoreCaret();
            return;
        }
        if (ok) {
            try { document.execCommand('undo'); } catch (_) { /* ignore */ }
            // если undo не вернул текст — принудительно восстановим ниже
            if (String(ta.value || '') !== before) {
                ta.value = before;
            }
        }
    } catch (_) { /* ignore */ }

    // 2) надёжный setRangeText (без нативного undo в части браузеров)
    try {
        ta.setRangeText(inserted, start, end, 'end');
        if (String(ta.value || '') === expected) {
            restoreCaret();
            return;
        }
    } catch (_) { /* ignore */ }

    // 3) прямой fallback
    ta.value = expected;
    restoreCaret();
}

/** Пары обёрток before…after в тексте (без вложенности одного типа). */
function findMarkupPairs(text, before, after) {
    const b = String(before || '');
    const a = String(after || '');
    if (!b || !a) return [];
    const pairs = [];
    const raw = String(text || '');
    let i = 0;
    while (i < raw.length) {
        if (b === '*' && a === '*' && raw.startsWith('**', i)) {
            i += 2;
            continue;
        }
        const start = raw.indexOf(b, i);
        if (start < 0) break;
        if (b === '*' && a === '*' && raw.startsWith('**', start)) {
            i = start + 2;
            continue;
        }
        if (b === '==' && a === '==' && /^==c[1-4]:/.test(raw.slice(start))) {
            i = start + 2;
            continue;
        }
        let end = raw.indexOf(a, start + b.length);
        if (end < 0) break;
        if (b === '*' && a === '*') {
            while (end >= 0 && raw.startsWith('**', end)) {
                end = raw.indexOf(a, end + 2);
            }
            if (end < 0) break;
        }
        if (end < start + b.length) {
            i = start + b.length;
            continue;
        }
        pairs.push({
            wrapStart: start,
            wrapEnd: end + a.length,
            innerStart: start + b.length,
            innerEnd: end
        });
        i = end + a.length;
    }
    return pairs;
}

function findEnclosingMarkup(text, selStart, selEnd, before, after) {
    const pairs = findMarkupPairs(text, before, after);
    let best = null;
    for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        if (selStart >= p.wrapStart && selEnd <= p.wrapEnd) {
            if (!best || (p.wrapEnd - p.wrapStart) < (best.wrapEnd - best.wrapStart)) {
                best = p;
            }
        }
    }
    return best;
}

function applyTextareaInnerRange(ta, wrapStart, wrapEnd, inner) {
    const text = inner == null ? '' : String(inner);
    replaceTextareaRange(ta, wrapStart, wrapEnd, text, wrapStart, wrapStart + text.length);
}

/** Word-like toggle: повторный клик снимает обёртку before…after. */
function wrapTextareaSelection(ta, before, after, placeholder) {
    if (!ta) return;
    const start = ta.selectionStart | 0;
    const end = ta.selectionEnd | 0;
    const val = String(ta.value || '');
    let selected = val.slice(start, end);
    const b = String(before || '');
    const a = String(after || '');
    const ph = placeholder || 'текст';

    if (selected.startsWith(b) && selected.endsWith(a) && selected.length > b.length + a.length) {
        applyTextareaInnerRange(ta, start, end, selected.slice(b.length, selected.length - a.length));
        return;
    }

    if (start >= b.length && end + a.length <= val.length
        && val.slice(start - b.length, start) === b
        && val.slice(end, end + a.length) === a) {
        applyTextareaInnerRange(ta, start - b.length, end + a.length, selected);
        return;
    }

    const enclosing = findEnclosingMarkup(val, start, end, b, a);
    if (enclosing) {
        applyTextareaInnerRange(ta, enclosing.wrapStart, enclosing.wrapEnd, val.slice(enclosing.innerStart, enclosing.innerEnd));
        return;
    }

    if (!selected) selected = ph;
    const next = b + selected + a;
    replaceTextareaRange(ta, start, end, next, start + b.length, start + b.length + selected.length);
}
/** Глобальный toast. Создание DOM — одной строкой (control-flow obfuscator ломал createElement+append). */
(function () {
    if (typeof window === 'undefined') return;
    var hideTimer = null;
    window.showToast = function showToast(msg, opts) {
        opts = opts || {};
        var text = String(msg == null ? '' : msg).trim();
        if (!text) return;
        var el = document.getElementById('appToast');
        if (!el) {
            (document.body || document.documentElement).insertAdjacentHTML(
                'beforeend',
                '<div id="appToast" class="app-toast" role="status" aria-live="polite" hidden></div>'
            );
            el = document.getElementById('appToast');
        }
        if (!el) return;
        el.textContent = text;
        el.hidden = false;
        el.classList.add('is-on');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () {
            el.classList.remove('is-on');
            el.hidden = true;
        }, Math.max(1200, (opts && opts.duration | 0) || 2400));
    };
})();
