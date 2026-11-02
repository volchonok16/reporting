/**
 * SVG «Веер значимости» — радар, толщина луча = вес критерия.
 */
function generateFanSVG(layoutData, themeColors) {
    const { title, axes, series, width, height, cx, cy, maxR } = layoutData;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
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
    const theme = themeColors && themeColors.length
        ? themeColors
        : (isDark
            ? ['#fb7185', '#60a5fa', '#fbbf24', '#2dd4bf', '#c4b5fd']
            : ['#e11d48', '#2563eb', '#d97706', '#0d9488', '#7c3aed']);

    function el(name, attrs) {
        const n = document.createElementNS(svgNS, name);
        Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
        return n;
    }

    const N = axes.length;
    const angleStep = (Math.PI * 2) / N;
    const startAngle = -Math.PI / 2;

    function pt(i, r) {
        const a = startAngle + i * angleStep;
        return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, a };
    }

    svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: bg }));

    const titleEl = el('text', {
        x: width / 2, y: 28, fill: ink, 'font-size': 20, 'font-weight': 700, 'text-anchor': 'middle'
    });
    titleEl.textContent = title || 'Веер значимости';
    svg.appendChild(titleEl);
    const sub = el('text', {
        x: width / 2, y: 50, fill: muted, 'font-size': 13, 'text-anchor': 'middle'
    });
    sub.textContent = 'Толщина луча = вес критерия. Полигон — оценка по осям.';
    svg.appendChild(sub);

    for (let r = 0.25; r <= 1.001; r += 0.25) {
        const d = axes.map((_, i) => {
            const p = pt(i, maxR * r);
            return (i === 0 ? 'M' : 'L') + ' ' + p.x + ' ' + p.y;
        }).join(' ') + ' Z';
        svg.appendChild(el('path', {
            d, fill: 'none', stroke: grid, 'stroke-width': 1, opacity: 0.65
        }));
    }

    axes.forEach((ax, i) => {
        const angle = startAngle + i * angleStep;
        const half = ax.weight * 10;
        const perp = angle + Math.PI / 2;
        const dx = Math.cos(perp) * half;
        const dy = Math.sin(perp) * half;
        const end = pt(i, maxR);
        const d = [
            `M ${cx + dx} ${cy + dy}`,
            `L ${end.x + dx} ${end.y + dy}`,
            `L ${end.x - dx} ${end.y - dy}`,
            `L ${cx - dx} ${cy - dy}`,
            'Z'
        ].join(' ');
        svg.appendChild(el('path', {
            d,
            fill: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.06)',
            stroke: isDark ? 'rgba(255,255,255,0.22)' : 'rgba(15,23,42,0.14)',
            'stroke-width': 1
        }));

        const outward = Math.abs(Math.sin(angle)) > 0.85 ? 42 : 34;
        const lab = pt(i, maxR + outward);
        const anchor = Math.abs(Math.cos(angle)) < 0.4
            ? 'middle'
            : (Math.cos(angle) > 0 ? 'start' : 'end');
        const labelText = ax.label + ' · ' + Math.round(ax.weight * 100) + '%';
        const maxLabW = Math.max(90, Math.min(160, width * 0.28));
        const labLines = (typeof wrapTextLines === 'function')
            ? wrapTextLines(labelText, maxLabW, 14).slice(0, 2)
            : [labelText];
        labLines.forEach((line, li) => {
            const t = el('text', {
                x: lab.x,
                y: lab.y + 5 + li * 16,
                fill: ink,
                'font-size': 14,
                'font-weight': 700,
                'text-anchor': anchor
            });
            t.textContent = line;
            svg.appendChild(t);
        });
    });

    series.forEach((s, si) => {
        const color = theme[si % theme.length];
        const d = s.values.map((v, i) => {
            const p = pt(i, maxR * v);
            return (i === 0 ? 'M' : 'L') + ' ' + p.x + ' ' + p.y;
        }).join(' ') + ' Z';
        const poly = el('path', {
            d, fill: color, opacity: 0.28, stroke: color, 'stroke-width': 3.5
        });
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(poly, s.line || s.sourceLine);
        }
        svg.appendChild(poly);
        s.values.forEach((v, i) => {
            const p = pt(i, maxR * v);
            svg.appendChild(el('circle', {
                cx: p.x, cy: p.y, r: 5.5,
                fill: color, stroke: isDark ? '#0f172a' : '#fff', 'stroke-width': 2
            }));
        });
    });

    // легенда внизу, отдельной полосой
    const legY = height - 28;
    const legW = Math.min(width - 40, series.length * 150);
    const legX0 = (width - legW) / 2;
    series.forEach((s, si) => {
        const x = legX0 + si * (legW / Math.max(1, series.length));
        const color = theme[si % theme.length];
        svg.appendChild(el('rect', { x, y: legY - 9, width: 16, height: 16, rx: 3, fill: color }));
        const t = el('text', { x: x + 24, y: legY + 4, fill: ink, 'font-size': 14, 'font-weight': 600 });
        t.textContent = s.name;
        t.setAttribute('data-label', s.name);
        if (typeof setDiagramSourceLine === 'function') {
            setDiagramSourceLine(t, s.line || s.sourceLine);
        }
        svg.appendChild(t);
    });

    return {
        svg,
        width,
        height,
        svgString: new XMLSerializer().serializeToString(svg)
    };
}
