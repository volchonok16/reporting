/**
 * SVG «Водопад» — старт, +/−, подытоги, итог; план/факт; единицы и %.
 */
function generateWaterfallSVG(layoutData, themeColors) {
    const {
        title, units, showPct, seriesLayouts, width, height
    } = layoutData;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Водопад');
    svg.style.fontFamily = (typeof getUiFontFamily === 'function'
        ? getUiFontFamily()
        : 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif');

    const isDark = document.body.classList.contains('dark');
    const bg = typeof readCssColor === 'function'
        ? readCssColor('--diagram-bg', isDark ? '#161618' : '#f8fafc')
        : (isDark ? '#161618' : '#f8fafc');
    const ink = isDark ? '#e2e8f0' : '#0f172a';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const grid = isDark ? '#334155' : '#cbd5e1';
    // Роли те же (старт / + / − / подытог / итог), цвета — из палитры темы
    const palette = (themeColors && themeColors.length)
        ? themeColors.slice()
        : [];
    // Simmetrika: growth green and loss red whatever the palette (the soft one drew losses mint);
    // the palette's own colours only when it has no hue (grey).
    const hueless = (hex) => {
        const h = typeof cssColorToHex === 'function' ? cssColorToHex(hex, '#888888') : String(hex);
        const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        return Math.max(...c) - Math.min(...c) < 24;
    };
    const grey = palette.length > 2 && hueless(palette[1]) && hueless(palette[2]);
    const softLook = typeof isSoftDiagramStyle === 'function' && isSoftDiagramStyle();
    const pos = grey ? palette[1] : (softLook ? '#6ee7b7' : (isDark ? '#34d399' : '#059669'));
    const neg = grey ? palette[2] : (softLook ? '#fca5a5' : (isDark ? '#fb7185' : '#e11d48'));
    const baseCol = palette[0] || (isDark ? '#64748b' : '#475569');
    const totalCol = palette[4] || palette[0] || (isDark ? '#60a5fa' : '#2563eb');
    const subtotalCol = palette[3] || (isDark ? '#a78bfa' : '#7c3aed');

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    function fitLabel(node, maxW, sizes, weight) {
        if (typeof document === 'undefined') return;
        const c = fitLabel._c || (fitLabel._c = document.createElement('canvas'));
        const ctx = c.getContext('2d');
        const fam = typeof getUiFontFamily === 'function' ? getUiFontFamily() : 'system-ui, sans-serif';
        for (const fs of sizes) {
            ctx.font = weight + ' ' + fs + 'px ' + fam;
            node.setAttribute('font-size', fs);
            if (ctx.measureText(node.textContent).width <= maxW) return;
        }
    }

    function fmtNum(v, withSign) {
        const n = Math.round(v * 100) / 100;
        const s = n.toLocaleString('ru-RU');
        const core = (withSign && v > 0) ? ('+' + s) : s;
        return units ? (core + '\u00a0' + units) : core;
    }

    function fmtPct(p) {
        if (p == null || !Number.isFinite(p)) return '';
        const n = Math.round(p * 10) / 10;
        const sign = n > 0 ? '+' : '';
        return sign + n.toLocaleString('ru-RU') + '%';
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width: width, height: height, fill: bg }));

    const titleEl = el('text', {
        x: width / 2, y: 28, fill: ink, 'font-size': 16, 'font-weight': 700, 'text-anchor': 'middle'
    });
    titleEl.textContent = title || 'Водопад';
    svg.appendChild(titleEl);

    if (units) {
        const u = el('text', {
            x: width / 2, y: 46, fill: muted, 'font-size': 11, 'text-anchor': 'middle'
        });
        u.textContent = 'единицы: ' + units;
        svg.appendChild(u);
    }

    const layouts = (seriesLayouts && seriesLayouts.length)
        ? seriesLayouts
        : [{
            name: null,
            steps: layoutData.steps || [],
            connectors: layoutData.connectors || [],
            zeroY: layoutData.zeroY,
            plotBottom: layoutData.plotBottom,
            chartLeft: layoutData.chartLeft,
            chartRight: layoutData.chartRight,
            ticks: [{ value: 0, y: layoutData.zeroY }],
            headerY: 0
        }];

    layouts.forEach((lay) => {
        if (lay.name && layouts.length > 1) {
            const h = el('text', {
                x: lay.chartLeft || 64,
                y: lay.headerY || (lay.plotTop - 6),
                fill: ink,
                'font-size': 13,
                'font-weight': 700
            });
            h.textContent = lay.name.charAt(0).toUpperCase() + lay.name.slice(1);
            svg.appendChild(h);
        }

        const axisLeft = (lay.chartLeft != null ? lay.chartLeft : 40) - 8;
        const axisRight = (lay.chartRight != null ? lay.chartRight : width - 20) + 8;

        (lay.ticks || []).forEach((t) => {
            const isZero = Math.abs(t.value) < 1e-9;
            svg.appendChild(el('line', {
                x1: axisLeft, y1: t.y, x2: axisRight, y2: t.y,
                stroke: grid,
                'stroke-width': isZero ? 1.25 : 1,
                'stroke-dasharray': isZero ? '4 4' : '2 5',
                opacity: isZero ? 0.95 : 0.55
            }));
            const lab = el('text', {
                x: axisLeft - 6,
                y: t.y + 3,
                fill: muted,
                'font-size': 10,
                'text-anchor': 'end'
            });
            lab.textContent = fmtNum(t.value, false).replace(/\u00a0.*/, '');
            svg.appendChild(lab);
        });

        (lay.connectors || []).forEach((c) => {
            svg.appendChild(el('line', {
                x1: c.x1, y1: c.y, x2: c.x2, y2: c.y,
                stroke: muted, 'stroke-width': 1.5, opacity: 0.75
            }));
        });

        (lay.steps || []).forEach((s) => {
            let fill = baseCol;
            if (s.kind === 'delta') fill = s.value >= 0 ? pos : neg;
            else if (s.kind === 'total') fill = totalCol;
            else if (s.kind === 'subtotal') fill = subtotalCol;

            const bar = el('rect', {
                x: s.x, y: s.y, width: s.width, height: s.height,
                rx: 4, fill: fill, opacity: 0.92
            });
            if (typeof setDiagramSourceLine === 'function') {
                setDiagramSourceLine(bar, s.line || s.sourceLine);
            }
            svg.appendChild(bar);

            const valLabel = el('text', {
                x: s.labelX,
                y: s.y - 8,
                fill: ink,
                'font-size': 11,
                'font-weight': 700,
                'text-anchor': 'middle'
            });
            if (s.kind === 'delta') valLabel.textContent = fmtNum(s.value, true);
            else valLabel.textContent = fmtNum(s.top, false);
            // Simmetrika: no wider than the bar's slot — neighbouring values ran into one another.
            fitLabel(valLabel, s.width + 12, [11, 10, 9], 700);
            svg.appendChild(valLabel);

            if (showPct !== false && s.pctLabel != null && Number.isFinite(s.pctLabel)) {
                const pct = el('text', {
                    x: s.labelX,
                    y: s.y - 20,
                    fill: muted,
                    'font-size': 9,
                    'font-weight': 600,
                    'text-anchor': 'middle'
                });
                pct.textContent = fmtPct(s.kind === 'delta' ? s.pctOfStart : s.pctLabel);
                svg.appendChild(pct);
            }

            // Подписи столбцов: перенос + уменьшение шрифта, чтобы текст не обрезался
            // Tilted names stay one line (Simmetrika: a wrapped second line ran into the next name).
            const maxNameW = s.tiltLabels ? 120 : Math.max(40, s.width + 12);
            const maxLines = s.tiltLabels ? 1 : 3;
            const sizeCandidates = s.tiltLabels ? [10, 9, 8] : [11, 10, 9, 8];
            let nameLines = [String(s.name || '')];
            let nameFs = sizeCandidates[0];
            if (typeof wrapTextLines === 'function') {
                for (let si = 0; si < sizeCandidates.length; si++) {
                    const fs = sizeCandidates[si];
                    const lines = wrapTextLines(s.name, maxNameW, fs);
                    nameFs = fs;
                    nameLines = lines;
                    if (lines.length <= maxLines) break;
                }
                nameLines = s.tiltLabels ? [String(s.name || '')] : nameLines.slice(0, maxLines);
            }
            const lineH = Math.round(nameFs * 1.15);
            const baseY = (lay.plotBottom || (height - 28)) + 14;
            if (s.tiltLabels) {
                const g = el('g', {
                    transform: `translate(${s.labelX},${baseY + 4}) rotate(-35)`
                });
                nameLines.forEach((line, i) => {
                    const t = el('text', {
                        x: 0,
                        y: i * lineH,
                        fill: muted,
                        'font-size': nameFs,
                        'font-weight': 600,
                        'text-anchor': 'end'
                    });
                    t.textContent = line;
                    if (i === 0 && s.name) t.setAttribute('data-label', s.name);
                    g.appendChild(t);
                });
                svg.appendChild(g);
            } else {
                nameLines.forEach((line, i) => {
                    const t = el('text', {
                        x: s.labelX,
                        y: baseY + i * lineH,
                        fill: muted,
                        'font-size': nameFs,
                        'font-weight': 600,
                        'text-anchor': 'middle'
                    });
                    t.textContent = line;
                    if (i === 0 && s.name) t.setAttribute('data-label', s.name);
                    svg.appendChild(t);
                });
            }
        });
    });

    return {
        svg,
        width,
        height,
        svgString: new XMLSerializer().serializeToString(svg)
    };
}
